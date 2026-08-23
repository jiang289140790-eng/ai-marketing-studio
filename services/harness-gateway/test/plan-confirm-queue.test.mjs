// Queue-level two-phase contract: plan-only submission, stale/tampered
// confirmation fails closed with zero runner calls, exact approvals, retry of
// the exact failed step only, RETRY_UNSAFE for ambiguous paid outcomes, and
// restart recovery of planned/partial tasks.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setTimeout } from 'node:timers';
import { HarnessTaskQueue, GATEWAY_SCHEMA_VERSION, runWithIsolatedTaskView, runWithTaskTimeout, validateConfirmRequest, validateDelegatedAuthorization, validatePlanRequest, validateRetryRequest } from '../gateway-core.mjs';
import { createPlanner, planFingerprint } from '../planner.mjs';
import { createBridgeStateReader, executeConfirmedPlan } from '../deterministic-executor.mjs';

const planner = createPlanner();

function planRequest(overrides = {}) {
  return {
    schema_version: GATEWAY_SCHEMA_VERSION,
    request_id: 'plan-1',
    user_id: 'user-a',
    project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa',
    intent: '分析这个 X 帖子 https://x.com/a/status/1234567890123456789，保存证据和分析，并生成待审核 Brief',
    ...overrides,
  };
}

function confirmRequest(taskId, fingerprint, approval) {
  return { schema_version: GATEWAY_SCHEMA_VERSION, task_id: taskId, plan_fingerprint: fingerprint, approval };
}

function retryRequest(taskId, fingerprint, stepId, approval) {
  return { schema_version: GATEWAY_SCHEMA_VERSION, task_id: taskId, plan_fingerprint: fingerprint, step_id: stepId, approval };
}

// Stateful mock boundary; the exact tool contract is enforced on every call
// (validateToolCall runs inside the executor before bridge contact).
function mockBridge({ failCollect = false, ambiguousCollect = false, failAnalysis = false } = {}) {
  const state = { revision: 3, evidence: [], analyses: [], cards: [], brief: null, handoffs: [] };
  const calls = [];
  const flags = { failCollect, ambiguousCollect, failAnalysis };
  const assertCurrentRevision = (call) => {
    assert.equal(call.expected_revision, state.revision, `${call.operation} must bind the latest project revision before bridge contact`);
  };
  const client = async (call, trusted) => {
    calls.push(call.operation);
    switch (call.operation) {
      case 'workspace.project.read':
        return { ok: true, data: { project: { version: state.revision, topic: 't', objective: 'o', constraints: [], evidence: state.evidence, analyses: state.analyses, knowledge_cards: state.cards, brief: state.brief, handoffs: state.handoffs } } };
      case 'research.collect_url': {
        if (flags.ambiguousCollect) return { ok: false, code: 'TOOL_TIMEOUT', diagnostics: { issues: ['bridge timed out'] } };
        if (flags.failCollect) return { ok: false, code: 'UNSUPPORTED_PLATFORM', diagnostics: { issues: ['platform rejected'] } };
        const text = '测试正文内容';
        const item = {
          id: 'x-post-1', source_url: call.payload.url, label: '帖子', platform: 'x', content_text: text,
          external_id: '1234567890123456789', content_sha256: createHash('sha256').update(text).digest('hex'),
          provenance: { schema_version: 'p22_collected_source_v1', provider: 'apify:xquik/x-tweet-scraper', run_id: 'run-1', collected_at: '2026-08-15T08:00:00.000Z', usage_total_usd: 0.01, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
          collection_proof: '1999999999.' + 'c'.repeat(64), source_metadata: { author: { name: 'A' }, engagement: { likes: 1 } }, media_assets: [],
        };
        return { ok: true, entity: { type: 'evidence', id: 'ev-dummy' }, data: { items: [item] }, artifact_refs: [] };
      }
      case 'workspace.evidence.create': {
        assertCurrentRevision(call);
        const id = 'ev-' + '1'.repeat(24);
        state.evidence = [{ ...call.payload.evidence, id, project_id: trusted.project_id, fingerprint: 'e'.repeat(64), version: 1 }];
        state.revision += 1;
        return { ok: true, entity: { type: 'evidence', id }, artifact_refs: [id] };
      }
      case 'research.analyze_persisted': {
        if (flags.failAnalysis) return { ok: false, code: 'QWEN_REQUEST_FAILED', diagnostics: { issues: ['model rejected'] } };
        return { ok: true, data: { analyses: [{ source_id: 'x-post-1', model: 'qwen3.5-omni-flash', result: { text_expression: 'x', media_analysis: [], virality_drivers: [], reusable_methods: [], signals: [], risks: [] }, executed_at: '2026-08-15T08:01:00.000Z', usage: { total_tokens: 200 }, cost: {} }] }, artifact_refs: [] };
      }
      case 'workspace.analysis.create': {
        assertCurrentRevision(call);
        const record = { ...call.payload.analysis, fingerprint: 'a'.repeat(64) };
        state.analyses = [record];
        state.revision += 1;
        return { ok: true, entity: { type: 'analysis', id: record.id }, artifact_refs: [record.id] };
      }
      case 'workspace.card.create': {
        assertCurrentRevision(call);
        const record = { ...call.payload.card, fingerprint: 'k'.repeat(64) };
        state.cards = [record];
        state.revision += 1;
        return { ok: true, entity: { type: 'card', id: record.id }, artifact_refs: [record.id] };
      }
      case 'workspace.brief.assemble': {
        assertCurrentRevision(call);
        const record = { ...call.payload.brief, fingerprint: 'b'.repeat(64) };
        state.brief = record;
        state.revision += 1;
        return { ok: true, entity: { type: 'brief', id: record.id }, artifact_refs: [record.id] };
      }
      default:
        return { ok: false, code: 'UNEXPECTED_OPERATION' };
    }
  };
  return { state, calls, client, flags };
}

function createQueue(bridge, { initialTasks = [], plannerOverride = planner, queueOptions = {} } = {}) {
  const deterministicRunner = (request, taskId, signal, runtimeContext, taskView, emit) => {
    const stateReader = createBridgeStateReader(bridge.client);
    return executeConfirmedPlan({ taskView, plan: taskView.plan, signal, emit, toolClient: bridge.client, stateReader });
  };
  return new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    deterministicRunner,
    planner: plannerOverride,
    initialTasks,
    validateRuntimeContext: (context) => (context?.delegatedAuthorization ? { ok: true } : { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' }),
    ...queueOptions,
  });
}

test('plan-only submission never executes and replays idempotently', async () => {
  const bridge = mockBridge();
  const queue = createQueue(bridge);
  const first = await queue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(first.ok, true);
  assert.equal(first.task.state, 'planned');
  assert.equal(first.task.plan.schema_version, 'ams_harness_plan_v1');
  assert.equal(first.task.plan_fingerprint, first.task.plan.fingerprint);
  assert.equal(first.task.h2_context.capability_registry.registry_version, 'h2_capability_registry_v1');
  assert.ok(first.task.h2_context.capability_registry.capability_count > 0, 'reviewed runtime capabilities are attached to the exact plan');
  assert.equal(first.task.h2_context.project_memory.item_count, 0, 'a new project task starts with bounded empty memory');
  assert.equal(first.task.h2_context.preflight_critic.verdict, 'pass', 'the exact immutable plan passes preflight review');
  assert.equal(bridge.calls.length, 0, 'planning must not contact the bridge');
  await queue.whenIdle();
  assert.equal(bridge.calls.length, 0, 'a plan alone must never execute');
  const replay = await queue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
});

test('semantic clarification releases planning reservation and performs zero bridge or runner calls', async () => {
  const bridge = mockBridge();
  let plannerCalls = 0;
  const clarificationPlanner = {
    async plan() {
      plannerCalls += 1;
      return {
        ok: false,
        code: 'PLANNER_CLARIFICATION_REQUIRED',
        diagnostics: { questions: [{ id: 'x_sort', field: 'sort', prompt: 'X 只能按最新发布搜索，是否接受？', options: ['接受', '改搜 Reddit 热门'] }] },
      };
    },
  };
  const queue = createQueue(bridge, { plannerOverride: clarificationPlanner });
  const request = planRequest({ request_id: 'clarification-1', intent: '帮我收集最近最热的 X 帖子 5 条' });
  const first = await queue.plan(request, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(first.code, 'PLANNER_CLARIFICATION_REQUIRED');
  assert.equal(first.diagnostics.questions.length, 1);
  assert.equal(queue.list('user-a').length, 0, 'clarification does not persist an executable task');
  assert.equal(bridge.calls.length, 0, 'clarification never contacts business tools');
  const second = await queue.plan(request, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(second.code, 'PLANNER_CLARIFICATION_REQUIRED');
  assert.equal(plannerCalls, 2, 'a later explicit request can plan fresh after the reservation is released');
  assert.equal(bridge.calls.length, 0);
});

test('stale or tampered confirmation fails closed with zero execution', async () => {
  const bridge = mockBridge();
  const queue = createQueue(bridge);
  const planned = await queue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const task = planned.task;
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  const wrongFingerprint = confirmRequest(task.id, 'f'.repeat(64), approvals);
  const rejected = queue.confirm(wrongFingerprint, task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'PLAN_FINGERPRINT_MISMATCH');
  const wrongTask = confirmRequest('ht-22222222-2222-4222-8222-222222222222', task.plan.fingerprint, approvals);
  assert.equal(queue.confirm(wrongTask, task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) }).code, 'TASK_NOT_FOUND');
  const missingApproval = confirmRequest(task.id, task.plan.fingerprint, { paid_external_calls: true, online_writes: false, handoff_creation: false });
  assert.equal(queue.confirm(missingApproval, task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) }).code, 'CONFIRM_APPROVAL_MISMATCH');
  const extraApproval = confirmRequest(task.id, task.plan.fingerprint, { paid_external_calls: true, online_writes: true, handoff_creation: true });
  assert.equal(queue.confirm(extraApproval, task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) }).code, 'CONFIRM_APPROVAL_MISMATCH');
  await queue.whenIdle();
  assert.equal(bridge.calls.length, 0, 'rejected confirmations must execute zero tools');
});

