import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authenticate, identities } from './auth.js';
import { authorize, versions } from './policy.js';
import { openDatabase, resetDatabase, transaction } from './db.js';

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const fail = (status, code) => { throw new HttpError(status, code); };
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id);
function bodyFields(body, allowed, required = []) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || !Object.keys(body).length ||
      Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !(key in body))) fail(400, 'INVALID_FIELDS');
}
export function createApp({ db = openDatabase() } = {}) {
  const app = express();
  app.locals.db = db;
  app.use((req, res, next) => {
    req.trace = []; req.requestId = randomUUID();
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  function send(req, res, status, data = null, error = null) {
    req.trace.push({ name: 'Request outcome', result: status >= 500 ? 'ERROR' : status >= 400 ? 'REJECTED' : 'SUCCESS', reason: error?.code || `HTTP_${status}` });
    res.status(status).json({ data, error, trace: req.trace, requestId: req.requestId });
  }
    // Public catalog contains only fixed lab identities/IDs, never live task contents.
  app.get('/lab/config', (req, res) => send(req, res, 200, {
    versions,
    users: identities.map(id => ({ id, token: `demo-${id}` })),
    tasks: ['A1','A2','A3','A4','B1','B2'], projects: ['alpha','beta'],
  }));
  app.post('/lab/reset', (req, res) => {
    // Reject cross-origin browser submissions to the local-only reset endpoint.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) fail(403, 'CROSS_ORIGIN_RESET');
    resetDatabase(db); send(req, res, 200, { reset: true });
  });
  const api = express.Router({ mergeParams: true });
  app.use('/api/:version', api);
  api.use((req, res, next) => {
    if (!versions.includes(req.params.version)) return next(new HttpError(404, 'VERSION_NOT_FOUND'));
    req.principal = authenticate(db, req.headers.authorization);
    req.trace.push({ name: 'Authentication', result: req.principal ? 'PASS' : 'FAIL', reason: req.principal?.id || 'TOKEN_REQUIRED' });
    if (!req.principal) return next(new HttpError(401, 'UNAUTHENTICATED'));
    next();
  });
  function endpoint(action, kind, work) {
    return (req, res) => {
      if (!validId(req.params.id) || (req.params.userId && !validId(req.params.userId))) fail(400, 'INVALID_ID');
      const execute = () => {
        const task = kind === 'task' ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) : null;
        if (kind === 'task' && !task) fail(404, 'TASK_NOT_FOUND');
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task?.projectId || req.params.id);
        if (!project) fail(404, 'PROJECT_NOT_FOUND');
        const membership = db.prepare('SELECT * FROM project_memberships WHERE projectId = ? AND userId = ?').get(project.id, req.principal.id);
        const decision = authorize(req.params.version, req.principal, action, { project, task, membership });
        req.trace.push(...decision.checks, { name: 'Authorization decision', result: decision.allowed ? 'ALLOW' : 'DENY', reason: decision.reason });
        if (decision.allowed !== true) fail(403, decision.reason);
        return work(req, { task, project });
      };
      const output = req.method === 'GET' ? execute() : transaction(db, execute);
      send(req, res, Number.isInteger(output?.status) ? output.status : 200, output?.data ?? output);
    };
  }
    // Discoverable lab directory: authentication grants only project IDs/names.
    api.get('/projects', (req, res) => {
      req.trace.push({ name: 'Lab directory', result: 'ALLOW', reason: 'DISCOVERABLE_PROJECT_NAMES_ONLY' });
      send(req, res, 200, db.prepare('SELECT id, name FROM projects ORDER BY id').all());
    });
    api.get('/projects/:id', endpoint('read', 'project', (req, { project }) => project));
    api.get('/projects/:id/tasks', endpoint('read', 'project', (req, { project }) =>
      db.prepare('SELECT * FROM tasks WHERE projectId = ? ORDER BY id').all(project.id)));
    api.get('/tasks/:id', endpoint('read', 'task', (req, { task }) => task));
  api.patch('/tasks/:id', endpoint('edit', 'task', (req, { task }) => {
    bodyFields(req.body, ['title','description','status']);
    for (const key of ['title','description']) if (key in req.body && (typeof req.body[key] !== 'string' || req.body[key].length > (key === 'title' ? 200 : 2000) || (key === 'title' && !req.body[key].trim()))) fail(400, 'INVALID_TEXT');
    if ('status' in req.body && !['Open','Closed'].includes(req.body.status)) fail(400, 'INVALID_STATUS');
    const updated = { ...task, ...req.body };
    db.prepare('UPDATE tasks SET title = ?, description = ?, status = ? WHERE id = ?').run(updated.title, updated.description, updated.status, task.id);
    return updated;
  }));
  api.delete('/projects/:id', endpoint('delete', 'project', (req, { project }) => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    return { deleted: project.id };
  }));
  api.get('/projects/:id/members', endpoint('members', 'project', (req, { project }) =>
    db.prepare('SELECT userId, role FROM project_memberships WHERE projectId = ? ORDER BY userId').all(project.id)));
  api.post('/projects/:id/members', endpoint('members', 'project', (req, { project }) => {
    bodyFields(req.body, ['userId','role'], ['userId','role']);
    if (!validId(req.body.userId) || !['Viewer','Member'].includes(req.body.role)) fail(400, 'INVALID_MEMBER');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.body.userId);
    if (!user) fail(404, 'USER_NOT_FOUND');
    if (req.params.version === 'v4' && user.tenantId !== project.tenantId) fail(403, 'TARGET_TENANT_MISMATCH');
    if (db.prepare('SELECT 1 FROM project_memberships WHERE projectId = ? AND userId = ?').get(project.id, user.id)) fail(409, 'MEMBERSHIP_EXISTS');
    db.prepare('INSERT INTO project_memberships VALUES (?,?,?)').run(project.id, user.id, req.body.role);
    return { status: 201, data: { userId: user.id, role: req.body.role } };
  }));
  const changeMember = remove => endpoint('members', 'project', (req, { project }) => {
    const member = db.prepare('SELECT * FROM project_memberships WHERE projectId = ? AND userId = ?').get(project.id, req.params.userId);
    if (!member) fail(404, 'MEMBERSHIP_NOT_FOUND');
    const ownerIsFixed = member.role === 'Owner';
    req.trace.push({ name: 'Business rule: fixed project owner', result: ownerIsFixed ? 'FAIL' : 'PASS', reason: ownerIsFixed ? 'OWNER_IS_FIXED' : 'TARGET_IS_NOT_OWNER' });
    if (ownerIsFixed) fail(409, 'OWNER_IS_FIXED');
    if (remove) {
      db.prepare('DELETE FROM project_memberships WHERE projectId = ? AND userId = ?').run(project.id, member.userId);
      return { deleted: member.userId };
    }
    bodyFields(req.body, ['role'], ['role']);
    if (!['Viewer','Member'].includes(req.body.role)) fail(400, 'INVALID_ROLE');
    db.prepare('UPDATE project_memberships SET role = ? WHERE projectId = ? AND userId = ?').run(req.body.role, project.id, member.userId);
    return { userId: member.userId, role: req.body.role };
  });
  api.patch('/projects/:id/members/:userId', changeMember(false));
  api.delete('/projects/:id/members/:userId', changeMember(true));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((req, res) => send(req, res, 404, null, { code: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    send(req, res, status, null, { code: error.type === 'entity.parse.failed' ? 'INVALID_JSON' : status === 500 ? 'INTERNAL_ERROR' : error.message });
  });
  return app;
}
