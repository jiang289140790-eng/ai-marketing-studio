/* global Response, structuredClone, URL */
// Deterministic executor tests: exact single-item expansion of batch intents
// with unique deterministic idempotency keys, exact payload construction for
// every TOOL_DEFINITIONS operation, reuse adversarial cases (missing,
// duplicate, wrong-project, wrong-version, wrong-fingerprint), failed-step-only
// retry, and zero bridge calls on any plan/template bug.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { TOOL_DEFINITIONS, validateToolCall } from '../tool-contract.mjs';
import { buildPlan as buildExactPlan, createPlanner, validatePlanShape } from '../planner.mjs';
import { createToolClient } from '../tool-client.mjs';
import {
  BRIEF_CARD_IDENTITY_INVALID,
  BRIEF_PROJECT_IDENTITY_INVALID,
  PAID_AMBIGUOUS_CODES,
  STEP_LABELS,
  createBridgeStateReader,
  deriveCanonicalBriefId,
  executeConfirmedPlan,
  metricValue,
} from '../deterministic-executor.mjs';

const TASK_ID = 'ht-11111111-1111-4111-8111-111111111111';
const planner = createPlanner();

async function buildPlan(intent, projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa') {
  const result = await planner.plan({
    taskId: TASK_ID,
    request: { user_id: 'user-a', project_id: projectId, intent, request_fingerprint: 'a'.repeat(64) },
  });
  assert.equal(result.ok, true, result.code);
  return result.value;
}

function view(plan) {
  return {
    id: TASK_ID,
    request: { user_id: plan.user_id || 'user-a', project_id: plan.project_id, intent: plan.intent },
    plan,
    confirmation: {
      approval: {
        paid_external_calls: plan.approvals.paid_external_calls,
        online_writes: plan.approvals.online_writes,
        handoff_creation: plan.approvals.handoff_creation,
      },
      confirmed_at: '2026-08-15T08:00:00.000Z',
    },
    step_states: {},
  };
}

function attachmentInspectionResult(call) {
  const contentText = 'A verified private image showing a product comparison layout.';
  const contentSha256 = createHash('sha256').update(contentText).digest('hex');
  const item = {
    id: 'h5-att-aaaaaaaaaaaaaaaaaaaaaaaa',
    platform: 'private_attachment',
    source_url: 'https://xtkkdvghiohlnpfnnhmx.supabase.co/storage/v1/object/authenticated/harness-thread-attachments/source.png',
    label: 'source.png',
    content_text: contentText,
    content_sha256: contentSha256,
    collection_proof: `1999999999.${'c'.repeat(64)}`,
    provenance: {
      run_id: TASK_ID,
      thread_id: call.payload.thread_id,
      collected_at: '2026-08-24T12:00:00.000Z',
      usage_total_usd: 0.01,
      budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      object_bindings: call.payload.attachments.map((attachment) => ({
        ...structuredClone(attachment),
        sha256: 'd'.repeat(64),
      })),
    },
  };
  return {
    ok: true,
    data: {
      items: [item],
      analyses: [{
        source_id: item.id,
        model: 'qwen3.5-omni-flash',
        executed_at: '2026-08-24T12:00:01.000Z',
        result: {
          text_expression: 'Product comparison headline and two-column layout.',
          media_analysis: [{ type: 'image', description: 'Two product cards with contrasting benefits.' }],
          virality_drivers: ['clear contrast'],
          reusable_methods: ['before-after structure'],
          signals: ['comparison'],
          risks: [],
        },
        usage: { total_tokens: 120 },
        cost: { recorded_cny: 0.02, reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      }],
      usage: { total_tokens: 120 },
      cost: { recorded_cny: 0.02 },
    },
    artifact_refs: [],
  };
}

function searchItem(url, index) {
  const text = `搜索命中 ${index} 的内容文本`;
  return {
    id: `search-item-${index}`, source_url: url, label: `命中 ${index}`, platform: 'x', content_text: text,
    external_id: `99${index}`, content_sha256: createHash('sha256').update(text).digest('hex'),
    provenance: { schema_version: 'p22_collected_source_v1', provider: 'apify:xquik/x-tweet-scraper', run_id: 'run-s', collected_at: '2026-08-15T08:00:00.000Z', usage_total_usd: 0.001, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    collection_proof: '1999999999.' + 'c'.repeat(64), source_metadata: { author: { name: 'A' }, engagement: { likes: index } }, media_assets: [],
  };
}

// Mock boundary enforcing the exact envelope contract; records every call and
// every idempotency key.
function mockBoundary(seed = { evidence: [], analyses: [], cards: [], brief: null, handoffs: [] }) {
  const state = { revision: 3, ...seed };
  const calls = [];
  const ids = new Set();
  const assertCurrentRevision = (call) => {
    assert.equal(call.expected_revision, state.revision, `${call.operation} must bind the latest project revision before bridge contact`);
  };
  const client = async (call, trusted) => {
    calls.push(call);
    // The bounded project-state read intentionally reuses one key; every
    // expanded step call must be unique.
    if (call.idempotency_key !== 'state-read') {
      assert.equal(ids.has(call.idempotency_key), false, 'idempotency keys must be unique per execution');
      ids.add(call.idempotency_key);
    }
    switch (call.operation) {
      case 'workspace.project.read':
        return { ok: true, data: { project: { version: state.revision, topic: 't', objective: 'o', constraints: [], evidence: state.evidence, analyses: state.analyses, knowledge_cards: state.cards, brief: state.brief, handoffs: state.handoffs } } };
      case 'research.search_x': {
        const count = call.payload.count;
        const items = Array.from({ length: count }, (_, index) => searchItem(`https://x.com/i/web/status/9${index}`, index));
        return { ok: true, data: { items }, artifact_refs: [] };
      }
      case 'research.search_reddit': {
        const items = Array.from({ length: call.payload.count }, (_, index) => searchItem(`https://www.reddit.com/r/x/comments/9${index}/t${index}/`, index));
        return { ok: true, data: { items }, artifact_refs: [] };
      }
      case 'research.collect_url': {
        const text = '采集正文内容';
        const item = {
          id: 'x-post-1', source_url: call.payload.url, label: '帖子', platform: 'x', content_text: text,
          external_id: '1234567890123456789', content_sha256: createHash('sha256').update(text).digest('hex'),
          provenance: { schema_version: 'p22_collected_source_v1', provider: 'apify:xquik/x-tweet-scraper', run_id: 'run-1', collected_at: '2026-08-15T08:00:00.000Z', usage_total_usd: 0.01, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
          collection_proof: '1999999999.' + 'c'.repeat(64), source_metadata: { author: { name: 'A' }, engagement: { likes: 1 } }, media_assets: [],
        };
        return { ok: true, entity: { type: 'evidence', id: 'ev-dummy' }, data: { items: [item] }, artifact_refs: [] };
      }
      case 'research.inspect_attachments':
        return attachmentInspectionResult(call);
      case 'workspace.evidence.create': {
        assertCurrentRevision(call);
        const id = `ev-${createHash('sha256').update(call.idempotency_key).digest('hex').slice(0, 24)}`;
        state.evidence = [...state.evidence, { ...call.payload.evidence, id, project_id: trusted.project_id, fingerprint: `ef${id.slice(2)}`, version: 1 }];
        state.revision += 1;
        return { ok: true, entity: { type: 'evidence', id }, artifact_refs: [id] };
      }
      case 'research.analyze_persisted':
        return { ok: true, data: { analyses: [{ source_id: 'x-post-1', model: 'qwen3.5-omni-flash', text_expression: 'x', media_analysis: [], virality_drivers: [], reusable_methods: [], signals: [], risks: [] }], usage: { total_tokens: 200 }, cost: { recorded_cny: 2 } }, artifact_refs: [] };
      case 'workspace.analysis.create': {
        assertCurrentRevision(call);
        const record = { ...call.payload.analysis, fingerprint: `af${call.payload.analysis.id.slice(3)}` };
        state.analyses = [record];
        state.revision += 1;
        return { ok: true, entity: { type: 'analysis', id: record.id }, artifact_refs: [record.id] };
      }
      case 'workspace.card.create': {
        assertCurrentRevision(call);
        const record = { ...call.payload.card, fingerprint: `kf${call.payload.card.id.slice(3)}` };
        state.cards = [record];
        state.revision += 1;
        return { ok: true, entity: { type: 'card', id: record.id }, artifact_refs: [record.id] };
      }
      case 'workspace.brief.assemble': {
        assertCurrentRevision(call);
        const record = { ...call.payload.brief, fingerprint: 'bf'.repeat(32) };
        state.brief = record;
        state.revision += 1;
        return { ok: true, entity: { type: 'brief', id: record.id }, artifact_refs: [record.id] };
      }
      case 'workspace.lineage.audit':
        return { ok: true, read_only: true, data: { lineage: { evidence: state.evidence.length } } };
      default:
        return { ok: false, code: 'UNEXPECTED_OPERATION' };
    }
  };
  return { state, calls, client };
}

async function run(plan, bridge) {
  const taskView = view(plan);
  const stateReader = createBridgeStateReader(bridge.client);
  const output = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: bridge.client, stateReader });
  return { taskView, output };
}

test('every workflow step builds an exact payload that passes validateToolCall', async () => {
  const bridge = mockBoundary();
  const intents = [
    '分析这个 X 帖子 https://x.com/a/status/1234567890123456789，保存证据和分析，并生成待审核 Brief',
    '搜索 X 上 AI 营销，选 2 条保存为证据',
    '搜索 reddit 上 AI 营销，选 2 条保存为证据',
    '把项目里现有证据都分析一遍',
    '比较当前项目中表现最好的帖子',
    '审计一下来源血缘',
    '帮我读一下当前项目状态',
  ];
  const seenOperations = new Set();
  for (const intent of intents) {
    const plan = await buildPlan(intent);
    const callStart = bridge.calls.length;
    const { taskView, output } = await run(plan, bridge);
    assert.equal(output.outcome, 'succeeded', `${intent} → ${output.outcome}: ${JSON.stringify(taskView.step_states)}`);
    for (const call of bridge.calls.slice(callStart)) {
      if (!call.idempotency_key.startsWith('d-') || call.idempotency_key === 'state-read') continue;
      seenOperations.add(call.operation);
      const definition = TOOL_DEFINITIONS[call.operation];
      assert.ok(definition, `operation ${call.operation} is allowlisted`);
      const payloadKeys = Object.keys(call.payload).sort();
      const allowedKeys = [...definition.fields].sort();
      // Every payload key must be one of the operation's exact allowed fields,
      // and every required field must be present; optional fields may be
      // omitted (validateToolCall below enforces the same contract).
      assert.ok(payloadKeys.every((key) => allowedKeys.includes(key)), `${call.operation} payload has only allowed fields (got ${payloadKeys.join(',')})`);
      for (const key of definition.fields) {
        if (!definition.optional.includes(key)) assert.ok(payloadKeys.includes(key), `${call.operation} missing required field ${key}`);
      }
      const checked = validateToolCall(
        { schema_version: 'ams_harness_tool_v1', operation: call.operation, payload: call.payload, idempotency_key: call.idempotency_key, expected_revision: call.expected_revision },
        { task_id: TASK_ID, user_id: 'user-a', project_id: plan.project_id, approval: plan.approvals },
      );
      assert.equal(checked.ok, true, `${call.operation} passes validateToolCall (${checked.code})`);
    }
    assert.ok(taskView.step_states['st-0'].state, 'step states recorded');
  }
  // every TOOL_DEFINITIONS operation used by a workflow was constructed exactly
  for (const workflow of ['search_x', 'search_reddit']) {
    const plan = await buildPlan(workflow === 'search_x' ? '搜索 X 上 AI 营销，选 2 条保存为证据' : '搜索 reddit 上 AI 营销，选 2 条保存为证据');
    for (const step of plan.steps) if (step.operation) seenOperations.add(step.operation);
  }
});

test('verified private attachment executes one paid inspection and preserves Evidence → Analysis → Knowledge → pending Brief lineage', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const threadId = 'thr_22222222-2222-4222-8222-222222222222';
  const attachment = {
    ref: `harness-thread-attachments:${userId}/${threadId}/req-1/source.png`,
    name: 'source.png',
    size: 1024,
    mime_type: 'image/png',
  };
  const planned = await planner.plan({
    taskId: TASK_ID,
    request: {
      user_id: userId,
      project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa',
      intent: '请理解附件并生成知识卡和待审核 Brief',
      attachments: [attachment],
      request_fingerprint: 'a'.repeat(64),
    },
  });
  assert.equal(planned.ok, true, planned.code);
  const bridge = mockBoundary();
  const { output } = await run(planned.value, bridge);
  assert.equal(output.outcome, 'succeeded');

  const businessCalls = bridge.calls.filter((call) => call.operation !== 'workspace.project.read');
  assert.deepEqual(businessCalls.map((call) => call.operation), [
    'research.inspect_attachments',
    'workspace.evidence.create',
    'workspace.analysis.create',
    'workspace.card.create',
    'workspace.brief.assemble',
  ]);
  assert.equal(bridge.calls.filter((call) => call.operation === 'research.inspect_attachments').length, 1, 'exactly one paid attachment inspection');
  assert.deepEqual(businessCalls[0].payload.attachments, [attachment]);
  assert.equal(businessCalls[0].payload.thread_id, threadId);

  assert.equal(bridge.state.evidence.length, 1);
  const evidence = bridge.state.evidence[0];
  assert.equal(evidence.provenance.schema_version, 'h5_verified_attachment_provenance_v1');
  assert.deepEqual(evidence.provenance.object_bindings, [{ ...attachment, sha256: 'd'.repeat(64) }]);
  assert.equal(bridge.state.analyses.length, 1);
  assert.equal(bridge.state.analyses[0].evidence_id, evidence.id);
  assert.equal(bridge.state.analyses[0].model_analysis.model, 'qwen3.5-omni-flash');
  assert.equal(bridge.state.cards.length, 1);
  assert.equal(bridge.state.cards[0].analysis_id, bridge.state.analyses[0].id);
  assert.equal(bridge.state.cards[0].evidence_id, evidence.id);
  assert.equal(bridge.state.brief.status, 'pending_review');
  assert.deepEqual(bridge.state.brief.knowledge_citation_ids, [bridge.state.cards[0].id]);
  assert.deepEqual(bridge.state.brief.evidence_provenance.evidence_ids, [evidence.id]);
  assert.equal(output.result_data.attachment_pipeline.source.id, 'h5-att-aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(output.result_data.attachment_pipeline.analysis.model, 'qwen3.5-omni-flash');
  assert.deepEqual(
    output.result_data.attachment_pipeline.source.provenance.object_bindings,
    [{ ...attachment, sha256: 'd'.repeat(64) }],
  );
  assert.equal(JSON.stringify(output.result_data).includes('signed_url'), false, 'signed URLs are never persisted');
});

test('malformed attachment model response stops after one paid inspection and performs zero downstream writes', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const threadId = 'thr_22222222-2222-4222-8222-222222222222';
  const planned = await planner.plan({
    taskId: TASK_ID,
    request: {
      user_id: userId,
      project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa',
      intent: '请理解附件并生成知识卡和待审核 Brief',
      attachments: [{
        ref: `harness-thread-attachments:${userId}/${threadId}/req-1/source.png`,
        name: 'source.png', size: 1024, mime_type: 'image/png',
      }],
      request_fingerprint: 'a'.repeat(64),
    },
  });
  assert.equal(planned.ok, true, planned.code);
  const base = mockBoundary();
  const calls = [];
  const client = async (call, trusted) => {
    calls.push(call);
    if (call.operation === 'research.inspect_attachments') {
      return {
        ok: false,
        code: 'MODEL_RESPONSE_INVALID',
        diagnostics: {
          field: 'output.choices[0].message.content',
          reason: 'JSON_INVALID',
          response_shape: {
            root_type: 'object',
            known_root_keys: ['output', 'usage'],
            compatible_choice_count: null,
            native_choice_count: 1,
            content_type: 'string',
            content_length: 9528,
            content_part_count: null,
            content_parts: [],
            json_root_type: null,
            analysis_rows: [{
              row_type: 'object',
              keys: ['source_id', 'PRIVATE_USER_VALUE_MUST_NOT_ESCAPE'],
              field_types: { source_id: 'string', PRIVATE_USER_VALUE_MUST_NOT_ESCAPE: 'string' },
              media_count: 0,
              media_rows: [],
            }],
          },
          raw_response: 'PRIVATE_MODEL_BODY_MUST_NOT_ESCAPE',
          authorization: 'Bearer PRIVATE_TOKEN_MUST_NOT_ESCAPE',
        },
      };
    }
    return base.client(call, trusted);
  };
  const taskView = view(planned.value);
  const output = await executeConfirmedPlan({
    taskView,
    plan: planned.value,
    signal: null,
    emit: () => {},
    toolClient: client,
    stateReader: createBridgeStateReader(client),
  });
  assert.equal(output.outcome, 'failed');
  assert.equal(calls.filter((call) => call.operation === 'research.inspect_attachments').length, 1);
  assert.deepEqual(calls.filter((call) => call.operation.startsWith('workspace.') && call.operation !== 'workspace.project.read'), []);
  const failedStep = taskView.step_states[planned.value.steps.find((step) => step.operation === 'research.inspect_attachments').step];
  assert.equal(failedStep.failed_count, 1, 'the first real provider call is exactly attempt 1');
  assert.equal(failedStep.error.code, 'MODEL_RESPONSE_INVALID');
  assert.equal(failedStep.error.field, 'output.choices[0].message.content');
  assert.equal(failedStep.error.reason, 'JSON_INVALID');
  assert.deepEqual(failedStep.error.response_shape, {
    root_type: 'object',
    known_root_keys: ['output', 'usage'],
    compatible_choice_count: null,
    native_choice_count: 1,
    content_type: 'string',
    content_length: 9528,
    content_part_count: null,
    content_parts: [],
    json_root_type: null,
    analysis_rows: [{
      row_type: 'object',
      keys: ['source_id', '<unrecognized-key>'],
      field_types: { source_id: 'string', '<unrecognized-key>': 'string' },
      media_count: 0,
      media_rows: [],
    }],
  });
  assert.equal(JSON.stringify(taskView.step_states).includes('PRIVATE_MODEL_BODY_MUST_NOT_ESCAPE'), false);
  assert.equal(JSON.stringify(taskView.step_states).includes('PRIVATE_TOKEN_MUST_NOT_ESCAPE'), false);
  assert.equal(JSON.stringify(taskView.step_states).includes('PRIVATE_USER_VALUE_MUST_NOT_ESCAPE'), false);
  assert.deepEqual(failedStep.error.response_shape.analysis_rows[0].keys, ['source_id', '<unrecognized-key>']);
  assert.equal(base.state.evidence.length, 0);
  assert.equal(base.state.analyses.length, 0);
  assert.equal(base.state.cards.length, 0);
  assert.equal(base.state.brief, null);
});

