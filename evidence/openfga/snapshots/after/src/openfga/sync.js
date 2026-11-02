import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authorizationState, transaction } from '../db.js';
import { FgaClient, AuthorizationUnavailable } from './client.js';
import { projectTuples, tupleIdentity, tupleValue } from './relations.js';

export const model = JSON.parse(readFileSync(new URL('../../openfga/model.json', import.meta.url), 'utf8'));
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v)))
    : Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] != null && value[key] !== '' && !(Array.isArray(value[key]) && value[key].length === 0))
      .map(key => [key, JSON.parse(canonical(value[key]))])) : value);
export const modelHash = createHash('sha256').update(canonical(model)).digest('hex');

export class AuthorizationService {
  constructor(db, { client = new FgaClient() } = {}) {
    this.db = db; this.client = client; this.inFlight = null;
  }
  state() { return authorizationState(this.db); }
  ready() {
    const s = this.state();
    return Boolean(this.storeId && this.modelId) && s.apiUrl === this.client.apiUrl && s.storeId === this.storeId && s.modelId === this.modelId &&
      s.modelHash === modelHash && s.appliedRevision === s.desiredRevision;
  }
  assertReady() { if (!this.ready()) throw new AuthorizationUnavailable('AUTHORIZATION_NOT_READY'); }
  sync() {
    if (!this.inFlight) this.inFlight = this.reconcile().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async reconcile() {
    const db = this.db, owner = randomUUID();
    transaction(db, () => {
      const s = this.state();
      if (s.syncOwner && s.syncUntil > Date.now()) throw new AuthorizationUnavailable('AUTHORIZATION_SYNC_BUSY');
      db.prepare('UPDATE authorization_state SET syncOwner=?, syncUntil=? WHERE id=1').run(owner, Date.now()+30000);
      db.prepare('UPDATE authorization_state SET appliedRevision=-1 WHERE id=1').run();
    });
    const renew = () => {
      const changed = db.prepare('UPDATE authorization_state SET syncUntil=? WHERE id=1 AND syncOwner=? AND syncUntil>?').run(Date.now()+30000, owner, Date.now());
      if (changed.changes !== 1) throw new AuthorizationUnavailable('AUTHORIZATION_SYNC_BUSY');
    };
    try {
      let s = this.state();
      if (s.apiUrl && s.apiUrl !== this.client.apiUrl) throw new AuthorizationUnavailable('AUTHORIZATION_ENDPOINT_MISMATCH');
      if (!s.storeId) {
        const store = await this.client.createStore(`task-lab-${randomUUID()}`); renew();
        db.prepare('UPDATE authorization_state SET apiUrl=?, storeId=?, appliedRevision=-1 WHERE id=1').run(this.client.apiUrl, store.id);
      }
      s = this.state();
      if (!s.modelId) {
        const result = await this.client.writeModel(s.storeId, model); renew();
        db.prepare('UPDATE authorization_state SET modelId=?, modelHash=?, appliedRevision=-1 WHERE id=1').run(result.authorization_model_id, modelHash);
      }
      s = this.state();
      if (s.modelHash !== modelHash) throw new AuthorizationUnavailable('AUTHORIZATION_MODEL_MISMATCH');
      const remote = (await this.client.readModel(s.storeId, s.modelId)).authorization_model; renew();
      const { id, ...definition } = remote;
      if (canonical(definition) !== canonical(model)) throw new AuthorizationUnavailable('AUTHORIZATION_MODEL_MISMATCH');
      this.storeId = s.storeId; this.modelId = s.modelId;
      for (let round=0; round<8; round++) {
        const snapshot = transaction(db, () => ({ revision: this.state().desiredRevision, tuples: projectTuples(db) }));
        const actual = await this.client.readTuples(this.storeId); renew();
        const desired = new Map(snapshot.tuples.map(t => [tupleIdentity(t), t]));
        const present = new Map(actual.map(t => [tupleIdentity(t), t]));
        const deletes = actual.filter(t => !desired.has(tupleIdentity(t)) || tupleValue(t) !== tupleValue(desired.get(tupleIdentity(t))));
        const writes = snapshot.tuples.filter(t => !present.has(tupleIdentity(t)) || tupleValue(t) !== tupleValue(present.get(tupleIdentity(t))));
        // Remove stale grants first; readiness stays closed across all batches.
        for (let i=0; i<deletes.length; i+=50) {
          renew();
          await this.client.writeTuples(this.storeId, this.modelId, [], deletes.slice(i,i+50).map(({ user, relation, object }) => ({ user, relation, object })));
        }
        for (let i=0; i<writes.length; i+=50) {
          renew(); await this.client.writeTuples(this.storeId, this.modelId, writes.slice(i,i+50), []);
        }
        renew();
        const completed = transaction(db, () => {
          if (this.state().desiredRevision !== snapshot.revision) return false;
          db.prepare('UPDATE authorization_state SET appliedRevision=? WHERE id=1 AND syncOwner=?').run(snapshot.revision, owner);
          db.prepare('DELETE FROM authorization_outbox WHERE revision<=?').run(snapshot.revision);
          return true;
        });
        if (completed) return this.state();
      }
      throw new AuthorizationUnavailable('AUTHORIZATION_SYNC_BUSY');
    } catch (error) {
      throw error instanceof AuthorizationUnavailable ? error : new AuthorizationUnavailable('AUTHORIZATION_SYNC_FAILED');
    } finally {
      db.prepare('UPDATE authorization_state SET syncOwner=NULL, syncUntil=0 WHERE id=1 AND syncOwner=?').run(owner);
    }
  }
  async check(query) {
    this.assertReady();
    try {
      const allowed = await this.client.check(this.storeId, this.modelId, query);
      if (typeof allowed !== 'boolean') throw new AuthorizationUnavailable();
      return allowed;
    } catch { throw new AuthorizationUnavailable(); }
  }
}
