// P19 运营研究工作台：纯数据契约与有界校验（浏览器与 node:test 双环境可用）。
//
// 复刻自已验收来源（只读参考，未整体复制脏仓库）：
// - Knowledge Engine: content_knowledge_card_v1 校验器（纯校验部分）、
//   ams_brief_review_v1 决定契约（approved / return_for_revision + local_manual）、
//   ams_external_handoff_package_v1 边界（handoff-pkg-<24hex>、四项执行标志严格 false、
//   source_trace local_bridge / approved_content_brief、全局结构边界）。
// - video-generator: P16 世系审计的节点/边、current/invalid/stale 源状态、
//   INVALID_SOURCE > BROKEN > PARTIAL > COMPLETE 优先级（见 p19-lineage.js）。
//
// 本模块不执行任何网络、模型、生成、路由、发布、子进程或密钥访问；
// 不读取 localStorage；全部函数为纯函数或纯校验器。

export const EXECUTION_FLAG_KEYS = Object.freeze([
  'generation_executed',
  'routing_executed',
  'network_executed',
  'publish_executed',
]);

export const EXECUTION_FLAGS = Object.freeze(
  EXECUTION_FLAG_KEYS.reduce((acc, key) => ({ ...acc, [key]: false }), {}),
);

export const EXECUTION_FLAG_LABELS = Object.freeze({
  generation_executed: '生成',
  routing_executed: '路由',
  network_executed: '网络',
  publish_executed: '发布',
});

// ---- 已验收边界常量（与 Knowledge Engine 交接包服务一致）----
export const MAX_IDENTIFIER_LENGTH = 200;   // 关键身份/标识字段上限
export const MAX_STRING_LENGTH = 5000;      // 有效记录中任意单个字符串上限
export const MAX_SERIALIZED_BYTES = 262144; // 序列化记录上限（256 KiB）
export const MAX_NESTING_DEPTH = 8;         // 嵌套层级上限
export const MAX_ARRAY_LENGTH = 100;        // 数组条目上限
export const MAX_DIAGNOSTIC_LENGTH = 512;   // 公开诊断文案上限
export const MAX_DISPLAY_TEXT = 120;
export const MAX_ID_TEXT = 80;
export const MAX_SHORT_TEXT = 40;

export const PACKAGE_ID_PATTERN = /^handoff-pkg-[0-9a-f]{24}$/;
export const PROJECT_ID_PATTERN = /^prj-[0-9a-f]{24}$/;
export const EVIDENCE_ID_PATTERN = /^ev-[0-9a-f]{24}$/;
export const ANALYSIS_ID_PATTERN = /^an-[0-9a-f]{24}$/;
export const CARD_ID_PATTERN = /^kc-[0-9a-f]{24}$/;
export const BRIEF_ID_PATTERN = /^brief-[0-9a-f]{24}$/;

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const URL_PATTERN = /^https?:\/\/[^\s]+$/i;

// ---- P29 多模态证据扩展（有界媒体资产 / 来源快照 / 模型分析）----
export const P29_MEDIA_ID_PATTERN = /^m-[0-9a-f]{24}$/;
export const P29_MAX_MEDIA = 8; // 正常 X 帖子媒体上限；超出声明边界必须硬失败，绝不静默截断
export const P29_MEDIA_KINDS = Object.freeze(['image', 'video', 'gif']);
export const P29_HASH_KINDS = Object.freeze(['url', 'content']); // 明确区分 URL 字符串哈希与内容哈希
export const P29_ENGAGEMENT_KEYS = Object.freeze(['likes', 'retweets', 'replies', 'quotes', 'views', 'bookmarks']);
export const P29_MAX_ENGAGEMENT = 1000000000000; // 互动计数上界（1e12）
export const P29_MAX_MEDIA_BYTES = 536870912; // 512 MiB，与媒体元数据字节边界一致
export const MODEL_ANALYSIS_SCHEMA_VERSION = 'p29_multimodal_model_v1';
export const P32_MODEL_ANALYSIS_SCHEMA_VERSION = 'p32_multimodal_model_v2';
export const MULTIMODAL_MODEL = 'qwen3.5-omni-flash';
export const MULTIMODAL_PROVIDER = 'dashscope';
export const MULTIMODAL_METHOD = 'multimodal_model';

// P32-A v2 result fields: backward-compatible extension of v1 bounded structured fields.
export const P32_V2_RESULT_KEYS = Object.freeze([
  'text_expression', 'hook', 'copy_pattern', 'target_audience', 'audience_need_emotion',
  'media_analysis', 'virality_drivers', 'reusable_methods', 'rewrite_suggestions',
  'signals', 'risks',
]);
export const P32_V2_MEDIA_ANALYSIS_KEYS = Object.freeze([
  'media_id', 'visual_content', 'composition', 'people', 'scene', 'emotion',
  'visual_selling_points', 'style_pattern',
]);

export const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// ---- 精确 schema 版本 ----
export const PROJECT_SCHEMA_VERSION = 'p19_research_project_v1';
export const EVIDENCE_SCHEMA_VERSION = 'p19_evidence_record_v1';
export const P22_EVIDENCE_PROVENANCE_SCHEMA_VERSION = 'p22_apify_evidence_provenance_v1';
export const ANALYSIS_SCHEMA_VERSION = 'p19_analysis_v1';
export const KNOWLEDGE_CARD_SCHEMA_VERSION = 'content_knowledge_card_v1';
export const BRIEF_SCHEMA_VERSION = 'ams_content_brief_v1';
export const BRIEF_REVIEW_SCHEMA_VERSION = 'ams_brief_review_v1';
export const HANDOFF_SCHEMA_VERSION = 'ams_external_handoff_package_v1';
export const PROJECT_PACKAGE_SCHEMA_VERSION = 'p19_project_package_v1';
export const STORE_SCHEMA_VERSION = 'p19_store_v1';
export const LINEAGE_SCHEMA_VERSION = 'p19_lineage_audit_v1';

export const BRIEF_DECISIONS = Object.freeze(['approved', 'return_for_revision']);
export const BRIEF_STATUSES = Object.freeze(['pending_review', 'approved', 'returned']);
export const PROJECT_STATUSES = Object.freeze(['active', 'archived']);

export const ANALYSIS_KIND = 'deterministic_local';
export const HANDOFF_DECISION_METHOD = 'local_manual';
export const HANDOFF_KIND = 'external_generation_handoff_package';
export const HANDOFF_STATUS = 'ready_for_external_import';
export const HANDOFF_PAYLOAD_LABEL = 'local_external_generation_handoff_package';

