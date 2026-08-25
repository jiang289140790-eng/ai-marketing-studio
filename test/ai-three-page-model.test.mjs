// 三页任务架构：纯前端读取适配（harness-task-model）确定性单元测试。
// 无网络、无浏览器、无 mock 运行时数据 —— 只验证映射与有界化。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_LABELS,
  buildSourceChain,
  classifyArtifactRef,
  isCapabilityIntent,
  isValidHarnessTaskId,
  normalizeTaskSnapshot,
  requiredApprovals,
  resultHeadline,
  resultSections,
  reviewSummary,
  stateLabel,
  stepExecutionView,
  taskErrorText,
  taskPhase,
  taskSnapshotView,
  technicalDetails,
  toolCallsView,
} from '../src/services/harness-task-model.js';

const TASK_ID = 'ht-00000000-0000-4000-8000-000000000001';

function sampleTask(overrides = {}) {
  return {
    id: TASK_ID,
    state: 'running',
    created_at: '2026-08-23T01:00:00.000Z',
    updated_at: '2026-08-23T01:05:00.000Z',
    request: {
      user_id: 'user-1',
      request_id: 'web-request-1',
      project_id: 'prj-000000000000000000000001',
      intent: '分析表现最好的帖子并保存证据',
    },
    request_fingerprint: 'a'.repeat(64),
    plan: {
      fingerprint: 'b'.repeat(64),
      workflow_title: '研究分析闭环',
      steps: [
        { step: 'st-1', label: '搜索帖子', operation: 'search', depends_on: [], reuse: false, cost: true, write: false },
        { step: 'st-2', label: '保存证据', operation: 'save_evidence', depends_on: ['st-1'], reuse: false, cost: false, write: true },
      ],
      approvals: { paid_external_calls: true, online_writes: true },
      slots: { metric: 'views' },
    },
    plan_fingerprint: 'b'.repeat(64),
    confirmation: { approval: { paid_external_calls: true, online_writes: true, handoff_creation: false } },
    retry_target: null,
    step_states: {
      'st-1': { state: 'succeeded', failed_count: 1, started_at: '2026-08-23T01:02:00.000Z', finished_at: '2026-08-23T01:03:00.000Z', error: null },
      'st-2': { state: 'running', failed_count: 0, started_at: '2026-08-23T01:03:30.000Z', finished_at: null, error: null },
    },
    result: {
      artifact_refs: ['ev-000000000000000000000001', 'kc-000000000000000000000002', 'refs/ev-000000000000000000000003'],
      final_response: '已完成分析。',
      result_data: { top: ['p1'] },
    },
    error: null,
    ...overrides,
  };
}

test('isValidHarnessTaskId 只接受 ht- 前缀的真实任务编号', () => {
  assert.equal(isValidHarnessTaskId('ht-00000000-0000-4000-8000-000000000001'), true);
  assert.equal(isValidHarnessTaskId('ht-00000000-0000-4000-8000-000000000001'.toUpperCase()), false, '大小写必须精确');
  assert.equal(isValidHarnessTaskId('g1j-000000000000000000000001'), false);
  assert.equal(isValidHarnessTaskId('ht-00000000-0000-4000-8000-00000000000'), false);
  assert.equal(isValidHarnessTaskId(''), false);
  assert.equal(isValidHarnessTaskId(null), false);
  assert.equal(isValidHarnessTaskId(123), false);
});

test('normalizeTaskSnapshot：非法输入返回 null（诚实错误态，绝不猜测）', () => {
  assert.equal(normalizeTaskSnapshot(null), null);
  assert.equal(normalizeTaskSnapshot(undefined), null);
  assert.equal(normalizeTaskSnapshot('task'), null);
  assert.equal(normalizeTaskSnapshot([]), null);
  assert.equal(normalizeTaskSnapshot({ id: 'g1j-000000000000000000000001', state: 'running' }), null);
});

test('normalizeTaskSnapshot：未知状态返回 invalid 视图而非猜测', () => {
  const view = normalizeTaskSnapshot({ id: TASK_ID, state: 'mystery' });
  assert.equal(view.invalid, true);
  assert.equal(view.state, 'unknown');
});

