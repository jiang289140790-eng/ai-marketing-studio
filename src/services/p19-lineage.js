// P19 世系审计：复刻已验收 P16 的有界 fail-closed 世系投影（本地纯函数）。
//
// 把 P16 的 7 步外部链（handoff import → draft → review → plan → readiness →
// preparation → ledger）映射为 P19 的本地研究链：
//   research_project → evidence_record → deterministic_analysis →
//   knowledge_card → content_brief → review_decision → handoff_package
//
// - 节点状态：current / invalid / stale（已验收 P16 源状态）。
// - 审计状态优先级（已验收）：INVALID_SOURCE > BROKEN > PARTIAL > COMPLETE。
// - 诊断：missing / duplicate / wrong-binding（固定文案，有界，不回显无界原始值）。
// - 输出深克隆 + 深冻结；行上限 100、原因上限 8、计数如实。
// - 纯本地投影：不创建、不导入、不修改、不生成、不路由、不发布任何记录。

import {
  BRIEF_ID_PATTERN,
  EXECUTION_FLAG_KEYS,
  LINEAGE_SCHEMA_VERSION,
  MAX_DISPLAY_TEXT,
  MAX_ID_TEXT,
  MAX_SHORT_TEXT,
  boundedText,
  clonePlain,
  evidenceProofFingerprint,
  resolveBriefEvidenceBindings,
  deepFreeze,
  isNonEmptyString,
  isPlainObject,
  validateAnalysis,
  validateBrief,
  validateEvidenceRecord,
  validateHandoffPackageRecord,
  validateKnowledgeCard,
  validateProject,
} from './p19-contracts.js';

export const LINEAGE_NODE_TYPES = Object.freeze([
  'research_project',
  'evidence_record',
  'deterministic_analysis',
  'knowledge_card',
  'content_brief',
  'review_decision',
  'handoff_package',
]);

export const LINEAGE_EDGE_KINDS = Object.freeze([
  'project_to_evidence',
  'evidence_to_analysis',
  'analysis_to_card',
  'card_to_brief',
  'brief_to_decision',
  'brief_to_handoff',
]);

export const AUDIT_STATES = ['COMPLETE', 'PARTIAL', 'BROKEN', 'INVALID_SOURCE'];
export const STATE_SEVERITY = { INVALID_SOURCE: 3, BROKEN: 2, PARTIAL: 1, COMPLETE: 0 };

export const SOURCE_STATES = ['current', 'invalid', 'stale'];

export const MAX_AUDIT_ROWS = 100;
export const MAX_REASONS = 8;

const REASON_UNBOUND_ANALYSIS = '分析绑定的证据不存在或绑定错误。';
const REASON_UNBOUND_CARD = '知识卡绑定的分析不存在或绑定错误。';
const REASON_UNBOUND_HANDOFF_BRIEF = '交接包绑定的 Brief 与当前版本不一致。';
const _REASON_DUPLICATE_BRIEF = '存在多份 Brief（同一项目）。';
const REASON_DUPLICATE_HANDOFF = '存在重复的交接包（同一项目出现多份）。';
const _REASON_DOWNSTREAM_WITHOUT_UPSTREAM = '存在下游记录但缺少必要的上游记录。';
const REASON_MISSING_EVIDENCE = '没有证据记录。';
const REASON_MISSING_ANALYSIS = '没有确定性分析记录。';
const REASON_MISSING_CARD = '没有知识卡。';
const REASON_MISSING_BRIEF = '没有 Brief。';
const REASON_MISSING_DECISION = '没有审核决定。';
const REASON_MISSING_HANDOFF = '没有交接包。';

/**
 * 构建单个项目的世系审计行（已验收 P16 resolveLineage 的本地映射）。
 * 返回深冻结行；任何调用方改写都会抛错。
 */
