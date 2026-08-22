// P17-C 线上 Staging 集成预览服务：只读消费 5 个已验收的 Supabase staging api 视图
//
// 仅通过应用运行时已提供的公开浏览器配置（supabase-client.js）执行 SELECT 读取，
// 使用 client.schema('api').from(view).select('*') 模式访问 staging api schema，
// 绝不执行 insert / update / delete / upsert / rpc / storage / realtime。
//
// 5 个已验收视图：
//   api.ke_knowledge_cards_v1      — 知识卡（Knowledge Engine）
//   api.ke_content_briefs_v1      — 内容 Brief（Knowledge Engine）
//   api.ke_handoff_manifest_v1    — 交接清单（Knowledge Engine）
//   api.ke_handoff_package_detail_v1 — 交接包详情（Knowledge Engine）
//   api.vg_lineage_audit_v1       — 世系审计（Video Generator）
//
// 绝不引用生产项目 ID、服务角色密钥、私有 schema 或任何写操作。

import { isSupabaseConfigured, requireSupabase } from './supabase-client.js';
import { createP19CommandClient } from './p19-server-write-adapter.js';

// ---- 视图名称常量 -----------------------------------------------------------
export const STAGING_VIEWS = Object.freeze({
  KNOWLEDGE_CARDS: 'ke_knowledge_cards_v1',
  CONTENT_BRIEFS: 'ke_content_briefs_v1',
  HANDOFF_MANIFEST: 'ke_handoff_manifest_v1',
  HANDOFF_PACKAGE_DETAIL: 'ke_handoff_package_detail_v1',
  LINEAGE_AUDIT: 'vg_lineage_audit_v1',
});

export const ALL_STAGING_VIEW_NAMES = Object.freeze(Object.values(STAGING_VIEWS));

// ---- 世系状态常量 -----------------------------------------------------------
export const LINEAGE_STATES = Object.freeze({
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  BROKEN: 'BROKEN',
  INVALID_SOURCE: 'INVALID_SOURCE',
});

const LINEAGE_STATE_DISPLAY = Object.freeze({
  COMPLETE: { label: '完整', tone: 'success' },
  PARTIAL: { label: '部分', tone: 'warning' },
  BROKEN: { label: '断裂', tone: 'error' },
  INVALID_SOURCE: { label: '无效来源', tone: 'error' },
});

export function lineageStateDisplay(state) {
  return LINEAGE_STATE_DISPLAY[state] || { label: state || '未知', tone: 'muted' };
}

// ---- 运行时状态 -------------------------------------------------------------
export function getStagingRuntimeStatus() {
  return {
    configured: isSupabaseConfigured,
    readOnly: true,
    views: [...ALL_STAGING_VIEW_NAMES],
    note: '知识数据通过已认证的 server-only Edge 只读命令读取；浏览器不进入 api schema，无写操作、无服务角色密钥。',
  };
}

function knowledgeBoundaryViews(data = [], status = 'live', error = null) {
  return {
    status,
    data,
    error,
  };
}

function knowledgeBoundaryFailure(error) {
  const code = String(error?.code || 'KNOWLEDGE_READ_FAILED').slice(0, 80);
  const message = String(error?.message || '知识数据读取失败。').slice(0, 300);
  const accessDenied = /AUTH_REQUIRED|AUTH_FAILED|STAGING_ROLE_DENIED|FORBIDDEN|permission denied/i.test(`${code} ${message}`);
  const status = accessDenied ? 'access_denied' : 'read_error';
  return {
    status,
    code,
    message,
    accessDenied,
  };
}

function withProjectIdentity(record, projectId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return { project_id: projectId, ...record };
}