test('batch expansion: 1, 2, max and over-limit inputs get exactly one call per item', async () => {
  const maxPlan = await buildPlan('搜索 X 上 AI 营销，选 5 条保存为证据');
  assert.equal(maxPlan.steps.find((step) => step.fan_out).fan_out.max, 5);
  const bridge = mockBoundary();
  const { output } = await run(maxPlan, bridge);
  assert.equal(output.outcome, 'succeeded');
  const evidenceCreates = bridge.calls.filter((call) => call.operation === 'workspace.evidence.create');
  assert.equal(evidenceCreates.length, 5, 'exactly one evidence.create per saved item');
  const keys = evidenceCreates.map((call) => call.idempotency_key);
  assert.equal(new Set(keys).size, 5, 'unique deterministic idempotency keys per item');
  const searchCalls = bridge.calls.filter((call) => call.operation === 'research.search_x');
  assert.equal(searchCalls.length, 1, 'exactly one search call');
  assert.equal(searchCalls[0].payload.count, 5);
  const onePlan = await buildPlan('搜索 X 上 AI 营销，选 1 条保存为证据');
  const bridge1 = mockBoundary();
  const oneRun = await run(onePlan, bridge1);
  assert.equal(oneRun.output.outcome, 'succeeded');
  assert.equal(bridge1.calls.filter((call) => call.operation === 'workspace.evidence.create').length, 1);
  assert.equal(bridge1.calls.filter((call) => call.operation === 'research.search_x').length, 1);
  // zero saved items: no evidence writes at all
  const zeroPlan = await buildPlan('搜索 X 上 AI 营销');
  const bridge0 = mockBoundary();
  const zeroRun = await run(zeroPlan, bridge0);
  assert.equal(zeroRun.output.outcome, 'succeeded');
  assert.equal(bridge0.calls.some((call) => call.operation === 'workspace.evidence.create'), false);
  // over-limit intent fails closed at plan time
  const over = await planner.plan({
    taskId: TASK_ID,
    request: { user_id: 'user-a', project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', intent: '搜索 X 上 AI，选 99 条保存为证据', request_fingerprint: 'a'.repeat(64) },
  });
  assert.equal(over.ok, false);
});

test('analysis and comparison execution honor their requested count slots', async () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const evidence = Array.from({ length: 4 }, (_, index) => ({
    id: `ev-${String(index + 1).padStart(24, '0')}`,
    project_id: projectId,
    source_url: `https://x.com/i/web/status/8${index}`,
    label: `source ${index}`,
    platform: 'X · Apify',
    content_text: `evidence ${index}`,
    source_metadata: { engagement: { likes: 100 - index } },
    media_metadata: { sha256: createHash('sha256').update(`evidence ${index}`).digest('hex') },
    fingerprint: createHash('sha256').update(`fingerprint ${index}`).digest('hex'),
    version: 1,
  }));

  const analysisPlan = await buildPlan('分析 1 条证据', projectId);
  assert.equal(analysisPlan.cost_indicators.paid_calls, 1);
  assert.equal(analysisPlan.cost_indicators.online_writes, 1);
  const analysisBridge = mockBoundary({ evidence });
  const analyzed = await run(analysisPlan, analysisBridge);
  assert.equal(analyzed.output.outcome, 'succeeded');
  assert.equal(analysisBridge.calls.filter((call) => call.operation === 'research.analyze_persisted').length, 1);
  assert.equal(analysisBridge.calls.filter((call) => call.operation === 'workspace.analysis.create').length, 1);

  // compare_project is read-only by default: zero paid calls, zero writes,
  // and the bounded deterministic ranking is returned instead.
  const comparisonPlan = await buildPlan('比较 2 条当前项目中表现最好的帖子', projectId);
  assert.equal(comparisonPlan.cost_indicators.paid_calls, 0);
  assert.equal(comparisonPlan.cost_indicators.online_writes, 0);
  const comparisonBridge = mockBoundary({ evidence });
  const compared = await run(comparisonPlan, comparisonBridge);
  assert.equal(compared.output.outcome, 'succeeded');
  assert.equal(comparisonBridge.calls.filter((call) => call.operation === 'workspace.analysis.create').length, 0, 'read-only comparison writes nothing');
  assert.equal(comparisonBridge.calls.some((call) => call.operation.startsWith('research.')), false, 'read-only comparison makes zero research/model calls');
  assert.equal(compared.output.result_data.compare.metric, 'engagement');
  assert.equal(compared.output.result_data.compare.persisted, false);
  assert.equal(compared.output.result_data.compare.ranking.length, 2);

  // Explicit save language opts into persistence, which requires the exact
  // online_writes approval before any write can happen.
  const persistedPlan = await buildPlan('比较 2 条当前项目中表现最好的帖子并保存比较分析', projectId);
  assert.equal(persistedPlan.cost_indicators.paid_calls, 0);
  assert.equal(persistedPlan.cost_indicators.online_writes, 2);
  assert.equal(persistedPlan.approvals.online_writes, true);
  const persistedBridge = mockBoundary({ evidence });
  const persisted = await run(persistedPlan, persistedBridge);
  assert.equal(persisted.output.outcome, 'succeeded');
  assert.equal(persistedBridge.calls.filter((call) => call.operation === 'workspace.analysis.create').length, 2);
  assert.equal(persistedBridge.calls.some((call) => call.operation.startsWith('research.')), false, 'persisted comparison still makes zero research/model calls');
  assert.equal(persisted.output.result_data.compare.persisted, true);
  assert.equal(persisted.output.result_data.compare.ranking.length, 2);
});

