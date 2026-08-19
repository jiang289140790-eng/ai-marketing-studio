// G1 验收 #6：Harness 确定性生成工具。
//
// 覆盖：计划批准标记（quote 只读零批准；submit 同时需要 paid_external_calls
// + online_writes）、无批准/不提交、精确批准绑定（submit 载荷必须来自 quote
// 步骤结果）、状态/产物只读绝不继承 submit 批准、失败阻断依赖步骤、同一幂等
// 键重放不产生第二个付费作业。

import test from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_SCHEMA_VERSION, HarnessTaskQueue, validateConfirmRequest } from '../services/harness-gateway/gateway-core.mjs';
import { buildPlan, classifyIntent, createPlanner } from '../services/harness-gateway/planner.mjs';
import { createBridgeStateReader, deriveCanonicalBriefId, executeConfirmedPlan, STEP_STATE_FAILED } from '../services/harness-gateway/deterministic-executor.mjs';
import { G1_COMMAND_SCHEMA_VERSION, toBoundaryRequest, validateToolCall } from '../services/harness-gateway/tool-contract.mjs';

const TASK_ID = 'ht-22222222-2222-4222-8222-222222222222';
const USER_ID = 'user-g1';
const PROJECT_ID = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
const BRIEF_ID = 'brief-111111111111111111111111';

