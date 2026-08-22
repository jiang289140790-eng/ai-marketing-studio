import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/auth-context';
import { EmptyState } from '../components/EmptyState';
import {
  STAGING_VIEWS,
  getStagingRuntimeStatus,
  fetchKnowledgeEngineData,
} from '../services/staging-preview-service';
import { loadIntegratedWorkspace } from '../services/integrated-workspace-service.js';
import { KnowledgeCard, BriefPanel, HandoffPanel, LineagePanel, WorkspaceSourceBanner } from '../components/integrated-workspace';

// ---- 知识引擎四个视图的标签与描述 ---------------------------------------------
const KE_TABS = [
  {
    id: 'knowledgeCards',
    viewName: STAGING_VIEWS.KNOWLEDGE_CARDS,
    label: '知识卡',
    description: '带引用的已验证知识条目 — api.ke_knowledge_cards_v1',
  },
  {
    id: 'contentBriefs',
    viewName: STAGING_VIEWS.CONTENT_BRIEFS,
    label: '内容 Brief',
    description: '约束、执行标志与人工审核边界 — api.ke_content_briefs_v1',
  },
  {
    id: 'handoffManifest',
    viewName: STAGING_VIEWS.HANDOFF_MANIFEST,
    label: '交接清单',
    description: '跨项目交接包的清单与状态 — api.ke_handoff_manifest_v1',
  },
  {
    id: 'handoffPackageDetail',
    viewName: STAGING_VIEWS.HANDOFF_PACKAGE_DETAIL,
    label: '交接包详情',
    description: '交接包内容明细与校验信息 — api.ke_handoff_package_detail_v1',
  },
];

// ---- 字段标签映射（通用回退）--------------------------------------------------
function fieldLabel(key) {
  const labels = {
    title: '标题',
    summary: '摘要',
    description: '描述',
    status: '状态',
    category: '类别',
    confidence: '置信度',
    source: '来源',
    created_at: '创建时间',
    updated_at: '更新时间',
    task_id: '任务 ID',
    package_id: '包 ID',
    handoff_id: '交接 ID',
    evidence_count: '证据数',
    constraint_count: '约束数',
    generation_executed: '生成',
    routing_executed: '路由',
    network_executed: '网络',
    publish_executed: '发布',
  };
  return labels[key] || key;
}

function formatCell(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value).slice(0, 200);
    } catch {
      return '[不可序列化]';
    }
  }
  const s = String(value);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