test('confirmed plans fail closed when the deterministic runner is unavailable', async () => {
  const bridge = mockBridge();
  let legacyCalls = 0;
  const queue = new HarnessTaskQueue({
    runner: async () => { legacyCalls += 1; return {}; },
    planner,
    validateRuntimeContext: () => ({ ok: true }),
  });
  const planned = await queue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  const confirmed = queue.confirm(confirmRequest(planned.task.id, planned.task.plan.fingerprint, approvals), 'user-a', { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.deepEqual(confirmed, { ok: false, code: 'DETERMINISTIC_RUNNER_UNAVAILABLE' });
  await queue.whenIdle();
  assert.equal(legacyCalls, 0);
  assert.equal(bridge.calls.length, 0);
  assert.equal(queue.read(planned.task.id, 'user-a').task.state, 'planned');
});

test('deterministic execution has one bounded overall timeout and aborts its task signal', async () => {
  let boundedSignal;
  const startedAt = Date.now();
  await assert.rejects(
    runWithTaskTimeout({
      signal: null,
      timeoutMs: 5,
      run: (signal) => {
        boundedSignal = signal;
        return new Promise(() => {});
      },
    }),
    (error) => error?.code === 'TASK_TIMEOUT',
  );
  assert.equal(boundedSignal.aborted, true);
  assert.equal(boundedSignal.reason?.code, 'TASK_TIMEOUT');
  assert.ok(Date.now() - startedAt < 250, 'an uncooperative runner cannot hold the bounded timeout open');
});

test('parent cancellation immediately releases an abort-ignoring task and already-aborted work never starts', async () => {
  const parent = new globalThis.AbortController();
  let boundedSignal;
  let calls = 0;
  const startedAt = Date.now();
  const pending = runWithTaskTimeout({
    signal: parent.signal,
    timeoutMs: 10_000,
    run: (signal) => {
      calls += 1;
      boundedSignal = signal;
      return new Promise(() => {});
    },
  });
  await Promise.resolve();
  parent.abort();
  await assert.rejects(pending, (error) => error?.code === 'CANCELLED');
  assert.equal(calls, 1);
  assert.equal(boundedSignal.aborted, true);
  assert.equal(boundedSignal.reason?.code, 'CANCELLED');
  assert.ok(Date.now() - startedAt < 250, 'parent cancellation cannot leave an uncooperative runner holding the queue');

  const alreadyAborted = new globalThis.AbortController();
  alreadyAborted.abort();
  let preAbortedCalls = 0;
  await assert.rejects(
    runWithTaskTimeout({
      signal: alreadyAborted.signal,
      timeoutMs: 10_000,
      run: () => {
        preAbortedCalls += 1;
        return Promise.resolve();
      },
    }),
    (error) => error?.code === 'CANCELLED',
  );
  assert.equal(preAbortedCalls, 0, 'already-cancelled work must not start');
});

test('an abort-ignoring runner cannot mutate or emit after terminal timeout', async () => {
  const taskView = { step_states: { initial: { state: 'running' } } };
  const emitted = [];
  await assert.rejects(
    runWithTaskTimeout({
      signal: null,
      timeoutMs: 5,
      run: (signal) => runWithIsolatedTaskView({
        taskView,
        signal,
        emit: (detail) => emitted.push(detail),
        run: async (isolated, isolatedEmit) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          isolated.step_states.late = { state: 'succeeded' };
          isolatedEmit({ event: 'late' });
          return {};
        },
      }),
    }),
    (error) => error?.code === 'TASK_TIMEOUT',
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(taskView.step_states.initial.state, 'failed');
  assert.equal(taskView.step_states.initial.error.code, 'TASK_TIMEOUT');
  assert.equal(taskView.step_states.initial.error.retry_unsafe, false);
  assert.ok(taskView.step_states.initial.finished_at);
  assert.equal(taskView.step_states.late, undefined);
  assert.deepEqual(emitted, []);
});

test('confirmed plan executes deterministically and terminal replay is free', async () => {
  const bridge = mockBridge();
  const queue = createQueue(bridge);
  const planned = await queue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const task = planned.task;
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  const confirmed = queue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.task.state, 'queued');
  await queue.whenIdle();
  const done = queue.read(task.id, task.request.user_id).task;
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.partial_completion, undefined);
  const executed = bridge.calls.filter((operation) => operation !== 'workspace.project.read');
  assert.deepEqual(executed, ['research.collect_url', 'workspace.evidence.create', 'research.analyze_persisted', 'workspace.analysis.create', 'workspace.card.create', 'workspace.brief.assemble']);
  assert.equal(done.result.artifact_refs.length, 4, 'evidence + analysis + card + brief refs');
  const callsBeforeReplay = bridge.calls.length;
  const replay = queue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(replay.replayed, true);
  assert.equal(bridge.calls.length, callsBeforeReplay, 'terminal replay must not execute');
});

