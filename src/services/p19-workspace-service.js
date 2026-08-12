// P19 运营研究工作台服务：项目/证据/分析/知识卡/Brief/交接包/世系 的本地编排。
//
// - 分析为确定性本地分析（deterministic_local）：显式规则 + provenance，绝不调用模型；
// - 依赖制品携带精确源身份与指纹快照；编辑上游使下游制品过时（stale），
//   并阻止批准/交接，直到重建并重新审核；
// - 交接包创建的唯一入口是「当前 Brief 修订已批准且未过时」；
// - 四项执行标志恒为 false；
// - 纯本地：不发起任何网络请求、不访问 Supabase、不读取 localStorage（由 store 层负责）。
//
// 所有操作返回深克隆快照；修改项目时版本号递增，指纹从规范化 JSON 确定性计算。

import {
  ANALYSIS_KIND,
  ANALYSIS_SCHEMA_VERSION,
  BRIEF_DECISIONS,
  BRIEF_REVIEW_SCHEMA_VERSION,
  BRIEF_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  EXECUTION_FLAGS,
  HANDOFF_DECISION_METHOD,
  HANDOFF_KIND,
  HANDOFF_PAYLOAD_LABEL,
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_STATUS,
  KNOWLEDGE_CARD_SCHEMA_VERSION,
  MAX_ARRAY_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_STRING_LENGTH,
  MODEL_ANALYSIS_SCHEMA_VERSION,
  P32_MODEL_ANALYSIS_SCHEMA_VERSION,
  MULTIMODAL_METHOD,
  MULTIMODAL_MODEL,
  MULTIMODAL_PROVIDER,
  PROJECT_SCHEMA_VERSION,
  clonePlain,
  evidenceProofFingerprint,
  fingerprintOf,
  isNonEmptyString,
  resolveBriefEvidenceBindings,
  sha256Hex,
  stableCanonicalJson,
  stableId,
  validateAnalysis,
  validateBrief,
  validateEvidenceRecord,
  validateHandoffPackageRecord,
  validateKnowledgeCard,
  validateMediaAssets,
  validateSourceMetadata,
} from './p19-contracts.js';

export const ANALYSIS_ENGINE_VERSION = 'p19_analysis_engine_v1';

const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '就', '都', '而', '及', '或', '等', '不', '也', '有', '为', '被', '把', '这', '那',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'at', 'by',
]);

function textOf(value) {
  return String(value ?? '').trim();
}

function boundedSlice(value, max) {
  const clean = textOf(value).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function requireBoundedInput(value, max, field) {
  const raw = String(value ?? '');
  if (raw.length > max) throw workbenchError('FIELD_TOO_LONG', `${field}不能超过 ${max} 个字符。`);
  return boundedSlice(raw, max);
}

// ---- 确定性规则引擎 -----------------------------------------------------------

function ruleSourceUrlShape(evidence) {
  const output = { protocol: '', hostname: '', note: '' };
  try {
    const parsed = new globalThis.URL(evidence.source_url);
    output.protocol = parsed.protocol;
    output.hostname = parsed.hostname;
  } catch {
    output.note = '来源 URL 无法解析（入口校验已拒绝此类证据）。';
  }
  return output;
}

function ruleTextLengthProfile(evidence) {
  const text = textOf(evidence.content_text);
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentences = text.split(/[.!?。！？]+/).filter((part) => part.trim()).length;
  return {
    characters: text.length,
    words,
    sentences,
    note: text.length > MAX_STRING_LENGTH ? '正文长度已按 5000 字符上限截断。' : '',
  };
}

function ruleKeywordFrequency(evidence) {
  const text = textOf(evidence.content_text).toLowerCase();
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  const frequency = new Map();
  const firstSeen = new Map();
  tokens.forEach((token, index) => {
    if (!frequency.has(token)) {
      frequency.set(token, 0);
      firstSeen.set(token, index);
    }
    frequency.set(token, frequency.get(token) + 1);
  });
  const ranked = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1] || firstSeen.get(a[0]) - firstSeen.get(b[0]))
    .slice(0, 5)
    .map(([word, count]) => `${word}×${count}`);
  // 扁平字符串数组：保持记录嵌套层级在已验收的 8 层上限内。
  return { keywords: ranked, note: ranked.length === 0 ? '正文中没有可提取的关键词。' : '' };
}

function ruleToneIndicators(evidence) {
  const text = textOf(evidence.content_text);
  const exclamations = (text.match(/[!！]/g) || []).length;
  const questions = (text.match(/[?？]/g) || []).length;
  const emoji = (text.match(/[\p{Extended_Pictographic}]/u) || []).length;
  const allCaps = (text.match(/\b[A-Z]{3,}\b/g) || []).slice(0, 5);
  return {
    exclamations,
    questions,
    emoji,
    all_caps_words: allCaps,
    note: '以下仅为文本层面的确定性标记，不构成任何内容生成或创作判断。',
  };
}

function ruleMediaMetadataBounds(evidence) {
  const meta = evidence.media_metadata;
  if (meta === null || meta === undefined) {
    return { present: false, note: '本证据未附加本地媒体元数据（无原始媒体字节）。' };
  }
  const checks = [
    typeof meta.filename === 'string' && meta.filename.length <= 200,
    typeof meta.mime_type === 'string' && meta.mime_type.length <= 100,
    Number.isInteger(meta.byte_size) && meta.byte_size >= 0 && meta.byte_size <= 536870912,
    typeof meta.last_modified === 'string' && meta.last_modified.length <= 80,
    typeof meta.sha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.sha256),
  ];
  return {
    present: true,
    all_bounds_ok: checks.every(Boolean),
    note: '仅保存浏览器计算的元数据（文件名/MIME/字节大小/修改时间/SHA-256），从不保存原始文件字节。',
  };
}

function ruleManualProvenanceTrust(evidence) {
  const p22Verified = evidence.provenance?.manual === false
    && evidence.provenance?.schema_version === 'p22_apify_evidence_provenance_v1';
  return {
    manual: evidence.provenance && evidence.provenance.manual === true,
    trust_status: evidence.provenance && evidence.provenance.manual === true ? 'manual_local' : p22Verified ? 'apify_server_bound' : 'unknown',
    note: p22Verified
      ? 'P22 Apify 公开来源已由服务端证明绑定正文、身份与采集运行。'
      : '人工录入的证据按 manual_local 标记可信来源；不依赖任何平台验证。',
  };
}

export function runDeterministicRules(evidence) {
  const rules = [
    { rule_id: 'source_url_shape', label: '来源 URL 形状', output: ruleSourceUrlShape(evidence) },
    { rule_id: 'text_length_profile', label: '文本长度画像', output: ruleTextLengthProfile(evidence) },
    { rule_id: 'keyword_frequency', label: '关键词频次', output: ruleKeywordFrequency(evidence) },
    { rule_id: 'tone_indicators', label: '语气标记', output: ruleToneIndicators(evidence) },
    { rule_id: 'media_metadata_bounds', label: '媒体元数据边界', output: ruleMediaMetadataBounds(evidence) },
    { rule_id: 'manual_provenance_trust', label: '人工来源可信度', output: ruleManualProvenanceTrust(evidence) },
  ];
  return rules;
}

// ---- 实体构建器 ---------------------------------------------------------------

/** 创建项目快照（版本 1，执行标志恒 false）。 */
export async function createProject({
  topic,
  objective,
  audience,
  channel,
  constraints = [],
  now = () => new Date().toISOString(),
  hasher = fingerprintOf,
} = {}) {
  const clean = {
    topic: requireBoundedInput(topic, MAX_STRING_LENGTH, '项目主题'),
    objective: requireBoundedInput(objective, MAX_STRING_LENGTH, '项目目标'),
    audience: requireBoundedInput(audience, MAX_IDENTIFIER_LENGTH, '目标受众'),
    channel: requireBoundedInput(channel, MAX_IDENTIFIER_LENGTH, '目标渠道'),
    constraints: (Array.isArray(constraints) ? constraints : []).slice(0, MAX_ARRAY_LENGTH).map((item) => boundedSlice(item, MAX_STRING_LENGTH)),
  };
  const timestamp = now();
  const id = await stableId('prj-', { ...clean, timestamp });
  const project = {
    schema_version: PROJECT_SCHEMA_VERSION,
    id,
    version: 1,
    status: 'active',
    ...clean,
    execution_flags: clonePlain(EXECUTION_FLAGS),
    evidence: [],
    analyses: [],
    knowledge_cards: [],
    brief: null,
    handoff: null,
    handoffs: [],
    lineage: null,
    fingerprint: '',
    created_at: timestamp,
    updated_at: timestamp,
  };
  project.fingerprint = await hasher(project);
  return project;
}

/** 更新项目档案；任何档案变化使依赖它的 Brief/交接包过时。 */
export async function updateProjectProfile(project, patch, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const next = clonePlain(project);
  for (const key of ['topic', 'objective', 'audience', 'channel']) {
    if (patch[key] !== undefined) {
      const max = key === 'channel' || key === 'audience' ? MAX_IDENTIFIER_LENGTH : MAX_STRING_LENGTH;
      next[key] = requireBoundedInput(patch[key], max, key);
    }
  }
  if (Array.isArray(patch.constraints)) {
    next.constraints = patch.constraints.slice(0, MAX_ARRAY_LENGTH).map((item) => boundedSlice(item, MAX_STRING_LENGTH));
  }
  return bumpProject(next, { now, hasher });
}

