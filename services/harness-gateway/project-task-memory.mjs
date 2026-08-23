import { createHash } from 'node:crypto';
import { WORKFLOW_IDS } from './workflow-catalog.mjs';

export const PROJECT_TASK_MEMORY_SCHEMA_VERSION = 'ams_harness_project_task_memory_v1';
export const MAX_MEMORY_ITEMS = 8;
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const MEMORY_WORKFLOWS = new Set([...WORKFLOW_IDS, 'legacy']);
const SAFE_REF = /^(?:ev|an|kc|brief|g1j|g1x|handoff)-[a-z0-9-]{1,120}$/;

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function userBinding(userId) {
  return createHash('sha256').update(String(userId)).digest('hex');
}

export function buildProjectTaskMemory({ tasks = [], userId, projectId, limit = MAX_MEMORY_ITEMS } = {}) {
  if (typeof userId !== 'string' || !userId || typeof projectId !== 'string' || !/^prj-[0-9a-f]{24}$/.test(projectId)) {
    return { ok: false, code: 'PROJECT_MEMORY_BINDING_INVALID' };
  }
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_MEMORY_ITEMS, limit)) : MAX_MEMORY_ITEMS;
  const items = tasks
    .filter((task) => task?.request?.user_id === userId && task?.request?.project_id === projectId && TERMINAL.has(task?.state))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, safeLimit)
    .map((task) => ({
      workflow: MEMORY_WORKFLOWS.has(task?.plan?.workflow) ? task.plan.workflow : 'legacy',
      state: task.state,
      artifact_refs: [...new Set((task?.result?.artifact_refs || []).filter((ref) => typeof ref === 'string' && SAFE_REF.test(ref)))].slice(0, 10),
      critic_verdict: ['pass', 'repair', 'blocked'].includes(task?.h2_context?.postflight_critic?.verdict)
        ? task.h2_context.postflight_critic.verdict
        : null,
    }));
  const body = {
    schema_version: PROJECT_TASK_MEMORY_SCHEMA_VERSION,
    user_binding: userBinding(userId),
    project_id: projectId,
    items,
  };
  return { ok: true, value: { ...body, fingerprint: fingerprint(body) } };
}

export function validateProjectTaskMemory(memory, { userId, projectId } = {}) {
  const rebuilt = buildProjectTaskMemory({ tasks: [], userId, projectId });
  if (!rebuilt.ok || !memory || typeof memory !== 'object' || Array.isArray(memory)) return { ok: false, code: 'PROJECT_MEMORY_INVALID' };
  if (memory.schema_version !== PROJECT_TASK_MEMORY_SCHEMA_VERSION) return { ok: false, code: 'PROJECT_MEMORY_SCHEMA_MISMATCH' };
  if (memory.user_binding !== userBinding(userId) || memory.project_id !== projectId) return { ok: false, code: 'PROJECT_MEMORY_CROSS_BOUNDARY' };
  if (!Array.isArray(memory.items) || memory.items.length > MAX_MEMORY_ITEMS) return { ok: false, code: 'PROJECT_MEMORY_INVALID' };
  const body = { schema_version: memory.schema_version, user_binding: memory.user_binding, project_id: memory.project_id, items: memory.items };
  if (memory.fingerprint !== fingerprint(body)) return { ok: false, code: 'PROJECT_MEMORY_TAMPERED' };
  for (const item of memory.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, code: 'PROJECT_MEMORY_INVALID' };
    if (!MEMORY_WORKFLOWS.has(item.workflow) || !TERMINAL.has(item.state)) return { ok: false, code: 'PROJECT_MEMORY_INVALID' };
    if (!Array.isArray(item.artifact_refs) || item.artifact_refs.some((ref) => typeof ref !== 'string' || !SAFE_REF.test(ref))) return { ok: false, code: 'PROJECT_MEMORY_INVALID' };
    if (item.critic_verdict !== null && !['pass', 'repair', 'blocked'].includes(item.critic_verdict)) return { ok: false, code: 'PROJECT_MEMORY_INVALID' };
  }
  return { ok: true, value: globalThis.structuredClone(memory) };
}

export function memoryForPlanner(memory) {
  return {
    prior_workflows: memory?.items?.map((item) => item.workflow).slice(0, MAX_MEMORY_ITEMS) || [],
    prior_terminal_states: memory?.items?.map((item) => item.state).slice(0, MAX_MEMORY_ITEMS) || [],
    artifact_types: [...new Set((memory?.items || []).flatMap((item) => item.artifact_refs.map((ref) => ref.split('-')[0])))],
  };
}