export function buildProjectLineageRow(project) {
  const reasons = [];
  let state = 'COMPLETE';
  let p5Valid = false;

  function addReason(reason) {
    if (reasons.length < MAX_REASONS && !reasons.includes(reason)) reasons.push(reason);
  }

  const identities = {
    project_id: isPlainObject(project) && isNonEmptyString(project.id) ? boundedText(project.id, MAX_ID_TEXT) : '',
    evidence_ids: [],
    analysis_ids: [],
    card_ids: [],
    brief_id: '',
    review_decision_ids: [],
    handoff_package_ids: [],
  };

  if (!isPlainObject(project)) {
    return deepFreeze({
      project_id: '',
      topic: '',
      objective: '',
      state: 'INVALID_SOURCE',
      deepest_step: 0,
      p5_valid: false,
      identities,
      reasons: Object.freeze(['项目记录不是对象。']),
      reasons_truncated: false,
      execution_flags: null,
      evaluated_at: '',
    });
  }

  const projectVerdict = validateProject(project);
  if (!projectVerdict.valid) {
    addReason('项目记录未通过 P19 项目契约校验。');
    state = 'INVALID_SOURCE';
  }

  // ---- 收集全部记录（先声明，供缺失判断使用）----
  const evidence = Array.isArray(project.evidence) ? project.evidence : [];
  const analyses = Array.isArray(project.analyses) ? project.analyses : [];
  const cards = Array.isArray(project.knowledge_cards) ? project.knowledge_cards : [];
  const brief = project.brief || null;
  const handoffs = Array.isArray(project.handoffs)
    ? project.handoffs
    : project.handoff
      ? [project.handoff]
      : [];
  const briefCount = brief ? 1 : 0;
  // 与已验收 SQL 契约一致：节点缺失时若有任何下游记录 → BROKEN，否则 PARTIAL。
  const hasDownstream = (step) => {
    if (step === 'evidence') return analyses.length + cards.length + briefCount + handoffs.length > 0;
    if (step === 'analysis') return cards.length + briefCount + handoffs.length > 0;
    if (step === 'card') return briefCount + handoffs.length > 0;
    if (step === 'brief') return handoffs.length > 0;
    if (step === 'decision') return handoffs.length > 0;
    return false;
  };

  // ---- 证据节点 ----
  let evidenceInvalid = 0;
  for (const record of evidence) {
    const valid = validateEvidenceRecord(record).valid;
    if (!valid) evidenceInvalid += 1;
    identities.evidence_ids.push(boundedText(record && record.id, MAX_ID_TEXT));
  }
  if (evidenceInvalid > 0) {
    addReason('存在未通过校验的证据记录（invalid 源）。');
    state = 'INVALID_SOURCE';
  }
  if (state !== 'INVALID_SOURCE' && evidence.length === 0) {
    state = hasDownstream('evidence') ? 'BROKEN' : 'PARTIAL';
    addReason(REASON_MISSING_EVIDENCE);
  }

  // ---- 分析节点：校验 + 证据绑定 + 源指纹（stale）----
  const evidenceById = new Map(evidence.map((record) => [record.id, record]));
  let analysesInvalid = 0;
  for (const record of analyses) {
    const valid = validateAnalysis(record).valid;
    if (!valid) {
      analysesInvalid += 1;
    } else {
      const bound = evidenceById.get(record.evidence_id);
      if (!bound) {
        addReason(REASON_UNBOUND_ANALYSIS);
        state = 'BROKEN';
      } else if (record.evidence_fingerprint !== bound.fingerprint || record.evidence_version !== bound.version) {
        addReason('分析引用的证据快照已过时（stale 源）。');
        state = 'INVALID_SOURCE';
      }
    }
    identities.analysis_ids.push(boundedText(record && record.id, MAX_ID_TEXT));
  }
  if (analysesInvalid > 0) {
    addReason('存在未通过校验的分析记录（invalid 源）。');
    state = 'INVALID_SOURCE';
  }
  if (state === 'COMPLETE' && analyses.length === 0) {
    state = hasDownstream('analysis') ? 'BROKEN' : 'PARTIAL';
    addReason(REASON_MISSING_ANALYSIS);
  }

  // ---- 知识卡节点：校验 + 分析绑定 + 源指纹 ----
  const analysisById = new Map(analyses.map((record) => [record.id, record]));
  let cardsInvalid = 0;
  for (const record of cards) {
    const valid = validateKnowledgeCard(record).valid;
    if (!valid) {
      cardsInvalid += 1;
    } else {
      const bound = analysisById.get(record.analysis_id);
      if (!bound) {
        addReason(REASON_UNBOUND_CARD);
        state = 'BROKEN';
      } else if (record.analysis_fingerprint !== bound.fingerprint || record.analysis_version !== bound.version) {
        addReason('知识卡引用的分析快照已过时（stale 源）。');
        state = 'INVALID_SOURCE';
      }
    }
    identities.card_ids.push(boundedText(record && record.id, MAX_ID_TEXT));
  }
  if (cardsInvalid > 0) {
    addReason('存在未通过校验的知识卡（invalid 源）。');
    state = 'INVALID_SOURCE';
  }
  if (state === 'COMPLETE' && cards.length === 0) {
    state = hasDownstream('card') ? 'BROKEN' : 'PARTIAL';
    addReason(REASON_MISSING_CARD);
  }

  // ---- Brief 节点：校验 + 知识卡绑定 + 快照指纹 ----
  if (brief) {
    identities.brief_id = boundedText(brief.id, MAX_ID_TEXT);
    if (!validateBrief(brief).valid) {
      addReason('Brief 未通过 P19 Brief 契约校验。');
      state = 'INVALID_SOURCE';
    } else {
      const cardById = new Map(cards.map((record) => [record.id, record]));
      const snapshots = isPlainObject(brief.card_fingerprints) ? brief.card_fingerprints : {};
      const binding = resolveBriefEvidenceBindings(project, brief.knowledge_citation_ids);
      const missingOrWrong = !binding.valid || (brief.knowledge_citation_ids || []).some((cardId) => {
        const card = cardById.get(cardId);
        if (!card) return true;
        return snapshots[cardId] !== card.fingerprint;
      });
      const evidenceFingerprintWrong = binding.valid
        && brief.evidence_provenance_fingerprint !== evidenceProofFingerprint(binding.evidence);
      if (missingOrWrong || evidenceFingerprintWrong) {
        addReason('Brief 引用的知识卡/证据快照已过时（stale 源）。');
        state = 'INVALID_SOURCE';
      }
    }
  }
  if (state === 'COMPLETE' && !brief) {
    state = hasDownstream('brief') ? 'BROKEN' : 'PARTIAL';
    addReason(REASON_MISSING_BRIEF);
  }

  // ---- 审核决定节点 ----
  const review = isPlainObject(brief && brief.review) ? brief.review : null;
  const decision = review && isPlainObject(review.decision) ? review.decision : null;
  const decisionFound = decision && BRIEF_ID_PATTERN.test(String(review && review.brief_id || ''));
  if (decisionFound) {
    identities.review_decision_ids.push(boundedText(String(decision.decided_at || review.brief_id), MAX_ID_TEXT));
  } else if (state !== 'INVALID_SOURCE') {
    addReason(REASON_MISSING_DECISION);
    state = hasDownstream('decision') ? 'BROKEN' : 'PARTIAL';
  }

  // ---- 交接包节点：已验收 P5 校验 + 非 false 标志 + Brief 绑定 ----
  for (const record of handoffs) {
    const verdict = validateHandoffPackageRecord(record);
    if (!verdict.valid) {
      addReason(`交接包未通过 P5 验证：${verdict.issues[0] || 'invalid 源。'}`);
      state = 'INVALID_SOURCE';
    } else {
      p5Valid = true;
      if (isPlainObject(record.execution_flags)) {
        for (const key of EXECUTION_FLAG_KEYS) {
          if (record.execution_flags[key] !== false) {
            addReason(`${key} 不是严格布尔 false。`);
            state = 'INVALID_SOURCE';
          }
        }
      }
      const provenance = record.brief_provenance;
      if (brief && provenance && (
        provenance.brief_id !== brief.id
        || provenance.brief_version !== brief.version
        || provenance.brief_status !== brief.status
      )) {
        addReason(REASON_UNBOUND_HANDOFF_BRIEF);
        state = 'BROKEN';
      }
      if (!brief) {
        addReason(REASON_UNBOUND_HANDOFF_BRIEF);
        state = 'BROKEN';
      }
    }
    identities.handoff_package_ids.push(boundedText(record && record.id, MAX_ID_TEXT));
  }
  if (state === 'COMPLETE' && handoffs.length === 0) {
    state = 'PARTIAL';
    addReason(REASON_MISSING_HANDOFF);
  }
  if (handoffs.length > 1) {
    addReason(REASON_DUPLICATE_HANDOFF);
    state = 'BROKEN';
  }

  // ---- 最深步骤（展示用）----
  let deepestStep = 0;
  if (identities.project_id) deepestStep = 1;
  if (identities.evidence_ids.length > 0) deepestStep = 2;
  if (identities.analysis_ids.length > 0) deepestStep = 3;
  if (identities.card_ids.length > 0) deepestStep = 4;
  if (identities.brief_id) deepestStep = 5;
  if (identities.review_decision_ids.length > 0) deepestStep = 6;
  if (identities.handoff_package_ids.length > 0) deepestStep = 7;

  // 与已验收 P17 vg_lineage_audit_v1 SQL 契约一致：
  // 绑定错误/重复/下游缺上游 → BROKEN（无论下游有多深），不冒泡为 PARTIAL；
  // 仅「末端步骤缺失」→ PARTIAL。

  const executionFlags = handoffs[0] && isPlainObject(handoffs[0].execution_flags)
    ? EXECUTION_FLAG_KEYS.reduce((acc, key) => ({ ...acc, [key]: handoffs[0].execution_flags[key] === true }), {})
    : null;

  return deepFreeze({
    project_id: identities.project_id,
    topic: isPlainObject(project) && isNonEmptyString(project.topic) ? boundedText(project.topic, MAX_DISPLAY_TEXT) : '',
    objective: isPlainObject(project) && isNonEmptyString(project.objective) ? boundedText(project.objective, MAX_DISPLAY_TEXT) : '',
    state,
    deepest_step: deepestStep,
    p5_valid: p5Valid,
    identities: deepFreeze(clonePlain(identities)),
    reasons: Object.freeze(reasons.slice(0, MAX_REASONS)),
    reasons_truncated: reasons.length > MAX_REASONS,
    execution_flags: executionFlags,
    evaluated_at: isPlainObject(project) && isNonEmptyString(project.updated_at) ? boundedText(project.updated_at, MAX_SHORT_TEXT) : '',
  });
}


