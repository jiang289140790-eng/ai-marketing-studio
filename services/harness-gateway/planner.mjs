// Harness plan builder (v1). The plan is the authoritative, immutable,
// schema-validated execution contract produced by the Gateway.
//
// Planning never executes business tools. It may use the configured model
// ONLY to select one fixed workflow id and extract bounded scalar slots
// (injectable `modelPlanner`); the exact same fail-closed slot normalization
// applies to model output and to the deterministic intent classifier, so an
// unknown workflow, slot, field, type, enum, size or identity fails closed
// before any business tool call. The plan carries a stable SHA-256 fingerprint
// over canonical JSON, exact trusted user/project binding, the required
// approval scopes, cost/write indicators and the ordered, dependency-bound
// step graph.
import { createHash } from 'node:crypto';
import { identifyPublicPostUrl } from '../../supabase/functions/p22-research-assist/assist-core.mjs';
import { APPROVAL_SCOPES, MAX_WORKFLOW_STEPS, lookupWorkflow } from './workflow-catalog.mjs';

export const PLAN_SCHEMA_VERSION = 'ams_harness_plan_v1';
export const PLAN_VERSION = 2;
export const MAX_PLAN_INTENT = 12_000;
export const REQUEST_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
export const STEP_ID_PATTERN = /^st-\d+$/;
export const ITEM_ID_PATTERN = /^st-\d+#\d+$/;