async function fetchKnowledgeThroughCommandBoundary({ client, userId }) {
  if (!isSupabaseConfigured && !client) {
    return { status: 'not_configured', byView: {}, liveCount: 0, errorCount: 0, accessDenied: false };
  }
  if (!userId) {
    return { status: 'not_signed_in', byView: {}, liveCount: 0, errorCount: 0, accessDenied: false };
  }

  try {
    const commandClient = createP19CommandClient({ client: client || requireSupabase() });
    const listResult = await commandClient.invoke('project.list', {});
    const projects = Array.isArray(listResult?.data?.projects) ? listResult.data.projects : [];
    const projectResults = await Promise.all(projects.map(async (summary) => {
      const projectId = String(summary?.id || '');
      if (!/^prj-[0-9a-f]{24}$/.test(projectId)) {
        const invalid = new Error('项目列表返回了无效身份，已停止知识读取。');
        invalid.code = 'PROJECT_ID_INVALID';
        throw invalid;
      }
      const result = await commandClient.invoke('project.read', { project_id: projectId });
      return result?.data?.project || null;
    }));

    const knowledgeCards = [];
    const contentBriefs = [];
    const handoffs = [];
    for (const project of projectResults) {
      const projectId = String(project?.id || '');
      for (const card of project?.knowledge_cards || []) {
        const normalized = withProjectIdentity(card, projectId);
        if (normalized) knowledgeCards.push(normalized);
      }
      const brief = withProjectIdentity(project?.brief, projectId);
      if (brief) contentBriefs.push(brief);
      const projectHandoffs = Array.isArray(project?.handoffs)
        ? project.handoffs
        : (project?.handoff ? [project.handoff] : []);
      for (const handoff of projectHandoffs) {
        const normalized = withProjectIdentity(handoff, projectId);
        if (normalized) handoffs.push(normalized);
      }
    }

    const byView = {
      [STAGING_VIEWS.KNOWLEDGE_CARDS]: knowledgeBoundaryViews(knowledgeCards),
      [STAGING_VIEWS.CONTENT_BRIEFS]: knowledgeBoundaryViews(contentBriefs),
      [STAGING_VIEWS.HANDOFF_MANIFEST]: knowledgeBoundaryViews(handoffs),
      [STAGING_VIEWS.HANDOFF_PACKAGE_DETAIL]: knowledgeBoundaryViews(handoffs),
    };
    const totalCount = knowledgeCards.length + contentBriefs.length + handoffs.length;
    return {
      status: totalCount === 0 ? 'empty' : 'live',
      byView,
      liveCount: 4,
      errorCount: 0,
      accessDenied: false,
      provenance: {
        boundary: 'p19-workspace-command',
        commands: ['project.list', 'project.read'],
        ops: 'read_only',
        note: `已通过服务端只读边界读取 ${projects.length} 个当前账号项目；浏览器未访问 api schema。`,
      },
    };
  } catch (error) {
    const failure = knowledgeBoundaryFailure(error);
    const byView = Object.fromEntries([
      STAGING_VIEWS.KNOWLEDGE_CARDS,
      STAGING_VIEWS.CONTENT_BRIEFS,
      STAGING_VIEWS.HANDOFF_MANIFEST,
      STAGING_VIEWS.HANDOFF_PACKAGE_DETAIL,
    ].map((view) => [view, knowledgeBoundaryViews([], failure.status, failure.message)]));
    return {
      status: failure.status,
      byView,
      liveCount: 0,
      errorCount: failure.accessDenied ? 0 : 1,
      accessDenied: failure.accessDenied,
      error: { code: failure.code, message: failure.message },
      provenance: {
        boundary: 'p19-workspace-command',
        commands: ['project.list', 'project.read'],
        ops: 'read_only',
      },
    };
  }
}

// ---- 内部辅助：单视图读取 ----------------------------------------------------
async function fetchSingleView(viewName, { client, userId } = {}) {
  if (!isSupabaseConfigured) {
    return { view: viewName, status: 'not_configured', data: [], error: null };
  }
  if (!userId) {
    return { view: viewName, status: 'not_signed_in', data: [], error: null };
  }
  const supabase = client || requireSupabase();
  try {
    const { data, error } = await supabase
      .schema('api')
      .from(viewName)
      .select('*');
    if (error) {
      const message = String(error.message || error.code || '');
      const isPermission = /permission denied|policy|not authorized|JWT|PGRST/i.test(message);
      return {
        view: viewName,
        status: isPermission ? 'access_denied' : 'read_error',
        data: [],
        error: message,
      };
    }
    return { view: viewName, status: 'live', data: data || [], error: null };
  } catch (err) {
    return {
      view: viewName,
      status: 'read_error',
      data: [],
      error: String(err.message || err || '读取失败'),
    };
  }
}

