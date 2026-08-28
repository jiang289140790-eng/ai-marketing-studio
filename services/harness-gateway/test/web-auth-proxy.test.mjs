import assert from 'node:assert/strict';
import test from 'node:test';
import { BOOTSTRAP_SCRIPT, injectBootstrapScript, requestSessionId } from '../web-auth-proxy.mjs';

test('web bootstrap changes transport only and removes the opaque fragment immediately', () => {
  const html = injectBootstrapScript('<html><head><title>DeepSeek Harness</title></head><body>native</body></html>');
  assert.match(html, /ams_native_bootstrap_v1/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /x-ams-bootstrap/);
  assert.match(html, /<title>DeepSeek Harness<\/title>/);
  assert.doesNotMatch(BOOTSTRAP_SCRIPT, /button|card|badge|快捷|项目状态/i);
});

test('native session id is extracted from requests and session.create responses', () => {
  assert.equal(requestSessionId('/api/session.get', JSON.stringify({ payload: { sessionId: 'session-existing' } })), 'session-existing');
  assert.equal(requestSessionId('/api/session.get', JSON.stringify({ params: { sessionId: 'session-from-params' } })), 'session-from-params');
  assert.equal(requestSessionId('/api/agent.run', JSON.stringify({ agentId: 'session-from-agent' })), 'session-from-agent');
  assert.equal(requestSessionId('/api/session.get', JSON.stringify({ session: { id: 'session-nested' } })), 'session-nested');
  assert.equal(requestSessionId('/api/session.create', '{}', JSON.stringify({ result: { value: { sessionId: 'session-created' } } })), 'session-created');
  assert.equal(requestSessionId('/api/session.create', '{}', JSON.stringify({ result: { value: { id: 'session-created-by-id' } } })), 'session-created-by-id');
  assert.equal(requestSessionId('/api/session.create', '{}', JSON.stringify({ result: { sessionId: 'session-created-result' } })), 'session-created-result');
  assert.equal(requestSessionId('/api/session.create', '{}', JSON.stringify({ data: { sessionId: 'session-created-data' } })), 'session-created-data');
  assert.equal(requestSessionId('/api/session.get', JSON.stringify({ payload: { sessionId: '../bad' } })), '');
  assert.equal(requestSessionId('/api/session.get', JSON.stringify({ payload: { sessionId: 'x'.repeat(193) } })), '');
  assert.equal(requestSessionId('/api/session.create', '{bad json', '{}'), '');
});
