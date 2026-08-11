import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/auth-context';
import { EmptyState } from '../components/EmptyState';
import {
  STAGING_VIEWS,
  getStagingRuntimeStatus,
  fetchKnowledgeEngineData,
} from '../services/staging-preview-service';

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

  // ---- 状态渲染 --------------------------------------------------------------
  if (!runtime.configured) {
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

  if (fetching && !keData) {
    return (
      <section className="page-stack">
        <div className="notice">正在从 staging api 读取知识引擎数据（SELECT）...</div>
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
          <h2>来自 staging api 的只读知识数据</h2>
          <p>
            本页仅执行 SELECT 读取 api.ke_* 四个视图；不写入、不合并、不删除、不修改任何知识记录。
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
          知识引擎视图读取失败：{keData?.error?.message || '无法连接到 staging api。'}
        </div>
      )}
      {keStatus === 'access_denied' && (
        <div className="notice error">
          知识引擎视图访问被拒绝：当前凭据无权访问 staging api schema。
        </div>
      )}
      {keStatus === 'empty' && (
        <div className="notice">
          知识引擎四个视图均可访问，但当前没有任何记录。在知识引擎流程产出入库后会自动出现。
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
                共 {currentRows.length} 条记录（仅 SELECT 读取，未写入或修改）
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
