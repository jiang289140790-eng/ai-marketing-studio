import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/auth-context';
import {
  RESEARCH_EXECUTION_FLAGS,
  buildDevFallbackView,
  buildReadErrorView,
  fetchResearchWorkspaceData,
  getResearchRuntimeStatus,
} from '../services/research-workspace-service';
import './ResearchWorkspacePage.css';

const CHAIN_STEPS = [
  ['1', '主题与目标', '一个明确的研究主题与目标'],
  ['2', '证据采集', '公开样本来源、采集状态与溯源'],
  ['3', '多模态分析', '钩子、格式、视觉/叙事结构、受众洞察'],
  ['4', '知识卡', '带引用的已验证知识条目'],
  ['5', '可审核 Brief', '约束、执行标志与人工审核边界'],
];

const FLAG_LABELS = [
  ['generation_executed', '生成'],
  ['routing_executed', '路由'],
  ['network_executed', '网络'],
  ['publish_executed', '发布'],
];

// 实时后端可读字段与后端尚不存在（不可臆造）的字段。缺失字段如实标注“当前后端数据不可用”。
const ANALYSIS_FIELDS_LIVE = [
  { key: 'hook', label: '开场钩子', real: true },
  { key: 'format', label: '内容格式', real: false },
  { key: 'visualStory', label: '视觉/叙事结构', real: false },
  { key: 'structure', label: '整体结构', real: true },
  { key: 'audienceInsight', label: '受众洞察', real: false },
  { key: 'strategy', label: '复刻策略', real: true },
  { key: 'analysis', label: '完整分析', real: true },
];

// 开发用本地示例沿用 V1 的字段集合。
const ANALYSIS_FIELDS_DEV = [
  { key: 'hook', label: '开场钩子' },
  { key: 'format', label: '内容格式' },
  { key: 'visualStory', label: '视觉/叙事结构' },
  { key: 'structure', label: '整体结构' },
  { key: 'audienceInsight', label: '受众洞察' },
];

const MODE_INFO = {
  live: { label: '实时只读', tone: 'live' },
  loading: { label: '加载中', tone: 'loading' },
  not_configured: { label: '未配置', tone: 'off' },
  not_signed_in: { label: '未登录', tone: 'off' },
  read_error: { label: '读取失败', tone: 'error' },
  empty: { label: '空库', tone: 'empty' },
  dev_fallback: { label: '开发用示例', tone: 'preview' },
};

const NOT_AVAILABLE_LABEL = '当前后端数据不可用';

function StatusPill({ label, tone }) {
  return <span className={`research-pill research-pill-${tone}`}>{label}</span>;
}

function formatCount(value) {
  return Number(value ?? 0).toLocaleString();
}

