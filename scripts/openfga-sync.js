import { openDatabase } from '../src/db.js';
import { AuthorizationService } from '../src/openfga/sync.js';
const db = openDatabase();
try {
  const service = new AuthorizationService(db);
  const state = await service.sync();
  console.log(JSON.stringify({ ready: true, apiUrl: state.apiUrl, storeId: state.storeId, modelId: state.modelId, appliedRevision: state.appliedRevision }, null, 2));
} catch (error) {
  console.error(error.status === 503 ? error.message : 'OpenFGA setup failed'); process.exitCode = 1;
} finally { db.close(); }