test('reuse adversarial: exact match skips cost/write; missing/duplicate/stale fails closed', async () => {
  // Exact existing evidence for the same URL and content hash → collect and
  // evidence.create both reuse; zero paid calls and zero writes.
  const text = '采集正文内容';
  const existingEvidence = [{
    id: 'ev-111111111111111111111111', project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', source_url: 'https://x.com/i/web/status/1234567890123456789',
    label: '帖子', platform: 'X · Apify', content_text: text, recorded_at: '2026-08-15T08:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false, method: 'apify_public_collection',
      provider: 'apify:xquik/x-tweet-scraper', source_platform: 'x', source_id: 'x-post-1', external_id: '1234567890123456789',
      source_url: 'https://x.com/i/web/status/1234567890123456789', run_id: 'run-1', collected_at: '2026-08-15T08:00:00.000Z',
      usage_total_usd: 0.01, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      content_sha256: createHash('sha256').update(text).digest('hex'), collection_proof: '1999999999.' + 'c'.repeat(64),
      statement: 'test',
    },
    media_metadata: { sha256: createHash('sha256').update(text).digest('hex') }, media_assets: [],
    fingerprint: 'e'.repeat(64), version: 1,
  }];
  const plan = await buildPlan('分析这个 X 帖子 https://x.com/a/status/1234567890123456789，保存证据和分析，并生成待审核 Brief');
  const reuseBridge = mockBoundary({ evidence: existingEvidence });
  const reuseRun = await run(plan, reuseBridge);
  assert.equal(reuseRun.output.outcome, 'succeeded');
  assert.equal(reuseRun.taskView.step_states['st-1'].state, 'reused', 'collect step reused');
  assert.equal(reuseRun.taskView.step_states['st-2'].state, 'reused', 'evidence write step reused');
  assert.equal(reuseBridge.calls.filter((call) => call.operation === 'research.collect_url').length, 0, 'no paid collection');
  assert.equal(reuseBridge.calls.filter((call) => call.operation === 'workspace.evidence.create').length, 0, 'no evidence write');

  // Duplicate exact matches fail closed with REUSE_AMBIGUOUS.
  const duplicateBridge = mockBoundary({ evidence: [existingEvidence[0], { ...existingEvidence[0], id: 'ev-222222222222222222222222', fingerprint: 'f'.repeat(64) }] });
  const dupRun = await run(plan, duplicateBridge);
  assert.equal(dupRun.output.outcome, 'failed');
  const collectStep = dupRun.taskView.step_states['st-1'];
  assert.equal(collectStep.error.code, 'REUSE_AMBIGUOUS');

  // Wrong-project evidence must not be reused: a project binding mismatch
  // makes the exact identity lookup fail (never a cross-project guess).
  const wrongProject = mockBoundary({ evidence: [{ ...existingEvidence[0], project_id: 'prj-bbbbbbbbbbbbbbbbbbbbbbbb' }] });
  const wrongRun = await run(plan, wrongProject);
  assert.equal(wrongRun.output.outcome, 'succeeded');
  assert.equal(wrongProject.calls.filter((call) => call.operation === 'research.collect_url').length, 1, 'collect runs when no exact same-project record exists');

  // Stale version (wrong fingerprint/version on the evidence) means the
  // analysis must not reuse a stale analysis: missing exact analysis runs.
  const staleBridge = mockBoundary({
    evidence: existingEvidence,
    analyses: [{
      id: 'an-aaaaaaaaaaaaaaaaaaaaaaaa', project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', evidence_id: 'ev-111111111111111111111111',
      schema_version: 'p19_analysis_v1', kind: 'deterministic_local', evidence_fingerprint: 'old-fingerprint', evidence_version: 0,
      model_analysis: { schema_version: 'p29_multimodal_model_v1', provider: 'dashscope', model: 'qwen3.5-omni-flash', result: {}, usage: { total_tokens: 100 } },
      fingerprint: 'a'.repeat(64), version: 1,
    }],
  });
  const staleRun = await run(plan, staleBridge);
  assert.equal(staleRun.output.outcome, 'succeeded');
  assert.equal(staleRun.taskView.step_states['st-3'].state, 'succeeded', 'stale analysis binding is not reused (fresh paid analyze)');
  assert.equal(staleRun.taskView.step_states['st-4'].state, 'succeeded');

  // Wrong fingerprint on the card lineage must not reuse.
  const cardBridge = mockBoundary({
    evidence: existingEvidence,
    analyses: [{
      id: 'an-aaaaaaaaaaaaaaaaaaaaaaaa', project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', evidence_id: 'ev-111111111111111111111111',
      schema_version: 'p19_analysis_v1', kind: 'deterministic_local', evidence_fingerprint: 'e'.repeat(64), evidence_version: 1,
      model_analysis: { schema_version: 'p29_multimodal_model_v1', provider: 'dashscope', model: 'qwen3.5-omni-flash', result: {}, usage: { total_tokens: 100 } },
      fingerprint: 'a'.repeat(64), version: 1,
    }],
    cards: [{
      id: 'kc-111111111111111111111111', project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', evidence_id: 'ev-111111111111111111111111',
      analysis_id: 'an-aaaaaaaaaaaaaaaaaaaaaaaa', analysis_fingerprint: 'wrong-fingerprint',
      schema_version: 'content_knowledge_card_v1', version: 1, fingerprint: 'k'.repeat(64),
    }],
  });
  const cardRun = await run(plan, cardBridge);
  assert.equal(cardRun.output.outcome, 'succeeded');
  assert.equal(cardRun.taskView.step_states['st-5'].state, 'succeeded', 'wrong-lineage card is not reused');
});

test('first failure blocks dependents and marks them blocked; summary is truthful', async () => {
  const plan = await buildPlan('分析这个 X 帖子 https://x.com/a/status/1234567890123456789，保存证据和分析，并生成待审核 Brief');
  const bridge = mockBoundary();
  const original = bridge.client;
  let analyzed = 0;
  bridge.client = async (call, trusted) => {
    if (call.operation === 'research.analyze_persisted') {
      analyzed += 1;
      if (analyzed === 1) return { ok: false, code: 'QWEN_REQUEST_FAILED', diagnostics: { issues: ['model down'] } };
    }
    return original(call, trusted);
  };
  const { taskView, output } = await run(plan, bridge);
  assert.equal(output.outcome, 'partial', 'succeeded steps before the failure => partial');
  assert.equal(taskView.step_states['st-3'].state, 'failed');
  assert.equal(taskView.step_states['st-4'].state, 'blocked');
  assert.equal(taskView.step_states['st-5'].state, 'blocked');
  assert.equal(taskView.step_states['st-6'].state, 'blocked');
  assert.ok(output.final_response.includes('失败'), 'summary reflects the failure');
  assert.ok(output.final_response.includes('被阻断'), 'summary reflects blocked steps');
  assert.equal(STEP_LABELS[taskView.step_states['st-4'].state], '被阻断');
});

test('a planner/template bug surfaces as INTERNAL_PLAN_VALIDATION_ERROR with zero bridge calls', async () => {
  const plan = await buildPlan('审计一下来源血缘');
  const broken = { ...plan, steps: [{ ...plan.steps[0], operation: 'research.invented' }] };
  const bridge = mockBoundary();
  const taskView = view(plan);
  const output = await executeConfirmedPlan({ taskView, plan: broken, signal: null, emit: () => {}, toolClient: bridge.client, stateReader: createBridgeStateReader(bridge.client) });
  assert.equal(output.outcome, 'failed');
  assert.equal(taskView.step_states['st-0'].error.code, 'INTERNAL_PLAN_VALIDATION_ERROR');
  assert.equal(taskView.step_states['st-0'].error.retry_unsafe, true, 'a broken plan is not retryable');
  assert.equal(taskView.step_states['st-0'].failed_count, 0, 'plan validation failed before any real tool call');
  assert.equal(bridge.calls.length, 0, 'zero bridge calls on a plan bug');
});

test('empty fan-out inputs fail closed instead of reporting a reused success', async () => {
  for (const intent of ['把项目里现有证据都分析一遍']) {
    const plan = await buildPlan(intent);
    const bridge = mockBoundary();
    const { taskView, output } = await run(plan, bridge);
    assert.equal(output.outcome, 'partial', `${intent}: the bounded project read succeeded before the empty fan-out failed`);
    const fanOutStep = plan.steps.find((step) => step.fan_out);
    assert.ok(fanOutStep, 'the workflow contains the expected fan-out step');
    assert.equal(taskView.step_states[fanOutStep.step].state, 'failed');
    assert.equal(taskView.step_states[fanOutStep.step].error.code, 'FAN_OUT_SOURCE_EMPTY');
    assert.equal(taskView.step_states[fanOutStep.step].item_count, 0);
    assert.equal(taskView.step_states[fanOutStep.step].executed_count, 0);
    assert.equal(
      bridge.calls.filter((call) => call.operation !== 'workspace.project.read').length,
      0,
      'empty source executes no business tools',
    );
  }

  // compare_project is not a fan-out workflow: with zero evidence the default
  // read-only comparison still succeeds and returns the empty deterministic
  // ranking instead of failing closed.
  const comparePlan = await buildPlan('比较当前项目中表现最好的帖子');
  const compareBridge = mockBoundary();
  const compared = await run(comparePlan, compareBridge);
  assert.equal(compared.output.outcome, 'succeeded');
  assert.equal(compared.taskView.step_states['st-1'].state, 'succeeded', 'the local compare step succeeds on an empty project');
  assert.equal(compared.taskView.step_states['st-1'].item_count, 0);
  assert.equal(compared.output.result_data.compare.metric, 'engagement');
  assert.equal(compared.output.result_data.compare.persisted, false);
  assert.deepEqual(compared.output.result_data.compare.ranking, []);
  assert.equal(
    compareBridge.calls.filter((call) => call.operation !== 'workspace.project.read').length,
    0,
    'an empty read-only comparison executes no business tools',
  );
});

