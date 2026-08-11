import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/auth-context';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import {
  getStagingRuntimeStatus,
  fetchLineageAuditData,
  fetchAllStagingData,
  lineageStateDisplay,
} from '../services/staging-preview-service';

// ---- 工作流链步骤 -----------------------------------------------------------
const WORKFLOW_STEPS = [
  { step: 1, label: '研究', hint: '发现内容机会与竞品对标', target: 'research' },
  { step: 2, label: '证据', hint: '公开样本来源与溯源', target: 'research' },
  { step: 3, label: '知识卡', hint: '已验证的可复用知识条目', target: 'knowledge' },
  { step: 4, label: '人工审核', hint: 'Brief 与内容审核', target: 'knowledge' },
  { step: 5, label: '世系追溯', hint: '数据来源与完整性追踪', target: 'dashboard' },
];

const LINEAGE_STATE_ORDER = ['COMPLETE', 'PARTIAL', 'BROKEN', 'INVALID_SOURCE'];

// ---- 主组件 -----------------------------------------------------------------
export function CommandCenter({ userId, onNavigate }) {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const runtime = useMemo(() => getStagingRuntimeStatus(), []);
  const signedIn = Boolean(userId) && isAuthenticated;

  const [stagingData, setStagingData] = useState(null);
  const [lineageData, setLineageData] = useState(null);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!runtime.configured || !signedIn) {
      setStagingData(null);
      setLineageData(null);
      return undefined;
    }
    let cancelled = false;
    setFetching(true);
    Promise.all([
      fetchAllStagingData({ userId }),
      fetchLineageAuditData({ userId }),
    ])
      .then(([nextStaging, nextLineage]) => {
        if (!cancelled) {
          setStagingData(nextStaging);
          setLineageData(nextLineage);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStagingData({ status: 'read_error', error: { message: '读取 staging 数据失败。' } });
          setLineageData({ status: 'read_error', error: { message: '读取世系数据失败。' } });
        }
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => { cancelled = true; };
  }, [runtime.configured, signedIn, userId]);

  // ---- 渲染：各状态分支 ------------------------------------------------------
  if (!runtime.configured) {
    return (
      <section className="page-stack">
        <EmptyState
          title="等待数据服务配置"
          description="配置 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY 后，本页会显示研究工作流、知识引擎与世系审计的只读状态。"
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
      <section className="page-stack command-center-v2 staging-preview">
        <div className="hero-panel command-hero command-hero-simple">
          <p className="eyebrow">AI 运营指挥中心 · 线上只读预览</p>
          <h2>从研究证据到可审核 Brief</h2>
          <p>先浏览完整工作流；登录后再读取属于你的 staging 知识数据与世系审计。所有数据均为只读，不执行任何生成、路由或发布动作。</p>
        </div>
        <section className="command-section workflow-chain-section" aria-label="研究工作流">
          <div className="section-head compact-head">
            <div>
              <p className="eyebrow">智能工作流</p>
              <h3>五步完成内容研究与人工审核准备</h3>
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
              先看研究工作台
            </button>
            <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>
              查看知识引擎结构
            </button>
          </div>
        </section>
        <div className="notice">当前未登录：请先登录后查看你的 staging 数据；未登录时不会发起任何只读查询。</div>
      </section>
    );
  }

  if (fetching && !stagingData) {
    return (
      <section className="page-stack">
        <div className="notice">正在从 staging api 读取只读数据（SELECT）...</div>
      </section>
    );
  }

  const stagingStatus = stagingData?.status || 'loading';
  const stagingCounts = stagingData?.counts || {};
  const lineageStatus = lineageData?.status || 'loading';
  const lineageEntries = lineageData?.entries || [];
  const lineageStateCounts = lineageData?.stateCounts || {};

  return (
    <section className="page-stack command-center-v2 staging-preview">
      {/* ---- 工作流链 ---- */}
      <section className="command-section workflow-chain-section" aria-label="研究工作流">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">研究工作流</p>
            <h3>从研究到世系追溯的完整链路</h3>
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
        </div>
      </section>

      {/* ---- 知识引擎摘要 ---- */}
      <section className="command-section knowledge-summary-section" aria-label="知识引擎摘要">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">知识引擎（只读）</p>
            <h3>来自 staging api 的当前数据量</h3>
          </div>
          <StatusBadge
            status={
              stagingStatus === 'live'
                ? 'connected'
                : stagingStatus === 'partial'
                  ? 'limited'
                  : stagingStatus === 'access_denied'
                    ? 'error'
                    : stagingStatus === 'read_error'
                      ? 'error'
                      : stagingStatus === 'empty'
                        ? 'draft'
                        : 'not_connected'
            }
          />
        </div>
        {stagingStatus === 'read_error' ? (
          <div className="command-clear-state">
            <span>!</span>
            <div>
              <strong>知识引擎视图读取失败</strong>
              <p>{stagingData?.error?.message || '无法读取 staging api 视图。请检查后端配置与访问权限。'}</p>
            </div>
          </div>
        ) : stagingStatus === 'access_denied' ? (
          <div className="command-clear-state">
            <span>!</span>
            <div>
              <strong>知识引擎视图访问被拒绝</strong>
              <p>当前凭据无权访问 staging api schema。请联系管理员确认 anon key 的 SELECT 权限。</p>
            </div>
          </div>
        ) : stagingStatus === 'empty' ? (
          <div className="command-clear-state">
            <span>—</span>
            <div>
              <strong>知识引擎视图当前为空</strong>
              <p>staging api 视图已配置并可访问，但尚未包含任何记录。在知识引擎流程产出入库后会自动出现。</p>
            </div>
          </div>
        ) : (
          <dl className="campaign-summary-grid">
            <div><dt>知识卡</dt><dd>{stagingCounts.knowledgeCards || 0} 张</dd></div>
            <div><dt>内容 Brief</dt><dd>{stagingCounts.contentBriefs || 0} 条</dd></div>
            <div><dt>交接清单</dt><dd>{stagingCounts.handoffManifest || 0} 项</dd></div>
            <div><dt>交接包详情</dt><dd>{stagingCounts.handoffPackageDetail || 0} 条</dd></div>
          </dl>
        )}
        {(stagingStatus === 'live' || stagingStatus === 'partial') && (
          <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>
            查看知识引擎全部数据
          </button>
        )}
      </section>

      {/* ---- 世系审计 ---- */}
      <section className="command-section lineage-section" aria-label="世系审计">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">世系审计（只读）</p>
            <h3>数据来源完整性与链路追踪</h3>
          </div>
          <StatusBadge
            status={
              lineageStatus === 'live'
                ? 'connected'
                : lineageStatus === 'read_error'
                  ? 'error'
                  : lineageStatus === 'access_denied'
                    ? 'error'
                    : lineageStatus === 'empty'
                      ? 'draft'
                      : 'not_connected'
            }
          />
        </div>
        {lineageStatus === 'read_error' ? (
          <div className="command-clear-state">
            <span>!</span>
            <div>
              <strong>世系视图读取失败</strong>
              <p>{lineageData?.error?.message || '无法读取 vg_lineage_audit_v1 视图。'}</p>
            </div>
          </div>
        ) : lineageStatus === 'access_denied' ? (
          <div className="command-clear-state">
            <span>!</span>
            <div>
              <strong>世系视图访问被拒绝</strong>
              <p>当前凭据无权访问 api.vg_lineage_audit_v1。</p>
            </div>
          </div>
        ) : lineageStatus === 'empty' ? (
          <div className="command-clear-state">
            <span>—</span>
            <div>
              <strong>世系审计记录为空</strong>
              <p>已配置并可访问，但尚无世系记录。在交接包导入与审核流程运行后会自动填充。</p>
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
                  const state = String(entry.lineage_state || entry.state || '').toUpperCase();
                  const display = lineageStateDisplay(state);
                  return (
                    <article className="lineage-entry-row" key={entry.id || index}>
                      <span className={`lineage-entry-badge tone-${display.tone}`}>{display.label}</span>
                      <div>
                        <strong>{entry.source_label || entry.task_id || `记录 ${index + 1}`}</strong>
                        <p>{entry.summary || entry.note || '暂无摘要'}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {lineageEntries.length > 5 && (
              <p className="notice">还有 {lineageEntries.length - 5} 条世系记录，请前往数据页面查看完整列表。</p>
            )}
          </>
        )}
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
            <strong>api schema · 公开 anon key</strong>
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
        <p>P17-C 线上 staging 集成预览 · 仅 SELECT 只读</p>
        <p className="preview-footer-fine">
          四条执行标志均为 false · 不采集、不生成、不路由、不发布
        </p>
      </footer>
    </section>
  );
}
