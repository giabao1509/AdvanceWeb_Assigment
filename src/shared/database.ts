import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });

export type SqliteDb = Database.Database;

const open = (name: string): SqliteDb => {
  const db = new Database(join(config.dataDir, name));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
};

const stockSchema = `
  CREATE TABLE IF NOT EXISTS stock (
    sku TEXT PRIMARY KEY,
    available_qty INTEGER NOT NULL CHECK (available_qty >= 0)
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    order_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

export const resetInventory = (db: SqliteDb, secure: boolean): void => {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM reservations; DELETE FROM stock;');
    if (secure) db.exec('DELETE FROM used_nonces;');
    db.prepare('INSERT INTO stock(sku, available_qty) VALUES (?, ?)').run('SKU-001', 20);
    db.prepare('INSERT INTO stock(sku, available_qty) VALUES (?, ?)').run('SKU-LOW', 1);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

export const openBaselineInventory = (): SqliteDb => {
  const db = open('baseline-inventory.sqlite');
  db.exec(stockSchema);
  const count = db.prepare('SELECT COUNT(*) AS count FROM stock').get() as { count: number };
  if (count.count === 0) resetInventory(db, false);
  return db;
};

export const openSecureInventory = (): SqliteDb => {
  const db = open('secure-inventory.sqlite');
  db.exec(`${stockSchema}
    CREATE TABLE IF NOT EXISTS used_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  const count = db.prepare('SELECT COUNT(*) AS count FROM stock').get() as { count: number };
  if (count.count === 0) resetInventory(db, true);
  return db;
};

const orderSchema = `
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    sku TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    reservation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

export const resetBaselineOrder = (db: SqliteDb): void => {
  db.exec('DELETE FROM orders;');
};

export const openBaselineOrder = (): SqliteDb => {
  const db = open('baseline-order.sqlite');
  db.exec(orderSchema);
  return db;
};

export const resetSecureOrder = (db: SqliteDb): void => {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM refresh_tokens; DELETE FROM orders; DELETE FROM users;');
    db.prepare(`INSERT INTO users(id, username, password_hash, created_at)
      VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), config.username, bcrypt.hashSync(config.password, config.bcryptCost), Date.now());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

export const openSecureOrder = (): SqliteDb => {
  const db = open('secure-order.sqlite');
  db.exec(`${orderSchema}
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      family_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      revoked_at INTEGER,
      replaced_by TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS refresh_family_idx ON refresh_tokens(family_id);
  `);
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  if (count.count === 0) resetSecureOrder(db);
  return db;
};

export interface InventoryMetrics {
  stock: Array<{ sku: string; availableQty: number }>;
  reservations: number;
}

export const inventoryMetrics = (db: SqliteDb): InventoryMetrics => ({
  stock: db.prepare('SELECT sku, available_qty AS availableQty FROM stock ORDER BY sku').all() as InventoryMetrics['stock'],
  reservations: (db.prepare('SELECT COUNT(*) AS count FROM reservations').get() as { count: number }).count,
});