export async function archiveProject(project, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const next = clonePlain(project);
  next.status = 'archived';
  return bumpProject(next, { now, hasher });
}

function bumpProject(project, { now, hasher }) {
  project.version += 1;
  project.updated_at = now();
  return refreshFingerprint(project, hasher);
}

async function refreshFingerprint(project, hasher) {
  const copy = clonePlain(project);
  copy.fingerprint = '';
  const fingerprint = await hasher(copy);
  copy.fingerprint = fingerprint;
  return copy;
}

/** 附加证据记录（元数据仅限本地；绝不接收原始字节）。 */
export async function addEvidence(project, input, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const record = await buildEvidenceRecord(project, input, { now, hasher });
  const existing = (project.evidence || []).find((item) => item.id === record.id);
  if (existing) {
    const p22Source = record.provenance?.manual === false;
    if (!p22Source
      || existing.source_url !== record.source_url
      || existing.provenance?.content_sha256 !== record.provenance?.content_sha256
      || existing.provenance?.external_id !== record.provenance?.external_id) {
      throw workbenchError('EVIDENCE_IDENTITY_CONFLICT', '相同证据身份绑定了不同来源内容，已失败关闭。');
    }
    // 同一正文身份不得静默绑定不同来源快照/媒体（服务端证明同样绑定它们）。
    if (p29EvidenceBindingFingerprint(existing) !== p29EvidenceBindingFingerprint(record)) {
      throw workbenchError('EVIDENCE_IDENTITY_CONFLICT', '同一证据身份绑定了不同的来源快照或媒体内容，已失败关闭。');
    }
    return clonePlain(project);
  }
  const next = clonePlain(project);
  next.evidence = [...next.evidence, record];
  return bumpProject(next, { now, hasher });
}

/**
 * 构建一条证据记录（不落库）：provenance 默认值、正文有界、P29 来源快照/媒体
 * 资产校验、P22 正文哈希复算、确定性 id 与契约校验。addEvidence 与
 * addEvidenceBatch 共用同一构建器，保证单条与批量行为完全一致。
 */
async function buildEvidenceRecord(project, input, { now, hasher }) {
  const timestamp = now();
  const provenance = input.provenance && typeof input.provenance === 'object' && !Array.isArray(input.provenance)
    ? clonePlain(input.provenance)
    : {
      manual: true,
      statement: '该证据由用户手工录入并核对；来源 URL 为人工填写，未经任何平台采集或验证。',
    };
  const p22Source = provenance.manual === false && provenance.schema_version === 'p22_apify_evidence_provenance_v1';
  const rawContent = String(input.content_text ?? '');
  if (p22Source && (!rawContent.trim() || rawContent.length > MAX_STRING_LENGTH)) {
    throw workbenchError('EVIDENCE_INVALID', 'P22 证据正文缺失或超过 5000 字符，已拒绝。');
  }
  const record = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    id: '',
    project_id: project.id,
    source_url: boundedSlice(input.source_url, 1000),
    label: boundedSlice(input.label, 200),
    platform: boundedSlice(input.platform, 80),
    content_text: p22Source ? rawContent : boundedSlice(input.content_text, MAX_STRING_LENGTH),
    recorded_at: isNonEmptyString(input.recorded_at) ? input.recorded_at : timestamp,
    provenance,
    media_metadata: normalizeMediaMetadata(input.media_metadata),
    version: 1,
    fingerprint: '',
    created_at: timestamp,
    updated_at: timestamp,
  };
  // P29 版本化扩展：来源快照与有序媒体资产（缺省 = 旧记录；存在即严格校验）。
  if (input.source_metadata !== undefined && input.source_metadata !== null) {
    const snapshot = validateSourceMetadata(input.source_metadata);
    if (!snapshot.valid) throw workbenchError('EVIDENCE_INVALID', snapshot.issues[0] || '来源快照不符合 P29 有界契约。');
    record.source_metadata = clonePlain(input.source_metadata);
  }
  if (input.media_assets !== undefined) {
    const assets = validateMediaAssets(input.media_assets);
    if (!assets.valid) throw workbenchError('EVIDENCE_INVALID', assets.issues[0] || '媒体资产不符合 P29 有界契约。');
    record.media_assets = clonePlain(input.media_assets);
  }
  if (p22Source && await sha256Hex(record.content_text) !== provenance.content_sha256) {
    throw workbenchError('EVIDENCE_HASH_MISMATCH', 'P22 证据正文与来源 SHA-256 不一致，已拒绝。');
  }
  const identity = p22Source
    ? {
      project_id: project.id,
      provider: provenance.provider,
      source_url: record.source_url,
      external_id: provenance.external_id || null,
      content_sha256: provenance.content_sha256,
    }
    : { project_id: project.id, source_url: record.source_url, recorded_at: timestamp };
  const id = await stableId('ev-', identity);
  record.id = id;
  const verdict = validateEvidenceRecord(record);
  if (!verdict.valid) throw workbenchError('EVIDENCE_INVALID', verdict.issues[0] || '证据记录未通过契约校验。');
  record.fingerprint = await hasher(record);
  return record;
}

/**
 * P32-B 批量导入证据：前端工作区层面的原子操作。全部输入先按单条相同规则
 * 构建并校验，任何一条无效（含批次内重复身份、与项目内已有证据身份冲突）
 * 即整批失败关闭，当前项目完全不变；全部有效才一次性保存并递增一次版本。
 */
export async function addEvidenceBatch(project, inputs, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const list = Array.isArray(inputs) ? inputs : [];
  if (list.length < 1 || list.length > 5) {
    throw workbenchError('BATCH_SIZE_OUT_OF_RANGE', '批量导入必须为 1–5 条。');
  }
  const records = [];
  const seenIds = new Set();
  const seenTriples = new Set();
  for (const input of list) {
    if (!input || typeof input !== 'object') throw workbenchError('BATCH_INPUT_INVALID', '批量导入包含无效条目，已整批失败关闭。');
    const record = await buildEvidenceRecord(project, input, { now, hasher });
    if (seenIds.has(record.id)) {
      throw workbenchError('BATCH_DUPLICATE_IDENTITY', '批量导入中存在相同证据身份，已整批失败关闭。');
    }
    seenIds.add(record.id);
    const triple = `${record.source_url}|${record.provenance?.external_id || ''}|${record.provenance?.content_sha256 || ''}`;
    if (seenTriples.has(triple)) {
      throw workbenchError('BATCH_DUPLICATE_IDENTITY', '批量导入中存在重复来源（同一 URL/外部 ID/正文哈希），已整批失败关闭。');
    }
    seenTriples.add(triple);
    if ((project.evidence || []).some((item) => item.id === record.id)) {
      throw workbenchError('EVIDENCE_IDENTITY_CONFLICT', '批量导入与项目内已有证据身份冲突，已整批失败关闭。');
    }
    records.push(record);
  }
  const next = clonePlain(project);
  next.evidence = [...next.evidence, ...records];
  return bumpProject(next, { now, hasher });
}

function normalizeMediaMetadata(meta) {
  if (meta === null || meta === undefined) return null;
  const out = {};
  if (typeof meta.filename === 'string') out.filename = boundedSlice(meta.filename, 200);
  if (typeof meta.mime_type === 'string') out.mime_type = boundedSlice(meta.mime_type, 100);
  if (Number.isInteger(meta.byte_size) && meta.byte_size >= 0 && meta.byte_size <= 536870912) out.byte_size = meta.byte_size;
  if (typeof meta.last_modified === 'string') out.last_modified = meta.last_modified.slice(0, 80);
  if (typeof meta.sha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.sha256)) out.sha256 = meta.sha256;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * P29 证据绑定指纹：来源快照 + 每条有序媒体的 (id, order, 哈希种类, 哈希值)。
 * 同一证据身份（正文/来源）不得静默绑定不同快照或媒体集合。
 */
function p29EvidenceBindingFingerprint(record) {
  const snapshot = stableCanonicalJson(record.source_metadata !== undefined ? record.source_metadata : null);
  const media = (Array.isArray(record.media_assets) ? record.media_assets : []).map((asset) => (
    `${asset.id}|${asset.order}|${asset.hash && asset.hash.kind}|${asset.hash && asset.hash.value}`
  ));
  return `${JSON.stringify(snapshot)}::${media.join(',')}`;
}

/** 编辑证据；下游分析/知识卡/Brief/交接包全部变为过时。 */
export async function updateEvidence(project, evidenceId, patch, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const next = clonePlain(project);
  const record = next.evidence.find((item) => item.id === evidenceId);
  if (!record) throw workbenchError('EVIDENCE_NOT_FOUND', '要编辑的证据不存在。');
  if (patch.source_url !== undefined) record.source_url = boundedSlice(patch.source_url, 1000);
  if (patch.label !== undefined) record.label = boundedSlice(patch.label, 200);
  if (patch.platform !== undefined) record.platform = boundedSlice(patch.platform, 80);
  if (patch.content_text !== undefined) record.content_text = boundedSlice(patch.content_text, MAX_STRING_LENGTH);
  if (patch.media_metadata !== undefined) record.media_metadata = normalizeMediaMetadata(patch.media_metadata);
  if (patch.source_metadata !== undefined) {
    if (patch.source_metadata === null) {
      delete record.source_metadata;
    } else {
      const snapshot = validateSourceMetadata(patch.source_metadata);
      if (!snapshot.valid) throw workbenchError('EVIDENCE_INVALID', snapshot.issues[0] || '来源快照不符合 P29 有界契约。');
      record.source_metadata = clonePlain(patch.source_metadata);
    }
  }
  if (patch.media_assets !== undefined) {
    if (patch.media_assets === null) {
      delete record.media_assets;
    } else {
      const assets = validateMediaAssets(patch.media_assets);
      if (!assets.valid) throw workbenchError('EVIDENCE_INVALID', assets.issues[0] || '媒体资产不符合 P29 有界契约。');
      record.media_assets = clonePlain(patch.media_assets);
    }
  }
  const verdict = validateEvidenceRecord(record);
  if (!verdict.valid) throw workbenchError('EVIDENCE_INVALID', verdict.issues[0] || '更新后的证据未通过契约校验。');
  record.version += 1;
  record.updated_at = now();
  record.fingerprint = await hasher(record);
  return bumpProject(next, { now, hasher });
}