// ---- 公开 API：批量读取所有 5 个视图 -----------------------------------------
export async function fetchAllStagingData({ client, userId } = {}) {
  const views = ALL_STAGING_VIEW_NAMES;
  const results = await Promise.all(
    views.map((view) => fetchSingleView(view, { client, userId })),
  );

  const byView = {};
  let totalCount = 0;
  let liveCount = 0;
  let errorCount = 0;
  let accessDenied = false;

  for (const result of results) {
    byView[result.view] = {
      status: result.status,
      data: result.data,
      error: result.error,
    };
    totalCount += result.data.length;
    if (result.status === 'live') liveCount += 1;
    if (result.status === 'read_error') errorCount += 1;
    if (result.status === 'access_denied') accessDenied = true;
  }

  const topLevelStatus = (() => {
    if (!results.length || results.every((r) => r.status === 'not_configured')) return 'not_configured';
    if (results.every((r) => r.status === 'not_signed_in')) return 'not_signed_in';
    if (accessDenied && liveCount === 0) return 'access_denied';
    if (errorCount > 0 && liveCount === 0) return 'read_error';
    if (liveCount === 0) return 'empty';
    if (errorCount > 0 || accessDenied) return 'partial';
    return 'live';
  })();

  return {
    status: topLevelStatus,
    byView,
    counts: {
      knowledgeCards: byView[STAGING_VIEWS.KNOWLEDGE_CARDS]?.data?.length || 0,
      contentBriefs: byView[STAGING_VIEWS.CONTENT_BRIEFS]?.data?.length || 0,
      handoffManifest: byView[STAGING_VIEWS.HANDOFF_MANIFEST]?.data?.length || 0,
      handoffPackageDetail: byView[STAGING_VIEWS.HANDOFF_PACKAGE_DETAIL]?.data?.length || 0,
      lineageAudit: byView[STAGING_VIEWS.LINEAGE_AUDIT]?.data?.length || 0,
      total: totalCount,
    },
    liveCount,
    errorCount,
    accessDenied,
    provenance: {
      schema: 'api',
      views: [...views],
      ops: 'select_only',
      note: `已读取 ${liveCount} / ${views.length} 个视图（仅 SELECT）。`,
    },
  };
}

// ---- 公开 API：单独读取知识引擎 4 视图 ---------------------------------------
export async function fetchKnowledgeEngineData({ client, userId } = {}) {
  return fetchKnowledgeThroughCommandBoundary({ client, userId });
}

// ---- 公开 API：单独读取世系审计视图 -----------------------------------------
export async function fetchLineageAuditData({ client, userId } = {}) {
  const result = await fetchSingleView(STAGING_VIEWS.LINEAGE_AUDIT, { client, userId });

  const entries = result.data || [];
  const stateCounts = { COMPLETE: 0, PARTIAL: 0, BROKEN: 0, INVALID_SOURCE: 0 };

  for (const entry of entries) {
    const state = String(entry.lineage_state || entry.state || '').toUpperCase();
    if (Object.hasOwn(stateCounts, state)) {
      stateCounts[state] += 1;
    }
  }

  return {
    status: result.status,
    entries,
    stateCounts,
    error: result.error,
    provenance: {
      schema: 'api',
      view: STAGING_VIEWS.LINEAGE_AUDIT,
      ops: 'select_only',
      note: `已读取 ${entries.length} 条世系记录（仅 SELECT）。`,
    },
  };
}

// ---- 显式构建错误/空视图（供页面在未发起请求前使用）----------------------------
export function buildStagingNotConfiguredView() {
  return {
    status: 'not_configured',
    configured: false,
    note: '实时后端未配置：设置 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY 后刷新本页。',
  };
}

export function buildStagingNotSignedInView() {
  return {
    status: 'not_signed_in',
    configured: true,
    note: '已配置实时后端，但当前没有已恢复的登录会话。请先在应用内完成登录。',
  };
}

export function buildStagingReadErrorView(message) {
  return {
    status: 'read_error',
    error: { message: String(message || '读取 staging 数据失败。') },
  };
}
