// Exact unit tests for the fixed workflow catalog: every entry, slot schema,
// dependency graph, approval derivation and fan-out bound; unknown workflows,
// slots, fields, types, enums, sizes and identities fail closed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_DEFINITIONS } from '../tool-contract.mjs';
import { APPROVAL_SCOPES, MAX_FAN_OUT, MAX_WORKFLOW_STEPS, WORKFLOW_BY_ID, WORKFLOW_IDS, assertWorkflowIntegrity, lookupWorkflow } from '../workflow-catalog.mjs';
import { canonicalJson, derivePlanSteps, normalizeSlots, PLAN_SCHEMA_VERSION, planFingerprint, validatePlanShape } from '../planner.mjs';

test('catalog integrity: every entry, operation, scope, dependency and bound is exact', () => {
  const verdict = assertWorkflowIntegrity();
  assert.equal(verdict.ok, true, verdict.issues.join('; '));
  assert.equal(WORKFLOW_IDS.length, 14, 'the fixed catalog includes the bounded private-attachment workflow');
  for (const id of WORKFLOW_IDS) {
    const workflow = lookupWorkflow(id);
    assert.ok(workflow, `workflow ${id} resolves`);
    assert.ok(workflow.steps.length > 0 && workflow.steps.length <= MAX_WORKFLOW_STEPS);
    for (const step of workflow.steps) {
      if (step.kind === 'tool') {
        assert.ok(TOOL_DEFINITIONS[step.operation], `${id}.${step.step} operation is in TOOL_DEFINITIONS`);
      }
      for (const scope of step.approval) assert.ok(APPROVAL_SCOPES.includes(scope), `${id}.${step.step} scope known`);
      if (step.fan_out) {
        assert.ok(step.fan_out.max >= 1 && step.fan_out.max <= MAX_FAN_OUT);
        assert.equal(workflow.slots[step.fan_out.limit_slot]?.type, 'integer');
      }
      if (step.gate != null) assert.ok(Object.hasOwn(workflow.slots, step.gate), `${id}.${step.step} gate declares a slot`);
    }
  }
});

test('slot normalization rejects unknown slots, wrong types, enums, sizes and identities', () => {
  const workflow = lookupWorkflow('collect_analyze_evidence');
  assert.equal(normalizeSlots(workflow, { url: 'https://x.com/a/status/1', invented: true }).code, 'PLAN_SLOT_UNKNOWN');
  assert.equal(normalizeSlots(workflow, { url: 'https://x.com/a/status/1', persist: 'yes' }).code, 'PLAN_SLOT_TYPE');
  assert.equal(normalizeSlots(workflow, {}).code, 'PLAN_SLOT_REQUIRED');
  assert.equal(normalizeSlots(workflow, { url: 'https://x.com/a/status/1', persist: true }).ok, true);
  assert.equal(normalizeSlots(workflow, { url: 'http://insecure.example/status/1' }).code, 'PLAN_SLOT_URL_INVALID');
  assert.equal(normalizeSlots(workflow, { url: 'https://www.reddit.com/r/x/comments/ab/cd/' }).code, 'PLAN_SLOT_URL_UNSUPPORTED');
  assert.equal(normalizeSlots(workflow, { url: 'https://x.com/home' }).code, 'PLAN_SLOT_URL_INVALID');
  const search = lookupWorkflow('search_reddit');
  assert.equal(normalizeSlots(search, { keyword: 'k', count: 0 }).code, 'PLAN_SLOT_BOUNDS');
  assert.equal(normalizeSlots(search, { keyword: 'k', count: 11 }).code, 'PLAN_SLOT_BOUNDS');
  assert.equal(normalizeSlots(search, { keyword: 'k', sort: 'bogus' }).code, 'PLAN_SLOT_ENUM');
  assert.equal(normalizeSlots(search, { keyword: 'k', subreddit: 'r/BAD NAME!' }).code, 'PLAN_SLOT_ENUM');
  assert.equal(normalizeSlots(search, { keyword: 'k', save_count: 6 }).code, 'PLAN_SLOT_BOUNDS');
  const similar = lookupWorkflow('generate_similar');
  assert.equal(normalizeSlots(similar, { evidence_id: 'ev-zzz' }).code, 'PLAN_SLOT_IDENTITY');
  // analysis_id is required by the tool contract and the p22 boundary (the
  // paid draft generator needs the exact bound analysis); a plan without it
  // fails closed at plan time instead of dying at execution with an internal
  // validation error.
  assert.equal(normalizeSlots(similar, { evidence_id: 'ev-' + 'a'.repeat(24) }).code, 'PLAN_SLOT_REQUIRED');
  const identityOver = normalizeSlots(similar, { evidence_id: `ev-${'a'.repeat(24)}`, analysis_id: `an-${'b'.repeat(24)}` });
  assert.equal(identityOver.ok, true);
});

