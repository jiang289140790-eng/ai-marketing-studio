// P19 本地后端命令契约核心（纯 ESM，浏览器/node:test/Deno 均可导入；未部署）。
//
// 这是未来授权 staging 写入边界的可本地测试契约，不是可执行部署：
// - 用户身份只来自已验证 JWT 的 subject（deriveUserIdFromClaims），
//   绝不来自请求输入或 user_metadata；
// - 要求已验收的 staging 访问角色（viewer/reviewer/operator/admin）；
// - 只接受显式版本化命令清单（COMMAND_ALLOWLIST），未知命令/未知字段一律 fail closed；
// - 完整校验 payload schema、修订版本、哈希、执行标志、源绑定、所有权与幂等键；
// - 返回有界结构化诊断（固定文案，<=512 字符，绝不回显无界原始值）；
// - 不执行任何模型/网络/提供商/路由/发布行为。
//
// 幂等与哈希在事务性数据库边界内原子完成（api.p19_apply_entity_write /
// api.p19_remove_evidence）：边界先做规范化 JSONB 哈希校验，再原子预留
// (user_id, idempotency_key)，最后执行受修订保护的写入——同一键的并发请求
// 恰好一次 applied、其余全部 replay。本核心通过注入的 db 接口镜像该契约：
//   getProject(userId, projectId) -> payload|null
//   listProjectEntities(userId, projectId) -> {evidence, analyses, cards, brief, handoff}
//   writeEntity(userId, meta) -> {outcome:'applied', entity}
//                              | {outcome:'replayed', ledger}
//     meta: {command, idempotency_key, entity_type, entity_id, request_summary,
//            table, payload, declared_sha, expected_base_version}
//   removeEvidence(userId, meta) -> 同上
// 边界错误以 {code, message} 属性抛错（PAYLOAD_HASH_MISMATCH /
// PROJECT_REVISION_STALE / PROJECT_ARCHIVED / EVIDENCE_NOT_FOUND），
// 本核心映射为有界结果。
//
// 归档只读门禁（命令核心与事务性 SQL 双重强制，任何一层都不能被绕过）：
// 项目最新修订为 archived 后，全部变更命令（project.update、evidence
// create/update/remove、analysis/card/Brief/handoff 变更）一律返回有界
// PROJECT_ARCHIVED；project.archive 只允许归档 active 项目且对已归档项目
// 幂等（有界无操作，绝不写新修订）；只读命令 lineage.audit 仍可读归档项目。

import {
  ANALYSIS_SCHEMA_VERSION,
  BRIEF_DECISIONS,
  BRIEF_REVIEW_SCHEMA_VERSION,
  BRIEF_SCHEMA_VERSION,
  BRIEF_STATUSES,
  EVIDENCE_SCHEMA_VERSION,
  EXECUTION_FLAG_KEYS,
  HANDOFF_DECISION_METHOD,
  KNOWLEDGE_CARD_SCHEMA_VERSION,
  MAX_DIAGNOSTIC_LENGTH,
  PROJECT_ID_PATTERN,
  PROJECT_PACKAGE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  clonePlain,
  fingerprintOf,
  isNonEmptyString,
  isPlainObject,
  issue,
  validateAnalysis,
  validateBrief,
  validateEvidenceRecord,
  validateHandoffPackageRecord,
  validateKnowledgeCard,
  validateProjectPackage,
} from '../../../src/services/p19-contracts.js';

export const COMMAND_SCHEMA_VERSION = 'p19_command_contract_v1';

/** 显式版本化命令清单（allowlist）；角色为所需的最低 staging 访问角色。 */
export const COMMAND_ALLOWLIST = Object.freeze({
  'project.list': { role: 'viewer', label: 'List research projects' },
  'project.read': { role: 'viewer', label: 'Read research project' },
  'project.import': { role: 'operator', label: 'Import validated local project package' },
  'project.create': { role: 'operator', label: '创建研究项目' },
  'project.update': { role: 'operator', label: '更新项目档案' },
  'project.archive': { role: 'operator', label: '归档项目' },
  'evidence.create': { role: 'operator', label: '创建证据记录' },
  'evidence.update': { role: 'operator', label: '更新证据记录' },
  'evidence.remove': { role: 'operator', label: '移除证据记录' },
  'analysis.create': { role: 'operator', label: '登记确定性本地分析' },
  'card.create': { role: 'operator', label: '登记知识卡' },
  'brief.assemble': { role: 'operator', label: '组装可审核 Brief' },
  'brief.decide': { role: 'reviewer', label: '记录人工审核决定' },
  'handoff.create': { role: 'operator', label: '派生 P5 交接包' },
  'lineage.audit': { role: 'viewer', label: '世系审计（只读命令）' },
});

/** 角色阶梯（与已验收 is_staging_user 映射一致）。 */
export const ROLE_RANK = Object.freeze({ viewer: 0, reviewer: 1, operator: 2, admin: 3 });

/** 每命令允许的顶层字段（未知字段 fail closed）。 */
const COMMAND_FIELDS = Object.freeze({
  'project.list': [],
  'project.read': ['project_id'],
  'project.import': ['package'],
  'project.create': ['project'],
  'project.update': ['project_id', 'patch'],
  'project.archive': ['project_id'],
  'evidence.create': ['project_id', 'evidence'],
  'evidence.update': ['project_id', 'evidence_id', 'expected_fingerprint', 'patch'],
  'evidence.remove': ['project_id', 'evidence_id', 'expected_fingerprint'],
  'analysis.create': ['project_id', 'expected_fingerprint', 'analysis'],
  'card.create': ['project_id', 'expected_fingerprint', 'card'],
  'brief.assemble': ['project_id', 'expected_fingerprint', 'brief'],
  'brief.decide': ['project_id', 'expected_fingerprint', 'decision'],
  'handoff.create': ['project_id', 'expected_fingerprint', 'handoff'],
  'lineage.audit': ['project_id'],
});

const PROJECT_PATCH_FIELDS = ['topic', 'objective', 'audience', 'channel', 'constraints'];
const EVIDENCE_PATCH_FIELDS = ['source_url', 'label', 'platform', 'content_text', 'media_metadata'];