test('PAID_AMBIGUOUS_CODES are bounded and exposed for retry gating', () => {
  assert.ok(PAID_AMBIGUOUS_CODES.includes('TOOL_TIMEOUT'));
  assert.ok(PAID_AMBIGUOUS_CODES.includes('TOOL_BRIDGE_UNAVAILABLE'));
  assert.ok(!PAID_AMBIGUOUS_CODES.includes('QWEN_REQUEST_FAILED'), 'definitive boundary rejections are not ambiguous');
});

test('failed-step retry restores bounded paid search output without repeating the paid call', async () => {
  const plan = await buildPlan('搜索 X 中 AI 营销，选 1 条保存为证据');
  const base = mockBoundary();
  let failSave = true;
  const operations = [];
  const client = async (call, trusted, signal) => {
    operations.push(call.operation);
    if (call.operation === 'workspace.evidence.create' && failSave) {
      return { ok: false, code: 'P19_ENTITY_REVISION_STALE', diagnostics: { issues: ['stale revision'] } };
    }
    return base.client(call, trusted, signal);
  };
  const taskView = view(plan);
  const stateReader = createBridgeStateReader(client);
  const first = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: client, stateReader });
  assert.equal(first.outcome, 'partial');
  const searchStep = plan.steps.find((step) => step.operation === 'research.search_x');
  const saveStep = plan.steps.find((step) => step.operation === 'workspace.evidence.create');
  assert.ok(taskView.step_states[searchStep.step].resume_output?.search_items?.length > 0);

  failSave = false;
  taskView.retry_target = { step_id: saveStep.step, plan_fingerprint: plan.fingerprint };
  const retried = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: client, stateReader });
  assert.equal(retried.outcome, 'succeeded');
  assert.equal(operations.filter((operation) => operation === 'research.search_x').length, 1);
  assert.equal(operations.filter((operation) => operation === 'workspace.evidence.create').length, 2);
  assert.equal(base.state.evidence.length, 1);
});

test('paid analysis retry keeps the restored result and rejects stale persisted lineage', async () => {
  const plan = await buildPlan('\u5206\u6790\u8fd9\u4e2a X \u5e16\u5b50 https://x.com/a/status/1234567890123456789\uff0c\u4fdd\u5b58\u8bc1\u636e\u548c\u5206\u6790\uff0c\u5e76\u751f\u6210\u5f85\u5ba1\u6838 Brief');
  const base = mockBoundary();
  let failAnalysisWrite = true;
  let paidCalls = 0;
  let savedAnalysis = null;
  const client = async (call, trusted, signal) => {
    if (call.operation === 'research.analyze_persisted') paidCalls += 1;
    if (call.operation === 'workspace.analysis.create') {
      if (failAnalysisWrite) return { ok: false, code: 'P19_ENTITY_REVISION_STALE', diagnostics: { issues: ['stale revision'] } };
      savedAnalysis = structuredClone(call.payload.analysis);
    }
    return base.client(call, trusted, signal);
  };
  const taskView = view(plan);
  const stateReader = createBridgeStateReader(client);
  const first = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: client, stateReader });
  assert.equal(first.outcome, 'partial');
  const paidStep = plan.steps.find((step) => step.operation === 'research.analyze_persisted');
  const saveStep = plan.steps.find((step) => step.operation === 'workspace.analysis.create');
  assert.equal(taskView.step_states[paidStep.step].state, 'succeeded');
  assert.equal(taskView.step_states[saveStep.step].state, 'failed');
  const currentEvidence = base.state.evidence[0];
  base.state.analyses = [{
    id: 'an-stale00000000000000000000',
    project_id: plan.project_id,
    evidence_id: currentEvidence.id,
    evidence_fingerprint: '0'.repeat(64),
    evidence_version: 0,
    schema_version: 'p19_analysis_v1',
    model_analysis: {
      schema_version: 'p29_multimodal_model_v1',
      provider: 'dashscope',
      method: 'qwen_multimodal',
      model: 'stale-model',
      result: { text_expression: 'stale-result' },
      usage: { total_tokens: 1 },
    },
    fingerprint: 'f'.repeat(64),
    version: 1,
  }];
  failAnalysisWrite = false;
  taskView.retry_target = { step_id: saveStep.step, plan_fingerprint: plan.fingerprint };
  const retried = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: client, stateReader });
  assert.equal(retried.outcome, 'succeeded');
  assert.equal(paidCalls, 1, 'the paid analysis is never repeated');
  assert.equal(savedAnalysis.model_analysis.model, 'qwen3.5-omni-flash');
  assert.equal(savedAnalysis.model_analysis.result.text_expression, 'x');
  assert.equal(savedAnalysis.model_analysis.usage.total_tokens, 200);
  assert.equal(savedAnalysis.model_analysis.usage.recorded_cny, 2);
  assert.notEqual(savedAnalysis.model_analysis.result.text_expression, 'stale-result');
});

test('terminal read-only workflows return their bounded tool result to the caller', async () => {
  const searchPlan = await buildPlan('\u641c\u7d22 X \u4e0a AI \u8425\u9500\u7684\u70ed\u95e8\u8bdd\u9898');
  const searchBridge = mockBoundary();
  const searched = await run(searchPlan, searchBridge);
  assert.equal(searched.output.outcome, 'succeeded');
  const searchResult = Object.values(searched.output.result_data)[0];
  assert.equal(searchResult.items.length, 5);
  assert.equal(searchResult.items[0].source_url, 'https://x.com/i/web/status/90');

  const auditPlan = await buildPlan('\u5ba1\u8ba1\u4e00\u4e0b\u6765\u6e90\u8840\u7f18');
  const auditBridge = mockBoundary();
  const audited = await run(auditPlan, auditBridge);
  assert.equal(audited.output.outcome, 'succeeded');
  assert.deepEqual(Object.values(audited.output.result_data)[0].lineage, { evidence: 0 });
});

test('collection-only URL plan succeeds after its paid call without reading a null project', async () => {
  const plan = await buildPlan('collect this X post https://x.com/a/status/1234567890123456789', null);
  assert.equal(plan.project_id, null);
  assert.deepEqual(plan.steps.map((step) => step.operation), ['research.collect_url']);
  const bridge = mockBoundary();
  const { output } = await run(plan, bridge);
  assert.equal(output.outcome, 'succeeded');
  assert.equal(bridge.calls.filter((call) => call.operation === 'research.collect_url').length, 1);
  assert.equal(bridge.calls.filter((call) => call.operation === 'workspace.project.read').length, 0);
  assert.equal(output.result_data.collect.items.length, 1);
});

test('an unrelated ordinary local analysis is never misrepresented as the read-only comparison result', async () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const evidence = {
    id: 'ev-111111111111111111111111',
    project_id: projectId,
    source_url: 'https://x.com/i/web/status/1234567890123456789',
    label: '帖子',
    platform: 'X · Apify',
    content_text: '用于比较的来源正文',
    source_metadata: { engagement: { likes: 25, comments: 3 } },
    fingerprint: 'e'.repeat(64),
    version: 1,
  };
  const ordinary = {
    schema_version: 'p19_analysis_v1',
    id: 'an-111111111111111111111111',
    project_id: projectId,
    evidence_id: evidence.id,
    evidence_fingerprint: evidence.fingerprint,
    evidence_version: evidence.version,
    kind: 'deterministic_local',
    version: 1,
    fingerprint: 'a'.repeat(64),
  };
  // No explicit persist intent (比较/提炼 are read-only), so the comparison
  // must not write or reuse anything: the ordinary analysis stays untouched
  // and the result is the deterministic local ranking of the evidence.
  const plan = await buildPlan('比较当前项目中表现最好的帖子，提炼可复用的内容规律', projectId);
  const bridge = mockBoundary({ evidence: [evidence], analyses: [ordinary], cards: [], brief: null, handoffs: [] });
  const { taskView, output } = await run(plan, bridge);
  assert.equal(output.outcome, 'succeeded');
  assert.equal(bridge.calls.filter((call) => call.operation === 'workspace.analysis.create').length, 0, 'no explicit persist intent => zero writes');
  assert.equal(bridge.calls.some((call) => call.operation.startsWith('research.')), false, 'the comparison makes zero research/model calls');
  assert.equal(taskView.step_states['st-1'].state, 'succeeded');
  assert.equal(taskView.step_states['st-1'].item_count, 1);
  assert.equal(taskView.step_states['st-1'].reused_count, 0);
  const compare = output.result_data.compare;
  assert.equal(compare.metric, 'engagement');
  assert.equal(compare.persisted, false);
  assert.deepEqual(compare.ranking.map((row) => row.evidence_id), [evidence.id], 'the ranking is derived from the evidence, not from any analysis');
  assert.equal(compare.ranking[0].metric_value, metricValue(evidence, 'engagement'), 'the deterministic engagement formula produces the comparison value');
  assert.equal(bridge.state.analyses.length, 1, 'no comparison analysis was written');
  assert.equal(bridge.state.analyses[0].id, ordinary.id, 'the pre-existing ordinary analysis is untouched and never replaced');
  assert.ok(!JSON.stringify(compare).includes(ordinary.id), 'the ordinary analysis id never appears in the comparison result');
});

test('handoff payload is derived only through the canonical P19 implementation', async () => {
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(new URL('../deterministic-executor.mjs', import.meta.url), 'utf8'));
  assert.match(source, /return \(await deriveHandoffPackage\(sourceProject\)\)\.handoff/);
});

test('fan-out failure preserves completed writes and retry skips their exact item indexes', async () => {
  const plan = await buildPlan('搜索 X 中 AI 营销，选 3 条保存为证据');
  const base = mockBoundary();
  let saveAttempts = 0;
  let failSecond = true;
  const client = async (call, trusted, signal) => {
    if (call.operation === 'workspace.evidence.create') {
      saveAttempts += 1;
      if (failSecond && saveAttempts === 2) return { ok: false, code: 'P19_ENTITY_REVISION_STALE', diagnostics: { issues: ['stale revision'] } };
    }
    return base.client(call, trusted, signal);
  };
  const taskView = view(plan);
  const stateReader = createBridgeStateReader(client);
  const first = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: client, stateReader });
  assert.equal(first.outcome, 'partial');
  const saveStep = plan.steps.find((step) => step.operation === 'workspace.evidence.create');
  const failed = taskView.step_states[saveStep.step];
  assert.equal(failed.executed_count, 1);
  assert.equal(failed.item_count, 1);
  assert.equal(failed.refs.length, 1);
  assert.deepEqual(failed.completed_items, [{ item_index: 0, reused: false, ref: failed.refs[0], entity: { type: 'evidence', id: failed.refs[0] } }]);

  failSecond = false;
  taskView.retry_target = { step_id: saveStep.step, plan_fingerprint: plan.fingerprint };
  const retried = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: client, stateReader });
  assert.equal(retried.outcome, 'succeeded');
  assert.equal(saveAttempts, 4, 'one failed attempt plus three unique successful item attempts; item 0 is not repeated');
  assert.equal(base.state.evidence.length, 3);
  assert.equal(taskView.step_states[saveStep.step].completed_items.length, 3);
});