/**
 * 纯确定性世系审计投影：对每个项目构建一行审计（已验收 P16 buildLineageAudit 本地映射）。
 * - 输出深克隆 + 深冻结；行按严重度降序 → 最深步骤降序 → 项目 id 升序；
 * - 行上限 100、原因上限 8、计数如实；任何调用方改写都会抛错。
 */
export function buildLineageAudit(projects = []) {
  const source = Array.isArray(projects) ? projects : [];
  const rows = source
    .map((project) => buildProjectLineageRow(project))
    .sort((a, b) => {
      const bySev = STATE_SEVERITY[b.state] - STATE_SEVERITY[a.state];
      if (bySev !== 0) return bySev;
      const byStep = b.deepest_step - a.deepest_step;
      if (byStep !== 0) return byStep;
      return String(a.project_id).localeCompare(String(b.project_id));
    });
  const counts = { total: rows.length };
  for (const state of AUDIT_STATES) counts[state] = rows.filter((row) => row.state === state).length;
  return deepFreeze({
    ok: true,
    schema_version: LINEAGE_SCHEMA_VERSION,
    rows: rows.slice(0, MAX_AUDIT_ROWS),
    total: rows.length,
    truncated: rows.length > MAX_AUDIT_ROWS,
    max_rows: MAX_AUDIT_ROWS,
    counts,
  });
}

