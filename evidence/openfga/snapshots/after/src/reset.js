import { openDatabase, resetDatabase } from './db.js';
import { AuthorizationService } from './openfga/sync.js';
const db = openDatabase();
try {
  resetDatabase(db);
  try { await new AuthorizationService(db).sync(); console.log('SQLite reset to seed; OpenFGA synchronized.'); }
  catch { console.log('SQLite reset COMMITTED; OpenFGA sync PENDING. Run npm.cmd run fga:sync when the service is available.'); process.exitCode = 2; }
} finally { db.close(); }
