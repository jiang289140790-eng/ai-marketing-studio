import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/auth-context';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import {
  getStagingRuntimeStatus,
  fetchAllStagingData,
  fetchLineageAuditData,
  lineageStateDisplay,
} from '../services/staging-preview-service';
import { loadIntegratedWorkspace, buildFullChainTrace } from '../services/integrated-workspace-service.js';
import { ChainProgress, WorkspaceSourceBanner } from '../components/integrated-workspace';

// P17-C 向后兼容：保留旧 staging 服务引用（P18 新增 loadIntegratedWorkspace）
const _STAGING_COMPAT = { fetchAllStagingData, fetchLineageAuditData };

// ---- 工作流链步骤 -----------------------------------------------------------
const WORKFLOW_STEPS = [
  { step: 1, label: '研究证据', hint: '来源身份、引用与采集状态', target: 'research' },
  { step: 2, label: '分析', hint: '文本/多模态分析摘要', target: 'research' },
  { step: 3, label: '知识卡', hint: '已验证的可复用知识条目', target: 'knowledge' },
  { step: 4, label: '可审核 Brief', hint: '约束、执行标志与人工审核', target: 'knowledge' },
  { step: 5, label: 'P5 交接包', hint: '交接清单与执行边界', target: 'knowledge' },
  { step: 6, label: 'P16 世系', hint: '数据来源与完整性追踪', target: 'dashboard' },
];

const LINEAGE_STATE_ORDER = ['COMPLETE', 'PARTIAL', 'BROKEN', 'INVALID_SOURCE'];