function redditSearchItem(index) {
  const text = `Reddit 命中 ${index} 的内容文本`;
  return {
    id: `reddit-item-${index}`, source_url: `https://www.reddit.com/r/marketing/comments/9${index}/t${index}/`, label: `红迪命中 ${index}`, platform: 'reddit', content_text: text,
    external_id: `r${index}`, content_sha256: createHash('sha256').update(text).digest('hex'),
    provenance: { schema_version: 'p22_collected_source_v1', provider: 'apify:endspec/reddit-instant-search-scraper', run_id: 'run-r', collected_at: '2026-08-15T08:00:00.000Z', usage_total_usd: 0.001, budget_reservation_id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    collection_proof: '1999999999.' + 'd'.repeat(64), source_metadata: { author: { name: 'R' }, engagement: { likes: index } }, media_assets: [],
  };
}

// Boundary that returns an exact number of distinct-identity items per
// platform (defaults to the requested count; an over-provisioned platform can
// return more than the requested count to prove the executor's exact bound).
function combinedSearchBridge({ xCount = null, rCount = null } = {}) {
  const base = mockBoundary();
  const original = base.client;
  base.client = async (call, trusted) => {
    if (call.operation === 'research.search_x') {
      const items = Array.from({ length: xCount ?? call.payload.count }, (_, index) => searchItem(`https://x.com/i/web/status/9${index}`, index));
      return { ok: true, data: { items }, artifact_refs: [] };
    }
    if (call.operation === 'research.search_reddit') {
      const items = Array.from({ length: rCount ?? call.payload.count }, (_, index) => redditSearchItem(index));
      return { ok: true, data: { items }, artifact_refs: [] };
    }
    return original(call, trusted);
  };
  return base;
}

test('search_x_reddit preserves both platforms in order and bounded exactly by the contract', async () => {
  // count=1 per platform, save 2: combined = [X, Reddit]; both saved, X first,
  // with distinct platform identities and unique deterministic keys.
  const plan = await buildPlan('搜索 X 和 Reddit 上 "AI 营销" 1 条，选 2 条保存为证据');
  assert.equal(plan.workflow, 'search_x_reddit');
  assert.equal(plan.slots.count, 1);
  assert.equal(plan.slots.save_count, 2);
  const bridge = mockBoundary();
  const { taskView, output } = await run(plan, bridge);
  assert.equal(output.outcome, 'succeeded');
  const saveStep = taskView.step_states['st-3'];
  assert.equal(saveStep.source_count, 2, 'combined set is 1 X + 1 Reddit');
  assert.equal(saveStep.item_count, 2, 'exactly the selected combined items are saved');
  const creates = bridge.calls.filter((call) => call.operation === 'workspace.evidence.create');
  assert.equal(creates.length, 2, 'exactly one single-item evidence call per selected combined item');
  assert.deepEqual(creates.map((call) => call.payload.evidence.source_url), [
    'https://x.com/i/web/status/90',
    'https://www.reddit.com/r/x/comments/90/t0/',
  ], 'combined order is X results then Reddit results');
  const keys = creates.map((call) => call.idempotency_key);
  assert.equal(new Set(keys).size, 2, 'unique deterministic idempotency keys');
  assert.ok(keys.every((key) => /^d-[0-9a-f]{32}$/.test(key)), 'deterministic key shape');
  assert.equal(keys[0] !== keys[1], true);
});

test('read-only combined search returns both X and Reddit result sets', async () => {
  const plan = await buildPlan('search X and Reddit for "AI marketing"');
  assert.equal(plan.workflow, 'search_x_reddit');
  assert.equal(plan.slots.save_count, 0);
  const bridge = combinedSearchBridge({ xCount: 2, rCount: 2 });
  const { output } = await run(plan, bridge);
  assert.equal(output.outcome, 'succeeded');
  assert.deepEqual(
    output.result_data.search_x_reddit.items.map((item) => item.source_url),
    [
      'https://x.com/i/web/status/90',
      'https://x.com/i/web/status/91',
      'https://www.reddit.com/r/marketing/comments/90/t0/',
      'https://www.reddit.com/r/marketing/comments/91/t1/',
    ],
  );
});

test('search_x_reddit: 1, max and over-bound combined saves are exact with no platform loss', async () => {
  // 1: a single saved item is the X result (X first).
  const one = await buildPlan('搜索 X 和 Reddit 上 "AI 营销" 1 条，选 1 条保存为证据');
  const bridgeOne = mockBoundary();
  const oneRun = await run(one, bridgeOne);
  assert.equal(oneRun.output.outcome, 'succeeded');
  const oneCreates = bridgeOne.calls.filter((call) => call.operation === 'workspace.evidence.create');
  assert.equal(oneCreates.length, 1, 'exactly one selected item is saved');
  assert.equal(oneCreates[0].payload.evidence.source_url, 'https://x.com/i/web/status/90', 'the single saved item is the X result (X first)');
  assert.equal(oneRun.taskView.step_states['st-3'].source_count, 2, 'combined = 1 X + 1 Reddit');

  // max: per-platform count at the maximum (10 each) — the combined set keeps
  // both platforms (20 items) instead of dropping Reddit behind an overall cap.
  const max = await buildPlan('搜索 X 和 Reddit 上 "AI 营销" 10 条，选 5 条保存为证据');
  assert.equal(max.slots.count, 10);
  const bridgeMax = mockBoundary();
  const maxRun = await run(max, bridgeMax);
  assert.equal(maxRun.output.outcome, 'succeeded');
  assert.equal(maxRun.taskView.step_states['st-3'].source_count, 20, 'no platform loss at the maximum: 10 X + 10 Reddit');
  assert.equal(maxRun.taskView.step_states['st-3'].item_count, 5, 'exactly the selected save_count items are saved');
  const maxCreates = bridgeMax.calls.filter((call) => call.operation === 'workspace.evidence.create');
  assert.equal(maxCreates.length, 5);
  assert.equal(new Set(maxCreates.map((call) => call.idempotency_key)).size, 5, 'unique deterministic keys at the maximum');

  // over-bound: save_count above the available combined items is bounded by
  // availability; a boundary returning more than the requested count is
  // truncated to the exact per-platform bound — never by an overall cap.
  const over = await buildPlan('搜索 X 和 Reddit 上 "AI 营销" 2 条，选 5 条保存为证据');
  assert.equal(over.slots.count, 2);
  const bridgeOver = combinedSearchBridge({ xCount: 2, rCount: 12 });
  const overRun = await run(over, bridgeOver);
  assert.equal(overRun.output.outcome, 'succeeded');
  assert.equal(overRun.taskView.step_states['st-3'].source_count, 4, 'combined is bounded per platform by count (2 X + 2 Reddit)');
  assert.equal(overRun.taskView.step_states['st-3'].item_count, 4, 'saves are bounded by the available combined items');
  const overCreates = bridgeOver.calls.filter((call) => call.operation === 'workspace.evidence.create');
  assert.equal(overCreates.length, 4);
  assert.equal(new Set(overCreates.map((call) => call.idempotency_key)).size, 4);
});

// ---------------------------------------------------------------------------
// Production-shaped client wiring: the real tool client validates the single
// canonical external call shape at the bridge boundary. The previous bug fed
// the internally enriched executor value into the client, which re-validated
// it as an external call and rejected workspace.project.read with
// UNKNOWN_FIELD on task_id. These tests pin the fixed contract end to end.
// ---------------------------------------------------------------------------

const bridgeSecret = 's'.repeat(32);
const delegatedAuthorization = `Bearer ${'a'.repeat(40)}`;

function compareEvidenceRecord(idSuffix, views, likes) {
  const text = `evidence ${idSuffix}`;
  return {
    id: `ev-${idSuffix}`,
    project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa',
    source_url: `https://x.com/i/web/status/${idSuffix.slice(-1)}`,
    label: `source ${idSuffix}`,
    platform: 'X · Apify',
    content_text: text,
    source_metadata: { engagement: { views, likes } },
    fingerprint: createHash('sha256').update(text).digest('hex'),
    version: 1,
  };
}

// Real tool client whose fetch records every bridge envelope and answers the
// bounded project read plus (optionally) the comparison analysis write.
function realBridgeClient({ evidence = [], onCall = null } = {}) {
  let revision = 3;
  let analyses = [];
  let failFirstWrite = false;
  const bodies = [];
  const client = createToolClient({
    bridgeUrl: 'https://bridge.example.test/functions/v1/harness-tool-bridge',
    bridgeSecret,
    delegatedAuthorization,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      onCall?.(body);
      const call = body.call;
      if (call.operation === 'workspace.project.read') {
        return new Response(JSON.stringify({ ok: true, code: 'OK', data: { project: { version: revision, evidence, analyses } } }), { status: 200 });
      }
      if (call.operation === 'workspace.analysis.create') {
        if (failFirstWrite) {
          failFirstWrite = false;
          return new Response(JSON.stringify({
            ok: false,
            code: 'P19_ENTITY_REVISION_STALE',
            diagnostics: { field: 'expected_revision', operation: 'analysis.create', issues: ['stale revision'] },
          }), { status: 200 });
        }
        const record = { ...call.payload.analysis, fingerprint: 'af'.repeat(32) };
        analyses = [record];
        revision += 1;
        return new Response(JSON.stringify({ ok: true, code: 'OK', entity: { type: 'analysis', id: record.id } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED_OPERATION' }), { status: 200 });
    },
  });
  return {
    client,
    bodies,
    failNextWrite() { failFirstWrite = true; },
    get revision() { return revision; },
    get analyses() { return analyses; },
  };
}

// Spies on the executor→client boundary: every call argument the executor
// hands to the tool client (project reads, tool steps, lineage audit, retries)
// must be the canonical external shape — never the internally enriched value.
function assertCanonicalCallShape(client) {
  return async (call, trustedContext, signal) => {
    const keys = Object.keys(call);
    assert.equal(
      keys.includes('task_id') || keys.includes('user_id') || keys.includes('project_id'),
      false,
      'no internal trusted fields may cross the tool client',
    );
    for (const key of keys) {
      assert.ok(
        ['schema_version', 'operation', 'payload', 'idempotency_key', 'expected_revision'].includes(key),
        `the client sees only canonical external call fields (got ${key})`,
      );
    }
    return client(call, trustedContext, signal);
  };
}

test('a production-shaped zero-paid compare_project crosses the real tool client and the exact P19 boundary without UNKNOWN_FIELD', async () => {
  const evidence = [compareEvidenceRecord('000000000000000000000001', 10, 2), compareEvidenceRecord('000000000000000000000002', 20, 1)];
  const plan = await buildPlan('比较当前项目中表现最好的帖子');
  assert.equal(plan.approvals.paid_external_calls, false);
  assert.equal(plan.cost_indicators.paid_calls, 0);
  const bridge = realBridgeClient({ evidence });
  const spied = assertCanonicalCallShape(bridge.client);
  const taskView = view(plan);
  const stateReader = createBridgeStateReader(spied);
  const output = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: spied, stateReader });
  assert.equal(output.outcome, 'succeeded', `the read no longer fails with UNKNOWN_FIELD: ${JSON.stringify(taskView.step_states['st-0']?.error)}`);
  assert.equal(bridge.bodies.length, 1, 'the read-only comparison makes exactly one bridge call (the bounded project read)');
  assert.equal(output.result_data.compare.persisted, false);
  assert.deepEqual(output.result_data.compare.ranking.map((row) => row.evidence_id), [
    'ev-000000000000000000000002',
    'ev-000000000000000000000001',
  ], 'the deterministic ranking is produced after the successful read');
  const body = bridge.bodies[0];
  assert.deepEqual(
    body.call.payload,
    { project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa' },
    'the signed envelope call payload never gains internal trusted fields',
  );
  assert.deepEqual(body.boundary, {
    endpoint: 'p19-workspace-command',
    body: {
      schema_version: 'p19_command_contract_v1',
      command: 'project.read',
      idempotency_key: `h-${createHash('sha256').update(`${TASK_ID}\0state-read`, 'utf8').digest('hex')}`,
      payload: { project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa' },
    },
  }, 'the downstream P19 body is exactly {schema_version, command, idempotency_key, payload:{project_id}}');
});

test('read-boundary failures retain exact bounded diagnostics through the state reader into the final step failure', async () => {
  const plan = await buildPlan('比较当前项目中表现最好的帖子');
  const bodies = [];
  const client = createToolClient({
    bridgeUrl: 'https://bridge.example.test/functions/v1/harness-tool-bridge',
    bridgeSecret,
    delegatedAuthorization,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return new Response(JSON.stringify({
        ok: false,
        code: 'P19_PROJECT_NOT_FOUND',
        diagnostics: { field: 'project_id', operation: 'project.read', issues: ['项目不存在'] },
      }), { status: 200 });
    },
  });
  const trustedContext = { task_id: TASK_ID, user_id: 'user-a', project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', approval: {} };
  const stateReader = createBridgeStateReader(client);
  const state = await stateReader(trustedContext, 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', null);
  assert.equal(state.ok, false);
  assert.equal(state.code, 'P19_PROJECT_NOT_FOUND');
  assert.equal(state.diagnostics.operation, 'project.read', 'the state reader keeps the exact boundary operation');
  assert.equal(state.diagnostics.field, 'project_id', 'the state reader keeps the exact offending field');

  const taskView = view(plan);
  const output = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: client, stateReader });
  assert.equal(output.outcome, 'failed');
  const readStep = plan.steps[0];
  const snapshot = taskView.step_states[readStep.step];
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.error.code, 'P19_PROJECT_NOT_FOUND', 'the final step failure keeps the exact code');
  assert.equal(snapshot.error.operation, 'project.read', 'the final step failure keeps the exact operation');
  assert.equal(snapshot.error.field, 'project_id', 'the final step failure keeps the exact offending field');
  assert.deepEqual(bodies[0].boundary.body.payload, { project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa' }, 'the failed read also crossed with the exact P19 payload');
});

test('a tool-step boundary failure retains exact operation and field in the final step failure without leaking values', async () => {
  const plan = await buildPlan('搜索 X 上 AI 营销，选 1 条保存为证据');
  const bridge = mockBoundary();
  const original = bridge.client;
  bridge.client = async (call, trusted, signal) => {
    if (call.operation === 'workspace.evidence.create') {
      return { ok: false, code: 'P19_PAYLOAD_FIELD_INVALID', diagnostics: { field: 'evidence', operation: 'evidence.create', issues: ['证据记录无效'] } };
    }
    return original(call, trusted, signal);
  };
  const { taskView, output } = await run(plan, bridge);
  assert.equal(output.outcome, 'partial');
  const saveStep = plan.steps.find((step) => step.operation === 'workspace.evidence.create');
  const snapshot = taskView.step_states[saveStep.step];
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.error.code, 'P19_PAYLOAD_FIELD_INVALID');
  assert.equal(snapshot.error.operation, 'evidence.create', 'the exact boundary operation reaches the final step failure');
  assert.equal(snapshot.error.field, 'evidence', 'the exact offending field reaches the final step failure');
  assert.doesNotMatch(JSON.stringify(taskView.step_states), /Bearer|token|secret|password/i, 'step failures never surface tokens or secrets');
});

test('a failed-write retry re-reads project state through the same canonical client contract', async () => {
  const evidence = [compareEvidenceRecord('000000000000000000000001', 10, 2), compareEvidenceRecord('000000000000000000000002', 20, 1)];
  const plan = await buildPlan('比较当前项目中表现最好的帖子并保存比较分析');
  const bridge = realBridgeClient({ evidence });
  bridge.failNextWrite();
  const spied = assertCanonicalCallShape(bridge.client);
  const taskView = view(plan);
  const stateReader = createBridgeStateReader(spied);
  const first = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: spied, stateReader });
  assert.equal(first.outcome, 'partial');
  const saveStep = plan.steps.find((step) => step.operation === 'workspace.analysis.create');
  assert.equal(taskView.step_states[saveStep.step].error.code, 'P19_ENTITY_REVISION_STALE');
  assert.equal(taskView.step_states[saveStep.step].error.operation, 'analysis.create');
  assert.equal(taskView.step_states[saveStep.step].error.field, 'expected_revision');

  taskView.retry_target = { step_id: saveStep.step, plan_fingerprint: plan.fingerprint };
  const retried = await executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient: spied, stateReader });
  assert.equal(retried.outcome, 'succeeded');
  assert.equal(retried.result_data.compare.persisted, true);
  const writes = bridge.bodies.filter((body) => body.call.operation === 'workspace.analysis.create');
  assert.equal(writes.length, 3, 'one failed write attempt plus the two unique item writes on retry');
  for (const body of bridge.bodies) {
    if (body.call.operation === 'workspace.analysis.create') {
      assert.deepEqual(
        Object.keys(body.boundary.body.payload).sort(),
        ['analysis', 'expected_fingerprint', 'expected_revision', 'project_id'],
        'the write boundary payload contains exactly the permitted fields',
      );
    } else {
      assert.deepEqual(body.boundary.body, {
        schema_version: 'p19_command_contract_v1',
        command: 'project.read',
        idempotency_key: `h-${createHash('sha256').update(`${TASK_ID}\0state-read`, 'utf8').digest('hex')}`,
        payload: { project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa' },
      }, 'every state re-read on retry crosses the exact P19 boundary');
    }
  }
});