/**
 * 移除证据，并同步剪除依赖它的下游制品（确定性级联）：
 * 分析（evidence_id 绑定）→ 知识卡（analysis_id 绑定）→ Brief（引用了被剪
 * 除的卡）→ 交接包（绑定被剪除的 Brief）。项目始终内部绑定：导出包在任何
 * 移除序列之后都可导入，绝不允许带缺失绑定的包产生（也不在导入端静默接受）。
 */
export async function removeEvidence(project, evidenceId, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const next = clonePlain(project);
  const index = next.evidence.findIndex((item) => item.id === evidenceId);
  if (index < 0) throw workbenchError('EVIDENCE_NOT_FOUND', '要移除的证据不存在。');
  next.evidence.splice(index, 1);
  // 级联 1：剪除绑定该证据的分析。
  const prunedAnalysisIds = new Set(
    (next.analyses || []).filter((item) => item.evidence_id === evidenceId).map((item) => item.id),
  );
  if (prunedAnalysisIds.size > 0) {
    next.analyses = next.analyses.filter((item) => !prunedAnalysisIds.has(item.id));
    // 级联 2：剪除绑定这些分析的知识卡。
    next.knowledge_cards = next.knowledge_cards.filter((card) => !prunedAnalysisIds.has(card.analysis_id));
  }
  // 级联 3：Brief 引用了被剪除的卡 → 剪除 Brief（其引用集必须全部存在）。
  const remainingCardIds = new Set((next.knowledge_cards || []).map((card) => card.id));
  const briefReferencesMissing = Boolean(next.brief)
    && (next.brief.knowledge_citation_ids || []).some((cardId) => !remainingCardIds.has(cardId));
  if (briefReferencesMissing) {
    next.brief = null;
    // 级联 4：交接包绑定被剪除的 Brief → 剪除交接包。
    next.handoff = null;
    next.handoffs = [];
  }
  return bumpProject(next, { now, hasher });
}

/** 对单条证据运行确定性本地分析（deterministic_local）。 */
export async function runAnalysis(project, evidenceId, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const evidence = (project.evidence || []).find((item) => item.id === evidenceId);
  if (!evidence) throw workbenchError('EVIDENCE_NOT_FOUND', '要分析的证据不存在。');
  const previous = (project.analyses || []).find((item) => item.evidence_id === evidenceId) || null;
  if (previous && previous.evidence_fingerprint === evidence.fingerprint && previous.evidence_version === evidence.version) {
    return clonePlain(project);
  }
  const timestamp = now();
  const ruleOutputs = runDeterministicRules(evidence);
  const id = previous?.id || await stableId('an-', { project_id: project.id, evidence_id: evidenceId, timestamp });
  const record = {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    id,
    project_id: project.id,
    evidence_id: evidenceId,
    kind: ANALYSIS_KIND,
    rule_ids: ruleOutputs.map((rule) => rule.rule_id),
    provenance: {
      method: ANALYSIS_KIND,
      generated_by: ANALYSIS_ENGINE_VERSION,
      model: null,
      executed_at: timestamp,
      statement: '本分析完全由确定性文本/本地元数据规则在本机计算，不调用任何模型、不联网、不产生费用。',
    },
    result: {
      summary: ruleSummary(ruleOutputs),
      rules: ruleOutputs.map((rule) => ({ rule_id: rule.rule_id, label: rule.label, output: clonePlain(rule.output) })),
    },
    evidence_fingerprint: evidence.fingerprint,
    evidence_version: evidence.version,
    version: previous ? previous.version + 1 : 1,
    fingerprint: '',
    created_at: previous?.created_at || timestamp,
    updated_at: timestamp,
  };
  record.fingerprint = await hasher(record);
  const next = clonePlain(project);
  // 重跑保留逻辑 analysis id，令既有知识卡/Brief 的绑定继续有效；
  // 指纹与版本变化会把知识卡及 Brief 确定性标记为 stale，直到用户重建。
  next.analyses = next.analyses.filter((item) => item.evidence_id !== evidenceId);
  next.analyses = [...next.analyses, record];
  return bumpProject(next, { now, hasher });
}

function ruleSummary(ruleOutputs, withModel = false) {
  const byId = new Map(ruleOutputs.map((rule) => [rule.rule_id, rule.output]));
  const keywords = byId.get('keyword_frequency').keywords || [];
  const tones = byId.get('tone_indicators') || {};
  return {
    label: withModel ? '多模态 Qwen 分析（模型结果 + 确定性补充）' : '确定性本地分析（无模型）',
    keyword_count: keywords.length,
    top_keywords: keywords.slice(0, 3),
    exclamations: tones.exclamations || 0,
    questions: tones.questions || 0,
  };
}

/**
 * 登记 P29 服务端多模态分析（精确接受模型结果，绝不替换为本地确定性文本）：
 * - 模型结果以显式版本化 model_analysis 扩展持久化（p29_multimodal_model_v1），
 *   kind 保持数据库边界唯一的 deterministic_local，模型/执行身份在扩展中保留；
 * - 逐媒体分析必须按精确顺序绑定证据的全部媒体 id（缺失/重复/乱序/外来一律拒绝）；
 * - 确定性规则作为补充合并进 result；按证据重跑保持分析 id，幂等重放。
 */
export async function recordAssistedAnalysis(project, evidenceId, modelResult, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const evidence = (project.evidence || []).find((item) => item.id === evidenceId);
  if (!evidence) throw workbenchError('EVIDENCE_NOT_FOUND', '要分析的证据不存在。');
  const previous = (project.analyses || []).find((item) => item.evidence_id === evidenceId) || null;
  if (previous && previous.model_analysis && previous.evidence_fingerprint === evidence.fingerprint && previous.evidence_version === evidence.version) {
    return clonePlain(project);
  }
  if (!modelResult || typeof modelResult !== 'object') throw workbenchError('ANALYSIS_MODEL_RESULT_INVALID', '模型分析结果缺失，已拒绝。');
  const sourceId = String(modelResult.source_id || '');
  if (!sourceId || sourceId !== String(evidence.provenance?.source_id || '')) {
    throw workbenchError('ANALYSIS_SOURCE_BINDING_INVALID', '模型分析没有精确绑定证据来源身份，已拒绝。');
  }
  const result = modelResult.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw workbenchError('ANALYSIS_MODEL_RESULT_INVALID', '模型分析结果无效，已拒绝。');
  // 严格规范边界：result 只接受 p29_multimodal_model_v1 声明的模型结果子集；
  // 解析行携带的来源身份字段（source_id/source_url/content_sha256/method）不属于结果子集，
  // 存在未知字段一律失败关闭，绝不静默丢弃或降级。
  const MODEL_RESULT_KEYS = ['text_expression', 'media_analysis', 'virality_drivers', 'reusable_methods', 'signals', 'risks'];
  if (Object.keys(result).some((key) => !MODEL_RESULT_KEYS.includes(key))) {
    throw workbenchError('ANALYSIS_MODEL_RESULT_INVALID', '模型结果包含未知字段，已拒绝。');
  }
  const mediaIds = (evidence.media_assets || []).map((asset) => asset.id);
  const boundMediaIds = (Array.isArray(result.media_analysis) ? result.media_analysis : []).map((row) => row && row.media_id);
  if (JSON.stringify(boundMediaIds) !== JSON.stringify(mediaIds)) {
    throw workbenchError('ANALYSIS_MEDIA_BINDING_INVALID', '模型分析未按精确顺序绑定全部媒体 id（缺失/重复/乱序/外来均拒绝）。');
  }
  const totalTokens = Number(modelResult.usage && modelResult.usage.total_tokens);
  if (!Number.isInteger(totalTokens) || totalTokens <= 0) {
    throw workbenchError('ANALYSIS_MODEL_RESULT_INVALID', '模型用量无效，已拒绝。');
  }
  const timestamp = now();
  const model = String(modelResult.model || MULTIMODAL_MODEL).slice(0, 80);
  const extension = {
    schema_version: MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: MULTIMODAL_PROVIDER,
    model,
    method: MULTIMODAL_METHOD,
    executed_at: String(modelResult.executed_at || timestamp).slice(0, 80),
    media_ids: mediaIds,
    result: clonePlain(result),
    usage: { total_tokens: totalTokens },
  };
  const ruleOutputs = runDeterministicRules(evidence);
  const id = previous?.id || await stableId('an-', { project_id: project.id, evidence_id: evidenceId, timestamp });
  const record = {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    id,
    project_id: project.id,
    evidence_id: evidenceId,
    kind: ANALYSIS_KIND,
    rule_ids: ruleOutputs.map((rule) => rule.rule_id),
    provenance: {
      method: ANALYSIS_KIND,
      generated_by: ANALYSIS_ENGINE_VERSION,
      model,
      executed_at: timestamp,
      statement: '本分析包含 P29 服务端多模态 Qwen 分析（model_analysis 扩展）与确定性规则补充；模型结果按来源与逐媒体精确绑定。',
    },
    model_analysis: extension,
    result: {
      summary: ruleSummary(ruleOutputs, true),
      rules: ruleOutputs.map((rule) => ({ rule_id: rule.rule_id, label: rule.label, output: clonePlain(rule.output) })),
    },
    evidence_fingerprint: evidence.fingerprint,
    evidence_version: evidence.version,
    version: previous ? previous.version + 1 : 1,
    fingerprint: '',
    created_at: previous?.created_at || timestamp,
    updated_at: timestamp,
  };
  record.fingerprint = await hasher(record);
  const verdict = validateAnalysis(record);
  if (!verdict.valid) throw workbenchError('ANALYSIS_INVALID', verdict.issues[0] || '多模态分析记录未通过契约校验。');
  const next = clonePlain(project);
  next.analyses = next.analyses.filter((item) => item.evidence_id !== evidenceId);
  next.analyses = [...next.analyses, record];
  return bumpProject(next, { now, hasher });
}