test('retry reruns only the exact failed step; completed steps stay untouched', async () => {
  const bridge = mockBridge({ failAnalysis: true });
  const queue = createQueue(bridge);
  const planned = await queue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const task = planned.task;
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  queue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  await queue.whenIdle();
  const partial = queue.read(task.id, task.request.user_id).task;
  assert.equal(partial.state, 'partial', 'some steps succeeded before the analysis failure');
  assert.equal(partial.step_states['st-1'].state, 'succeeded');
  assert.equal(partial.step_states['st-3'].state, 'failed');
  assert.equal(partial.step_states['st-4'].state, 'blocked');
  assert.equal(partial.step_states['st-6'].state, 'blocked');
  const cancelledPartial = queue.cancel(task.id, task.request.user_id);
  assert.equal(cancelledPartial.ok, true);
  assert.equal(cancelledPartial.unchanged, true);
  assert.equal(cancelledPartial.task.state, 'partial');
  const callsBefore = bridge.calls.length;

  // Retry an eligible failed step with the same fingerprint and approvals.
  bridge.flags.failAnalysis = false;
  const retried = queue.retry(retryRequest(task.id, task.plan.fingerprint, 'st-3', approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(retried.ok, true);
  await queue.whenIdle();
  const done = queue.read(task.id, task.request.user_id).task;
  assert.equal(done.state, 'succeeded');
  assert.equal(done.step_states['st-1'].state, 'succeeded', 'completed step untouched');
  assert.equal(done.step_states['st-3'].state, 'succeeded', 'retried step reran');
  assert.equal(done.step_states['st-4'].state, 'succeeded', 'dependent step resumed');
  const newCalls = bridge.calls.slice(callsBefore);
  assert.ok(newCalls.includes('research.analyze_persisted'), 'only the failed step reruns its paid call');
  assert.ok(!newCalls.includes('research.collect_url'), 'completed paid collection must not rerun');
  assert.ok(!newCalls.includes('workspace.evidence.create'), 'completed write must not rerun');
  const collectionCalls = bridge.calls.filter((operation) => operation === 'research.collect_url');
  assert.equal(collectionCalls.length, 1, 'exactly one paid collection across the whole task');
});

test('an accepted failed-step retry replays idempotently while queued, running, and after every final outcome', async () => {
  const sourceBridge = mockBridge({ failAnalysis: true });
  const sourceQueue = createQueue(sourceBridge);
  const planned = await sourceQueue.plan(planRequest({ request_id: 'retry-replay-source' }));
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  sourceQueue.confirm(confirmRequest(planned.task.id, planned.task.plan.fingerprint, approvals), planned.task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  await sourceQueue.whenIdle();
  const partial = sourceQueue.read(planned.task.id, planned.task.request.user_id).task;
  assert.equal(partial.state, 'partial');

  for (const outcome of ['partial', 'succeeded', 'failed']) {
    let release;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let executions = 0;
    const queue = new HarnessTaskQueue({
      runner: async () => { throw new Error('legacy runner must not run'); },
      planner,
      initialTasks: [partial],
      deterministicRunner: async (_request, _taskId, _signal, _runtime, liveTask) => {
        executions += 1;
        markStarted();
        await gate;
        applyScriptedStepEvidence(liveTask, outcome);
        return { outcome, final_response: outcome, artifact_refs: [] };
      },
      validateRuntimeContext: (context) => (context?.delegatedAuthorization ? { ok: true } : { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' }),
    });
    const request = retryRequest(partial.id, partial.plan.fingerprint, 'st-3', approvals);
    const accepted = queue.retry(request, partial.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.replayed, false);
    const queuedReplay = queue.retry(request, partial.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
    assert.equal(queuedReplay.replayed, true, `${outcome}: queued replay`);
    await started;
    const runningReplay = queue.retry(request, partial.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
    assert.equal(runningReplay.replayed, true, `${outcome}: running replay`);
    release();
    await queue.whenIdle();
    const finalReplay = queue.retry(request, partial.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
    assert.equal(finalReplay.replayed, true, `${outcome}: final replay`);
    assert.equal(finalReplay.task.state, outcome, JSON.stringify({ error: finalReplay.task.error, critic: finalReplay.task.h2_context?.postflight_critic, states: finalReplay.task.step_states }));
    assert.equal(executions, 1, `${outcome}: exact replay never enqueues or executes twice`);
    const otherStep = queue.retry(retryRequest(partial.id, partial.plan.fingerprint, 'st-1', approvals), partial.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
    assert.notEqual(otherStep.replayed, true, `${outcome}: a different step is never treated as the accepted retry`);
  }
});

test('ambiguous paid outcome rejects retry with RETRY_UNSAFE', async () => {
  const bridge = mockBridge({ ambiguousCollect: true });
  const queue = createQueue(bridge);
  const planned = await queue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const task = planned.task;
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  queue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  await queue.whenIdle();
  const failed = queue.read(task.id, task.request.user_id).task;
  assert.equal(failed.state, 'partial', 'read_state succeeded before the ambiguous paid step failed');
  const verdict = queue.retry(retryRequest(task.id, task.plan.fingerprint, 'st-1', approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'RETRY_UNSAFE');
});

test('ambiguous paid Provider call remains exactly once across failure, restart and repeated retry attempts', async () => {
  const bridge = mockBridge({ ambiguousCollect: true });
  const firstQueue = createQueue(bridge);
  const planned = await firstQueue.plan(planRequest({ request_id: 'paid-once-across-restart' }), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  firstQueue.confirm(confirmRequest(planned.task.id, planned.task.plan.fingerprint, approvals), planned.task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  await firstQueue.whenIdle();
  const partial = firstQueue.read(planned.task.id, planned.task.request.user_id).task;
  assert.equal(bridge.calls.filter((operation) => operation === 'research.collect_url').length, 1);

  const restarted = createQueue(bridge, { initialTasks: [partial] });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retry = restarted.retry(retryRequest(partial.id, partial.plan.fingerprint, 'st-1', approvals), partial.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
    assert.equal(retry.code, 'RETRY_UNSAFE');
  }
  restarted.cancel(partial.id, partial.request.user_id);
  assert.equal(bridge.calls.filter((operation) => operation === 'research.collect_url').length, 1, 'restart, retries and cancellation cannot resubmit an ambiguous paid call');
});

test('retry requires the exact failed step and the same plan fingerprint', async () => {
  const bridge = mockBridge({ failAnalysis: true });
  const queue = createQueue(bridge);
  const planned = await queue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const task = planned.task;
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  queue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  await queue.whenIdle();
  const wrongStep = queue.retry(retryRequest(task.id, task.plan.fingerprint, 'st-1', approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(wrongStep.code, 'STEP_NOT_FAILED');
  const wrongFingerprint = queue.retry(retryRequest(task.id, 'f'.repeat(64), 'st-3', approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(wrongFingerprint.code, 'PLAN_FINGERPRINT_MISMATCH');
  const wrongApproval = queue.retry(retryRequest(task.id, task.plan.fingerprint, 'st-3', { paid_external_calls: false, online_writes: true, handoff_creation: false }), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(wrongApproval.code, 'CONFIRM_APPROVAL_MISMATCH');
});

test('restart recovery keeps planned tasks planned and partial tasks retryable', async () => {
  const bridge = mockBridge({ failAnalysis: true });
  const firstQueue = createQueue(bridge);
  const planned = await firstQueue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const task = planned.task;
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  firstQueue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  await firstQueue.whenIdle();
  const partial = firstQueue.read(task.id, task.request.user_id).task;
  assert.equal(partial.state, 'partial');

  // A second queue loads the persisted snapshot of the same partial task.
  const secondQueue = createQueue(bridge, { initialTasks: [partial] });
  const recovered = secondQueue.read(task.id, task.request.user_id).task;
  assert.equal(recovered.state, 'partial');
  assert.equal(recovered.plan.fingerprint, task.plan.fingerprint);
  assert.equal(recovered.step_states['st-1'].state, 'succeeded');
  assert.equal(recovered.step_states['st-3'].state, 'failed');

  // A queued/running snapshot recovers as failed; a planned snapshot stays planned.
  const plannedSnapshot = { ...planned.task, plan_fingerprint: planned.task.plan.fingerprint };
  const thirdQueue = createQueue(bridge, { initialTasks: [plannedSnapshot] });
  assert.equal(thirdQueue.read(planned.task.id, planned.task.request.user_id).task.state, 'planned');
  const runningSnapshot = { ...partial, state: 'running' };
  const fourthQueue = createQueue(bridge, { initialTasks: [runningSnapshot] });
  const recoveredRunning = fourthQueue.read(task.id, task.request.user_id).task;
  assert.equal(recoveredRunning.state, 'failed');
  assert.equal(recoveredRunning.error.code, 'GATEWAY_RESTARTED');
});

test('plan request validation is exact and fail-closed', () => {
  assert.equal(validatePlanRequest({ ...planRequest(), approval: { paid_external_calls: true } }).code, 'UNKNOWN_FIELD');
  assert.equal(validatePlanRequest({ ...planRequest(), sql: 'select 1' }).code, 'UNKNOWN_FIELD');
  assert.equal(validatePlanRequest({ ...planRequest(), user_id: '' }).code, 'USER_ID_INVALID');
  assert.equal(validatePlanRequest({ ...planRequest(), intent: '' }).code, 'INTENT_INVALID');
  assert.equal(validatePlanRequest({ schema_version: 'other' }).code, 'SCHEMA_VERSION_MISMATCH');
  assert.equal(validateConfirmRequest({ schema_version: GATEWAY_SCHEMA_VERSION, task_id: 'bad', plan_fingerprint: 'a'.repeat(64), approval: {} }).code, 'TASK_ID_INVALID');
  assert.equal(validateConfirmRequest({ schema_version: GATEWAY_SCHEMA_VERSION, task_id: 'ht-11111111-1111-4111-8111-111111111111', plan_fingerprint: 'zz', approval: {} }).code, 'PLAN_FINGERPRINT_INVALID');
  assert.equal(validateConfirmRequest({ schema_version: GATEWAY_SCHEMA_VERSION, task_id: 'ht-11111111-1111-4111-8111-111111111111', plan_fingerprint: 'a'.repeat(64), approval: { admin: true } }).code, 'APPROVAL_UNKNOWN_FIELD');
  assert.equal(validateRetryRequest({ schema_version: GATEWAY_SCHEMA_VERSION, task_id: 'ht-11111111-1111-4111-8111-111111111111', plan_fingerprint: 'a'.repeat(64), step_id: 'st-0', approval: {} }).code, undefined);
  assert.equal(validateRetryRequest({ schema_version: GATEWAY_SCHEMA_VERSION, task_id: 'ht-11111111-1111-4111-8111-111111111111', plan_fingerprint: 'a'.repeat(64), step_id: 'other', approval: {} }).code, 'STEP_ID_INVALID');
});

test('concurrent identical plan requests serialize into one planner invocation and one authoritative plan', async () => {
  const bridge = mockBridge();
  let plannerInvocations = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delayedPlanner = {
    async plan(args) {
      plannerInvocations += 1;
      await gate;
      return createPlanner().plan(args);
    },
  };
  const queue = createQueue(bridge, { plannerOverride: delayedPlanner });
  const request = planRequest({ request_id: 'concurrent-1' });
  const first = queue.plan(request, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const second = queue.plan(request, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(plannerInvocations, 1, 'two simultaneous identical requests invoke the planner exactly once');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.replayed, true, 'the waiting caller replays the leader outcome');
  assert.equal(a.task.id, b.task.id, 'one task id for the identity');
  assert.equal(a.task.plan.fingerprint, b.task.plan.fingerprint, 'one plan fingerprint for the identity');
  const tasks = queue.list('user-a', 100).filter((task) => task.request.request_id === 'concurrent-1');
  assert.equal(tasks.length, 1, 'exactly one authoritative task/plan exists for the identity');
  // Zero duplicate confirm/execution paths: confirming the single plan runs
  // its paid steps exactly once.
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  const confirmed = queue.confirm(confirmRequest(a.task.id, a.task.plan.fingerprint, approvals), 'user-a', { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(confirmed.ok, true);
  await queue.whenIdle();
  const done = queue.read(a.task.id, 'user-a').task;
  assert.equal(done.state, 'succeeded');
  const collectionCalls = bridge.calls.filter((operation) => operation === 'research.collect_url');
  assert.equal(collectionCalls.length, 1, 'the single plan executes its paid steps exactly once');
});

test('concurrent different normalized requests under one identity fail closed with IDEMPOTENCY_CONFLICT', async () => {
  let plannerInvocations = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delayedPlanner = {
    async plan(args) {
      plannerInvocations += 1;
      await gate;
      return createPlanner().plan(args);
    },
  };
  const queue = new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    planner: delayedPlanner,
    validateRuntimeContext: () => ({ ok: true }),
  });
  const leader = queue.plan(planRequest({ request_id: 'concurrent-2' }), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const conflict = await queue.plan(planRequest({ request_id: 'concurrent-2', intent: '不同的意图' }), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT', 'a different normalized request under the same in-flight identity fails closed immediately');
  release();
  const outcome = await leader;
  assert.equal(outcome.ok, true);
  assert.equal(plannerInvocations, 1, 'the conflicting caller never invoked the planner');
});

test('planner failure releases the reservation without leaving a second executable plan', async () => {
  let attempts = 0;
  const flakyPlanner = {
    async plan(args) {
      attempts += 1;
      if (attempts === 1) return { ok: false, code: 'PLANNER_UNRECOGNIZED' };
      return createPlanner().plan(args);
    },
  };
  const queue = new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    planner: flakyPlanner,
    validateRuntimeContext: () => ({ ok: true }),
  });
  const request = planRequest({ request_id: 'concurrent-3' });
  const [a, b] = await Promise.all([queue.plan(request, null), queue.plan(request, null)]);
  assert.equal(a.ok, false);
  assert.equal(a.code, 'PLANNER_UNRECOGNIZED');
  assert.equal(b.ok, false, 'the waiting caller shares the leader failure instead of becoming a second leader');
  assert.equal(b.code, 'PLANNER_UNRECOGNIZED');
  assert.equal(attempts, 1, 'concurrent callers produce exactly one planning attempt');
  assert.equal(queue.list('user-a', 100).filter((task) => task.request.request_id === 'concurrent-3').length, 0, 'the shared planning failure leaves no executable task');
  const retried = await queue.plan(request, null);
  assert.equal(retried.ok, true, 'a later explicit request may plan fresh after the failed reservation is released');
  assert.equal(retried.replayed, false);
  assert.equal(attempts, 2, 'only the later explicit request starts a fresh planning attempt');
  assert.equal(queue.list('user-a', 100).filter((task) => task.request.request_id === 'concurrent-3').length, 1, 'the later request creates exactly one authoritative task');
  await queue.whenIdle();
});

test('all concurrent waiters share one failed planning outcome and never elect duplicate leaders', async () => {
  const bridge = mockBridge();
  let invocations = 0;
  const failingPlanner = {
    async plan() {
      invocations += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: false, code: 'PLANNER_UNAVAILABLE' };
    },
  };
  const queue = createQueue(bridge, { plannerOverride: failingPlanner });
  const request = planRequest({ request_id: 'concurrent-failure' });
  const outcomes = await Promise.all([queue.plan(request), queue.plan(request), queue.plan(request), queue.plan(request)]);
  assert.equal(invocations, 1);
  assert.ok(outcomes.every((outcome) => outcome.ok === false && outcome.code === 'PLANNER_UNAVAILABLE'));
  assert.equal(queue.list('user-a', 10).length, 0);
  assert.equal(bridge.calls.length, 0);
});

test('a synchronous planner throw releases the reservation so a later request can recover', async () => {
  let attempts = 0;
  const planner = {
    plan(args) {
      attempts += 1;
      if (attempts === 1) throw new Error('synchronous planner failure');
      return createPlanner().plan(args);
    },
  };
  const queue = new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    planner,
    validateRuntimeContext: () => ({ ok: true }),
  });
  const request = planRequest({ request_id: 'sync-planner-recovery' });
  const failed = await queue.plan(request, null);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'PLANNER_UNAVAILABLE');
  const recovered = await queue.plan(request, null);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.replayed, false);
  assert.equal(attempts, 2);
});

test('executed plan replays never disclose internal paid retry state', async () => {
  const bridge = mockBridge();
  const queue = createQueue(bridge);
  const request = planRequest({ request_id: 'filtered-plan-replay' });
  const planned = await queue.plan(request);
  const approvals = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  queue.confirm(
    confirmRequest(planned.task.id, planned.task.plan.fingerprint, approvals),
    planned.task.request.user_id,
    { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) },
  );
  await queue.whenIdle();
  const replay = await queue.plan(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.ok(Object.values(replay.task.step_states).some((state) => state.state === 'succeeded'));
  for (const state of Object.values(replay.task.step_states)) {
    assert.equal(state.resume_output, undefined);
    assert.equal(state.resume_ref, undefined);
  }
});

test('audit persistence failure durably fails the reservation without a second executable plan', async () => {
  let plannerInvocations = 0;
  const countingPlanner = {
    async plan(args) { plannerInvocations += 1; return createPlanner().plan(args); },
  };
  const queue = new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    planner: countingPlanner,
    onEvent: () => { throw new Error('audit disk full'); },
    validateRuntimeContext: () => ({ ok: true }),
  });
  const request = planRequest({ request_id: 'concurrent-4' });
  const first = await queue.plan(request, null);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'AUDIT_PERSISTENCE_UNAVAILABLE');
  assert.equal(queue.list('user-a', 100).filter((task) => task.request.request_id === 'concurrent-4').length, 0, 'the failed plan left no task behind');
  const second = await queue.plan(request, null);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'AUDIT_PERSISTENCE_UNAVAILABLE', 'the audit failure durably fails the reservation');
  assert.equal(plannerInvocations, 1, 'no second planner invocation after the durable audit failure');
  assert.equal(queue.list('user-a', 100).filter((task) => task.request.request_id === 'concurrent-4').length, 0, 'no second executable plan was ever created');
});

test('restart-safe replay of the exact original plan request replays identically without the planner or business tools', async () => {
  const bridge = mockBridge();
  const firstQueue = createQueue(bridge);
  const original = await firstQueue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const task = original.task;

  // Persisted snapshot round-trip through a fresh queue: the exact request
  // fingerprint, plan and plan fingerprint survive restart unchanged.
  const recoveredQueue = createQueue(bridge, { initialTasks: [task] });
  const recovered = recoveredQueue.read(task.id, task.request.user_id).task;
  assert.equal(recovered.request_fingerprint, task.request_fingerprint, 'request fingerprint survives restart unchanged');
  assert.equal(recovered.plan.fingerprint, task.plan.fingerprint, 'plan fingerprint survives restart unchanged');
  assert.equal(recovered.request.intent, task.request.intent, 'plan request shape survives restart');

  // Replaying the exact original plan request must return the identical task
  // id, plan fingerprint, request fingerprint and plan — the planner never
  // runs and no business tool is contacted.
  let plannerInvocations = 0;
  const countingPlanner = { async plan(args) { plannerInvocations += 1; return createPlanner().plan(args); } };
  const replayQueue = new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    planner: countingPlanner,
    initialTasks: [task],
    validateRuntimeContext: () => ({ ok: true }),
  });
  const replay = await replayQueue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(replay.ok, true, `exact replay after restart must succeed, not conflict (${replay.code})`);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, task.id, 'identical task id after restart');
  assert.equal(replay.task.plan.fingerprint, task.plan.fingerprint, 'identical plan fingerprint after restart');
  assert.equal(replay.task.request_fingerprint, task.request_fingerprint, 'identical request fingerprint after restart');
  assert.equal(replay.task.plan.intent, task.plan.intent, 'identical plan content');
  assert.equal(plannerInvocations, 0, 'replay must not invoke the planner');
  await replayQueue.whenIdle();
  assert.equal(bridge.calls.length, 0, 'replay must not invoke any business tool');
});

test('restart replay with altered intent or project fails closed; a different user is a separate identity', async () => {
  const bridge = mockBridge();
  const sourceQueue = createQueue(bridge);
  const original = await sourceQueue.plan(planRequest(), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const task = original.task;
  const restarted = createQueue(bridge, { initialTasks: [task] });
  const alteredIntent = await restarted.plan(planRequest({ intent: '不同的意图' }), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(alteredIntent.code, 'IDEMPOTENCY_CONFLICT', 'altered intent under the same identity fails closed after restart');
  const alteredProject = await restarted.plan(planRequest({ project_id: 'prj-bbbbbbbbbbbbbbbbbbbbbbbb' }), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(alteredProject.code, 'IDEMPOTENCY_CONFLICT', 'altered project under the same identity fails closed after restart');
  const alteredUser = await restarted.plan(planRequest({ user_id: 'user-b' }), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(alteredUser.ok, true, 'a different user is a different trusted identity');
  assert.notEqual(alteredUser.task.id, task.id, 'the different identity creates its own authoritative plan');
});

test('legacy non-plan task snapshots still reload through the legacy immediate-execution normalizer', () => {
  const legacy = {
    id: 'ht-33333333-3333-4333-8333-333333333333',
    state: 'queued',
    created_at: '2026-08-15T08:00:00.000Z',
    updated_at: '2026-08-15T08:00:00.000Z',
    request: {
      schema_version: GATEWAY_SCHEMA_VERSION,
      request_id: 'legacy-1',
      user_id: 'user-a',
      project_id: null,
      intent: 'legacy immediate execution',
      approval: { paid_external_calls: false, online_writes: false, handoff_creation: false },
    },
    result: null,
    error: null,
  };
  const queue = new HarnessTaskQueue({ runner: async () => {}, initialTasks: [legacy], validateRuntimeContext: () => ({ ok: true }) });
  const recovered = queue.read(legacy.id, 'user-a').task;
  assert.equal(recovered.state, 'failed', 'queued legacy snapshot recovers as failed');
  assert.equal(recovered.error.code, 'GATEWAY_RESTARTED');
  const replay = queue.submit({ ...legacy.request }, null);
  assert.equal(replay.replayed, true, 'legacy submit replay stays idempotent under the legacy normalizer');
  assert.equal(replay.task.id, legacy.id);
});

test('corrupted persisted plan fails the task closed with zero execution', async () => {
  const bridge = mockBridge();
  const sourceQueue = createQueue(bridge);
  const good = (await sourceQueue.plan(planRequest({ request_id: 'corrupt-1' }), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) })).task;
  const corrupted = {
    ...good,
    plan: { ...good.plan, intent: '被篡改的意图', fingerprint: good.plan.fingerprint },
    plan_fingerprint: good.plan.fingerprint,
  };
  const queue = createQueue(bridge, { initialTasks: [corrupted] });
  const recovered = queue.read(good.id, 'user-a').task;
  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.error.code, 'PLAN_CORRUPTED');
  assert.equal(recovered.plan, null, 'corrupted plan is never executable');
  assert.equal(recovered.plan_fingerprint, null);
  const replay = await queue.plan(planRequest({ request_id: 'corrupt-1' }), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'IDEMPOTENCY_CONFLICT', 'the corrupted identity fails closed on replay');
  await queue.whenIdle();
  assert.equal(bridge.calls.length, 0, 'a corrupted plan executes zero tools');
});

test('restart rejects a valid plan attached to the wrong persisted task envelope', async () => {
  const bridge = mockBridge();
  const source = createQueue(bridge);
  const first = (await source.plan(planRequest({ request_id: 'restore-bound-a' }))).task;
  const second = (await source.plan(planRequest({ request_id: 'restore-bound-b', project_id: 'prj-bbbbbbbbbbbbbbbbbbbbbbbb' }))).task;
  const crossBound = { ...first, plan: second.plan, plan_fingerprint: second.plan.fingerprint };
  const restored = createQueue(bridge, { initialTasks: [crossBound] });
  const task = restored.read(first.id, 'user-a').task;
  assert.equal(task.state, 'failed');
  assert.equal(task.error.code, 'PLAN_CORRUPTED');
  assert.equal(task.plan, null);
  assert.equal(bridge.calls.length, 0);
});

test('unconfirmed plans have exact per-user and global admission bounds', async () => {
  const bridge = mockBridge();
  let plannerInvocations = 0;
  const countingPlanner = { async plan(args) { plannerInvocations += 1; return planner.plan(args); } };
  const queue = createQueue(bridge, {
    plannerOverride: countingPlanner,
    queueOptions: { capacity: 3, plannedPerUserCapacity: 2 },
  });
  const first = await queue.plan(planRequest({ request_id: 'bound-a1' }));
  const second = await queue.plan(planRequest({ request_id: 'bound-a2' }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const sameUserOverflow = await queue.plan(planRequest({ request_id: 'bound-a3' }));
  assert.equal(sameUserOverflow.code, 'PLANNED_TASK_LIMIT');
  const otherUser = await queue.plan(planRequest({ request_id: 'bound-b1', user_id: 'user-b' }));
  assert.equal(otherUser.ok, true);
  const globalOverflow = await queue.plan(planRequest({ request_id: 'bound-c1', user_id: 'user-c' }));
  assert.equal(globalOverflow.code, 'QUEUE_FULL');
  assert.equal(plannerInvocations, 3, 'rejected admission creates no planner or tool side effect');
  assert.equal(bridge.calls.length, 0);
});

test('planned tasks can be cancelled to release bounded admission capacity', async () => {
  const bridge = mockBridge();
  const queue = createQueue(bridge, { queueOptions: { capacity: 1, plannedPerUserCapacity: 1 } });
  const first = await queue.plan(planRequest({ request_id: 'cancel-plan-1' }));
  assert.equal(first.ok, true);
  const cancelled = queue.cancel(first.task.id, 'user-a');
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task.state, 'cancelled');
  const next = await queue.plan(planRequest({ request_id: 'cancel-plan-2' }));
  assert.equal(next.ok, true);
  assert.equal(bridge.calls.length, 0);
});

test('legacy submit shares the global capacity bound with unconfirmed plans', async () => {
  const bridge = mockBridge();
  const queue = createQueue(bridge, { queueOptions: { capacity: 1, plannedPerUserCapacity: 1 } });
  const planned = await queue.plan(planRequest({ request_id: 'capacity-plan' }));
  assert.equal(planned.ok, true);
  const submitted = queue.submit({
    schema_version: GATEWAY_SCHEMA_VERSION,
    request_id: 'capacity-submit',
    user_id: 'user-b',
    project_id: null,
    intent: 'legacy immediate task',
    approval: { paid_external_calls: false, online_writes: false, handoff_creation: false },
  }, { delegatedAuthorization: 'Bearer ' + 'b'.repeat(40) });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.code, 'QUEUE_FULL');
});

test('gateway rejects malformed or cross-bound planner output before persistence', async () => {
  const bridge = mockBridge();
  const malformed = createQueue(bridge, {
    plannerOverride: { async plan() { return { ok: true, value: { schema_version: 'ams_harness_plan_v1' } }; } },
  });
  const malformedResult = await malformed.plan(planRequest({ request_id: 'bad-shape' }));
  assert.equal(malformedResult.code, 'PLANNER_OUTPUT_INVALID');
  assert.equal(malformed.list('user-a', 10).length, 0);

  const crossBoundPlanner = {
    async plan(args) {
      const built = await planner.plan(args);
      const value = { ...built.value, user_id: 'user-b' };
      value.fingerprint = planFingerprint(value);
      return { ok: true, value };
    },
  };
  const crossBound = createQueue(bridge, { plannerOverride: crossBoundPlanner });
  const crossBoundResult = await crossBound.plan(planRequest({ request_id: 'bad-binding' }));
  assert.equal(crossBoundResult.code, 'PLANNER_OUTPUT_INVALID');
  assert.equal(crossBound.list('user-a', 10).length, 0);
  assert.equal(bridge.calls.length, 0);
});

test('inactive partial tasks share the bounded history retention limit', async () => {
  const bridge = mockBridge({ failAnalysis: true });
  const queue = createQueue(bridge, { queueOptions: { maxHistory: 2 } });
  for (let index = 0; index < 3; index += 1) {
    const planned = await queue.plan(planRequest({ request_id: `partial-bound-${index}` }));
    const approval = planned.task.plan.approvals;
    assert.equal(queue.confirm(confirmRequest(planned.task.id, planned.task.plan.fingerprint, approval), 'user-a', { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) }).ok, true);
    await queue.whenIdle();
  }
  const records = queue.list('user-a', 10);
  assert.equal(records.length, 2);
  assert.ok(records.every((task) => task.state === 'partial'));
});

// ---------------------------------------------------------------------------
// Queue-level running→terminal continuation contract. The deterministic
// executor returns outcome `running` while the submitted G1 job is still
// queued/running; the gateway must park that task durably nonterminal (never
// succeeded) and converge it only through an explicit authenticated same-task
// continuation that re-runs the bounded deterministic round (the executor
// performs exactly one read-only generation.status there).
// ---------------------------------------------------------------------------

function applyScriptedStepEvidence(task, outcome) {
  if (outcome === 'succeeded') {
    for (const step of task.plan.steps) task.step_states[step.step] = { state: 'succeeded' };
    return;
  }
  if (outcome === 'running') {
    const first = task.plan.steps[0];
    task.step_states[first.step] = { ...(task.step_states[first.step] || {}), state: 'succeeded', observed_round: 1 };
    return;
  }
  const failed = task.plan.steps.find((step) => task.step_states?.[step.step]?.state === 'failed' || task.step_states?.[step.step]?.failed_count > 0) || task.plan.steps[0];
  task.step_states[failed.step] = { ...(task.step_states[failed.step] || {}), state: 'failed', observed_round: 1 };
}

function scriptedQueue({ outcomes, initialTasks = [], onEvent = () => {}, capacity = 10 }) {
  let executions = 0;
  const deterministicRunner = async (_request, _taskId, _signal, _runtime, task) => {
    const outcome = outcomes[Math.min(executions, outcomes.length - 1)];
    executions += 1;
    applyScriptedStepEvidence(task, outcome);
    return { outcome, final_response: `scripted-round-${executions - 1}`, artifact_refs: [] };
  };
  const queue = new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    deterministicRunner,
    planner,
    initialTasks,
    onEvent,
    capacity,
    validateRuntimeContext: (context) => (context?.delegatedAuthorization ? { ok: true } : { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' }),
  });
  return { queue, executions: () => executions };
}

async function parkedTask(outcomes) {
  const { queue, executions } = scriptedQueue({ outcomes });
  const planned = await queue.plan(planRequest({ request_id: `park-${outcomes[0]}` }), { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  const approvals = planned.task.plan.approvals;
  const confirmed = queue.confirm(confirmRequest(planned.task.id, planned.task.plan.fingerprint, approvals), planned.task.request.user_id, { delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });
  assert.equal(confirmed.ok, true);
  await queue.whenIdle();
  return { queue, executions, task: queue.read(planned.task.id, planned.task.request.user_id).task, approvals };
}

const validAuth = () => ({ delegatedAuthorization: 'Bearer ' + 'a'.repeat(40) });

test('deterministic running outcome parks the task durably nonterminal and is never succeeded', async () => {
  const { queue, executions, task } = await parkedTask(['running']);
  assert.equal(task.state, 'running', 'running outcome must remain a durable nonterminal state');
  assert.equal(task.pending_continuation, true, 'the park marker must be durable');
  assert.equal(executions(), 1, 'the bounded deterministic round ran exactly once');
  assert.equal(task.result.final_response, 'scripted-round-0');
  assert.equal(queue.listSummaries(task.request.user_id, 10)[0].state, 'running', 'summaries never report succeeded for a parked task');
});

test('a durably parked running task is cancelled without an active controller', async () => {
  const { queue, task } = await parkedTask(['running']);
  const cancelled = queue.cancel(task.id, task.request.user_id);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task.state, 'cancelled', 'a parked task cancels exactly like a queued task');
  assert.equal(queue.read(task.id, task.request.user_id).task.state, 'cancelled');
});

test('explicit authenticated same-task continuation performs exactly one refresh round and converges', async () => {
  const { queue, executions, task, approvals } = await parkedTask(['running', 'succeeded']);
  const continuation = queue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), task.request.user_id, validAuth());
  assert.equal(continuation.ok, true);
  assert.equal(continuation.continued, true, 'a parked task confirms as a fresh continuation');
  assert.equal(continuation.replayed, false);
  assert.equal(continuation.task.state, 'queued', 'the continuation schedules one bounded refresh round');
  await queue.whenIdle();
  const done = queue.read(task.id, task.request.user_id).task;
  assert.equal(done.state, 'succeeded', 'the continuation converges the task to the real terminal state');
  assert.equal(done.pending_continuation, undefined, 'terminal convergence clears the park marker');
  assert.equal(executions(), 2, 'exactly one refresh round ran');
  const replay = queue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), task.request.user_id, validAuth());
  assert.equal(replay.replayed, true, 'a terminal continuation is an idempotent replay');
  assert.equal(executions(), 2, 'a terminal replay never executes');
});

test('continuation fails closed before execution on wrong identity, fingerprint, approvals or authorization', async () => {
  const { queue, executions, task, approvals } = await parkedTask(['running']);
  const wrongUser = queue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), 'user-b', validAuth());
  assert.equal(wrongUser.code, 'TASK_NOT_FOUND', 'wrong identity fails closed');
  const wrongFingerprint = queue.confirm(confirmRequest(task.id, 'f'.repeat(64), approvals), task.request.user_id, validAuth());
  assert.equal(wrongFingerprint.code, 'PLAN_FINGERPRINT_MISMATCH', 'wrong plan fingerprint fails closed');
  const missingApproval = queue.confirm(
    confirmRequest(task.id, task.plan.fingerprint, { ...approvals, paid_external_calls: false }),
    task.request.user_id,
    validAuth(),
  );
  assert.equal(missingApproval.code, 'CONFIRM_APPROVAL_MISMATCH', 'mismatched approvals fail closed');
  const unauthorized = queue.confirm(confirmRequest(task.id, task.plan.fingerprint, approvals), task.request.user_id, null);
  assert.equal(unauthorized.code, 'DELEGATED_AUTHORIZATION_REQUIRED', 'invalid delegated authorization fails closed');
  assert.equal(executions(), 1, 'every rejected continuation executes zero rounds');
  assert.equal(queue.read(task.id, task.request.user_id).task.state, 'running', 'the task stays parked after rejected continuations');
});

test('concurrent continuations are idempotently merged into exactly one refresh round', async () => {
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let executions = 0;
  const queue = new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    planner,
    deterministicRunner: async (_request, _taskId, _signal, _runtime, task) => {
      executions += 1;
      if (executions === 1) {
        applyScriptedStepEvidence(task, 'running');
        return { outcome: 'running', final_response: 'round-1', artifact_refs: [] };
      }
      markStarted();
      await gate;
      applyScriptedStepEvidence(task, 'succeeded');
      return { outcome: 'succeeded', final_response: 'round-2', artifact_refs: [] };
    },
    validateRuntimeContext: (context) => (context?.delegatedAuthorization ? { ok: true } : { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' }),
  });
  const planned = await queue.plan(planRequest({ request_id: 'continuation-merge' }), validAuth());
  const approvals = planned.task.plan.approvals;
  const confirm = () => queue.confirm(confirmRequest(planned.task.id, planned.task.plan.fingerprint, approvals), planned.task.request.user_id, validAuth());
  confirm();
  await queue.whenIdle();
  assert.equal(queue.read(planned.task.id, planned.task.request.user_id).task.state, 'running');
  const first = confirm();
  assert.equal(first.continued, true);
  const whileQueued = confirm();
  assert.equal(whileQueued.replayed, true, 'a queued continuation round merges concurrent confirms');
  await started;
  const whileRunning = confirm();
  assert.equal(whileRunning.replayed, true, 'an executing continuation round merges concurrent confirms');
  release();
  await queue.whenIdle();
  const done = queue.read(planned.task.id, planned.task.request.user_id).task;
  assert.equal(done.state, 'succeeded');
  assert.equal(executions, 2, 'concurrent continuations produce exactly one refresh round');
  const terminalReplay = confirm();
  assert.equal(terminalReplay.replayed, true);
  assert.equal(executions, 2);
});

test('parked running task survives a gateway restart with its identity and converges after reload', async () => {
  const events = [];
  await parkedTaskWithEvents(['running'], events);
  const snapshot = events.find((event) => event.event === 'running' && event.task?.pending_continuation === true)?.task;
  assert.ok(snapshot, 'the parked snapshot is emitted durably');
  const target = scriptedQueue({ outcomes: ['succeeded'], initialTasks: [snapshot] });
  const recovered = target.queue.read(snapshot.id, snapshot.request.user_id).task;
  assert.equal(recovered.state, 'running', 'the parked task stays nonterminal across the restart');
  assert.equal(recovered.pending_continuation, true, 'the park marker survives the restart');
  assert.equal(recovered.plan.fingerprint, snapshot.plan.fingerprint, 'the plan identity survives the restart');
  const continued = target.queue.confirm(confirmRequest(snapshot.id, snapshot.plan.fingerprint, snapshot.plan.approvals), snapshot.request.user_id, validAuth());
  assert.equal(continued.ok, true);
  assert.equal(continued.continued, true);
  await target.queue.whenIdle();
  assert.equal(target.queue.read(snapshot.id, snapshot.request.user_id).task.state, 'succeeded', 'the reloaded task converges after the continuation');
  assert.equal(target.executions(), 1, 'the reloaded queue executed exactly the one continuation round');
});

test('continuation rejects an expired delegated authorization before any execution', async () => {
  const now = 1786686000000;
  const jwt = (expiresAt) => `Bearer a.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString('base64url')}.signature`;
  let executions = 0;
  const queue = new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    planner,
    deterministicRunner: async (_request, _taskId, _signal, _runtime, task) => {
      executions += 1;
      applyScriptedStepEvidence(task, 'running');
      return { outcome: 'running', final_response: 'parked', artifact_refs: [] };
    },
    validateRuntimeContext: (context) => validateDelegatedAuthorization(context, { now, minimumValidityMs: 750_000 }),
  });
  const planned = await queue.plan(planRequest({ request_id: 'expired-continuation' }), { delegatedAuthorization: jwt(now + 800_000) });
  const approvals = planned.task.plan.approvals;
  queue.confirm(confirmRequest(planned.task.id, planned.task.plan.fingerprint, approvals), planned.task.request.user_id, { delegatedAuthorization: jwt(now + 800_000) });
  await queue.whenIdle();
  assert.equal(queue.read(planned.task.id, planned.task.request.user_id).task.state, 'running');
  const rejected = queue.confirm(confirmRequest(planned.task.id, planned.task.plan.fingerprint, approvals), planned.task.request.user_id, { delegatedAuthorization: jwt(now + 700_000) });
  assert.equal(rejected.code, 'DELEGATED_AUTHORIZATION_EXPIRES_TOO_SOON', 'an expired delegation fails closed before execution');
  assert.equal(executions, 1, 'the expired continuation executed zero refresh rounds');
});