function request(intent, overrides = {}) {
  return {
    user_id: USER_ID,
    project_id: PROJECT_ID,
    intent,
    request_fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

function buildGeneratePlan(slots = {}) {
  return buildPlan({
    taskId: TASK_ID,
    request: request('生成图片'),
    workflowId: 'generate_media',
    slots: {
      brief_id: BRIEF_ID,
      mode: 'image',
      prompt: '一只在森林里的猫',
      ...slots,
    },
  });
}

test('生成计划精确标记付费调用与 staging 写入；quote-only 零费用零写入', () => {
  const plan = buildGeneratePlan();
  assert.equal(plan.ok, true, plan.code);
  assert.deepEqual(plan.value.steps.map((step) => step.operation), [
    'workspace.project.read',
    'generation.quote',
    'generation.submit',
  ]);
  assert.equal(plan.value.steps[1].cost, false, 'quote 步骤必须零费用');
  assert.equal(plan.value.steps[1].write, false, 'quote 步骤必须零写入');
  assert.equal(plan.value.steps[2].cost, true, 'submit 步骤必须标记付费');
  assert.equal(plan.value.steps[2].write, true, 'submit 步骤必须标记 staging 写入');
  assert.equal(plan.value.approvals.paid_external_calls, true, 'submit 需要付费批准');
  assert.equal(plan.value.approvals.online_writes, true, 'submit 需要写入批准');
  assert.equal(plan.value.approvals.handoff_creation, false);
  assert.equal(plan.value.cost_indicators.paid_calls, 1, '恰好 1 次付费调用');
  assert.equal(plan.value.cost_indicators.online_writes, 1, '恰好 1 次 staging 写入');

  const quoteOnly = buildGeneratePlan({ submit_generation: false });
  assert.equal(quoteOnly.ok, true, quoteOnly.code);
  assert.deepEqual(quoteOnly.value.steps.map((step) => step.operation), [
    'workspace.project.read',
    'generation.quote',
  ]);
  assert.equal(quoteOnly.value.approvals.paid_external_calls, false, 'quote-only 不得要求付费批准');
  assert.equal(quoteOnly.value.approvals.online_writes, false, 'quote-only 不得要求写入批准');
  assert.equal(quoteOnly.value.cost_indicators.paid_calls, 0);
  assert.equal(quoteOnly.value.cost_indicators.online_writes, 0);
});

test('无批准/不提交：确认缺少任一批准范围即 fail closed', () => {
  const plan = buildGeneratePlan().value;
  const base = {
    schema_version: 'ams_harness_gateway_v1',
    task_id: TASK_ID,
    plan_fingerprint: plan.fingerprint,
  };
  assert.equal(validateConfirmRequest({ ...base, approval: { paid_external_calls: true, online_writes: true, handoff_creation: false } }, plan).ok, true);
  assert.equal(
    validateConfirmRequest({ ...base, approval: { paid_external_calls: false, online_writes: true, handoff_creation: false } }, plan).code,
    'CONFIRM_APPROVAL_MISMATCH',
    '缺少付费批准必须拒绝',
  );
  assert.equal(
    validateConfirmRequest({ ...base, approval: { paid_external_calls: true, online_writes: false, handoff_creation: false } }, plan).code,
    'CONFIRM_APPROVAL_MISMATCH',
    '缺少写入批准必须拒绝',
  );
  assert.equal(
    validateConfirmRequest({ ...base, approval: { paid_external_calls: true, online_writes: true, handoff_creation: true } }, plan).code,
    'CONFIRM_APPROVAL_MISMATCH',
    '多余批准范围同样拒绝（精确绑定）',
  );
  const quoteOnly = buildGeneratePlan({ submit_generation: false }).value;
  assert.equal(
    validateConfirmRequest({ ...base, plan_fingerprint: quoteOnly.fingerprint, approval: { paid_external_calls: true, online_writes: false, handoff_creation: false } }, quoteOnly).code,
    'CONFIRM_APPROVAL_MISMATCH',
    'quote-only 计划不得携带付费批准',
  );
});

test('执行器：无确认批准时提交步骤绝不执行（零工具调用）', async () => {
  const plan = buildGeneratePlan().value;
  const calls = [];
  const taskView = {
    id: TASK_ID,
    confirmation: { approval: { paid_external_calls: false, online_writes: true, handoff_creation: false } },
    step_states: {},
    plan,
  };
  const toolClient = async (call) => { calls.push(call); return { ok: true, data: {} }; };
  const stateReader = async () => ({ ok: true, project: { id: PROJECT_ID, version: 1 }, revision: 1 });
  await assert.rejects(
    executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient, stateReader, now: () => '2026-08-16T00:00:00.000Z' }),
    (error) => error?.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(calls.length, 0, '缺少批准时不得发起任何工具调用');
});

test('执行器：quote → submit 精确批准绑定；幂等重放不产生第二个付费作业', async () => {
  const plan = buildGeneratePlan().value;
  const issuedQuotes = new Map();
  const createdJobs = new Map();
  let quoteCalls = 0;
  let submitCalls = 0;
  let statusCalls = 0;

  const toolClient = async (call, trustedContext) => {
    const checked = validateToolCall(call, trustedContext);
    assert.equal(checked.ok, true, `工具调用必须通过校验：${checked.code}`);
    if (call.operation.startsWith('generation.')) {
      const boundary = toBoundaryRequest(checked.value);
      assert.equal(boundary.body.schema_version, G1_COMMAND_SCHEMA_VERSION, `${call.operation} 边界请求必须携带精确 G1 命令版本`);
      assert.equal(boundary.body.schema_version, 'g1_generation_command_v1');
    }
    if (call.operation === 'workspace.project.read') {
      return {
        ok: true,
        data: {
          project: {
            id: PROJECT_ID,
            version: 1,
            brief: {
              id: BRIEF_ID,
              version: 1,
              status: 'pending_review',
              fingerprint: 'b'.repeat(64),
              knowledge_citation_ids: ['kc-111111111111111111111111'],
              evidence_provenance: { evidence_ids: ['ev-111111111111111111111111'] },
            },
          },
        },
      };
    }
    if (call.operation === 'generation.quote') {
      quoteCalls += 1;
      const quote = {
        schema_version: 'g1_quote_v1',
        quote_id: `g1q-${'a'.repeat(24)}`,
        quote_fingerprint: 'f'.repeat(64),
        request_sha256: 'r'.repeat(64),
        price_cny_min: 0.02,
        price_cny_max: 0.3,
        estimated_max_cost_cny: 0.3,
        expires_at: '2026-08-16T00:30:00.000Z',
        mode: call.payload.mode,
        model_name: 'qwen-image-2.0',
        will_pay: true,
        will_write: true,
        will_use_storage: true,
        will_execute: true,
      };
      issuedQuotes.set(quote.quote_id, quote);
      return { ok: true, data: { quote }, entity: { type: 'quote', id: quote.quote_id }, artifact_refs: [quote.quote_id] };
    }
    if (call.operation === 'generation.submit') {
      submitCalls += 1;
      const quote = issuedQuotes.get(call.payload.quote_id);
      assert.ok(quote, 'submit 载荷必须引用 quote 步骤产出的 quote_id');
      assert.equal(call.payload.quote_fingerprint, quote.quote_fingerprint, 'submit 必须绑定精确 quote 指纹');
      assert.equal(call.payload.estimated_max_cost_cny, quote.estimated_max_cost_cny, 'submit 必须绑定预估最大费用');
      assert.equal(call.expected_revision, 1, 'submit 必须携带可信项目修订号');
      assert.equal(call.payload.expected_revision, undefined, 'expected_revision 是信封字段，绝不进入 payload（边界转换时重新嵌入）');
      assert.equal(call.payload.mode, 'image');
      assert.equal(call.payload.prompt, '一只在森林里的猫');
      const key = call.idempotency_key;
      if (!createdJobs.has(key)) {
        // 本用例聚焦批准绑定与幂等重放：提交返回的作业已终态完成
        // （异步排队→运行→完成的契约由专门的异步状态用例覆盖）。
        createdJobs.set(key, { id: `g1j-${'b'.repeat(24)}`, status: 'completed', key });
      }
      const job = createdJobs.get(key);
      return { ok: true, data: { job }, entity: { type: 'generation_job', id: job.id }, artifact_refs: [job.id] };
    }
    if (call.operation === 'generation.status') {
      statusCalls += 1;
      return { ok: true, data: { job: createdJobs.values().next().value } };
    }
    return { ok: false, code: 'OPERATION_DENIED', diagnostics: { issues: [] } };
  };
  const stateReader = async () => ({ ok: true, project: { id: PROJECT_ID, version: 1 }, revision: 1 });
  const makeView = () => ({
    id: TASK_ID,
    confirmation: { approval: { paid_external_calls: true, online_writes: true, handoff_creation: false } },
    step_states: {},
    plan,
  });
  const now = () => '2026-08-16T00:00:00.000Z';

  // 第一次执行：作业已终态完成 → 外层成功，且无需状态读取。
  const first = await executeConfirmedPlan({
    taskView: makeView(), plan, signal: null, emit: () => {}, toolClient, stateReader, now,
  });
  assert.equal(first.outcome, 'succeeded');
  assert.equal(quoteCalls, 1);
  assert.equal(submitCalls, 1);
  assert.equal(statusCalls, 0, '提交已终态完成的作业绝不发起状态读取');
  assert.deepEqual(
    first.artifact_refs,
    [`g1q-${'a'.repeat(24)}`, `g1j-${'b'.repeat(24)}`],
    'quote 与作业身份必须作为有界产物引用返回',
  );
  assert.match(first.final_response, /生成媒体|生成图片|素材/, '最终响应必须包含生成工作流标签');

  // 第二次执行（同一计划/同一幂等键派生）：边界重放同一作业 → 绝不重复付费。
  const second = await executeConfirmedPlan({
    taskView: makeView(), plan, signal: null, emit: () => {}, toolClient, stateReader, now,
  });
  assert.equal(second.outcome, 'succeeded');
  assert.equal(createdJobs.size, 1, '同一幂等键必须重放同一作业，绝不创建第二个付费作业');
  assert.equal(submitCalls, 2, 'submit 调用发生两次但第二次是幂等重放');
  assert.equal(quoteCalls, 2, 'quote 是只读且幂等（同请求复用同 quote）');
});

test('执行器：quote 失败阻断 submit（失败停止依赖步骤，零重复调用）', async () => {
  const plan = buildGeneratePlan().value;
  const calls = [];
  const toolClient = async (call) => {
    calls.push(call.operation);
    if (call.operation === 'workspace.project.read') {
      return { ok: true, data: { project: { id: PROJECT_ID, version: 1 } } };
    }
    if (call.operation === 'generation.quote') {
      return { ok: false, code: 'G1_BRIEF_NOT_FOUND', diagnostics: { issues: ['Brief 不存在。'] } };
    }
    return { ok: true, data: {} };
  };
  // 与生产接线一致：read_state 经由 createBridgeStateReader 走同一工具客户端，
  // 使 calls 能精确观测并断言 workspace.project.read → generation.quote 顺序。
  const stateReader = createBridgeStateReader(toolClient);
  const taskView = {
    id: TASK_ID,
    confirmation: { approval: { paid_external_calls: true, online_writes: true, handoff_creation: false } },
    step_states: {},
    plan,
  };
  const outcome = await executeConfirmedPlan({
    taskView, plan, signal: null, emit: () => {}, toolClient, stateReader, now: () => '2026-08-16T00:00:00.000Z',
  });
  assert.equal(outcome.outcome, 'failed', 'quote 失败时外层任务状态必须恰好是 failed');
  assert.equal(taskView.step_states['st-1'].state, STEP_STATE_FAILED);
  assert.equal(taskView.step_states['st-1'].error.code, 'G1_BRIEF_NOT_FOUND', 'quote 失败必须保留精确错误码');
  assert.equal(taskView.step_states['st-1'].error.retry_unsafe, false, 'quote 只读零费用，失败绝不被标记为付费歧义');
  assert.equal(taskView.step_states['st-2'].state, 'blocked', 'submit 必须被依赖失败阻断');
  assert.deepEqual(calls, ['workspace.project.read', 'generation.quote'], '精确顺序：项目读取先于报价；绝不允许 submit 被调用');
});

test('只读状态/产物读取：零批准、零费用、零写入，绝不继承 submit 批准', () => {
  const statusPlan = buildPlan({
    taskId: TASK_ID,
    request: request('查看生成任务状态'),
    workflowId: 'read_generation',
    slots: { job_id: `g1j-${'c'.repeat(24)}` },
  });
  assert.equal(statusPlan.ok, true, statusPlan.code);
  assert.deepEqual(statusPlan.value.steps.map((step) => step.operation), ['generation.status']);
  assert.equal(statusPlan.value.approvals.paid_external_calls, false);
  assert.equal(statusPlan.value.approvals.online_writes, false);
  assert.equal(statusPlan.value.cost_indicators.paid_calls, 0);
  assert.equal(statusPlan.value.cost_indicators.online_writes, 0);
  for (const step of statusPlan.value.steps) {
    assert.equal(step.cost, false);
    assert.equal(step.write, false);
  }
  const artifactPlan = buildPlan({
    taskId: TASK_ID,
    request: request('查看生成产物'),
    workflowId: 'read_generation',
    slots: { job_id: `g1j-${'c'.repeat(24)}`, artifact_id: `g1x-${'c'.repeat(24)}` },
  });
  assert.equal(artifactPlan.ok, true, artifactPlan.code);
  assert.deepEqual(artifactPlan.value.steps.map((step) => step.operation), ['generation.status', 'generation.artifact']);
  assert.equal(artifactPlan.value.approvals.paid_external_calls, false, '产物读取绝不继承 submit 批准');
  const unbound = buildPlan({ taskId: TASK_ID, request: request('x', { project_id: null }), workflowId: 'read_generation', slots: { job_id: `g1j-${'c'.repeat(24)}` } });
  assert.equal(unbound.code, 'PROJECT_BINDING_REQUIRED', '读取也必须绑定精确项目');
});

test('分类器：生成/读取/报价意图的确定性映射与 fail closed', () => {
  const image = classifyIntent(`用 brief-${'a'.repeat(24)} 生成图片，提示词：「一只在森林里的猫」，16:9`);
  assert.equal(image.ok, true);
  assert.equal(image.value.workflow, 'generate_media');
  assert.equal(image.value.slots.mode, 'image');
  assert.equal(image.value.slots.brief_id, `brief-${'a'.repeat(24)}`);
  assert.equal(image.value.slots.prompt, '一只在森林里的猫');
  assert.equal(image.value.slots.aspect_ratio, '16:9');
  assert.equal(image.value.slots.submit_generation, true);

  const video = classifyIntent(`用 brief-${'a'.repeat(24)} 生成视频，提示词：「海边日落」，5 秒，1080p`);
  assert.equal(video.ok, true);
  assert.equal(video.value.workflow, 'generate_media');
  assert.equal(video.value.slots.mode, 'video_t2v');
  assert.equal(video.value.slots.duration_seconds, 5);
  assert.equal(video.value.slots.resolution, '1080p');

  const i2v = classifyIntent(`用 brief-${'a'.repeat(24)} 图生视频，提示词：「参考图动画」，引用素材 ${'d'.repeat(8)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(12)}`);
  assert.equal(i2v.ok, true);
  assert.equal(i2v.value.slots.mode, 'video_i2v');
  assert.equal(i2v.value.slots.reference_asset_id, `${'d'.repeat(8)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(12)}`);

  const quoteOnly = classifyIntent(`用 brief-${'a'.repeat(24)} 生成图片，提示词：「猫」，只要报价`);
  assert.equal(quoteOnly.ok, true);
  assert.equal(quoteOnly.value.slots.submit_generation, false, '只要报价绝不提交');

  const read = classifyIntent(`查看生成任务状态 g1j-${'e'.repeat(24)}`);
  assert.equal(read.ok, true);
  assert.equal(read.value.workflow, 'read_generation');
  assert.equal(read.value.slots.job_id, `g1j-${'e'.repeat(24)}`);

  const readArtifact = classifyIntent(`打开生成产物 g1j-${'e'.repeat(24)} 的 g1x-${'f'.repeat(24)}`);
  assert.equal(readArtifact.ok, true);
  assert.equal(readArtifact.value.workflow, 'read_generation');
  assert.equal(readArtifact.value.slots.artifact_id, `g1x-${'f'.repeat(24)}`);

  const missingMode = classifyIntent(`用 brief-${'a'.repeat(24)} 生成素材，提示词：「猫」`);
  assert.equal(missingMode.ok, true);
  assert.equal(missingMode.value.slots.mode, null, '无图片/视频词的素材意图不得发明 mode');
  const plan = buildPlan({ taskId: TASK_ID, request: request('生成素材'), workflowId: 'generate_media', slots: missingMode.value.slots });
  assert.equal(plan.code, 'PLAN_SLOT_REQUIRED', '缺 mode 必须 fail closed');

  const noPrompt = classifyIntent(`用 brief-${'a'.repeat(24)} 生成图片`);
  assert.equal(noPrompt.ok, true);
  assert.equal(noPrompt.value.slots.prompt, null, '无提示词不得从噪音中发明 prompt');
  const plan2 = buildPlan({ taskId: TASK_ID, request: request('生成图片'), workflowId: 'generate_media', slots: noPrompt.value.slots });
  assert.equal(plan2.code, 'PLAN_SLOT_REQUIRED', '缺 prompt 必须 fail closed');

  const readNoJob = classifyIntent('查看生成任务状态');
  assert.equal(readNoJob.ok, true);
  const plan3 = buildPlan({ taskId: TASK_ID, request: request('查看生成任务状态'), workflowId: 'read_generation', slots: readNoJob.value.slots });
  assert.equal(plan3.code, 'PLAN_SLOT_REQUIRED', '状态读取缺作业身份必须 fail closed');
});

test('分类器：中文 i2v 意图（参考图片/用这张图）确定性分类 video_i2v，精确绑定提示词与素材；缺素材 fail closed', () => {
  const asset = `${'e'.repeat(8)}-${'e'.repeat(4)}-${'e'.repeat(4)}-${'e'.repeat(4)}-${'e'.repeat(12)}`;

  const viaReference = classifyIntent(`参考图片生成视频，提示词：「猫咪散步」，引用素材 ${asset}`);
  assert.equal(viaReference.ok, true, viaReference.code);
  assert.equal(viaReference.value.workflow, 'generate_media');
  assert.equal(viaReference.value.slots.mode, 'video_i2v', '参考图片生成视频必须确定性分类为 video_i2v');
  assert.equal(viaReference.value.slots.prompt, '猫咪散步', '必须精确提取成对中文引号内的提示词');
  assert.equal(viaReference.value.slots.reference_asset_id, asset, '必须绑定精确引用素材身份');

  const viaThisImage = classifyIntent(`用这张图生成视频，提示词：“猫咪散步”，引用素材 ${asset}`);
  assert.equal(viaThisImage.ok, true, viaThisImage.code);
  assert.equal(viaThisImage.value.slots.mode, 'video_i2v', '用这张图生成视频必须分类为 video_i2v，绝不降级为文生视频');
  assert.equal(viaThisImage.value.slots.prompt, '猫咪散步');
  assert.equal(viaThisImage.value.slots.reference_asset_id, asset);

  const asciiQuotes = classifyIntent(`用这张图生成视频，提示词："猫咪散步"，引用素材 ${asset}`);
  assert.equal(asciiQuotes.value.slots.prompt, '猫咪散步', '成对 ASCII 引号内提示词同样精确提取');

  const labeled = classifyIntent(`用这张图生成视频，提示词：猫咪散步，引用素材 ${asset}`);
  assert.equal(labeled.value.slots.prompt, '猫咪散步', '提示词标签后的文本精确提取（成对引号归一）');

  // 缺引用素材身份：分类绝不降级为 t2v、绝不发明素材；计划构建必须 fail closed。
  const missing = classifyIntent(`用这张图生成视频，提示词：「猫咪散步」`);
  assert.equal(missing.ok, true, missing.code);
  assert.equal(missing.value.slots.mode, 'video_i2v', '缺素材时仍保持 video_i2v 分类，绝不降级');
  assert.equal(missing.value.slots.reference_asset_id, undefined, '绝不发明素材身份');
  const missingPlan = buildPlan({
    taskId: TASK_ID,
    request: request('用这张图生成视频'),
    workflowId: 'generate_media',
    slots: missing.value.slots,
  });
  assert.equal(missingPlan.code, 'PLAN_SLOT_REQUIRED', 'i2v 缺引用素材必须 fail closed');
  assert.equal(missingPlan.diagnostics?.field, 'reference_asset_id');

  const missingViaReference = classifyIntent(`参考图片生成视频，提示词：「猫咪散步」`);
  assert.equal(missingViaReference.value.slots.mode, 'video_i2v', '参考图片缺素材同样绝不降级为 t2v');
  assert.equal(missingViaReference.value.slots.reference_asset_id, undefined, '参考图片缺素材绝不发明素材身份');
  const missingPlan2 = buildPlan({
    taskId: TASK_ID,
    request: request('参考图片生成视频'),
    workflowId: 'generate_media',
    slots: missingViaReference.value.slots,
  });
  assert.equal(missingPlan2.code, 'PLAN_SLOT_REQUIRED', '参考图片缺引用素材同样 fail closed');
});

test('工具契约：generation 操作必须经过完整校验（未知字段/批准/修订）', () => {
  const trusted = {
    task_id: TASK_ID,
    user_id: USER_ID,
    project_id: PROJECT_ID,
    approval: { paid_external_calls: true, online_writes: true, handoff_creation: false },
  };
  const submitCall = {
    schema_version: 'ams_harness_tool_v1',
    operation: 'generation.submit',
    payload: {
      project_id: PROJECT_ID,
      brief_id: BRIEF_ID,
      mode: 'image',
      prompt: '猫',
      quote_id: `g1q-${'a'.repeat(24)}`,
      quote_fingerprint: 'f'.repeat(64),
      estimated_max_cost_cny: 0.3,
    },
    idempotency_key: 'g1-tool-key',
    expected_revision: 1,
  };
  assert.equal(validateToolCall(submitCall, trusted).ok, true, '合法 submit 必须通过');
  const withoutRevision = { ...submitCall, expected_revision: undefined };
  assert.equal(validateToolCall(withoutRevision, trusted).code, 'EXPECTED_REVISION_REQUIRED', 'submit 必须携带可信项目修订');
  const withoutApproval = validateToolCall(submitCall, { ...trusted, approval: { paid_external_calls: true, online_writes: false, handoff_creation: false } });
  assert.equal(withoutApproval.code, 'APPROVAL_REQUIRED', '缺少写入批准必须拒绝');
  const unknownField = { ...submitCall, payload: { ...submitCall.payload, sql: 'select 1' } };
  assert.equal(validateToolCall(unknownField, trusted).code, 'UNKNOWN_PAYLOAD_FIELD', '未知字段必须拒绝');
  const quoteCall = {
    schema_version: 'ams_harness_tool_v1',
    operation: 'generation.quote',
    payload: { project_id: PROJECT_ID, brief_id: BRIEF_ID, mode: 'image', prompt: '猫' },
    idempotency_key: 'g1-tool-key-2',
  };
  assert.equal(validateToolCall(quoteCall, { ...trusted, approval: {} }).ok, true, 'quote 只读且零批准');
});

test('G1 四操作边界版本不可变：精确写入、覆盖尝试 fail closed、批准/修订守卫不回归', () => {
  const trusted = {
    task_id: TASK_ID,
    user_id: USER_ID,
    project_id: PROJECT_ID,
    approval: { paid_external_calls: true, online_writes: true, handoff_creation: false },
  };
  const g1Payloads = {
    'generation.quote': { project_id: PROJECT_ID, brief_id: BRIEF_ID, mode: 'image', prompt: '猫' },
    'generation.submit': {
      project_id: PROJECT_ID, brief_id: BRIEF_ID, mode: 'image', prompt: '猫',
      quote_id: `g1q-${'a'.repeat(24)}`, quote_fingerprint: 'f'.repeat(64), estimated_max_cost_cny: 0.3,
    },
    'generation.status': { project_id: PROJECT_ID, job_id: `g1j-${'b'.repeat(24)}` },
    'generation.artifact': { project_id: PROJECT_ID, job_id: `g1j-${'b'.repeat(24)}`, artifact_id: `g1x-${'c'.repeat(24)}` },
  };
  const expectedActions = { 'generation.quote': 'quote', 'generation.submit': 'approve_submit', 'generation.status': 'status', 'generation.artifact': 'artifact' };
  for (const [operation, payload] of Object.entries(g1Payloads)) {
    const base = {
      schema_version: 'ams_harness_tool_v1',
      operation,
      payload,
      idempotency_key: `g1-boundary-${operation}`,
      ...(operation === 'generation.submit' ? { expected_revision: 1 } : {}),
    };
    const checked = validateToolCall(base, trusted);
    assert.equal(checked.ok, true, `${operation} 必须通过校验：${checked.code}`);
    const boundary = toBoundaryRequest(checked.value);
    assert.equal(boundary.body.schema_version, 'g1_generation_command_v1', `${operation} 边界必须携带精确版本`);
    assert.equal(boundary.body.schema_version, G1_COMMAND_SCHEMA_VERSION, '版本必须来自网关固定常量');
    assert.equal(boundary.body.action, expectedActions[operation]);
    const payloadOverride = validateToolCall({ ...base, payload: { ...payload, schema_version: 'g1_generation_command_v1' } }, trusted);
    assert.equal(payloadOverride.code, 'UNKNOWN_PAYLOAD_FIELD', `${operation} 载荷内覆盖版本必须 fail closed`);
    assert.equal(payloadOverride.diagnostics.field, 'schema_version');
    const envelopeOverride = validateToolCall({ ...base, schema_version: 'g1_generation_command_v1' }, trusted);
    assert.equal(envelopeOverride.code, 'SCHEMA_VERSION_MISMATCH', `${operation} 信封覆盖版本必须 fail closed`);
    if (operation === 'generation.submit') {
      assert.equal(validateToolCall({ ...base, expected_revision: undefined }, trusted).code, 'EXPECTED_REVISION_REQUIRED', 'submit 修订守卫不回归');
      assert.equal(validateToolCall(base, { ...trusted, approval: { paid_external_calls: true, online_writes: false, handoff_creation: false } }).code, 'APPROVAL_REQUIRED', 'submit 写入批准守卫不回归');
    } else {
      assert.equal(validateToolCall(base, { ...trusted, approval: {} }).ok, true, `${operation} 只读零批准不回归`);
    }
  }
});

test('G1 报价绑定精确规范 Brief 身份：非规范历史 Brief 被规范装配取代后，quote 载荷复用同一持久化身份', async () => {
  // staging 实测：持久化 Brief 身份为 25 位十六进制后缀。分类器必须 fail
  // closed（绝不截断前 24 位 → 绝不绑定错误身份 → 无任何提交/提供商调用/
  // 作业/费用）。
  const stagingIntent = classifyIntent('用 brief-8a14d78ceee1a3ff2b32a076e 生成图片，提示词：「猫」');
  assert.equal(stagingIntent.ok, false);
  assert.equal(stagingIntent.code, 'PLANNER_IDENTITY_INVALID');
  assert.equal(stagingIntent.diagnostics.field, 'brief_id');

  // 项目含非规范历史 Brief 与完整卡集；装配必须写入由当前项目派生的确定性
  // 规范身份，历史记录保留在写前快照。
  const cardIds = [`kc-${'1'.repeat(24)}`, `kc-${'2'.repeat(24)}`, `kc-${'3'.repeat(24)}`];
  const state = {
    revision: 1,
    cards: cardIds.map((id) => ({ id, project_id: PROJECT_ID, schema_version: 'content_knowledge_card_v1', version: 1, fingerprint: 'k'.repeat(64) })),
    brief: {
      id: 'brief-8a14d78ceee1a3ff2b32a076e',
      project_id: PROJECT_ID,
      schema_version: 'ams_content_brief_v1',
      version: 1,
      status: 'pending_review',
      topic: '历史遗留主题',
      objective: '历史遗留目标',
      constraints: [],
      knowledge_citation_ids: cardIds,
      evidence_provenance: { evidence_ids: [], evidence_fingerprints: {}, statement: '历史记录' },
      review: { schema_version: 'ams_brief_review_v1', brief_id: 'brief-8a14d78ceee1a3ff2b32a076e', comments: [], decision: null },
      analysis_provenance: { method: 'multimodal_model', provider: 'dashscope', model: 'qwen-plus', executed_at: '2026-08-01T00:00:00.000Z', analysis_ids: [], media_count: 0, statement: '历史记录' },
      fingerprint: 'f'.repeat(64),
    },
  };
  const operations = [];
  const quotePayloads = [];
  let persistedReadBriefId = null;
  const toolClient = async (call, trustedContext) => {
    const checked = validateToolCall(call, trustedContext);
    assert.equal(checked.ok, true, `工具调用必须通过校验：${checked.code}`);
    operations.push(call.operation);
    if (call.operation === 'workspace.project.read') {
      // 刷新/读取恢复：每次读取都返回当前持久化状态。
      persistedReadBriefId = state.brief.id;
      return { ok: true, data: { project: { id: PROJECT_ID, version: state.revision, topic: 't', objective: 'o', constraints: [], evidence: [], analyses: [], knowledge_cards: state.cards, brief: state.brief, handoffs: [] } } };
    }
    if (call.operation === 'workspace.brief.assemble') {
      const record = { ...call.payload.brief, fingerprint: 'b'.repeat(64) };
      state.brief = record;
      state.revision += 1;
      return { ok: true, entity: { type: 'brief', id: record.id }, artifact_refs: [record.id] };
    }
    if (call.operation === 'generation.quote') {
      quotePayloads.push(call.payload);
      return { ok: true, data: { quote: { schema_version: 'g1_quote_v1', quote_id: `g1q-${'a'.repeat(24)}`, quote_fingerprint: 'f'.repeat(64), request_sha256: 'r'.repeat(64), price_cny_min: 0.02, price_cny_max: 0.3, estimated_max_cost_cny: 0.3, expires_at: '2026-08-16T00:30:00.000Z', mode: call.payload.mode, model_name: 'qwen-image-2.0', will_pay: false, will_write: false, will_use_storage: false, will_execute: false } }, entity: { type: 'quote', id: `g1q-${'a'.repeat(24)}` }, artifact_refs: [`g1q-${'a'.repeat(24)}`] };
    }
    return { ok: false, code: 'OPERATION_DENIED', diagnostics: { issues: [] } };
  };
  const stateReader = createBridgeStateReader(toolClient);
  const makeView = (plan) => ({
    id: TASK_ID,
    confirmation: {
      approval: {
        paid_external_calls: plan.approvals.paid_external_calls,
        online_writes: plan.approvals.online_writes,
        handoff_creation: plan.approvals.handoff_creation,
      },
      confirmed_at: '2026-08-16T00:00:00.000Z',
    },
    step_states: {},
    plan,
  });
  const now = () => '2026-08-16T00:00:00.000Z';

  // 阶段 1：装配待审核 Brief → 写入规范身份。
  const assemble = buildPlan({ taskId: TASK_ID, request: request('生成待审核 Brief'), workflowId: 'assemble_brief', slots: {} });
  assert.equal(assemble.ok, true, assemble.code);
  // 规范身份由当前项目 + 完整知识卡身份集合确定性派生。
  const expectedId = deriveCanonicalBriefId(PROJECT_ID, cardIds);
  const first = await executeConfirmedPlan({ taskView: makeView(assemble.value), plan: assemble.value, signal: null, emit: () => {}, toolClient, stateReader, now });
  assert.equal(first.outcome, 'succeeded', JSON.stringify(first));
  assert.equal(state.brief.id, expectedId, '装配必须写入由当前项目派生的确定性规范身份');
  assert.notEqual(state.brief.id, 'brief-8a14d78ceee1a3ff2b32a076e', '历史身份绝不被复用为新 Brief 身份');

  // 阶段 2：以持久化的规范身份请求报价（quote-only：零费用零写入），
  // quote 载荷的 brief_id 必须与持久化规范身份完全一致。
  const classified = classifyIntent(`用 ${state.brief.id} 生成图片，提示词：「猫」，只要报价`);
  assert.equal(classified.ok, true, classified.code);
  assert.equal(classified.value.slots.brief_id, state.brief.id);
  const quote = buildPlan({ taskId: TASK_ID, request: request('生成图片'), workflowId: 'generate_media', slots: classified.value.slots });
  assert.equal(quote.ok, true, quote.code);
  assert.equal(quote.value.approvals.paid_external_calls, false, 'quote-only 零付费批准');
  const second = await executeConfirmedPlan({ taskView: makeView(quote.value), plan: quote.value, signal: null, emit: () => {}, toolClient, stateReader, now });
  assert.equal(second.outcome, 'succeeded', JSON.stringify(second));
  assert.equal(operations.filter((operation) => operation === 'generation.quote').length, 1);
  assert.equal(persistedReadBriefId, state.brief.id, '刷新/读取恢复返回持久化的规范身份');
  assert.equal(quotePayloads.length, 1);
  assert.equal(quotePayloads[0].brief_id, expectedId, 'quote 载荷绑定精确的规范持久化 Brief 身份');
  assert.match(quotePayloads[0].brief_id, /^brief-[0-9a-f]{24}$/);
  assert.ok(!operations.includes('generation.submit'), 'quote-only 绝不发起付费提交');
});

/** 异步 submit 夹具：同一 taskView 跨执行回合保持 step_states（刷新/重开语义）。 */
function makeAsyncGenerationHarness() {
  const plan = buildGeneratePlan().value;
  let quoteCalls = 0;
  let submitCalls = 0;
  let statusCalls = 0;
  let jobState = { status: 'queued' };
  const toolClient = async (call, trustedContext) => {
    const checked = validateToolCall(call, trustedContext);
    assert.equal(checked.ok, true, `工具调用必须通过校验：${checked.code}`);
    if (call.operation === 'workspace.project.read') {
      return { ok: true, data: { project: { id: PROJECT_ID, version: 1, brief: { id: BRIEF_ID, version: 1, status: 'pending_review', fingerprint: 'b'.repeat(64), knowledge_citation_ids: ['kc-111111111111111111111111'], evidence_provenance: { evidence_ids: ['ev-111111111111111111111111'] } } } } };
    }
    if (call.operation === 'generation.quote') {
      quoteCalls += 1;
      const quote = {
        schema_version: 'g1_quote_v1', quote_id: `g1q-${'a'.repeat(24)}`, quote_fingerprint: 'f'.repeat(64),
        request_sha256: 'r'.repeat(64), price_cny_min: 0.02, price_cny_max: 0.3, estimated_max_cost_cny: 0.3,
        expires_at: '2026-08-16T00:30:00.000Z', mode: call.payload.mode, model_name: 'qwen-image-2.0',
        will_pay: true, will_write: true, will_use_storage: true, will_execute: true,
      };
      return { ok: true, data: { quote }, entity: { type: 'quote', id: quote.quote_id }, artifact_refs: [quote.quote_id] };
    }
    if (call.operation === 'generation.submit') {
      submitCalls += 1;
      return { ok: true, data: { job: { id: `g1j-${'b'.repeat(24)}`, status: jobState.status, mode: 'image', model_name: 'qwen-image-2.0' } }, entity: { type: 'generation_job', id: `g1j-${'b'.repeat(24)}` }, artifact_refs: [`g1j-${'b'.repeat(24)}`] };
    }
    if (call.operation === 'generation.status') {
      statusCalls += 1;
      return { ok: true, data: { job: { id: `g1j-${'b'.repeat(24)}`, ...jobState } }, entity: { type: 'generation_job', id: `g1j-${'b'.repeat(24)}` } };
    }
    return { ok: false, code: 'OPERATION_DENIED', diagnostics: { issues: [] } };
  };
  const stateReader = async () => ({ ok: true, project: { id: PROJECT_ID, version: 1 }, revision: 1 });
  const taskView = {
    id: TASK_ID,
    confirmation: { approval: { paid_external_calls: true, online_writes: true, handoff_creation: false } },
    step_states: {},
    plan,
  };
  const now = () => '2026-08-16T00:00:00.000Z';
  const run = () => executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient, stateReader, now });
  return {
    plan, taskView, run, setJob(next) { jobState = next; },
    counts: () => ({ quoteCalls, submitCalls, statusCalls }),
  };
}

