import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHarnessPrompt, harnessReadiness } from '../harness-runner.mjs';

test('Harness model execution requires explicit paid-call approval', () => {
  assert.throws(
    () => buildHarnessPrompt({ intent: 'plan this', approval: { paid_external_calls: false } }, 'ht-test'),
    (error) => error.code === 'PAID_EXTERNAL_APPROVAL_REQUIRED',
  );
  const prompt = buildHarnessPrompt({ intent: 'plan this', approval: { paid_external_calls: true } }, 'ht-test');
  assert.match(prompt, /Task id: ht-test/);
  assert.match(prompt, /User intent: plan this/);
});

test('Harness readiness requires the internal model proxy configuration', () => {
  assert.equal(harnessReadiness({ HARNESS_EXECUTABLE: '/app/dsh', HARNESS_WORKSPACE: '/workspace' }).model_credential_configured, false);
  assert.equal(harnessReadiness({ HARNESS_EXECUTABLE: '/app/dsh', HARNESS_WORKSPACE: '/workspace', DEEPSEEK_API_KEY: 'internal', DEEPSEEK_BASE_URL: 'http://model-proxy:8791' }).model_credential_configured, true);
});
