import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

// Dedicated throwaway SQLite file; never open/reset the live demo database.
export async function withLab(work, appFactory = createApp) {
  const directory = mkdtempSync(join(tmpdir(), 'task-lab-evidence-'));
  let db, app, server;
  try {
    db = openDatabase(join(directory, 'evidence.sqlite'));
    app = appFactory({ db });
    // Historical baseline snapshots predate the async OpenFGA startup contract.
    if (app.locals.ready && !(await app.locals.ready)) throw new Error('OpenFGA initialization failed; run docker compose up -d --wait');
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolveReady, reject) => {
      server.once('listening', resolveReady);
      server.once('error', reject);
    });
    return await work({ db, app, authorization: app.locals.authorization, baseUrl: `http://127.0.0.1:${server.address().port}` });
  } finally {
    if (server?.listening) await new Promise((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
    const store = db && db.prepare('SELECT storeId FROM authorization_state WHERE id=1').get().storeId;
    if (store && app?.locals.authorization) await app.locals.authorization.client.deleteStore(store);
    db?.close();
    const child = relative(resolve(tmpdir()), resolve(directory));
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Refusing cleanup outside temporary directory');
    rmSync(directory, { recursive: true, force: true });
  }
}