test('执行器：异步 submit 非终态；status 读取推进 completed，刷新绝不重复提交', async () => {
  const harness = makeAsyncGenerationHarness();

  // 回合 1：submit 返回 queued → 状态读取仍 queued → 外层非终态 running。
  const first = await harness.run();
  assert.equal(first.outcome, 'running', '排队中的作业绝不报告 completed');
  assert.equal(first.partial_completion, false, '非终态绝不是 partial');
  assert.match(first.final_response, /尚未完成/, '最终响应必须如实说明尚未完成');
  const submitSnapshot = harness.taskView.step_states['st-2'];
  assert.equal(submitSnapshot.state, 'succeeded', '提交本身已成功（作业被接受）');
  assert.equal(submitSnapshot.job_status, 'queued', '快照必须记录真实作业状态');
  assert.equal(submitSnapshot.job_id, `g1j-${'b'.repeat(24)}`);
  assert.equal(harness.counts().submitCalls, 1);
  assert.equal(harness.counts().statusCalls, 1, '每回合恰好一次只读状态读取');
  assert.ok(plainObjectLike(first.result_data?.generation_status), '结果必须携带生成状态视图');
  assert.equal(first.result_data.generation_status.status, 'queued');

  // 回合 2（刷新/重开，同一 taskView）：作业 completed → status 读取推进终态。
  harness.setJob({ status: 'completed', mode: 'image', model_name: 'qwen-image-2.0', artifact_count: 1 });
  const second = await harness.run();
  assert.equal(second.outcome, 'succeeded', '作业完成时外层任务必须终态成功');
  assert.equal(harness.taskView.step_states['st-2'].job_status, 'completed');
  assert.equal(harness.counts().submitCalls, 1, '刷新绝不重复提交付费作业');
  assert.equal(harness.counts().quoteCalls, 1, '刷新绝不重复报价');
  assert.equal(harness.counts().statusCalls, 2, '刷新通过精确 status 读取推进');
  assert.equal(second.result_data.generation_status.status, 'completed');

  // 回合 3：再次执行已终态任务 → 零新增调用。
  const third = await harness.run();
  assert.equal(third.outcome, 'succeeded');
  assert.equal(harness.counts().submitCalls, 1);
  assert.equal(harness.counts().statusCalls, 2, '终态后绝不再次读取');
});