test('plan fingerprint is stable, binding-exact and tamper-sensitive', () => {
  const base = {
    schema_version: PLAN_SCHEMA_VERSION,
    plan_version: 2,
    task_id: 'ht-11111111-1111-4111-8111-111111111111',
    workflow: 'lineage_audit',
    workflow_title: '来源血缘审计',
    intent: '审计一下来源血缘',
    user_id: 'user-a',
    project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa',
    request_fingerprint: 'a'.repeat(64),
    approvals: { paid_external_calls: false, online_writes: false, handoff_creation: false },
    cost_indicators: { paid_calls: 0, online_writes: 0 },
    slots: {},
    steps: [{ step: 'st-0', key: 'audit', label: '执行血缘审计', kind: 'tool', operation: 'workspace.lineage.audit', depends_on: [], approval: [], cost: false, write: false, fan_out: null, reuse: null, terminal_artifact: 'lineage' }],
  };
  const fingerprint = planFingerprint(base);
  assert.equal(fingerprint, planFingerprint({ ...base, steps: [{ ...base.steps[0], ...{} }] }), 'identical plans fingerprint identically');
  assert.notEqual(fingerprint, planFingerprint({ ...base, user_id: 'user-b' }), 'user binding changes the fingerprint');
  assert.notEqual(fingerprint, planFingerprint({ ...base, project_id: null }), 'project binding changes the fingerprint');
  assert.notEqual(fingerprint, planFingerprint({ ...base, intent: '不同的意图' }), 'intent changes the fingerprint');
  assert.notEqual(fingerprint, planFingerprint({ ...base, slots: { x: 1 } }), 'slots change the fingerprint');
  assert.equal(validatePlanShape({ ...base, fingerprint }).ok, true);
  assert.equal(validatePlanShape({ ...base, fingerprint: 'f'.repeat(64) }).code, 'PLAN_FINGERPRINT_MISMATCH');
  assert.equal(validatePlanShape({ ...base, workflow: 'not_a_workflow', fingerprint }).code, 'PLAN_WORKFLOW_UNKNOWN');
  assert.equal(validatePlanShape({ ...base, schema_version: 'other', fingerprint }).code, 'PLAN_SCHEMA_MISMATCH');
  assert.equal(validatePlanShape({ ...base, project_id: 'prj-zz', fingerprint }).code, 'PLAN_BINDING_INVALID');
  assert.equal(validatePlanShape({ ...base, sql: 'select 1', fingerprint }).code, 'PLAN_UNKNOWN_FIELD');
});