export function ResearchWorkspacePage({ detailId, onNavigate }) {
  const { isAuthenticated, loading: authLoading, userId } = useAuth();
  const runtime = useMemo(() => getResearchRuntimeStatus(), []);
  const configured = runtime.configured;
  const signedIn = Boolean(userId) && isAuthenticated;

  // 开发用本地示例默认关闭：仅在未配置实时后端时由用户显式开启。
  const [devFallbackOn, setDevFallbackOn] = useState(false);
  const [view, setView] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(detailId || null);

  const devFallbackView = useMemo(() => buildDevFallbackView(), []);

  useEffect(() => {
    if (!configured || !signedIn) {
      setView(null);
      setFetching(false);
      return undefined;
    }
    let cancelled = false;
    setFetching(true);
    fetchResearchWorkspaceData({ userId })
      .then((nextView) => {
        if (!cancelled) setView(nextView);
      })
      .catch((error) => {
        if (!cancelled) setView(buildReadErrorView(error && error.message));
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [configured, signedIn, userId, refreshKey]);

  const activeView = !configured && devFallbackOn ? devFallbackView : view;

  const mode = useMemo(() => {
    if (!configured) return devFallbackOn ? 'dev_fallback' : 'not_configured';
    if (authLoading) return 'loading';
    if (!signedIn) return 'not_signed_in';
    if (!activeView || (fetching && !view)) return 'loading';
    if (activeView.status === 'read_error') return 'read_error';
    if (activeView.status === 'empty') return 'empty';
    return 'live';
  }, [activeView, authLoading, configured, devFallbackOn, fetching, signedIn, view]);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  const selectedEvidence = useMemo(() => {
    const items = activeView?.evidence || [];
    return items.find((item) => item.id === selectedEvidenceId) || items[0] || null;
  }, [activeView, selectedEvidenceId]);

  const flagRows = useMemo(() => {
    const flags = (activeView && activeView.executionFlags) || RESEARCH_EXECUTION_FLAGS;
    return FLAG_LABELS.map(([key, label]) => ({ label, value: flags[key] }));
  }, [activeView]);

  const modeInfo = MODE_INFO[mode];
  const isDev = mode === 'dev_fallback';
  const analysisFields = isDev ? ANALYSIS_FIELDS_DEV : ANALYSIS_FIELDS_LIVE;
  const modeNote = isDev
    ? '以下全部内容为固定的本地示例数据，不代表任何真实读取或执行。'
    : '本页仅执行 SELECT 只读请求：不采集、不分析调用、不生成、不路由、不发布。';

  const heroText =
    mode === 'not_configured'
      ? null
      : isDev
        ? {
            title: '研究工作台（开发用本地示例）',
            objective: '固定本地示例数据，仅用于未配置实时后端时的界面预览。',
          }
        : {
            title: '研究工作台 · 实时只读数据',
            objective:
              '基于真实后端记录查看 证据 → 分析 → 知识 → 可审核 Brief 的生产链；后端尚不存在的关联与字段会明确标注“当前后端数据不可用”。',
          };

  return (
    <section className="research-workspace">
      <div className="research-status-bar">
        <div className="research-status-left">
          <StatusPill label={modeInfo.label} tone={modeInfo.tone} />
          <span className="research-status-version">ams-research-workspace-v2-live</span>
        </div>
        <div className="research-status-mid">
          <strong>执行状态：</strong>
          {flagRows.map((row) => (
            <span className="research-flag" key={row.label}>
              {row.label} <b>{row.value ? '已执行' : '未执行'}</b>
            </span>
          ))}
          <span className="research-flag-all">四项标志均为 false</span>
        </div>
        <div className="research-status-right">
          <span>
            数据源：{configured ? '已配置' : '未配置'} · 登录：{signedIn ? '已登录' : '未登录'}
          </span>
          {configured && signedIn && (
            <button
              className="research-button research-refresh-button"
              type="button"
              disabled={fetching}
              onClick={refresh}
            >
              {fetching ? '刷新中...' : '刷新只读数据'}
            </button>
          )}
        </div>
      </div>

      {mode === 'not_configured' ? (
        <div className="research-setup-panel">
          <p className="research-eyebrow">实时后端未配置</p>
          <p>
            本页需要应用运行时的公开浏览器配置（VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY）才能读取真实数据；
            配置后刷新页面即可看到 证据 → 分析 → 知识 → Brief 的实时只读状态。
          </p>
          <p>本页默认不展示任何示例数据。也可以显式开启开发用本地示例来预览界面布局：</p>
          <button
            className="research-button"
            type="button"
            onClick={() => setDevFallbackOn(true)}
          >
            开启开发用本地示例（默认关闭）
          </button>
        </div>
      ) : (
        <header className="research-hero">
          <p className="research-eyebrow">研究工作台</p>
          <h2>{heroText.title}</h2>
          <p className="research-objective">
            <strong>目标：</strong>{heroText.objective}
          </p>
          <p className="research-boundary">{modeNote}</p>
          <div className="research-chain" aria-label="研究产品链">
            {CHAIN_STEPS.map(([num, label, hint], index) => (
              <span className="research-chain-step" key={label}>
                <i>{num}</i>
                <b>{label}</b>
                <small>{hint}</small>
                {index < CHAIN_STEPS.length - 1 && <em>→</em>}
              </span>
            ))}
          </div>
        </header>
      )}

      {mode === 'loading' && (
        <div className="research-panel-note">
          正在从实时后端读取只读数据（SELECT）...
        </div>
      )}

      {mode === 'not_signed_in' && (
        <div className="research-setup-panel">
          <p className="research-eyebrow">已配置实时后端 · 未登录</p>
          <p>
            当前没有已恢复的登录会话。请先在应用内完成登录后再回到本页查看实时只读数据；
            本页本身不执行任何登录动作。
          </p>
        </div>
      )}

      {mode === 'read_error' && (
        <div className="research-setup-panel research-error-panel">
          <p className="research-eyebrow">实时读取失败</p>
          <p>{activeView.error && activeView.error.message}</p>
          <p className="research-empty-note">
            本页不会用示例数据替换失败的实时请求。请检查运行时配置与后端访问权限后重试。
          </p>
          <button className="research-button" type="button" onClick={refresh}>
            重试读取只读数据
          </button>
        </div>
      )}

      {mode === 'empty' && (
        <div className="research-setup-panel">
          <p className="research-eyebrow">实时后端为空</p>
          <p>{activeView.note}</p>
          <button className="research-button" type="button" onClick={refresh}>
            重新刷新只读数据
          </button>
        </div>
      )}

      {isDev && (
        <div className="research-dev-banner">
          开发用本地示例数据（非实时后端数据）· 实时请求失败不会回退到本视图
        </div>
      )}

      {(mode === 'live' || isDev) && (
        <>
          <section className="research-lane" aria-label="来源证据">
            <div className="research-lane-head">
              <div>
                <p className="research-eyebrow">来源证据</p>
                <h3>采集状态与溯源</h3>
              </div>
              <span>
                {activeView.counts.evidence} 个来源{isDev ? '（本地示例）' : '（实时后端）'}
              </span>
            </div>
            {activeView.sources.length > 0 && (
              <p className="research-lane-note">
                来源账号：{activeView.sources.map((source) => `${source.name}（${source.platform}${source.followers != null ? ` · ${formatCount(source.followers)} 粉丝` : ''}）`).join('、')}
              </p>
            )}
            {activeView.evidence.length === 0 ? (
              <p className="research-empty-note">没有可展示的来源证据记录。</p>
            ) : (
              <div className="research-evidence-grid">
                {activeView.evidence.map((item) => {
                  const isSelected = item.id === selectedEvidenceId;
                  return (
                    <button
                      className={`research-evidence-card ${isSelected ? 'selected' : ''}`}
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedEvidenceId(item.id)}
                      aria-pressed={isSelected}
                    >
                      <div className="research-card-top">
                        <strong>{item.name}</strong>
                        {item.captureStatusLabel ? (
                          <StatusPill
                            label={item.captureStatusLabel}
                            tone={item.captureStatus === 'collected_local_preview' ? 'collected' : 'pending'}
                          />
                        ) : (
                          <StatusPill label="实时记录" tone="live" />
                        )}
                      </div>
                      <div className="research-card-meta">
                        <span>
                          {item.platform}
                          {item.account && item.account.username ? ` · ${item.account.username}` : ''}
                          {item.category ? ` · ${item.category}` : ''}
                        </span>
                        {item.capturedAt && <span>{item.capturedAt}</span>}
                        {item.publishedAt && <span>发布于 {item.publishedAt}</span>}
                      </div>
                      {item.snippet && <p className="research-snippet">{item.snippet}</p>}
                      {item.engagement ? (
                        <p className="research-engagement">{item.engagement}</p>
                      ) : item.views != null ? (
                        <p className="research-engagement">
                          Views {formatCount(item.views)} · Likes {formatCount(item.likes)} · Comments {formatCount(item.comments)}
                        </p>
                      ) : null}
                      <p className="research-provenance">{item.provenance}</p>
                      {item.displayOnlyUrl && (
                        <p className="research-display-url">来源链接：{item.displayOnlyUrl}</p>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="research-lane-note">
              点击任一来源可查看其关联的分析、知识卡与 Brief 引用（仅内存交互，不修改数据）。
            </p>
          </section>

          <section className="research-lane" aria-label="多模态分析">
            <div className="research-lane-head">
              <div>
                <p className="research-eyebrow">多模态分析</p>
                <h3>钩子、格式、结构与受众洞察</h3>
              </div>
              <span>
                {activeView.counts.analyses} 条分析{isDev ? '（本地示例）' : '（实时后端）'}
              </span>
            </div>
            {activeView.analyses.length === 0 ? (
              <p className="research-empty-note">
                {isDev ? '（本地示例）' : '当前后端数据不可用：'}没有可展示的分析记录。
              </p>
            ) : (
              <div className="research-analysis-grid">
                {activeView.analyses.map((analysis) => {
                  const isLinked = analysis.evidenceId === selectedEvidence?.id;
                  return (
                    <article
                      className={`research-analysis-card ${isLinked ? 'linked' : ''}`}
                      key={analysis.id}
                      aria-current={isLinked ? 'true' : undefined}
                    >
                      <div className="research-card-top">
                        <strong>{analysis.title || '实时后端分析记录'}</strong>
                        <StatusPill
                          label={analysis.statusLabel || (isLinked ? '已分析' : '未关联')}
                          tone={isLinked ? 'analysed' : 'pending'}
                        />
                      </div>
                      <p className="research-card-meta">
                        关联来源：{analysis.evidenceId}
                        {analysis.modelLabel ? `（${analysis.modelLabel}）` : '（实时后端记录）'}
                      </p>
                      <dl className="research-analysis-fields">
                        {analysisFields.map((field) => {
                          const available = isDev || field.real;
                          const value = available ? analysis[field.key] : null;
                          return (
                            <div key={field.key}>
                              <dt>{field.label}</dt>
                              <dd>{value && value.length > 0 ? value : NOT_AVAILABLE_LABEL}</dd>
                            </div>
                          );
                        })}
                      </dl>
                      <p className="research-provenance">
                        {analysis.analysisNote || '字段来自实时后端表 content_analysis（仅 SELECT）。'}
                      </p>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="research-lane" aria-label="知识卡">
            <div className="research-lane-head">
              <div>
                <p className="research-eyebrow">知识卡</p>
                <h3>带引用的已验证知识条目</h3>
              </div>
              <span>
                {activeView.counts.knowledge} 张知识卡{isDev ? '（本地示例）' : ''}
              </span>
            </div>
            {activeView.knowledge.available ? (
              <div className="research-knowledge-grid">
                {activeView.knowledge.items.map((knowledge) => {
                  const isLinked = knowledge.citations.some((citation) => citation.evidenceId === selectedEvidence?.id);
                  return (
                    <article
                      className={`research-knowledge-card ${isLinked ? 'linked' : ''}`}
                      key={knowledge.id}
                      aria-current={isLinked ? 'true' : undefined}
                    >
                      <div className="research-card-top">
                        <strong>{knowledge.title}</strong>
                        <StatusPill label={knowledge.statusLabel} tone="preview" />
                      </div>
                      <p>{knowledge.summary}</p>
                      <p className="research-confidence">置信度：{knowledge.confidence}</p>
                      <div className="research-citations">
                        <b>引用证据：</b>
                        {knowledge.citations.map((citation) => (
                          <blockquote key={citation.evidenceId}>
                            <span>{citation.evidenceId}</span>
                            <p>“{citation.quote}”</p>
                          </blockquote>
                        ))}
                      </div>
                      <p className="research-provenance">{knowledge.note}</p>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="research-not-available">
                <b>{NOT_AVAILABLE_LABEL}</b>
                <p>{activeView.knowledge.reason}</p>
              </div>
            )}
          </section>

          <section className="research-lane" aria-label="可审核 Brief">
            <div className="research-lane-head">
              <div>
                <p className="research-eyebrow">可审核 Brief</p>
                <h3>等待人工审核与交接</h3>
              </div>
              {activeView.brief.available && (
                <StatusPill label={activeView.brief.data.humanDecision.statusLabel} tone="pending" />
              )}
            </div>
            {activeView.brief.available ? (
              <div className="research-brief">
                <p className="research-provenance">{activeView.brief.data.briefProvenance}</p>
                <p className="research-human-note">{activeView.brief.data.humanDecision.note}</p>

                <h4>主题与目标</h4>
                <p><strong>{activeView.brief.data.topic}</strong></p>
                <p>{activeView.brief.data.objective}</p>

                <h4>结构建议（来自分析）</h4>
                <ul className="research-brief-list">
                  {activeView.brief.data.structuralGuidance.map((item) => <li key={item}>{item}</li>)}
                </ul>

                <h4>约束</h4>
                <ul className="research-brief-list">
                  {activeView.brief.data.constraints.map((item) => <li key={item}>{item}</li>)}
                </ul>

                <h4>引用知识卡</h4>
                <ul className="research-brief-list">
                  {activeView.brief.data.knowledgeCitations.map((item) => (
                    <li key={item.knowledgeId}><strong>{item.knowledgeId}</strong> · {item.title}</li>
                  ))}
                </ul>

                <h4>证据溯源</h4>
                <p>{activeView.brief.data.evidenceProvenance}</p>
                <p className="research-selected-note">
                  当前选中来源：{selectedEvidence ? selectedEvidence.id : '（无）'}
                </p>

                <h4>执行标志（全部严格 false）</h4>
                <div className="research-flag-grid">
                  {flagRows.map((row) => (
                    <div className={`research-flag-cell ${row.value ? 'on' : ''}`} key={row.label}>
                      <span>{row.label}</span>
                      <b>{row.value ? '已执行' : '未执行'}</b>
                    </div>
                  ))}
                </div>

                <h4>人工反馈</h4>
                <p className="research-empty-note">
                  {activeView.brief.data.manualFeedback.length === 0
                    ? '暂无人工反馈（示例 Brief 尚未进入审核流程）'
                    : activeView.brief.data.manualFeedback.join('；')}
                </p>

                <h4>外部项目边界</h4>
                <p>{activeView.brief.data.externalProjectBoundary}</p>

                <div className="research-handoff">
                  <p className="research-eyebrow">下一交接边界</p>
                  <p>{activeView.brief.data.nextHandoffBoundary}</p>
                  <p className="research-import-only">import_only: {String(activeView.brief.data.importOnly)}</p>
                </div>
              </div>
            ) : (
              <div className="research-not-available">
                <b>{NOT_AVAILABLE_LABEL}</b>
                <p>{activeView.brief.reason}</p>
                <h4>执行标志（全部严格 false）</h4>
                <div className="research-flag-grid">
                  {flagRows.map((row) => (
                    <div className={`research-flag-cell ${row.value ? 'on' : ''}`} key={row.label}>
                      <span>{row.label}</span>
                      <b>{row.value ? '已执行' : '未执行'}</b>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </>
      )}

      <footer className="research-footer">
        {activeView ? (
          <>
            <p>{activeView.provenance.note}</p>
            {activeView.provenance.tablesRead.length > 0 && (
              <p>已读取表：{activeView.provenance.tablesRead.join('、')}（仅 SELECT）</p>
            )}
          </>
        ) : (
          <p>等待实时后端数据...（仅 SELECT 只读请求）</p>
        )}
        <p className="research-footer-fine">
          四项执行标志均为 false · 实时请求失败绝不回退示例数据
        </p>
        <div className="research-actions">
          <span>下一步人工操作（仅跳转，不修改任何数据）：</span>
          <button className="research-button" type="button" onClick={() => onNavigate('intelligence')}>
            前往内容情报查看现有分析
          </button>
          <button className="research-button" type="button" onClick={() => onNavigate('workspace')}>
            前往内容工作台继续生产
          </button>
        </div>
      </footer>
    </section>
  );
}