/** 证据表 required 列 recorded_at 的 ISO-8601 模式（与边界 timestamptz 转换一致）。 */
const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function fail(code, message, extra = {}) {
  return { ok: false, code, message, diagnostics: { issues: [message] }, ...extra };
}

function boundedDiagnostics(issues) {
  return { issues: issues.slice(0, 8).map((text) => (text.length > MAX_DIAGNOSTIC_LENGTH ? `${text.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : text)) };
}

/** 用户身份只来自已验证 JWT 的 subject；user_metadata / 请求输入一律忽略。 */
export function deriveUserIdFromClaims(claims) {
  const sub = claims && typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!sub || sub.length > 200) {
    const error = new Error('JWT 缺少有效的 subject，无法确定 user_id。');
    error.code = 'INVALID_SUBJECT';
    throw error;
  }
  return sub;
}

export function hasRequiredRole(accessRole, requiredRole) {
  return ROLE_RANK[accessRole] !== undefined && ROLE_RANK[accessRole] >= ROLE_RANK[requiredRole];
}

/** 解析并校验命令请求信封：版本、命令、幂等键、未知字段。 */
export function parseCommandRequest(input) {
  if (!isPlainObject(input)) return fail('INVALID_REQUEST', '请求不是 JSON 对象。');
  if (input.schema_version !== COMMAND_SCHEMA_VERSION) return fail('SCHEMA_VERSION_MISMATCH', '请求 schema_version 不是精确的 p19_command_contract_v1。');
  const command = input.command;
  if (typeof command !== 'string' || !Object.hasOwn(COMMAND_ALLOWLIST, command)) {
    return fail('UNKNOWN_COMMAND', `命令不在允许清单内，已 fail closed（${String(command || '').slice(0, 40)}）。`);
  }
  const idempotencyKey = input.idempotency_key;
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) {
    return fail('IDEMPOTENCY_KEY_INVALID', '幂等键缺失或超长。');
  }
  const payload = isPlainObject(input.payload) ? input.payload : {};
  const allowed = COMMAND_FIELDS[command];
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    return fail('UNKNOWN_FIELDS', `请求包含未知字段（${unknown.length} 个），已 fail closed。`, { command, idempotency_key: idempotencyKey });
  }
  return {
    ok: true,
    command,
    idempotency_key: idempotencyKey,
    payload: clonePlain(payload),
    payload_sha256: typeof input.payload_sha256 === 'string' && /^[0-9a-f]{64}$/.test(input.payload_sha256) ? input.payload_sha256 : null,
  };
}

/**
 * 执行一条已解析命令。校验顺序固定：角色 → payload schema →
 * 所有权/绑定 → 哈希/修订/标志 → 边界写入（边界内原子完成
 * 规范化哈希校验 + 幂等预留 + 受修订保护的变更）。
 * 返回有界结构化诊断；任何失败都不写入。
 */
export async function executeCommand({ command, idempotency_key: idempotencyKey, payload, payload_sha256: payloadSha256, user_id: userId, access_role: accessRole }, { db, hasher = fingerprintOf } = {}) {
  if (!db) throw new Error('executeCommand 需要注入 db。');
  const definition = COMMAND_ALLOWLIST[command];
  if (!definition) return fail('UNKNOWN_COMMAND', '命令不在允许清单内，已 fail closed。');
  if (!hasRequiredRole(accessRole, definition.role)) {
    return fail('ROLE_DENIED', `当前 staging 角色无权执行 ${definition.label}（需要 ${definition.role}）。`, { command, idempotency_key: idempotencyKey });
  }

  const applied = await applyCommand(command, payload, payloadSha256, userId, idempotencyKey, { db, hasher });
  if (!applied.ok) return applied;
  if (applied.replayed) {
    // 幂等重放：边界原子预留失败，返回已记录结果，绝不重复写入。
    return {
      ok: true,
      command,
      idempotency_key: idempotencyKey,
      applied: false,
      replay_of: applied.replay_of,
      entity: applied.entity,
      diagnostics: applied.diagnostics,
    };
  }
  if (applied.read_only) {
    return {
      ok: true,
      command,
      idempotency_key: idempotencyKey,
      applied: false,
      read_only: true,
      data: clonePlain(applied.data),
      diagnostics: applied.diagnostics || { issues: [] },
    };
  }
  if (applied.already_archived) {
    // 归档幂等：已归档项目再次归档为有界无操作，绝不写新修订。
    return {
      ok: true,
      command,
      idempotency_key: idempotencyKey,
      applied: false,
      already_archived: true,
      entity: applied.entity,
      diagnostics: applied.diagnostics,
    };
  }
  return {
    ok: true,
    command,
    idempotency_key: idempotencyKey,
    applied: true,
    entity: applied.entity,
    applied_at: applied.applied_at,
    diagnostics: applied.diagnostics,
  };
}

/** 边界写入的错误映射（边界抛 {code, message}；未知错误继续抛出）。 */
async function boundaryWrite(ctx, { table, entityType, entityId, payload, expectedBaseVersion = null, expectedEntityFingerprint = null, declaredSha = null }) {
  try {
    return await ctx.db.writeEntity(ctx.userId, {
      command: ctx.command,
      idempotency_key: ctx.idempotencyKey,
      entity_type: entityType,
      entity_id: entityId,
      request_summary: { command: ctx.command, request_payload: clonePlain(ctx.payload), payload_sha256: ctx.payloadSha256 || null },
      table,
      payload: clonePlain(payload),
      declared_sha: declaredSha,
      expected_base_version: expectedBaseVersion,
      expected_entity_fingerprint: expectedEntityFingerprint,
    });
  } catch (error) {
    const code = String((error && error.code) || '');
    if (code === 'PAYLOAD_HASH_MISMATCH') {
      return fail('PAYLOAD_HASH_MISMATCH', 'payload_sha256 与规范化内容不一致，已拒绝。');
    }
    if (code === 'PROJECT_REVISION_STALE') {
      return fail('PROJECT_REVISION_STALE', '项目最新修订已变化（并发写入），拒绝从旧修订分支。');
    }
    if (code === 'ENTITY_REVISION_STALE') {
      return fail('ENTITY_REVISION_STALE', '实体快照已变化（并发写入），拒绝覆盖较新的记录。');
    }
    if (code === 'EVIDENCE_NOT_FOUND') {
      return fail('EVIDENCE_NOT_FOUND', '证据不存在或不属于当前项目。');
    }
    if (code === 'PROJECT_ARCHIVED') {
      return fail('PROJECT_ARCHIVED', '项目已归档（只读）：变更命令已拒绝；归档快照不会被修改。');
    }
    if (code === 'IDEMPOTENCY_CONFLICT') {
      return fail('IDEMPOTENCY_CONFLICT', '幂等键已绑定到另一请求身份，已拒绝复用。');
    }
    if (code === 'PROJECT_ID_INVALID') {
      return fail('PROJECT_ID_INVALID', '项目绑定格式无效，已拒绝。');
    }
    throw error;
  }
}

function requireExpectedFingerprint(payload, current, entityType, entityId) {
  const expected = payload.expected_fingerprint ?? null;
  if (expected !== null && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) {
    return fail('ENTITY_REVISION_INVALID', 'expected_fingerprint 必须是精确的 64 位小写 SHA-256。', { entity: { type: entityType, id: entityId } });
  }
  void current;
  return { ok: true, value: expected };
}

/** 边界结果 → 命令结果（applied / replayed 统一出口；边界失败原样透传）。 */
function writeResult(write, type, id, extraDiagnostics = { issues: [] }) {
  if (!write || write.ok === false) return write;
  if (write.already_archived === true) {
    return {
      ok: true,
      already_archived: true,
      entity: write.entity || { type, id },
      diagnostics: { issues: ['项目已是归档状态（并发归档未写入新修订）。'] },
    };
  }
  if (write.outcome === 'replayed') {
    const ledger = write.ledger && typeof write.ledger === 'object' ? write.ledger : {};
    return {
      ok: true,
      replayed: true,
      replay_of: {
        status: ledger.status || 'applied',
        command: ledger.command || null,
        entity_type: ledger.entity_type || type,
        entity_id: ledger.entity_id || id,
        diagnostics: ledger.diagnostics || { issues: [] },
      },
      entity: { type: ledger.entity_type || type, id: ledger.entity_id || id },
      diagnostics: ledger.diagnostics || { issues: [] },
    };
  }
  return okResult(type, id, extraDiagnostics);
}

async function applyCommand(command, payload, payloadSha256, userId, idempotencyKey, { db, hasher }) {
  const ctx = { command, idempotencyKey, payloadSha256, userId, db, hasher, payload };
  switch (command) {
    case 'project.list': return applyProjectList(ctx);
    case 'project.read': return applyProjectRead(ctx);
    case 'project.import': return applyProjectImport(ctx);
    case 'project.create': return applyProjectCreate(ctx);
    case 'project.update': return applyProjectUpdate(ctx);
    case 'project.archive': return applyProjectArchive(ctx);
    case 'evidence.create': return applyEvidenceCreate(ctx);
    case 'evidence.update': return applyEvidenceUpdate(ctx);
    case 'evidence.remove': return applyEvidenceRemove(ctx);
    case 'analysis.create': return applyAnalysisCreate(ctx);
    case 'card.create': return applyCardCreate(ctx);
    case 'brief.assemble': return applyBriefAssemble(ctx);
    case 'brief.decide': return applyBriefDecide(ctx);
    case 'handoff.create': return applyHandoffCreate(ctx);
    case 'lineage.audit': return applyLineageAudit(ctx);
    default: return fail('UNKNOWN_COMMAND', '命令不在允许清单内，已 fail closed。');
  }
}

async function applyProjectList(ctx) {
  const projects = await ctx.db.listProjects(ctx.userId);
  if (!Array.isArray(projects)) return fail('PROJECT_LIST_INVALID', 'Project list boundary returned an invalid payload.');
  return {
    ok: true,
    read_only: true,
    data: { projects: clonePlain(projects) },
    diagnostics: { issues: [] },
  };
}

async function applyProjectRead(ctx) {
  const owned = await requireOwnedProject(ctx.payload, ctx.userId, ctx.db, { forMutation: false });
  if (!owned.ok) return owned;
  const entities = await ctx.db.listProjectEntities(ctx.userId, owned.projectId);
  const handoff = entities.handoff || null;
  const project = {
    ...clonePlain(owned.project),
    evidence: clonePlain(entities.evidence || []),
    analyses: clonePlain(entities.analyses || []),
    knowledge_cards: clonePlain(entities.cards || []),
    brief: entities.brief ? clonePlain(entities.brief) : null,
    handoff: handoff ? clonePlain(handoff) : null,
    handoffs: handoff ? [clonePlain(handoff)] : [],
    lineage: null,
    fingerprint: '',
  };
  project.fingerprint = await ctx.hasher(project);
  return {
    ok: true,
    read_only: true,
    data: { project },
    diagnostics: { issues: [] },
  };
}

async function applyProjectImport(ctx) {
  const pkg = ctx.payload.package;
  if (!isPlainObject(pkg) || pkg.schema_version !== PROJECT_PACKAGE_SCHEMA_VERSION) {
    return fail('IMPORT_PACKAGE_INVALID', '导入包版本或结构无效，已拒绝。');
  }
  const verdict = validateProjectPackage(pkg);
  if (!verdict.valid) {
    return fail('IMPORT_PACKAGE_INVALID', '导入包未通过完整 P19 合同校验。', { diagnostics: boundedDiagnostics(verdict.issues || []) });
  }
  if (JSON.stringify(pkg).length > 2 * 1024 * 1024) {
    return fail('IMPORT_PACKAGE_TOO_LARGE', '导入包超过 2 MiB 上限，已拒绝。');
  }
  const actualFingerprint = await ctx.hasher({
    schema_version: pkg.schema_version,
    exported_at: pkg.exported_at,
    project: pkg.project,
    evidence: pkg.evidence,
    analyses: pkg.analyses,
    knowledge_cards: pkg.knowledge_cards,
    brief: pkg.brief,
    handoff: pkg.handoff,
  });
  if (actualFingerprint !== pkg.fingerprint) {
    return fail('IMPORT_FINGERPRINT_MISMATCH', '导入包指纹与内容不一致，已拒绝。');
  }
  const binding = validateImportBindings(pkg);
  if (!binding.ok) {
    return fail('IMPORT_BINDING_FAILED', binding.message);
  }
  if (pkg.project.status !== 'active') {
    return fail('IMPORT_STATUS_UNSUPPORTED', '在线导入只接受 active 本地草稿；归档快照保持只读且不会被复活。');
  }
  try {
    const result = await ctx.db.importProject(ctx.userId, {
      idempotency_key: ctx.idempotencyKey,
      package: clonePlain(pkg),
    });
    if (result?.outcome === 'replayed') {
      return {
        ok: true,
        replayed: true,
        replay_of: result.ledger?.id || result.ledger?.idempotency_key || ctx.idempotencyKey,
        entity: { type: 'project', id: pkg.project.id },
        diagnostics: result?.diagnostics || { issues: [] },
      };
    }
    return {
      ok: true,
      entity: { type: 'project', id: pkg.project.id },
      applied_at: result?.applied_at || null,
      diagnostics: result?.diagnostics || { issues: [] },
    };
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (code === 'IMPORT_PROJECT_COLLISION' || code === 'IDEMPOTENCY_CONFLICT') {
      return fail(code, code === 'IMPORT_PROJECT_COLLISION'
        ? '在线工作区已存在相同 project_id，拒绝覆盖或合并。'
        : '导入幂等键已绑定到其他请求，已拒绝。', { entity: { type: 'project', id: pkg.project.id } });
    }
    throw error;
  }
}

function validateImportBindings(pkg) {
  const projectId = pkg.project.id;
  const evidenceIds = new Set();
  const analysisIds = new Set();
  const cardIds = new Set();
  for (const record of pkg.evidence) {
    if (record.project_id !== projectId || evidenceIds.has(record.id)) {
      return { ok: false, message: '导入包包含重复证据或跨项目证据绑定，已拒绝。' };
    }
    evidenceIds.add(record.id);
  }
  for (const record of pkg.analyses) {
    if (record.project_id !== projectId || analysisIds.has(record.id) || !evidenceIds.has(record.evidence_id)) {
      return { ok: false, message: '导入包包含重复分析、跨项目分析或缺失证据绑定，已拒绝。' };
    }
    analysisIds.add(record.id);
  }
  for (const record of pkg.knowledge_cards) {
    if (record.project_id !== projectId || cardIds.has(record.id) || !analysisIds.has(record.analysis_id)) {
      return { ok: false, message: '导入包包含重复知识卡、跨项目知识卡或缺失分析绑定，已拒绝。' };
    }
    cardIds.add(record.id);
  }
  if (pkg.brief && (pkg.brief.project_id !== projectId
    || (pkg.brief.knowledge_citation_ids || []).some((id) => !cardIds.has(id)))) {
    return { ok: false, message: '导入包 Brief 的项目或知识卡绑定无效，已拒绝。' };
  }
  if (pkg.handoff) {
    const provenance = pkg.handoff.brief_provenance;
    if (pkg.handoff.project_id !== projectId || !pkg.brief || !provenance
      || provenance.brief_id !== pkg.brief.id || provenance.brief_version !== pkg.brief.version) {
      return { ok: false, message: '导入包交接包与当前 Brief 绑定无效，已拒绝。' };
    }
  }
  return { ok: true };
}

function requireProjectId(payload) {
  const projectId = payload.project_id;
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    return fail('PROJECT_ID_INVALID', 'project_id 不是稳定的有界 prj-<24位十六进制> 格式。');
  }
  return { ok: true, projectId };
}

/**
 * 归档只读门禁（核心层）：项目最新修订为 archived 后，全部变更命令
 * （project.update、evidence create/update/remove、analysis/card/Brief/handoff
 * 变更）一律返回有界 PROJECT_ARCHIVED；project.archive 只允许归档 active
 * 项目且幂等；只读 lineage.audit 不受影响。
 */
async function requireOwnedProject(payload, userId, db, { forMutation = true } = {}) {
  const check = requireProjectId(payload);
  if (!check.ok) return check;
  const project = await db.getProject(userId, check.projectId);
  if (!project) return fail('PROJECT_NOT_FOUND', '项目不存在或不属于当前用户。', { entity: { type: 'project', id: check.projectId } });
  if (forMutation && project.status === 'archived') {
    return fail('PROJECT_ARCHIVED', '项目已归档（只读）：变更命令已拒绝；归档快照不会被修改。', { entity: { type: 'project', id: check.projectId } });
  }
  return { ok: true, projectId: check.projectId, project };
}

/** 请求声明的 payload_sha256（若有）必须与最终存储 payload 的规范化哈希一致。 */
async function requireHash(artifact, payloadSha256, hasher) {
  if (!payloadSha256) return { ok: true, actual: null };
  return hasher(artifact).then((actual) => {
    if (actual !== payloadSha256) {
      return fail('PAYLOAD_HASH_MISMATCH', 'payload_sha256 与规范化内容不一致，已拒绝。');
    }
    return { ok: true, actual };
  });
}

async function applyProjectCreate(ctx) {
  const { payload, hasher } = ctx;
  const raw = payload.project;
  if (!isPlainObject(raw)) return fail('PROJECT_INVALID', 'project 必须是对象。');
  for (const [field, max] of [['topic', 5000], ['objective', 5000], ['audience', 200], ['channel', 200]]) {
    if (typeof raw[field] !== 'string' || raw[field].trim().length === 0 || raw[field].length > max) {
      return fail('PROJECT_INVALID', `${field} 缺失或超过 ${max} 字符。`);
    }
  }
  const project = {
    schema_version: PROJECT_SCHEMA_VERSION,
    id: '',
    version: 1,
    status: 'active',
    topic: raw.topic.trim(),
    objective: raw.objective.trim(),
    audience: raw.audience.trim(),
    channel: raw.channel.trim(),
    constraints: Array.isArray(raw.constraints) ? raw.constraints.slice(0, 100).map((item) => String(item || '').trim().slice(0, 5000)) : [],
    execution_flags: EXECUTION_FLAG_KEYS.reduce((acc, key) => ({ ...acc, [key]: false }), {}),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { valid, issues } = validateProjectShape(project);
  if (!valid) return fail('PROJECT_INVALID', '项目记录未通过 P19 项目契约校验。', { diagnostics: boundedDiagnostics(issues) });
  project.id = `prj-${(await hasher({ user_id: ctx.userId, idempotency_key: ctx.idempotencyKey, project: raw })).slice(0, 24)}`;
  // 哈希必须覆盖最终存储的 payload（含派生 id）。
  const hashCheck = await requireHash(project, ctx.payloadSha256, hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_research_projects_v1',
    entityType: 'project',
    entityId: project.id,
    payload: project,
    expectedBaseVersion: null,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'project', project.id);
}

function validateProjectShape(project) {
  const issues = [];
  if (project.schema_version !== PROJECT_SCHEMA_VERSION) issue(issues, 'schema_version 不是精确的 p19_research_project_v1。');
  if (!isNonEmptyString(project.topic)) issue(issues, '项目主题缺失。');
  if (!isNonEmptyString(project.objective)) issue(issues, '项目目标缺失。');
  if (!isNonEmptyString(project.audience)) issue(issues, '目标受众缺失。');
  if (!isNonEmptyString(project.channel)) issue(issues, '目标渠道缺失。');
  if (!Array.isArray(project.constraints)) issue(issues, '约束必须是数组。');
  return { valid: issues.length === 0, issues };
}

/** 服务端创建证据时 id 尚未分配：先校验除 id 外的形状，分配后不再回退校验。 */
function validateEvidenceShape(record) {
  const withId = { ...record, id: 'ev-aaaaaaaaaaaaaaaaaaaaaaaa' };
  const verdict = validateEvidenceRecord(withId);
  return { valid: verdict.valid, issues: verdict.issues.filter((text) => !text.includes('证据 id')) };
}

async function applyProjectUpdate(ctx) {
  const { payload, db, hasher } = ctx;
  const owned = await requireOwnedProject(payload, ctx.userId, db);
  if (!owned.ok) return owned;
  const patch = isPlainObject(payload.patch) ? payload.patch : {};
  const unknown = Object.keys(patch).filter((key) => !PROJECT_PATCH_FIELDS.includes(key));
  if (unknown.length > 0) return fail('UNKNOWN_FIELDS', 'project.update patch 包含未知字段，已 fail closed。', { entity: { type: 'project', id: owned.projectId } });
  const project = clonePlain(owned.project);
  for (const [field, max] of [['topic', 5000], ['objective', 5000], ['audience', 200], ['channel', 200]]) {
    if (patch[field] !== undefined) {
      if (typeof patch[field] !== 'string' || patch[field].trim().length === 0 || patch[field].length > max) {
        return fail('PROJECT_INVALID', `${field} 缺失或超过 ${max} 字符。`, { entity: { type: 'project', id: owned.projectId } });
      }
      project[field] = patch[field].trim();
    }
  }
  if (Array.isArray(patch.constraints)) project.constraints = patch.constraints.slice(0, 100).map((item) => String(item || '').trim().slice(0, 5000));
  const { valid, issues } = validateProjectShape(project);
  if (!valid) return fail('PROJECT_INVALID', '更新后的项目未通过契约校验。', { entity: { type: 'project', id: owned.projectId }, diagnostics: boundedDiagnostics(issues) });
  const baseVersion = Number(owned.project.version) || 1;
  project.version = baseVersion + 1;
  project.updated_at = new Date().toISOString();
  const hashCheck = await requireHash(project, ctx.payloadSha256, hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_research_projects_v1',
    entityType: 'project',
    entityId: project.id,
    payload: project,
    expectedBaseVersion: baseVersion,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'project', project.id);
}

async function applyProjectArchive(ctx) {
  const owned = await requireOwnedProject(ctx.payload, ctx.userId, ctx.db, { forMutation: false });
  if (!owned.ok) return owned;
  const project = clonePlain(owned.project);
  if (project.status === 'archived') {
    // 幂等：已归档项目再次归档是有界无操作，绝不写新修订。
    return {
      ok: true,
      already_archived: true,
      command: ctx.command,
      idempotency_key: ctx.idempotencyKey,
      entity: { type: 'project', id: owned.projectId },
      diagnostics: { issues: ['项目已是归档状态（归档命令幂等，未写入新修订）。'] },
    };
  }
  if (project.status !== 'active') return fail('PROJECT_STATE_INVALID', '只有 active 项目可以归档。', { entity: { type: 'project', id: owned.projectId } });
  const baseVersion = Number(owned.project.version) || 1;
  project.status = 'archived';
  project.version = baseVersion + 1;
  project.updated_at = new Date().toISOString();
  const hashCheck = await requireHash(project, ctx.payloadSha256, ctx.hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_research_projects_v1',
    entityType: 'project',
    entityId: project.id,
    payload: project,
    expectedBaseVersion: baseVersion,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'project', project.id);
}

async function applyEvidenceCreate(ctx) {
  const { payload, db, hasher } = ctx;
  const owned = await requireOwnedProject(payload, ctx.userId, db);
  if (!owned.ok) return owned;
  const raw = payload.evidence;
  if (!isPlainObject(raw)) return fail('EVIDENCE_INVALID', 'evidence 必须是对象。');
  const recordedAt = String(raw.recorded_at || new Date().toISOString()).slice(0, 80);
  if (!ISO8601_PATTERN.test(recordedAt)) {
    return fail('EVIDENCE_INVALID', 'recorded_at 必须是 ISO-8601 时间字符串（边界 required 列）。', { entity: { type: 'project', id: owned.projectId } });
  }
  const record = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    id: '',
    project_id: owned.projectId,
    source_url: String(raw.source_url || '').trim().slice(0, 1000),
    label: String(raw.label || '').trim().slice(0, 200),
    platform: String(raw.platform || '').trim().slice(0, 80),
    content_text: String(raw.content_text || '').slice(0, 5000),
    recorded_at: recordedAt,
    provenance: isPlainObject(raw.provenance) ? clonePlain(raw.provenance) : { manual: true, statement: '服务端登记：来源由人工提交。' },
    media_metadata: isPlainObject(raw.media_metadata) ? clonePlain(raw.media_metadata) : null,
    version: 1,
    fingerprint: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { valid, issues } = validateEvidenceShape(record);
  if (!valid) return fail('EVIDENCE_INVALID', '证据记录未通过 P19 证据契约校验。', { entity: { type: 'project', id: owned.projectId }, diagnostics: boundedDiagnostics(issues) });
  record.id = `ev-${(await hasher(record)).slice(0, 24)}`;
  record.fingerprint = await hasher(record);
  const hashCheck = await requireHash(record, ctx.payloadSha256, hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_evidence_records_v1',
    entityType: 'evidence',
    entityId: record.id,
    payload: record,
    expectedBaseVersion: null,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'evidence', record.id);
}

async function applyEvidenceUpdate(ctx) {
  const { payload, db, hasher } = ctx;
  const owned = await requireOwnedProject(payload, ctx.userId, db);
  if (!owned.ok) return owned;
  const evidenceId = payload.evidence_id;
  if (typeof evidenceId !== 'string' || !/^ev-[0-9a-f]{24}$/.test(evidenceId)) return fail('EVIDENCE_ID_INVALID', 'evidence_id 格式无效。', { entity: { type: 'project', id: owned.projectId } });
  const entities = await db.listProjectEntities(ctx.userId, owned.projectId);
  const record = (entities.evidence || []).find((item) => item.id === evidenceId);
  if (!record) return fail('EVIDENCE_NOT_FOUND', '证据不存在或不属于当前项目。', { entity: { type: 'evidence', id: evidenceId } });
  const baseline = requireExpectedFingerprint(payload, record, 'evidence', evidenceId);
  if (!baseline.ok) return baseline;
  const patch = isPlainObject(payload.patch) ? payload.patch : {};
  const unknown = Object.keys(patch).filter((key) => !EVIDENCE_PATCH_FIELDS.includes(key));
  if (unknown.length > 0) return fail('UNKNOWN_FIELDS', 'evidence.update patch 包含未知字段，已 fail closed。', { entity: { type: 'evidence', id: evidenceId } });
  const next = clonePlain(record);
  if (patch.source_url !== undefined) next.source_url = String(patch.source_url).trim().slice(0, 1000);
  if (patch.label !== undefined) next.label = String(patch.label).trim().slice(0, 200);
  if (patch.platform !== undefined) next.platform = String(patch.platform).trim().slice(0, 80);
  if (patch.content_text !== undefined) next.content_text = String(patch.content_text).slice(0, 5000);
  if (patch.media_metadata !== undefined) next.media_metadata = isPlainObject(patch.media_metadata) ? clonePlain(patch.media_metadata) : null;
  const { valid, issues } = validateEvidenceRecord(next);
  if (!valid) return fail('EVIDENCE_INVALID', '更新后的证据未通过契约校验。', { entity: { type: 'evidence', id: evidenceId }, diagnostics: boundedDiagnostics(issues) });
  next.version = (record.version || 1) + 1;
  next.updated_at = new Date().toISOString();
  next.fingerprint = '';
  next.fingerprint = await hasher(next);
  const hashCheck = await requireHash(next, ctx.payloadSha256, hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_evidence_records_v1',
    entityType: 'evidence',
    entityId: evidenceId,
    payload: next,
    expectedBaseVersion: null,
    expectedEntityFingerprint: baseline.value,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'evidence', evidenceId);
}

async function applyEvidenceRemove(ctx) {
  const owned = await requireOwnedProject(ctx.payload, ctx.userId, ctx.db);
  if (!owned.ok) return owned;
  const evidenceId = ctx.payload.evidence_id;
  if (typeof evidenceId !== 'string' || !/^ev-[0-9a-f]{24}$/.test(evidenceId)) return fail('EVIDENCE_ID_INVALID', 'evidence_id 格式无效。', { entity: { type: 'project', id: owned.projectId } });
  const baseline = requireExpectedFingerprint(ctx.payload, null, 'evidence', evidenceId);
  if (!baseline.ok) return baseline;
  // 存在性与幂等都在事务性边界内原子处理（预留在前、删除在后）：
  // 同键重放先命中幂等预留 → replayed，绝不因证据已删除而误报。
  try {
    const write = await ctx.db.removeEvidence(ctx.userId, {
      command: ctx.command,
      idempotency_key: ctx.idempotencyKey,
      entity_type: 'evidence',
      entity_id: evidenceId,
      request_summary: { command: ctx.command, request_payload: clonePlain(ctx.payload), payload_sha256: ctx.payloadSha256 || null },
      project_id: owned.projectId,
      evidence_id: evidenceId,
      expected_entity_fingerprint: baseline.value,
    });
    return writeResult(write, 'evidence', evidenceId);
  } catch (error) {
    const code = String((error && error.code) || '');
    if (code === 'EVIDENCE_NOT_FOUND') {
      return fail('EVIDENCE_NOT_FOUND', '证据不存在或不属于当前项目。', { entity: { type: 'evidence', id: evidenceId } });
    }
    if (code === 'PROJECT_ARCHIVED') {
      return fail('PROJECT_ARCHIVED', '项目已归档（只读）：证据移除已拒绝；归档快照不会被修改。', { entity: { type: 'project', id: owned.projectId } });
    }
    if (code === 'IDEMPOTENCY_CONFLICT') {
      return fail('IDEMPOTENCY_CONFLICT', '幂等键已绑定到另一请求身份，已拒绝复用。', { entity: { type: 'evidence', id: evidenceId } });
    }
    if (code === 'ENTITY_REVISION_STALE') {
      return fail('ENTITY_REVISION_STALE', '证据快照已变化（并发写入或删除），拒绝移除。', { entity: { type: 'evidence', id: evidenceId } });
    }
    throw error;
  }
}

async function applyAnalysisCreate(ctx) {
  const { payload, db, hasher } = ctx;
  const owned = await requireOwnedProject(payload, ctx.userId, db);
  if (!owned.ok) return owned;
  const raw = payload.analysis;
  if (!isPlainObject(raw)) return fail('ANALYSIS_INVALID', 'analysis 必须是对象。');
  const record = clonePlain(raw);
  record.project_id = owned.projectId;
  record.schema_version = ANALYSIS_SCHEMA_VERSION;
  if (typeof record.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.fingerprint)) {
    record.fingerprint = '';
    record.fingerprint = await hasher(record);
  }
  const entities = await db.listProjectEntities(ctx.userId, owned.projectId);
  const evidenceExists = (entities.evidence || []).some((item) => item.id === record.evidence_id);
  if (!evidenceExists) return fail('ANALYSIS_BINDING_INVALID', '分析绑定的证据不存在，已拒绝。', { entity: { type: 'project', id: owned.projectId } });
  const previous = (entities.analyses || []).find((item) => item.id === record.id) || null;
  const baseline = requireExpectedFingerprint(payload, previous, 'analysis', String(record.id || '').slice(0, 200));
  if (!baseline.ok) return baseline;
  const { valid, issues } = validateAnalysis(record);
  if (!valid) return fail('ANALYSIS_INVALID', '分析记录未通过 P19 分析契约校验（kind 必须为 deterministic_local）。', { entity: { type: 'project', id: owned.projectId }, diagnostics: boundedDiagnostics(issues) });
  const hashCheck = await requireHash(record, ctx.payloadSha256, hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_analyses_v1',
    entityType: 'analysis',
    entityId: String(record.id || '').slice(0, 200),
    payload: record,
    expectedBaseVersion: null,
    expectedEntityFingerprint: baseline.value,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'analysis', String(record.id || '').slice(0, 200));
}

async function applyCardCreate(ctx) {
  const { payload, db, hasher } = ctx;
  const owned = await requireOwnedProject(payload, ctx.userId, db);
  if (!owned.ok) return owned;
  const raw = payload.card;
  if (!isPlainObject(raw)) return fail('CARD_INVALID', 'card 必须是对象。');
  const record = clonePlain(raw);
  record.project_id = owned.projectId;
  record.schema_version = KNOWLEDGE_CARD_SCHEMA_VERSION;
  if (typeof record.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.fingerprint)) {
    record.fingerprint = '';
    record.fingerprint = await hasher(record);
  }
  const entities = await db.listProjectEntities(ctx.userId, owned.projectId);
  const analysis = (entities.analyses || []).find((item) => item.id === record.analysis_id);
  if (!analysis) return fail('CARD_BINDING_INVALID', '知识卡绑定的分析不存在，已拒绝。', { entity: { type: 'project', id: owned.projectId } });
  const previous = (entities.cards || []).find((item) => item.id === record.id && item.version === record.version) || null;
  const baseline = requireExpectedFingerprint(payload, previous, 'card', String(record.id || '').slice(0, 200));
  if (!baseline.ok) return baseline;
  if (record.analysis_fingerprint && analysis.fingerprint && record.analysis_fingerprint !== analysis.fingerprint) {
    return fail('CARD_SNAPSHOT_STALE', '知识卡引用的分析快照与当前记录不一致，已拒绝。', { entity: { type: 'card', id: String(record.id || '').slice(0, 40) } });
  }
  const { valid, issues } = validateKnowledgeCard(record);
  if (!valid) return fail('CARD_INVALID', '知识卡未通过 content_knowledge_card_v1 校验。', { entity: { type: 'project', id: owned.projectId }, diagnostics: boundedDiagnostics(issues) });
  const hashCheck = await requireHash(record, ctx.payloadSha256, hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_knowledge_cards_v1',
    entityType: 'card',
    entityId: String(record.id || '').slice(0, 200),
    payload: record,
    expectedBaseVersion: null,
    expectedEntityFingerprint: baseline.value,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'card', String(record.id || '').slice(0, 200));
}

async function applyBriefAssemble(ctx) {
  const { payload, db, hasher } = ctx;
  const owned = await requireOwnedProject(payload, ctx.userId, db);
  if (!owned.ok) return owned;
  const raw = payload.brief;
  if (!isPlainObject(raw)) return fail('BRIEF_INVALID', 'brief 必须是对象。');
  const record = clonePlain(raw);
  record.project_id = owned.projectId;
  record.schema_version = BRIEF_SCHEMA_VERSION;
  if (!BRIEF_STATUSES.includes(record.status)) record.status = 'pending_review';
  if (typeof record.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.fingerprint)) {
    record.fingerprint = '';
    record.fingerprint = await hasher(record);
  }
  const entities = await db.listProjectEntities(ctx.userId, owned.projectId);
  const cardIds = new Set((entities.cards || []).map((card) => card.id));
  for (const cardId of record.knowledge_citation_ids || []) {
    if (!cardIds.has(cardId)) return fail('BRIEF_BINDING_INVALID', 'Brief 引用的知识卡不存在，已拒绝。', { entity: { type: 'project', id: owned.projectId } });
  }
  const previous = (entities.briefs || []).find((item) => item.id === record.id && item.version === record.version)
    || (entities.brief && entities.brief.id === record.id && entities.brief.version === record.version ? entities.brief : null);
  const baseline = requireExpectedFingerprint(payload, previous, 'brief', String(record.id || '').slice(0, 200));
  if (!baseline.ok) return baseline;
  const { valid, issues } = validateBrief(record);
  if (!valid) return fail('BRIEF_INVALID', 'Brief 未通过 P19 Brief 契约校验。', { entity: { type: 'project', id: owned.projectId }, diagnostics: boundedDiagnostics(issues) });
  const hashCheck = await requireHash(record, ctx.payloadSha256, hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_briefs_v1',
    entityType: 'brief',
    entityId: String(record.id || '').slice(0, 200),
    payload: record,
    expectedBaseVersion: null,
    expectedEntityFingerprint: baseline.value,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'brief', String(record.id || '').slice(0, 200));
}

async function applyBriefDecide(ctx) {
  const { payload, db, hasher } = ctx;
  const owned = await requireOwnedProject(payload, ctx.userId, db);
  if (!owned.ok) return owned;
  const decision = payload.decision;
  if (!isPlainObject(decision)) return fail('DECISION_INVALID', 'decision 必须是对象。', { entity: { type: 'project', id: owned.projectId } });
  const entities = await db.listProjectEntities(ctx.userId, owned.projectId);
  const brief = entities.brief || null;
  if (!brief) return fail('BRIEF_NOT_FOUND', '项目还没有 Brief，无法记录审核决定。', { entity: { type: 'project', id: owned.projectId } });
  const baseline = requireExpectedFingerprint(payload, brief, 'brief', String(brief.id || '').slice(0, 200));
  if (!baseline.ok) return baseline;
  if (decision.brief_id !== brief.id || decision.brief_version !== brief.version) {
    return fail('DECISION_REVISION_MISMATCH', '审核决定引用的 Brief 修订与当前不一致，已拒绝。', { entity: { type: 'brief', id: brief.id } });
  }
  if (!BRIEF_DECISIONS.includes(decision.value)) return fail('DECISION_INVALID', '审核决定 value 必须是 approved 或 return_for_revision。', { entity: { type: 'brief', id: brief.id } });
  if (decision.source !== HANDOFF_DECISION_METHOD) return fail('DECISION_SOURCE_INVALID', '审核决定 source 不是精确的 local_manual。', { entity: { type: 'brief', id: brief.id } });
  if (!isNonEmptyString(decision.rationale) || decision.rationale.length > 500) return fail('DECISION_RATIONALE_INVALID', '审核理由必须为非空且不超过 500 字符。', { entity: { type: 'brief', id: brief.id } });
  const review = {
    schema_version: BRIEF_REVIEW_SCHEMA_VERSION,
    brief_id: brief.id,
    decision: {
      value: decision.value,
      rationale: decision.rationale,
      decided_at: decision.decided_at || new Date().toISOString(),
      source: HANDOFF_DECISION_METHOD,
      decided_by: String(decision.decided_by || '').trim().slice(0, 200) || 'server_user',
    },
    comments: Array.isArray(decision.comments) ? decision.comments.slice(0, 50).map((item) => String(item || '').slice(0, 1000)) : [],
  };
  const next = clonePlain(brief);
  next.review = review;
  next.status = decision.value === 'approved' ? 'approved' : 'returned';
  next.updated_at = new Date().toISOString();
  next.fingerprint = '';
  next.fingerprint = await hasher(next);
  const hashCheck = await requireHash(next, ctx.payloadSha256, hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_briefs_v1',
    entityType: 'brief',
    entityId: String(next.id || '').slice(0, 200),
    payload: next,
    expectedBaseVersion: null,
    expectedEntityFingerprint: baseline.value,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'brief', String(next.id || '').slice(0, 200));
}

async function applyHandoffCreate(ctx) {
  const { payload, db, hasher } = ctx;
  const owned = await requireOwnedProject(payload, ctx.userId, db);
  if (!owned.ok) return owned;
  const raw = payload.handoff;
  if (!isPlainObject(raw)) return fail('HANDOFF_INVALID', 'handoff 必须是对象。');
  const record = clonePlain(raw);
  record.project_id = owned.projectId;
  if (typeof record.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.fingerprint)) {
    record.fingerprint = '';
    record.fingerprint = await hasher(record);
  }
  const entities = await db.listProjectEntities(ctx.userId, owned.projectId);
  const brief = entities.brief || null;
  const decision = brief && brief.review && brief.review.decision ? brief.review.decision : null;
  const previous = (entities.handoffs || []).find((item) => item.id === record.id && item.version === record.version)
    || (entities.handoff && entities.handoff.id === record.id && entities.handoff.version === record.version ? entities.handoff : null);
  const baseline = requireExpectedFingerprint(payload, previous, 'handoff', String(record.id || '').slice(0, 200));
  if (!baseline.ok) return baseline;
  if (!brief || brief.status !== 'approved' || !decision || decision.value !== 'approved') {
    return fail('HANDOFF_BRIEF_NOT_APPROVED', '交接包创建被拒绝：当前 Brief 修订未被人工批准。', { entity: { type: 'project', id: owned.projectId } });
  }
  const provenance = record.brief_provenance;
  if (!provenance || provenance.brief_id !== brief.id || provenance.brief_version !== brief.version
    || provenance.brief_schema_version !== brief.schema_version || provenance.brief_status !== brief.status) {
    return fail('HANDOFF_BINDING_INVALID', '交接包绑定的 Brief 与当前修订不一致，已拒绝。', { entity: { type: 'project', id: owned.projectId } });
  }
  const { valid, issues } = validateHandoffPackageRecord(record);
  if (!valid) return fail('HANDOFF_INVALID', '交接包未通过 P5 边界校验。', { entity: { type: 'project', id: owned.projectId }, diagnostics: boundedDiagnostics(issues) });
  const hashCheck = await requireHash(record, ctx.payloadSha256, hasher);
  if (!hashCheck.ok) return hashCheck;
  const write = await boundaryWrite(ctx, {
    table: 'p19_handoff_packages_v1',
    entityType: 'handoff',
    entityId: String(record.id || '').slice(0, 200),
    payload: record,
    expectedBaseVersion: null,
    expectedEntityFingerprint: baseline.value,
    declaredSha: ctx.payloadSha256,
  });
  return writeResult(write, 'handoff', String(record.id || '').slice(0, 200));
}

async function applyLineageAudit(ctx) {
  // 只读命令：归档项目仍可审计（归档门禁只拒绝变更命令）。
  const owned = await requireOwnedProject(ctx.payload, ctx.userId, ctx.db, { forMutation: false });
  if (!owned.ok) return owned;
  const entities = await ctx.db.listProjectEntities(ctx.userId, owned.projectId);
  const rows = {
    evidence: (entities.evidence || []).length,
    analyses: (entities.analyses || []).length,
    cards: (entities.cards || []).length,
    brief: entities.brief ? { id: entities.brief.id, version: entities.brief.version, status: entities.brief.status } : null,
    handoff: entities.handoff ? { id: entities.handoff.id, status: entities.handoff.status } : null,
  };
  return okResult('project', owned.projectId, { issues: [], lineage: rows });
}

function okResult(type, id, diagnostics) {
  return {
    ok: true,
    entity: { type, id },
    applied_at: new Date().toISOString(),
    diagnostics,
  };
}
