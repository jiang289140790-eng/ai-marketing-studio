import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHarnessPrompt, harnessReadiness } from '../harness-runner.mjs';

test('Harness model launch requires paid approval and exposes every independent scope', () => {
  assert.throws(
    () => buildHarnessPrompt({ intent: 'read this project', project_id: 'project-a', approval: { paid_external_calls: false, online_writes: false, handoff_creation: false } }, 'ht-read'),
    (error) => error.code === 'PAID_EXTERNAL_APPROVAL_REQUIRED',
  );
  const prompt = buildHarnessPrompt({ intent: 'plan this', project_id: 'project-a', approval: { paid_external_calls: true, online_writes: true, handoff_creation: true } }, 'ht-test');
  assert.match(prompt, /Task id: ht-test/);
  assert.match(prompt, /Trusted bound project id \(JSON; use this exact value for project-scoped tools\): "project-a"/);
  assert.match(prompt, /Paid external tools approved: true/);
  assert.match(prompt, /Online writes approved: true/);
  assert.match(prompt, /Generation handoff approved: true/);
  assert.match(prompt, /User intent: plan this/);
});

test('Harness readiness requires the internal model proxy configuration', () => {
  assert.equal(harnessReadiness({ HARNESS_EXECUTABLE: '/app/dsh', HARNESS_WORKSPACE: '/workspace' }).model_credential_configured, false);
  assert.equal(harnessReadiness({ HARNESS_EXECUTABLE: '/app/dsh', HARNESS_WORKSPACE: '/workspace', DEEPSEEK_API_KEY: 'internal', DEEPSEEK_BASE_URL: 'http://model-proxy:8791' }).model_credential_configured, true);
});

test('Harness readiness requires the exact HTTPS AMS tool bridge shape', () => {
  const base = { HARNESS_EXECUTABLE: '/app/dsh', HARNESS_WORKSPACE: '/workspace', AMS_TOOL_BRIDGE_SECRET_FILE: '/run/secrets/bridge' };
  assert.equal(harnessReadiness(base).tool_bridge_configured, false);
  assert.equal(harnessReadiness({ ...base, AMS_TOOL_BRIDGE_URL: 'http://example.test/functions/v1/harness-tool-bridge' }).tool_bridge_configured, false);
  assert.equal(harnessReadiness({ ...base, AMS_TOOL_BRIDGE_URL: 'https://amsstagingexample.supabase.co/functions/v1/harness-tool-bridge' }).tool_bridge_configured, true);
});