async function parkedTaskWithEvents(outcomes, events) {
  const { queue, executions } = scriptedQueue({ outcomes, onEvent: (event) => events.push(event) });
  const planned = await queue.plan(planRequest({ request_id: 'restart-park' }), validAuth());
  const confirmed = queue.confirm(confirmRequest(planned.task.id, planned.task.plan.fingerprint, planned.task.plan.approvals), planned.task.request.user_id, validAuth());
  assert.equal(confirmed.ok, true);
  await queue.whenIdle();
  return { queue, executions, task: queue.read(planned.task.id, planned.task.request.user_id).task };
}

test('restart fails excess unconfirmed plans closed and keeps retained history bounded', async () => {
  const bridge = mockBridge();
  const source = createQueue(bridge);
  const snapshots = [];
  for (const [requestId, userId] of [['restart-a1', 'user-a'], ['restart-a2', 'user-a'], ['restart-b1', 'user-b']]) {
    snapshots.push((await source.plan(planRequest({ request_id: requestId, user_id: userId }))).task);
  }
  const events = [];
  const restored = new HarnessTaskQueue({
    runner: async () => {},
    deterministicRunner: async () => ({}),
    planner,
    initialTasks: snapshots,
    capacity: 2,
    plannedPerUserCapacity: 1,
    maxHistory: 2,
    onEvent: (event) => events.push(event),
  });
  const records = [...restored.list('user-a', 10), ...restored.list('user-b', 10)];
  assert.equal(records.filter((task) => task.state === 'planned').length, 2, 'one plan per user survives within the global bound');
  const rejected = records.find((task) => task.error?.code === 'PLANNED_TASK_LIMIT_RESTORED');
  assert.ok(rejected, 'excess persisted plan is explicit rather than silently retained or evicted');
  assert.ok(events.some((event) => event.task_id === rejected.id && event.event === 'recovered_failed'));
});
