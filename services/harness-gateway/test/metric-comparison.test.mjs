/* global structuredClone */
// Metric comparison contract tests for the online entry repair:
// Chinese highest-metric intents map to compare_project with the exact
// metric, the requested metric wins over aggregate engagement in adversarial
// fixtures, missing/zero/tie semantics are deterministic and stable, the
// comparison is read-only by default (zero collection/analysis/model/paid
// calls) and persists only under explicit online-writes approval, and
// research.analyze_persisted rejects any extra payload field with bounded
// exact diagnostics that never leak values.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { toBoundaryRequest, TOOL_SCHEMA_VERSION, validateToolCall } from '../tool-contract.mjs';
import { createPlanner } from '../planner.mjs';
import { createBridgeStateReader, executeConfirmedPlan, metricValue } from '../deterministic-executor.mjs';

const TASK_ID = 'ht-11111111-1111-4111-8111-111111111111';
const PROJECT_ID = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
const planner = createPlanner();

async function buildPlan(intent, projectId = PROJECT_ID) {
  const result = await planner.plan({
    taskId: TASK_ID,
    request: { user_id: 'user-a', project_id: projectId, intent, request_fingerprint: 'a'.repeat(64) },
  });
  assert.equal(result.ok, true, `${intent} → ${result.code}`);
  return result.value;
}

function view(plan, approval = null) {
  const requested = approval || {
    paid_external_calls: plan.approvals.paid_external_calls,
    online_writes: plan.approvals.online_writes,
    handoff_creation: plan.approvals.handoff_creation,
  };
  return {
    id: TASK_ID,
    request: { user_id: 'user-a', project_id: plan.project_id, intent: plan.intent },
    plan,
    confirmation: { approval: requested, confirmed_at: '2026-08-16T08:00:00.000Z' },
    step_states: {},
  };
}

function evidenceRecord(idSuffix, sourceUrl, engagement = {}) {
  const text = `evidence ${idSuffix}`;
  return {
    id: `ev-${idSuffix}`,
    project_id: PROJECT_ID,
    source_url: sourceUrl,
    label: `source ${idSuffix}`,
    platform: 'X · Apify',
    content_text: text,
    source_metadata: { engagement },
    media_metadata: { sha256: createHash('sha256').update(text).digest('hex') },
    fingerprint: createHash('sha256').update(`fingerprint ${idSuffix}`).digest('hex'),
    version: 1,
  };
}

// Mock boundary that records every call; any unexpected operation fails the
// test, which is exactly what proves the comparison makes zero paid calls.
function mockBoundary(seed = { evidence: [], analyses: [] }) {
  const state = { revision: 3, ...seed };
  const calls = [];
  const client = async (call) => {
    calls.push(call.operation);
    switch (call.operation) {
      case 'workspace.project.read':
        return { ok: true, data: { project: { version: state.revision, evidence: state.evidence, analyses: state.analyses } } };
      case 'workspace.analysis.create': {
        const record = { ...call.payload.analysis, fingerprint: `af${call.payload.analysis.id.slice(3)}` };
        state.analyses = [...(state.analyses || []), record];
        state.revision += 1;
        return { ok: true, entity: { type: 'analysis', id: record.id }, artifact_refs: [record.id] };
      }
      default:
        assert.fail(`unexpected bridge operation ${call.operation} — the comparison must make zero research/model/paid calls`);
    }
  };
  return { state, calls, client };
}

async function run(plan, bridge, approval = null) {
  const taskView = view(plan, approval);
  const stateReader = createBridgeStateReader(bridge.client);
  const output = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: bridge.client, stateReader });
  return { taskView, output };
}

test('Chinese highest-metric intents build compare_project plans with the exact metric slot', async () => {
  const cases = [
    ['你能分析下近期展现量最高的X帖子吗', 'views'],
    ['近期浏览量最高的帖子', 'views'],
    ['播放量最高的内容', 'views'],
    ['曝光最高的来源', 'views'],
    ['互动最高的帖子', 'engagement'],
    ['互动量最高的来源', 'engagement'],
  ];
  for (const [intent, metric] of cases) {
    const plan = await buildPlan(intent);
    assert.equal(plan.workflow, 'compare_project', intent);
    assert.equal(plan.slots.metric, metric, intent);
    assert.equal(plan.slots.persist, false, intent);
    assert.equal(plan.approvals.online_writes, false, intent);
    assert.equal(plan.approvals.paid_external_calls, false, intent);
    assert.deepEqual(plan.steps.map((step) => step.operation), ['workspace.project.read', null], intent);
    assert.equal(plan.cost_indicators.paid_calls, 0, intent);
    assert.equal(plan.cost_indicators.online_writes, 0, intent);
  }
});

