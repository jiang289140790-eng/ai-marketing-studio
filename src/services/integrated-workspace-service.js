// P18 完整智能内容链服务：统一 staging 实时数据与演示工作区的只读视图模型
//
// 优先规则：
//   1. 尝试读取 5 个 staging api 视图（通过 staging-preview-service.js）。
//   2. 如果全部 5 个视图读取成功：
//      a. 如果 staging 数据非空 → 返回 live staging 数据（永远不降级为 demo）。
//      b. 如果 staging 数据完全为空 → 返回「验收演示项目」数据，并明确标注为 demo。
//   3. 如果任何视图读取失败、部分失败或返回格式错误的数据 → fail closed，
//      显示可读的错误信息，绝不静默降级为 demo。
//   4. 跨绑定的 live 行如果格式畸形或不完整 → fail closed，报告具体校验失败原因。
//
// 本服务不执行任何写入、模型调用、生成、路由或发布。

import {
  ALL_STAGING_VIEW_NAMES,
  STAGING_VIEWS,
  getStagingRuntimeStatus,
  fetchAllStagingData,
  lineageStateDisplay,
} from './staging-preview-service.js';
import { DEMO_WORKSPACE, DEMO_WORKSPACE_META } from '../data/integrated-demo-workspace.js';

// ---- 常量 -------------------------------------------------------------------
export const INTEGRATED_EXECUTION_FLAGS = Object.freeze({
  generation_executed: false,
  routing_executed: false,
  network_executed: false,
  publish_executed: false,
});

const STORAGE_KEY_PREFIX = 'p18_brief_review_v1_';
const STORAGE_VERSION = 1;
const STORAGE_MAX_ENTRIES = 50;
const STORAGE_MAX_VALUE_LENGTH = 5000;

// ---- localStorage：有界版本化的 Brief 审批/退回/评论状态 -----------------------
function storageKey(briefId) {
  return `${STORAGE_KEY_PREFIX}${briefId}`;
}

