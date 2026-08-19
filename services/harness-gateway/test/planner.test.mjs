// Planner unit tests: intent classification, slot extraction bounds, fail-closed
// rejection of unknown workflows/slots/types/enums/sizes/identities, and the
// injectable model-planner path going through the exact same validation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlanner, classifyIntent, buildPlan, validatePlanShape } from '../planner.mjs';

const TASK_ID = 'ht-11111111-1111-4111-8111-111111111111';

function request(intent, overrides = {}) {
  return {
    user_id: 'user-a',
    project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa',
    intent,
    request_fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

test('intent classifier maps every supported ability to exactly one workflow', () => {
  const cases = [
    ['帮我读一下当前项目状态', 'read_capability'],
    ['分析这个 X 帖子 https://x.com/a/status/1234567890123456789，保存证据和分析，并生成待审核 Brief', 'collect_analyze_evidence'],
    ['搜索 X 上 AI 营销 热门话题', 'search_x'],
    ['搜索 reddit 上 AI 营销，选 3 条保存为证据', 'search_reddit'],
    ['搜索 X 和 Reddit 上本周最热门的话题 AI 营销，选 5 条保存为证据', 'search_x_reddit'],
    ['把项目里现有证据都分析一遍', 'analyze_evidence'],
    ['比较当前项目中表现最好的帖子，提炼可复用的内容规律', 'compare_project'],
    ['生成交接包', 'create_handoff'],
    ['审计一下来源血缘', 'lineage_audit'],
  ];
  for (const [intent, expected] of cases) {
    const verdict = classifyIntent(intent);
    assert.equal(verdict.ok, true, intent);
    assert.equal(verdict.value.workflow, expected, intent);
  }
});

test('unknown or ambiguous intents fail closed', () => {
  assert.equal(classifyIntent('随便做点事').code, 'PLANNER_UNRECOGNIZED');
  assert.equal(classifyIntent('').code, 'PLANNER_INTENT_INVALID');
  assert.equal(classifyIntent('x'.repeat(12_001)).code, 'PLANNER_INTENT_INVALID');
});

test('Chinese highest-metric intents select compare_project with the exact metric', () => {
  const cases = [
    ['你能分析下近期展现量最高的X帖子吗', 'views'],
    ['近期浏览量最高的帖子帮我挑出来', 'views'],
    ['播放量最高的视频内容', 'views'],
    ['曝光最高的内容比较一下', 'views'],
    ['互动最高的帖子是哪些', 'engagement'],
    ['比较一下互动量最高的来源', 'engagement'],
  ];
  for (const [intent, expectedMetric] of cases) {
    const verdict = classifyIntent(intent);
    assert.equal(verdict.ok, true, intent);
    assert.equal(verdict.value.workflow, 'compare_project', intent);
    assert.equal(verdict.value.slots.metric, expectedMetric, intent);
    assert.equal(verdict.value.slots.persist, undefined, `${intent}: comparison defaults to read-only`);
  }
  // Generic compare/best-performing phrases keep the documented default
  // engagement metric and never invent a metric.
  const generic = classifyIntent('比较当前项目中表现最好的帖子，提炼可复用的内容规律');
  assert.equal(generic.ok, true);
  assert.equal(generic.value.workflow, 'compare_project');
  assert.equal(generic.value.slots.metric, undefined, 'generic compare relies on the slot default');
  const explicitPersist = classifyIntent('比较当前项目中互动最高的帖子并保存比较分析');
  assert.equal(explicitPersist.ok, true);
  assert.equal(explicitPersist.value.slots.metric, 'engagement');
  assert.equal(explicitPersist.value.slots.persist, true, 'explicit save language opts into persistence approval');
  const savedEvidence = classifyIntent('比较一下已经保存的证据里表现最好的');
  assert.equal(savedEvidence.ok, true);
  assert.equal(savedEvidence.value.slots.persist, undefined, 'already-saved evidence phrasing never opts into a write');
});

test('metric compare plans are read-only by default and write only under explicit approval', () => {
  const readOnly = buildPlan({
    taskId: TASK_ID,
    request: request('分析下近期展现量最高的X帖子'),
    workflowId: 'compare_project',
    slots: { metric: 'views', count: 2 },
  });
  assert.equal(readOnly.ok, true, readOnly.code);
  assert.deepEqual(readOnly.value.slots, { metric: 'views', count: 2, persist: false });
  assert.deepEqual(readOnly.value.steps.map((step) => step.operation), ['workspace.project.read', null], 'read-only plan has no write step');
  assert.equal(readOnly.value.steps[1].key, 'compare');
  assert.equal(readOnly.value.steps[1].kind, 'local');
  assert.equal(readOnly.value.approvals.online_writes, false);
  assert.equal(readOnly.value.approvals.paid_external_calls, false);
  assert.equal(readOnly.value.cost_indicators.paid_calls, 0);
  assert.equal(readOnly.value.cost_indicators.online_writes, 0);

  const persisted = buildPlan({
    taskId: TASK_ID,
    request: request('比较当前项目中互动最高的帖子并保存比较分析'),
    workflowId: 'compare_project',
    slots: { metric: 'engagement', count: 2, persist: true },
  });
  assert.equal(persisted.ok, true, persisted.code);
  assert.deepEqual(persisted.value.steps.map((step) => step.operation), ['workspace.project.read', null, 'workspace.analysis.create']);
  assert.deepEqual(persisted.value.steps[2].depends_on, ['st-1']);
  assert.equal(persisted.value.steps[2].write, true);
  assert.equal(persisted.value.approvals.online_writes, true, 'persist requires the online_writes approval');
  assert.equal(persisted.value.cost_indicators.online_writes, 2);
  // The requested metric is never invented: an unsupported metric word fails
  // closed instead of silently falling back to engagement.
  const invented = buildPlan({ taskId: TASK_ID, request: request('x'), workflowId: 'compare_project', slots: { metric: 'saves', count: 2 } });
  assert.equal(invented.code, 'PLAN_SLOT_ENUM');
});

test('Brief intent wins over generic analysis words when no URL is present', () => {
  const verdict = classifyIntent('Generate a pending Brief from the existing analysis results');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.workflow, 'assemble_brief');
});

test('collection-only URL intent stays read-only and project-independent', () => {
  const intent = 'collect this X post https://x.com/a/status/1234567890123456789';
  const classified = classifyIntent(intent);
  assert.equal(classified.ok, true);
  assert.deepEqual(classified.value.slots, {
    url: 'https://x.com/a/status/1234567890123456789',
    persist: false,
    analyze: false,
    card: false,
    brief: false,
  });
  const built = buildPlan({
    taskId: TASK_ID,
    request: request(intent, { project_id: null }),
    workflowId: classified.value.workflow,
    slots: classified.value.slots,
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.value.steps.map((step) => step.operation), ['research.collect_url']);
  assert.equal(built.value.approvals.online_writes, false);
  assert.equal(built.value.cost_indicators.online_writes, 0);
});

test('slot extraction is bounded: counts, save counts and identities', async () => {
  const planner = createPlanner();
  const search = await planner.plan({ taskId: TASK_ID, request: request('搜索 reddit 上 AI 营销，选 3 条保存为证据') });
  assert.equal(search.ok, true);
  assert.equal(search.value.slots.keyword, 'AI 营销');
  assert.equal(search.value.slots.count, 5, 'a save phrase never doubles as the search count');
  assert.equal(search.value.slots.save_count, 3);
  assert.equal(search.value.slots.sort, 'relevance');
  assert.equal(search.value.slots.time_filter, 'all');
  const combined = await planner.plan({ taskId: TASK_ID, request: request('搜索 X 和 Reddit 上本周最热门的话题 AI 营销，选 5 条保存为证据') });
  assert.equal(combined.ok, true);
  assert.equal(combined.value.slots.keyword, 'AI 营销');
  assert.equal(combined.value.slots.save_count, 5);
  const tooMany = await planner.plan({ taskId: TASK_ID, request: request('搜索 X 上 AI，选 99 条保存为证据') });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'PLAN_SLOT_BOUNDS', 'over-limit save count fails closed');
  const similar = await planner.plan({ taskId: TASK_ID, request: request(`根据知识卡 ev-${'a'.repeat(24)} 和分析 an-${'b'.repeat(24)} 生成相似内容草案`) });
  assert.equal(similar.ok, true);
  assert.equal(similar.value.slots.evidence_id, `ev-${'a'.repeat(24)}`);
  assert.equal(similar.value.slots.analysis_id, `an-${'b'.repeat(24)}`);
  const noIdentity = await planner.plan({ taskId: TASK_ID, request: request('根据已审核知识卡生成一个新的内容策划草案') });
  assert.equal(noIdentity.code, 'PLAN_SLOT_REQUIRED', 'generate_similar without an exact identity fails closed');
  // analysis_id is required by the paid draft boundary; a plan missing it
  // fails closed at plan time instead of dying at execution.
  const noAnalysis = await planner.plan({ taskId: TASK_ID, request: request(`根据知识卡 ev-${'a'.repeat(24)} 生成相似内容草案`) });
  assert.equal(noAnalysis.code, 'PLAN_SLOT_REQUIRED', 'generate_similar without the exact bound analysis fails closed');
  const redditUrl = await planner.plan({ taskId: TASK_ID, request: request('保存这个帖子 https://www.reddit.com/r/marketing/comments/ab/xy/ 为证据') });
  assert.equal(redditUrl.code, 'PLAN_SLOT_URL_UNSUPPORTED', 'Reddit collection fails closed with guidance');
});

test('cost indicators use the requested fan-out bound instead of catalog maxima', () => {
  const cases = [
    ['search_x', { keyword: 'AI', count: 5, save_count: 1 }, 1, 1],
    ['search_x_reddit', { keyword: 'AI', count: 5, save_count: 1 }, 2, 1],
    ['analyze_evidence', { count: 1 }, 1, 1],
    ['analyze_evidence', { count: 3 }, 3, 3],
    // compare_project is read-only by default (zero writes, zero paid calls);
    // only an explicit persist approval adds the bounded write step.
    ['compare_project', { count: 2 }, 0, 0],
    ['compare_project', { count: 2, metric: 'views', persist: false }, 0, 0],
    ['compare_project', { count: 2, metric: 'views', persist: true }, 0, 2],
  ];
  for (const [workflowId, slots, paidCalls, onlineWrites] of cases) {
    const result = buildPlan({ taskId: TASK_ID, request: request(workflowId), workflowId, slots });
    assert.equal(result.ok, true, `${workflowId}: ${result.code}`);
    assert.equal(result.value.cost_indicators.paid_calls, paidCalls, `${workflowId} paid calls`);
    assert.equal(result.value.cost_indicators.online_writes, onlineWrites, `${workflowId} writes`);
    for (const step of result.value.steps.filter((entry) => entry.fan_out)) {
      assert.equal(typeof step.fan_out.limit_slot, 'string');
      assert.equal(Number.isSafeInteger(result.value.slots[step.fan_out.limit_slot]), true);
    }
  }
});

test('model planner output goes through the exact same fail-closed validation', async () => {
  const fakeModel = async (_intent) => ({ workflow: 'search_x', slots: { keyword: 'k', count: 3, save_count: 0 } });
  const planner = createPlanner({ modelPlanner: fakeModel });
  const ok = await planner.plan({ taskId: TASK_ID, request: request('whatever the model says') });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.workflow, 'search_x');

  const inventedWorkflow = async () => ({ workflow: 'invented', slots: {} });
  const rejected = await createPlanner({ modelPlanner: inventedWorkflow }).plan({ taskId: TASK_ID, request: request('x') });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'PLAN_WORKFLOW_UNKNOWN');

  const inventedSlot = async () => ({ workflow: 'search_x', slots: { keyword: 'k', sql: 'select 1' } });
  const slotRejected = await createPlanner({ modelPlanner: inventedSlot }).plan({ taskId: TASK_ID, request: request('x') });
  assert.equal(slotRejected.ok, false);
  assert.equal(slotRejected.code, 'PLAN_SLOT_UNKNOWN');

  const invalidType = async () => ({ workflow: 'search_x', slots: { keyword: 'k', count: 'many' } });
  const typeRejected = await createPlanner({ modelPlanner: invalidType }).plan({ taskId: TASK_ID, request: request('x') });
  assert.equal(typeRejected.code, 'PLAN_SLOT_TYPE');

  const modelCrash = async () => { throw new Error('model down'); };
  const crashResult = await createPlanner({ modelPlanner: modelCrash }).plan({ taskId: TASK_ID, request: request('x') });
  assert.equal(crashResult.ok, false);
  assert.equal(crashResult.code, 'PLANNER_UNAVAILABLE');
});

