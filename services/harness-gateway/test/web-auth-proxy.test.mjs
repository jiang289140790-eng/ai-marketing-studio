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
  assert.equal(requestSessionId('/api/session.create', '{}', JSON.stringify({ result: { value: { sessionId: 'session-created' } } })), 'session-created');
  assert.equal(requestSessionId('/api/session.create', '{bad json', '{}'), '');
});