/** 有界搜索与状态筛选（已验收 P16 filterAudit 本地映射）。 */
export function filterLineageAudit(rows, { query = '', states = [] } = {}) {
  const clean = String(query || '').trim().toLowerCase().slice(0, 200);
  const allowed = Array.isArray(states) && states.length > 0 ? new Set(states) : null;
  const selected = rows.filter((row) => {
    if (allowed && !allowed.has(row.state)) return false;
    if (!clean) return true;
    return [row.project_id, row.topic, row.objective].some((value) => value && value.toLowerCase().includes(clean));
  });
  return deepFreeze(selected.map((row) => deepFreeze(clonePlain(row))));
}

/** 节点/边展示投影：为单个项目构建有界 nodes/edges 列表（只读，不修改输入）。 */
export function buildProjectLineageGraph(project) {
  const nodes = [];
  const edges = [];
  if (!isPlainObject(project)) {
    return deepFreeze({ nodes: [], edges: [], schema_version: LINEAGE_SCHEMA_VERSION });
  }
  const pushNode = (id, type, state, reason) => {
    nodes.push(deepFreeze({
      id: boundedText(id, MAX_ID_TEXT),
      type,
      source_state: state,
      reason: reason || '',
    }));
  };
  const pushEdge = (fromId, toId, kind) => {
    edges.push(deepFreeze({
      from: boundedText(fromId, MAX_ID_TEXT),
      to: boundedText(toId, MAX_ID_TEXT),
      edge_kind: kind,
    }));
  };

  const projectValid = validateProject(project).valid;
  pushNode(project.id, 'research_project', projectValid ? 'current' : 'invalid', projectValid ? '' : '项目记录未通过校验。');

  const evidence = Array.isArray(project.evidence) ? project.evidence : [];
  const evidenceById = new Map();
  for (const record of evidence) {
    const valid = validateEvidenceRecord(record).valid;
    pushNode(record.id, 'evidence_record', valid ? 'current' : 'invalid', valid ? '' : '证据记录未通过校验。');
    evidenceById.set(record.id, record);
    pushEdge(project.id, record.id, 'project_to_evidence');
  }

  const analyses = Array.isArray(project.analyses) ? project.analyses : [];
  const analysisById = new Map();
  for (const record of analyses) {
    const valid = validateAnalysis(record).valid;
    const bound = evidenceById.get(record.evidence_id);
    const stale = valid && bound && (record.evidence_fingerprint !== bound.fingerprint || record.evidence_version !== bound.version);
    pushNode(record.id, 'deterministic_analysis', stale ? 'stale' : valid ? 'current' : 'invalid', stale ? '证据快照已过时。' : valid ? '' : '分析记录未通过校验。');
    analysisById.set(record.id, record);
    pushEdge(record.evidence_id, record.id, 'evidence_to_analysis');
  }

  const cards = Array.isArray(project.knowledge_cards) ? project.knowledge_cards : [];
  const cardById = new Map();
  for (const record of cards) {
    const valid = validateKnowledgeCard(record).valid;
    const bound = analysisById.get(record.analysis_id);
    const stale = valid && bound && (record.analysis_fingerprint !== bound.fingerprint || record.analysis_version !== bound.version);
    pushNode(record.id, 'knowledge_card', stale ? 'stale' : valid ? 'current' : 'invalid', stale ? '分析快照已过时。' : valid ? '' : '知识卡未通过校验。');
    cardById.set(record.id, record);
    pushEdge(record.analysis_id, record.id, 'analysis_to_card');
  }

  const brief = project.brief || null;
  if (brief) {
    const valid = validateBrief(brief).valid;
    pushNode(brief.id, 'content_brief', valid ? 'current' : 'invalid', valid ? '' : 'Brief 未通过校验。');
    for (const cardId of (brief.knowledge_citation_ids || [])) {
      pushEdge(cardId, brief.id, 'card_to_brief');
    }
  }

  const decision = brief && brief.review && brief.review.decision ? brief.review.decision : null;
  if (decision) {
    const decisionId = `decision-${String(decision.decided_at || '').slice(0, 40)}`;
    pushNode(decisionId, 'review_decision', 'current', '');
    pushEdge(brief.id, decisionId, 'brief_to_decision');
  }

  const handoffs = Array.isArray(project.handoffs)
    ? project.handoffs
    : project.handoff
      ? [project.handoff]
      : [];
  for (const record of handoffs) {
    const verdict = validateHandoffPackageRecord(record);
    pushNode(record.id, 'handoff_package', verdict.valid ? 'current' : 'invalid', verdict.valid ? '' : '交接包未通过 P5 校验。');
    if (brief && brief.id) pushEdge(brief.id, record.id, 'brief_to_handoff');
  }

  return deepFreeze({
    schema_version: LINEAGE_SCHEMA_VERSION,
    nodes,
    edges,
  });
}