test('adversarial fixtures: the requested views metric wins over aggregate engagement', async () => {
  // ev…0001 has the highest aggregate engagement (900 views + 5000 likes)
  // but the LOWEST views; the requested views ranking must never be
  // substituted by engagement.
  const evidence = [
    evidenceRecord('000000000000000000000003', 'https://x.com/i/web/status/3', { views: 1000, likes: 0 }),
    evidenceRecord('000000000000000000000001', 'https://x.com/i/web/status/1', { views: 900, likes: 5000 }),
    evidenceRecord('000000000000000000000002', 'https://x.com/i/web/status/2', { views: 1100, likes: 100 }),
  ];
  const viewsPlan = await buildPlan('分析下近期展现量最高的X帖子');
  const viewsBridge = mockBoundary({ evidence });
  const viewsRun = await run(viewsPlan, viewsBridge);
  assert.equal(viewsRun.output.outcome, 'succeeded');
  const viewsRanking = viewsRun.output.result_data.compare.ranking;
  assert.deepEqual(viewsRanking.map((row) => row.evidence_id), [
    'ev-000000000000000000000002', // 1100 views
    'ev-000000000000000000000003', // 1000 views
    'ev-000000000000000000000001', // 900 views — despite the highest engagement
  ]);
  assert.deepEqual(viewsRanking.map((row) => row.metric_value), [1100, 1000, 900]);
  assert.equal(viewsRun.output.result_data.compare.metric, 'views');
  assert.equal(viewsRun.output.result_data.compare.persisted, false);

  // The same evidence under the engagement metric ranks by the documented
  // formula (views + likes + retweets + replies + reddit), proving the two
  // orders genuinely conflict.
  const engagementPlan = await buildPlan('互动最高的帖子');
  const engagementBridge = mockBoundary({ evidence });
  const engagementRun = await run(engagementPlan, engagementBridge);
  assert.equal(engagementRun.output.outcome, 'succeeded');
  assert.deepEqual(engagementRun.output.result_data.compare.ranking.map((row) => row.evidence_id), [
    'ev-000000000000000000000001', // 5900
    'ev-000000000000000000000002', // 1200
    'ev-000000000000000000000003', // 1000
  ]);
});

test('missing, zero and tie cases are deterministic and stable across input order', () => {
  const metric = 'views';
  const mixed = [
    evidenceRecord('000000000000000000000001', 'https://x.com/i/web/status/1', { views: 5, likes: 1 }),
    evidenceRecord('000000000000000000000003', 'https://x.com/i/web/status/3', { likes: 9 }), // views missing → 0
    evidenceRecord('000000000000000000000002', 'https://x.com/i/web/status/2', { views: 5, likes: 2 }), // tie with 1
    evidenceRecord('000000000000000000000004', 'https://x.com/i/web/status/4', {}), // nothing → 0
    evidenceRecord('000000000000000000000000', 'https://x.com/i/web/status/0', { views: 0 }), // explicit zero
  ];
  const expected = ['ev-000000000000000000000001', 'ev-000000000000000000000002', 'ev-000000000000000000000000', 'ev-000000000000000000000003', 'ev-000000000000000000000004'];
  const ranks = (evidence) => {
    const values = evidence.map((record) => metricValue(record, metric));
    return evidence
      .map((record, index) => ({ record, value: values[index] }))
      .sort((left, right) => (right.value - left.value)
        || (String(left.record.id) < String(right.record.id) ? -1 : String(left.record.id) > String(right.record.id) ? 1 : 0))
      .map((entry) => entry.record.id);
  };
  assert.deepEqual(ranks(mixed), expected, 'tie broken by evidence id ascending; missing and zero both 0');
  assert.deepEqual(ranks([...mixed].reverse()), expected, 'input order never changes the ranking');
  assert.deepEqual(ranks([mixed[4], mixed[1], mixed[0], mixed[3], mixed[2]]), expected, 'permuted input produces the identical ranking');
});

test('read-only comparison makes zero collection/analysis/model/paid calls and no cost reservation', async () => {
  const evidence = [evidenceRecord('000000000000000000000001', 'https://x.com/i/web/status/1', { views: 10 })];
  const plan = await buildPlan('分析下近期展现量最高的X帖子');
  const bridge = mockBoundary({ evidence });
  const { output, taskView } = await run(plan, bridge);
  assert.equal(output.outcome, 'succeeded');
  assert.deepEqual(bridge.calls, ['workspace.project.read'], 'the only bridge call is the bounded project read');
  assert.equal(taskView.step_states['st-1'].state, 'succeeded');
  assert.equal(taskView.step_states['st-1'].item_count, 1);
  assert.equal(output.result_data.compare.metric, 'views');
  assert.equal(output.result_data.compare.ranking.length, 1);
  assert.equal(output.result_data.compare.ranking[0].views, 10);
  assert.equal(output.result_data.compare.persisted, false);
  // No paid step exists in the plan, so no cost reservation can be created.
  assert.equal(plan.cost_indicators.paid_calls, 0);
  assert.equal(plan.steps.some((step) => step.cost), false);
  assert.equal(plan.approvals.paid_external_calls, false);
});