const POST_URL_PATTERN = /(https?:\/\/[^\s，,。；;）)>"\]]+)/iu;
const INTEGER_PATTERN = /(\d{1,2})\s*条/;
const SAVE_COUNT_PATTERNS = [
  /选\s*(\d{1,2})\s*条/,
  /保存(?:前|其中|这)?\s*(\d{1,2})\s*条/,
  /save\s+(?:the\s+)?(?:top\s+)?(\d{1,2})\b/i,
  /(\d{1,2})\s*(?:条)?\s*保存/,
];

// Non-anchored extraction patterns for identity claims inside free text; the
// anchored catalog patterns remain the exact slot validators.
const IDENTITY_CLAIMS = [
  [/(ev-[0-9a-f]{24})/i, 'evidence_id'],
  [/(an-[0-9a-f]{24})/i, 'analysis_id'],
];

const SEARCH_TRIGGERS = /搜索|搜一搜|热门|话题|查找|search\b|find\b|trending|hot topic/i;
const X_TRIGGERS = /(?:^|[^a-z])\bx\b|twitter|推特|X 平台|X 帖子|x 帖子|x 内容/i;
const REDDIT_TRIGGERS = /reddit|红迪/i;
const BRIEF_TRIGGERS = /brief|待审核简报|生成简报|简报|待审核\s*brief|审阅?brief/i;
const CARD_TRIGGERS = /知识卡|knowledge\s*card/i;
const ANALYZE_TRIGGERS = /分析|多模态|analy[sz]e\b|analysis\b/i;
const PERSIST_TRIGGERS = /保存|存档|持久化|persist\b|save\b|evidence\b|证据/i;
const HANDOFF_TRIGGERS = /交接包|交接|handoff|hand[- ]?off/i;
const COMPARE_TRIGGERS = /比较|对比|compare\b|best[- ]?performing|表现最好|表现最佳/i;
// Chinese highest-metric requests select the fixed compare_project metric
// slot. 展现量/浏览量/播放量/曝光量 all use the canonical views metric
// (they never get an invented number); 互动 uses the single documented
// engagement formula. The classifier never invents a metric — a phrase with
// no metric word falls back to the documented default engagement slot.
const METRIC_VIEWS_TRIGGERS = /展现量|浏览量|播放量|曝光(?:量|度)?|most\s+viewed|highest\s+views|impressions?\b/i;
const METRIC_ENGAGEMENT_TRIGGERS = /互动(?:量|数|指标)?|engagement\b/i;
// Persisting the comparison requires an explicit user approval; a compare
// intent only opts in with explicit save language ("保存的比较" as in already
// saved evidence never does).
const COMPARE_PERSIST_TRIGGERS = /保存(?!的|过)|存档|persist\b|save\b/i;
const SIMILAR_TRIGGERS = /类似|相似|相似内容|相似风格|generate\s+similar|similar\s+content|草案|draft\b/i;
const LINEAGE_TRIGGERS = /溯源|血缘|审计|lineage|audit\b/i;
const CAPABILITY_TRIGGERS = /能力|capabilit|当前项目|项目状态|项目信息|read\s+(?:the\s+)?project|what\s+can/i;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Canonical JSON: stable key order, so fingerprints survive field reordering. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function planFingerprint(plan) {
  const { fingerprint: _fingerprint, ...body } = plan;
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

function fail(code, diagnostics = {}) {
  return { ok: false, code, diagnostics };
}

/**
 * Fail-closed normalization of candidate slots against the workflow slot
 * schema. Unknown slot, field, type, enum, size or identity values are
 * rejected — never coerced, truncated or silently dropped.
 */
export function normalizeSlots(workflow, candidate) {
  if (candidate != null && !plainObject(candidate)) return fail('PLAN_SLOT_INVALID', { field: 'slots' });
  const raw = candidate ?? {};
  const unknown = Object.keys(raw).find((key) => !Object.hasOwn(workflow.slots, key));
  if (unknown) return fail('PLAN_SLOT_UNKNOWN', { field: unknown });
  const slots = {};
  for (const [key, schema] of Object.entries(workflow.slots)) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') {
      if (schema.required) return fail('PLAN_SLOT_REQUIRED', { field: key });
      if (schema.default !== undefined) slots[key] = schema.default;
      continue;
    }
    switch (schema.type) {
      case 'boolean': {
        if (typeof value !== 'boolean') return fail('PLAN_SLOT_TYPE', { field: key });
        slots[key] = value;
        break;
      }
      case 'integer': {
        const numeric = typeof value === 'string' && /^\d+$/.test(value);
        const number = numeric ? Number(value) : value;
        if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
          return fail('PLAN_SLOT_TYPE', { field: key });
        }
        if (number < schema.min || number > schema.max) {
          return fail('PLAN_SLOT_BOUNDS', { field: key });
        }
        slots[key] = number;
        break;
      }
      case 'enum': {
        if (typeof value !== 'string' || !schema.values.includes(value)) return fail('PLAN_SLOT_ENUM', { field: key });
        slots[key] = value;
        break;
      }
      case 'url':
      case 'string': {
        if (typeof value !== 'string') return fail('PLAN_SLOT_TYPE', { field: key });
        const text = value.trim();
        if (!text || text.length > schema.max) return fail('PLAN_SLOT_BOUNDS', { field: key });
        if (schema.pattern && !schema.pattern.test(text)) return fail('PLAN_SLOT_ENUM', { field: key });
        if (schema.type === 'url') {
          // identifyPublicPostUrl is the authoritative exact-post validator
          // (HTTPS only, exact X status page); Reddit permalinks are
          // identified but not yet collectable and fail closed.
          let identity;
          try {
            identity = identifyPublicPostUrl(text);
          } catch {
            return fail('PLAN_SLOT_URL_INVALID', { field: key });
          }
          if (!identity || identity.supported !== true) {
            return fail('PLAN_SLOT_URL_UNSUPPORTED', { field: key, diagnostics: { message: '当前仅支持具体 X 帖子链接；Reddit 帖子请使用搜索工作流。' } });
          }
          slots[key] = identity.canonical_url;
        } else {
          slots[key] = text;
        }
        break;
      }
      case 'identity': {
        if (typeof value !== 'string') return fail('PLAN_SLOT_TYPE', { field: key });
        const text = value.trim();
        if (!text || text.length > schema.max || !schema.pattern.test(text)) return fail('PLAN_SLOT_IDENTITY', { field: key });
        slots[key] = text;
        break;
      }
      default:
        return fail('PLAN_SLOT_INVALID', { field: key });
    }
  }
  return { ok: true, value: slots };
}

/** Deterministic flag normalization for collect_analyze_evidence. */
function normalizeFlags(slots) {
  const next = { ...slots };
  if (next.brief) { next.card = true; next.analyze = true; next.persist = true; }
  if (next.card) { next.analyze = true; next.persist = true; }
  if (next.analyze) next.persist = true;
  return next;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) return Number(match[1]);
  }
  return null;
}

const KEYWORD_NOISE = /\b(?:x|twitter|reddit)\b|推特|红迪|帖子|主题|话题|热门|最|本周|今天|最近|搜索|搜一搜|search|find|trending|和|与|上|在|中|里|的|了|条|保存|证据|分析|选/gi;

