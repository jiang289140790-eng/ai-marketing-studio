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
    ['compare_project', { count: 2 }, 0, 2],
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