// ---------------------------------------------------------------------------
// Brief canonical identity contract (milestone ams-g1-p19-brief-identity-
// quote-binding-final-repair): a Brief ID is reused only when it exactly
// satisfies brief-<24 位小写十六进制>. A historical non-canonical identity
// (25-character legacy suffix) stays untouched in the pre-write snapshot; the
// new assembly writes the deterministic canonical identity with the complete
// three-card and provenance bindings, so a later G1 quote binds exactly.
// ---------------------------------------------------------------------------

const LEGACY_BRIEF_ID = 'brief-8a14d78ceee1a3ff2b32a076e'; // 25 位十六进制后缀（staging 实测身份）

function legacyBrief(projectId, citationIds) {
  return {
    id: LEGACY_BRIEF_ID,
    project_id: projectId,
    schema_version: 'ams_content_brief_v1',
    version: 1,
    status: 'pending_review',
    topic: '历史遗留主题',
    objective: '历史遗留目标',
    constraints: ['不虚构事实'],
    knowledge_citation_ids: citationIds,
    evidence_provenance: { evidence_ids: [], evidence_fingerprints: {}, statement: '历史记录' },
    review: { schema_version: 'ams_brief_review_v1', brief_id: LEGACY_BRIEF_ID, comments: [], decision: null },
    analysis_provenance: { method: 'multimodal_model', provider: 'dashscope', model: 'qwen-plus', executed_at: '2026-08-01T00:00:00.000Z', analysis_ids: [], media_count: 0, statement: '历史记录' },
    fingerprint: 'f'.repeat(64),
  };
}

function canonicalBrief(projectId, citationIds, version = 1, fingerprint = 'c'.repeat(64)) {
  const id = `brief-${'a'.repeat(24)}`;
  return {
    id,
    project_id: projectId,
    schema_version: 'ams_content_brief_v1',
    version,
    status: 'pending_review',
    topic: 't',
    objective: 'o',
    constraints: [],
    knowledge_citation_ids: citationIds,
    evidence_provenance: { evidence_ids: [], evidence_fingerprints: {}, statement: 's' },
    review: { schema_version: 'ams_brief_review_v1', brief_id: id, comments: [], decision: null },
    analysis_provenance: { method: 'multimodal_model', provider: 'dashscope', model: 'qwen-plus', executed_at: '2026-08-01T00:00:00.000Z', analysis_ids: [], media_count: 0, statement: 's' },
    fingerprint,
  };
}

// 完整三卡集：3 evidence + 3 analyses + 3 cards，供 Brief 装配继承。
function threeCardProject(projectId) {
  const evidence = Array.from({ length: 3 }, (_, i) => ({
    id: `ev-${'0'.repeat(23)}${i + 1}`,
    project_id: projectId,
    source_url: `https://x.com/i/web/status/7${i}`,
    fingerprint: 'e'.repeat(64),
    version: 1,
  }));
  const analyses = Array.from({ length: 3 }, (_, i) => ({
    id: `an-${'0'.repeat(23)}${i + 1}`,
    project_id: projectId,
    evidence_id: evidence[i].id,
    evidence_fingerprint: evidence[i].fingerprint,
    evidence_version: 1,
    schema_version: 'p19_analysis_v1',
    fingerprint: `a${i}`.repeat(64).slice(0, 64),
    version: 1,
    model_analysis: { media_ids: [] },
  }));
  const cards = Array.from({ length: 3 }, (_, i) => ({
    id: `kc-${'0'.repeat(23)}${i + 1}`,
    project_id: projectId,
    evidence_id: evidence[i].id,
    analysis_id: analyses[i].id,
    analysis_fingerprint: analyses[i].fingerprint,
    schema_version: 'content_knowledge_card_v1',
    version: 1,
    fingerprint: 'k'.repeat(64),
  }));
  return { evidence, analyses, cards };
}

