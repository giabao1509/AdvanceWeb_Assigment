export const versions = ['starter','v1','v2','v3','v4'];
const actions = ['read','edit','delete','members'];
const permissions = new Map([
  ['Viewer', ['read']],
  ['Member', ['read','edit']],
  ['Owner', ['read','edit','delete','members']],
]);
export function authorize(version, principal, action, { project, task, membership } = {}) {
  const checks = [];
  const check = (name, pass, reason) => {
    checks.push({ name, result: pass ? 'PASS' : 'FAIL', reason });
    return pass;
  };
  const result = (allowed, reason) => ({ allowed, reason, checks });
  // Validate policy inputs before any permissive lab/admin branch.
  const deny = reason => {
    check('Policy input', false, reason);
    return result(false, reason);
  };
  if (!versions.includes(version)) return deny('UNKNOWN_VERSION');
  if (!actions.includes(action)) return deny('UNKNOWN_ACTION');
  if (!principal?.id) return deny('UNAUTHENTICATED');
  if (!project?.id) return deny('PROJECT_REQUIRED');
  if (action === 'edit' && (!task?.id || task.projectId !== project.id)) return deny('TASK_REQUIRED');
  if (membership && !permissions.has(membership.role)) return deny('UNKNOWN_ROLE');
  if (version === 'starter') {
    checks.push({ name: 'Object authorization', result: 'SKIPPED', reason: 'STARTER_IDOR' });
    return result(true, 'STARTER_AUTHENTICATION_ONLY');
  }
  if (version === 'v4') {
    if (!check('Tenant boundary', principal.tenantId === project.tenantId, 'SAME_TENANT_REQUIRED')) return result(false, 'TENANT_MISMATCH');
    if (principal.isAdmin) {
      check('Tenant admin', true, 'ADMIN_IN_OWN_TENANT');
      return result(true, 'TENANT_ADMIN_ALLOWED');
    }
  }
  if (!check('Project membership', Boolean(membership), 'PROJECT_MEMBERSHIP_REQUIRED')) return result(false, 'NOT_PROJECT_MEMBER');
  // V1 protects all objects by project membership; per-action roles start in V2.
  if (version === 'v1') return result(true, 'PROJECT_MEMBER_ALLOWED');
  const role = membership.role;
  const roleAllowed = permissions.get(role)?.includes(action) === true;
  if (!check('Project role', roleAllowed, `${role}:${action}`)) return result(false, 'ROLE_DENIED');
  if (['v3','v4'].includes(version) && action === 'edit' && role === 'Member') {
    if (!check('Task assignee', task.assigneeId === principal.id, 'CALLER_MUST_BE_ASSIGNEE')) return result(false, 'NOT_ASSIGNEE');
    if (!check('Task status', task.status === 'Open', 'CURRENT_TASK_MUST_BE_OPEN')) return result(false, 'TASK_CLOSED');
  }
  return result(true, 'POLICY_ALLOWED');
}
