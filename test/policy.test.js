import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, versions } from '../src/policy.js';

const principal = { id: 'alice', tenantId: 'alpha', isAdmin: 0 };
const context = {
  project: { id: 'alpha', tenantId: 'alpha' },
  task: { id: 'A1', projectId: 'alpha', assigneeId: 'alice', status: 'Open' },
  membership: { role: 'Owner' },
};
function denied(decision, reason) {
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, reason);
  assert.deepEqual(decision.checks.at(-1), { name: 'Policy input', result: 'FAIL', reason });
}

test('PDP rejects unknown versions even for an owner or tenant admin', () => {
  for (const version of ['v5', '', undefined, 'toString']) {
    for (const isAdmin of [0, 1]) {
      denied(authorize(version, { ...principal, isAdmin }, 'read', context), 'UNKNOWN_VERSION');
    }
  }
});

test('PDP rejects unknown actions before Starter, V1 or tenant admin can allow', () => {
  for (const version of versions) {
    for (const isAdmin of [0, 1]) {
      for (const action of ['export', '', undefined, 'toString']) {
        denied(authorize(version, { ...principal, isAdmin }, action, context), 'UNKNOWN_ACTION');
      }
    }
  }
});

test('PDP rejects unknown membership roles for every action and version', () => {
  for (const version of versions) {
    for (const isAdmin of [0, 1]) {
      for (const role of ['Admin', '', undefined, 'toString', '__proto__']) {
        for (const action of ['read', 'edit', 'delete', 'members']) {
          denied(authorize(version, { ...principal, isAdmin }, action, {
            ...context, membership: { role },
          }), 'UNKNOWN_ROLE');
        }
      }
    }
  }
});

test('PDP rejects missing identity or resource context instead of allowing or throwing', () => {
  for (const version of versions) {
    denied(authorize(version, null, 'read', context), 'UNAUTHENTICATED');
    denied(authorize(version, principal, 'read'), 'PROJECT_REQUIRED');
    denied(authorize(version, principal, 'edit', { ...context, task: null }), 'TASK_REQUIRED');
    denied(authorize(version, principal, 'edit', {
      ...context, task: { ...context.task, projectId: 'beta' },
    }), 'TASK_REQUIRED');
  }
});

test('Explicit RBAC allowlist grants only documented role/action pairs in V2–V4', () => {
  const expected = {
    Viewer: [true, false, false, false],
    Member: [true, true, false, false],
    Owner: [true, true, true, true],
  };
  for (const version of ['v2', 'v3', 'v4']) {
    for (const [role, allowed] of Object.entries(expected)) {
      for (const [index, action] of ['read', 'edit', 'delete', 'members'].entries()) {
        assert.equal(authorize(version, principal, action, {
          ...context, membership: { role },
        }).allowed, allowed[index], `${version}/${role}/${action}`);
      }
    }
  }
});