// ---- 有界工具 ----

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 有界展示文本：剥离控制字符并截断，绝不把无界原始值回显到页面。 */
export function boundedText(value, max = MAX_DISPLAY_TEXT) {
  if (typeof value !== 'string') return '';
  const clean = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 追加公开诊断：固定文案且强制 <=512 字符，绝不回显无界原始值。 */
export function issue(issues, message) {
  issues.push(
    message.length > MAX_DIAGNOSTIC_LENGTH
      ? `${message.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
      : message,
  );
}

/** 全局结构边界：任意字符串 <=5000、任意数组 <=100、嵌套 <=8、序列化 <=262144 字节。 */
export function checkGlobalBounds(record, issues) {
  let oversizeString = false;
  let oversizedArray = false;
  let tooDeep = false;
  const walk = (value, depth) => {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) oversizedArray = true;
      if (depth + 1 > MAX_NESTING_DEPTH) {
        tooDeep = true;
        return;
      }
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') {
      if (depth + 1 > MAX_NESTING_DEPTH) {
        tooDeep = true;
        return;
      }
      for (const key of Object.keys(value)) walk(value[key], depth + 1);
      return;
    }
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) oversizeString = true;
  };
  walk(record, 0);
  if (tooDeep) issue(issues, `记录嵌套层级超过 ${MAX_NESTING_DEPTH} 层上限。`);
  if (oversizedArray) issue(issues, `记录包含超过 ${MAX_ARRAY_LENGTH} 项的数组。`);
  if (oversizeString) issue(issues, `记录包含超过 ${MAX_STRING_LENGTH} 字符的字符串（无界内容）。`);
  let bytes = 0;
  try {
    bytes = new globalThis.TextEncoder().encode(JSON.stringify(record)).length;
  } catch {
    bytes = MAX_SERIALIZED_BYTES + 1;
  }
  if (bytes > MAX_SERIALIZED_BYTES) issue(issues, `序列化记录超过 ${MAX_SERIALIZED_BYTES} 字节上限。`);
}

export function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clonePlain(value[key]);
    return out;
  }
  return value;
}

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** 规范化 JSON（键排序），保证指纹/哈希确定性。 */
export function stableCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(stableCanonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableCanonicalJson(value[key])]),
    );
  }
  return value;
}

/**
 * SHA-256（小写十六进制）。使用 WebCrypto（浏览器与 Node >=18 均可用）；
 * 校验失败（如环境缺失）时抛错，绝不回退到非密码学哈希。
 */
export async function sha256Hex(text) {
  const bytes = new globalThis.TextEncoder().encode(String(text));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 同步 SHA-256，仅用于同步 localStorage 读边界的完整性复验。
 * 算法输入与 WebCrypto 版本完全相同（UTF-8 字节），便于读取前 fail closed。
 */
export function sha256HexSync(text) {
  const bytes = Array.from(new globalThis.TextEncoder().encode(String(text)));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i += 1) {
      const p = offset + i * 4;
      w[i] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
  }
  return h.map((value) => value.toString(16).padStart(8, '0')).join('');
}

export function fingerprintOfSync(value) {
  return sha256HexSync(JSON.stringify(stableCanonicalJson(value)));
}

export async function fingerprintOf(value) {
  return sha256Hex(JSON.stringify(stableCanonicalJson(value)));
}

/** 从规范化指纹截取稳定 id：前缀 + 24 位十六进制。 */
export async function stableId(prefix, value) {
  const digest = await fingerprintOf(value);
  return `${prefix}${digest.slice(0, 24)}`;
}

/** 证据溯源快照指纹：全部证据 id:指纹 排序拼接（确定性、同步，供 Brief 快照比对）。 */
export function evidenceProofFingerprint(evidence) {
  return (Array.isArray(evidence) ? evidence : [])
    .filter((record) => isPlainObject(record) && isNonEmptyString(record.fingerprint))
    .map((record) => `${record.id}:${record.fingerprint}`)
    .sort()
    .join('|');
}

/** Resolve only the Evidence records transitively cited by a Brief's cards.
 * The chain is fail-closed: every cited card, analysis and evidence identity must
 * be unique and its stored version/fingerprint binding must still be exact.
 */
export function resolveBriefEvidenceBindings(project, citationIds) {
  const ids = Array.isArray(citationIds) ? citationIds : [];
  const cards = Array.isArray(project?.knowledge_cards) ? project.knowledge_cards : [];
  const analyses = Array.isArray(project?.analyses) ? project.analyses : [];
  const evidence = Array.isArray(project?.evidence) ? project.evidence : [];
  const issues = [];
  const resolved = [];
  const seenCitations = new Set();
  const seenAnalyses = new Set();
  const seenEvidence = new Set();

  for (const cardId of ids) {
    if (!isNonEmptyString(cardId) || seenCitations.has(cardId)) {
      issues.push('Brief knowledge citation identity is missing or duplicated.');
      continue;
    }
    seenCitations.add(cardId);
    const cardMatches = cards.filter((record) => record?.id === cardId);
    if (cardMatches.length !== 1) {
      issues.push('Brief knowledge citation does not resolve to exactly one card.');
      continue;
    }
    const card = cardMatches[0];
    if (card.project_id !== project?.id) {
      issues.push('Brief knowledge card belongs to a different project.');
      continue;
    }
    if (!isNonEmptyString(card.analysis_id) || seenAnalyses.has(card.analysis_id)) {
      issues.push('Brief card analysis identity is missing or duplicated.');
      continue;
    }
    seenAnalyses.add(card.analysis_id);
    const analysisMatches = analyses.filter((record) => record?.id === card.analysis_id);
    if (analysisMatches.length !== 1) {
      issues.push('Brief card does not resolve to exactly one analysis.');
      continue;
    }
    const analysis = analysisMatches[0];
    if (analysis.project_id !== project?.id) {
      issues.push('Brief analysis belongs to a different project.');
      continue;
    }
    if (card.analysis_fingerprint !== analysis.fingerprint || card.analysis_version !== analysis.version) {
      issues.push('Brief card analysis binding is stale or mismatched.');
      continue;
    }
    if (!isNonEmptyString(analysis.evidence_id) || seenEvidence.has(analysis.evidence_id)) {
      issues.push('Brief analysis evidence identity is missing or duplicated.');
      continue;
    }
    seenEvidence.add(analysis.evidence_id);
    const evidenceMatches = evidence.filter((record) => record?.id === analysis.evidence_id);
    if (evidenceMatches.length !== 1) {
      issues.push('Brief analysis does not resolve to exactly one evidence record.');
      continue;
    }
    const source = evidenceMatches[0];
    if (source.project_id !== project?.id) {
      issues.push('Brief evidence belongs to a different project.');
      continue;
    }
    if (analysis.evidence_fingerprint !== source.fingerprint || analysis.evidence_version !== source.version) {
      issues.push('Brief analysis evidence binding is stale or mismatched.');
      continue;
    }
    resolved.push(source);
  }

  return {
    valid: ids.length > 0 && issues.length === 0 && resolved.length === ids.length,
    evidence: resolved,
    issues,
  };
}

// ---- 项目 ----

export function validateProject(project) {
  const issues = [];
  if (!isPlainObject(project)) {
    issue(issues, '项目记录不是对象，无法按 P19 项目契约校验。');
    return { valid: false, issues };
  }
  if (project.schema_version !== PROJECT_SCHEMA_VERSION) issue(issues, 'schema_version 不是精确的 p19_research_project_v1。');
  if (!isNonEmptyString(project.id) || !PROJECT_ID_PATTERN.test(project.id)) issue(issues, '项目 id 不是稳定的有界 prj-<24位十六进制> 格式。');
  if (!Number.isInteger(project.version) || project.version < 1) issue(issues, '项目版本必须是正整数。');
  if (!PROJECT_STATUSES.includes(project.status)) issue(issues, '项目状态必须是 active 或 archived。');
  if (!isNonEmptyString(project.topic) || project.topic.length > MAX_STRING_LENGTH) issue(issues, '项目主题缺失或超长。');
  if (!isNonEmptyString(project.objective) || project.objective.length > MAX_STRING_LENGTH) issue(issues, '项目目标缺失或超长。');
  if (!isNonEmptyString(project.audience) || project.audience.length > MAX_IDENTIFIER_LENGTH) issue(issues, '目标受众缺失或超长。');
  if (!isNonEmptyString(project.channel) || project.channel.length > MAX_IDENTIFIER_LENGTH) issue(issues, '目标渠道缺失或超长。');
  if (!Array.isArray(project.constraints) || !project.constraints.every((item) => typeof item === 'string' && item.trim().length <= MAX_STRING_LENGTH)) {
    issue(issues, '约束必须是字符串数组。');
  }
  if (project.execution_flags !== undefined && project.execution_flags !== null && !validateExecutionFlags(project.execution_flags).valid) {
    issue(issues, '执行标志不是四项严格 false。');
  }
  checkGlobalBounds(project, issues);
  return { valid: issues.length === 0, issues };
}

export function validateExecutionFlags(flags) {
  const issues = [];
  if (!isPlainObject(flags)) {
    issue(issues, '缺少 execution_flags 对象。');
    return { valid: false, issues };
  }
  for (const key of EXECUTION_FLAG_KEYS) {
    if (!(key in flags)) {
      issue(issues, `${key} 缺失。`);
    } else if (flags[key] !== false) {
      issue(issues, `${key} 不是严格布尔 false。`);
    }
  }
  if (Object.keys(flags).some((key) => !EXECUTION_FLAG_KEYS.includes(key))) {
    issue(issues, 'execution_flags 包含未知的额外标志。');
  }
  return { valid: issues.length === 0, issues };
}

// ---- 证据 ----

export function validateMediaMetadata(meta) {
  const issues = [];
  if (meta === null) return { valid: true, issues };
  if (!isPlainObject(meta)) {
    issue(issues, '媒体元数据必须是对象或 null。');
    return { valid: false, issues };
  }
  if (meta.filename !== undefined && (typeof meta.filename !== 'string' || meta.filename.length > 200)) issue(issues, '媒体文件名缺失或超长。');
  if (meta.mime_type !== undefined && (typeof meta.mime_type !== 'string' || meta.mime_type.length > 100)) issue(issues, '媒体 MIME 类型缺失或超长。');
  if (meta.byte_size !== undefined && (!Number.isInteger(meta.byte_size) || meta.byte_size < 0 || meta.byte_size > 536870912)) issue(issues, '媒体字节大小必须是 0..512MiB 的整数。');
  if (meta.last_modified !== undefined && (typeof meta.last_modified !== 'string' || meta.last_modified.length > 80)) issue(issues, '媒体最后修改时间格式无效。');
  if (meta.sha256 !== undefined && (typeof meta.sha256 !== 'string' || !SHA256_PATTERN.test(meta.sha256))) issue(issues, '媒体 SHA-256 必须是 64 位十六进制。');
  if (Object.keys(meta).some((key) => !['filename', 'mime_type', 'byte_size', 'last_modified', 'sha256'].includes(key))) {
    issue(issues, '媒体元数据包含未知字段。');
  }
  return { valid: issues.length === 0, issues };
}

// ---- P29：来源快照（作者/发布时间/互动）与有序媒体资产 ----

export function validateSourceMetadata(meta) {
  const issues = [];
  if (meta === null) return { valid: true, issues };
  if (!isPlainObject(meta)) {
    issue(issues, '来源快照必须是对象或 null。');
    return { valid: false, issues };
  }
  const unknown = Object.keys(meta).filter((key) => !['author', 'published_at', 'engagement'].includes(key));
  if (unknown.length) issue(issues, '来源快照包含未知字段。');
  const author = meta.author;
  if (author !== null && author !== undefined) {
    if (!isPlainObject(author)) {
      issue(issues, '来源作者必须是对象或 null。');
    } else {
      const authorUnknown = Object.keys(author).filter((key) => !['name', 'handle', 'user_id'].includes(key));
      if (authorUnknown.length) issue(issues, '来源作者包含未知字段。');
      if (author.name !== null && author.name !== undefined && (typeof author.name !== 'string' || author.name.trim().length === 0 || author.name.length > 120)) issue(issues, '作者显示名缺失或超长。');
      if (author.handle !== null && author.handle !== undefined && (typeof author.handle !== 'string' || author.handle.trim().length === 0 || author.handle.length > 80)) issue(issues, '作者句柄缺失或超长。');
      if (author.user_id !== null && author.user_id !== undefined && (typeof author.user_id !== 'string' || author.user_id.trim().length === 0 || author.user_id.length > 80)) issue(issues, '作者 ID 缺失或超长。');
    }
  }
  if (meta.published_at !== null && meta.published_at !== undefined) {
    if (typeof meta.published_at !== 'string' || meta.published_at.length > 80 || !ISO8601_PATTERN.test(meta.published_at)) {
      issue(issues, '来源发布时间必须是 ISO-8601 时间字符串或 null。');
    }
  }
  const engagement = meta.engagement;
  if (engagement !== null && engagement !== undefined) {
    if (!isPlainObject(engagement)) {
      issue(issues, '互动计数必须是对象或 null。');
    } else {
      const engagementUnknown = Object.keys(engagement).filter((key) => !P29_ENGAGEMENT_KEYS.includes(key));
      if (engagementUnknown.length) issue(issues, '互动计数包含未知字段。');
      for (const key of P29_ENGAGEMENT_KEYS) {
        const value = engagement[key];
        if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0 || value > P29_MAX_ENGAGEMENT)) {
          issue(issues, `互动计数 ${key} 必须是非负有界整数或 null。`);
        }
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

export function validateMediaAsset(asset) {
  const issues = [];
  if (!isPlainObject(asset)) {
    issue(issues, '媒体资产必须是对象。');
    return { valid: false, issues };
  }
  const unknown = Object.keys(asset).filter((key) => ![
    'id', 'tweet_id', 'external_id', 'canonical_tweet_url', 'media_url', 'order', 'kind',
    'mime_type', 'dimensions', 'byte_size', 'hash',
  ].includes(key));
  if (unknown.length) issue(issues, '媒体资产包含未知字段。');
  if (!isNonEmptyString(asset.id) || !P29_MEDIA_ID_PATTERN.test(asset.id)) issue(issues, '媒体资产 id 不是稳定的有界 m-<24位十六进制> 格式。');
  if (asset.tweet_id !== null && asset.tweet_id !== undefined && (typeof asset.tweet_id !== 'string' || asset.tweet_id.trim().length === 0 || asset.tweet_id.length > 160)) issue(issues, '媒体推文绑定缺失或超长。');
  if (asset.external_id !== null && asset.external_id !== undefined && (typeof asset.external_id !== 'string' || asset.external_id.trim().length === 0 || asset.external_id.length > 160)) issue(issues, '媒体外部 ID 缺失或超长。');
  if (typeof asset.canonical_tweet_url !== 'string' || !URL_PATTERN.test(asset.canonical_tweet_url) || asset.canonical_tweet_url.length > 1000) issue(issues, '媒体绑定推文 URL 无效。');
  if (typeof asset.media_url !== 'string' || !URL_PATTERN.test(asset.media_url) || asset.media_url.length > 1000) issue(issues, '媒体 URL 必须是 http(s) 且有界。');
  if (!Number.isInteger(asset.order) || asset.order < 0 || asset.order >= P29_MAX_MEDIA) issue(issues, '媒体序号必须是 0..7 的整数。');
  if (!P29_MEDIA_KINDS.includes(asset.kind)) issue(issues, '媒体种类必须是 image / video / gif。');
  if (typeof asset.mime_type !== 'string' || asset.mime_type.length > 100) issue(issues, '媒体 MIME 类型缺失或超长。');
  const dimensions = asset.dimensions;
  if (dimensions !== null && dimensions !== undefined) {
    if (!isPlainObject(dimensions) || Object.keys(dimensions).some((key) => !['width', 'height'].includes(key))) {
      issue(issues, '媒体尺寸必须是 {width,height} 对象或 null。');
    } else if (!Number.isInteger(dimensions.width) || dimensions.width < 1 || dimensions.width > 65536
      || !Number.isInteger(dimensions.height) || dimensions.height < 1 || dimensions.height > 65536) {
      issue(issues, '媒体尺寸必须是 1..65536 的整数或 null。');
    }
  }
  if (asset.byte_size !== null && asset.byte_size !== undefined && (!Number.isInteger(asset.byte_size) || asset.byte_size < 0 || asset.byte_size > P29_MAX_MEDIA_BYTES)) {
    issue(issues, '媒体字节大小必须是 0..512MiB 的整数或 null。');
  }
  const hash = asset.hash;
  if (!isPlainObject(hash)) {
    issue(issues, '媒体完整性记录缺失。');
  } else {
    const hashUnknown = Object.keys(hash).filter((key) => !['algorithm', 'kind', 'value'].includes(key));
    if (hashUnknown.length) issue(issues, '媒体完整性记录包含未知字段。');
    if (hash.algorithm !== 'sha256') issue(issues, '媒体哈希算法必须精确为 sha256。');
    if (!P29_HASH_KINDS.includes(hash.kind)) issue(issues, '媒体哈希种类必须是 url 或 content（绝不把 URL 字符串哈希冒充内容哈希）。');
    if (typeof hash.value !== 'string' || !SHA256_PATTERN.test(hash.value)) issue(issues, '媒体哈希值必须是 64 位十六进制。');
  }
  return { valid: issues.length === 0, issues };
}

export function validateMediaAssets(assets) {
  const issues = [];
  if (!Array.isArray(assets)) {
    issue(issues, '媒体资产必须是数组。');
    return { valid: false, issues };
  }
  if (assets.length > P29_MAX_MEDIA) issue(issues, `媒体资产数量超过 ${P29_MAX_MEDIA} 条声明上限。`);
  const ids = new Set();
  const urls = new Set();
  assets.forEach((asset, index) => {
    const verdict = validateMediaAsset(asset);
    if (!verdict.valid) issues.push(...verdict.issues);
    if (asset && typeof asset === 'object') {
      if (typeof asset.id === 'string') {
        if (ids.has(asset.id)) issue(issues, `媒体资产 id 重复：${asset.id.slice(0, 24)}。`);
        ids.add(asset.id);
      }
      if (typeof asset.media_url === 'string') {
        if (urls.has(asset.media_url)) issue(issues, '媒体资产 URL 重复。');
        urls.add(asset.media_url);
      }
      if (asset.order !== index) issue(issues, '媒体资产顺序与零基下标不一致（乱序）。');
    }
  });
  return { valid: issues.length === 0, issues };
}

export function validateModelAnalysis(extension) {
  const issues = [];
  if (!isPlainObject(extension)) {
    issue(issues, '模型分析扩展必须是对象。');
    return { valid: false, issues };
  }
  const unknown = Object.keys(extension).filter((key) => ![
    'schema_version', 'provider', 'model', 'method', 'executed_at', 'media_ids', 'result', 'usage',
  ].includes(key));
  if (unknown.length) issue(issues, '模型分析扩展包含未知字段。');
  if (extension.schema_version !== MODEL_ANALYSIS_SCHEMA_VERSION) issue(issues, '模型分析扩展 schema_version 不是精确的 p29_multimodal_model_v1。');
  if (extension.provider !== MULTIMODAL_PROVIDER) issue(issues, '模型提供方不是精确的 dashscope。');
  if (extension.method !== MULTIMODAL_METHOD) issue(issues, '模型分析方法不是精确的 multimodal_model。');
  if (!isNonEmptyString(extension.model) || extension.model.length > 80) issue(issues, '模型标识缺失或超长。');
  if (!isNonEmptyString(extension.executed_at) || extension.executed_at.length > 80 || !ISO8601_PATTERN.test(extension.executed_at)) issue(issues, '模型执行时间必须是 ISO-8601 字符串。');
  const mediaIds = extension.media_ids;
  if (!Array.isArray(mediaIds) || mediaIds.length > P29_MAX_MEDIA
    || !mediaIds.every((id) => isNonEmptyString(id) && P29_MEDIA_ID_PATTERN.test(id))) {
    issue(issues, '媒体绑定列表必须是有界的 m-<24位十六进制> id 数组。');
  } else if (new Set(mediaIds).size !== mediaIds.length) {
    issue(issues, '媒体绑定列表包含重复 id。');
  }
  const usage = extension.usage;
  if (!isPlainObject(usage) || !Number.isInteger(usage.total_tokens) || usage.total_tokens <= 0) {
    issue(issues, '模型用量必须是含正整数的 total_tokens 对象。');
  }
  const result = extension.result;
  if (!isPlainObject(result)) {
    issue(issues, '模型结果必须是对象。');
  } else {
    const resultUnknown = Object.keys(result).filter((key) => ![
      'text_expression', 'media_analysis', 'virality_drivers', 'reusable_methods', 'signals', 'risks',
    ].includes(key));
    if (resultUnknown.length) issue(issues, '模型结果包含未知字段。');
    if (!isNonEmptyString(result.text_expression) || result.text_expression.length > 300) issue(issues, 'text_expression 必须为非空且不超过 300 字符。');
    const mediaAnalysis = result.media_analysis;
    if (!Array.isArray(mediaAnalysis)) {
      issue(issues, '缺少逐媒体分析 media_analysis。');
    } else {
      if (mediaAnalysis.length !== mediaIds.length) issue(issues, '逐媒体分析数量与媒体绑定数量不一致。');
      mediaAnalysis.forEach((row, index) => {
        if (!isPlainObject(row)) {
          issue(issues, `逐媒体分析 #${index + 1} 不是对象。`);
          return;
        }
        const rowUnknown = Object.keys(row).filter((key) => !['media_id', 'visual_content', 'composition', 'people', 'scene', 'emotion'].includes(key));
        if (rowUnknown.length) issue(issues, `逐媒体分析 #${index + 1} 包含未知字段。`);
        if (row.media_id !== mediaIds[index]) issue(issues, `逐媒体分析 #${index + 1} 未按顺序绑定精确媒体 id（缺失/重复/乱序/外来均失败）。`);
        for (const key of ['visual_content', 'composition', 'people', 'scene', 'emotion']) {
          if (!isNonEmptyString(row[key]) || row[key].length > 500) issue(issues, `逐媒体分析 ${key} 必须为非空且不超过 500 字符。`);
        }
      });
    }
    for (const key of ['virality_drivers', 'reusable_methods', 'signals', 'risks']) {
      const list = result[key];
      if (!Array.isArray(list) || list.length > 5 || !list.every((entry) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 240)) {
        issue(issues, `${key} 必须是最多 5 项非空且每项不超过 240 字符的数组。`);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

/** P32-A 版本化模型分析扩展（p32_multimodal_model_v2）：向后兼容 v1 的有界结果字段扩展。 */
export function validateP32ModelAnalysis(extension) {
  const issues = [];
  if (!isPlainObject(extension)) {
    issue(issues, '模型分析扩展必须是对象。');
    return { valid: false, issues };
  }
  const unknown = Object.keys(extension).filter((key) => ![
    'schema_version', 'provider', 'model', 'method', 'executed_at', 'media_ids', 'result', 'usage', '_request_identity',
  ].includes(key));
  if (unknown.length) issue(issues, '模型分析扩展包含未知字段。');
  if (extension.schema_version !== P32_MODEL_ANALYSIS_SCHEMA_VERSION) issue(issues, '模型分析扩展 schema_version 不是精确的 p32_multimodal_model_v2。');
  if (extension.provider !== MULTIMODAL_PROVIDER) issue(issues, '模型提供方不是精确的 dashscope。');
  if (extension.method !== MULTIMODAL_METHOD) issue(issues, '模型分析方法不是精确的 multimodal_model。');
  if (!isNonEmptyString(extension.model) || extension.model.length > 80) issue(issues, '模型标识缺失或超长。');
  if (!isNonEmptyString(extension.executed_at) || extension.executed_at.length > 80 || !ISO8601_PATTERN.test(extension.executed_at)) issue(issues, '模型执行时间必须是 ISO-8601 字符串。');
  const mediaIds = extension.media_ids;
  if (!Array.isArray(mediaIds) || mediaIds.length > P29_MAX_MEDIA
    || !mediaIds.every((id) => isNonEmptyString(id) && P29_MEDIA_ID_PATTERN.test(id))) {
    issue(issues, '媒体绑定列表必须是有界的 m-<24位十六进制> id 数组。');
  } else if (new Set(mediaIds).size !== mediaIds.length) {
    issue(issues, '媒体绑定列表包含重复 id。');
  }
  const usage = extension.usage;
  if (!isPlainObject(usage) || !Number.isInteger(usage.total_tokens) || usage.total_tokens <= 0) {
    issue(issues, '模型用量必须是含正整数的 total_tokens 对象。');
  }
  const result = extension.result;
  if (!isPlainObject(result)) {
    issue(issues, '模型结果必须是对象。');
  } else {
    const resultUnknown = Object.keys(result).filter((key) => !P32_V2_RESULT_KEYS.includes(key));
    if (resultUnknown.length) issue(issues, '模型结果包含未知字段。');
    for (const key of ['text_expression', 'hook', 'copy_pattern', 'target_audience', 'audience_need_emotion']) {
      if (!isNonEmptyString(result[key]) || result[key].length > 500) issue(issues, `${key} 必须为非空且不超过 500 字符。`);
    }
    const mediaAnalysis = result.media_analysis;
    if (!Array.isArray(mediaAnalysis)) {
      issue(issues, '缺少逐媒体分析 media_analysis。');
    } else {
      if (mediaAnalysis.length !== mediaIds.length) issue(issues, '逐媒体分析数量与媒体绑定数量不一致。');
      mediaAnalysis.forEach((row, index) => {
        if (!isPlainObject(row)) {
          issue(issues, `逐媒体分析 #${index + 1} 不是对象。`);
          return;
        }
        const rowUnknown = Object.keys(row).filter((key) => !P32_V2_MEDIA_ANALYSIS_KEYS.includes(key));
        if (rowUnknown.length) issue(issues, `逐媒体分析 #${index + 1} 包含未知字段。`);
        if (row.media_id !== mediaIds[index]) issue(issues, `逐媒体分析 #${index + 1} 未按顺序绑定精确媒体 id（缺失/重复/乱序/外来均失败）。`);
        for (const key of ['visual_content', 'composition', 'people', 'scene', 'emotion', 'style_pattern']) {
          if (!isNonEmptyString(row[key]) || row[key].length > 500) issue(issues, `逐媒体分析 ${key} 必须为非空且不超过 500 字符。`);
        }
        const sellingPoints = row.visual_selling_points;
        if (!Array.isArray(sellingPoints) || sellingPoints.length === 0 || sellingPoints.length > 3 || !sellingPoints.every((entry) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 240)) {
          issue(issues, `逐媒体分析 visual_selling_points 必须是最多 3 项非空且每项不超过 240 字符的数组。`);
        }
      });
    }
    for (const key of ['virality_drivers', 'reusable_methods', 'rewrite_suggestions', 'signals', 'risks']) {
      const list = result[key];
      if (!Array.isArray(list) || list.length === 0 || list.length > 5 || !list.every((entry) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 240)) {
        issue(issues, `${key} 必须是最多 5 项非空且每项不超过 240 字符的数组。`);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

export function validateEvidenceRecord(record) {
  const issues = [];
  if (!isPlainObject(record)) {
    issue(issues, '证据记录不是对象，无法按 P19 证据契约校验。');
    return { valid: false, issues };
  }
  if (record.schema_version !== EVIDENCE_SCHEMA_VERSION) issue(issues, 'schema_version 不是精确的 p19_evidence_record_v1。');
  if (!isNonEmptyString(record.id) || !EVIDENCE_ID_PATTERN.test(record.id)) issue(issues, '证据 id 不是稳定的有界 ev-<24位十六进制> 格式。');
  if (!isNonEmptyString(record.project_id) || !PROJECT_ID_PATTERN.test(record.project_id)) issue(issues, '证据缺少有效的项目绑定。');
  if (!isNonEmptyString(record.source_url) || !URL_PATTERN.test(record.source_url) || record.source_url.length > 1000) issue(issues, '来源 URL 缺失、格式错误或超长。');
  if (!isNonEmptyString(record.label) || record.label.length > 200) issue(issues, '证据标签缺失或超长。');
  if (!isNonEmptyString(record.platform) || record.platform.length > 80) issue(issues, '平台缺失或超长。');
  if (!isNonEmptyString(record.content_text) || record.content_text.length > MAX_STRING_LENGTH) issue(issues, '内容文本缺失或超过 5000 字符。');
  if (!isNonEmptyString(record.recorded_at)) issue(issues, '记录时间缺失。');
  else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(record.recorded_at)) issue(issues, '记录时间必须是 ISO-8601 时间字符串（数据库边界 required 列）。');
  if (!isPlainObject(record.provenance)) {
    issue(issues, '证据来源 provenance 必须是对象。');
  } else if (record.provenance.manual === true) {
    if (typeof record.provenance.statement !== 'string') issue(issues, '证据来源 statement 必须是字符串。');
  } else if (record.provenance.manual === false) {
    const provenance = record.provenance;
    const allowed = [
      'schema_version','manual','method','provider','source_platform','source_id','external_id',
      'source_url','run_id','collected_at','usage_total_usd','budget_reservation_id',
      'content_sha256','collection_proof','statement',
    ];
    if (Object.keys(provenance).some((key) => !allowed.includes(key))) issue(issues, 'P22 来源 provenance 包含未知字段。');
    if (provenance.schema_version !== P22_EVIDENCE_PROVENANCE_SCHEMA_VERSION) issue(issues, 'P22 来源 schema_version 无效。');
    if (provenance.method !== 'apify_public_collection') issue(issues, 'P22 来源 method 无效。');
    if (provenance.provider !== 'apify:xquik/x-tweet-scraper') issue(issues, 'P22 来源 provider 无效。');
    if (provenance.source_platform !== 'x') issue(issues, 'P22 来源平台无效。');
    if (!isNonEmptyString(provenance.source_id) || provenance.source_id.length > 160) issue(issues, 'P22 来源 ID 缺失或超长。');
    if (provenance.external_id !== null && (!isNonEmptyString(provenance.external_id) || provenance.external_id.length > 160)) issue(issues, 'P22 平台内容 ID 无效。');
    if (provenance.source_url !== record.source_url) issue(issues, 'P22 provenance 来源 URL 与证据不一致。');
    if (!isNonEmptyString(provenance.run_id) || provenance.run_id.length > 200) issue(issues, 'P22 采集运行 ID 缺失或超长。');
    if (!isNonEmptyString(provenance.collected_at) || provenance.collected_at !== record.recorded_at) issue(issues, 'P22 采集时间与证据时间不一致。');
    if (!Number.isFinite(provenance.usage_total_usd) || provenance.usage_total_usd < 0 || provenance.usage_total_usd > 10) issue(issues, 'P22 采集用量无效。');
    if (typeof provenance.budget_reservation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(provenance.budget_reservation_id)) issue(issues, 'P22 预算预留身份无效。');
    if (typeof provenance.content_sha256 !== 'string' || !SHA256_PATTERN.test(provenance.content_sha256)) issue(issues, 'P22 正文 SHA-256 无效。');
    if (typeof provenance.collection_proof !== 'string' || !/^\d{10}\.[0-9a-f]{64}$/i.test(provenance.collection_proof)) issue(issues, 'P22 服务端来源证明无效。');
    if (!isNonEmptyString(provenance.statement) || provenance.statement.length > 500) issue(issues, 'P22 来源说明缺失或超长。');
  } else {
    issue(issues, '证据来源 manual 必须是严格布尔值。');
  }
  const media = validateMediaMetadata(record.media_metadata === undefined ? null : record.media_metadata);
  if (!media.valid) issues.push(...media.issues);
  if (record.provenance?.manual === false && record.media_metadata?.sha256 !== record.provenance.content_sha256) {
    issue(issues, 'P22 provenance SHA-256 与媒体元数据不一致。');
  }
  if (record.source_metadata !== undefined) {
    const snapshot = validateSourceMetadata(record.source_metadata);
    if (!snapshot.valid) issues.push(...snapshot.issues);
  }
  if (record.media_assets !== undefined) {
    const assets = validateMediaAssets(record.media_assets);
    if (!assets.valid) issues.push(...assets.issues);
  }
  checkGlobalBounds(record, issues);
  return { valid: issues.length === 0, issues };
}

// ---- 确定性本地分析 ----

export const DETERMINISTIC_RULES = Object.freeze([
  { rule_id: 'source_url_shape', label: '来源 URL 形状', description: '校验来源 URL 必须为 http(s) 且有界，输出协议与主机名。' },
  { rule_id: 'text_length_profile', label: '文本长度画像', description: '按字符数、词数与句数统计正文，超长截断到有界上限。' },
  { rule_id: 'keyword_frequency', label: '关键词频次', description: '去除停用词后按词频降序取前 5 个关键词；同频按首次出现位置决定。' },
  { rule_id: 'tone_indicators', label: '语气标记', description: '统计感叹号、问号、表情符号与全部大写词，输出确定性标记。' },
  { rule_id: 'media_metadata_bounds', label: '媒体元数据边界', description: '校验文件名/MIME/字节大小/修改时间/SHA-256 是否均有界且格式正确。' },
  { rule_id: 'manual_provenance_trust', label: '人工来源可信度', description: '证据为人工录入（manual=true）时输出 trust_status=manual_local。' },
]);

export function validateAnalysis(record) {
  const issues = [];
  if (!isPlainObject(record)) {
    issue(issues, '分析记录不是对象，无法按 P19 分析契约校验。');
    return { valid: false, issues };
  }
  if (record.schema_version !== ANALYSIS_SCHEMA_VERSION) issue(issues, 'schema_version 不是精确的 p19_analysis_v1。');
  if (record.kind !== ANALYSIS_KIND) issue(issues, 'kind 不是精确的 deterministic_local。');
  if (!isNonEmptyString(record.id) || !ANALYSIS_ID_PATTERN.test(record.id)) issue(issues, '分析 id 不是稳定的有界 an-<24位十六进制> 格式。');
  if (!isNonEmptyString(record.project_id) || !PROJECT_ID_PATTERN.test(record.project_id)) issue(issues, '分析缺少有效的项目绑定。');
  if (!isNonEmptyString(record.evidence_id) || !EVIDENCE_ID_PATTERN.test(record.evidence_id)) issue(issues, '分析缺少有效的证据绑定。');
  const extension = record.model_analysis;
  if (extension === undefined) {
    if (!Array.isArray(record.rule_ids) || !record.rule_ids.every((item) => typeof item === 'string' && DETERMINISTIC_RULES.some((rule) => rule.rule_id === item))) {
      issue(issues, '分析规则必须来自确定性规则清单。');
    }
  } else if (extension === null) {
    issue(issues, 'model_analysis 不能为 null：要么缺省（纯确定性分析），要么是 model_analysis 扩展。');
  } else {
    if (!Array.isArray(record.rule_ids) || !record.rule_ids.every((item) => typeof item === 'string' && DETERMINISTIC_RULES.some((rule) => rule.rule_id === item))) {
      issue(issues, '分析规则必须来自确定性规则清单（补充规则；模型结果以 model_analysis 为准）。');
    }
  }
  if (!isPlainObject(record.provenance)) {
    issue(issues, '分析 provenance 必须是对象。');
  } else {
    if (record.provenance.method !== ANALYSIS_KIND) issue(issues, '分析 provenance.method 不是精确的 deterministic_local。');
    if (extension !== undefined) {
      if (record.provenance.model !== (extension && extension.model)) {
        issue(issues, '分析 provenance.model 必须与 model_analysis 模型标识精确一致（保留模型/来源身份）。');
      }
    } else if (record.provenance.model !== null) {
      issue(issues, '分析 provenance.model 必须是 null（纯确定性分析未调用任何模型）。');
    }
  }
  if (!isPlainObject(record.result)) issue(issues, '分析结果 result 必须是对象。');
  if (extension !== undefined) {
    if (extension.schema_version === P32_MODEL_ANALYSIS_SCHEMA_VERSION) {
      const verdict = validateP32ModelAnalysis(extension);
      if (!verdict.valid) issues.push(...verdict.issues);
    } else {
      const verdict = validateModelAnalysis(extension);
      if (!verdict.valid) issues.push(...verdict.issues);
    }
  }
  checkGlobalBounds(record, issues);
  return { valid: issues.length === 0, issues };
}

// ---- 知识卡（复刻已验收 content_knowledge_card_v1 校验器）----

export function validateKnowledgeCard(card) {
  const issues = [];
  if (!isPlainObject(card)) {
    issue(issues, '知识卡不是对象，无法按 content_knowledge_card_v1 校验。');
    return { valid: false, issues };
  }
  if (card.schema_version !== KNOWLEDGE_CARD_SCHEMA_VERSION) issue(issues, 'schema_version 不是精确的 content_knowledge_card_v1。');
  const obs = card.source_observations;
  if (!isPlainObject(obs)) { issue(issues, '缺少 source_observations 对象。'); }
  else {
    if (!isNonEmptyString(obs.post_text)) issue(issues, '缺少来源正文 source_observations.post_text。');
    if (!Array.isArray(obs.uncertainties) || !obs.uncertainties.every((item) => typeof item === 'string' && item.trim())) { issue(issues, 'uncertainties 必须是非空字符串数组。'); }
    const media = obs.media;
    if (!isPlainObject(media)) { issue(issues, '缺少来源媒体 source_observations.media。'); }
    else {
      if (typeof media.duration_seconds !== 'number' || media.duration_seconds < 0) issue(issues, '媒体时长必须是 >=0 的数字。');
      if (!isNonEmptyString(media.resolution)) issue(issues, '媒体分辨率缺失。');
      if (typeof media.audio_track_present !== 'boolean') issue(issues, '音轨存在标记必须是布尔。');
      if (!Array.isArray(media.timeline) || media.timeline.length < 3) issue(issues, 'timeline 必须包含 start/middle/end 至少 3 段。');
      if (!Array.isArray(media.transcript_segments)) issue(issues, 'transcript_segments 必须是数组。');
    }
  }
  const analysis = card.creative_analysis;
  if (!isPlainObject(analysis)) { issue(issues, '缺少 creative_analysis 对象。'); }
  else {
    for (const key of ['hook', 'copy_device', 'visual_impact', 'seductive_tone', 'narrative_arc', 'audio_role']) {
      if (!isNonEmptyString(analysis[key])) issue(issues, `creative_analysis.${key} 缺失。`);
    }
    for (const key of ['semantic_layers', 'audience_response_mechanisms', 'replicable_features']) {
      if (!Array.isArray(analysis[key]) || !analysis[key].every((item) => typeof item === 'string' && item.trim())) { issue(issues, `creative_analysis.${key} 必须是非空字符串数组。`); }
    }
    const risks = analysis.risk_labels;
    if (!isPlainObject(risks)) { issue(issues, '缺少 creative_analysis.risk_labels 对象。'); }
    else {
      if (!['none', 'low', 'medium', 'high'].includes(risks.sexual_suggestiveness)) issue(issues, 'sexual_suggestiveness 枚举无效。');
      if (!['low', 'medium', 'high'].includes(risks.platform_moderation)) issue(issues, 'platform_moderation 枚举无效。');
      if (!['broad', 'restricted', 'adult-oriented'].includes(risks.brand_suitability)) issue(issues, 'brand_suitability 枚举无效。');
      if (!Array.isArray(risks.notes) || !risks.notes.every((item) => typeof item === 'string')) issue(issues, 'risk_labels.notes 必须是字符串数组。');
    }
  }
  if (!Array.isArray(card.evidence_links) || card.evidence_links.length < 3) { issue(issues, 'evidence_links 至少需要 3 条引用。'); }
  else {
    card.evidence_links.forEach((link, index) => {
      if (!isPlainObject(link)) { issue(issues, `证据引用 #${index + 1} 不是对象。`); return; }
      if (!isNonEmptyString(link.claim)) issue(issues, `证据引用 #${index + 1} 缺少 claim。`);
      if (!['post_text', 'video_frame', 'video_sequence', 'audio', 'metadata'].includes(link.evidence_type)) issue(issues, `证据引用 #${index + 1} evidence_type 枚举无效。`);
      if (!isNonEmptyString(link.source_ref)) issue(issues, `证据引用 #${index + 1} 缺少 source_ref。`);
      if (link.time_range !== null && typeof link.time_range !== 'string') issue(issues, `证据引用 #${index + 1} time_range 必须是字符串或 null。`);
      if (typeof link.confidence !== 'number' || link.confidence < 0 || link.confidence > 1) issue(issues, `证据引用 #${index + 1} confidence 必须是 0..1 数字。`);
    });
  }
  const guidance = card.generation_guidance;
  if (!isPlainObject(guidance)) { issue(issues, '缺少 generation_guidance 对象。'); }
  else {
    for (const key of ['reusable_pattern', 'must_preserve', 'must_not_invent', 'prompt_ingredients', 'variation_space']) {
      if (key === 'reusable_pattern') { if (!isNonEmptyString(guidance[key])) issue(issues, 'generation_guidance.reusable_pattern 缺失。'); }
      else if (!Array.isArray(guidance[key]) || !guidance[key].every((item) => typeof item === 'string' && item.trim())) { issue(issues, `generation_guidance.${key} 必须是非空字符串数组。`); }
    }
  }
  const readiness = card.generation_readiness;
  if (!isPlainObject(readiness)) { issue(issues, '缺少 generation_readiness 对象。'); }
  else {
    if (typeof readiness.usable !== 'boolean') issue(issues, 'generation_readiness.usable 必须是布尔。');
    if (!Number.isFinite(readiness.score) || readiness.score < 0 || readiness.score > 100) issue(issues, 'generation_readiness.score 必须是 0..100 数字。');
    if (!Array.isArray(readiness.reasons) || !readiness.reasons.every((item) => typeof item === 'string')) issue(issues, 'generation_readiness.reasons 必须是字符串数组。');
    if (!Array.isArray(readiness.blockers) || !readiness.blockers.every((item) => typeof item === 'string')) issue(issues, 'generation_readiness.blockers 必须是字符串数组。');
  }
  const serialized = JSON.stringify(card);
  for (const forbidden of ['看起来像', '应该是', '大概有']) { if (serialized.includes(forbidden)) { issue(issues, `不确定措辞「${forbidden}」必须移入 uncertainties，不得作为断言出现。`); } }
  if (card.analysis_provenance !== undefined && card.analysis_provenance !== null) {
    const provenance = card.analysis_provenance;
    if (!isPlainObject(provenance)) { issue(issues, '知识卡分析来源 identity 必须是对象或 null。'); }
    else {
      const provenanceUnknown = Object.keys(provenance).filter((key) => !['method', 'provider', 'model', 'executed_at', 'source_analysis_id', 'media_ids', 'statement'].includes(key));
      if (provenanceUnknown.length) issue(issues, '知识卡分析来源 identity 包含未知字段。');
      if (provenance.method !== MULTIMODAL_METHOD) issue(issues, '知识卡分析来源 method 不是精确的 multimodal_model。');
      if (provenance.provider !== MULTIMODAL_PROVIDER) issue(issues, '知识卡分析来源 provider 不是精确的 dashscope。');
      if (!isNonEmptyString(provenance.model) || provenance.model.length > 80) issue(issues, '知识卡分析来源模型标识缺失或超长。');
      if (!isNonEmptyString(provenance.executed_at) || provenance.executed_at.length > 80) issue(issues, '知识卡分析来源执行时间缺失或超长。');
      if (!isNonEmptyString(provenance.source_analysis_id) || provenance.source_analysis_id.length > 200) issue(issues, '知识卡分析来源 analysis 绑定缺失或超长。');
      if (!Array.isArray(provenance.media_ids) || provenance.media_ids.length > P29_MAX_MEDIA || !provenance.media_ids.every((id) => isNonEmptyString(id) && P29_MEDIA_ID_PATTERN.test(id))) { issue(issues, '知识卡分析来源媒体绑定必须是有界的 m-<24位十六进制> id 数组。'); }
      if (!isNonEmptyString(provenance.statement) || provenance.statement.length > 500) issue(issues, '知识卡分析来源说明缺失或超长。');
    }
  }
  checkGlobalBounds(card, issues);
  return { valid: issues.length === 0, issues };
}

// ---- Brief 与审核决定（ams_brief_review_v1）----

export function validateBrief(brief) {
  const issues = [];
  if (!isPlainObject(brief)) { issue(issues, 'Brief 不是对象，无法按 P19 Brief 契约校验。'); return { valid: false, issues }; }
  if (brief.schema_version !== BRIEF_SCHEMA_VERSION) issue(issues, 'schema_version 不是精确的 ams_content_brief_v1。');
  if (!isNonEmptyString(brief.id) || !BRIEF_ID_PATTERN.test(brief.id)) issue(issues, 'Brief id 不是稳定的有界 brief-<24位十六进制> 格式。');
  if (!isNonEmptyString(brief.project_id) || !PROJECT_ID_PATTERN.test(brief.project_id)) issue(issues, 'Brief 缺少有效的项目绑定。');
  if (!Number.isInteger(brief.version) || brief.version < 1) issue(issues, 'Brief 版本必须是正整数。');
  if (!BRIEF_STATUSES.includes(brief.status)) issue(issues, 'Brief 状态必须是 pending_review / approved / returned。');
  if (!isNonEmptyString(brief.topic) || brief.topic.length > MAX_STRING_LENGTH) issue(issues, 'Brief 主题缺失或超长。');
  if (!isNonEmptyString(brief.objective) || brief.objective.length > MAX_STRING_LENGTH) issue(issues, 'Brief 目标缺失或超长。');
  if (!Array.isArray(brief.knowledge_citation_ids) || brief.knowledge_citation_ids.length < 1 || brief.knowledge_citation_ids.length > MAX_ARRAY_LENGTH) { issue(issues, 'Brief 引用知识卡列表必须包含 1..100 项。'); }
  if (!Array.isArray(brief.structural_guidance) || !brief.structural_guidance.every((item) => typeof item === 'string')) issue(issues, '结构建议必须是字符串数组。');
  if (!Array.isArray(brief.constraints) || !brief.constraints.every((item) => typeof item === 'string')) issue(issues, '约束必须是字符串数组。');
  if (!isPlainObject(brief.evidence_provenance)) issue(issues, '证据溯源 evidence_provenance 必须是对象。');
  const review = brief.review;
  if (!isPlainObject(review)) { issue(issues, 'Brief 缺少 review 对象。'); }
  else {
    if (review.schema_version !== BRIEF_REVIEW_SCHEMA_VERSION) issue(issues, '审核 schema_version 不是精确的 ams_brief_review_v1。');
    if (!isNonEmptyString(review.brief_id)) issue(issues, '审核缺少 brief_id 绑定。');
    if (!Array.isArray(review.comments) || !review.comments.every((item) => typeof item === 'string' && item.length <= 1000)) { issue(issues, '审核评论必须是字符串数组且每条不超过 1000 字符。'); }
    if (review.decision !== null && review.decision !== undefined) {
      const verdict = validateBriefReview(review);
      if (!verdict.valid) issues.push(...verdict.issues);
      if (verdict.valid) { const value = review.decision.value; const expected = value === 'approved' ? 'approved' : 'returned'; if (brief.status !== expected) issue(issues, `Brief 状态与审核决定不一致（应为 ${expected}）。`); }
    }
  }
  if (brief.analysis_provenance !== undefined && brief.analysis_provenance !== null) {
    const provenance = brief.analysis_provenance;
    if (!isPlainObject(provenance)) { issue(issues, 'Brief 分析来源 identity 必须是对象或 null。'); }
    else {
      const provenanceUnknown = Object.keys(provenance).filter((key) => !['method', 'provider', 'model', 'executed_at', 'analysis_ids', 'media_count', 'statement'].includes(key));
      if (provenanceUnknown.length) issue(issues, 'Brief 分析来源 identity 包含未知字段。');
      if (provenance.method !== MULTIMODAL_METHOD) issue(issues, 'Brief 分析来源 method 不是精确的 multimodal_model。');
      if (provenance.provider !== MULTIMODAL_PROVIDER) issue(issues, 'Brief 分析来源 provider 不是精确的 dashscope。');
      if (!isNonEmptyString(provenance.model) || provenance.model.length > 80) issue(issues, 'Brief 分析来源模型标识缺失或超长。');
      if (!isNonEmptyString(provenance.executed_at) || provenance.executed_at.length > 80) issue(issues, 'Brief 分析来源执行时间缺失或超长。');
      if (!Array.isArray(provenance.analysis_ids) || provenance.analysis_ids.length < 1 || provenance.analysis_ids.length > MAX_ARRAY_LENGTH || !provenance.analysis_ids.every((id) => isNonEmptyString(id) && id.length <= 200)) { issue(issues, 'Brief 分析来源 analysis 绑定必须是有界的非空 id 数组。'); }
      if (!Number.isInteger(provenance.media_count) || provenance.media_count < 0 || provenance.media_count > P29_MAX_MEDIA * MAX_ARRAY_LENGTH) { issue(issues, 'Brief 分析来源媒体计数必须是 0..800 的整数。'); }
      if (!isNonEmptyString(provenance.statement) || provenance.statement.length > 500) issue(issues, 'Brief 分析来源说明缺失或超长。');
    }
  }
  if (brief.multimodal_findings !== undefined && brief.multimodal_findings !== null) {
    const findings = brief.multimodal_findings;
    if (!Array.isArray(findings) || findings.length > 10 || !findings.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 240)) { issue(issues, 'Brief 多模态发现必须是最多 10 条非空且每条不超过 240 字符的数组。'); }
  }
  checkGlobalBounds(brief, issues);
  return { valid: issues.length === 0, issues };
}

export function validateBriefReview(review) {
  const issues = [];
  if (!isPlainObject(review)) { issue(issues, '审核记录不是对象，无法按 ams_brief_review_v1 校验。'); return { valid: false, issues }; }
  if (review.schema_version !== BRIEF_REVIEW_SCHEMA_VERSION) issue(issues, '审核 schema_version 不是精确的 ams_brief_review_v1。');
  if (!isNonEmptyString(review.brief_id)) issue(issues, '审核缺少 brief_id 绑定。');
  const decision = review.decision;
  if (decision === null || decision === undefined) { issue(issues, '审核缺少 decision 决定对象。'); }
  else {
    if (!isPlainObject(decision)) { issue(issues, '审核决定不是对象。'); }
    else {
      if (!BRIEF_DECISIONS.includes(decision.value)) issue(issues, '审核决定 value 必须是 approved 或 return_for_revision。');
      if (decision.source !== 'local_manual') issue(issues, '审核决定 source 不是精确的 local_manual。');
      if (!isNonEmptyString(decision.rationale) || decision.rationale.length > 500) issue(issues, '审核理由必须为非空且不超过 500 字符。');
      if (!isNonEmptyString(decision.decided_by) || decision.decided_by.length > MAX_IDENTIFIER_LENGTH) issue(issues, '决定人缺失或超长。');
      if (!isNonEmptyString(decision.decided_at) || decision.decided_at.length > MAX_IDENTIFIER_LENGTH) issue(issues, '决定时间缺失或超长。');
    }
  }
  if (!Array.isArray(review.comments) || !review.comments.every((item) => typeof item === 'string' && item.length <= 1000)) { issue(issues, '审核评论必须是字符串数组且每条不超过 1000 字符。'); }
  checkGlobalBounds(review, issues);
  return { valid: issues.length === 0, issues };
}

// ---- 交接包（复刻已验收 ams_external_handoff_package_v1 校验器纯部分）----

export function validateHandoffPackageRecord(record) {
  const issues = [];
  if (!isPlainObject(record)) { issue(issues, '记录不是对象，无法按 P5 交接包边界校验。'); return { valid: false, issues }; }
  if (record.schema_version !== HANDOFF_SCHEMA_VERSION) issue(issues, 'schema_version 不是精确的 ams_external_handoff_package_v1。');
  if (record.version !== 1) issue(issues, 'version 不是精确的 1。');
  if (record.kind !== HANDOFF_KIND) issue(issues, 'kind 不是精确的 external_generation_handoff_package。');
  if (record.status !== HANDOFF_STATUS) issue(issues, 'status 不是精确的 ready_for_external_import。');
  if (record.payload_label !== HANDOFF_PAYLOAD_LABEL) issue(issues, 'payload_label 不是精确的 local_external_generation_handoff_package。');
  if (record.is_external_task !== false) issue(issues, 'is_external_task 不是严格布尔 false。');
  if (record.submission_pending !== true) issue(issues, 'submission_pending 不是严格布尔 true。');
  if (record.local_only !== true) issue(issues, 'local_only 不是严格布尔 true。');
  if (record.repo_external !== true) issue(issues, 'repo_external 不是严格布尔 true。');
  if (!isNonEmptyString(record.id)) { issue(issues, '缺少稳定的交接包 id。'); }
  else if (!PACKAGE_ID_PATTERN.test(record.id)) { issue(issues, '交接包 id 不是稳定的有界 handoff-pkg-<24位十六进制> 格式。'); }
  const brief = record.brief_provenance;
  if (!isPlainObject(brief)) { issue(issues, '缺少简报来源 brief_provenance 对象。'); }
  else {
    if (!isNonEmptyString(brief.brief_id) || brief.brief_id.length > MAX_IDENTIFIER_LENGTH) issue(issues, '简报来源 brief_provenance.brief_id 缺失或超长。');
    if (!Number.isInteger(brief.brief_version) || brief.brief_version < 1) issue(issues, '简报版本绑定必须是正整数。');
    if (!isNonEmptyString(brief.brief_schema_version) || brief.brief_schema_version.length > MAX_IDENTIFIER_LENGTH) issue(issues, '简报 schema 绑定缺失或超长。');
    if (!isNonEmptyString(brief.brief_status) || brief.brief_status.length > MAX_IDENTIFIER_LENGTH) issue(issues, '简报状态绑定缺失或超长。');
  }
  const decision = record.human_decision;
  if (!isPlainObject(decision)) { issue(issues, '缺少人工决定 human_decision 对象。'); }
  else {
    if (decision.value !== 'approved') issue(issues, '人工决定 value 不是精确的 approved。');
    if (decision.source !== 'local_manual') issue(issues, '人工决定来源 source 不是精确的 local_manual。');
    if (!isNonEmptyString(decision.rationale)) issue(issues, '缺少批准理由 human_decision.rationale。');
    if (!isNonEmptyString(decision.decided_by) || decision.decided_by.length > MAX_IDENTIFIER_LENGTH) issue(issues, '决定人缺失或超长。');
    if (!isNonEmptyString(decision.decided_at) || decision.decided_at.length > MAX_IDENTIFIER_LENGTH) issue(issues, '决定时间缺失或超长。');
  }
  if (!isNonEmptyString(record.topic)) issue(issues, '缺少主题 topic。');
  if (!isNonEmptyString(record.objective)) issue(issues, '缺少目标 objective。');
  const citations = record.knowledge_citations;
  if (!Array.isArray(citations)) { issue(issues, '缺少知识引用列表 knowledge_citations。'); }
  else if (citations.length === 0) { issue(issues, '知识引用列表 knowledge_citations 为空。'); }
  else {
    citations.forEach((item, index) => {
      const at = `知识引用 #${index + 1}`;
      if (!isPlainObject(item)) { issue(issues, `${at} 不是对象。`); return; }
      if (!isNonEmptyString(item.knowledge_id) || item.knowledge_id.length > MAX_IDENTIFIER_LENGTH) issue(issues, `${at} 缺少或超长 knowledge_id。`);
      if (!isNonEmptyString(item.type)) issue(issues, `${at} 缺少 type。`);
      if (!isNonEmptyString(item.title)) issue(issues, `${at} 缺少 title。`);
      if (typeof item.excerpt !== 'string') issue(issues, `${at} 的 excerpt 必须是字符串。`);
      if (!Array.isArray(item.evidence_refs) || item.evidence_refs.length > MAX_ARRAY_LENGTH || !item.evidence_refs.every((ref) => isNonEmptyString(ref) && ref.length <= MAX_IDENTIFIER_LENGTH)) { issue(issues, `${at} 的证据列表必须是有界非空字符串数组。`); }
      if (item.evidence_completeness !== null && !isPlainObject(item.evidence_completeness)) issue(issues, `${at} 的证据完整度必须是对象或 null。`);
      if (!isNonEmptyString(item.trust_status)) issue(issues, `${at} 缺少 trust_status。`);
      if (typeof item.validation_status !== 'string') issue(issues, `${at} 的 validation_status 必须是字符串。`);
    });
  }
  const evidence = record.evidence_provenance;
  if (!isPlainObject(evidence)) { issue(issues, '缺少证据来源 evidence_provenance。'); }
  else {
    if (typeof evidence.local_only !== 'boolean') issue(issues, '证据来源 local_only 必须是严格布尔值。');
    if (!isNonEmptyString(evidence.store) || evidence.store.length > MAX_IDENTIFIER_LENGTH) issue(issues, '证据来源存储标识缺失或超长。');
    if (!isNonEmptyString(evidence.created_from) || evidence.created_from.length > MAX_IDENTIFIER_LENGTH) issue(issues, '证据来源创建来源缺失或超长。');
    if (typeof evidence.knowledge_count !== 'number' || evidence.knowledge_count < 0) issue(issues, '证据来源 knowledge_count 必须是 >=0 的数字。');
    if (typeof evidence.statement !== 'string') issue(issues, '证据来源 statement 必须是字符串。');
  }
  const guidance = record.structural_guidance;
  if (!isPlainObject(guidance)) { issue(issues, '缺少结构指导 structural_guidance。'); }
  else { for (const key of ['reusable_patterns', 'must_preserve', 'variation_space']) { if (!Array.isArray(guidance[key]) || !guidance[key].every((entry) => typeof entry === 'string')) issue(issues, `结构指导 ${key} 必须是字符串数组。`); } }
  const constraints = record.constraints;
  if (!isPlainObject(constraints)) { issue(issues, '缺少约束 constraints。'); }
  else { if (!Array.isArray(constraints.must_not_invent) || !constraints.must_not_invent.every((entry) => typeof entry === 'string')) issue(issues, '约束 must_not_invent 必须是字符串数组。'); if (!isNonEmptyString(constraints.evidence_boundary)) issue(issues, '缺少约束证据边界 constraints.evidence_boundary。'); }
  const boundary = record.external_project_boundary;
  if (!isPlainObject(boundary)) { issue(issues, '缺少外部项目边界 external_project_boundary。'); }
  else { if (!isNonEmptyString(boundary.destination)) issue(issues, '外部项目边界 destination 不能为空。'); if (!isNonEmptyString(boundary.statement)) issue(issues, '外部项目边界 statement 不能为空。'); }
  const importOnly = record.import_only;
  if (!isPlainObject(importOnly)) { issue(issues, '缺少人工导入标记 import_only。'); }
  else if (importOnly.manual_import_required !== true) { issue(issues, 'import_only.manual_import_required 不是严格布尔 true。'); }
  if (record.manual_feedback !== null && !isPlainObject(record.manual_feedback)) issue(issues, '人工反馈 manual_feedback 必须是对象或 null。');
  const flags = record.execution_flags; const flagVerdict = validateExecutionFlags(flags); if (!flagVerdict.valid) issues.push(...flagVerdict.issues);
  const trace = record.source_trace;
  if (!isPlainObject(trace)) { issue(issues, '缺少来源轨迹 source_trace。'); }
  else { if (trace.origin !== 'local_bridge') issue(issues, '来源轨迹 origin 不是精确的 local_bridge。'); if (trace.created_from !== 'approved_content_brief') issue(issues, '来源轨迹 created_from 不是精确的 approved_content_brief。'); }
  checkGlobalBounds(record, issues);
  return { valid: issues.length === 0, issues };
}

// ---- 导入包（单项目 JSON 包，本地备份）----

export function validateProjectPackage(pkg) {
  const issues = [];
  if (!isPlainObject(pkg)) { issue(issues, '导入包不是对象，无法按 P19 项目包契约校验。'); return { valid: false, issues }; }
  if (pkg.schema_version !== PROJECT_PACKAGE_SCHEMA_VERSION) issue(issues, '导入包 schema_version 不是精确的 p19_project_package_v1。');
  if (typeof pkg.exported_at !== 'string' || pkg.exported_at.length > 80) issue(issues, '导出时间缺失或超长。');
  if (typeof pkg.fingerprint !== 'string' || !SHA256_PATTERN.test(pkg.fingerprint)) issue(issues, '导入包指纹必须是 64 位十六进制。');
  const project = pkg.project; const projectVerdict = validateProject(project); if (!projectVerdict.valid) issues.push(...projectVerdict.issues);
  const evidence = pkg.evidence;
  if (!Array.isArray(evidence) || evidence.length > MAX_ARRAY_LENGTH) { issue(issues, '导入包证据列表必须是有界数组。'); }
  else { for (const record of evidence) { const verdict = validateEvidenceRecord(record); if (!verdict.valid) issues.push(...verdict.issues); } }
  const analyses = pkg.analyses;
  if (!Array.isArray(analyses) || analyses.length > MAX_ARRAY_LENGTH) { issue(issues, '导入包分析列表必须是有界数组。'); }
  else { for (const record of analyses) { const verdict = validateAnalysis(record); if (!verdict.valid) issues.push(...verdict.issues); } }
  const cards = pkg.knowledge_cards;
  if (!Array.isArray(cards) || cards.length > MAX_ARRAY_LENGTH) { issue(issues, '导入包知识卡列表必须是有界数组。'); }
  else { for (const record of cards) { const verdict = validateKnowledgeCard(record); if (!verdict.valid) issues.push(...verdict.issues); } }
  const brief = pkg.brief; if (brief !== null && !validateBrief(brief).valid) issues.push(...validateBrief(brief).issues);
  const handoff = pkg.handoff; if (handoff !== null && !validateHandoffPackageRecord(handoff).valid) issues.push(...validateHandoffPackageRecord(handoff).issues);
  checkGlobalBounds(pkg, issues);
  return { valid: issues.length === 0, issues };
}