test('normalizeTaskSnapshot：真实快照被有界化且字段精确保留', () => {
  const view = normalizeTaskSnapshot(sampleTask());
  assert.equal(view.id, TASK_ID);
  assert.equal(view.state, 'running');
  assert.equal(view.request.intent, '分析表现最好的帖子并保存证据');
  assert.equal(view.request.project_id, 'prj-000000000000000000000001');
  assert.equal(view.plan.workflow_title, '研究分析闭环');
  assert.deepEqual(view.plan.approvals, { paid_external_calls: true, online_writes: true });
  assert.equal(view.plan.steps.length, 2);
  assert.deepEqual(view.step_states['st-1'], {
    state: 'succeeded',
    failed_count: 1,
    started_at: '2026-08-23T01:02:00.000Z',
    finished_at: '2026-08-23T01:03:00.000Z',
    error: null,
    tool_calls: [],
  });
  assert.equal(view.result.artifact_refs.length, 3);
  assert.equal(view.result.final_response, '已完成分析。');
  assert.deepEqual(view.result.result_data, { top: ['p1'] });
});

test('normalizeTaskSnapshot：长字段被有界截断、非法步骤被丢弃', () => {
  const view = normalizeTaskSnapshot({
    id: TASK_ID,
    state: 'planned',
    request: { intent: 'x'.repeat(20_000), project_id: 'y'.repeat(500) },
    plan: { steps: [null, { step: 'st-ok', label: 'ok' }, { step: 'st-long', label: 'l'.repeat(10_000) }] },
    step_states: { 'st-ok': 'not-an-object', 'st-ok2': { state: 'succeeded' } },
  });
  assert.equal(view.request.intent.length, 12_000, 'intent 必须截断到 12000');
  assert.equal(view.request.project_id.length, 80, 'project_id 必须截断到 80');
  assert.equal(view.plan.steps.length, 2, 'null 步骤必须被丢弃');
  assert.equal(view.plan.steps[1].label.length, 160, '步骤标签必须截断到 160');
  assert.deepEqual(Object.keys(view.step_states), ['st-ok2'], '非对象 step_states 必须被跳过');
});

test('stateLabel / taskPhase：状态标签与阶段分类', () => {
  assert.equal(stateLabel('planned'), '等待确认');
  assert.equal(stateLabel('running'), '正在执行');
  assert.equal(stateLabel('failed'), '执行失败');
  assert.equal(stateLabel('mystery'), 'mystery');
  assert.equal(taskPhase({ state: 'planned' }), 'planned');
  assert.equal(taskPhase({ state: 'queued' }), 'active');
  assert.equal(taskPhase({ state: 'running' }), 'active');
  assert.equal(taskPhase({ state: 'partial' }), 'attention');
  assert.equal(taskPhase({ state: 'failed' }), 'attention');
  assert.equal(taskPhase({ state: 'succeeded' }), 'terminal');
  assert.equal(taskPhase({ state: 'cancelled' }), 'terminal');
});

test('classifyArtifactRef：证据/知识卡/Brief/生成产物/其他身份分类', () => {
  assert.deepEqual(classifyArtifactRef('ev-000000000000000000000001'), { kind: 'evidence', id: 'ev-000000000000000000000001', label: '证据' });
  assert.deepEqual(classifyArtifactRef('kc-000000000000000000000002'), { kind: 'knowledge', id: 'kc-000000000000000000000002', label: '知识卡' });
  assert.deepEqual(classifyArtifactRef('card-000000000000000000000003'), { kind: 'knowledge', id: 'card-000000000000000000000003', label: '知识卡' });
  assert.deepEqual(classifyArtifactRef('brf-000000000000000000000004'), { kind: 'brief', id: 'brf-000000000000000000000004', label: 'Brief' });
  assert.deepEqual(classifyArtifactRef('g1x-000000000000000000000005'), { kind: 'generation', id: 'g1x-000000000000000000000005', label: '生成产物' });
  assert.deepEqual(classifyArtifactRef('refs/ev-000000000000000000000006'), { kind: 'evidence', id: 'ev-000000000000000000000006', label: '证据' }, '带路径的引用取最后一段');
  assert.equal(classifyArtifactRef('https://x.com/status/1').kind, 'other');
  assert.equal(classifyArtifactRef('').kind, 'other');
  assert.equal(classifyArtifactRef(null).kind, 'other');
});