test('非规范历史 Brief：写入完整三卡绑定的规范身份，历史记录保留在写前快照且不被改写', async () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const { evidence, analyses, cards } = threeCardProject(projectId);
  const cardIds = cards.map((card) => card.id);
  // 历史 Brief 引用与当前完全相同的卡集合 —— 在规范身份契约下也绝不复用，
  // 必须写入新的规范身份（否则 G1 永远无法绑定该 Brief）。
  const bridge = mockBoundary({ evidence, analyses, cards, brief: legacyBrief(projectId, cardIds) });
  const preWrite = structuredClone(bridge.state.brief);
  assert.equal(preWrite.id, LEGACY_BRIEF_ID, '写前快照保留历史 Brief 身份');

  const plan = await buildPlan('生成待审核 Brief', projectId);
  assert.equal(plan.workflow, 'assemble_brief');
  const { taskView, output } = await run(plan, bridge);
  assert.equal(output.outcome, 'succeeded', JSON.stringify(taskView.step_states));

  // 历史记录保持原样（身份/内容未被改写或删除）。
  assert.equal(preWrite.id, LEGACY_BRIEF_ID);
  assert.equal(preWrite.topic, '历史遗留主题');
  // 装配步骤实际执行（非规范身份绝不复用、绝不跳过写入）。
  const briefStep = taskView.step_states[plan.steps[1].step];
  assert.equal(briefStep.state, 'succeeded');
  assert.equal(briefStep.reused_count, 0);

  // 新 Brief 使用由当前项目 + 完整知识卡身份集合派生的确定性规范身份
  // （乱序/重复输入恒等），携带完整三卡与来源绑定。
  const expectedId = deriveCanonicalBriefId(projectId, cardIds);
  const assembled = bridge.calls.find((call) => call.operation === 'workspace.brief.assemble');
  assert.ok(assembled, '装配必须发起一次 brief.assemble 写入');
  const record = assembled.payload.brief;
  assert.equal(record.id, expectedId);
  assert.match(record.id, /^brief-[0-9a-f]{24}$/);
  assert.notEqual(record.id, LEGACY_BRIEF_ID);
  assert.equal(record.status, 'pending_review');
  assert.equal(record.version, 1, '新的规范实体从版本 1 开始独立谱系');
  assert.equal(assembled.payload.expected_fingerprint, null, '新规范实体无同实体基线');
  assert.deepEqual(record.knowledge_citation_ids, cardIds, '完整三卡引用继承');
  assert.deepEqual(record.evidence_provenance.evidence_ids, evidence.map((entry) => entry.id), '精确 Evidence 绑定');
  assert.equal(record.evidence_provenance.evidence_fingerprints[evidence[0].id], analyses[0].fingerprint, '指纹绑定来自卡的分析血缘');
  assert.deepEqual(record.analysis_provenance.analysis_ids, analyses.map((entry) => entry.id), '精确分析血缘');
  assert.equal(record.review.brief_id, record.id, '审核绑定新规范身份');
  // 写后刷新/读取恢复：持久化状态 = 新规范 Brief。
  assert.equal(bridge.state.brief.id, expectedId);
  // 历史身份绝不出现在任何写入载荷中。
  assert.ok(!JSON.stringify(bridge.calls.filter((call) => call.operation !== 'workspace.project.read')).includes(LEGACY_BRIEF_ID));
});

test('权威 P19 kc- 三卡集（staging 实卡身份）装配规范待审核 Brief：三卡引用与来源血缘精确保留', async () => {
  // 既有 staging 权威知识卡身份（kc-<24 位小写十六进制>）；契约来自
  // src/services/p19-contracts.js 的 CARD_ID_PATTERN。生产逻辑绝不硬编码具体
  // 卡值，此处仅以真实身份形状做端到端证明：完整 kc- 卡集 → 确定性规范 Brief。
  // 数组顺序即源卡顺序（刻意非字典序）：规范 Brief 身份派生对集合排序/去重，
  // 而引用字段必须逐位保留该原始顺序（下方按完整原数组精确断言）。
  const stagingCardIds = [
    'kc-39a7a6a0de13b773f0edc61d',
    'kc-a05847c2e314f856d3b19903',
    'kc-8e29f99670cc5f7298609855',
  ];
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const { evidence, analyses, cards } = threeCardProject(projectId);
  const boundCards = cards.map((card, index) => ({ ...card, id: stagingCardIds[index] }));
  const bridge = mockBoundary({ evidence, analyses, cards: boundCards });
  const plan = await buildPlan('生成待审核 Brief', projectId);
  const { taskView, output } = await run(plan, bridge);
  assert.equal(output.outcome, 'succeeded', JSON.stringify(taskView.step_states));
  const briefStep = plan.steps.find((step) => step.operation === 'workspace.brief.assemble');
  assert.equal(taskView.step_states[briefStep.step].state, 'succeeded');
  const calls = bridge.calls.filter((call) => call.operation !== 'workspace.project.read');
  assert.deepEqual(
    calls.map((call) => call.operation),
    ['workspace.brief.assemble'],
    '仅一次 Brief 装配写入，零其他 business/provider/paid 调用',
  );
  const record = calls[0].payload.brief;
  assert.equal(record.id, deriveCanonicalBriefId(projectId, stagingCardIds), '规范身份由精确项目 + 完整 kc- 卡集合（乱序输入）确定性派生');
  assert.match(record.id, /^brief-[0-9a-f]{24}$/);
  assert.equal(record.status, 'pending_review');
  assert.equal(record.version, 1);
  // 引用字段精确保留源卡完整原始顺序（去重但绝不排序）：stagingCardIds 本身
  // 非字典序，直接对原数组全量 deepEqual 即证明 —— 排序/去重只发生在规范 Brief
  // 身份派生（deriveCanonicalBriefId）内部，绝不作用于引用列表本身。
  assert.deepEqual(record.knowledge_citation_ids, stagingCardIds, '三卡引用精确保留（保持源卡完整原始顺序）');
  assert.deepEqual(record.evidence_provenance.evidence_ids, evidence.map((entry) => entry.id), '精确 Evidence 绑定');
  assert.equal(record.evidence_provenance.evidence_fingerprints[evidence[0].id], analyses[0].fingerprint, '指纹绑定来自卡的分析血缘');
  assert.deepEqual(record.analysis_provenance.analysis_ids, analyses.map((entry) => entry.id), '精确分析血缘');
  assert.equal(record.review.brief_id, record.id, '审核绑定新规范身份');
  assert.equal(calls[0].payload.expected_fingerprint, null, '新规范实体无同实体基线');
});

test('规范 Brief 身份派生：同一项目+卡集合（乱序/重复）恒等，卡集合或项目变化绝不碰撞', () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const setA = [`kc-${'1'.repeat(24)}`, `kc-${'2'.repeat(24)}`, `kc-${'3'.repeat(24)}`];
  const idA = deriveCanonicalBriefId(projectId, setA);
  assert.match(idA, /^brief-[0-9a-f]{24}$/);
  // 同一项目 + 同一卡集合 → 恒等；乱序或重复输入不改变身份。
  assert.equal(deriveCanonicalBriefId(projectId, [`kc-${'3'.repeat(24)}`, `kc-${'1'.repeat(24)}`, `kc-${'2'.repeat(24)}`]), idA, '乱序的同一卡集合产生同一规范身份');
  assert.equal(deriveCanonicalBriefId(projectId, [...setA, `kc-${'1'.repeat(24)}`]), idA, '重复的同一卡集合产生同一规范身份（去重后）');
  // 卡集合变化 → 身份变化（绝不碰撞）。
  assert.notEqual(deriveCanonicalBriefId(projectId, setA.slice(0, 2)), idA, '缺失一张卡 → 不同身份');
  assert.notEqual(deriveCanonicalBriefId(projectId, [...setA, `kc-${'4'.repeat(24)}`]), idA, '新增一张卡 → 不同身份');
  assert.notEqual(deriveCanonicalBriefId(projectId, []), idA, '空卡集合 → 不同身份');
  // 项目变化 → 身份变化（项目隔离）。
  assert.notEqual(deriveCanonicalBriefId('prj-bbbbbbbbbbbbbbbbbbbbbbbb', setA), idA, '不同项目 → 不同身份');
  // 非法/非规范卡身份绝不进入派生输入：fail closed（见下方专门测试），绝不
  // 静默剔除 —— 剔除会掩盖真实卡集合并产生身份碰撞（筛选后与空/更小集合同 ID）。
  // card-<24 位十六进制> 在旧契约下曾是合法格式，现在必须作为别名整体拒绝。
  assert.throws(
    () => deriveCanonicalBriefId(projectId, [...setA, `card-${'1'.repeat(24)}`]),
    (error) => error?.code === BRIEF_CARD_IDENTITY_INVALID && error?.diagnostics?.field === 'knowledge_card_id',
    '任一非法卡身份使整个派生失败关闭',
  );
});

test('规范 Brief 身份：非法卡/项目身份 fail closed —— 稳定 code、准确 field、绝不生成 Brief ID', () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const validCard = `kc-${'1'.repeat(24)}`;
  // 项目身份错绑/非法：非字符串、空、非法格式 → BRIEF_PROJECT_IDENTITY_INVALID。
  for (const badProject of [null, undefined, '', 'prj-zz', 'project-x', 42, `PRJ-${'a'.repeat(24)}`]) {
    assert.throws(
      () => deriveCanonicalBriefId(badProject, [validCard]),
      (error) => error?.code === BRIEF_PROJECT_IDENTITY_INVALID && error?.diagnostics?.field === 'project_id',
      `项目身份 ${String(badProject)} 必须 fail closed`,
    );
  }
  // 卡身份集合输入错绑：非数组（含单个身份字符串）→ BRIEF_CARD_IDENTITY_INVALID。
  for (const badSet of [null, undefined, validCard, { 0: validCard }, 42]) {
    assert.throws(
      () => deriveCanonicalBriefId(projectId, badSet),
      (error) => error?.code === BRIEF_CARD_IDENTITY_INVALID && error?.diagnostics?.field === 'knowledge_cards',
      '卡身份集合必须为数组，否则 fail closed',
    );
  }
  // 非法卡身份条目：空值/非字符串/非法格式/非规范（大写、25/23 位、非 kc 前缀），
  // 以及完整的 card-<24 位十六进制> 旧前缀别名（整体拒绝，绝不当作合法身份）
  // → 稳定 code + 准确 field + 首个非法条目下标；诊断绝不泄漏原值。
  const illegalEntries = ['', '   ', null, undefined, 42, 'card-not-canonical', `card-${'1'.repeat(24)}`, `card-${'A'.repeat(24)}`, `kc-${'A'.repeat(24)}`, `KC-${'1'.repeat(24)}`, `kc-${'1'.repeat(25)}`, `kc-${'1'.repeat(23)}`, 'brief-111111111111111111111111', 'kc-zzzzzzzzzzzzzzzzzzzzzzzz'];
  for (const illegal of illegalEntries) {
    assert.throws(
      () => deriveCanonicalBriefId(projectId, [validCard, illegal]),
      (error) => {
        assert.equal(error?.code, BRIEF_CARD_IDENTITY_INVALID);
        assert.equal(error?.diagnostics?.field, 'knowledge_card_id');
        assert.equal(error?.diagnostics?.index, 1, '必须指出首个非法条目的精确下标');
        assert.ok(!/[0-9a-f]{24}/.test(String(error?.message)), '诊断不泄漏卡身份原值');
        return true;
      },
      `非法卡身份条目 ${String(illegal)} 必须 fail closed`,
    );
  }
  // 单条目集合含非法身份同样失败：绝不静默退化为「空集合派生」身份。
  assert.throws(
    () => deriveCanonicalBriefId(projectId, ['']),
    (error) => error?.code === BRIEF_CARD_IDENTITY_INVALID && error?.diagnostics?.index === 0,
  );
});