test('执行器：终态失败/needs_attention → 外层 failed（绝不 completed），诊断有界保留', async () => {
  // 场景 A：provider 明确失败 → 外层 failed + 精确有界诊断。
  const harnessA = makeAsyncGenerationHarness();
  assert.equal((await harnessA.run()).outcome, 'running');
  harnessA.setJob({
    status: 'failed', mode: 'image', model_name: 'qwen-image-2.0',
    diagnostics: {
      code: 'G1_PROVIDER_FAILED',
      issues: ['Provider task reached FAILED: InvalidParameter — Input should be \'1080P\' or \'720P\': parameters.resolution'],
      provider_code: 'InvalidParameter',
      provider_message: 'Input should be \'1080P\' or \'720P\': parameters.resolution',
    },
  });
  const secondA = await harnessA.run();
  assert.equal(secondA.outcome, 'failed', '终态失败必须使外层任务失败，绝不 completed');
  assert.equal(secondA.needs_attention, undefined, '普通失败不是 needs_attention');
  const failedStepA = harnessA.taskView.step_states['st-2'];
  assert.equal(failedStepA.state, 'failed');
  assert.equal(failedStepA.error.code, 'G1_PROVIDER_FAILED', '必须保留精确失败码');
  assert.equal(failedStepA.error.g1_terminal, true);
  assert.equal(failedStepA.job_status, 'failed');
  assert.match(failedStepA.error.message, /InvalidParameter/, '有界诊断必须保留 provider 代码');
  assert.equal(harnessA.counts().submitCalls, 1, '终态失败后绝不重复提交');
  assert.equal(harnessA.counts().statusCalls, 2);
  assert.equal(secondA.result_data.generation_status.status, 'failed');

  // 场景 B：needs_attention → 外层 failed + needs_attention 标记。
  const harnessB = makeAsyncGenerationHarness();
  assert.equal((await harnessB.run()).outcome, 'running');
  harnessB.setJob({
    status: 'needs_attention', mode: 'image', model_name: 'qwen-image-2.0',
    diagnostics: { code: 'G1_WORKER_TIMEOUT', issues: ['Generation exceeded the overall bounded timeout.'] },
  });
  const secondB = await harnessB.run();
  assert.equal(secondB.outcome, 'failed', 'needs_attention 必须使外层任务失败，绝不 completed');
  assert.equal(secondB.needs_attention, true, '必须显式标记需要关注');
  assert.match(secondB.final_response, /需要人工关注/);
  const failedStepB = harnessB.taskView.step_states['st-2'];
  assert.equal(failedStepB.error.code, 'G1_WORKER_TIMEOUT', '必须保留精确诊断码');
  assert.equal(failedStepB.error.g1_needs_attention, true);
  assert.equal(failedStepB.job_status, 'needs_attention');
  assert.equal(harnessB.counts().submitCalls, 1, 'needs_attention 后绝不重复提交');

  // 回合 3：终态失败后再次刷新 → 保持失败，零新增调用。
  const thirdA = await harnessA.run();
  assert.equal(thirdA.outcome, 'failed');
  assert.equal(harnessA.counts().submitCalls, 1);
  assert.equal(harnessA.counts().statusCalls, 2, '终态失败后刷新绝不再次读取/提交');
});