// ---- 主组件 -----------------------------------------------------------------
export function KnowledgeVaultPage({ userId, onNavigate }) {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const runtime = useMemo(() => getStagingRuntimeStatus(), []);
  const signedIn = Boolean(userId) && isAuthenticated;

  const [keData, setKeData] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [activeTab, setActiveTab] = useState('knowledgeCards');
  // P18：集成演示工作区后备
  const [integratedWorkspace, setIntegratedWorkspace] = useState(null);
  const [iwTab, setIwTab] = useState('knowledgeCards');

  useEffect(() => {
    if (!runtime.configured || !signedIn) {
      setKeData(null);
      return undefined;
    }
    let cancelled = false;
    setFetching(true);
    fetchKnowledgeEngineData({ userId })
      .then((next) => {
        if (!cancelled) setKeData(next);
      })
      .catch(() => {
        if (!cancelled)
          setKeData({ status: 'read_error', error: { message: '读取知识引擎数据失败。' } });
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => { cancelled = true; };
  }, [runtime.configured, signedIn, userId]);

  // P18：当未配置或 staging 为空/不可用时，加载集成验收演示工作区
  useEffect(() => {
    if (runtime.configured && signedIn) {
      return undefined; // staging 优先
    }
    let cancelled = false;
    loadIntegratedWorkspace({ userId: null })
      .then((ws) => {
        if (!cancelled && ws && ws.demoOnly) {
          setIntegratedWorkspace(ws);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [runtime.configured, signedIn, userId]);

  // ---- 状态渲染 --------------------------------------------------------------
  if (!runtime.configured) {
    // P18：未配置时展示验收演示项目
    if (integratedWorkspace && integratedWorkspace.demoOnly) {
      return renderDemoKnowledgeWorkspace();
    }
    return (
      <section className="page-stack">
        <EmptyState
          title="等待数据服务配置"
          description="配置 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY 后，本页会显示知识引擎四个 staging api 视图的只读数据。"
        />
      </section>
    );
  }

  if (authLoading) {
    return (
      <section className="page-stack">
        <div className="notice">正在恢复登录状态...</div>
      </section>
    );
  }

  if (!signedIn) {
    // P18：未登录时展示验收演示项目
    if (integratedWorkspace && integratedWorkspace.demoOnly) {
      return renderDemoKnowledgeWorkspace();
    }
    return (
      <section className="page-stack knowledge-engine-page staging-preview">
        <div className="hero-panel command-hero command-hero-simple">
          <p className="eyebrow">知识引擎 · 线上只读预览</p>
          <h2>四类知识证据，一条可追溯链路</h2>
          <p>你可以先查看数据结构；登录后才读取属于你的 staging 记录。所有数据均为只读，不执行任何写入、合并或删除动作。</p>
        </div>
        <div className="knowledge-summary-grid">
          {KE_TABS.map((tab) => (
            <article className="knowledge-summary-card" key={tab.id}>
              <span className="status-badge not_connected">登录后读取</span>
              <h3>{tab.label}</h3>
              <p>{tab.description}</p>
            </article>
          ))}
        </div>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('research')}>
            查看研究工作台
          </button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('dashboard')}>
            返回指挥中心
          </button>
        </div>
        <div className="notice">当前未登录：请先登录后读取属于你的 staging 知识记录。</div>
      </section>
    );
  }

  // P18：渲染验收演示知识工作区
  function renderDemoKnowledgeWorkspace() {
    const iw = integratedWorkspace;
    const iwKc = iw?.knowledgeCards || [];
    const iwBrief = iw?.brief || null;
    const iwHandoff = iw?.handoff || null;
    const iwLineage = iw?.lineage || { entries: [], stateCounts: {} };
    const iwDemoTabs = [
      { id: 'knowledgeCards', label: '知识卡', count: iwKc.length },
      { id: 'contentBriefs', label: '可审核 Brief', count: iwBrief ? 1 : 0 },
      { id: 'handoffManifest', label: 'P5 交接包', count: iwHandoff ? 1 : 0 },
      { id: 'handoffPackageDetail', label: 'P16 世系', count: iwLineage.entries.length },
    ];

    return (
      <section className="page-stack knowledge-engine-page staging-preview">
        <WorkspaceSourceBanner workspace={iw} />

        <div className="section-head">
          <div>
            <p className="eyebrow">知识引擎 · 验收演示项目</p>
            <h2>知识卡、Brief、交接包与世系审计</h2>
            <p>验收演示项目：以下全部内容为固定的本地演示数据，不代表任何真实读取或执行。</p>
          </div>
          <div className="button-row">
            <button className="ghost-button" type="button" onClick={() => onNavigate('research')}>
              研究工作台
            </button>
            <button className="ghost-button" type="button" onClick={() => onNavigate('dashboard')}>
              指挥中心
            </button>
          </div>
        </div>

        {/* 视图标签 */}
        <div className="capability-tabs" role="tablist" aria-label="知识引擎演示视图">
          {iwDemoTabs.map((tab) => (
            <button
              className={iwTab === tab.id ? 'active' : ''}
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={iwTab === tab.id}
              onClick={() => setIwTab(tab.id)}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>

        {/* 知识卡视图 */}
        {iwTab === 'knowledgeCards' && (
          <section className="ke-view-section" aria-label="知识卡" role="tabpanel">
            <div className="ke-view-head">
              <p className="eyebrow">知识卡</p>
              <p className="ke-view-desc">带引用的已验证知识条目 — 验收演示项目</p>
            </div>
            {iwKc.length === 0 ? (
              <div className="command-clear-state">
                <span>—</span>
                <div><strong>当前没有知识卡记录</strong></div>
              </div>
            ) : (
              <div className="iw-knowledge-grid-demo">
                {iwKc.map((item) => (
                  <KnowledgeCard key={item.id} item={item} />
                ))}
              </div>
            )}
          </section>
        )}

        {/* Brief 视图 */}
        {iwTab === 'contentBriefs' && (
          <section className="ke-view-section" aria-label="可审核 Brief" role="tabpanel">
            <div className="ke-view-head">
              <p className="eyebrow">可审核 Brief</p>
              <p className="ke-view-desc">约束、执行标志与人工审核边界 — 验收演示项目</p>
            </div>
            <BriefPanel brief={iwBrief} executionFlags={iw?.executionFlags} />
          </section>
        )}

        {/* 交接包视图 */}
        {iwTab === 'handoffManifest' && (
          <section className="ke-view-section" aria-label="P5 交接包" role="tabpanel">
            <div className="ke-view-head">
              <p className="eyebrow">P5 交接包</p>
              <p className="ke-view-desc">交接清单、内容计划与执行边界 — 验收演示项目</p>
            </div>
            <HandoffPanel handoff={iwHandoff} executionFlags={iw?.executionFlags} />
          </section>
        )}

        {/* 世系视图 */}
        {iwTab === 'handoffPackageDetail' && (
          <section className="ke-view-section" aria-label="P16 世系" role="tabpanel">
            <div className="ke-view-head">
              <p className="eyebrow">P16 世系审计</p>
              <p className="ke-view-desc">数据来源完整性与链路追踪 — 验收演示项目</p>
            </div>
            <LineagePanel lineage={iwLineage} />
          </section>
        )}

        {/* 安全边界 */}
        <section className="command-section preview-boundary-section" aria-label="预览安全边界">
          <div className="section-head compact-head">
            <div>
              <p className="eyebrow">安全边界</p>
              <h3>验收演示项目 — 纯本地数据</h3>
            </div>
          </div>
          <div className="preview-boundary-detail">
            <div className="boundary-row">
              <span>数据源</span>
              <strong>验收演示项目（本地）</strong>
            </div>
            <div className="boundary-row">
              <span>写操作 / 网络请求</span>
              <strong>未执行</strong>
            </div>
          </div>
        </section>

        <footer className="preview-footer">
          <p>P18 完整智能内容链 · 验收演示项目</p>
          <p className="preview-footer-fine">四项执行标志均为 false · 不采集、不生成、不路由、不发布</p>
        </footer>
      </section>
    );
  }

  if (fetching && !keData) {
    return (
      <section className="page-stack">
        <div className="notice">正在通过 staging 服务端只读边界读取知识数据...</div>
      </section>
    );
  }

  const keStatus = keData?.status || 'loading';
  const byView = keData?.byView || {};

  const currentTab = KE_TABS.find((tab) => tab.id === activeTab) || KE_TABS[0];
  const currentView = byView[currentTab.viewName];
  const currentRows = currentView?.data || [];
  const currentViewStatus = currentView?.status || 'loading';
  const currentViewError = currentView?.error || '';

  return (
    <section className="page-stack knowledge-engine-page staging-preview">
      {/* ---- 页头 ---- */}
      <div className="section-head">
        <div>
          <p className="eyebrow">知识引擎 · 线上只读预览</p>
          <h2>当前账号的只读知识数据</h2>
          <p>
            本页通过已认证的服务端只读命令读取当前账号的知识卡、Brief 与交接包；浏览器不访问私有 schema，也不写入、不合并、不删除记录。
          </p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate('research')}>
            研究工作台
          </button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('dashboard')}>
            指挥中心
          </button>
        </div>
      </div>

      {/* ---- 整体状态 ---- */}
      {keStatus === 'read_error' && (
        <div className="notice error">
          知识数据读取失败：{keData?.error?.message || '无法连接到 staging 只读服务。'}
        </div>
      )}
      {keStatus === 'access_denied' && (
        <div className="notice error">
          知识数据访问被拒绝：请确认当前账号仍在 staging 访问名单中并重新登录。
        </div>
      )}
      {keStatus === 'empty' && (
        <div className="notice">
          当前账号还没有知识卡、Brief 或交接包。在研究流程形成产物后会自动出现。
        </div>
      )}

      {/* ---- 视图概览摘要 ---- */}
      {(keStatus === 'live' || keStatus === 'partial') && (
        <div className="stat-grid compact">
          {KE_TABS.map((tab) => {
            const view = byView[tab.viewName];
            const count = view?.data?.length || 0;
            const viewOk = view?.status === 'live';
            return (
              <button
                className={`stat-card-clickable ${activeTab === tab.id ? 'active' : ''}`}
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
              >
                <StatCard
                  label={tab.label}
                  value={viewOk ? count : '—'}
                  hint={viewOk ? undefined : view?.error || '未连接'}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* ---- 标签导航 ---- */}
      {(keStatus === 'live' || keStatus === 'empty') && (
        <div className="capability-tabs" role="tablist" aria-label="知识引擎视图">
          {KE_TABS.map((tab) => {
            const view = byView[tab.viewName];
            const count = view?.data?.length || 0;
            return (
              <button
                className={activeTab === tab.id ? 'active' : ''}
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* ---- 当前视图内容 ---- */}
      {(keStatus === 'live' || keStatus === 'empty') && (
        <section className="ke-view-section" aria-label={currentTab.label} role="tabpanel">
          <div className="ke-view-head">
            <p className="eyebrow">{currentTab.label}</p>
            <p className="ke-view-desc">{currentTab.description}</p>
          </div>

          {currentViewStatus === 'read_error' && (
            <div className="notice error">读取 {currentTab.label} 失败：{currentViewError}</div>
          )}
          {currentViewStatus === 'access_denied' && (
            <div className="notice error">无权访问 {currentTab.label} 视图。</div>
          )}
          {currentRows.length === 0 && currentViewStatus === 'live' && (
            <div className="command-clear-state">
              <span>—</span>
              <div>
                <strong>当前没有{currentTab.label}记录</strong>
                <p>该视图已连接并可访问，但尚无数据。</p>
              </div>
            </div>
          )}

          {currentRows.length > 0 && (
            <>
              <p className="ke-view-count">
                共 {currentRows.length} 条记录（服务端只读，未写入或修改）
              </p>
              <div className="ke-data-grid">
                {currentRows.map((row, index) => (
                  <article className="ke-data-card" key={row.id || index}>
                    <dl className="business-detail-list ke-detail-list">
                      {Object.entries(row).map(([key, value]) => (
                        <div key={key}>
                          <dt>{fieldLabel(key)}</dt>
                          <dd>{formatCell(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      )}

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
            <strong>api schema · 公开 anon key</strong>
          </div>
          <div className="boundary-row">
            <span>已读取视图</span>
            <strong>ke_knowledge_cards_v1 · ke_content_briefs_v1 · ke_handoff_manifest_v1 · ke_handoff_package_detail_v1</strong>
          </div>
          <div className="boundary-row">
            <span>写操作 / 合并 / 删除</span>
            <strong>未执行</strong>
          </div>
        </div>
      </section>

      <footer className="preview-footer">
        <p>P17-C 线上 staging 集成预览 · 仅 SELECT 只读</p>
        <p className="preview-footer-fine">知识引擎四个视图均为只读 · 不写入、不修改、不删除</p>
      </footer>
    </section>
  );
}