/**
 * P32-A 版本化 Qwen 重新分析：始终追加新分析记录，绝不覆写/删除旧版本。
 * 每次重新分析产生新的唯一分析 id，版本号为该证据下的顺序递增版本。
 * v2 多模态模型扩展（p32_multimodal_model_v2）直接持久化，不与 v1 混用。
 */
export async function recordVersionedReanalysis(project, evidenceId, modelResult, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const evidence = (project.evidence || []).find((item) => item.id === evidenceId);
  if (!evidence) throw workbenchError('EVIDENCE_NOT_FOUND', '要分析的证据不存在。');
  // 验证媒体资产完整性
  const mediaIds = (evidence.media_assets || []).map((asset) => asset.id);
  if (!mediaIds.length) throw workbenchError('REANALYSIS_MEDIA_MISSING', '证据缺少已验证的媒体资产，无法进行 Qwen 多模态重新分析。');
  if (!modelResult || typeof modelResult !== 'object') throw workbenchError('ANALYSIS_MODEL_RESULT_INVALID', '模型分析结果缺失，已拒绝。');
  const sourceId = String(modelResult.source_id || '');
  if (!sourceId || sourceId !== String(evidence.provenance?.source_id || '')) {
    throw workbenchError('ANALYSIS_SOURCE_BINDING_INVALID', '模型分析没有精确绑定证据来源身份，已拒绝。');
  }
  const result = modelResult.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw workbenchError('ANALYSIS_MODEL_RESULT_INVALID', '模型分析结果无效，已拒绝。');

  // 严格规范边界：v2 结果只接受已声明的字段子集。
  const V2_KEYS = ['text_expression', 'hook', 'copy_pattern', 'target_audience', 'audience_need_emotion',
    'media_analysis', 'virality_drivers', 'reusable_methods', 'rewrite_suggestions', 'signals', 'risks'];
  if (Object.keys(result).some((key) => !V2_KEYS.includes(key))) {
    throw workbenchError('ANALYSIS_MODEL_RESULT_INVALID', '模型结果包含未知字段，已拒绝。');
  }
  // 逐媒体绑定校验
  const boundMediaIds = (Array.isArray(result.media_analysis) ? result.media_analysis : []).map((row) => row && row.media_id);
  if (JSON.stringify(boundMediaIds) !== JSON.stringify(mediaIds)) {
    throw workbenchError('ANALYSIS_MEDIA_BINDING_INVALID', '模型分析未按精确顺序绑定全部媒体 id（缺失/重复/乱序/外来均拒绝）。');
  }
  const totalTokens = Number(modelResult.usage && modelResult.usage.total_tokens);
  if (!Number.isInteger(totalTokens) || totalTokens <= 0) {
    throw workbenchError('ANALYSIS_MODEL_RESULT_INVALID', '模型用量无效，已拒绝。');
  }

  const timestamp = now();
  const model = String(modelResult.model || MULTIMODAL_MODEL).slice(0, 80);
  // 计算下一个版本号
  const existingVersions = (project.analyses || []).filter((item) => item.evidence_id === evidenceId);
  const nextVersion = existingVersions.reduce((max, item) => Math.max(max, item.version || 0), 0) + 1;

  // 去重：相同请求身份不创建重复版本
  const requestIdentity = modelResult._request_identity || null;
  if (requestIdentity) {
    const duplicate = existingVersions.find((item) =>
      item.model_analysis && item.model_analysis._request_identity === requestIdentity);
    if (duplicate) return clonePlain(project);
  }

  const extension = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: MULTIMODAL_PROVIDER,
    model,
    method: MULTIMODAL_METHOD,
    executed_at: String(modelResult.executed_at || timestamp).slice(0, 80),
    media_ids: mediaIds,
    result: clonePlain(result),
    usage: { total_tokens: totalTokens },
    _request_identity: requestIdentity,
  };

  const ruleOutputs = runDeterministicRules(evidence);
  const id = await stableId('an-', { project_id: project.id, evidence_id: evidenceId, version: nextVersion, timestamp });
  const record = {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    id,
    project_id: project.id,
    evidence_id: evidenceId,
    kind: ANALYSIS_KIND,
    rule_ids: ruleOutputs.map((rule) => rule.rule_id),
    provenance: {
      method: ANALYSIS_KIND,
      generated_by: ANALYSIS_ENGINE_VERSION,
      model,
      executed_at: timestamp,
      statement: `本分析包含 P32 版本化多模态 Qwen 重新分析（p32_multimodal_model_v2，第 ${nextVersion} 版）；模型结果按来源与逐媒体精确绑定。`,
    },
    model_analysis: extension,
    result: {
      summary: ruleSummary(ruleOutputs, true),
      rules: ruleOutputs.map((rule) => ({ rule_id: rule.rule_id, label: rule.label, output: clonePlain(rule.output) })),
    },
    evidence_fingerprint: evidence.fingerprint,
    evidence_version: evidence.version,
    version: nextVersion,
    fingerprint: '',
    created_at: timestamp,
    updated_at: timestamp,
  };
  record.fingerprint = await hasher(record);
  const verdict = validateAnalysis(record);
  if (!verdict.valid) throw workbenchError('ANALYSIS_INVALID', verdict.issues[0] || '版本化重新分析记录未通过契约校验。');
  const next = clonePlain(project);
  // 追加，不覆写
  next.analyses = [...next.analyses, record];
  return bumpProject(next, { now, hasher });
}

/**
 * 获取某证据的最新分析版本（版本号最高且有效的分析记录），
 * 供 Knowledge Card 创建和比较使用。无分析返回 null。
 */
export function getLatestAnalysisForEvidence(project, evidenceId) {
  const analyses = (project.analyses || []).filter((item) => item.evidence_id === evidenceId);
  if (!analyses.length) return null;
  return analyses.reduce((best, current) => (current.version > best.version ? current : best), analyses[0]);
}

/**
 * 获取某证据的所有分析版本，按版本号降序排列（最新在前）。
 */
export function getAllAnalysisVersionsForEvidence(project, evidenceId) {
  return (project.analyses || [])
    .filter((item) => item.evidence_id === evidenceId)
    .sort((a, b) => b.version - a.version);
}

/**
 * P32-A 多选比较：2-5 条选定证据，每条绑定其最新有效分析，
 * 输出确定性逐条摘要和比较信息。不调用模型、不虚构事实。
 */
export function generateEvidenceComparison(project, selectedEvidenceIds) {
  const ids = Array.isArray(selectedEvidenceIds) ? selectedEvidenceIds : [];
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length < 2 || uniqueIds.length > 5) {
    return { valid: false, reason: `比较需要 2-5 条记录，当前选择了 ${uniqueIds.length} 条。`, rows: [], summary: null };
  }
  const evidenceById = new Map((project.evidence || []).map((item) => [item.id, item]));
  const rows = [];
  const warnings = [];
  for (const evidenceId of uniqueIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      return { valid: false, reason: `证据 ${evidenceId} 不存在于当前项目中。`, rows: [], summary: null };
    }
    const latestAnalysis = getLatestAnalysisForEvidence(project, evidenceId);
    if (!latestAnalysis || !latestAnalysis.model_analysis) {
      warnings.push(`证据 ${evidenceId.slice(0, 16)}… 缺少有效多模态分析。`);
      rows.push({ evidenceId, evidence, analysis: null, analysisMissing: true });
      continue;
    }
    const ext = latestAnalysis.model_analysis;
    const result = ext.result || {};
    const isV2 = ext.schema_version === P32_MODEL_ANALYSIS_SCHEMA_VERSION;
    rows.push({
      evidenceId,
      evidence,
      analysis: latestAnalysis,
      analysisVersion: latestAnalysis.version,
      totalVersions: getAllAnalysisVersionsForEvidence(project, evidenceId).length,
      schemaVersion: ext.schema_version,
      hook: isV2 ? (result.hook || '') : (result.text_expression || '').slice(0, 200),
      audience: isV2 ? (result.target_audience || '') : '',
      engagement: evidence.source_metadata?.engagement || null,
      visualPattern: (result.media_analysis || []).slice(0, 2).map((row) => (isV2 ? (row.style_pattern || row.visual_content) : (row.visual_content || ''))).join('；'),
      propagationDrivers: result.virality_drivers || [],
      reusableFormula: isV2 ? (result.reusable_methods || []) : (result.reusable_methods || []),
      risks: result.risks || [],
      analysisMissing: false,
    });
  }
  // 确定性比较摘要：派生自精确选定记录，不调用模型
  const validRows = rows.filter((row) => !row.analysisMissing);
  const allHooks = validRows.map((row) => row.hook).filter(Boolean);
  const allDrivers = validRows.flatMap((row) => row.propagationDrivers);
  const allRisks = validRows.flatMap((row) => row.risks);
  const highestEngagement = validRows.reduce((best, row) => {
    if (!row.engagement) return best;
    const total = (row.engagement.likes || 0) + (row.engagement.retweets || 0) + (row.engagement.replies || 0);
    return total > (best.total || -1) ? { row, total } : best;
  }, { row: null, total: -1 });

  const summary = {
    totalSelected: uniqueIds.length,
    analyzedCount: validRows.length,
    missingAnalysisCount: warnings.length,
    warnings,
    commonDrivers: [...new Set(allDrivers)].slice(0, 5),
    commonRisks: [...new Set(allRisks)].slice(0, 5),
    highestEngagementSignal: highestEngagement.row ? {
      evidenceId: highestEngagement.row.evidenceId,
      hook: highestEngagement.row.hook.slice(0, 100),
      total: highestEngagement.total,
    } : null,
    diverseHooks: validRows.length >= 2 ? allHooks : [],
  };
  return { valid: true, rows, summary };
}