test('buildSourceChain：来源链去重、分类并保留项目绑定', () => {
  const task = normalizeTaskSnapshot(sampleTask());
  const chain = buildSourceChain(task);
  assert.equal(chain.project_id, 'prj-000000000000000000000001');
  assert.deepEqual(chain.evidence, ['ev-000000000000000000000001', 'ev-000000000000000000000003']);
  assert.deepEqual(chain.knowledge, ['kc-000000000000000000000002']);
  assert.deepEqual(chain.brief, []);
  assert.deepEqual(chain.generation, []);
  assert.deepEqual(chain.other, []);
  // 重复引用去重。
  const duplicated = normalizeTaskSnapshot(sampleTask({ result: { artifact_refs: ['ev-000000000000000000000001', 'ev-000000000000000000000001'] } }));
  assert.deepEqual(buildSourceChain(duplicated).evidence, ['ev-000000000000000000000001']);
  // 无结果 → 空来源链。
  const empty = buildSourceChain(normalizeTaskSnapshot(sampleTask({ result: null })));
  assert.equal(empty.evidence.length, 0);
  assert.equal(empty.project_id, 'prj-000000000000000000000001');
  assert.deepEqual(buildSourceChain(null), { project_id: null, evidence: [], analysis: [], knowledge: [], brief: [], generation: [], other: [] });
});

test('classifyArtifactRef：an- 分析身份参与分类，来源链包含分析桶', () => {
  assert.deepEqual(classifyArtifactRef('an-000000000000000000000007'), { kind: 'analysis', id: 'an-000000000000000000000007', label: '分析' });
  const task = normalizeTaskSnapshot(sampleTask({ result: { artifact_refs: ['ev-000000000000000000000001', 'an-000000000000000000000007', 'kc-000000000000000000000002'] } }));
  const chain = buildSourceChain(task);
  assert.deepEqual(chain.evidence, ['ev-000000000000000000000001']);
  assert.deepEqual(chain.analysis, ['an-000000000000000000000007']);
  assert.deepEqual(chain.knowledge, ['kc-000000000000000000000002']);
});

test('isCapabilityIntent：只识别“能力：…”只读能力查询', () => {
  assert.equal(isCapabilityIntent('能力：你能干什么'), true);
  assert.equal(isCapabilityIntent('能力：你现在能做哪些事情'), true);
  assert.equal(isCapabilityIntent(' 能力：目前可以完成什么任务？ '), true);
  assert.equal(isCapabilityIntent('分析这个 X 帖子'), false);
  assert.equal(isCapabilityIntent(''), false);
  assert.equal(isCapabilityIntent(null), false);
});

test('toolCallsView：缺失时明确空态，绝不从计划步骤伪造', () => {
  const task = normalizeTaskSnapshot(sampleTask());
  assert.deepEqual(toolCallsView(task), { present: false, calls: [] });
  assert.deepEqual(toolCallsView(null), { present: false, calls: [] });
  // 任务级真实 tool_calls 记录。
  const withTaskCalls = normalizeTaskSnapshot(sampleTask({
    tool_calls: [
      { tool: 'search', operation: 'web_search', status: 'succeeded', started_at: '2026-08-23T01:02:00.000Z', finished_at: '2026-08-23T01:02:30.000Z', error: null },
      { tool: 'save', operation: 'save_evidence', status: 'failed', error: { code: 'TOOL_FAILED', message: '保存失败' } },
    ],
  }));
  const taskView = toolCallsView(withTaskCalls);
  assert.equal(taskView.present, true);
  assert.equal(taskView.calls.length, 2);
  assert.equal(taskView.calls[0].tool, 'search');
  assert.equal(taskView.calls[0].status, 'succeeded');
  assert.equal(taskView.calls[1].error.code, 'TOOL_FAILED');
  // 逐步级真实 tool_calls 记录（带步骤归属）。
  const withStepCalls = normalizeTaskSnapshot(sampleTask({
    step_states: {
      'st-1': { state: 'succeeded', tool_calls: [{ tool: 'search', status: 'succeeded' }] },
      'st-2': { state: 'running' },
    },
  }));
  const stepView = toolCallsView(withStepCalls);
  assert.equal(stepView.present, true);
  assert.equal(stepView.calls[0].step, 'st-1');
  // 非对象记录被丢弃；有界。
  const messy = normalizeTaskSnapshot(sampleTask({ tool_calls: [null, 'junk', { tool: 'x' }] }));
  assert.equal(toolCallsView(messy).calls.length, 1);
});

