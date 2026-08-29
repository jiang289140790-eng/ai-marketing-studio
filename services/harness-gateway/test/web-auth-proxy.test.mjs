import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BOOTSTRAP_SCRIPT, bootstrapBindSessionId, injectBootstrapScript, requestSessionId } from '../web-auth-proxy.mjs';

test('web bootstrap changes transport only, removes the opaque fragment, and keeps the token for API binding', () => {
  const html = injectBootstrapScript('<html><head><title>DeepSeek Harness</title></head><body>native</body></html>');
  assert.match(html, /ams_native_bootstrap_v1/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /x-ams-bootstrap/);
  assert.match(html, /\/ams\/native-bootstrap\/bind/);
  assert.match(html, /ams_native_session_id_v1/);
  assert.match(html, /session\.create/);
  assert.match(html, /dsh\.sessions\.current/);
  assert.match(html, /makeSessionId/);
  assert.match(html, /'session-'/);
  assert.match(html, /sessionStorage\.removeItem\(sk\)/);
  assert.match(html, /clearHarnessSessionSelection/);
  assert.match(html, /current\.\*session\|active\.\*session\|selected\.\*session/);
  assert.match(html, /if\(bootstrap\)headers\.set\('x-ams-bootstrap',bootstrap\)/);
  assert.doesNotMatch(html, /ams-web-/);
  assert.doesNotMatch(html, /if\(r\.ok\)[^;]+sessionStorage\.removeItem\(k\)/);
  assert.doesNotMatch(html, /sessionStorage\.getItem\(bk\)!==bootstrap\+':'\+sid\)headers/);
  assert.doesNotMatch(html, /localStorage\.clear/);
  assert.doesNotMatch(html, /sessionStorage\.clear/);
  assert.match(html, /<title>DeepSeek Harness<\/title>/);
  assert.doesNotMatch(BOOTSTRAP_SCRIPT, /button|card|badge|快捷|项目状态/i);
});

test('native bootstrap bind endpoint accepts only stable browser session ids', () => {
  assert.equal(bootstrapBindSessionId(JSON.stringify({ session_id: 'session-11111111-2222-4333-8444-555555555555' })), 'session-11111111-2222-4333-8444-555555555555');
  assert.equal(bootstrapBindSessionId(JSON.stringify({ session_id: '../bad' })), '');
  assert.equal(bootstrapBindSessionId(JSON.stringify({ session_id: '' })), '');
  assert.equal(bootstrapBindSessionId('{bad json'), '');
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

test('official Harness web uses the official web command without unsupported profile flags', async () => {
  const source = await readFile(new URL('../web-auth-proxy.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dshBin,\s*'web',\s*'--profile'/);
  assert.doesNotMatch(source, /dshBin,\s*'--profile',\s*'ams'/);
  assert.doesNotMatch(source, /dshBin,\s*'--profile',\s*'web',\s*'web'/);
  assert.match(source, /dshBin,\s*'web',\s*'--host'/);
});