test('执行器：status 读取边界失败 → 保持非终态与有界读取错误，绝不重提', async () => {
  const plan = buildGeneratePlan().value;
  let submitCalls = 0;
  let statusCalls = 0;
  let statusBroken = true;
  const jobId = `g1j-${'b'.repeat(24)}`;
  const toolClient = async (call, trustedContext) => {
    const checked = validateToolCall(call, trustedContext);
    assert.equal(checked.ok, true, `工具调用必须通过校验：${checked.code}`);
    if (call.operation === 'workspace.project.read') {
      return { ok: true, data: { project: { id: PROJECT_ID, version: 1, brief: { id: BRIEF_ID, version: 1, status: 'pending_review', fingerprint: 'b'.repeat(64), knowledge_citation_ids: ['kc-111111111111111111111111'], evidence_provenance: { evidence_ids: ['ev-111111111111111111111111'] } } } } };
    }
    if (call.operation === 'generation.quote') {
      return { ok: true, data: { quote: { schema_version: 'g1_quote_v1', quote_id: `g1q-${'a'.repeat(24)}`, quote_fingerprint: 'f'.repeat(64), request_sha256: 'r'.repeat(64), price_cny_min: 0.02, price_cny_max: 0.3, estimated_max_cost_cny: 0.3, expires_at: '2026-08-16T00:30:00.000Z', mode: 'image', model_name: 'qwen-image-2.0', will_pay: true, will_write: true, will_use_storage: true, will_execute: true } }, entity: { type: 'quote', id: `g1q-${'a'.repeat(24)}` }, artifact_refs: [`g1q-${'a'.repeat(24)}`] };
    }
    if (call.operation === 'generation.submit') {
      submitCalls += 1;
      return { ok: true, data: { job: { id: jobId, status: 'queued' } }, entity: { type: 'generation_job', id: jobId }, artifact_refs: [jobId] };
    }
    if (call.operation === 'generation.status') {
      statusCalls += 1;
      if (statusBroken) return { ok: false, code: 'G1_JOB_NOT_FOUND', diagnostics: { issues: ['作业不存在。'] } };
      return { ok: true, data: { job: { id: jobId, status: 'completed' } }, entity: { type: 'generation_job', id: jobId } };
    }
    return { ok: false, code: 'OPERATION_DENIED', diagnostics: { issues: [] } };
  };
  const stateReader = async () => ({ ok: true, project: { id: PROJECT_ID, version: 1 }, revision: 1 });
  const taskView = {
    id: TASK_ID,
    confirmation: { approval: { paid_external_calls: true, online_writes: true, handoff_creation: false } },
    step_states: {},
    plan,
  };
  const now = () => '2026-08-16T00:00:00.000Z';
  const run = () => executeConfirmedPlan({ taskView, plan, signal: null, emit: () => {}, toolClient, stateReader, now });

  // 回合 1：submit queued → status 读取失败 → 仍非终态，携带有界读取错误。
  const first = await run();
  assert.equal(first.outcome, 'running', '状态读取失败绝不误报完成');
  assert.equal(first.partial_completion, false);
  const snapshot = taskView.step_states['st-2'];
  assert.equal(snapshot.state, 'succeeded', '提交本身已成功');
  assert.equal(snapshot.job_status, 'queued');
  assert.deepEqual(snapshot.status_read_error, { code: 'G1_JOB_NOT_FOUND', message: '作业不存在。' }, '读取失败必须有界保留');
  assert.equal(submitCalls, 1, '读取失败绝不重提付费作业');
  assert.equal(statusCalls, 1);

  // 回合 2：读取恢复 → completed → 终态成功；仍无第二次提交。
  statusBroken = false;
  const second = await run();
  assert.equal(second.outcome, 'succeeded', '读取恢复后推进到终态完成');
  assert.equal(taskView.step_states['st-2'].job_status, 'completed');
  assert.equal(submitCalls, 1, '全程绝不第二次提交');
  assert.equal(statusCalls, 2);
});

function plainObjectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 队列级 running→terminal 续接契约：真实 planner + 真实确定性执行器 +
// 有状态 mock 边界，穿过 HarnessTaskQueue 的完整 confirm/持久化/重载路径。
// ---------------------------------------------------------------------------

/** 队列级异步生成夹具：同一有状态边界贯穿多个队列实例（重启重载共享作业身份）。 */
function makeQueueGenerationHarness({ initialTasks = [], onEvent = () => {} } = {}) {
  const state = {
    job: { status: 'queued' },
    quoteCalls: 0,
    submitCalls: 0,
    statusCalls: 0,
    ops: [],
  };
  const toolClient = async (call, trustedContext) => {
    const checked = validateToolCall(call, trustedContext);
    assert.equal(checked.ok, true, `工具调用必须通过校验：${checked.code}`);
    state.ops.push(call.operation);
    if (call.operation === 'workspace.project.read') {
      return {
        ok: true,
        data: {
          project: {
            id: PROJECT_ID,
            version: 1,
            brief: {
              id: BRIEF_ID,
              version: 1,
              status: 'pending_review',
              fingerprint: 'b'.repeat(64),
              knowledge_citation_ids: ['kc-111111111111111111111111'],
              evidence_provenance: { evidence_ids: ['ev-111111111111111111111111'] },
            },
          },
        },
      };
    }
    if (call.operation === 'generation.quote') {
      state.quoteCalls += 1;
      return {
        ok: true,
        data: {
          quote: {
            schema_version: 'g1_quote_v1',
            quote_id: `g1q-${'a'.repeat(24)}`,
            quote_fingerprint: 'f'.repeat(64),
            request_sha256: 'r'.repeat(64),
            price_cny_min: 0.02,
            price_cny_max: 0.3,
            estimated_max_cost_cny: 0.3,
            expires_at: '2026-08-16T00:30:00.000Z',
            mode: call.payload.mode,
            model_name: 'qwen-image-2.0',
            will_pay: true,
            will_write: true,
            will_use_storage: true,
            will_execute: true,
          },
        },
        entity: { type: 'quote', id: `g1q-${'a'.repeat(24)}` },
        artifact_refs: [`g1q-${'a'.repeat(24)}`],
      };
    }
    if (call.operation === 'generation.submit') {
      state.submitCalls += 1;
      return { ok: true, data: { job: { id: `g1j-${'b'.repeat(24)}`, ...state.job } }, entity: { type: 'generation_job', id: `g1j-${'b'.repeat(24)}` }, artifact_refs: [`g1j-${'b'.repeat(24)}`] };
    }
    if (call.operation === 'generation.status') {
      state.statusCalls += 1;
      return { ok: true, data: { job: { id: `g1j-${'b'.repeat(24)}`, ...state.job } }, entity: { type: 'generation_job', id: `g1j-${'b'.repeat(24)}` } };
    }
    return { ok: false, code: 'OPERATION_DENIED', diagnostics: { issues: [] } };
  };
  const deterministicRunner = (_request, _taskId, signal, _runtimeContext, taskView, emit) => executeConfirmedPlan({
    taskView,
    plan: taskView.plan,
    signal,
    emit,
    toolClient,
    stateReader: createBridgeStateReader(toolClient),
  });
  const queue = new HarnessTaskQueue({
    runner: async () => { throw new Error('legacy runner must not run for planned tasks'); },
    deterministicRunner,
    planner: createPlanner(),
    initialTasks,
    onEvent,
    validateRuntimeContext: (context) => (context?.delegatedAuthorization ? { ok: true } : { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' }),
  });
  return {
    queue,
    setJob(next) { state.job = next; },
    counts: () => ({ quoteCalls: state.quoteCalls, submitCalls: state.submitCalls, statusCalls: state.statusCalls }),
    ops: () => state.ops.slice(),
  };
}

const VALID_AUTH = { delegatedAuthorization: 'Bearer ' + 'g'.repeat(40) };

async function planQueueGeneration(queue, requestId = 'queue-generation-1') {
  return queue.plan({
    schema_version: GATEWAY_SCHEMA_VERSION,
    request_id: requestId,
    user_id: USER_ID,
    project_id: PROJECT_ID,
    intent: `用 brief-${'a'.repeat(24)} 生成图片，提示词：「一只在森林里的猫」`,
  }, VALID_AUTH);
}

function queueConfirmRequest(task, approval = task.plan.approvals) {
  return { schema_version: GATEWAY_SCHEMA_VERSION, task_id: task.id, plan_fingerprint: task.plan.fingerprint, approval };
}

test('队列级：running 结果持久为非终态；显式续接恰一次只读 status 并收敛，绝不重复报价/提交/付费/写入', async () => {
  const harness = makeQueueGenerationHarness();
  const planned = await planQueueGeneration(harness.queue);
  assert.equal(planned.ok, true, planned.code);
  const task = planned.task;
  const confirm = (userId = task.request.user_id, runtimeContext = VALID_AUTH) => harness.queue.confirm(queueConfirmRequest(task), userId, runtimeContext);

  const confirmed = confirm();
  assert.equal(confirmed.ok, true);
  await harness.queue.whenIdle();
  let current = harness.queue.read(task.id, task.request.user_id).task;
  assert.equal(current.state, 'running', '排队中的作业绝不把外层任务报告为 succeeded');
  assert.equal(current.pending_continuation, true, '非终态必须持久化为可续接的 durable park');
  assert.equal(harness.counts().submitCalls, 1);
  assert.equal(harness.counts().quoteCalls, 1);
  assert.equal(harness.counts().statusCalls, 1, '首回合恰一次只读状态读取');
  assert.equal(current.result.result_data.generation_status.status, 'queued');

  // 显式认证续接：作业 completed → 恰一次只读 status → 收敛 succeeded。
  harness.setJob({ status: 'completed', mode: 'image', model_name: 'qwen-image-2.0', artifact_count: 1 });
  const opsBefore = harness.ops().length;
  const continued = confirm();
  assert.equal(continued.ok, true);
  assert.equal(continued.continued, true, '同任务显式续接必须被接受');
  await harness.queue.whenIdle();
  current = harness.queue.read(task.id, task.request.user_id).task;
  assert.equal(current.state, 'succeeded', '作业完成后续接必须收敛到终态成功');
  assert.equal(harness.counts().submitCalls, 1, '续接绝不重复提交付费作业');
  assert.equal(harness.counts().quoteCalls, 1, '续接绝不重复报价');
  assert.equal(harness.counts().statusCalls, 2, '续接恰一次只读状态读取');
  assert.deepEqual(harness.ops().slice(opsBefore), ['generation.status'], '续接回合除恰一次只读 status 外零调用');
  assert.equal(current.pending_continuation, undefined, '终态收敛必须清除 park 标记');
  assert.equal(current.result.result_data.generation_status.status, 'completed');

  // 终态后重复续接 → 幂等重放，零新增调用。
  const replay = confirm();
  assert.equal(replay.replayed, true);
  assert.equal(harness.counts().statusCalls, 2, '终态后绝不再次读取/提交');
});

test('队列级：续接在错误身份/指纹/授权前失败；needs_attention 收敛为 failed 且诊断有界', async () => {
  const harness = makeQueueGenerationHarness();
  const planned = await planQueueGeneration(harness.queue);
  const task = planned.task;
  const confirm = (userId = task.request.user_id, runtimeContext = VALID_AUTH) => harness.queue.confirm(queueConfirmRequest(task), userId, runtimeContext);
  confirm();
  await harness.queue.whenIdle();
  assert.equal(harness.queue.read(task.id, task.request.user_id).task.state, 'running');

  const wrongUser = confirm('user-other');
  assert.equal(wrongUser.code, 'TASK_NOT_FOUND', '错误身份在执行前失败');
  const wrongFingerprint = harness.queue.confirm({ ...queueConfirmRequest(task), plan_fingerprint: 'f'.repeat(64) }, task.request.user_id, VALID_AUTH);
  assert.equal(wrongFingerprint.code, 'PLAN_FINGERPRINT_MISMATCH', '错误计划指纹在执行前失败');
  const unauthorized = confirm(task.request.user_id, null);
  assert.equal(unauthorized.code, 'DELEGATED_AUTHORIZATION_REQUIRED', '无效委派授权在执行前失败');
  assert.equal(harness.counts().statusCalls, 1, '被拒绝的续接零执行');

  // 正确续接：作业 needs_attention → 外层 failed + 有界诊断。
  harness.setJob({
    status: 'needs_attention', mode: 'image', model_name: 'qwen-image-2.0',
    diagnostics: { code: 'G1_WORKER_TIMEOUT', issues: ['Generation exceeded the overall bounded timeout.'] },
  });
  const continued = confirm();
  assert.equal(continued.ok, true);
  await harness.queue.whenIdle();
  const current = harness.queue.read(task.id, task.request.user_id).task;
  assert.equal(current.state, 'failed', 'needs_attention 必须收敛为外层失败');
  assert.equal(current.error.code, 'G1_JOB_NEEDS_ATTENTION', '队列级必须保留有界 needs_attention 信号');
  const submitSnapshot = current.step_states['st-2'];
  assert.equal(submitSnapshot.state, 'failed');
  assert.equal(submitSnapshot.error.code, 'G1_WORKER_TIMEOUT', '精确诊断码必须保留');
  assert.equal(submitSnapshot.error.g1_needs_attention, true);
  assert.equal(submitSnapshot.job_status, 'needs_attention');
  assert.equal(current.result.result_data.generation_status.status, 'needs_attention');
  assert.equal(harness.counts().submitCalls, 1, '失败收敛后绝不重复提交');
  assert.equal(harness.counts().statusCalls, 2, '失败收敛恰一次只读状态读取');
  const replay = confirm();
  assert.equal(replay.replayed, true, '终态失败后的续接是幂等重放');
  assert.equal(harness.counts().statusCalls, 2, '终态失败后零新增调用');
});

test('队列级：持久快照重启后任务保持非终态，续接以一次只读 status 收敛（job 身份 restart-safe）', async () => {
  const events = [];
  const source = makeQueueGenerationHarness({ onEvent: (event) => events.push(event) });
  const planned = await planQueueGeneration(source.queue, 'queue-generation-restart');
  const task = planned.task;
  source.queue.confirm(queueConfirmRequest(task), task.request.user_id, VALID_AUTH);
  await source.queue.whenIdle();
  assert.equal(source.queue.read(task.id, task.request.user_id).task.state, 'running');
  const snapshot = events.find((event) => event.event === 'running' && event.task?.pending_continuation === true)?.task;
  assert.ok(snapshot, 'park 快照必须经审计事件持久化');
  assert.equal(snapshot.step_states['st-2'].job_status, 'queued', '作业身份必须随快照持久化');

  // 重启：同一持久快照重载进新队列（作业已在 provider 侧完成）。
  const target = makeQueueGenerationHarness({ initialTasks: [snapshot] });
  target.setJob({ status: 'completed', mode: 'image', model_name: 'qwen-image-2.0', artifact_count: 1 });
  const recovered = target.queue.read(task.id, task.request.user_id).task;
  assert.equal(recovered.state, 'running', '重启后任务必须保持非终态');
  assert.equal(recovered.pending_continuation, true);
  assert.equal(recovered.plan.fingerprint, task.plan.fingerprint, '计划身份必须跨重启保持');
  const continued = target.queue.confirm(queueConfirmRequest(recovered), recovered.request.user_id, VALID_AUTH);
  assert.equal(continued.ok, true);
  assert.equal(continued.continued, true);
  await target.queue.whenIdle();
  const done = target.queue.read(task.id, task.request.user_id).task;
  assert.equal(done.state, 'succeeded', '重启后续接必须收敛到真实终态');
  assert.equal(done.step_states['st-2'].job_status, 'completed');
  assert.equal(target.counts().submitCalls, 0, '重启后续接绝不重新提交付费作业');
  assert.equal(target.counts().quoteCalls, 0, '重启后续接绝不重复报价');
  assert.equal(target.counts().statusCalls, 1, '重启后续接恰一次只读状态读取收敛');
});
