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

test('PDP rejects unknown versions even for an owner or tenant admin', async () => {
  for (const version of ['v5', '', undefined, 'toString']) {
    for (const isAdmin of [0, 1]) {
      denied(await authorize(version, { ...principal, isAdmin }, 'read', context), 'UNKNOWN_VERSION');
    }
  }
});

test('PDP rejects unknown actions before Starter, V1 or tenant admin can allow', async () => {
  for (const version of versions) {
    for (const isAdmin of [0, 1]) {
      for (const action of ['export', '', undefined, 'toString']) {
        denied(await authorize(version, { ...principal, isAdmin }, action, context), 'UNKNOWN_ACTION');
      }
    }
  }
});

test('PDP rejects unknown membership roles for every action and version', async () => {
  for (const version of versions) {
    for (const isAdmin of [0, 1]) {
      for (const role of ['Admin', '', undefined, 'toString', '__proto__']) {
        for (const action of ['read', 'edit', 'delete', 'members']) {
          denied(await authorize(version, { ...principal, isAdmin }, action, {
            ...context, membership: { role },
          }), 'UNKNOWN_ROLE');
        }
      }
    }
  }
});

test('PDP rejects missing identity or resource context instead of allowing or throwing', async () => {
  for (const version of versions) {
    denied(await authorize(version, null, 'read', context), 'UNAUTHENTICATED');
    denied(await authorize(version, principal, 'read'), 'PROJECT_REQUIRED');
    denied(await authorize(version, principal, 'edit', { ...context, task: null }), 'TASK_REQUIRED');
    denied(await authorize(version, principal, 'edit', {
      ...context, task: { ...context.task, projectId: 'beta' },
    }), 'TASK_REQUIRED');
  }
});

test('OpenFGA decision is authoritative; missing service never falls back locally', async () => {
  await assert.rejects(authorize('v4', principal, 'read', context), { message: 'AUTHORIZATION_NOT_READY' });
  const deny = { modelId: 'test-double', check: async () => false };
  assert.equal((await authorize('v2', principal, 'edit', context, deny)).allowed, false);
  const malformed = { modelId: 'test-double', check: async () => 'true' };
  await assert.rejects(authorize('v2', principal, 'edit', context, malformed), { message: 'AUTHORIZATION_UNAVAILABLE' });
  let called = false;
  const service = { check: async () => { called = true; throw new Error('must not be called'); } };
  assert.equal((await authorize('starter', principal, 'read', context, service)).allowed, true);
  assert.equal(called, false);
});
