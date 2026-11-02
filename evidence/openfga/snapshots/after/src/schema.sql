CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  tenantId TEXT NOT NULL REFERENCES tenants(id),
  isAdmin INTEGER NOT NULL DEFAULT 0 CHECK (isAdmin IN (0,1))
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  tenantId TEXT NOT NULL REFERENCES tenants(id)
);
CREATE TABLE IF NOT EXISTS project_memberships (
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('Viewer','Member','Owner')),
  PRIMARY KEY (projectId, userId)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON project_memberships(projectId) WHERE role = 'Owner';
CREATE INDEX IF NOT EXISTS memberships_user ON project_memberships(userId);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  assigneeId TEXT REFERENCES users(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('Open','Closed'))
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(projectId);

-- Revisions never reset. This row also pins the graph belonging to this SQLite DB.
CREATE TABLE IF NOT EXISTS authorization_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  desiredRevision INTEGER NOT NULL DEFAULT 0,
  appliedRevision INTEGER NOT NULL DEFAULT -1,
  apiUrl TEXT, storeId TEXT, modelId TEXT, modelHash TEXT,
  syncOwner TEXT, syncUntil INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO authorization_state(id) VALUES (1);
CREATE TABLE IF NOT EXISTS authorization_outbox (
  revision INTEGER PRIMARY KEY,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS authorization_operations (
  id TEXT PRIMARY KEY, actorId TEXT,
  revision INTEGER NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
