import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { GenerationQuotePanel } from '../components/generation-execution/GenerationQuotePanel';
import { GenerationJobCard } from '../components/generation-execution/GenerationJobCard';
import { GenerationArtifactViewer } from '../components/generation-execution/GenerationArtifactViewer';
import { createP19Store } from '../services/p19-store.js';
import { createP20OnlineStore } from '../services/p20-online-store.js';
import { isSupabaseConfigured } from '../services/supabase-client';
import {
  G1_ASPECT_RATIOS,
  G1_MODES,
  G1_RESOLUTIONS,
  createGenerationClient,
  newGenerationRequestId,
  readGenerationActiveProject,
  readGenerationDemoUser,
} from '../services/generation-execution-service';
import './GenerationTasksPage.css';

const MODE_LABELS = {
  image: '图片（qwen-image-2.0）',
  video_t2v: '视频·文生视频（happyhorse-1.0-t2v）',
  video_i2v: '视频·图生视频（happyhorse-1.0-i2v，需已批准引用素材）',
};

const ACTIVE_STATUSES = new Set(['queued', 'running']);
// 有界轮询间隔：生产默认 4 秒；本地测试经 VITE_G1_POLL_INTERVAL_MS 收紧。
const runtimePollEnv = Number((import.meta.env || {}).VITE_G1_POLL_INTERVAL_MS || 4000);
const POLL_INTERVAL_MS = Number.isFinite(runtimePollEnv) && runtimePollEnv >= 200 ? runtimePollEnv : 4000;

function boundedMessage(error) {
  return String(error?.message || error || '操作失败。').slice(0, 200);
}

/** 作业明细中的有界费用上限（来自不可变报价/批准对象；无则显示 —）。 */
function boundedCostText(job) {
  const raw = job?.quote?.estimated_max_cost_cny ?? job?.approval?.estimated_max_cost_cny ?? null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return '—';
  return `¥${value.toFixed(2)}`;
}

/** Provider 实际结算值；Provider 未返回时必须明确显示未知，禁止用报价上限代替。 */
function boundedActualCostText(artifacts) {
  const values = (Array.isArray(artifacts) ? artifacts : [])
    .map((artifact) => artifact?.cost_cny)
    .filter((raw) => raw !== null && raw !== undefined && raw !== '')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0) return 'Provider 未返回';
  return `¥${values.reduce((total, value) => total + value, 0).toFixed(2)}`;
}

/** 有界终态诊断文本：仅显示代码与首条固定文案，绝不回显 raw 载荷/密钥。 */
function boundedJobDiagnosticsText(job, attempts) {
  const diagnostics = job?.diagnostics && typeof job.diagnostics === 'object' ? job.diagnostics : {};
  const code = String(diagnostics.code || '').slice(0, 80);
  const issues = Array.isArray(diagnostics.issues) ? diagnostics.issues.filter((entry) => typeof entry === 'string') : [];
  const first = issues[0] ? `：${issues[0].slice(0, 240)}` : '';
  let text = code || first ? `${code}${first}` : '';
  const latest = Array.isArray(attempts) && attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const attemptDiagnostics = latest?.diagnostics && typeof latest.diagnostics === 'object' ? latest.diagnostics : {};
  const providerCode = String(attemptDiagnostics.provider_code || '').slice(0, 80);
  const providerMessage = String(attemptDiagnostics.provider_message || '').slice(0, 240);
  if (providerCode) {
    text += (text ? '；' : '') + `${providerCode}${providerMessage ? ` — ${providerMessage}` : ''}`;
  }
  return text.slice(0, 400);
}

