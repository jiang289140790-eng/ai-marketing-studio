// P19 有界本地持久化存储：严格 schema 校验、深克隆隔离、配额/错误处理、
// 单项目 JSON 包确定性导入导出。
//
// - 存储信封严格校验：版本精确、未知顶层字段一律拒绝（fail closed），
//   绝不把不可信内容写回 localStorage。
// - 所有读取返回深克隆，绝不与内部状态别名。
// - 绝不存储令牌、凭据、原始媒体字节、浏览器会话对象或任何后端客户端实例。
// - 导出是本地项目备份，不是发布/导出任务；导入校验版本、大小、id、
//   指纹、绑定、执行标志，并拒绝未知或不安全字段。
// - 本模块不发起任何网络请求，不访问任何远程系统。

import {
  PROJECT_SCHEMA_VERSION,
  PROJECT_PACKAGE_SCHEMA_VERSION,
  STORE_SCHEMA_VERSION,
  clonePlain,
  fingerprintOf,
  fingerprintOfSync,
  isPlainObject,
  validateAnalysis,
  validateBrief,
  validateEvidenceRecord,
  validateHandoffPackageRecord,
  validateKnowledgeCard,
  validateProject,
  validateProjectPackage,
  MAX_DIAGNOSTIC_LENGTH,
} from './p19-contracts.js';

export const STORE_KEY = 'p19_workspace_store_v1';
export const STORE_MAX_PROJECTS = 20;
export const STORE_MAX_PACKAGE_TEXT_LENGTH = 2 * 1024 * 1024; // 导入包文本上限 2 MiB

export function p19StoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.bounded = true;
  return error;
}

export function isP19StoreError(error) {
  return Boolean(error && error.bounded);
}

/** 解析 + 深度校验存储信封；失败返回 { ok:false, code, message }，绝不抛出。 */
export function parseStoreEnvelope(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, code: 'EMPTY_STORE', message: '本地存储为空，无需恢复。' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'CORRUPT_STORE', message: '本地存储内容损坏（不是合法 JSON），已 fail closed 拒绝读取。' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: 'CORRUPT_STORE', message: '本地存储信封不是对象，已 fail closed 拒绝读取。' };
  }
  const allowedTop = ['version', 'projects'];
  const unknown = Object.keys(parsed).filter((key) => !allowedTop.includes(key));
  if (unknown.length > 0) {
    return { ok: false, code: 'UNKNOWN_STORE_FIELDS', message: `本地存储信封包含未知字段，已 fail closed 拒绝读取（${unknown.length} 个）。` };
  }
  if (parsed.version !== STORE_SCHEMA_VERSION) {
    return { ok: false, code: 'STORE_VERSION_MISMATCH', message: '本地存储版本不精确匹配 p19_store_v1，已 fail closed 拒绝读取。' };
  }
  if (!Array.isArray(parsed.projects) || parsed.projects.length > STORE_MAX_PROJECTS) {
    return { ok: false, code: 'STORE_PROJECTS_BOUND', message: '本地存储项目列表超出有界上限，已 fail closed 拒绝读取。' };
  }
  const problems = [];
  const projectIds = new Set();
  for (const project of parsed.projects) {
    const verdict = validateStoredProject(project);
    if (!verdict.ok) problem(problems, verdict.issues, '项目记录未通过 P19 深层存储校验');
    if (projectIds.has(project?.id)) problem(problems, [], '存储中存在重复项目 id');
    projectIds.add(project?.id);
  }
  if (problems.length > 0) {
    return { ok: false, code: 'STORE_VALIDATION_FAILED', message: problems.slice(0, 8).join('；') };
  }
  return { ok: true, store: parsed };
}

const STORED_PROJECT_FIELDS = Object.freeze([
  'schema_version','id','version','status','topic','objective','audience','channel','constraints',
  'execution_flags','evidence','analyses','knowledge_cards','brief','handoff','handoffs','lineage',
  'fingerprint','created_at','updated_at',
]);