test('approval derivation and dependency graph are exact per workflow', () => {
  const collect = lookupWorkflow('collect_analyze_evidence');
  const steps = derivePlanSteps(collect, { url: 'https://x.com/a/status/1', persist: true, analyze: true, card: true, brief: true });
  assert.deepEqual(steps.map((step) => step.step), ['st-0', 'st-1', 'st-2', 'st-3', 'st-4', 'st-5', 'st-6']);
  assert.deepEqual(steps[6].depends_on, ['st-5'], 'brief depends exactly on card');
  assert.deepEqual([...new Set(steps.flatMap((step) => step.approval))].sort(), ['online_writes', 'paid_external_calls']);
  const gated = derivePlanSteps(collect, { url: 'https://x.com/a/status/1', persist: true, analyze: false, card: false, brief: false });
  assert.deepEqual(gated.map((step) => step.step), ['st-0', 'st-1', 'st-2'], 'gates remove dependent steps exactly');
  const search = lookupWorkflow('search_x_reddit');
  const searchSteps = derivePlanSteps(search, { keyword: 'k', count: 5, save_count: 3 });
  assert.deepEqual(searchSteps.map((step) => step.step), ['st-0', 'st-1', 'st-2', 'st-3']);
  assert.deepEqual(searchSteps[3].depends_on, ['st-2'], 'combined save depends on the second search');
  assert.equal(searchSteps[3].fan_out.max, 5, 'fan-out bound is exact');
  assert.equal(searchSteps[3].fan_out.limit_slot, 'save_count', 'fan-out uses the requested save bound');
  const readOnly = derivePlanSteps(lookupWorkflow('read_capability'), {});
  assert.deepEqual(readOnly.flatMap((step) => step.approval), [], 'read-only workflow requires no approval');
  const handoff = derivePlanSteps(lookupWorkflow('create_handoff'), {});
  assert.ok(handoff.flatMap((step) => step.approval).includes('handoff_creation'), 'handoff declares handoff_creation');
});

test('G1 生成执行层工作流：quote 只读零批准；submit 付费+写入双重批准；读取零批准', () => {
  const generate = lookupWorkflow('generate_media');
  const steps = derivePlanSteps(generate, {
    brief_id: `brief-${'a'.repeat(24)}`, mode: 'image', prompt: '猫', submit_generation: true,
  });
  assert.deepEqual(steps.map((step) => step.operation), [
    'workspace.project.read', 'generation.quote', 'generation.submit',
  ]);
  assert.deepEqual(steps[2].depends_on, ['st-1'], 'submit 必须依赖 quote');
  assert.equal(steps[1].cost, false, 'quote 步骤零费用');
  assert.equal(steps[1].write, false, 'quote 步骤零写入');
  assert.deepEqual(steps[2].approval, ['paid_external_calls', 'online_writes'], 'submit 必须声明双重批准');
  assert.equal(steps[2].cost, true, 'submit 必须标记付费');
  assert.equal(steps[2].write, true, 'submit 必须标记 staging 写入');
  const quoteOnly = derivePlanSteps(generate, {
    brief_id: `brief-${'a'.repeat(24)}`, mode: 'image', prompt: '猫', submit_generation: false,
  });
  assert.deepEqual(quoteOnly.map((step) => step.operation), ['workspace.project.read', 'generation.quote'],
    'quote-only 计划绝不包含 submit 步骤');
  const read = lookupWorkflow('read_generation');
  const readSteps = derivePlanSteps(read, { job_id: `g1j-${'a'.repeat(24)}` });
  assert.deepEqual(readSteps.map((step) => step.operation), ['generation.status'], '只读状态步骤');
  assert.deepEqual(readSteps.flatMap((step) => step.approval), [], '只读读取绝不要求批准');
  const readWithArtifact = derivePlanSteps(read, { job_id: `g1j-${'a'.repeat(24)}`, artifact_id: `g1x-${'a'.repeat(24)}` });
  assert.deepEqual(readWithArtifact.map((step) => step.operation), ['generation.status', 'generation.artifact']);
  assert.equal(readWithArtifact[1].depends_on[0], 'st-0');
});

test('workflow ids and titles are stable for the UI contract', () => {
  assert.deepEqual(WORKFLOW_IDS, [
    'read_capability', 'collect_analyze_evidence', 'inspect_private_attachments', 'search_x', 'search_reddit',
    'search_x_reddit', 'analyze_evidence', 'compare_project', 'generate_similar',
    'assemble_brief', 'lineage_audit', 'create_handoff', 'generate_media', 'read_generation',
  ]);
  for (const id of WORKFLOW_IDS) assert.ok(typeof WORKFLOW_BY_ID[id].title === 'string' && WORKFLOW_BY_ID[id].title.length > 0);
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }), 'canonical JSON is key-order stable');
});