export function GenerationTasksPage({
  userId,
  onNavigate,
  detailId,
  routeParams,
}) {
  const activeProjectId = useMemo(() => readGenerationActiveProject(), []);
  const demoUser = useMemo(() => readGenerationDemoUser(), []);
  const resolvedUserId = userId || demoUser;

  const client = useMemo(() => createGenerationClient({ demoUser: resolvedUserId }), [resolvedUserId]);
  const store = useMemo(() => createP19Store(), []);
  const onlineStore = useMemo(() => createP20OnlineStore(), []);

  const [project, setProject] = useState(null);
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectError, setProjectError] = useState('');

  const [mode, setMode] = useState('image');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('');
  const [durationSeconds, setDurationSeconds] = useState('');
  const [resolution, setResolution] = useState('');
  const [referenceAssetId, setReferenceAssetId] = useState('');
  const [referenceAssets, setReferenceAssets] = useState([]);

  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [quoting, setQuoting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [submitMessage, setSubmitMessage] = useState('');

  const [jobs, setJobs] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState(detailId || '');
  const [jobDetail, setJobDetail] = useState(null);
  const [jobDetailError, setJobDetailError] = useState('');
  const [jobsLoading, setJobsLoading] = useState(true);

  const pollRef = useRef(null);
  const hasAutoSelectedRef = useRef(Boolean(detailId));

  const draftHandoff = useMemo(() => {
    const draftId = String(routeParams?.draftId || '').trim();
    if (!draftId) return null;
    return {
      draftId,
      title: String(routeParams?.title || '').trim(),
      visualPlan: String(routeParams?.visualPlan || '').trim(),
      aspectRatio: String(routeParams?.aspectRatio || '').trim(),
    };
  }, [routeParams]);

  useEffect(() => {
    if (!draftHandoff) return;
    setPrompt((current) => current || draftHandoff.visualPlan || draftHandoff.title);
    if (G1_ASPECT_RATIOS.includes(draftHandoff.aspectRatio)) {
      setAspectRatio((current) => current || draftHandoff.aspectRatio);
    }
  }, [draftHandoff]);

  // ---- 项目加载（本地 p19 store / 在线 p20 store；与研究工作台同一套）----
  useEffect(() => {
    let cancelled = false;
    async function loadProject() {
      setProjectLoading(true);
      setProjectError('');
      try {
        if (!activeProjectId) {
          setProject(null);
          return;
        }
        let next = null;
        if (isSupabaseConfigured) {
          next = await onlineStore.getProject(activeProjectId);
        } else {
          const localRead = store.getProject(activeProjectId);
          if (!localRead.ok) throw new Error(localRead.message || localRead.code || 'Local project unavailable.');
          next = localRead.project;
        }
        if (cancelled) return;
        setProject(next);
      } catch (error) {
        if (!cancelled) setProjectError(boundedMessage(error));
      } finally {
        if (!cancelled) setProjectLoading(false);
      }
    }
    loadProject();
    return () => { cancelled = true; };
  }, [activeProjectId, onlineStore, store]);

  // ---- 引用素材（仅 i2v 需要；服务端只返回已批准图片素材）----
  useEffect(() => {
    if (mode !== 'video_i2v') return undefined;
    let cancelled = false;
    client.listReferenceAssets()
      .then((result) => { if (!cancelled) setReferenceAssets(result?.data?.assets || []); })
      .catch(() => { if (!cancelled) setReferenceAssets([]); });
    return () => { cancelled = true; };
  }, [client, mode]);

  // ---- 作业列表 + 有界轮询（终态自动停止；刷新/重登录后自动恢复）----
  const refreshJobs = useCallback(async () => {
    if (!activeProjectId || !resolvedUserId) return;
    try {
      const result = await client.list({ projectId: activeProjectId, limit: 20 });
      setJobs(result?.data?.jobs || []);
    } catch (error) {
      setSubmitMessage(boundedMessage(error));
    } finally {
      setJobsLoading(false);
    }
  }, [activeProjectId, client, resolvedUserId]);

  const refreshSelectedJob = useCallback(async () => {
    if (!selectedJobId) return;
    try {
      const result = await client.status({ jobId: selectedJobId });
      setJobDetail(result?.data || null);
      setJobDetailError('');
    } catch (error) {
      setJobDetailError(boundedMessage(error));
    }
  }, [client, selectedJobId]);

  useEffect(() => { refreshJobs(); }, [refreshJobs]);

  useEffect(() => {
    if (!selectedJobId && jobs.length > 0 && !hasAutoSelectedRef.current) {
      hasAutoSelectedRef.current = true;
      setSelectedJobId(jobs[0].id);
    }
  }, [jobs, selectedJobId]);

  useEffect(() => {
    const hasActive = jobs.some((job) => ACTIVE_STATUSES.has(job.status));
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (hasActive) {
      pollRef.current = window.setInterval(() => { refreshJobs(); refreshSelectedJob(); }, POLL_INTERVAL_MS);
    }
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [jobs, refreshJobs, refreshSelectedJob]);

  useEffect(() => { refreshSelectedJob(); }, [refreshSelectedJob]);

  const brief = useMemo(() => {
    const candidate = project?.brief || null;
    if (!candidate) return null;
    if (!['approved', 'pending_review'].includes(candidate.status)) return null;
    return candidate;
  }, [project]);

  const briefCardIds = useMemo(() => (Array.isArray(brief?.knowledge_citation_ids) ? brief.knowledge_citation_ids : []), [brief]);
  const briefEvidenceIds = useMemo(() => {
    if (Array.isArray(brief?.evidence_provenance?.evidence_ids)) {
      return brief.evidence_provenance.evidence_ids;
    }
    if (!brief || !project) return [];
    const citedCards = new Map((project.knowledge_cards || []).map((card) => [card.id, card]));
    const analyses = new Map((project.analyses || []).map((analysis) => [analysis.id, analysis]));
    return [...new Set(briefCardIds.map((cardId) => {
      const card = citedCards.get(cardId);
      return analyses.get(card?.analysis_id)?.evidence_id || null;
    }).filter(Boolean))];
  }, [brief, briefCardIds, project]);

  const requestPayload = useMemo(() => {
    if (!activeProjectId || !brief) return null;
    return {
      project_id: activeProjectId,
      brief_id: brief.id,
      mode,
      prompt,
      negative_prompt: negativePrompt || undefined,
      aspect_ratio: aspectRatio || undefined,
      duration_seconds: mode.startsWith('video') && durationSeconds ? Number(durationSeconds) : undefined,
      resolution: mode.startsWith('video') && resolution ? resolution : undefined,
      reference_asset_id: mode === 'video_i2v' && referenceAssetId ? referenceAssetId : undefined,
      knowledge_card_ids: briefCardIds,
      evidence_ids: briefEvidenceIds,
    };
  }, [activeProjectId, aspectRatio, brief, briefCardIds, briefEvidenceIds, durationSeconds, mode, negativePrompt, prompt, referenceAssetId, resolution]);

  const requestQuote = useCallback(async () => {
    if (!requestPayload) return;
    setQuoting(true);
    setQuoteError('');
    setQuote(null);
    try {
      const result = await client.quote(requestPayload);
      setQuote(result?.data?.quote || null);
      if (!result?.data?.quote) setQuoteError('报价返回为空。');
    } catch (error) {
      setQuoteError(boundedMessage(error));
    } finally {
      setQuoting(false);
    }
  }, [client, requestPayload]);

  const approveSubmit = useCallback(async () => {
    if (!requestPayload || !quote) return;
    setApproving(true);
    setSubmitMessage('');
    try {
      const approval = {
        quote_id: quote.quote_id,
        quote_fingerprint: quote.quote_fingerprint,
        request_fingerprint: quote.request_sha256,
        estimated_max_cost_cny: quote.estimated_max_cost_cny,
        expires_at: quote.expires_at,
        source: 'browser',
      };
      const result = await client.approveSubmit({
        ...requestPayload,
        ...approval,
        idempotency_key: newGenerationRequestId(),
      });
      const job = result?.data?.job;
      if (!job) throw new Error('提交未返回作业。');
      setSubmitMessage(`作业已创建（${job.id}）；付费生成将在显式批准后执行。`);
      setQuote(null);
      setSelectedJobId(job.id);
      await refreshJobs();
      await refreshSelectedJob();
    } catch (error) {
      setSubmitMessage(boundedMessage(error));
    } finally {
      setApproving(false);
    }
  }, [client, quote, refreshJobs, refreshSelectedJob, requestPayload]);

  const canRequestQuote = Boolean(brief && requestPayload?.prompt?.trim() && resolvedUserId);

  const latestJob = useMemo(
    () => (selectedJobId ? jobs.find((job) => job.id === selectedJobId) : null) || jobs[0] || null,
    [jobs, selectedJobId],
  );
  const flowStage = quote ? 3 : prompt.trim() ? 2 : latestJob ? 4 : 1;
  const simpleMode = mode === 'image' ? 'image' : 'video';

  const drawerDiagnosticsText = jobDetail?.job ? boundedJobDiagnosticsText(jobDetail.job, jobDetail.attempts) : '';
  const drawerCostText = jobDetail?.job ? boundedCostText(jobDetail.job) : '—';
  const drawerActualCostText = boundedActualCostText(jobDetail?.artifacts);
  const drawerDiagnosticsLabel = jobDetail?.job?.status === 'completed' && drawerDiagnosticsText
    ? `历史诊断（已恢复）：${drawerDiagnosticsText}`
    : drawerDiagnosticsText;

  return (
    <section className="page-stack generation-tasks-page g1-page g2-page" data-testid="g2-workspace">
      <div className="section-head">
        <div>
          <p className="eyebrow">G2 · 简洁生成工作台</p>
          <h2>把想法变成图片或视频</h2>
          <p>描述你想要的成品。系统自动关联当前项目资料，先给出报价，只有你确认后才会开始生成。</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => onNavigate?.('research')}>查看研究资料</button>
      </div>

      {projectError && <div className="notice error">{projectError}</div>}
      {submitMessage && <div className={/失败|过期|冲突|无效|拒绝/.test(submitMessage) ? 'notice error' : 'notice'} data-testid="g1-submit-message">{submitMessage}</div>}

      <nav className="g2-flow" aria-label="生成流程" data-testid="g2-flow">
        {[
          ['1', '描述', '说清楚想生成什么'],
          ['2', '报价', '查看模型和费用上限'],
          ['3', '确认', '人工批准付费生成'],
          ['4', '成品', '进度、预览与下载'],
        ].map(([number, title, description], index) => {
          const step = index + 1;
          const state = step < flowStage ? 'done' : step === flowStage ? 'current' : 'pending';
          return (
            <div className={`g2-flow-step ${state}`} data-step={step} data-state={state} key={number}>
              <span>{step < flowStage ? '✓' : number}</span>
              <div><strong>{title}</strong><small>{description}</small></div>
            </div>
          );
        })}
      </nav>

      {draftHandoff && (
        <section className="draft-handoff-panel" aria-label="图片生成准备">
          <p className="eyebrow">图片生成准备</p>
          <h3>草稿已就绪</h3>
          <div className="draft-handoff-grid">
            <div><strong>草稿 ID</strong><p>{draftHandoff.draftId}</p></div>
            <div><strong>标题</strong><p>{draftHandoff.title || '未命名草稿'}</p></div>
            <div><strong>画幅</strong><p>{draftHandoff.aspectRatio || '1:1'}</p></div>
          </div>
          {draftHandoff.visualPlan && <p><strong>视觉方案：</strong>{draftHandoff.visualPlan}</p>}
          <p>这里只准备生成请求；不会自动调用模型、创建作业或产生费用。</p>
        </section>
      )}

      {!activeProjectId ? (
        <EmptyState title="尚未选择研究项目" description="先在研究工作台选择或创建项目并生成待审核/已批准 Brief，再回到这里发起图片或视频生成。" action={<button className="primary-button" type="button" onClick={() => onNavigate?.('research')}>进入研究工作台</button>} />
      ) : projectLoading ? (
        <div className="skeleton skeleton-card" />
      ) : !brief ? (
        <EmptyState title="当前项目没有可选择的 Brief" description="需要一份 pending_review 或 approved 状态的 Brief，并引用至少一张知识卡与证据。" action={<button className="primary-button" type="button" onClick={() => onNavigate?.('research')}>返回研究工作台生成 Brief</button>} />
      ) : (
        <>
          <section className="g1-create-panel" data-testid="g1-create-panel" role="region" aria-label="创建生成作业">
            <div className="g1-panel-head">
              <div>
                <p className="eyebrow">自动关联当前项目</p>
                <h3>创作说明</h3>
              </div>
              <span className={`status-badge ${brief.status === 'approved' ? 'approved' : 'review'}`}>{brief.status === 'approved' ? '已批准' : '待审核'}</span>
            </div>
            <div className="g2-source-summary" data-testid="g2-source-summary">
              <div>
                <small>来源 Brief</small>
                <strong>{brief.topic || '未命名 Brief'} · 第 {brief.version} 版</strong>
              </div>
              <div><small>自动引用</small><strong>{briefCardIds.length} 张知识卡 · {briefEvidenceIds.length} 条证据</strong></div>
              <button className="ghost-button compact" type="button" onClick={() => onNavigate?.('research')}>查看来源</button>
            </div>
            <div className="g2-mode-switch" role="group" aria-label="选择生成类型">
              <button
                type="button"
                className={simpleMode === 'image' ? 'active' : ''}
                aria-pressed={simpleMode === 'image'}
                data-testid="g2-mode-image"
                onClick={() => { setMode('image'); setQuote(null); }}
              >
                <span>▣</span><strong>生成图片</strong><small>海报、社媒图、视觉素材</small>
              </button>
              <button
                type="button"
                className={simpleMode === 'video' ? 'active' : ''}
                aria-pressed={simpleMode === 'video'}
                data-testid="g2-mode-video"
                onClick={() => { setMode(mode === 'video_i2v' ? 'video_i2v' : 'video_t2v'); setQuote(null); }}
              >
                <span>▶</span><strong>生成视频</strong><small>短视频、动态画面、图生视频</small>
              </button>
            </div>
            <label className="g1-field g2-prompt-field">
              <span>你想生成什么？</span>
              <textarea rows={5} value={prompt} maxLength={2000} onChange={(event) => { setPrompt(event.target.value); setQuote(null); }} placeholder={simpleMode === 'image' ? '例如：一张适合小红书发布的夏日新品海报，明亮自然，留出标题区域' : '例如：海边日落的 5 秒电影感短视频，镜头缓慢推进，暖色调'} data-testid="g1-prompt-input" />
              <small>{prompt.length}/2000 · 系统不会仅因输入文字而产生费用</small>
            </label>
            <details className="g2-advanced" data-testid="g2-advanced-settings">
              <summary>更多设置 <span>画幅、负面提示词与视频参数</span></summary>
              <div className="g1-form-grid">
                <label className="g1-field">
                  <span>生成模式</span>
                  <select value={mode} onChange={(event) => { setMode(event.target.value); setQuote(null); }} data-testid="g1-mode-select">
                    {G1_MODES.map((value) => <option value={value} key={value}>{MODE_LABELS[value]}</option>)}
                  </select>
                </label>
                <label className="g1-field">
                  <span>画幅</span>
                  <select value={aspectRatio} onChange={(event) => { setAspectRatio(event.target.value); setQuote(null); }} data-testid="g1-aspect-select">
                    <option value="">{mode === 'image' ? '默认 1:1' : '默认 16:9'}</option>
                    {G1_ASPECT_RATIOS.map((value) => <option value={value} key={value}>{value}</option>)}
                  </select>
                </label>
                <label className="g1-field g1-field-wide">
                  <span>不希望出现的内容（可选）</span>
                  <input type="text" value={negativePrompt} maxLength={500} onChange={(event) => { setNegativePrompt(event.target.value); setQuote(null); }} data-testid="g1-negative-input" />
                </label>
                {mode.startsWith('video') && (
                  <>
                    <label className="g1-field">
                      <span>时长（秒）</span>
                      <select value={durationSeconds} onChange={(event) => { setDurationSeconds(event.target.value); setQuote(null); }} data-testid="g1-duration-select">
                        <option value="">默认 5 秒</option>
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => <option value={value} key={value}>{value} 秒</option>)}
                      </select>
                    </label>
                    <label className="g1-field">
                      <span>分辨率</span>
                      <select value={resolution} onChange={(event) => { setResolution(event.target.value); setQuote(null); }} data-testid="g1-resolution-select">
                        <option value="">默认 720p</option>
                        {G1_RESOLUTIONS.map((value) => <option value={value} key={value}>{value}</option>)}
                      </select>
                    </label>
                  </>
                )}
                {mode === 'video_i2v' && (
                  <label className="g1-field g1-field-wide">
                    <span>已批准引用素材（图生视频必需）</span>
                    <select value={referenceAssetId} onChange={(event) => { setReferenceAssetId(event.target.value); setQuote(null); }} data-testid="g1-reference-select">
                      <option value="">选择引用素材…</option>
                      {referenceAssets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name || asset.id}</option>)}
                    </select>
                    {!referenceAssets.length && <small className="form-hint">素材库中暂无已批准图片；选择文生视频，或先批准一张引用图片。</small>}
                  </label>
                )}
              </div>
            </details>
            <div className="button-row">
              <button className="primary-button" type="button" disabled={!canRequestQuote || quoting} onClick={requestQuote} data-testid="g1-request-quote">
                {quoting ? '正在计算报价…' : '下一步：查看报价'}
              </button>
              <span className="form-hint">查看报价不会调用生成模型，也不会产生费用。</span>
            </div>
            {quoteError && <div className="notice error">{quoteError}</div>}
          </section>

          {quote && (
            <GenerationQuotePanel
              quote={quote}
              busy={approving}
              onApprove={approveSubmit}
              onDiscard={() => setQuote(null)}
            />
          )}
        </>
      )}

      <section className="g2-results-section" data-testid="g2-results-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">进度与成品</p>
            <h3>生成记录</h3>
            <p>重新打开页面后，系统会恢复最近作业、成品和版本历史。</p>
          </div>
        </div>
        <div className="g2-results-layout">
          <div className="g1-jobs-section">
            {jobsLoading ? <div className="skeleton skeleton-card" /> : jobs.length === 0 ? (
              <EmptyState title="还没有生成记录" description="填写创作说明并确认报价后，进度会显示在这里。" />
            ) : (
              <div className="generation-task-list">
                {jobs.map((job) => (
                  <GenerationJobCard key={job.id} job={job} selected={selectedJobId === job.id} onSelect={setSelectedJobId} />
                ))}
              </div>
            )}
          </div>

          <div className="g2-result-detail">
            {jobDetailError && <div className="notice error">{jobDetailError}</div>}
            {!selectedJobId && !jobsLoading && jobs.length > 0 && <p className="form-hint">选择一条生成记录查看成品。</p>}
            {selectedJobId && jobDetail?.job && (
              <aside className="detail-drawer generation-task-drawer g1-job-drawer" data-testid="g1-job-drawer">
          <div className="detail-drawer-header">
            <div>
              <p className="eyebrow">当前结果</p>
              <h3>{jobDetail.job.status === 'completed' ? '成品已就绪' : jobDetail.job.model_name || '生成进行中'}</h3>
              <p>{jobDetail.job.id} · {jobDetail.job.status}</p>
            </div>
            <div className="button-row">
              <button className="ghost-button compact" type="button" onClick={() => setSelectedJobId('')}>关闭</button>
              <button className="ghost-button compact" type="button" onClick={() => refreshSelectedJob()}>刷新状态</button>
            </div>
          </div>
          <div className="drawer-body">
            <div className="drawer-section-grid">
              <div className="detail-card"><span>模式</span><div>{jobDetail.job.mode}</div></div>
              <div className="detail-card"><span>绑定 Brief</span><div>第 {jobDetail.job.brief_version} 版（{jobDetail.job.brief_id}）</div></div>
              <div className="detail-card"><span>尝试</span><div>{jobDetail.job.attempt_count} / {jobDetail.job.max_attempts}</div></div>
              <div className="detail-card"><span>费用上限（报价）</span><div>{drawerCostText}</div></div>
              <div className="detail-card"><span>实际费用</span><div data-testid="g1-actual-cost">{drawerActualCostText}</div></div>
              <div className="detail-card"><span>创建时间</span><div>{new Date(jobDetail.job.created_at).toLocaleString('zh-CN', { hour12: false })}</div></div>
            </div>
            {drawerDiagnosticsLabel && (
              <p
                className="quality-warning"
                data-testid="g1-job-detail-diagnostics"
                data-diagnostic-state={jobDetail.job.status === 'completed' ? 'historical' : 'active'}
              >
                {drawerDiagnosticsLabel}
              </p>
            )}
            <GenerationArtifactViewer artifacts={jobDetail.artifacts || []} client={client} jobId={selectedJobId} onError={(error) => setJobDetailError(boundedMessage(error))} />
          </div>
              </aside>
            )}
          </div>
        </div>
      </section>
    </section>
  );
}
