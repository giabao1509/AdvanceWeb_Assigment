import { OpenFgaClient, ConsistencyPreference } from '@openfga/sdk';

export class AuthorizationUnavailable extends Error {
  constructor(code = 'AUTHORIZATION_UNAVAILABLE') { super(code); this.status = 503; }
}

export class FgaClient {
  constructor({ apiUrl = process.env.FGA_API_URL || 'http://127.0.0.1:8080', timeout = Number(process.env.FGA_TIMEOUT_MS || 3000) } = {}) {
    this.apiUrl = new URL(apiUrl).href.replace(/\/$/, '');
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 10000) throw new Error('FGA_TIMEOUT_MS must be 100..10000');
    this.sdk = new OpenFgaClient({ apiUrl: this.apiUrl, retryParams: { maxRetry: 0 }, baseOptions: { timeout } });
  }
  async createStore(name) { return this.sdk.createStore({ name }); }
  async deleteStore(storeId) { return this.sdk.deleteStore({ storeId }); }
  async writeModel(storeId, model) { return this.sdk.writeAuthorizationModel(model, { storeId }); }
  async readModel(storeId, modelId) { return this.sdk.readAuthorizationModel({ storeId, authorizationModelId: modelId }); }
  async readTuples(storeId) {
    const tuples = []; let continuationToken;
    do {
      const page = await this.sdk.read({}, { storeId, pageSize: 100, continuationToken, consistency: ConsistencyPreference.HigherConsistency });
      tuples.push(...page.tuples.map(tuple => tuple.key));
      continuationToken = page.continuation_token;
    } while (continuationToken);
    return tuples;
  }
  async writeTuples(storeId, modelId, writes, deletes) {
    const response = await this.sdk.write({ ...(writes.length ? { writes } : {}), ...(deletes.length ? { deletes } : {}) }, {
      storeId, authorizationModelId: modelId,
      transaction: { disable: false },
    });
    if ([...response.writes, ...response.deletes].some(item => item.status !== 'success')) throw new AuthorizationUnavailable('AUTHORIZATION_SYNC_FAILED');
  }
  async check(storeId, modelId, { user, relation, object, context }) {
    const response = await this.sdk.check({ user, relation, object, context }, {
      storeId, authorizationModelId: modelId, consistency: ConsistencyPreference.HigherConsistency,
    });
    if (typeof response.allowed !== 'boolean') throw new AuthorizationUnavailable();
    return response.allowed;
  }
}