const STORED_ENTITY_FIELDS = Object.freeze({
  evidence: Object.freeze([
    'schema_version','id','project_id','source_url','label','platform','content_text','recorded_at',
    'provenance','media_metadata','source_metadata','media_assets','version','fingerprint','created_at','updated_at',
  ]),
  analyses: Object.freeze([
    'schema_version','id','project_id','evidence_id','kind','rule_ids','provenance','result',
    'model_analysis','evidence_fingerprint','evidence_version','version','fingerprint','created_at','updated_at',
  ]),
  knowledge_cards: Object.freeze([
    'schema_version','source_observations','creative_analysis','evidence_links','generation_guidance',
    'generation_readiness','id','project_id','analysis_id','analysis_fingerprint','analysis_version',
    'trust_status','validation_status','analysis_provenance','version','fingerprint','created_at','updated_at',
  ]),
  handoffs: Object.freeze([
    'schema_version','id','version','kind','status','payload_label','is_external_task',
    'submission_pending','local_only','repo_external','brief_provenance','human_decision','topic',
    'objective','knowledge_citations','evidence_provenance','structural_guidance','constraints',
    'external_project_boundary','import_only','manual_feedback','execution_flags','source_trace',
    'project_id','fingerprint','created_at',
  ]),
  brief: Object.freeze([
    'schema_version','id','project_id','version','status','topic','objective','audience','channel',
    'constraints','knowledge_citation_ids','structural_guidance','evidence_provenance',
    'card_fingerprints','evidence_provenance_fingerprint','project_fingerprint','review','version_note',
    'analysis_provenance','multimodal_findings','fingerprint','created_at','updated_at',
  ]),
});

function rejectUnknownRecordFields(record, allowed, label, issues) {
  if (!isPlainObject(record)) return;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length) issues.push(`${label} 包含未知字段：${unknown.slice(0, 4).join(', ')}`);
}

function validateStoredProject(project) {
  const issues = [];
  const base = validateProject(project);
  if (!base.valid) issues.push(...base.issues);
  if (!isPlainObject(project)) return { ok: false, issues };
  const unknown = Object.keys(project).filter((key) => !STORED_PROJECT_FIELDS.includes(key));
  if (unknown.length) issues.push(`项目包含未知字段：${unknown.slice(0, 4).join(', ')}`);
  for (const field of ['evidence','analyses','knowledge_cards','handoffs']) {
    if (!Array.isArray(project[field])) issues.push(`项目缺少 ${field} 数组`);
  }
  if (project.lineage !== null) issues.push('持久化项目 lineage 必须为 null（世系由读取时确定性计算）');
  const groups = [
    ['evidence', validateEvidenceRecord],
    ['analyses', validateAnalysis],
    ['knowledge_cards', validateKnowledgeCard],
    ['handoffs', validateHandoffPackageRecord],
  ];
  for (const [field, validator] of groups) {
    const ids = new Set();
    for (const record of Array.isArray(project[field]) ? project[field] : []) {
      rejectUnknownRecordFields(record, STORED_ENTITY_FIELDS[field], field, issues);
      const result = validator(record);
      if (!result.valid) issues.push(`${field}：${result.issues[0] || '结构无效'}`);
      if (!Number.isInteger(record?.version) || record.version < 1) issues.push(`${field} 版本无效`);
      if (typeof record?.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.fingerprint)) issues.push(`${field} 指纹无效`);
      if (ids.has(record?.id)) issues.push(`${field} 存在重复 id`);
      ids.add(record?.id);
    }
  }
  if (project.brief !== null) {
    rejectUnknownRecordFields(project.brief, STORED_ENTITY_FIELDS.brief, 'brief', issues);
    const brief = validateBrief(project.brief);
    if (!brief.valid) issues.push(`brief：${brief.issues[0] || '结构无效'}`);
    if (typeof project.brief?.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(project.brief.fingerprint)) issues.push('brief 指纹无效');
  }
  if (project.handoff !== null) {
    rejectUnknownRecordFields(project.handoff, STORED_ENTITY_FIELDS.handoffs, 'handoff', issues);
    const handoff = validateHandoffPackageRecord(project.handoff);
    if (!handoff.valid) issues.push(`handoff：${handoff.issues[0] || '结构无效'}`);
    if (!Array.isArray(project.handoffs) || project.handoffs.length !== 1 || project.handoffs[0]?.id !== project.handoff.id) {
      issues.push('handoff 与 handoffs 快照不一致');
    }
  } else if (Array.isArray(project.handoffs) && project.handoffs.length !== 0) {
    issues.push('handoff 为空时 handoffs 必须为空');
  }
  const binding = checkBindings({
    project, evidence: project.evidence || [], analyses: project.analyses || [],
    knowledge_cards: project.knowledge_cards || [], brief: project.brief, handoff: project.handoff,
  });
  if (!binding.ok) issues.push(binding.message);
  if (typeof project.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(project.fingerprint)) {
    issues.push('项目指纹缺失或格式无效');
  } else {
    const copy = clonePlain(project);
    copy.fingerprint = '';
    if (fingerprintOfSync(copy) !== project.fingerprint) issues.push('项目指纹与完整嵌套快照不一致');
  }
  return { ok: issues.length === 0, issues };
}

