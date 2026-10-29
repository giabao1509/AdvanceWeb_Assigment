import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

// Dedicated throwaway SQLite file; never open/reset the live demo database.
export async function withLab(work, appFactory = createApp) {
  const directory = mkdtempSync(join(tmpdir(), 'task-lab-evidence-'));
  let db, server;
  try {
    db = openDatabase(join(directory, 'evidence.sqlite'));
    server = appFactory({ db }).listen(0, '127.0.0.1');
    await new Promise((resolveReady, reject) => {
      server.once('listening', resolveReady);
      server.once('error', reject);
    });
    return await work({ db, baseUrl: `http://127.0.0.1:${server.address().port}` });
  } finally {
    if (server?.listening) await new Promise((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
    db?.close();
    const child = relative(resolve(tmpdir()), resolve(directory));
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Refusing cleanup outside temporary directory');
    rmSync(directory, { recursive: true, force: true });
  }
}