test('resultSections：五分类全部来自真实 snapshot，缺失逐类空态', () => {
  const task = normalizeTaskSnapshot(sampleTask({
    result: {
      artifact_refs: ['ev-000000000000000000000001', 'an-000000000000000000000007', 'kc-000000000000000000000002', 'brf-000000000000000000000004', 'g1x-000000000000000000000005', 'refs/ev-000000000000000000000006'],
      final_response: 'ok',
      result_data: {
        analyses: [{ id: 'an-000000000000000000000008', summary: '多模态分析' }, { id: 'an-000000000000000000000009' }],
        artifacts: [{ id: 'g1x-00000000000000000000000a', name: '主视觉' }],
        artifact: { id: 'g1x-00000000000000000000000b', name: '封面' },
      },
    },
  }));
  const sections = resultSections(task);
  assert.equal(sections.evidence.present, true);
  assert.deepEqual(sections.evidence.items.map((item) => item.id), ['ev-000000000000000000000001', 'ev-000000000000000000000006']);
  assert.equal(sections.analysis.present, true);
  assert.equal(sections.analysis.items.length, 3, 'an- 引用 + result_data.analyses 行');
  assert.equal(sections.knowledge.present, true);
  assert.equal(sections.knowledge.items[0].id, 'kc-000000000000000000000002');
  assert.equal(sections.brief.present, true);
  assert.equal(sections.brief.items[0].id, 'brf-000000000000000000000004');
  assert.equal(sections.artifact.present, true);
  assert.equal(sections.artifact.items.length, 3, 'g1x- 引用 + artifacts 数组 + artifact 对象');
  // 无任何结果 → 五类全部缺失（逐类空态）。
  const empty = resultSections(normalizeTaskSnapshot(sampleTask({ result: null })));
  for (const key of ['evidence', 'analysis', 'knowledge', 'brief', 'artifact']) {
    assert.equal(empty[key].present, false, `${key} 必须为空态`);
    assert.deepEqual(empty[key].items, []);
  }
  assert.equal(resultSections(null).evidence.present, false);
});

test('resultHeadline：由同一 snapshot 派生，绝不存在静态 completed 覆盖 running', () => {
  const running = normalizeTaskSnapshot(sampleTask({ state: 'running', result: null }));
  assert.equal(resultHeadline(running), '任务尚未产生结果');
  const planned = normalizeTaskSnapshot(sampleTask({ state: 'planned', result: null }));
  assert.equal(resultHeadline(planned), '任务尚未产生结果');
  const succeededEmpty = normalizeTaskSnapshot(sampleTask({ state: 'succeeded', result: null }));
  assert.equal(resultHeadline(succeededEmpty), '任务已完成', '终态且无成果 → 任务已完成（由状态派生，非静态覆盖）');
  const failed = normalizeTaskSnapshot(sampleTask({ state: 'failed', result: null }));
  assert.equal(resultHeadline(failed), '任务未产生成果');
  const succeededWithEvidence = normalizeTaskSnapshot(sampleTask({ state: 'succeeded', result: { artifact_refs: ['ev-000000000000000000000001'] } }));
  assert.equal(resultHeadline(succeededWithEvidence), '1 条内容已保存为证据');
  assert.equal(resultHeadline(null), '任务尚未产生结果');
});