test('built plans re-validate exactly and bind user/project/intent', async () => {
  const planner = createPlanner();
  const result = await planner.plan({ taskId: TASK_ID, request: request('分析这个 X 帖子 https://x.com/a/status/1234567890123456789，保存证据和分析，并生成待审核 Brief') });
  assert.equal(result.ok, true);
  const plan = result.value;
  assert.equal(validatePlanShape(plan).ok, true);
  assert.equal(plan.user_id, 'user-a');
  assert.equal(plan.project_id, 'prj-aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(plan.task_id, TASK_ID);
  assert.equal(plan.approvals.paid_external_calls, true);
  assert.equal(plan.approvals.online_writes, true);
  assert.equal(plan.approvals.handoff_creation, false);
  assert.equal(plan.cost_indicators.paid_calls, 2, 'collect + analyze are the paid calls');
  assert.equal(plan.cost_indicators.online_writes, 4, 'evidence + analysis + card + brief are writes');
  const tampered = { ...plan, slots: { ...plan.slots, url: 'https://x.com/b/status/999' } };
  assert.equal(validatePlanShape(tampered).code, 'PLAN_SLOTS_MISMATCH', 'tampered slots fail closed');
  const missingKeyword = buildPlan({ taskId: TASK_ID, request: request('x'), workflowId: 'search_x', slots: {} });
  assert.equal(missingKeyword.ok, false, 'missing required slot fails closed at build');
  assert.equal(missingKeyword.code, 'PLAN_SLOT_REQUIRED');
  assert.equal(buildPlan({ taskId: TASK_ID, request: request('x'), workflowId: 'not_a_workflow', slots: {} }).code, 'PLAN_WORKFLOW_UNKNOWN');
});

test('G1 生成执行层：图片/视频/报价/状态/产物意图精确分类且绝不发明字段', () => {
  const cases = [
    [`用 brief-${'a'.repeat(24)} 生成图片，提示词：「一只猫」`, 'generate_media', { mode: 'image', brief_id: `brief-${'a'.repeat(24)}`, prompt: '一只猫' }],
    [`用 brief-${'a'.repeat(24)} 生成视频，提示词：「海边日落」，5 秒`, 'generate_media', { mode: 'video_t2v', brief_id: `brief-${'a'.repeat(24)}`, prompt: '海边日落', duration_seconds: 5 }],
    [`用 brief-${'a'.repeat(24)} 图生视频，提示词：「参考图动画」，引用素材 ${'d'.repeat(8)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(12)}`, 'generate_media', { mode: 'video_i2v', reference_asset_id: `${'d'.repeat(8)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(12)}` }],
    [`用 brief-${'a'.repeat(24)} 生成图片，提示词：「猫」，只要报价`, 'generate_media', { submit_generation: false }],
    [`查看生成任务状态 g1j-${'e'.repeat(24)}`, 'read_generation', { job_id: `g1j-${'e'.repeat(24)}` }],
    [`打开生成产物 g1j-${'e'.repeat(24)} 的 g1x-${'f'.repeat(24)}`, 'read_generation', { job_id: `g1j-${'e'.repeat(24)}`, artifact_id: `g1x-${'f'.repeat(24)}` }],
  ];
  for (const [intent, workflow, expectedSlots] of cases) {
    const verdict = classifyIntent(intent);
    assert.equal(verdict.ok, true, intent);
    assert.equal(verdict.value.workflow, workflow, intent);
    for (const [key, value] of Object.entries(expectedSlots)) {
      assert.equal(verdict.value.slots[key], value, `${intent}: slot ${key}`);
    }
  }
  // 缺提示词/mode 绝不从噪音中发明；缺作业身份的读取 fail closed。
  const noPrompt = classifyIntent(`用 brief-${'a'.repeat(24)} 生成图片`);
  assert.equal(noPrompt.value.slots.prompt, null);
  const noMode = classifyIntent(`用 brief-${'a'.repeat(24)} 生成素材，提示词：「猫」`);
  assert.equal(noMode.value.slots.mode, null);
  const noJob = classifyIntent('查看生成任务状态');
  assert.equal(noJob.value.slots.job_id, null);
  // 既有能力不受 G1 触发器干扰。
  assert.equal(classifyIntent('生成交接包').value.workflow, 'create_handoff');
  assert.equal(classifyIntent('Generate a pending Brief from the existing analysis results').value.workflow, 'assemble_brief');
  assert.equal(classifyIntent('比较当前项目中表现最好的帖子').value.workflow, 'compare_project');
});

test('G1 生成计划：quote-only 零费用零写入；submit 双重批准且引用精确修订', () => {
  const slots = {
    brief_id: `brief-${'a'.repeat(24)}`,
    mode: 'image',
    prompt: '一只猫',
    aspect_ratio: '1:1',
    submit_generation: true,
  };
  const plan = buildPlan({ taskId: TASK_ID, request: request('生成图片'), workflowId: 'generate_media', slots });
  assert.equal(plan.ok, true, plan.code);
  assert.deepEqual(plan.value.steps.map((step) => step.operation), [
    'workspace.project.read', 'generation.quote', 'generation.submit',
  ]);
  assert.equal(plan.value.approvals.paid_external_calls, true);
  assert.equal(plan.value.approvals.online_writes, true);
  assert.equal(plan.value.cost_indicators.paid_calls, 1);
  assert.equal(plan.value.cost_indicators.online_writes, 1);
  const quoteOnly = buildPlan({ taskId: TASK_ID, request: request('只要报价'), workflowId: 'generate_media', slots: { ...slots, submit_generation: false } });
  assert.equal(quoteOnly.ok, true, quoteOnly.code);
  assert.equal(quoteOnly.value.approvals.paid_external_calls, false, 'quote-only 计划绝不要求付费批准');
  assert.equal(quoteOnly.value.cost_indicators.paid_calls, 0);
  assert.equal(quoteOnly.value.cost_indicators.online_writes, 0);
  const unbound = buildPlan({ taskId: TASK_ID, request: request('生成图片', { project_id: null }), workflowId: 'generate_media', slots });
  assert.equal(unbound.code, 'PROJECT_BINDING_REQUIRED', '生成必须绑定精确项目');
});

test('project-bound workflows fail closed at plan time without an exact project', () => {
  const unbound = request('x', { project_id: null });
  for (const [workflowId, slots] of [
    ['assemble_brief', {}],
    ['create_handoff', {}],
    ['search_x', { keyword: 'AI marketing', count: 5, save_count: 1 }],
    ['search_reddit', { keyword: 'AI marketing', count: 5, save_count: 1 }],
  ]) {
    const verdict = buildPlan({ taskId: TASK_ID, request: unbound, workflowId, slots });
    assert.equal(verdict.ok, false, workflowId);
    assert.equal(verdict.code, 'PROJECT_BINDING_REQUIRED', workflowId);
    assert.equal(verdict.diagnostics.field, 'project_id', workflowId);
  }
  const publicSearch = buildPlan({ taskId: TASK_ID, request: unbound, workflowId: 'search_x', slots: { keyword: 'AI marketing', count: 5, save_count: 0 } });
  assert.equal(publicSearch.ok, true, 'a genuinely project-independent search-only plan remains valid');
  const boundBrief = buildPlan({ taskId: TASK_ID, request: request('x'), workflowId: 'assemble_brief', slots: {} });
  assert.equal(boundBrief.ok, true, 'the same workflow is valid with an exact project binding');
});

test('Brief 身份完整令牌契约：25+ 位后缀/前缀碰撞/尾随内容绝不截断，任何业务调用前 fail closed', async () => {
  const canonical = `brief-${'a'.repeat(24)}`;
  // staging 实测身份：25 位十六进制后缀（brief- + 25 hex）。
  const legacy25 = 'brief-8a14d78ceee1a3ff2b32a076e';
  assert.equal(legacy25.length, 31);
  // 25 位后缀：完整令牌不是规范身份 → PLANNER_IDENTITY_INVALID（绝不提取
  // 前 24 位前缀，G1 报价绝不绑定截断身份）。
  const v25 = classifyIntent(`用 ${legacy25} 生成图片，提示词：「猫」`);
  assert.equal(v25.ok, false);
  assert.equal(v25.code, 'PLANNER_IDENTITY_INVALID');
  assert.equal(v25.diagnostics.field, 'brief_id');
  assert.match(v25.diagnostics.message, /24 位小写十六进制/);
  // 更长后缀同样拒绝。
  for (const token of [`brief-${'b'.repeat(32)}`, `brief-${'c'.repeat(64)}`]) {
    const verdict = classifyIntent(`用 ${token} 生成图片，提示词：「猫」`);
    assert.equal(verdict.ok, false, token);
    assert.equal(verdict.code, 'PLANNER_IDENTITY_INVALID', token);
    assert.equal(verdict.diagnostics.field, 'brief_id', token);
  }
  // 前缀碰撞 / 尾随分隔符 / 尾随字母数字 / 非纯十六进制 / 大小写不规范。
  for (const token of [
    `${canonical}-x`,
    `${canonical}_`,
    `${canonical}abc`,
    `brief-${'a'.repeat(23)}xy`,
    `brief-${'A'.repeat(24)}`,
  ]) {
    const verdict = classifyIntent(`用 ${token} 生成图片，提示词：「猫」`);
    assert.equal(verdict.ok, false, token);
    assert.equal(verdict.code, 'PLANNER_IDENTITY_INVALID', token);
  }
  // 空后缀 / 无初始十六进制字符 / 非十六进制后缀：这些 brief- 令牌同样必须
  // fail closed（PLANNER_IDENTITY_INVALID, field: brief_id），绝不静默当作
  // 无身份而放行。
  for (const token of [
    'brief-',
    `brief-${'z'.repeat(24)}`,
    `brief-${'g'.repeat(24)}`,
    'brief-xyz',
    'brief-测试',
  ]) {
    const verdict = classifyIntent(`用 ${token} 生成图片，提示词：「猫」`);
    assert.equal(verdict.ok, false, token);
    assert.equal(verdict.code, 'PLANNER_IDENTITY_INVALID', token);
    assert.equal(verdict.diagnostics.field, 'brief_id', token);
  }
  // 坏令牌出现在任何意图（即使不是生成意图）中都 fail closed。
  assert.equal(classifyIntent(`搜索 ${legacy25} 相关内容`).code, 'PLANNER_IDENTITY_INVALID');
  assert.equal(classifyIntent(`把 ${legacy25} 保存为证据`).code, 'PLANNER_IDENTITY_INVALID');
  // 规范身份不受影响：分类与完整计划构建均通过。
  const ok = classifyIntent(`用 ${canonical} 生成图片，提示词：「猫」，只要报价`);
  assert.equal(ok.ok, true, ok.code);
  assert.equal(ok.value.slots.brief_id, canonical);
  const planned = await createPlanner().plan({ taskId: TASK_ID, request: request(`用 ${canonical} 生成图片，提示词：「猫」，只要报价`) });
  assert.equal(planned.ok, true, planned.code);
  assert.equal(planned.value.slots.brief_id, canonical);
  // 计划层兜底：显式传入超长 Brief 身份槽位同样 fail closed（PLAN_SLOT_IDENTITY）。
  const slotRejected = buildPlan({
    taskId: TASK_ID,
    request: request('生成图片'),
    workflowId: 'generate_media',
    slots: { brief_id: legacy25, mode: 'image', prompt: '猫' },
  });
  assert.equal(slotRejected.ok, false);
  assert.equal(slotRejected.code, 'PLAN_SLOT_IDENTITY');
  // 坏令牌无法产生任何计划 → 不会有任何执行或业务工具调用。
  const badPlan = await createPlanner().plan({ taskId: TASK_ID, request: request(`用 ${legacy25} 生成图片，提示词：「猫」`) });
  assert.equal(badPlan.ok, false);
  assert.equal(badPlan.code, 'PLANNER_IDENTITY_INVALID');
});
