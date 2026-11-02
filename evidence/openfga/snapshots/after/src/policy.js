import { permissionQuery } from './openfga/relations.js';
import { AuthorizationUnavailable } from './openfga/client.js';

export const versions = ['starter','v1','v2','v3','v4'];
const actions = ['read','edit','delete','members'];
const permissions = new Map([
  ['Viewer', ['read']], ['Member', ['read','edit']], ['Owner', ['read','edit','delete','members']],
]);

export function validatePolicyInput(version, principal, action, { project, task, membership } = {}) {
  if (!versions.includes(version)) return 'UNKNOWN_VERSION';
  if (!actions.includes(action)) return 'UNKNOWN_ACTION';
  if (!principal?.id) return 'UNAUTHENTICATED';
  if (!project?.id) return 'PROJECT_REQUIRED';
  if (task && task.projectId !== project.id) return 'TASK_REQUIRED';
  if (action === 'edit' && !task?.id) return 'TASK_REQUIRED';
  if (membership && !permissions.has(membership.role)) return 'UNKNOWN_ROLE';
}

// Diagnostic only: this function runs after OpenFGA DENY and cannot grant access.
function denialReason(version, principal, action, { project, task, membership }) {
  if (version === 'v4' && principal.tenantId !== project.tenantId) return 'TENANT_MISMATCH';
  if (!membership) return 'NOT_PROJECT_MEMBER';
  if (version !== 'v1' && !permissions.get(membership.role)?.includes(action)) return 'ROLE_DENIED';
  if (['v3','v4'].includes(version) && action === 'edit' && membership.role === 'Member') {
    if (task.assigneeId !== principal.id) return 'NOT_ASSIGNEE';
    if (task.status !== 'Open') return 'TASK_CLOSED';
  }
  return 'AUTHORIZATION_DENIED';
}

export async function authorize(version, principal, action, context = {}, service) {
  const invalid = validatePolicyInput(version, principal, action, context);
  if (invalid) return { allowed: false, reason: invalid, checks: [{ name: 'Policy input', result: 'FAIL', reason: invalid }] };
  if (version === 'starter') return {
    allowed: true, reason: 'STARTER_AUTHENTICATION_ONLY',
    checks: [{ name: 'Object authorization', result: 'SKIPPED', reason: 'STARTER_IDOR' }],
  };
  if (!service) throw new AuthorizationUnavailable('AUTHORIZATION_NOT_READY');
  const query = permissionQuery(version, principal, action, context);
  const allowed = await service.check(query);
  if (typeof allowed !== 'boolean') throw new AuthorizationUnavailable();
  const reason = allowed ? version === 'v1' ? 'PROJECT_MEMBER_ALLOWED'
    : version === 'v4' && principal.isAdmin ? 'TENANT_ADMIN_ALLOWED' : 'POLICY_ALLOWED'
    : denialReason(version, principal, action, context);
  const checks = [{ name: 'OpenFGA Check', result: allowed ? 'PASS' : 'FAIL', reason: `${query.relation} · ${query.object} · model ${service.modelId} · HIGHER_CONSISTENCY` }];
  if (version === 'v1') checks.push({ name: 'Project membership', result: context.membership ? 'PASS' : 'FAIL', reason: 'SQLITE_SNAPSHOT_OBSERVATION' });
  return { allowed: allowed === true, reason, checks };
}