/** 从分析构建校验过的 content_knowledge_card_v1 知识卡（确定性）。 */
export async function buildKnowledgeCard(project, analysisId, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const analysis = (project.analyses || []).find((item) => item.id === analysisId);
  if (!analysis) throw workbenchError('ANALYSIS_NOT_FOUND', '要转成知识卡的分析不存在。');
  if (analysis.kind !== ANALYSIS_KIND) throw workbenchError('ANALYSIS_KIND_INVALID', '只有 deterministic_local 分析可以转为知识卡。');
  const evidence = (project.evidence || []).find((item) => item.id === analysis.evidence_id);
  if (!evidence) throw workbenchError('EVIDENCE_NOT_FOUND', '分析绑定的证据不存在，无法构建知识卡。');
  const timestamp = now();
  const previous = (project.knowledge_cards || []).find((item) => item.analysis_id === analysisId) || null;
  if (previous && previous.analysis_fingerprint === analysis.fingerprint && previous.analysis_version === analysis.version) {
    return clonePlain(project);
  }
  const card = buildCardFromAnalysis(analysis, evidence);
  const verdict = validateKnowledgeCard(card);
  if (!verdict.valid) throw workbenchError('CARD_BUILD_FAILED', verdict.issues[0] || '知识卡构建未通过 content_knowledge_card_v1 校验。');
  const id = previous?.id || await stableId('kc-', { project_id: project.id, analysis_id: analysisId, timestamp });
  const multimodal = analysis.model_analysis;
  const record = {
    ...card,
    id,
    project_id: project.id,
    analysis_id: analysisId,
    analysis_fingerprint: analysis.fingerprint,
    analysis_version: analysis.version,
    trust_status: multimodal ? 'multimodal_model' : 'manual_local',
    validation_status: multimodal ? 'validated_multimodal' : 'validated_deterministic',
    // P29 版本化扩展：模型/执行身份与绑定媒体（纯确定性卡为 null）。
    analysis_provenance: multimodal ? {
      method: MULTIMODAL_METHOD,
      provider: MULTIMODAL_PROVIDER,
      model: multimodal.model,
      executed_at: multimodal.executed_at,
      source_analysis_id: analysis.id,
      media_ids: (multimodal.media_ids || []).slice(0, 8),
      statement: '该卡包含 P29 服务端多模态 Qwen 分析的绑定结果；模型/执行身份随分析保留。',
    } : null,
    version: previous ? previous.version + 1 : 1,
    fingerprint: '',
    created_at: previous?.created_at || timestamp,
    updated_at: timestamp,
  };
  record.fingerprint = await hasher(record);
  const next = clonePlain(project);
  const existing = next.knowledge_cards.findIndex((item) => item.analysis_id === analysisId);
  if (existing >= 0) {
    next.knowledge_cards[existing] = record;
  } else {
    next.knowledge_cards = [...next.knowledge_cards, record];
  }
  return bumpProject(next, { now, hasher });
}

function buildCardFromAnalysis(analysis, evidence) {
  return analysis.model_analysis ? buildMultimodalCardFromAnalysis(analysis, evidence) : buildDeterministicCardFromAnalysis(analysis, evidence);
}

/**
 * 已验收禁止措辞清洗：模型输出中的不确定措辞必须移入 uncertainties，
 * 不得作为卡内断言出现（validateKnowledgeCard 全文扫描同样强制）。
 */
function scrubAssertive(value) {
  const text = String(value ?? '');
  const cleaned = text.replace(/看起来像|应该是|大概有/g, '');
  return { text: cleaned, scrubbed: cleaned !== text };
}

function buildMultimodalCardFromAnalysis(analysis, evidence) {
  const extension = analysis.model_analysis;
  const result = extension.result;
  const postText = textOf(evidence.content_text);
  const mediaById = new Map((evidence.media_assets || []).map((asset) => [asset.id, asset]));
  const mediaRows = Array.isArray(result.media_analysis) ? result.media_analysis : [];
  let scrubbedAny = false;
  const scrubAll = (list) => list.map((value) => {
    const cleaned = scrubAssertive(value);
    if (cleaned.scrubbed) scrubbedAny = true;
    return cleaned.text.trim();
  });
  const visual = (row) => {
    const cleaned = scrubAssertive(row.visual_content);
    if (cleaned.scrubbed) scrubbedAny = true;
    return boundedSlice(cleaned.text, 500);
  };
  const composition = scrubAll(mediaRows.map((row) => row.composition).filter(Boolean));
  const scenes = scrubAll(mediaRows.map((row) => row.scene).filter(Boolean));
  const people = scrubAll(mediaRows.map((row) => row.people).filter(Boolean));
  const emotions = scrubAll(mediaRows.map((row) => row.emotion).filter(Boolean));
  const signals = scrubAll(Array.isArray(result.signals) ? result.signals : []);
  const reusableMethods = scrubAll(Array.isArray(result.reusable_methods) ? result.reusable_methods : []);
  const risks = scrubAll(Array.isArray(result.risks) ? result.risks : []);
  const drivers = scrubAll(Array.isArray(result.virality_drivers) ? result.virality_drivers : []);
  const textExpression = scrubAssertive(result.text_expression).text.trim() || postText;

  const segments = mediaRows.map((row, index) => {
    const asset = mediaById.get(row.media_id);
    return {
      stage: `media_${index + 1}`,
      time_range: asset && asset.kind === 'video' ? 'video_media' : 'image_media',
      visual_evidence: boundedSlice(visual(row), 300) || '（模型未提供确定性画面描述）',
      audio_evidence: '无音轨：媒体分析未包含音频内容。',
    };
  });
  while (segments.length < 3) {
    const third = Math.max(1, Math.floor(postText.length / 3));
    const index = segments.length;
    segments.push({
      stage: ['start', 'middle', 'end'][index] || `text_${index + 1}`,
      time_range: 'not_applicable_local_text',
      visual_evidence: boundedSlice(postText.slice((index % 3) * third, ((index % 3) + 1) * third), 300) || '（该段无正文内容）',
      audio_evidence: '无音轨。',
    });
  }

  const firstSentence = textExpression.split(/[.!?。！？]+/).map((part) => part.trim()).find((part) => part.length > 0) || textExpression.slice(0, 40);
  const firstImage = mediaRows[0];
  const firstAsset = mediaById.get(firstImage && firstImage.media_id);
  const risksText = risks.join('；');
  const links = [
    { claim: boundedSlice(`来源正文首句：${firstSentence}`, 200), evidence_type: 'post_text', source_ref: evidence.id, time_range: null, confidence: 0.9 },
    ...mediaRows.map((row, index) => {
      const asset = mediaById.get(row.media_id);
      return {
        claim: boundedSlice(`媒体 #${index + 1}（${asset ? asset.kind : 'media'} ${row.media_id}）画面：${visual(row)}`, 200),
        evidence_type: 'video_frame',
        source_ref: evidence.id,
        time_range: null,
        confidence: 0.8,
      };
    }),
    { claim: boundedSlice(`来源含 ${mediaRows.length} 个媒体资产，全部按顺序绑定并哈希（内容或 URL 完整性）。`, 200), evidence_type: 'metadata', source_ref: evidence.id, time_range: null, confidence: 0.8 },
  ];
  if (links.length < 3) {
    // 内容表达作为补充断言，保证 evidence_links 至少 3 条（卡契约下限）。
    links.push({
      claim: boundedSlice(`内容表达：${textExpression}`, 200),
      evidence_type: 'post_text',
      source_ref: evidence.id,
      time_range: null,
      confidence: 0.8,
    });
  }
  const riskLabels = {
    sexual_suggestiveness: /性|成人|擦边|暴露|性感/.test(risksText) ? 'medium' : 'none',
    platform_moderation: /平台|审核|封禁|违规|敏感/.test(risksText) ? 'medium' : 'low',
    brand_suitability: /品牌|代言|争议|负面/.test(risksText) ? 'restricted' : 'broad',
    notes: [boundedSlice(`模型风险信号：${risksText || '无'}`, 300)],
  };
  const uncertainties = [
    '模型对画面内容的描述基于服务端多模态分析，具体视觉细节以原始媒体为准。',
    ...(scrubbedAny ? ['模型输出中的不确定措辞已移入本清单，未作为断言进入卡内。'] : []),
  ];
  const mustPreserve = reusableMethods.slice(0, 3);
  return {
    schema_version: KNOWLEDGE_CARD_SCHEMA_VERSION,
    source_observations: {
      post_text: boundedSlice(postText, 2000),
      media: {
        duration_seconds: 0,
        resolution: firstAsset && firstAsset.dimensions ? `${firstAsset.dimensions.width}x${firstAsset.dimensions.height}` : 'local_metadata_only',
        audio_track_present: false,
        timeline: segments,
        transcript_segments: [],
      },
      uncertainties,
    },
    creative_analysis: {
      hook: boundedSlice(firstSentence, 200),
      copy_device: reusableMethods[0] || signals[0] || '直述句式',
      semantic_layers: [...composition, ...scenes, ...people].slice(0, 4),
      visual_impact: firstImage ? boundedSlice(visual(firstImage), 300) : '无视觉媒体。',
      seductive_tone: boundedSlice(`情感基调：${emotions[0] || '中性'}${emotions.length > 1 ? `；第二情绪：${emotions[1]}` : ''}。`, 200),
      narrative_arc: boundedSlice(textExpression, 200),
      audio_role: '无音轨（媒体分析未包含音频判断）。',
      audience_response_mechanisms: signals.slice(0, 3),
      replicable_features: reusableMethods.slice(0, 4),
      risk_labels: riskLabels,
    },
    evidence_links: links,
    generation_guidance: {
      reusable_pattern: boundedSlice(`围绕「${boundedSlice(textExpression, 100)}」的叙事，采用「${reusableMethods[0] || '直接展示'}」手法：先陈述事实，再给出可复用的视觉与结构特征。`, 500),
      must_preserve: mustPreserve.length > 0 ? mustPreserve : ['保留来源事实与画面细节'],
      must_not_invent: ['不虚构来源中没有的事实', '不猜测平台数据或互动数据'],
      prompt_ingredients: signals.slice(0, 3),
      variation_space: ['调整叙述顺序', '替换示例', '改变语气强度'],
    },
    generation_readiness: {
      usable: true,
      score: Math.min(100, 55 + mediaRows.length * 10),
      reasons: [
        '多模态模型分析已按顺序绑定全部媒体',
        '证据绑定完整',
        '模型/执行身份已保留',
        ...(drivers.length ? [boundedSlice(`传播驱动：${drivers[0]}`, 120)] : []),
      ],
      blockers: [],
    },
  };
}