test('technicalDetails：task_id/project_id/指纹/内部状态/审批字段齐备', () => {
  const task = normalizeTaskSnapshot(sampleTask());
  const technical = technicalDetails(task);
  assert.equal(technical.task_id, TASK_ID);
  assert.equal(technical.project_id, 'prj-000000000000000000000001');
  assert.equal(technical.plan_fingerprint, 'b'.repeat(64));
  assert.equal(technical.request_fingerprint, 'a'.repeat(64));
  assert.equal(technical.state, 'running');
  assert.equal(technical.updated_at, '2026-08-23T01:05:00.000Z');
  assert.deepEqual(technical.confirmation_approvals, { paid_external_calls: true, online_writes: true });
  assert.deepEqual(technical.required_approvals, { paid_external_calls: true, online_writes: true });
  assert.deepEqual(technicalDetails(null), {
    task_id: '', project_id: '', request_id: '', request_fingerprint: '', plan_fingerprint: '',
    state: '', created_at: '', updated_at: '', retry_target: '', confirmation_approvals: {}, required_approvals: {},
  });
});

test('taskSnapshotView：单一快照派生所有页面可见信息（同一状态映射）', () => {
  const task = normalizeTaskSnapshot(sampleTask({
    state: 'failed',
    error: { code: 'HARNESS_FAILED', message: '任务执行失败：st-2 工具失败。', category: 'tool', stage: 'run', operation: 'save_evidence' },
    step_states: { 'st-2': { state: 'failed', failed_count: 1, error: { code: 'TOOL_FAILED', message: '工具失败', retry_unsafe: false } } },
  }));
  const view = taskSnapshotView(task);
  assert.equal(view.stateLabel, '执行失败');
  assert.equal(view.phase, 'attention');
  assert.equal(view.intent, '分析表现最好的帖子并保存证据');
  assert.equal(view.projectId, 'prj-000000000000000000000001');
  assert.equal(view.workflowTitle, '研究分析闭环');
  assert.equal(view.steps.length, 2);
  assert.equal(view.toolCalls.present, false);
  assert.deepEqual(view.approvals, { paid_external_calls: true, online_writes: true });
  assert.equal(view.errorText.length > 0, true);
  assert.equal(view.headline, '2 条内容已保存为证据', '失败前已保存的证据仍诚实展示（同一派生）');
  assert.equal(view.technical.task_id, TASK_ID);
  assert.equal(view.sections.evidence.present, true, 'result 中的证据身份仍保留');
  assert.equal(taskSnapshotView(null), null);
});

test('reviewSummary：审核状态来自真实快照（计划确认范围 + 当前状态）', () => {
  const planned = reviewSummary(normalizeTaskSnapshot(sampleTask({ state: 'planned', confirmation: null, step_states: {} })));
  assert.equal(planned.state, 'planned');
  assert.equal(planned.label, '等待确认');
  assert.equal(planned.phase, 'planned');
  assert.deepEqual(planned.requiredApprovals, { paid_external_calls: true, online_writes: true });
  assert.deepEqual(planned.approvals, {});
  assert.equal(planned.plan_fingerprint, 'b'.repeat(64));

  const confirmed = reviewSummary(normalizeTaskSnapshot(sampleTask()));
  assert.deepEqual(confirmed.approvals, { paid_external_calls: true, online_writes: true });
  assert.equal(confirmed.workflow_title, '研究分析闭环');
});

test('stepExecutionView：步骤顺序、尝试次数（failed_count）与可重试性', () => {
  const task = normalizeTaskSnapshot(sampleTask({
    state: 'failed',
    step_states: {
      'st-1': { state: 'succeeded', failed_count: 1, started_at: '2026-08-23T01:02:00.000Z', finished_at: '2026-08-23T01:03:00.000Z', error: null },
      'st-2': { state: 'failed', failed_count: 2, started_at: '2026-08-23T01:03:30.000Z', finished_at: '2026-08-23T01:04:00.000Z', error: { code: 'TOOL_FAILED', message: '工具失败', retry_unsafe: false } },
    },
  }));
  const steps = stepExecutionView(task);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].step, 'st-1');
  assert.equal(steps[0].attempts, 1);
  assert.equal(steps[0].retryable, false);
  assert.equal(steps[1].attempts, 2);
  assert.equal(steps[1].retryable, true);
  assert.equal(steps[1].error.code, 'TOOL_FAILED');
  // 付费步骤失败 → retry_unsafe → 不可重试。
  const unsafe = normalizeTaskSnapshot(sampleTask({
    state: 'failed',
    step_states: { 'st-2': { state: 'failed', failed_count: 1, error: { code: 'COST', retry_unsafe: true } } },
  }));
  assert.equal(stepExecutionView(unsafe)[1].retryable, false);
  // 无计划 → 空视图。
  assert.deepEqual(stepExecutionView(normalizeTaskSnapshot(sampleTask({ plan: null }))), []);
});

