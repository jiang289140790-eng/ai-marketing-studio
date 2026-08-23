import { capabilityForWorkflow, validateCapabilityManifest } from './capability-registry.mjs';
import { validatePlanShape } from './planner.mjs';
import { validateProjectTaskMemory } from './project-task-memory.mjs';

export const EXECUTION_CRITIC_SCHEMA_VERSION = 'ams_harness_execution_critic_v1';
const TERMINAL_STEP = new Set(['succeeded', 'reused', 'failed', 'blocked', 'skipped']);

function verdict(value, code, extra = {}) {
  return { schema_version: EXECUTION_CRITIC_SCHEMA_VERSION, verdict: value, code, ...extra };
}

export function critiquePlan({ plan, capabilityManifest, memory }) {
  const manifest = validateCapabilityManifest(capabilityManifest);
  if (!manifest.ok) return { ok: false, value: verdict('blocked', manifest.code) };
  const checked = validatePlanShape(plan);
  if (!checked.ok) return { ok: false, value: verdict('blocked', 'CRITIC_PLAN_INVALID', { field: checked.diagnostics?.field || null }) };
  const capability = capabilityForWorkflow(capabilityManifest, plan.workflow);
  if (!capability) return { ok: false, value: verdict('blocked', 'CRITIC_CAPABILITY_MISSING') };
  const operations = [...new Set(plan.steps.map((step) => step.operation).filter(Boolean))];
  if (operations.some((operation) => !capability.operations.includes(operation))) {
    return { ok: false, value: verdict('blocked', 'CRITIC_OPERATION_OUTSIDE_CAPABILITY') };
  }
  const approvals = [...new Set(plan.steps.flatMap((step) => step.approval))].sort();
  if (JSON.stringify(approvals) !== JSON.stringify(capability.approvals)) {
    return { ok: false, value: verdict('blocked', 'CRITIC_APPROVAL_DRIFT') };
  }
  if (plan.project_id) {
    const memoryCheck = validateProjectTaskMemory(memory, { userId: plan.user_id, projectId: plan.project_id });
    if (!memoryCheck.ok) return { ok: false, value: verdict('blocked', memoryCheck.code) };
  }
  return { ok: true, value: verdict('pass', 'PLAN_SAFE', { safe_next_action: 'confirm_exact_plan' }) };
}

function descendants(plan, failedId) {
  const found = new Set([failedId]);
  for (const step of plan.steps) {
    if (step.depends_on.some((dependency) => found.has(dependency))) found.add(step.step);
  }
  return found;
}

export function critiqueExecution({ plan, stepStates, output }) {
  const failed = plan.steps.filter((step) => stepStates?.[step.step]?.state === 'failed');
  const blocked = plan.steps.filter((step) => ['blocked', 'skipped'].includes(stepStates?.[step.step]?.state));
  const incomplete = plan.steps.filter((step) => !TERMINAL_STEP.has(stepStates?.[step.step]?.state));
  const invalidDependency = plan.steps.find((step) => {
    const state = stepStates?.[step.step]?.state;
    return ['succeeded', 'reused'].includes(state)
      && step.depends_on.some((dependency) => !['succeeded', 'reused'].includes(stepStates?.[dependency]?.state));
  });
  if (invalidDependency) return { ok: false, value: verdict('blocked', 'CRITIC_DEPENDENCY_ORDER_INVALID', { field: invalidDependency.step, safe_next_action: 'inspect_task' }) };
  if (output?.outcome === 'succeeded' && (failed.length || blocked.length || incomplete.length)) {
    return { ok: false, value: verdict('blocked', 'CRITIC_FALSE_SUCCESS', { safe_next_action: 'inspect_task' }) };
  }
  if (failed.length === 0) {
    if (output?.outcome === 'failed' || output?.outcome === 'partial') return { ok: false, value: verdict('repair', 'CRITIC_OUTCOME_MISMATCH', { safe_next_action: 'inspect_task' }) };
    return { ok: true, value: verdict('pass', 'EXECUTION_COMPLETE', { safe_next_action: 'view_results' }) };
  }
  const retryable = failed.filter((step) => {
    const state = stepStates[step.step];
    if (step.cost === true || state?.retry_unsafe === true || state?.error?.retry_unsafe === true) return false;
    return descendants(plan, step.step).size >= 1;
  });
  if (retryable.length === 1 && failed.length === 1) {
    return { ok: true, value: verdict('repair', 'SAFE_SINGLE_STEP_RETRY', { safe_next_action: 'retry_failed_step', retry_step_id: retryable[0].step }) };
  }
  return { ok: true, value: verdict('blocked', 'RETRY_NOT_SAFE', { safe_next_action: 'create_new_plan' }) };
}