/**
 * Deterministic metric extraction for compare intents. Views synonyms
 * (展现量/浏览量/播放量/曝光量) all map to the canonical `views` metric;
 * 互动 maps to `engagement`. Views is checked first so an ambiguous phrase
 * is never silently re-ranked by aggregate engagement.
 */
function extractCompareMetric(text) {
  if (METRIC_VIEWS_TRIGGERS.test(text)) return 'views';
  if (METRIC_ENGAGEMENT_TRIGGERS.test(text)) return 'engagement';
  return null;
}

function extractKeyword(intent) {
  let text = String(intent).replace(POST_URL_PATTERN, ' ').replace(/r\/[A-Za-z0-9_]{2,32}/gi, ' ').trim();
  const quoted = /["“]([^"”]{1,240})["”]/.exec(text);
  if (quoted) return quoted[1].trim();
  const split = /(?:搜索|搜一搜|search|find|trending)\s*[:：]?\s*([^，,。；;]+)/i.exec(text);
  if (split && split[1] && split[1].trim()) text = split[1];
  const candidate = text.replace(KEYWORD_NOISE, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  return candidate || null;
}

/**
 * Deterministic intent classifier: maps a natural-language intent to one
 * fixed workflow id plus bounded scalar slots. Any unrecognized or ambiguous
 * intent fails closed — the model never invents workflows or payloads.
 */
export function classifyIntent(intent) {
  const text = String(intent ?? '').trim();
  if (!text || text.length > MAX_PLAN_INTENT) return fail('PLANNER_INTENT_INVALID');
  const urlMatch = POST_URL_PATTERN.exec(text);
  const claims = {};
  for (const [pattern, key] of IDENTITY_CLAIMS) {
    const match = pattern.exec(text);
    if (match) claims[key] = match[1];
  }

  if (HANDOFF_TRIGGERS.test(text)) {
    return { ok: true, value: { workflow: 'create_handoff', slots: {} } };
  }
  if (urlMatch) {
    if (!ANALYZE_TRIGGERS.test(text) && !PERSIST_TRIGGERS.test(text) && !BRIEF_TRIGGERS.test(text) && !CARD_TRIGGERS.test(text)) {
      return { ok: true, value: { workflow: 'collect_analyze_evidence', slots: { url: urlMatch[1], persist: false, analyze: false, card: false, brief: false } } };
    }
    return {
      ok: true,
      value: {
        workflow: 'collect_analyze_evidence',
        slots: {
          url: urlMatch[1],
          persist: PERSIST_TRIGGERS.test(text) || ANALYZE_TRIGGERS.test(text) || BRIEF_TRIGGERS.test(text) || CARD_TRIGGERS.test(text),
          analyze: ANALYZE_TRIGGERS.test(text) || BRIEF_TRIGGERS.test(text) || CARD_TRIGGERS.test(text),
          card: CARD_TRIGGERS.test(text) || BRIEF_TRIGGERS.test(text),
          brief: BRIEF_TRIGGERS.test(text),
        },
      },
    };
  }
  const bothPlatforms = X_TRIGGERS.test(text) && REDDIT_TRIGGERS.test(text);
  if (SEARCH_TRIGGERS.test(text) && (bothPlatforms || X_TRIGGERS.test(text) || REDDIT_TRIGGERS.test(text))) {
    const keyword = extractKeyword(text);
    if (!keyword) return fail('PLANNER_SLOT_REQUIRED', { field: 'keyword' });
    const saveCount = firstMatch(text, SAVE_COUNT_PATTERNS) ?? 0;
    // A save phrase ("选 N 条保存") never doubles as the search count; the
    // search count comes from a separate bounded count phrase.
    const countText = text.replace(/选\s*\d{1,2}\s*条|保存(?:前|其中|这)?\s*\d{1,2}\s*条/gi, ' ');
    const count = firstMatch(countText, [INTEGER_PATTERN]) ?? 5;
    if (bothPlatforms) return { ok: true, value: { workflow: 'search_x_reddit', slots: { keyword, count, save_count: saveCount } } };
    if (REDDIT_TRIGGERS.test(text)) {
      const slots = { keyword, count, save_count: saveCount };
      const subreddit = /r\/([A-Za-z0-9_]{2,32})/.exec(text);
      if (subreddit) slots.subreddit = subreddit[1];
      const timeMatch = /(hour|day|week|month|year|all)\b/i.exec(text);
      if (timeMatch) slots.time_filter = timeMatch[1].toLowerCase();
      return { ok: true, value: { workflow: 'search_reddit', slots } };
    }
    return { ok: true, value: { workflow: 'search_x', slots: { keyword, count, save_count: saveCount } } };
  }
  const metric = extractCompareMetric(text);
  if (COMPARE_TRIGGERS.test(text) || metric) {
    // A metric phrase always selects compare_project with the exact metric;
    // generic compare/best-performing phrases keep the documented default.
    const slots = { count: firstMatch(text, [INTEGER_PATTERN]) ?? 5 };
    if (metric) slots.metric = metric;
    if (COMPARE_PERSIST_TRIGGERS.test(text)) slots.persist = true;
    return { ok: true, value: { workflow: 'compare_project', slots } };
  }
  if (SIMILAR_TRIGGERS.test(text)) {
    return { ok: true, value: { workflow: 'generate_similar', slots: { evidence_id: claims.evidence_id ?? null, analysis_id: claims.analysis_id ?? null } } };
  }
  if (BRIEF_TRIGGERS.test(text)) {
    return { ok: true, value: { workflow: 'assemble_brief', slots: {} } };
  }
  if (ANALYZE_TRIGGERS.test(text)) {
    return { ok: true, value: { workflow: 'analyze_evidence', slots: { count: firstMatch(text, [INTEGER_PATTERN]) ?? 5 } } };
  }
  if (LINEAGE_TRIGGERS.test(text)) {
    return { ok: true, value: { workflow: 'lineage_audit', slots: {} } };
  }
  if (CAPABILITY_TRIGGERS.test(text)) {
    return { ok: true, value: { workflow: 'read_capability', slots: {} } };
  }
  return fail('PLANNER_UNRECOGNIZED');
}

/** Gated step graph for one plan: only steps whose gate slot is true. */
export function derivePlanSteps(workflow, slots) {
  const steps = [];
  const byKey = new Map();
  for (const template of workflow.steps) {
    // Gates are deterministic slot predicates: boolean flags must be true,
    // integer fan-out counts are included when non-zero.
    if (template.gate != null && !slots[template.gate]) continue;
    const step = {
      step: `st-${byKey.size}`,
      key: template.step,
      label: template.label,
      kind: template.kind,
      operation: template.operation,
      depends_on: template.depends_on.map((key) => byKey.get(key) || null).filter(Boolean),
      approval: [...template.approval],
      cost: template.cost === true,
      write: template.write === true,
      fan_out: template.fan_out ? {
        source: template.fan_out.source,
        max: template.fan_out.max,
        limit_slot: template.fan_out.limit_slot,
      } : null,
      reuse: template.reuse ? { kind: template.reuse.kind, rule: template.reuse.rule, note: template.reuse.note } : null,
      terminal_artifact: template.terminal_artifact,
    };
    byKey.set(template.step, step.step);
    steps.push(step);
  }
  return steps;
}

/**
 * Build the authoritative plan for one trusted task request. `workflowId` and
 * `slots` come from the deterministic classifier or from an injectable model
 * planner; both run through the same fail-closed normalization below.
 */
export function buildPlan({ taskId, request, workflowId, slots: candidateSlots }) {
  if (typeof taskId !== 'string' || !/^ht-[0-9a-f-]{36}$/.test(taskId)) return fail('PLAN_TASK_ID_INVALID');
  if (!request || typeof request !== 'object') return fail('PLAN_REQUEST_INVALID');
  if (typeof request.user_id !== 'string' || !request.user_id.trim()) return fail('PLAN_BINDING_INVALID', { field: 'user_id' });
  if (request.project_id != null && (typeof request.project_id !== 'string' || !request.project_id.trim())) {
    return fail('PLAN_BINDING_INVALID', { field: 'project_id' });
  }
  if (typeof request.intent !== 'string' || !request.intent.trim() || request.intent.length > MAX_PLAN_INTENT) {
    return fail('PLAN_INTENT_INVALID');
  }
  const workflow = lookupWorkflow(workflowId);
  if (!workflow) return fail('PLAN_WORKFLOW_UNKNOWN', { field: workflowId ?? null });
  const normalized = normalizeSlots(workflow, candidateSlots);
  if (!normalized.ok) return normalized;
  const slots = workflow.id === 'collect_analyze_evidence' ? normalizeFlags(normalized.value) : normalized.value;
  const steps = derivePlanSteps(workflow, slots);
  if (steps.length === 0 || steps.length > MAX_WORKFLOW_STEPS) return fail('PLAN_STEPS_INVALID');
  // A plan that reads or writes workspace state must be bound to one exact
  // project before it becomes authoritative. Public research-only plans may
  // remain project-independent, but a later confirmation must never authorize
  // a plan that is already guaranteed to fail at its first workspace step.
  // (Local deterministic steps carry no operation and are never project
  // boundaries by themselves.)
  const requiresProject = steps.some((step) => step.write === true
    || (typeof step.operation === 'string' && step.operation.startsWith('workspace.')));
  if (requiresProject && !request.project_id?.trim()) {
    return fail('PROJECT_BINDING_REQUIRED', { field: 'project_id' });
  }
  const approvals = {};
  for (const scope of APPROVAL_SCOPES) {
    approvals[scope] = steps.some((step) => step.approval.includes(scope));
  }
  const plannedCallCount = (step) => {
    if (!step.fan_out) return 1;
    const requested = slots[step.fan_out.limit_slot];
    if (!Number.isSafeInteger(requested)) return 0;
    return Math.min(step.fan_out.max, requested);
  };
  const costIndicators = {
    paid_calls: steps.reduce((sum, step) => sum + (step.cost ? plannedCallCount(step) : 0), 0),
    online_writes: steps.reduce((sum, step) => sum + (step.write ? plannedCallCount(step) : 0), 0),
  };
  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    plan_version: PLAN_VERSION,
    task_id: taskId,
    workflow: workflow.id,
    workflow_title: workflow.title,
    intent: request.intent.trim(),
    user_id: request.user_id.trim(),
    project_id: request.project_id?.trim() || null,
    request_fingerprint: request.request_fingerprint,
    approvals,
    cost_indicators: costIndicators,
    slots,
    steps,
  };
  const validation = validatePlanShape(plan);
  if (!validation.ok) return fail('PLAN_BUILD_INVALID', validation.diagnostics);
  plan.fingerprint = planFingerprint(plan);
  return { ok: true, value: plan };
}