test('comparison persists only under explicit online-writes approval and fails closed before any write otherwise', async () => {
  const evidence = [evidenceRecord('000000000000000000000001', 'https://x.com/i/web/status/1', { views: 10 }), evidenceRecord('000000000000000000000002', 'https://x.com/i/web/status/2', { views: 20 })];
  const plan = await buildPlan('比较当前项目中表现最好的帖子并保存比较分析');
  assert.equal(plan.approvals.online_writes, true);

  // Confirmation without the declared online_writes approval never executes.
  const deniedBridge = mockBoundary({ evidence });
  await assert.rejects(
    run(plan, deniedBridge, { paid_external_calls: false, online_writes: false, handoff_creation: false }),
    (error) => error?.code === 'APPROVAL_REQUIRED' && error?.message.includes('online_writes'),
  );
  assert.deepEqual(deniedBridge.calls, [], 'zero bridge calls happen before the approval gate');

  // With the exact approval, exactly the bounded count of analyses is written
  // and the same deterministic ranking is returned alongside them.
  const approvedBridge = mockBoundary({ evidence });
  const approved = await run(plan, approvedBridge);
  assert.equal(approved.output.outcome, 'succeeded');
  assert.deepEqual(approvedBridge.calls.filter((operation) => operation === 'workspace.analysis.create'), ['workspace.analysis.create', 'workspace.analysis.create']);
  assert.deepEqual(approvedBridge.calls.filter((operation) => operation.startsWith('research.')), [], 'persisting the local comparison still makes zero research/model calls');
  assert.equal(approved.output.result_data.compare.persisted, true);
  assert.equal(approved.output.result_data.compare.metric, 'engagement');
  assert.deepEqual(approved.output.result_data.compare.ranking.map((row) => row.evidence_id), [
    'ev-000000000000000000000002',
    'ev-000000000000000000000001',
  ]);
});

test('a retried failed save step restores the same deterministic comparison context', async () => {
  const evidence = [evidenceRecord('000000000000000000000001', 'https://x.com/i/web/status/1', { views: 10 })];
  const plan = await buildPlan('比较当前项目中表现最好的帖子并保存比较分析');
  const failing = mockBoundary({ evidence });
  const originalClient = failing.client;
  failing.client = async (call) => {
    if (call.operation === 'workspace.analysis.create') return { ok: false, code: 'BOUNDARY_FAILED', diagnostics: { issues: ['模拟写入失败'] } };
    return originalClient(call);
  };
  const taskView = view(plan);
  const stateReader = createBridgeStateReader(failing.client);
  const failed = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: failing.client, stateReader });
  // The read and local compare steps succeeded before the write step failed,
  // so the truthful outer outcome is partial, not failed.
  assert.equal(failed.outcome, 'partial');
  assert.equal(taskView.step_states['st-2'].state, 'failed');

  // Retry only the failed write step; the read and local compare steps stay
  // untouched and the ranking is rebuilt from the fresh project state.
  const retried = { ...structuredClone(taskView), retry_target: { step_id: 'st-2', plan_fingerprint: plan.fingerprint, retried_at: '2026-08-16T08:01:00.000Z' } };
  const restored = mockBoundary({ evidence });
  const restoredStateReader = createBridgeStateReader(restored.client);
  const output = await executeConfirmedPlan({ taskView: retried, plan, signal: null, emit: () => {}, toolClient: restored.client, stateReader: restoredStateReader });
  assert.equal(output.outcome, 'succeeded');
  assert.equal(output.result_data.compare.ranking[0].evidence_id, 'ev-000000000000000000000001');
  assert.equal(output.result_data.compare.persisted, true);
});

test('research.analyze_persisted accepts exactly {project_id, evidence_id} and extra fields fail with bounded exact diagnostics', () => {
  const context = { task_id: TASK_ID, user_id: 'user-a', project_id: PROJECT_ID, approval: { paid_external_calls: true } };
  const exact = validateToolCall({
    schema_version: TOOL_SCHEMA_VERSION,
    operation: 'research.analyze_persisted',
    payload: { project_id: PROJECT_ID, evidence_id: 'ev-111111111111111111111111' },
    idempotency_key: 'idem-analyze',
  }, context);
  assert.equal(exact.ok, true);
  assert.deepEqual(toBoundaryRequest(exact.value).body, {
    action: 'analyze_persisted',
    project_id: PROJECT_ID,
    evidence_id: 'ev-111111111111111111111111',
    idempotency_key: `h-${createHash('sha256').update(`${TASK_ID}\0idem-analyze`, 'utf8').digest('hex')}`,
  }, 'the boundary payload is exactly {project_id, evidence_id} plus the bound idempotency key');

  const extra = validateToolCall({
    schema_version: TOOL_SCHEMA_VERSION,
    operation: 'research.analyze_persisted',
    payload: { project_id: PROJECT_ID, evidence_id: 'ev-111111111111111111111111', model: 'some-model-name' },
    idempotency_key: 'idem-analyze-extra',
  }, context);
  assert.equal(extra.ok, false);
  assert.equal(extra.code, 'UNKNOWN_PAYLOAD_FIELD');
  assert.equal(extra.diagnostics.operation, 'research.analyze_persisted', 'diagnostics carry the exact operation');
  assert.equal(extra.diagnostics.field, 'model', 'diagnostics carry the exact offending field');
  // Bounded diagnostics never leak payload values, tokens, headers or secrets.
  const serialized = JSON.stringify(extra);
  assert.doesNotMatch(serialized, /some-model-name|Bearer|token|secret/i);
});