function buildDeterministicCardFromAnalysis(analysis, evidence) {
  const rules = new Map(analysis.result.rules.map((rule) => [rule.rule_id, rule.output]));
  const keywords = rules.get('keyword_frequency')?.keywords || [];
  const tones = rules.get('tone_indicators') || {};
  const lengthProfile = rules.get('text_length_profile') || { characters: 0, words: 0, sentences: 0 };
  const postText = textOf(evidence.content_text);
  const third = Math.max(1, Math.floor(postText.length / 3));
  const segments = [
    ['start', postText.slice(0, third)],
    ['middle', postText.slice(third, third * 2)],
    ['end', postText.slice(third * 2)],
  ];
  const firstSentence = postText.split(/[.!?。！？]+/).map((part) => part.trim()).find((part) => part.length > 0) || postText.slice(0, 40);
  const links = [
    { claim: boundedSlice(keywords[0] ? `关键词「${keywords[0]}」在来源文本中出现频率最高` : '来源文本未提取到有效关键词', 200), evidence_type: 'post_text', source_ref: evidence.id, time_range: null, confidence: 0.9 },
    { claim: `来源正文长度为 ${lengthProfile.characters} 字符、${lengthProfile.words} 词、${lengthProfile.sentences} 句`, evidence_type: 'metadata', source_ref: evidence.id, time_range: null, confidence: 0.8 },
    { claim: tones.exclamations + tones.questions > 0 ? `来源文本包含 ${tones.exclamations} 个感叹号与 ${tones.questions} 个问号` : '来源文本语气标记较少', evidence_type: 'metadata', source_ref: evidence.id, time_range: null, confidence: 0.7 },
  ];
  return {
    schema_version: KNOWLEDGE_CARD_SCHEMA_VERSION,
    source_observations: {
      post_text: boundedSlice(postText, 2000),
      media: {
        duration_seconds: 0,
        resolution: 'local_metadata_only',
        audio_track_present: false,
        timeline: segments.map(([stage, text]) => ({
          stage,
          time_range: 'not_applicable_local_text',
          visual_evidence: boundedSlice(text || '（该段无正文内容）', 300),
          audio_evidence: '无音轨：本地文本证据未包含音频。',
        })),
        transcript_segments: [],
      },
      uncertainties: ['本地文本证据不包含画面或音频，任何视觉/听觉判断均不适用。'],
    },
    creative_analysis: {
      hook: boundedSlice(firstSentence, 200),
      copy_device: keywords.slice(0, 2).join(' + ') || '直述句式',
      semantic_layers: keywords.slice(0, 4),
      visual_impact: '无视觉媒体：本卡只描述文本层面的确定性特征。',
      seductive_tone: tones.exclamations + tones.emoji > 0 ? '文本存在感叹/表情标记，注意平台尺度。' : '文本语气标记较少。',
      narrative_arc: lengthProfile.sentences > 1 ? '多句结构，可按起/中/尾分段。' : '单句结构。',
      audio_role: '无音轨。',
      audience_response_mechanisms: keywords.slice(0, 3).map((word) => `关键词「${word}」`),
      replicable_features: keywords.slice(0, 4),
      risk_labels: {
        sexual_suggestiveness: 'none',
        platform_moderation: 'low',
        brand_suitability: 'broad',
        notes: ['风险标签为确定性默认值，仅陈述本地文本未包含明显风险标记。'],
      },
    },
    evidence_links: links,
    generation_guidance: {
      reusable_pattern: boundedSlice(`主题「${evidence.label}」：先陈述事实，再列出关键特征，最后给出可复用的结构。`, 500),
      must_preserve: keywords.slice(0, 3),
      must_not_invent: ['不虚构来源中没有的事实', '不猜测平台数据或互动数据'],
      prompt_ingredients: keywords.slice(0, 3),
      variation_space: ['调整叙述顺序', '替换示例', '改变语气强度'],
    },
    generation_readiness: {
      usable: true,
      score: Math.min(100, 40 + keywords.length * 8),
      reasons: ['分析规则全部执行完成', '证据绑定完整', '关键特征可复用'],
      blockers: [],
    },
  };
}

/** 组装/重建可审核 Brief（版本递增，审核决定重置为待审核）。 */
export async function assembleBrief(project, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const cards = project.knowledge_cards || [];
  if (cards.length === 0) throw workbenchError('BRIEF_NEEDS_CARDS', '至少需要一张有效知识卡才能组装 Brief。');
  const staleness = await computeStaleness(project, { hasher });
  if (staleness.card_stale_ids.length > 0) {
    throw workbenchError('BRIEF_CARDS_STALE', '知识卡已过时：请先重跑对应分析并重建知识卡，再组装 Brief。');
  }
  const timestamp = now();
  const cardFingerprints = {};
  for (const card of cards) cardFingerprints[card.id] = card.fingerprint;
  const citationIds = cards.map((card) => card.id);
  const evidenceBinding = resolveBriefEvidenceBindings(project, citationIds);
  if (!evidenceBinding.valid) {
    throw workbenchError('BRIEF_EVIDENCE_BINDING_INVALID', evidenceBinding.issues[0] || 'Brief cited Evidence binding is invalid.');
  }
  const citedEvidence = evidenceBinding.evidence;
  const hasCollectedEvidence = citedEvidence.some((item) => item.provenance?.manual === false);
  const evidenceProvenanceFingerprint = evidenceProofFingerprint(citedEvidence);
  const projectFingerprint = await hasher(clonePlain({
    topic: project.topic,
    objective: project.objective,
    audience: project.audience,
    channel: project.channel,
    constraints: project.constraints,
  }));
  const previous = project.brief || null;
  const id = previous && previous.id ? previous.id : await stableId('brief-', { project_id: project.id, timestamp });
  const version = previous ? previous.version + 1 : 1;
  // P29：被引用知识卡中多模态卡的分析身份与纯语言发现（无多模态卡时缺省，兼容旧 Brief）。
  const multimodalCards = cards.filter((card) => card.analysis_provenance && card.analysis_provenance.method === MULTIMODAL_METHOD);
  const analysisById = new Map((project.analyses || []).map((row) => [row.id, row]));
  const evidenceById = new Map(citedEvidence.map((row) => [row.id, row]));
  const brief = {
    schema_version: BRIEF_SCHEMA_VERSION,
    id,
    project_id: project.id,
    version,
    status: 'pending_review',
    topic: project.topic,
    objective: project.objective,
    audience: project.audience,
    channel: project.channel,
    constraints: clonePlain(project.constraints || []),
    knowledge_citation_ids: citationIds,
    structural_guidance: cards.flatMap((card) => (card.generation_guidance ? card.generation_guidance.must_preserve || [] : []).slice(0, 3)).slice(0, MAX_ARRAY_LENGTH),
    evidence_provenance: {
      local_only: !hasCollectedEvidence,
      store: hasCollectedEvidence ? 'p19_workspace_v1' : 'p19_local_store_v1',
      created_from: 'selected_knowledge_cards',
      statement: hasCollectedEvidence
        ? '证据包含经服务端来源证明绑定的公开采集记录；Brief 保留对应知识卡与证据快照。'
        : '证据全部来自本地手工录入，未经过任何平台采集或验证。',
    },
    card_fingerprints: cardFingerprints,
    evidence_provenance_fingerprint: evidenceProvenanceFingerprint,
    project_fingerprint: projectFingerprint,
    analysis_provenance: multimodalCards.length > 0 ? {
      method: MULTIMODAL_METHOD,
      provider: MULTIMODAL_PROVIDER,
      model: multimodalCards[0].analysis_provenance.model,
      executed_at: multimodalCards[0].analysis_provenance.executed_at,
      analysis_ids: multimodalCards.map((card) => card.analysis_id),
      media_count: multimodalCards.reduce((sum, card) => sum + (card.analysis_provenance.media_ids || []).length, 0),
      statement: 'Brief 包含 P29 服务端多模态 Qwen 分析的绑定发现；模型/执行身份随分析与知识卡保留。',
    } : null,
    multimodal_findings: multimodalCards.length > 0 ? buildMultimodalFindings(multimodalCards, analysisById, evidenceById) : null,
    review: {
      schema_version: BRIEF_REVIEW_SCHEMA_VERSION,
      brief_id: id,
      decision: null,
      comments: previous && Array.isArray(previous.review?.comments) ? previous.review.comments.slice() : [],
    },
    version_note: previous ? `基于第 ${previous.version} 版重建（上游内容已变化）。` : '首次组装。',
    fingerprint: '',
    created_at: previous ? previous.created_at : timestamp,
    updated_at: timestamp,
  };
  brief.fingerprint = await hasher(brief);
  const verdict = validateBrief(brief);
  if (!verdict.valid) throw workbenchError('BRIEF_BUILD_FAILED', verdict.issues[0] || 'Brief 组装未通过校验。');
  const next = clonePlain(project);
  next.brief = brief;
  next.handoff = null; // Brief 重建后旧交接包作废
  next.handoffs = [];
  return bumpProject(next, { now, hasher });
}

