const roles = new Map([['Owner','owner'], ['Member','member'], ['Viewer','viewer']]);
export const tupleIdentity = t => JSON.stringify([t.user, t.relation, t.object]);
export const tupleValue = t => JSON.stringify([t.user, t.relation, t.object, t.condition?.name || '', t.condition?.context || {}]);
export function projectTuples(db) {
  const tuples = [];
  const add = (user, relation, object, condition) => tuples.push({ user, relation, object, ...(condition ? { condition } : {}) });
  for (const user of db.prepare('SELECT id, tenantId, isAdmin FROM users ORDER BY id').all()) {
    add(`user:${user.id}`, 'member', `tenant:${user.tenantId}`);
    if (user.isAdmin) add(`user:${user.id}`, 'admin', `tenant:${user.tenantId}`);
  }
  for (const project of db.prepare('SELECT id, tenantId FROM projects ORDER BY id').all()) add(`tenant:${project.tenantId}`, 'tenant', `project:${project.id}`);
  for (const m of db.prepare('SELECT * FROM project_memberships ORDER BY projectId,userId').all()) {
    if (!roles.has(m.role)) throw new Error('UNKNOWN_ROLE');
    add(`user:${m.userId}`, roles.get(m.role), `project:${m.projectId}`);
  }
  for (const task of db.prepare('SELECT id,projectId,assigneeId FROM tasks ORDER BY id').all()) {
    add(`project:${task.projectId}`, 'project', `task:${task.id}`);
    if (task.assigneeId) add(`user:${task.assigneeId}`, 'assignee', `task:${task.id}`, { name: 'task_is_open' });
  }
  return tuples;
}
export function permissionQuery(version, principal, action, { project, task }) {
  const relations = new Map([['read','can_read'],['edit','can_edit'],['delete','can_delete'],['members','can_manage_members']]);
  if (!['v1','v2','v3','v4'].includes(version) || !relations.has(action)) throw new Error('UNKNOWN_PERMISSION');
  return {
    user: `user:${principal.id}`, relation: `${relations.get(action)}_${version}`,
    object: task ? `task:${task.id}` : `project:${project.id}`,
    ...(task ? { context: { current_status: task.status } } : {}),
  };
}
