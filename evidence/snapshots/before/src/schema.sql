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