test('H5 模型诊断：刷新恢复保留有界结构、首次失败为 1 次且敏感字段被丢弃', () => {
  const raw = sampleTask({
    state: 'failed',
    step_states: {
      'st-2': {
        state: 'failed',
        failed_count: 1,
        error: {
          code: 'MODEL_RESPONSE_INVALID',
          message: 'The multimodal model response did not match the reviewed response contract.',
          field: 'output.choices[0].message.content',
          reason: 'JSON_INVALID',
          response_shape: {
            root_type: 'object',
            known_root_keys: ['output', 'usage', 'private_user_field'],
            compatible_choice_count: null,
            native_choice_count: 1,
            content_type: 'string',
            content_length: 9528,
            content_part_count: null,
            content_parts: [],
            json_root_type: null,
            private_model_body: 'PRIVATE_ATTACHMENT_BODY_MUST_NOT_ESCAPE',
            analysis_rows: [{
              row_type: 'object',
              keys: ['source_id', 'PRIVATE_USER_VALUE_MUST_NOT_ESCAPE'],
              field_types: { source_id: 'string', PRIVATE_USER_VALUE_MUST_NOT_ESCAPE: 'string' },
              media_count: 0,
              media_rows: [],
            }],
          },
          raw_response: 'PRIVATE_ATTACHMENT_BODY_MUST_NOT_ESCAPE',
          authorization: 'Bearer PRIVATE_TOKEN_MUST_NOT_ESCAPE',
          retry_unsafe: false,
        },
      },
    },
  });
  const restored = normalizeTaskSnapshot(JSON.parse(JSON.stringify(raw)));
  const step = stepExecutionView(restored)[1];
  assert.equal(step.attempts, 1);
  assert.equal(step.error.field, 'output.choices[0].message.content');
  assert.equal(step.error.reason, 'JSON_INVALID');
  assert.deepEqual(step.error.response_shape.known_root_keys, ['output', 'usage']);
  assert.equal(step.error.response_shape.native_choice_count, 1);
  const serialized = JSON.stringify(restored);
  assert.equal(serialized.includes('PRIVATE_ATTACHMENT_BODY_MUST_NOT_ESCAPE'), false);
  assert.equal(serialized.includes('PRIVATE_TOKEN_MUST_NOT_ESCAPE'), false);
  assert.equal(serialized.includes('PRIVATE_USER_VALUE_MUST_NOT_ESCAPE'), false);
  assert.equal(Object.hasOwn(step.error.response_shape, 'private_model_body'), false);
  assert.deepEqual(step.error.response_shape.analysis_rows[0].keys, ['source_id', '<unrecognized-key>']);
});

test('taskErrorText：有界错误文本且绝不回显原始载荷', () => {
  const task = normalizeTaskSnapshot(sampleTask({
    error: { code: 'TOOL_FAILED', message: 'm'.repeat(500), operation: 'search', category: 'tool', stage: 'run' },
  }));
  const text = taskErrorText(task);
  assert.match(text, /search/);
  assert.match(text, /TOOL_FAILED/);
  assert.ok(text.length <= 400, '错误文本必须有界');
  assert.equal(taskErrorText(normalizeTaskSnapshot(sampleTask({ error: null }))), '');
});

test('requiredApprovals：授权范围来自权威计划，绝不缺省放大', () => {
  const task = normalizeTaskSnapshot(sampleTask());
  assert.deepEqual(requiredApprovals(task), { paid_external_calls: true, online_writes: true });
  assert.deepEqual(requiredApprovals(normalizeTaskSnapshot(sampleTask({ plan: null }))), {});
  assert.equal(APPROVAL_LABELS.paid_external_calls, '付费采集或模型分析');
});
