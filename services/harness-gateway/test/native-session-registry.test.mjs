/* global Buffer */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeSessionRegistry } from '../native-session-registry.mjs';

function bearer(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `Bearer ${header}.${payload}.signature-value-long-enough`;
}

test('native bootstrap is one-time and binds delegated context to an exact Harness session', () => {
  let clock = 1_800_000_000_000;
  const registry = createNativeSessionRegistry({ now: () => clock });
  const created = registry.create({
    delegatedAuthorization: bearer(Math.floor(clock / 1000) + 3600),
    userId: 'user-1',
    projectId: 'prj-111111111111111111111111',
  });
  assert.equal(created.ok, true);
  assert.deepEqual(registry.counts(), { bootstraps: 1, sessions: 0 });
  const bound = registry.bind(created.bootstrapId, 'session-native-1');
  assert.equal(bound.ok, true);
  assert.equal(registry.bind(created.bootstrapId, 'session-native-2').code, 'NATIVE_BOOTSTRAP_EXPIRED');
  const context = registry.read('session-native-1');
  assert.equal(context.userId, 'user-1');
  assert.equal(context.projectId, 'prj-111111111111111111111111');
  assert.match(context.delegatedAuthorization, /^Bearer /);
  assert.deepEqual(registry.counts(), { bootstraps: 0, sessions: 1 });
});

test('native context expires with the delegated bearer and is never returned in health counts', () => {
  let clock = 1_800_000_000_000;
  const registry = createNativeSessionRegistry({ now: () => clock });
  const created = registry.create({ delegatedAuthorization: bearer(Math.floor(clock / 1000) + 60), userId: 'user-1' });
  assert.equal(registry.bind(created.bootstrapId, 'session-native-1').ok, true);
  clock += 61_000;
  assert.equal(registry.read('session-native-1').code, 'NATIVE_SESSION_CONTEXT_REQUIRED');
  assert.deepEqual(registry.counts(), { bootstraps: 0, sessions: 0 });
});

test('a different user cannot replace an existing native session binding', () => {
  const clock = 1_800_000_000_000;
  const registry = createNativeSessionRegistry({ now: () => clock });
  const first = registry.create({ delegatedAuthorization: bearer(Math.floor(clock / 1000) + 3600), userId: 'user-1' });
  const second = registry.create({ delegatedAuthorization: bearer(Math.floor(clock / 1000) + 3600), userId: 'user-2' });
  assert.equal(registry.bind(first.bootstrapId, 'session-native-1').ok, true);
  assert.equal(registry.bind(second.bootstrapId, 'session-native-1').code, 'NATIVE_SESSION_ALREADY_BOUND');
  assert.equal(registry.read('session-native-1').userId, 'user-1');
});

test('native current context follows the latest active bound session', () => {
  let clock = 1_800_000_000_000;
  const registry = createNativeSessionRegistry({ now: () => clock });
  assert.equal(registry.current().code, 'NATIVE_SESSION_CONTEXT_REQUIRED');

  const first = registry.create({ delegatedAuthorization: bearer(Math.floor(clock / 1000) + 3600), userId: 'user-1' });
  assert.equal(registry.bind(first.bootstrapId, 'session-native-1').ok, true);
  assert.equal(registry.current().userId, 'user-1');
  assert.equal(registry.current().projectId, null);

  clock += 1000;
  const second = registry.create({ delegatedAuthorization: bearer(Math.floor(clock / 1000) + 3600), userId: 'user-1' });
  assert.equal(registry.bind(second.bootstrapId, 'session-native-2').ok, true);
  assert.equal(registry.current().ok, true);
  assert.equal(registry.current().userId, 'user-1');

  clock += 3601_000;
  assert.equal(registry.current().code, 'NATIVE_SESSION_CONTEXT_REQUIRED');
});

test('native current context prefers the latest project-bound session over newer projectless sessions', () => {
  let clock = 1_800_000_000_000;
  const registry = createNativeSessionRegistry({ now: () => clock });

  const projectBound = registry.create({
    delegatedAuthorization: bearer(Math.floor(clock / 1000) + 3600),
    userId: 'user-1',
    projectId: 'prj-bound',
  });
  assert.equal(registry.bind(projectBound.bootstrapId, 'session-native-bound').ok, true);

  clock += 1000;
  const projectless = registry.create({
    delegatedAuthorization: bearer(Math.floor(clock / 1000) + 3600),
    userId: 'user-1',
    projectId: null,
  });
  assert.equal(registry.bind(projectless.bootstrapId, 'session-native-projectless').ok, true);

  const current = registry.current();
  assert.equal(current.ok, true);
  assert.equal(current.userId, 'user-1');
  assert.equal(current.projectId, 'prj-bound');
});

test('native current context skips expired latest sessions and returns the remaining active session', () => {
  let clock = 1_800_000_000_000;
  const registry = createNativeSessionRegistry({ now: () => clock });

  const first = registry.create({
    delegatedAuthorization: bearer(Math.floor(clock / 1000) + 3600),
    userId: 'user-1',
    projectId: 'prj-first',
  });
  assert.equal(registry.bind(first.bootstrapId, 'session-native-1').ok, true);

  clock += 1000;
  const second = registry.create({
    delegatedAuthorization: bearer(Math.floor(clock / 1000) + 60),
    userId: 'user-1',
    projectId: 'prj-second',
  });
  assert.equal(registry.bind(second.bootstrapId, 'session-native-2').ok, true);
  assert.equal(registry.current().projectId, 'prj-second');

  clock += 61_000;
  assert.equal(registry.current().projectId, 'prj-first');
});