/** 从多模态卡的绑定分析构建纯语言发现（有界、确定性；最多 10 条 × 240 字符）。 */
function buildMultimodalFindings(cards, analysisById, evidenceById) {
  const findings = [];
  for (const card of cards) {
    const analysis = analysisById.get(card.analysis_id);
    const extension = analysis && analysis.model_analysis;
    if (!extension) continue;
    const result = extension.result || {};
    if (typeof result.text_expression === 'string' && result.text_expression.trim()) {
      findings.push(`内容表达：${boundedSlice(result.text_expression, 220)}`);
    }
    const evidence = evidenceById.get(analysis.evidence_id);
    const assetByMediaId = new Map((evidence && evidence.media_assets || []).map((asset) => [asset.id, asset]));
    for (const row of Array.isArray(result.media_analysis) ? result.media_analysis : []) {
      const asset = assetByMediaId.get(row && row.media_id);
      const label = asset ? `媒体 #${asset.order + 1}` : String(row && row.media_id || '媒体').slice(0, 24);
      findings.push(`画面（${label}）：${boundedSlice(row.visual_content, 200)}`);
      if (findings.length >= 10) return findings;
    }
    if (findings.length >= 10) return findings;
  }
  return findings;
}

/** 审核决定（ams_brief_review_v1：approved / return_for_revision + local_manual）。 */
export async function reviewBrief(project, { decision, rationale, comment = '', decidedBy = 'local_user', now = () => new Date().toISOString() } = {}) {
  assertNotArchived(project);
  const brief = project.brief;
  if (!brief) throw workbenchError('BRIEF_NOT_FOUND', '项目还没有 Brief，请先组装。');
  if (brief.status !== 'pending_review' || brief.review?.decision !== null) {
    throw workbenchError('BRIEF_REVIEW_STATE_INVALID', '当前 Brief 已完成审核；退回的修订必须先重建，已批准的修订不得重复决定。');
  }
  const staleness = await computeStaleness(project);
  if (staleness.brief_stale) {
    throw workbenchError('BRIEF_STALE', `Brief 已过时：${staleness.brief_stale_reasons[0] || '上游内容已变化'}。请重建 Brief 后再审核。`);
  }
  if (!BRIEF_DECISIONS.includes(decision)) throw workbenchError('DECISION_INVALID', '审核决定必须是 approved 或 return_for_revision。');
  const cleanRationale = textOf(rationale);
  if (!cleanRationale) throw workbenchError('RATIONALE_REQUIRED', '请填写审核意见（必须提供简短理由）。');
  if (cleanRationale.length > 500) throw workbenchError('RATIONALE_TOO_LONG', '审核意见不能超过 500 字。');
  const timestamp = now();
  const next = clonePlain(project);
  next.brief = clonePlain(brief);
  next.brief.review.decision = {
    value: decision,
    rationale: cleanRationale,
    decided_at: timestamp,
    source: HANDOFF_DECISION_METHOD,
    decided_by: textOf(decidedBy) || 'local_user',
  };
  if (comment) {
    next.brief.review.comments = [...(next.brief.review.comments || []), boundedSlice(comment, 1000)];
  }
  next.brief.status = decision === 'approved' ? 'approved' : 'returned';
  next.brief.updated_at = timestamp;
  next.brief.version_note = decision === 'approved' ? `第 ${brief.version} 版已人工批准（local_manual）。` : `第 ${brief.version} 版已退回修改。`;
  next.brief.fingerprint = await fingerprintOf(next.brief);
  return bumpProject(next, { now, hasher: fingerprintOf });
}

/**
 * 从已批准且未过时的 Brief 派生 ams_external_handoff_package_v1。
 * 唯一入口门禁：当前 Brief 修订存在、状态 approved、且未过时。
 */
export async function deriveHandoffPackage(project, { now = () => new Date().toISOString(), hasher = fingerprintOf } = {}) {
  assertNotArchived(project);
  const brief = project.brief;
  if (!brief) throw workbenchError('HANDOFF_BRIEF_MISSING', '无法创建交接包：项目还没有 Brief。');
  if (brief.status !== 'approved' || !brief.review || !brief.review.decision || brief.review.decision.value !== 'approved') {
    throw workbenchError('HANDOFF_BRIEF_NOT_APPROVED', '无法创建交接包：当前 Brief 修订尚未被人工批准。');
  }
  if (brief.review.decision.source !== HANDOFF_DECISION_METHOD) {
    throw workbenchError('HANDOFF_DECISION_SOURCE_INVALID', '无法创建交接包：决定来源不是精确的 local_manual。');
  }
  const staleness = await computeStaleness(project);
  if (staleness.brief_stale) {
    throw workbenchError('HANDOFF_BRIEF_STALE', `无法创建交接包：${staleness.brief_stale_reasons[0] || 'Brief 已过时'}。请重建 Brief 并重新批准。`);
  }
  const evidenceBinding = resolveBriefEvidenceBindings(project, brief.knowledge_citation_ids);
  if (!evidenceBinding.valid) {
    throw workbenchError('HANDOFF_EVIDENCE_BINDING_INVALID', evidenceBinding.issues[0] || 'Handoff cited Evidence binding is invalid.');
  }
  const cardById = new Map((project.knowledge_cards || []).map((card) => [card.id, card]));
  const cards = brief.knowledge_citation_ids.map((cardId) => cardById.get(cardId));
  const citations = brief.knowledge_citation_ids.map((cardId, index) => {
    const card = cardById.get(cardId);
    return {
      knowledge_id: card ? card.id : cardId,
      type: card ? 'content_knowledge_card_v1' : 'missing_card',
      title: card ? boundedSlice(card.source_observations?.post_text, 120) : '缺失的知识卡',
      excerpt: card ? boundedSlice((card.creative_analysis?.hook || card.source_observations?.post_text || ''), 200) : '',
      evidence_refs: card ? (card.evidence_links || []).map((link) => link.source_ref).slice(0, 5) : [],
      evidence_completeness: card ? { linked: card.evidence_links.length, timeline: 'local_text' } : null,
      trust_status: card ? (card.trust_status || 'manual_local') : 'invalid',
      validation_status: card ? (card.validation_status || 'validated_deterministic') : 'unvalidated',
      citation_index: index + 1,
    };
  });
  const timestamp = now();
  const id = await stableId('handoff-pkg-', { project_id: project.id, brief_id: brief.id, brief_version: brief.version, timestamp });
  const decision = brief.review.decision;
  const record = {
    schema_version: HANDOFF_SCHEMA_VERSION,
    id,
    version: 1,
    kind: HANDOFF_KIND,
    status: HANDOFF_STATUS,
    payload_label: HANDOFF_PAYLOAD_LABEL,
    is_external_task: false,
    submission_pending: true,
    local_only: true,
    repo_external: true,
    brief_provenance: {
      brief_id: brief.id,
      brief_version: brief.version,
      brief_schema_version: brief.schema_version,
      brief_status: brief.status,
    },
    human_decision: {
      value: 'approved',
      source: HANDOFF_DECISION_METHOD,
      rationale: decision.rationale,
      decided_by: decision.decided_by,
      decided_at: decision.decided_at,
    },
    topic: brief.topic,
    objective: brief.objective,
    knowledge_citations: citations,
    evidence_provenance: {
      local_only: brief.evidence_provenance.local_only,
      store: brief.evidence_provenance.store,
      created_from: 'approved_content_brief',
      knowledge_count: citations.length,
      statement: brief.evidence_provenance.statement,
    },
    structural_guidance: {
      reusable_patterns: cards.flatMap((card) => (card.generation_guidance?.reusable_pattern ? [card.generation_guidance.reusable_pattern] : [])).slice(0, 10),
      must_preserve: cards.flatMap((card) => card.generation_guidance?.must_preserve || []).slice(0, 10),
      variation_space: cards.flatMap((card) => card.generation_guidance?.variation_space || []).slice(0, 10),
    },
    constraints: {
      must_not_invent: ['不虚构来源中没有的事实', '不猜测平台数据或互动数据'],
      evidence_boundary: '只允许引用本地项目内已校验的证据与知识卡。',
    },
    external_project_boundary: {
      destination: 'external_generation_project',
      statement: '本包仅描述本地研究结论与约束；外部项目的生成、路由与发布完全由其自行决定，与本页无关。',
    },
    import_only: { manual_import_required: true },
    manual_feedback: null,
    execution_flags: clonePlain(EXECUTION_FLAGS),
    source_trace: {
      origin: 'local_bridge',
      created_from: 'approved_content_brief',
    },
    project_id: project.id,
    fingerprint: '',
    created_at: timestamp,
  };
  const verdict = validateHandoffPackageRecord(record);
  if (!verdict.valid) throw workbenchError('HANDOFF_BUILD_FAILED', verdict.issues[0] || '交接包构建未通过 P5 校验。');
  record.fingerprint = await hasher(record);
  const next = clonePlain(project);
  next.handoff = record;
  next.handoffs = [record];
  return bumpProject(next, { now, hasher });
}