/**
 * Fail-closed shape validation of a complete plan (fresh or reloaded from
 * persistence). Unknown field, workflow, slot, type, enum, size, identity or
 * a fingerprint mismatch fails closed.
 */
export function validatePlanShape(plan) {
  if (!plainObject(plan)) return fail('PLAN_INVALID');
  const allowed = new Set([
    'schema_version', 'plan_version', 'task_id', 'workflow', 'workflow_title', 'intent',
    'user_id', 'project_id', 'request_fingerprint', 'approvals', 'cost_indicators',
    'slots', 'steps', 'fingerprint',
  ]);
  const unknown = Object.keys(plan).find((key) => !allowed.has(key));
  if (unknown) return fail('PLAN_UNKNOWN_FIELD', { field: unknown });
  if (plan.schema_version !== PLAN_SCHEMA_VERSION) return fail('PLAN_SCHEMA_MISMATCH');
  if (plan.plan_version !== PLAN_VERSION) return fail('PLAN_VERSION_MISMATCH');
  if (typeof plan.task_id !== 'string' || !/^ht-[0-9a-f-]{36}$/.test(plan.task_id)) return fail('PLAN_TASK_ID_INVALID');
  const workflow = lookupWorkflow(plan.workflow);
  if (!workflow) return fail('PLAN_WORKFLOW_UNKNOWN', { field: plan.workflow });
  if (typeof plan.workflow_title !== 'string' || plan.workflow_title !== workflow.title) return fail('PLAN_WORKFLOW_TITLE_MISMATCH');
  if (typeof plan.intent !== 'string' || !plan.intent.trim() || plan.intent.length > MAX_PLAN_INTENT) return fail('PLAN_INTENT_INVALID');
  if (typeof plan.user_id !== 'string' || !plan.user_id.trim()) return fail('PLAN_BINDING_INVALID', { field: 'user_id' });
  if (plan.project_id != null && (typeof plan.project_id !== 'string' || !/^prj-[0-9a-f]{24}$/.test(plan.project_id))) {
    return fail('PLAN_BINDING_INVALID', { field: 'project_id' });
  }
  if (typeof plan.request_fingerprint !== 'string' || !REQUEST_FINGERPRINT_PATTERN.test(plan.request_fingerprint)) {
    return fail('PLAN_REQUEST_FINGERPRINT_INVALID');
  }
  if (!plainObject(plan.approvals)) return fail('PLAN_APPROVALS_INVALID');
  for (const scope of APPROVAL_SCOPES) {
    if (typeof plan.approvals[scope] !== 'boolean') return fail('PLAN_APPROVALS_INVALID', { field: scope });
  }
  if (!plainObject(plan.cost_indicators)
    || !Number.isSafeInteger(plan.cost_indicators.paid_calls) || plan.cost_indicators.paid_calls < 0
    || !Number.isSafeInteger(plan.cost_indicators.online_writes) || plan.cost_indicators.online_writes < 0) {
    return fail('PLAN_COST_INDICATORS_INVALID');
  }
  const normalizedSlots = normalizeSlots(workflow, plan.slots);
  if (!normalizedSlots.ok) return normalizedSlots;
  const expectedSlots = workflow.id === 'collect_analyze_evidence'
    ? normalizeFlags(normalizedSlots.value)
    : normalizedSlots.value;
  // Defaulted slots may be absent from plans persisted before the slot was
  // added to the fixed catalog; every slot that IS present must still equal
  // the fail-closed normalization exactly. Anything stale or tampered is
  // caught here (types/enums/unknowns) and by the fingerprint binding below.
  const storedSlots = {};
  for (const key of Object.keys(plan.slots)) storedSlots[key] = expectedSlots[key];
  if (canonicalJson(storedSlots) !== canonicalJson(plan.slots)) return fail('PLAN_SLOTS_MISMATCH');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_WORKFLOW_STEPS) {
    return fail('PLAN_STEPS_INVALID');
  }
  const stepKeys = new Set();
  const expectedSteps = derivePlanSteps(workflow, expectedSlots);
  if (canonicalJson(expectedSteps) !== canonicalJson(plan.steps)) return fail('PLAN_STEPS_MISMATCH');
  for (const step of plan.steps) {
    if (!STEP_ID_PATTERN.test(step.step)) return fail('PLAN_STEP_ID_INVALID', { field: step.step });
    if (stepKeys.has(step.step)) return fail('PLAN_STEP_DUPLICATE', { field: step.step });
    stepKeys.add(step.step);
    for (const dependency of step.depends_on) {
      if (!STEP_ID_PATTERN.test(dependency) || !stepKeys.has(dependency)) {
        return fail('PLAN_STEP_DEPENDENCY_INVALID', { field: dependency });
      }
    }
  }
  if (plan.fingerprint !== undefined) {
    if (typeof plan.fingerprint !== 'string' || !REQUEST_FINGERPRINT_PATTERN.test(plan.fingerprint)) {
      return fail('PLAN_FINGERPRINT_INVALID');
    }
    if (planFingerprint(plan) !== plan.fingerprint) return fail('PLAN_FINGERPRINT_MISMATCH');
  }
  return { ok: true, value: plan };
}