// ---- 主组件 -----------------------------------------------------------------
export function CommandCenter({ userId, onNavigate }) {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const runtime = useMemo(() => getStagingRuntimeStatus(), []);
  const signedIn = Boolean(userId) && isAuthenticated;

  const [workspace, setWorkspace] = useState(null);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!runtime.configured || !signedIn) {
      setWorkspace(null);
      return undefined;
    }
    let cancelled = false;
    setFetching(true);
    loadIntegratedWorkspace({ userId })
      .then((ws) => {
        if (!cancelled) setWorkspace(ws);
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspace({
            status: 'fail_closed',
            source: null,
            sourceLabel: '数据读取失败',
            note: '加载集成工作区数据时发生意外错误。',
            error: { message: '加载集成工作区数据时发生意外错误。' },
            evidence: [],
            analyses: [],
            knowledgeCards: [],
            brief: null,
            handoff: null,
            lineage: { entries: [], definitions: {}, stateCounts: {} },
            executionFlags: {
              generation_executed: false,
              routing_executed: false,
              network_executed: false,
              publish_executed: false,
            },
          });
        }
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => { cancelled = true; };
  }, [runtime.configured, signedIn, userId]);

  // ---- 渲染：未配置 ------------------------------------------------------------
  if (!runtime.configured) {
    return (
      <section className="page-stack">
        <EmptyState
          title="等待数据服务配置"
          description="配置 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY 后，本页会显示完整智能内容链的只读状态。"
        />
      </section>
    );
  }

  // ---- 渲染：加载中 ------------------------------------------------------------
  if (authLoading) {
    return (
      <section className="page-stack">
        <div className="notice">正在恢复登录状态...</div>
      </section>
    );
  }

  // ---- 渲染：未登录（展示流程概览）----------------------------------------------
  if (!signedIn) {
    return (
      <section className="page-stack command-center-v2 staging-preview">
        <div className="hero-panel command-hero command-hero-simple">
          <div>
            <p className="eyebrow">AI 运营指挥中心 · 线上只读预览</p>
            <h2>研究证据 → 分析 → 知识卡 → 可审核 Brief → P5 交接包 → P16 世系</h2>
            <p>
              完整智能内容链：从公开样本证据到可审核 Brief，再到 P5 内容交接包和 P16 世系审计。
              登录后读取属于你的 staging 数据；所有数据均为只读，不执行任何生成、路由或发布动作。
            </p>
          </div>
        </div>

        <section className="command-section workflow-chain-section" aria-label="智能内容链">
          <div className="section-head compact-head">
            <div>
              <p className="eyebrow">智能内容链</p>
              <h3>六步完成从研究到世系追溯</h3>
            </div>
          </div>
          <div className="workflow-chain">
            {WORKFLOW_STEPS.map((item, index) => (
              <span className="workflow-chain-step" key={item.label}>
                <i>{item.step}</i>
                <b>{item.label}</b>
                <small>{item.hint}</small>
                {index < WORKFLOW_STEPS.length - 1 && <em>→</em>}
              </span>
            ))}
          </div>
          <div className="workflow-chain-actions">
            <button className="primary-button" type="button" onClick={() => onNavigate('research')}>
              进入研究工作台
            </button>
            <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>
              浏览知识引擎
            </button>
            <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>
              内容工作台
            </button>
          </div>
        </section>

        <div className="notice">当前未登录：请先登录后查看你的 staging 数据；未登录时不会发起任何只读查询。</div>
      </section>
    );
  }

  // ---- 渲染：加载中 ------------------------------------------------------------
  if (fetching && !workspace) {
    return (
      <section className="page-stack">
        <div className="notice">正在读取集成工作区数据（仅 SELECT 只读）...</div>
      </section>
    );
  }

  // ---- 渲染：fail closed -------------------------------------------------------
  if (workspace?.status === 'fail_closed') {
    return (
      <section className="page-stack command-center-v2 staging-preview">
        <div className="hero-panel command-hero command-hero-simple">
          <p className="eyebrow">AI 运营指挥中心 · 数据异常</p>
          <h2>数据读取失败（Fail Closed）</h2>
          <p>{workspace.note || '无法读取集成工作区数据。'}</p>
        </div>
        {workspace.validationErrors && workspace.validationErrors.length > 0 && (
          <section className="command-section" aria-label="校验错误">
            <div className="section-head compact-head">
              <div>
                <p className="eyebrow">校验错误</p>
                <h3>数据格式或跨绑定异常</h3>
              </div>
            </div>
            <ul className="iw-error-list">
              {workspace.validationErrors.map((err, idx) => (
                <li key={idx} className="error-text">{err}</li>
              ))}
            </ul>
          </section>
        )}
        <section className="command-section preview-boundary-section" aria-label="预览安全边界">
          <div className="section-head compact-head">
            <div>
              <p className="eyebrow">安全边界</p>
              <h3>Fail Closed — 绝不静默降级为演示数据</h3>
            </div>
          </div>
          <div className="preview-boundary-detail">
            <div className="boundary-row">
              <span>数据源</span>
              <strong>api schema · 公开 anon key</strong>
            </div>
            <div className="boundary-row">
              <span>状态</span>
              <strong>数据校验失败或读取异常</strong>
            </div>
            <div className="boundary-row">
              <span>写操作</span>
              <strong>无</strong>
            </div>
          </div>
        </section>
        <footer className="preview-footer">
          <p>P18 完整智能内容链 · Fail Closed</p>
          <p className="preview-footer-fine">
            四项执行标志均为 false · 不采集、不生成、不路由、不发布
          </p>
        </footer>
      </section>
    );
  }

  // ---- 渲染：有数据（live 或 demo）----------------------------------------------
  const isDemo = workspace?.demoOnly === true;
  const isLive = workspace?.status === 'live';
  const chainTrace = buildFullChainTrace(workspace);
  const evidenceCount = (workspace?.evidence || []).length;
  const analysisCount = (workspace?.analyses || []).length;
  const knowledgeCardCount = (workspace?.knowledgeCards || []).length;
  const brief = workspace?.brief || null;
  const handoff = workspace?.handoff || null;
  const lineage = workspace?.lineage || { entries: [], stateCounts: {} };
  const lineageEntries = lineage.entries || [];
  const lineageStateCounts = lineage.stateCounts || {};

  return (
    <section className="page-stack command-center-v2 staging-preview">
      {/* ---- 数据来源标识 ---- */}
      <WorkspaceSourceBanner workspace={workspace} />

      {/* ---- Hero ---- */}
      <div className="hero-panel command-hero command-hero-simple">
        <div>
          <p className="eyebrow">
            AI 运营指挥中心 · {isLive ? '实时 Staging 只读' : '验收演示项目'}
          </p>
          <h2>{chainTrace ? chainTrace.summary : '完整智能内容链'}</h2>
          <p>
            {isDemo
              ? '验收演示项目：以下全部内容为固定的本地演示数据，不代表任何真实读取或执行。'
              : '本页展示完整智能内容链的只读状态：研究证据 → 分析 → 知识卡 → 可审核 Brief → P5 交接包 → P16 世系。仅执行 SELECT 只读请求。'}
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" type="button" onClick={() => onNavigate('research')}>
            研究工作台
          </button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>
            知识引擎
          </button>
        </div>
      </div>

      {/* ---- 研究工作流链 ---- */}
      <ChainProgress workspace={workspace} currentStage="dashboard" onNavigate={onNavigate} />

      {/* ---- 当前状态摘要 ---- */}
      <section className="command-section" aria-label="项目状态摘要">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">当前项目状态</p>
            <h3>完整智能内容链健康检查</h3>
          </div>
          <StatusBadge status={isLive ? 'connected' : 'preview'} />
        </div>
        <dl className="campaign-summary-grid iw-dashboard-grid">
          <div className="iw-dash-stat">
            <dt>证据记录</dt>
            <dd>{evidenceCount}</dd>
            <small>来源身份 + 精确引用</small>
          </div>
          <div className="iw-dash-stat">
            <dt>分析摘要</dt>
            <dd>{analysisCount}</dd>
            <small>文本 + 多模态</small>
          </div>
          <div className="iw-dash-stat">
            <dt>知识卡</dt>
            <dd>{knowledgeCardCount}</dd>
            <small>带引用溯源</small>
          </div>
          <div className="iw-dash-stat">
            <dt>可审核 Brief</dt>
            <dd>{brief ? 1 : 0}</dd>
            <small>{brief ? brief.statusLabel : '无'}</small>
          </div>
          <div className="iw-dash-stat">
            <dt>P5 交接包</dt>
            <dd>{handoff ? 1 : 0}</dd>
            <small>{handoff ? handoff.statusLabel : '无'}</small>
          </div>
          <div className="iw-dash-stat">
            <dt>P16 世系</dt>
            <dd>{lineageEntries.length}</dd>
            <small>节点/边审计记录</small>
          </div>
        </dl>
        <div className="workflow-chain-actions">
          <button className="primary-button" type="button" onClick={() => onNavigate('research')}>
            进入研究工作台
          </button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>
            浏览知识引擎
          </button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>
            内容工作台
          </button>
        </div>
      </section>

      {/* ---- 知识引擎摘要 ---- */}
      <section className="command-section knowledge-summary-section" aria-label="知识引擎摘要">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">知识引擎</p>
            <h3>知识卡、Brief 与交接包</h3>
          </div>
        </div>
        {knowledgeCardCount === 0 && !brief && !handoff ? (
          <div className="command-clear-state">
            <span>—</span>
            <div>
              <strong>暂无知识引擎数据（staging 为空）</strong>
              <p>当前数据源中没有知识卡、Brief 或交接包记录。</p>
            </div>
          </div>
        ) : (
          <>
            <dl className="campaign-summary-grid">
              <div><dt>知识卡</dt><dd>{knowledgeCardCount} 张</dd></div>
              <div><dt>内容 Brief</dt><dd>{brief ? 1 : 0} 条</dd></div>
              <div><dt>P5 交接包</dt><dd>{handoff ? 1 : 0} 项</dd></div>
            </dl>
            {/* 执行标志摘要 */}
            <div className="iw-flag-grid iw-flag-summary">
              {[
                ['generation_executed', '生成'],
                ['routing_executed', '路由'],
                ['network_executed', '网络'],
                ['publish_executed', '发布'],
              ].map(([key, label]) => {
                const val = (workspace?.executionFlags || {})[key];
                return (
                  <div className={`iw-flag-cell ${val ? 'on' : ''}`} key={key}>
                    <span>{label}</span>
                    <strong>{val ? '已执行' : '未执行'}</strong>
                  </div>
                );
              })}
            </div>
          </>
        )}
        <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>
          查看知识引擎全部数据
        </button>
      </section>

      {/* ---- 世系审计 ---- */}
      <section className="command-section lineage-section" aria-label="世系审计">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">世系审计</p>
            <h3>数据来源完整性与链路追踪</h3>
          </div>
        </div>
        {lineageEntries.length === 0 ? (
          <div className="command-clear-state">
            <span>—</span>
            <div>
              <strong>暂无世系数据（staging 为空）</strong>
              <p>当前数据源中没有世系审计记录（empty）。</p>
            </div>
          </div>
        ) : (
          <>
            <div className="lineage-state-grid">
              {LINEAGE_STATE_ORDER.map((state) => {
                const display = lineageStateDisplay(state);
                const count = lineageStateCounts[state] || 0;
                return (
                  <div className={`lineage-state-card lineage-state-${display.tone}`} key={state}>
                    <strong>{display.label}</strong>
                    <span className="lineage-state-count">{count}</span>
                    <small>{state}</small>
                  </div>
                );
              })}
            </div>
            {lineageEntries.length > 0 && (
              <div className="lineage-entry-list">
                {lineageEntries.slice(0, 5).map((entry, index) => {
                  const state = String(entry.lineageState || entry.lineage_state || entry.state || '').toUpperCase();
                  const display = lineageStateDisplay(state);
                  return (
                    <article className="lineage-entry-row" key={entry.id || index}>
                      <span className={`lineage-entry-badge tone-${display.tone}`}>{display.label}</span>
                      <div>
                        <strong>
                          {entry.sourceLabel || entry.source_label || entry.task_id || `记录 ${index + 1}`}
                        </strong>
                        <p>{entry.summary || entry.note || '暂无摘要'}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {lineageEntries.length > 5 && (
              <p className="notice">还有 {lineageEntries.length - 5} 条世系记录。</p>
            )}
          </>
        )}
      </section>

      {/* ---- 出处 ---- */}
      <section className="command-section" aria-label="数据出处">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">出处</p>
            <h3>数据来源与阶段</h3>
          </div>
        </div>
        <div className="preview-boundary-detail">
          <div className="boundary-row">
            <span>数据来源</span>
            <strong>{isLive ? 'Supabase api schema（实时）' : '验收演示项目（本地）'}</strong>
          </div>
          <div className="boundary-row">
            <span>当前阶段</span>
            <strong>{isLive ? 'Staging 只读预览' : '验收演示 — 完整链展示'}</strong>
          </div>
          <div className="boundary-row">
            <span>下一步操作</span>
            <strong>前往研究工作台查看证据与分析</strong>
          </div>
        </div>
      </section>

      {/* ---- 安全边界 ---- */}
      <section className="command-section preview-boundary-section" aria-label="预览安全边界">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">安全边界</p>
            <h3>本页仅执行只读 SELECT</h3>
          </div>
        </div>
        <div className="preview-boundary-detail">
          <div className="boundary-row">
            <span>数据源</span>
            <strong>api schema · 公开 anon key{isDemo ? ' · 验收演示项目（本地）' : ''}</strong>
          </div>
          <div className="boundary-row">
            <span>已读取视图</span>
            <strong>{runtime.views.length} 个 staging 视图</strong>
          </div>
          <div className="boundary-row">
            <span>写操作</span>
            <strong>无（不执行 insert / update / delete / upsert / rpc）</strong>
          </div>
          <div className="boundary-row">
            <span>生成 / 路由 / 发布</span>
            <strong>未执行</strong>
          </div>
          <div className="boundary-row">
            <span>服务角色密钥</span>
            <strong>未使用</strong>
          </div>
        </div>
      </section>

      {/* ---- 底栏 ---- */}
      <footer className="preview-footer">
        <p>P18 完整智能内容链 · {isDemo ? '验收演示项目' : '线上 staging 集成预览'} · 仅 SELECT 只读</p>
        <p className="preview-footer-fine">
          四项执行标志均为 false · 不采集、不生成、不路由、不发布
        </p>
      </footer>
    </section>
  );
}
