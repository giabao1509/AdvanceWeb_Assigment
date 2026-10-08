// Mở SQLite với hook verbose: mọi câu SQL thực thi trong request có rid đều được log (D16).
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from './config.js';
import { als, log } from './context.js';

export function openDb(file) {
  return new Database(path.join(DATA_DIR, file), {
    readonly: true,
    fileMustExist: true,
    verbose: (sql) => {
      if (!als.getStore()) return; // câu lệnh lúc khởi động: không tính
      log({ kind: 'db', sql: sql.length > 300 ? `${sql.slice(0, 300)}…` : sql });
    },
  });
}

export const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');