/**
 * Planner facade. `modelPlanner` is optional and, when configured, may select
 * the workflow id and slots from the intent — its output is normalized by the
 * exact same fail-closed path as the deterministic classifier.
 */
export function createPlanner({ modelPlanner = null } = {}) {
  return {
    async plan({ taskId, request }) {
      let classification;
      if (modelPlanner) {
        let raw;
        try {
          raw = await modelPlanner(request.intent);
        } catch {
          return fail('PLANNER_UNAVAILABLE');
        }
        if (raw && raw.ok === false) return raw;
        if (!raw || !plainObject(raw) || typeof raw.workflow !== 'string') {
          return fail('PLANNER_OUTPUT_INVALID');
        }
        classification = { ok: true, value: raw };
      } else {
        classification = classifyIntent(request.intent);
      }
      if (classification.ok !== true) {
        return classification && classification.ok === false
          ? classification
          : fail('PLANNER_UNRECOGNIZED');
      }
      if (!plainObject(classification.value) || typeof classification.value.workflow !== 'string') {
        return fail('PLANNER_OUTPUT_INVALID');
      }
      const built = buildPlan({
        taskId,
        request,
        workflowId: classification.value.workflow,
        slots: classification.value.slots,
      });
      if (!built.ok) return built;
      return { ok: true, value: built.value };
    },
  };
}