function problem(problems, issues, prefix) {
  const text = issues.length > 0 ? `${prefix}：${issues[0]}` : prefix;
  if (problems.length < 8) problems.push(text.length > MAX_DIAGNOSTIC_LENGTH ? `${text.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : text);
}

/**
 * 创建有界本地存储。`storage` 可注入（默认 globalThis.localStorage），
 * `hasher` 可注入（默认 WebCrypto 指纹）；`now` 可注入保证测试确定性。
 */
export function createP19Store({
  storage = (typeof globalThis !== 'undefined' && globalThis.localStorage) || null,
  hasher = fingerprintOf,
} = {}) {
  function readEnvelope() {
    if (!storage) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '当前环境没有可用的本地存储，本页状态无法持久化。' };
    }
    let raw;
    try {
      raw = storage.getItem(STORE_KEY);
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '读取本地存储失败，本页状态无法恢复。' };
    }
    return parseStoreEnvelope(raw);
  }

  function writeEnvelope(envelope) {
    if (!storage) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '当前环境没有可用的本地存储，修改无法保存。' };
    }
    try {
      const raw = JSON.stringify(envelope);
      storage.setItem(STORE_KEY, raw);
      return { ok: true };
    } catch (error) {
      const quota = error && (error.name === 'QuotaExceededError' || error.code === 22);
      return {
        ok: false,
        code: quota ? 'STORAGE_QUOTA' : 'STORAGE_WRITE_FAILED',
        message: quota
          ? '本地存储空间不足，本次修改未保存。请先导出备份并清理其他项目的本地数据。'
          : '写入本地存储失败，本次修改未保存。',
      };
    }
  }

  /** 项目列表摘要（深克隆）。 */
  function listProjects() {
    const read = readEnvelope();
    if (!read.ok) return read;
    const projects = read.store.projects.map((project) => clonePlain({
      id: project.id,
      version: project.version,
      status: project.status,
      topic: project.topic,
      objective: project.objective,
      audience: project.audience,
      channel: project.channel,
      created_at: project.created_at,
      updated_at: project.updated_at,
      evidence_count: Array.isArray(project.evidence) ? project.evidence.length : 0,
      analysis_count: Array.isArray(project.analyses) ? project.analyses.length : 0,
      card_count: Array.isArray(project.knowledge_cards) ? project.knowledge_cards.length : 0,
      brief_status: project.brief ? project.brief.status : null,
      has_handoff: Boolean(project.handoff),
    }));
    return { ok: true, projects };
  }

  /** 获取项目完整快照（深克隆，绝无别名）。 */
  function getProject(projectId) {
    const read = readEnvelope();
    if (!read.ok) return read;
    const project = read.store.projects.find((item) => item.id === projectId);
    if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', message: '项目不存在或已被移除。' };
    return { ok: true, project: clonePlain(project) };
  }

  /** 保存项目（校验后整体替换同 id 快照；项目版本由上层递增）。 */
  function putProject(project) {
    const verdict = validateStoredProject(project);
    if (!verdict.ok) {
      return { ok: false, code: 'PROJECT_INVALID', message: verdict.issues[0] || '项目记录无效。' };
    }
    const read = readEnvelope();
    // fail closed：损坏信封（CORRUPT_STORE）与任何校验失败都绝不覆盖写回，
    // 原始字节保持原样；只有空存储（EMPTY_STORE）允许初始化新信封。
    if (!read.ok && read.code !== 'EMPTY_STORE') return read;
    const envelope = read.ok
      ? read.store
      : { version: STORE_SCHEMA_VERSION, projects: [] };
    const index = envelope.projects.findIndex((item) => item.id === project.id);
    if (index >= 0) {
      envelope.projects[index] = clonePlain(project);
    } else {
      if (envelope.projects.length >= STORE_MAX_PROJECTS) {
        return { ok: false, code: 'STORE_PROJECTS_BOUND', message: `本地最多保存 ${STORE_MAX_PROJECTS} 个项目，请先归档或移除旧项目。` };
      }
      envelope.projects.push(clonePlain(project));
    }
    const write = writeEnvelope(envelope);
    if (!write.ok) return write;
    return { ok: true, saved_at: project.updated_at || null };
  }

  /** 移除项目（破坏性，调用方必须先获得用户明确确认）。 */
  function deleteProject(projectId) {
    const read = readEnvelope();
    if (!read.ok) return read;
    const index = read.store.projects.findIndex((item) => item.id === projectId);
    if (index < 0) return { ok: false, code: 'PROJECT_NOT_FOUND', message: '项目不存在或已被移除。' };
    read.store.projects.splice(index, 1);
    return writeEnvelope(read.store);
  }

  /**
   * 导出单项目 JSON 包（本地备份）。校验通过后生成确定性指纹；
   * 返回的包是深克隆，绝不与存储别名。
   *
   * 确定性绑定契约：导出包必须内部绑定（证据/分析/知识卡/Brief/交接包
   * 的跨绑定引用全部存在）。任何带缺失绑定的存储内容导出时即 fail closed
   * （EXPORT_BINDING_FAILED），绝不产生不可导入的备份包；导入端同样不静默
   * 接受缺失绑定（IMPORT_BINDING_FAILED）。
   */
  async function exportProjectPackage(projectId) {
    const read = getProject(projectId);
    if (!read.ok) return read;
    const project = read.project;
    const body = {
      schema_version: PROJECT_PACKAGE_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      project: {
        schema_version: project.schema_version,
        id: project.id,
        version: project.version,
        status: project.status,
        topic: project.topic,
        objective: project.objective,
        audience: project.audience,
        channel: project.channel,
        constraints: project.constraints,
        execution_flags: project.execution_flags,
        created_at: project.created_at,
        updated_at: project.updated_at,
      },
      evidence: project.evidence,
      analyses: project.analyses,
      knowledge_cards: project.knowledge_cards,
      brief: project.brief || null,
      handoff: project.handoff || null,
    };
    const binding = checkBindings(body);
    if (!binding.ok) {
      return { ok: false, code: 'EXPORT_BINDING_FAILED', message: `导出包绑定不一致：${binding.message}已拒绝导出。` };
    }
    const fingerprint = await hasher(body);
    const pkg = { ...body, fingerprint };
    const verdict = validateProjectPackage(pkg);
    if (!verdict.valid) {
      return { ok: false, code: 'EXPORT_VALIDATION_FAILED', message: verdict.issues[0] || '导出包未通过校验。' };
    }
    return { ok: true, pkg: clonePlain(pkg), text: JSON.stringify(pkg, null, 2) };
  }

  /**
   * 导入单项目 JSON 包（本地备份恢复）。校验顺序固定：
   * 文本大小 → JSON 解析 → 版本/未知字段 → 指纹 → 各实体校验 → 绑定一致 → 执行标志。
   * 任何一步失败都 fail closed，返回有界诊断，绝不写入。
   */
  async function inspectProjectPackage(text) {
    if (typeof text !== 'string') {
      return { ok: false, code: 'IMPORT_NOT_TEXT', message: '导入内容不是文本。' };
    }
    if (text.length === 0) {
      return { ok: false, code: 'IMPORT_EMPTY', message: '导入内容为空。' };
    }
    if (text.length > STORE_MAX_PACKAGE_TEXT_LENGTH) {
      return { ok: false, code: 'IMPORT_TOO_LARGE', message: '导入包超过 2 MiB 大小上限，已拒绝。' };
    }
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      return { ok: false, code: 'IMPORT_INVALID_JSON', message: '导入包不是合法 JSON，已拒绝。' };
    }
    const unknown = unknownPackageFields(pkg);
    if (unknown.length > 0) {
      return { ok: false, code: 'IMPORT_UNKNOWN_FIELDS', message: `导入包包含未知或不安全字段（${unknown.length} 个），已拒绝。` };
    }
    if (pkg.schema_version !== PROJECT_PACKAGE_SCHEMA_VERSION) {
      return { ok: false, code: 'IMPORT_VERSION_MISMATCH', message: '导入包版本不是精确的 p19_project_package_v1，已拒绝。' };
    }
    const verdict = validateProjectPackage(pkg);
    if (!verdict.valid) {
      return { ok: false, code: 'IMPORT_VALIDATION_FAILED', message: verdict.issues.slice(0, 4).join('；'), issues: verdict.issues.slice(0, 8) };
    }
    const actual = await hasher({
      schema_version: pkg.schema_version,
      exported_at: pkg.exported_at,
      project: pkg.project,
      evidence: pkg.evidence,
      analyses: pkg.analyses,
      knowledge_cards: pkg.knowledge_cards,
      brief: pkg.brief,
      handoff: pkg.handoff,
    });
    if (actual !== pkg.fingerprint) {
      return { ok: false, code: 'IMPORT_FINGERPRINT_MISMATCH', message: '导入包指纹与内容不一致，已拒绝。' };
    }
    const binding = checkBindings(pkg);
    if (!binding.ok) {
      return { ok: false, code: 'IMPORT_BINDING_FAILED', message: `导入包绑定不一致：${binding.message}已拒绝。` };
    }
    const read = readEnvelope();
    // fail closed：损坏信封（CORRUPT_STORE）与任何校验失败都绝不覆盖写回，
    // 原始字节保持原样；只有空存储（EMPTY_STORE）允许初始化新信封。
    if (!read.ok && read.code !== 'EMPTY_STORE') return read;
    const envelope = read.ok
      ? read.store
      : { version: STORE_SCHEMA_VERSION, projects: [] };
    const existing = envelope.projects.findIndex((item) => item.id === pkg.project.id);
    const current = existing >= 0 ? envelope.projects[existing] : null;
    return {
      ok: true,
      pkg: clonePlain(pkg),
      text,
      project_id: pkg.project.id,
      incoming_fingerprint: pkg.fingerprint,
      incoming_version: pkg.project.version,
      replaces_existing: existing >= 0,
      replacement_confirmation: current ? {
        project_id: pkg.project.id,
        incoming_fingerprint: pkg.fingerprint,
        existing_version: current.version,
        existing_fingerprint: current.fingerprint,
      } : null,
    };
  }

  async function importProjectPackage(text, { replacement_confirmation: confirmation = null } = {}) {
    const inspected = await inspectProjectPackage(text);
    if (!inspected.ok) return inspected;
    const read = readEnvelope();
    if (!read.ok && read.code !== 'EMPTY_STORE') return read;
    const envelope = read.ok ? read.store : { version: STORE_SCHEMA_VERSION, projects: [] };
    const existing = envelope.projects.findIndex((item) => item.id === inspected.project_id);
    if (existing >= 0) {
      const expected = inspected.replacement_confirmation;
      const current = envelope.projects[existing];
      const exact = isPlainObject(confirmation)
        && confirmation.project_id === expected.project_id
        && confirmation.incoming_fingerprint === expected.incoming_fingerprint
        && confirmation.existing_version === expected.existing_version
        && confirmation.existing_fingerprint === expected.existing_fingerprint
        && current.version === confirmation.existing_version
        && current.fingerprint === confirmation.existing_fingerprint;
      if (!exact) {
        return { ok: false, code: 'IMPORT_REPLACEMENT_CONFIRM_REQUIRED', message: '同 ID 项目已存在或已变化，必须重新确认准确的现有版本与导入指纹。', replacement_confirmation: {
          project_id: inspected.project_id,
          incoming_fingerprint: inspected.incoming_fingerprint,
          existing_version: current.version,
          existing_fingerprint: current.fingerprint,
        } };
      }
    } else if (confirmation !== null) {
      return { ok: false, code: 'IMPORT_CONFIRMATION_STALE', message: '替换确认已过时：当前不存在对应的同 ID 项目。' };
    }
    const project = rebuildProjectFromPackage(inspected.pkg);
    project.fingerprint = await hasher({ ...clonePlain(project), fingerprint: '' });
    const deepVerdict = validateStoredProject(project);
    if (!deepVerdict.ok) return { ok: false, code: 'IMPORT_VALIDATION_FAILED', message: deepVerdict.issues.slice(0, 4).join('；') };
    if (existing >= 0) {
      envelope.projects[existing] = project;
    } else {
      if (envelope.projects.length >= STORE_MAX_PROJECTS) {
        return { ok: false, code: 'STORE_PROJECTS_BOUND', message: `本地最多保存 ${STORE_MAX_PROJECTS} 个项目，请先归档或移除旧项目。` };
      }
      envelope.projects.push(project);
    }
    const write = writeEnvelope(envelope);
    if (!write.ok) return write;
    return { ok: true, project_id: project.id, imported_at: project.updated_at };
  }

  return {
    listProjects,
    getProject,
    putProject,
    deleteProject,
    exportProjectPackage,
    inspectProjectPackage,
    importProjectPackage,
  };
}

/** 导入包未知字段拒绝（确定性 allowlist）。 */
function unknownPackageFields(pkg) {
  if (!isPlainObject(pkg)) return ['<not-an-object>'];
  const allowed = [
    'schema_version', 'exported_at', 'fingerprint',
    'project', 'evidence', 'analyses', 'knowledge_cards', 'brief', 'handoff',
  ];
  const unknown = Object.keys(pkg).filter((key) => !allowed.includes(key));
  const project = pkg.project;
  if (isPlainObject(project)) {
    const allowedProject = ['id', 'version', 'status', 'schema_version', 'topic', 'objective', 'audience', 'channel', 'constraints', 'execution_flags', 'created_at', 'updated_at'];
    unknown.push(...Object.keys(project).filter((key) => !allowedProject.includes(key)).map((key) => `project.${key}`));
  }
  return unknown;
}

/** 导入包跨绑定一致性：证据/分析/知识卡必须属于同项目，卡必须绑定存在的分析。 */
function checkBindings(pkg) {
  const projectId = pkg.project.id;
  const evidenceIds = new Set();
  const analysisIds = new Set();
  for (const record of pkg.evidence) {
    if (evidenceIds.has(record.id)) return bindingFail('证据 id 重复。');
    if (record.project_id !== projectId) return bindingFail('证据绑定到其他项目。');
    evidenceIds.add(record.id);
  }
  for (const record of pkg.analyses) {
    if (analysisIds.has(record.id)) return bindingFail('分析 id 重复。');
    if (record.project_id !== projectId) return bindingFail('分析绑定到其他项目。');
    if (!evidenceIds.has(record.evidence_id)) return bindingFail('分析绑定的证据不存在。');
    analysisIds.add(record.id);
  }
  const cardIds = new Set();
  for (const card of pkg.knowledge_cards) {
    if (cardIds.has(card.id)) return bindingFail('知识卡 id 重复。');
    cardIds.add(card.id);
    if (card.project_id !== projectId) return bindingFail('知识卡绑定到其他项目。');
    if (!analysisIds.has(card.analysis_id)) return bindingFail('知识卡绑定的分析不存在。');
    if (typeof card.analysis_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(card.analysis_fingerprint)) {
      return bindingFail('知识卡绑定指纹缺失或格式无效。');
    }
  }
  if (pkg.brief) {
    if (pkg.brief.project_id !== projectId) return bindingFail('Brief 绑定到其他项目。');
    for (const cardId of pkg.brief.knowledge_citation_ids) {
      if (!pkg.knowledge_cards.some((card) => card.id === cardId)) return bindingFail(`Brief 引用不存在的知识卡 ${String(cardId).slice(0, 40)}。`);
    }
  }
  if (pkg.handoff) {
    const provenance = pkg.handoff.brief_provenance;
    if (pkg.handoff.project_id !== projectId) return bindingFail('交接包绑定到其他项目。');
    if (!provenance || provenance.brief_id !== pkg.brief?.id || provenance.brief_version !== pkg.brief?.version) {
      return bindingFail('交接包绑定的 Brief 与当前版本不一致。');
    }
  }
  return { ok: true };
}

/** 绑定失败的中性错误（导入/导出调用方各自包装为有界错误码与文案）。 */
function bindingFail(message) {
  return { ok: false, code: 'BINDING_FAILED', message };
}

/** 从导入包重建完整项目快照（版本号按导入包原值；深克隆隔离）。 */
function rebuildProjectFromPackage(pkg) {
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    id: pkg.project.id,
    version: pkg.project.version,
    status: pkg.project.status,
    topic: pkg.project.topic,
    objective: pkg.project.objective,
    audience: pkg.project.audience,
    channel: pkg.project.channel,
    constraints: clonePlain(pkg.project.constraints),
    execution_flags: clonePlain(pkg.project.execution_flags),
    created_at: pkg.project.created_at,
    updated_at: pkg.project.updated_at,
    evidence: clonePlain(pkg.evidence),
    analyses: clonePlain(pkg.analyses),
    knowledge_cards: clonePlain(pkg.knowledge_cards),
    brief: pkg.brief ? clonePlain(pkg.brief) : null,
    handoff: pkg.handoff ? clonePlain(pkg.handoff) : null,
    handoffs: pkg.handoff ? [clonePlain(pkg.handoff)] : [],
    lineage: null,
    fingerprint: '',
  };
}