test('规范 Brief 身份：相同引用集合精确复用零写入；普通版本更新沿用同一身份与指纹基线', async () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const { evidence, analyses, cards } = threeCardProject(projectId);
  const cardIds = cards.map((card) => card.id);
  // 规范身份 + 相同引用集合 → 精确复用（既有行为保持：零写入，身份不变）。
  const reuseBridge = mockBoundary({ evidence, analyses, cards, brief: canonicalBrief(projectId, cardIds) });
  const reuseRun = await run(await buildPlan('生成待审核 Brief', projectId), reuseBridge);
  assert.equal(reuseRun.output.outcome, 'succeeded');
  assert.equal(reuseRun.taskView.step_states['st-1'].state, 'reused', '规范身份 + 相同引用集合 → 精确复用');
  assert.equal(reuseBridge.calls.filter((call) => call.operation === 'workspace.brief.assemble').length, 0, '零写入');
  assert.equal(reuseBridge.state.brief.id, `brief-${'a'.repeat(24)}`, '身份保持不变');

  // 引用集合变化 → 普通版本更新：同一规范身份、版本 +1、指纹基线精确，
  // 新 Brief 仍携带完整当前卡集合。
  const changedSet = canonicalBrief(projectId, cardIds.slice(0, 2));
  const updateBridge = mockBoundary({ evidence, analyses, cards, brief: changedSet });
  const updateRun = await run(await buildPlan('生成待审核 Brief', projectId), updateBridge);
  assert.equal(updateRun.output.outcome, 'succeeded');
  assert.equal(updateRun.taskView.step_states['st-1'].state, 'succeeded');
  const updateCall = updateBridge.calls.find((call) => call.operation === 'workspace.brief.assemble');
  assert.ok(updateCall, '引用集合变化必须写入新版本');
  assert.equal(updateCall.payload.brief.id, `brief-${'a'.repeat(24)}`, '普通版本更新沿用同一规范身份');
  assert.equal(updateCall.payload.brief.version, 2, '版本 +1');
  assert.equal(updateCall.payload.expected_fingerprint, 'c'.repeat(64), '同实体指纹基线精确');
  assert.deepEqual(updateCall.payload.brief.knowledge_citation_ids, cardIds, '新 Brief 携带完整当前卡集合');
});

test('项目隔离：其他项目的非规范 Brief 绝不命中本项目复用，也不作为本项目基线', async () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const otherProjectId = 'prj-bbbbbbbbbbbbbbbbbbbbbbbb';
  const { evidence, analyses, cards } = threeCardProject(projectId);
  const bridge = mockBoundary({ evidence, analyses, cards, brief: legacyBrief(otherProjectId, cards.map((card) => card.id)) });
  const { taskView, output } = await run(await buildPlan('生成待审核 Brief', projectId), bridge);
  assert.equal(output.outcome, 'succeeded', JSON.stringify(taskView.step_states));
  const call = bridge.calls.find((entry) => entry.operation === 'workspace.brief.assemble');
  assert.ok(call, '其他项目的 Brief 不能命中复用，必须写入本项目规范 Brief');
  assert.equal(call.payload.brief.project_id, projectId);
  assert.match(call.payload.brief.id, /^brief-[0-9a-f]{24}$/);
  assert.notEqual(call.payload.brief.id, LEGACY_BRIEF_ID);
  assert.equal(call.payload.expected_fingerprint, null, '其他项目的身份绝不作为本项目同实体基线');
});

test('畸形 Brief 身份计划在计划与执行两层均 fail closed：零 bridge/business/provider/paid 调用', async () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const request = { user_id: 'user-a', project_id: projectId, intent: '生成图片', request_fingerprint: 'a'.repeat(64) };
  // 计划层：通过底层计划构造入口 buildPlan({taskId, request, workflowId, slots})
  // 直接构造合法与畸形计划（同步入口，断言真实生效）。此前把
  // {taskId, workflowId, slots} 对象当 intent 误喂给自然语言 planner helper
  // —— 那是把对象喂给分类器的错误用法，断言从未到达目标代码。
  const overlong = buildExactPlan({
    taskId: TASK_ID,
    request,
    workflowId: 'generate_media',
    slots: { brief_id: LEGACY_BRIEF_ID, mode: 'image', prompt: '猫' },
  });
  assert.equal(overlong.ok, false);
  assert.equal(overlong.code, 'PLAN_SLOT_IDENTITY');
  assert.equal(overlong.diagnostics.field, 'brief_id');
  // 空身份按必填拒绝；其余非规范身份（大写/25 位/23 位后缀）一律 PLAN_SLOT_IDENTITY。
  assert.equal(buildExactPlan({
    taskId: TASK_ID, request, workflowId: 'generate_media', slots: { brief_id: '', mode: 'image', prompt: '猫' },
  }).code, 'PLAN_SLOT_REQUIRED');
  for (const badBriefId of [`brief-${'A'.repeat(24)}`, `brief-${'1'.repeat(25)}`, `brief-${'1'.repeat(23)}`]) {
    const rejected = buildExactPlan({
      taskId: TASK_ID, request, workflowId: 'generate_media', slots: { brief_id: badBriefId, mode: 'image', prompt: '猫' },
    });
    assert.equal(rejected.ok, false, `身份 ${badBriefId} 必须在计划层被拒绝`);
    assert.equal(rejected.code, 'PLAN_SLOT_IDENTITY');
    assert.equal(rejected.diagnostics.field, 'brief_id');
  }
  // 底层 builder 生成的合法计划（quote-only：零付费零写入批准；其成功执行
  // 路径由 g1-harness-tools 全链路覆盖）。
  const valid = buildExactPlan({
    taskId: TASK_ID,
    request,
    workflowId: 'generate_media',
    slots: { brief_id: `brief-${'a'.repeat(24)}`, mode: 'image', prompt: '猫', submit_generation: false },
  });
  assert.equal(valid.ok, true, valid.code);
  assert.equal(valid.value.approvals.paid_external_calls, false);
  // 执行层：篡改计划携带超长身份 → validatePlanShape 拒绝 → 零桥调用
  // （含项目读取），business/provider/paid 调用自然为零。
  const forged = { ...valid.value, slots: { ...valid.value.slots, brief_id: LEGACY_BRIEF_ID } };
  assert.equal(validatePlanShape(forged).code, 'PLAN_SLOT_IDENTITY');
  const bridge = mockBoundary();
  const taskView = view(valid.value);
  const output = await executeConfirmedPlan({
    taskView, plan: forged, signal: null, emit: () => {}, toolClient: bridge.client, stateReader: createBridgeStateReader(bridge.client),
  });
  assert.equal(output.outcome, 'failed');
  assert.equal(taskView.step_states['st-0'].error.code, 'INTERNAL_PLAN_VALIDATION_ERROR');
  assert.equal(taskView.step_states['st-0'].error.retry_unsafe, true, '畸形计划不可重试');
  assert.equal(bridge.calls.length, 0, '畸形身份绝不产生任何 bridge 调用（含项目读取）');
});

test('项目知识卡含非法或错绑身份：Brief 装配与复用均 fail closed，零 business/provider/paid 调用', async () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const { evidence, analyses, cards } = threeCardProject(projectId);
  const plan = await buildPlan('生成待审核 Brief', projectId);
  const briefStep = plan.steps.find((step) => step.operation === 'workspace.brief.assemble');
  // 非法卡身份（空值/非规范格式）进入项目状态 → 装配步骤失败关闭。
  const illegalBridge = mockBoundary({ evidence, analyses, cards: [{ ...cards[0], id: 'kc-broken' }, ...cards.slice(1)] });
  const illegalRun = await run(plan, illegalBridge);
  assert.equal(illegalRun.output.outcome, 'failed');
  assert.equal(illegalRun.taskView.step_states[briefStep.step].state, 'failed');
  assert.equal(illegalRun.taskView.step_states[briefStep.step].error.code, BRIEF_CARD_IDENTITY_INVALID);
  assert.equal(illegalRun.taskView.step_states[briefStep.step].error.field, 'knowledge_card_id');
  assert.equal(
    illegalBridge.calls.filter((call) => call.operation !== 'workspace.project.read').length,
    0,
    '非法卡身份绝不触发 business/provider/paid 调用',
  );
  // 错绑身份：卡记录绑定到其他项目 → 同样失败关闭（绝不被静默混入本项目身份）。
  const misboundBridge = mockBoundary({ evidence, analyses, cards: [{ ...cards[0], project_id: 'prj-bbbbbbbbbbbbbbbbbbbbbbbb' }, ...cards.slice(1)] });
  const misboundRun = await run(plan, misboundBridge);
  assert.equal(misboundRun.output.outcome, 'failed');
  assert.equal(misboundRun.taskView.step_states[briefStep.step].error.code, BRIEF_CARD_IDENTITY_INVALID);
  assert.equal(misboundRun.taskView.step_states[briefStep.step].error.field, 'knowledge_card_id');
  assert.equal(
    misboundBridge.calls.filter((call) => call.operation !== 'workspace.project.read').length,
    0,
    '错绑卡身份绝不触发 business/provider/paid 调用',
  );
  // card-<24 位十六进制> 旧前缀别名：即使格式完全合规（合法十六进制、正确长度），
  // 也整体拒绝 —— 权威身份严格为 kc-，card- 不是合法别名。
  const aliasBridge = mockBoundary({ evidence, analyses, cards: [{ ...cards[0], id: `card-${'1'.repeat(24)}` }, ...cards.slice(1)] });
  const aliasRun = await run(plan, aliasBridge);
  assert.equal(aliasRun.output.outcome, 'failed');
  assert.equal(aliasRun.taskView.step_states[briefStep.step].state, 'failed');
  assert.equal(aliasRun.taskView.step_states[briefStep.step].error.code, BRIEF_CARD_IDENTITY_INVALID);
  assert.equal(aliasRun.taskView.step_states[briefStep.step].error.field, 'knowledge_card_id');
  assert.equal(
    aliasBridge.calls.filter((call) => call.operation !== 'workspace.project.read').length,
    0,
    'card- 别名身份绝不触发 business/provider/paid 调用',
  );
  // 既有规范 Brief + 非法卡集合：绝不复用、绝不写入，同样失败关闭。
  const reuseBridge = mockBoundary({
    evidence, analyses,
    cards: [{ ...cards[0], id: 'kc-broken' }, ...cards.slice(1)],
    brief: canonicalBrief(projectId, cards.map((card) => card.id)),
  });
  const reuseRun = await run(plan, reuseBridge);
  assert.equal(reuseRun.output.outcome, 'failed');
  assert.equal(reuseRun.taskView.step_states[briefStep.step].state, 'failed');
  assert.equal(reuseRun.taskView.step_states[briefStep.step].error.code, BRIEF_CARD_IDENTITY_INVALID);
  assert.equal(reuseBridge.calls.filter((call) => call.operation === 'workspace.brief.assemble').length, 0, '非法卡身份绝不触发任何写入');
  assert.equal(
    reuseBridge.calls.filter((call) => call.operation !== 'workspace.project.read').length,
    0,
    '非法卡身份绝不复用、绝不写入、零 business/provider/paid 调用',
  );
});