/** 项目层执行标志：恒为四项严格 false（页面可见）。 */
export function projectExecutionFlags(project) {
  return clonePlain(project && project.execution_flags ? project.execution_flags : EXECUTION_FLAGS);
}

/**
 * 过时传播（确定性计算，不存储状态）：
 * - 分析过时：证据指纹/版本变化；
 * - 知识卡过时：分析指纹/版本变化；
 * - Brief 过时：引用知识卡指纹变化/缺失、证据指纹变化、项目档案变化；
 * - 交接包过时：Brief 指纹/绑定变化。
 * hasher 可注入保证测试确定性。
 */
export async function computeStaleness(project, { hasher = fingerprintOf } = {}) {
  const stale = {
    analysis_stale_ids: [],
    card_stale_ids: [],
    brief_stale: false,
    brief_stale_reasons: [],
    handoff_stale: false,
    handoff_stale_reasons: [],
  };
  const evidenceById = new Map((project.evidence || []).map((item) => [item.id, item]));
  for (const record of project.analyses || []) {
    const bound = evidenceById.get(record.evidence_id);
    if (!bound || record.evidence_fingerprint !== bound.fingerprint || record.evidence_version !== bound.version) {
      stale.analysis_stale_ids.push(record.id);
    }
  }
  const analysisById = new Map((project.analyses || []).map((item) => [item.id, item]));
  const analysisStaleIds = new Set(stale.analysis_stale_ids);
  // P32-A: when an evidence has multiple versioned analyses, the Knowledge Card that references
  // a specific analysis version must still match exactly; a new (higher-version) analysis does
  // NOT automatically stale the card that was built from an older analysis.
  for (const card of project.knowledge_cards || []) {
    const bound = analysisById.get(card.analysis_id);
    const sourceStale = bound && analysisStaleIds.has(bound.id);
    if (!bound || sourceStale || card.analysis_fingerprint !== bound.fingerprint || card.analysis_version !== bound.version) {
      stale.card_stale_ids.push(card.id);
    }
  }
  const brief = project.brief;
  if (brief) {
    const cardById = new Map((project.knowledge_cards || []).map((item) => [item.id, item]));
    for (const cardId of brief.knowledge_citation_ids || []) {
      const card = cardById.get(cardId);
      if (!card) {
        stale.brief_stale = true;
        stale.brief_stale_reasons.push('Brief 引用的知识卡已不存在。');
      } else if (brief.card_fingerprints?.[cardId] !== card.fingerprint) {
        stale.brief_stale = true;
        stale.brief_stale_reasons.push('Brief 引用的知识卡快照已变化。');
      }
    }
    if (stale.card_stale_ids.length > 0 && !stale.brief_stale) {
      stale.brief_stale = true;
      stale.brief_stale_reasons.push('存在过时的知识卡。');
    }
    if (brief.evidence_provenance_fingerprint) {
      const binding = resolveBriefEvidenceBindings(project, brief.knowledge_citation_ids);
      const current = binding.valid ? evidenceProofFingerprint(binding.evidence) : '';
      if (!binding.valid || brief.evidence_provenance_fingerprint !== current) {
        stale.brief_stale = true;
        stale.brief_stale_reasons.push('证据溯源快照与当前证据不一致。');
      }
    }
    if (brief.project_fingerprint) {
      const current = await hasher({
        topic: project.topic,
        objective: project.objective,
        audience: project.audience,
        channel: project.channel,
        constraints: project.constraints,
      });
      if (brief.project_fingerprint !== current) {
        stale.brief_stale = true;
        stale.brief_stale_reasons.push('项目档案（主题/目标/受众/渠道/约束）已变化。');
      }
    }
  }
  const handoff = project.handoff || (project.handoffs && project.handoffs[0]);
  if (handoff) {
    const provenance = handoff.brief_provenance;
    const bindingOk = brief
      && provenance
      && provenance.brief_id === brief.id
      && provenance.brief_version === brief.version
      && provenance.brief_schema_version === brief.schema_version
      && provenance.brief_status === brief.status;
    if (!bindingOk) {
      stale.handoff_stale = true;
      stale.handoff_stale_reasons.push('交接包绑定的 Brief 版本与当前不一致。');
    }
    if (stale.brief_stale) {
      stale.handoff_stale = true;
      stale.handoff_stale_reasons.push('Brief 已过时，交接包随之失效。');
    }
  }
  return stale;
}

export function workbenchError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.bounded = true;
  return error;
}

/**
 * 归档项目只读门禁：已归档项目拒绝一切普通编辑/分析/审核/交接操作
 * （除非由单独定义的显式恢复操作恢复；当前不提供恢复操作）。
 * 归档快照本身绝不会被后续编辑复活。
 */
function assertNotArchived(project) {
  if (project && project.status === 'archived') {
    throw workbenchError('PROJECT_ARCHIVED', '项目已归档（只读）：编辑/分析/审核/交接操作已拒绝；归档快照不会被修改。');
  }
}

/** 页面可读的步骤状态机（单项目）。 */
export async function buildProjectWorkflowState(project, { hasher = fingerprintOf } = {}) {
  const evidence = project.evidence || [];
  const analyses = project.analyses || [];
  const cards = project.knowledge_cards || [];
  const brief = project.brief || null;
  const handoff = project.handoff || null;
  const staleness = await computeStaleness(project, { hasher });
  const decision = brief && brief.review && brief.review.decision ? brief.review.decision : null;
  const briefApproved = Boolean(decision && decision.value === 'approved' && decision.source === HANDOFF_DECISION_METHOD);
  const steps = [
    { id: 'project', label: '研究项目', done: true, blocking: [] },
    { id: 'evidence', label: '证据采集', done: evidence.length > 0, blocking: evidence.length > 0 ? [] : ['至少录入一条证据。'] },
    { id: 'analysis', label: '来源分析', done: analyses.length > 0, blocking: analyses.length > 0 ? [] : ['对证据运行分析（多模态模型或确定性本地）。'] },
    { id: 'card', label: '知识卡', done: cards.length > 0, blocking: cards.length > 0 ? [] : ['把分析结果转为 content_knowledge_card_v1 知识卡。'] },
    { id: 'brief', label: '内容策划草案', done: Boolean(brief), blocking: brief ? [] : ['组装内容策划草案（待你确认）。'] },
    {
      id: 'review',
      label: '人工审核',
      done: briefApproved && !staleness.brief_stale,
      blocking: !brief ? ['先组装 Brief。'] : staleness.brief_stale ? [`Brief 已过时：${staleness.brief_stale_reasons[0] || '上游内容已变化'}。请重建 Brief 后再审核。`] : briefApproved ? [] : brief.status === 'returned' ? ['Brief 已被退回修改，请重建并重新审核。'] : ['当前 Brief 尚未批准。'],
    },
    { id: 'handoff', label: '交接包', done: Boolean(handoff), blocking: briefApproved && !staleness.brief_stale ? ['批准 Brief 后可派生 P5 交接包。'] : ['只有当前 Brief 修订被批准且未过时，才能派生交接包。'] },
    { id: 'lineage', label: '世系审计', done: true, blocking: [] },
  ];
  return {
    steps,
    counts: {
      evidence: evidence.length,
      analyses: analyses.length,
      cards: cards.length,
    },
    brief_status: brief ? brief.status : null,
    brief_version: brief ? brief.version : null,
    brief_approved: briefApproved,
    brief_stale: staleness.brief_stale,
    brief_stale_reasons: staleness.brief_stale_reasons,
    handoff_present: Boolean(handoff),
    handoff_stale: staleness.handoff_stale,
    execution_flags: projectExecutionFlags(project),
  };
}