export function loadBriefReviewState(briefId) {
  if (!briefId) return null;
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(briefId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed._v === STORAGE_VERSION && parsed._id === briefId) {
      return {
        status: parsed.status || 'pending',
        statusLabel: parsed.statusLabel || '待审核',
        reviewer: parsed.reviewer || null,
        reviewedAt: parsed.reviewedAt || null,
        decision: parsed.decision || null,
        comment: parsed.comment || '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveBriefReviewState(briefId, state) {
  if (!briefId) return false;
  try {
    // 边界控制：最大条目数
    if (!globalThis.localStorage) return false;
    const allKeys = Object.keys(globalThis.localStorage).filter((k) =>
      k.startsWith(STORAGE_KEY_PREFIX),
    );
    if (allKeys.length >= STORAGE_MAX_ENTRIES) {
      // 移除最旧的条目
      const oldest = allKeys.sort()[0];
      if (oldest && oldest !== storageKey(briefId)) {
        globalThis.localStorage.removeItem(oldest);
      }
    }

    // 边界控制：值长度
    const sanitized = {
      _v: STORAGE_VERSION,
      _id: briefId,
      status: String(state.status || 'pending').slice(0, 100),
      statusLabel: String(state.statusLabel || '待审核').slice(0, 200),
      reviewer: state.reviewer ? String(state.reviewer).slice(0, 200) : null,
      reviewedAt: state.reviewedAt || new Date().toISOString(),
      decision: state.decision ? String(state.decision).slice(0, 100) : null,
      comment: String(state.comment || '').slice(0, STORAGE_MAX_VALUE_LENGTH),
    };

    const raw = JSON.stringify(sanitized);
    if (raw.length > STORAGE_MAX_VALUE_LENGTH * 2) return false;

    globalThis.localStorage.setItem(storageKey(briefId), raw);
    return true;
  } catch {
    return false;
  }
}

export function clearBriefReviewState(briefId) {
  if (!briefId) return;
  try {
    globalThis.localStorage?.removeItem(storageKey(briefId));
  } catch {
    // 静默失败
  }
}

// ---- Staging 行校验 ---------------------------------------------------------
// 验证单行是否格式完整且跨绑定一致。返回 { valid, errors }。
function validateStagingRow(row, viewName, index) {
  const errors = [];
  if (!row || typeof row !== 'object') {
    errors.push(`${viewName}[${index}]: 行不是有效对象`);
    return { valid: false, errors };
  }

  // 基本要求：至少有一个标识字段
  const hasId = Boolean(row.id);
  if (!hasId) {
    errors.push(`${viewName}[${index}]: 缺少 id 字段`);
  }

  return { valid: errors.length === 0, errors };
}

// 验证整个视图的 staging 数据
function validateStagingView(viewName, rows) {
  const allErrors = [];
  if (!Array.isArray(rows)) {
    return {
      valid: false,
      errors: [`${viewName}: 数据不是数组 (type: ${typeof rows})`],
    };
  }

  for (let i = 0; i < rows.length; i++) {
    const result = validateStagingRow(rows[i], viewName, i);
    if (!result.valid) {
      allErrors.push(...result.errors);
    }
  }

  return { valid: allErrors.length === 0, errors: allErrors };
}

// 检查 cross-bound 引用一致性：验证 knowledge cards 引用的 evidence ID、brief 引用的 knowledge ID 等
function validateCrossBindings(byView) {
  const errors = [];

  // 收集所有有效 ID
  const knowledgeCardIds = new Set(
    (byView[STAGING_VIEWS.KNOWLEDGE_CARDS]?.data || []).map((r) => String(r.id)),
  );
  const briefIds = new Set(
    (byView[STAGING_VIEWS.CONTENT_BRIEFS]?.data || []).map((r) => String(r.id)),
  );

  // 检查交接清单引用的 brief
  const handoffRows = byView[STAGING_VIEWS.HANDOFF_MANIFEST]?.data || [];
  for (let i = 0; i < handoffRows.length; i++) {
    const row = handoffRows[i];
    const refBriefId = row.brief_id || row.briefId;
    if (refBriefId && !briefIds.has(String(refBriefId))) {
      errors.push(
        `handoff_manifest[${i}].brief_id=${refBriefId} 引用了不存在的 brief（cross-bound 校验失败）`,
      );
    }
  }

  // 检查交接包详情是否引用了存在的 knowledge card
  const pkgRows = byView[STAGING_VIEWS.HANDOFF_PACKAGE_DETAIL]?.data || [];
  for (let i = 0; i < pkgRows.length; i++) {
    const row = pkgRows[i];
    const refKcId = row.knowledge_card_id || row.knowledgeCardId;
    if (refKcId && !knowledgeCardIds.has(String(refKcId))) {
      errors.push(
        `handoff_package_detail[${i}].knowledge_card_id=${refKcId} 引用了不存在的 knowledge card（cross-bound 校验失败）`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---- 核心 API：加载集成工作区数据 --------------------------------------------
export async function loadIntegratedWorkspace({ client, userId } = {}) {
  const runtime = getStagingRuntimeStatus();

  // 演示数据只允许在五个 staging 视图均成功且全部为空时出现。
  if (!runtime.configured) {
    return buildFailClosedView(
      'not_configured',
      'Supabase staging 只读连接未配置，无法验证五个视图是否为空。',
      null,
    );
  }

  if (!userId) {
    return buildFailClosedView(
      'not_signed_in',
      '尚未登录，无法读取并验证 staging 数据。',
      null,
    );
  }

  try {
    // 步骤 1：读取所有 5 个 staging 视图
    const stagingResult = await fetchAllStagingData({ client, userId });

    // 步骤 2：如果整体状态不是 live 或 partial → fail closed
    if (stagingResult.status === 'read_error') {
      return buildFailClosedView(
        'staging_read_error',
        '读取 staging api 数据失败。请检查后端配置与访问权限。',
        stagingResult,
      );
    }

    if (stagingResult.status === 'access_denied') {
      return buildFailClosedView(
        'staging_access_denied',
        '无权访问 staging api schema。请确认 anon key 的 SELECT 权限。',
        stagingResult,
      );
    }

    if (
      stagingResult.status === 'partial' ||
      stagingResult.liveCount !== ALL_STAGING_VIEW_NAMES.length
    ) {
      return buildFailClosedView(
        'staging_partial_read',
        `Staging 只读结果不完整：仅 ${stagingResult.liveCount || 0}/${ALL_STAGING_VIEW_NAMES.length} 个视图读取成功。`,
        stagingResult,
      );
    }

    if (stagingResult.status === 'not_configured') {
      return buildFailClosedView(
        'not_configured',
        'Supabase staging 只读连接未配置，无法验证五个视图是否为空。',
        stagingResult,
      );
    }

    if (stagingResult.status === 'not_signed_in') {
      return buildFailClosedView(
        'not_signed_in',
        '尚未登录，无法读取并验证 staging 数据。',
        stagingResult,
      );
    }

    // 步骤 3：对 live 或 partial 状态执行行级校验
    const byView = stagingResult.byView || {};
    let allValidationErrors = [];

    for (const viewName of ALL_STAGING_VIEW_NAMES) {
      const view = byView[viewName];
      if (view && view.status === 'live' && view.data) {
        const validation = validateStagingView(viewName, view.data);
        if (!validation.valid) {
          allValidationErrors.push(...validation.errors);
        }
      }
    }

    // 步骤 4：cross-bound 校验
    const crossValidation = validateCrossBindings(byView);
    if (!crossValidation.valid) {
      allValidationErrors.push(...crossValidation.errors);
    }

    // 任何校验失败 → fail closed
    if (allValidationErrors.length > 0) {
      return buildFailClosedView(
        'staging_validation_failed',
        `Staging 数据校验失败（${allValidationErrors.length} 个错误）。行格式异常或跨绑定引用不一致。`,
        { ...stagingResult, validationErrors: allValidationErrors },
      );
    }

    // 步骤 5：判断 staging 是否完全为空
    const totalCount = (stagingResult.counts && stagingResult.counts.total) || 0;

    // 计算 5 个视图的行数
    const allViewCounts = ALL_STAGING_VIEW_NAMES.map((name) => {
      const v = byView[name];
      return (v && Array.isArray(v.data) && v.data.length) || 0;
    });
    const isCompletelyEmpty = allViewCounts.every((c) => c === 0) && totalCount === 0;

    if (isCompletelyEmpty) {
      // staging 完全为空 → 返回验收演示项目
      return buildDemoWorkspaceView('staging_empty');
    }

    // staging 有数据 → 返回 live 视图
    return buildLiveWorkspaceView(stagingResult);
  } catch (error) {
    return buildFailClosedView(
      'unexpected_error',
      `加载集成工作区数据时发生意外错误：${error.message || error}`,
      null,
    );
  }
}

// ---- 视图构建函数 ------------------------------------------------------------
function buildDemoWorkspaceView(reason) {
  const isStagingEmpty = reason === 'staging_empty';
  const isNotConfigured = reason === 'not_configured';

  return {
    status: 'demo',
    source: '验收演示项目',
    sourceLabel: '验收演示项目（本地演示数据）',
    sourceReason: reason,
    demoOnly: true,
    isStagingEmpty,
    isNotConfigured,
    meta: DEMO_WORKSPACE_META,
    evidence: DEMO_WORKSPACE.evidence,
    analyses: DEMO_WORKSPACE.analyses,
    knowledgeCards: DEMO_WORKSPACE.knowledgeCards,
    brief: DEMO_WORKSPACE.brief,
    handoff: DEMO_WORKSPACE.handoff,
    lineage: DEMO_WORKSPACE.lineage,
    executionFlags: DEMO_WORKSPACE.executionFlags,
    stagingData: null,
    note: isStagingEmpty
      ? 'Supabase staging api 的 5 个视图全部可读取但当前为空。显示验收演示项目数据。'
      : isNotConfigured
        ? 'Supabase 未配置。显示验收演示项目数据。'
        : '当前未登录。显示验收演示项目数据。',
    boundaryNote:
      '以下全部内容为「验收演示项目」的固定本地数据，不代表任何真实读取或执行。' +
      '四项执行标志均为 false，不采集、不生成、不路由、不发布。',
  };
}

function buildFailClosedView(reason, message, stagingResult) {
  return {
    status: 'fail_closed',
    source: null,
    sourceLabel: '数据读取失败',
    sourceReason: reason,
    demoOnly: false,
    isStagingEmpty: false,
    isNotConfigured: false,
    meta: null,
    evidence: [],
    analyses: [],
    knowledgeCards: [],
    brief: null,
    handoff: null,
    lineage: { entries: [], definitions: {}, stateCounts: {} },
    executionFlags: INTEGRATED_EXECUTION_FLAGS,
    stagingData: stagingResult,
    error: { message },
    validationErrors: stagingResult?.validationErrors || [],
    note: message,
    boundaryNote:
      'Staging 数据读取或校验失败。Fail closed：绝不静默降级为演示数据。' +
      '请检查后端配置、访问权限和数据完整性。',
  };
}

function buildLiveWorkspaceView(stagingResult) {
  const byView = stagingResult.byView || {};

  // 映射 staging 行到统一视图模型
  const knowledgeCards = (byView[STAGING_VIEWS.KNOWLEDGE_CARDS]?.data || []).map(
    (row) => mapStagingKnowledgeCard(row),
  );
  const contentBriefs = (byView[STAGING_VIEWS.CONTENT_BRIEFS]?.data || []).map(
    (row) => mapStagingBrief(row),
  );
  const handoffManifest = (byView[STAGING_VIEWS.HANDOFF_MANIFEST]?.data || []).map(
    (row) => mapStagingHandoff(row),
  );
  const handoffPackageDetail = (
    byView[STAGING_VIEWS.HANDOFF_PACKAGE_DETAIL]?.data || []
  ).map((row) => mapStagingPackageDetail(row));
  const lineageEntries = (byView[STAGING_VIEWS.LINEAGE_AUDIT]?.data || []).map(
    (row) => mapStagingLineageEntry(row),
  );

  // 构建世系状态计数
  const stateCounts = { COMPLETE: 0, PARTIAL: 0, BROKEN: 0, INVALID_SOURCE: 0 };
  for (const entry of lineageEntries) {
    const state = String(entry.lineageState || '').toUpperCase();
    if (Object.hasOwn(stateCounts, state)) {
      stateCounts[state] += 1;
    }
  }

  // 第一个 brief 作为主 Brief
  const primaryBrief = contentBriefs.length > 0 ? contentBriefs[0] : null;

  // 第一个 handoff 作为主交接包
  const primaryHandoff = handoffManifest.length > 0 ? handoffManifest[0] : null;

  return {
    status: 'live',
    source: 'staging_api',
    sourceLabel: '实时 Staging 数据（Supabase api schema）',
    sourceReason: 'live',
    demoOnly: false,
    isStagingEmpty: false,
    isNotConfigured: false,
    meta: null,
    evidence: [],
    analyses: [],
    knowledgeCards,
    brief: primaryBrief,
    handoff: primaryHandoff,
    handoffPackageDetails: handoffPackageDetail,
    lineage: {
      entries: lineageEntries,
      definitions: {}, // live 数据不使用 demo 定义
      stateCounts,
    },
    executionFlags: INTEGRATED_EXECUTION_FLAGS,
    stagingData: stagingResult,
    counts: stagingResult.counts || {},
    note: `已成功读取 staging api 数据。来源：Supabase api schema（${stagingResult.liveCount || 0}/${ALL_STAGING_VIEW_NAMES.length} 个视图在线）。`,
    boundaryNote:
      '本页仅执行 SELECT 只读请求：不采集、不分析调用、不生成、不路由、不发布。' +
      '四项执行标志均为 false。',
  };
}

// ---- Staging 行映射函数 ------------------------------------------------------
function mapStagingKnowledgeCard(row) {
  return {
    id: String(row.id || ''),
    title: String(row.title || ''),
    summary: String(row.summary || row.description || ''),
    category: String(row.category || ''),
    confidence: Number(row.confidence || 0),
    sourceEvidenceIds: Array.isArray(row.source_evidence_ids)
      ? row.source_evidence_ids.map(String)
      : [],
    sourceAnalysisIds: Array.isArray(row.source_analysis_ids)
      ? row.source_analysis_ids.map(String)
      : [],
    citations: Array.isArray(row.citations) ? row.citations : [],
    applicablePlatforms: Array.isArray(row.applicable_platforms)
      ? row.applicable_platforms
      : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: String(row.created_at || ''),
    provenance: `实时 staging 记录 · ${row.id || ''}`,
    isLive: true,
    raw: row,
  };
}

function mapStagingBrief(row) {
  return {
    id: String(row.id || ''),
    title: String(row.title || row.topic || ''),
    topic: String(row.topic || row.title || ''),
    objective: String(row.objective || row.description || ''),
    status: String(row.status || 'pending'),
    statusLabel: String(row.status_label || row.status || 'pending'),
    boundKnowledgeCardIds: Array.isArray(row.bound_knowledge_card_ids)
      ? row.bound_knowledge_card_ids.map(String)
      : [],
    boundEvidenceIds: Array.isArray(row.bound_evidence_ids)
      ? row.bound_evidence_ids.map(String)
      : [],
    constraints: Array.isArray(row.constraints) ? row.constraints : [],
    structuralGuidance: Array.isArray(row.structural_guidance)
      ? row.structural_guidance
      : [],
    humanDecision: {
      status: String(row.review_status || row.human_decision_status || 'pending'),
      statusLabel: String(row.review_status_label || '待审核'),
      reviewer: row.reviewer || null,
      reviewedAt: row.reviewed_at || null,
      decision: row.decision || row.review_decision || null,
      comment: String(row.review_comment || ''),
    },
    executionFlags: {
      generation_executed: Boolean(row.generation_executed),
      routing_executed: Boolean(row.routing_executed),
      network_executed: Boolean(row.network_executed),
      publish_executed: Boolean(row.publish_executed),
    },
    createdAt: String(row.created_at || ''),
    provenance: `实时 staging 记录 · ${row.id || ''}`,
    isLive: true,
    raw: row,
  };
}

function mapStagingHandoff(row) {
  return {
    id: String(row.id || ''),
    briefId: String(row.brief_id || row.briefId || ''),
    title: String(row.title || ''),
    description: String(row.description || ''),
    status: String(row.status || 'pending'),
    statusLabel: String(row.status_label || row.status || 'pending'),
    boundKnowledgeCardIds: Array.isArray(row.bound_knowledge_card_ids)
      ? row.bound_knowledge_card_ids.map(String)
      : [],
    boundEvidenceIds: Array.isArray(row.bound_evidence_ids)
      ? row.bound_evidence_ids.map(String)
      : [],
    executionFlags: {
      generation_executed: Boolean(row.generation_executed),
      routing_executed: Boolean(row.routing_executed),
      network_executed: Boolean(row.network_executed),
      publish_executed: Boolean(row.publish_executed),
    },
    contentPlan: Array.isArray(row.content_plan) ? row.content_plan : [],
    importOnly: Boolean(row.import_only),
    createdAt: String(row.created_at || ''),
    provenance: `实时 staging 记录 · ${row.id || ''}`,
    isLive: true,
    raw: row,
  };
}

function mapStagingPackageDetail(row) {
  return {
    id: String(row.id || ''),
    packageId: String(row.package_id || row.handoff_id || ''),
    knowledgeCardId: String(row.knowledge_card_id || row.knowledgeCardId || ''),
    detail: String(row.detail || row.description || ''),
    status: String(row.status || 'pending'),
    createdAt: String(row.created_at || ''),
    isLive: true,
    raw: row,
  };
}

function mapStagingLineageEntry(row) {
  const state = String(row.lineage_state || row.state || '').toUpperCase();
  const display = lineageStateDisplay(state);
  return {
    id: String(row.id || ''),
    nodeId: String(row.node_id || row.nodeId || ''),
    edgeId: String(row.edge_id || row.edgeId || ''),
    sourceNodeId: row.source_node_id || row.sourceNodeId || null,
    targetNodeId: String(row.target_node_id || row.targetNodeId || ''),
    lineageState: state,
    lineageStateDisplay: display,
    sourceLabel: String(row.source_label || row.sourceLabel || ''),
    summary: String(row.summary || row.note || ''),
    verifiedAt: String(row.verified_at || row.created_at || ''),
    isLive: true,
    raw: row,
  };
}

// ---- 辅助：按证据 ID 查找分析 -------------------------------------------------
export function findAnalysesForEvidence(analyses, evidenceId) {
  if (!analyses || !evidenceId) return [];
  return analyses.filter((a) => a.evidenceId === evidenceId);
}

// ---- 辅助：按知识卡 ID 查找引用证据 --------------------------------------------
export function findEvidenceForKnowledgeCard(evidence, knowledgeCard) {
  if (!evidence || !knowledgeCard) return [];
  const ids = new Set(
    (knowledgeCard.sourceEvidenceIds || []).map(String),
  );
  return evidence.filter((ev) => ids.has(String(ev.id)));
}

// ---- 辅助：构建从证据到世系的完整链 --------------------------------------------
export function buildFullChainTrace(workspace) {
  if (!workspace) return null;

  const { evidence, analyses, knowledgeCards, brief, handoff, lineage } = workspace;

  return {
    evidenceCount: (evidence || []).length,
    analysisCount: (analyses || []).length,
    knowledgeCardCount: (knowledgeCards || []).length,
    hasBrief: Boolean(brief),
    hasHandoff: Boolean(handoff),
    lineageEntryCount: (lineage?.entries || []).length,
    executionFlags: workspace.executionFlags || INTEGRATED_EXECUTION_FLAGS,
    source: workspace.source || workspace.sourceLabel || 'unknown',
    isDemo: workspace.demoOnly === true || (workspace.meta && workspace.meta.label && workspace.meta.label.includes('验收演示')),
    isLive: workspace.status === 'live',
    summary:
      `${(evidence || []).length} 条证据 → ${(analyses || []).length} 条分析 → ` +
      `${(knowledgeCards || []).length} 张知识卡 → ` +
      `${brief ? '1 条可审核 Brief' : '无 Brief'} → ` +
      `${handoff ? '1 个 P5 交接包' : '无交接包'} → ` +
      `${(lineage?.entries || []).length} 条世系记录`,
  };
}
