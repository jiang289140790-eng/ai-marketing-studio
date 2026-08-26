import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHarnessClient, newHarnessRequestId } from '../services/harness-client.js';
import { resolvePresentationBlocks } from '../services/harness-presentation.js';
import { PresentationPanel } from '../components/harness-presentation/PresentationPanel.jsx';
import { GenerationArtifactViewer } from '../components/generation-execution/GenerationArtifactViewer.jsx';
import { createGenerationClient } from '../services/generation-execution-service.js';
import {
  isValidHarnessTaskId,
  normalizeTaskSnapshot,
  stateLabel,
  taskSnapshotView,
} from '../services/harness-task-model.js';
import './ai-task-pages.css';
import './GenerationTasksPage.css';

function boundedMessage(error) {
  return String(error?.message || error || '操作失败。').slice(0, 200);
}

function formatTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

const POLL_INTERVAL_MS = 1500;
const GENERATION_JOB_ID = /^g1j-[0-9a-f]{24}$/;

function findGenerationJobId(value, depth = 0, seen = new Set()) {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') return GENERATION_JOB_ID.test(value) ? value : null;
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) {
      const found = findGenerationJobId(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if ((key === 'job_id' || key === 'jobId') && typeof item === 'string' && GENERATION_JOB_ID.test(item)) return item;
    const found = findGenerationJobId(item, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function attachmentBindings(pipeline) {
  const bindings = pipeline?.source?.provenance?.object_bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.filter((binding) => binding && typeof binding.ref === 'string' && typeof binding.mime_type === 'string');
}

function AttachmentPreview({ binding, preview, onDownload }) {
  const mime = String(binding.mime_type || '');
  return (
    <article className="ai-attachment-card" data-testid="ai-task-attachment-card">
      <div className="ai-attachment-card-head">
        <div><strong>{binding.name || 'attachment'}</strong><small>{mime} · {Number(binding.size || 0).toLocaleString()} bytes</small></div>
        <button className="ghost-button compact" type="button" onClick={() => onDownload(binding)}>下载</button>
      </div>
      {preview?.error ? (
        <div className="notice error" role="alert">{preview.error}</div>
      ) : !preview?.signedUrl ? (
        <div className="skeleton skeleton-card" />
      ) : mime.startsWith('image/') ? (
        <img className="ai-attachment-media" src={preview.signedUrl} alt={binding.name || '附件预览'} />
      ) : mime.startsWith('video/') ? (
        <video className="ai-attachment-media" src={preview.signedUrl} controls preload="metadata" />
      ) : mime === 'application/pdf' ? (
        <iframe
          className="ai-attachment-document"
          src={preview.signedUrl}
          title={binding.name || 'PDF 附件预览'}
          sandbox=""
          referrerPolicy="no-referrer"
        />
      ) : (
        <a className="ghost-button compact ai-attachment-open" href={preview.signedUrl} target="_blank" rel="noreferrer">打开附件</a>
      )}
      <code>{String(binding.sha256 || '')}</code>
    </article>
  );
}

// 结果页五分类展示顺序与标签（每类都从同一 snapshot 派生，缺失逐类空态）。
const RESULT_SECTION_ORDER = [
  ['evidence', 'Evidence'],
  ['analysis', 'Analysis'],
  ['knowledge', 'Knowledge'],
  ['brief', 'Brief'],
  ['artifact', 'Artifact'],
];

const RESULT_KIND_LABEL = {
  evidence: '证据',
  analysis: '分析',
  knowledge: '知识卡',
  brief: 'Brief',
  artifact: '生成成品',
};

const ANALYSIS_HIGHLIGHT_KEYS = [
  'summary',
  'conclusion',
  'text_expression',
  'hook',
  'copy_pattern',
  'visual_content',
  'composition',
  'scene',
  'emotion',
  'virality_drivers',
  'reusable_methods',
  'rewrite_suggestions',
];

function boundedDisplayText(value, limit = 220) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim().slice(0, limit);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => boundedDisplayText(item, Math.max(40, Math.floor(limit / 3)))).filter(Boolean).join('；').slice(0, limit);
  }
  if (typeof value === 'object') {
    return Object.entries(value).slice(0, 4).map(([key, item]) => `${key}: ${boundedDisplayText(item, 80)}`).filter(Boolean).join('；').slice(0, limit);
  }
  return '';
}

function readableSectionItem(item, label) {
  const kind = RESULT_KIND_LABEL[item?.kind] || label || '产物';
  const title = boundedDisplayText(item?.summary || item?.name, 120) || `${kind} 已保存`;
  const id = String(item?.id || '').trim();
  const suffix = id ? `${id.slice(0, 10)}…` : '无后台编号';
  return { kind, title, suffix, id };
}

function collectAnalysisHighlights(value, maxItems = 6, seen = new Set(), depth = 0) {
  if (!value || depth > 5 || seen.has(value)) return [];
  if (typeof value !== 'object') return [];
  seen.add(value);
  const highlights = [];
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) highlights.push(...collectAnalysisHighlights(item, maxItems, seen, depth + 1));
    return highlights.slice(0, maxItems);
  }
  for (const key of ANALYSIS_HIGHLIGHT_KEYS) {
    if (Object.hasOwn(value, key)) {
      const text = boundedDisplayText(value[key]);
      if (text) highlights.push({ label: key, text });
    }
    if (highlights.length >= maxItems) return highlights;
  }
  for (const item of Object.values(value).slice(0, 12)) {
    highlights.push(...collectAnalysisHighlights(item, maxItems - highlights.length, seen, depth + 1));
    if (highlights.length >= maxItems) break;
  }
  return highlights.slice(0, maxItems);
}

function resultOverview({ attachmentPipeline, chain, sections, task }) {
  const analysisResult = attachmentPipeline?.analysis?.result || null;
  const highlights = collectAnalysisHighlights(analysisResult);
  const mediaCount = attachmentBindings(attachmentPipeline).length;
  return {
    mediaCount,
    highlights,
    evidenceCount: chain?.evidence?.length || sections?.evidence?.items?.length || 0,
    analysisCount: chain?.analysis?.length || sections?.analysis?.items?.length || 0,
    knowledgeCount: chain?.knowledge?.length || sections?.knowledge?.items?.length || 0,
    briefCount: chain?.brief?.length || sections?.brief?.items?.length || 0,
    artifactCount: chain?.generation?.length || sections?.artifact?.items?.length || 0,
    briefStatus: task?.result?.result_data?.attachment_pipeline?.brief?.status || task?.result?.result_data?.brief?.status || '',
  };
}

function outcomeRoadmap({ overview, generationJobId, task }) {
  const items = [];
  if (overview.evidenceCount > 0 || overview.analysisCount > 0) {
    items.push({
      label: '研究与分析',
      text: `${overview.evidenceCount} 条证据、${overview.analysisCount} 份分析已经进入当前任务结果。`,
      next: '先看本页摘要，再展开来源媒体与执行详情。',
    });
  }
  if (overview.knowledgeCount > 0) {
    items.push({
      label: '知识沉淀',
      text: `${overview.knowledgeCount} 张知识卡已沉淀到当前项目。`,
      next: '去知识库按项目复查，可继续复用到后续任务。',
    });
  }
  if (overview.briefCount > 0) {
    items.push({
      label: 'Brief 草案',
      text: `${overview.briefCount} 份 Brief 草案已生成${overview.briefStatus ? `，状态为 ${overview.briefStatus}` : ''}。`,
      next: '审核后进入生成工作台，避免未审稿直接生成。',
    });
  }
  if (generationJobId || overview.artifactCount > 0) {
    items.push({
      label: '生成成品',
      text: '图片或视频成品已绑定 Storage Artifact。',
      next: '在本页预览、下载，并查看版本历史。',
    });
  }
  if (items.length === 0) {
    items.push({
      label: '当前状态',
      text: task?.state === 'failed' || task?.state === 'blocked' ? '任务没有形成完整成果。' : '任务结果正在整理。',
      next: task?.state === 'failed' || task?.state === 'blocked' ? '返回执行页处理阻断步骤。' : '稍后刷新会恢复同一服务端快照。',
    });
  }
  return items.slice(0, 4);
}

function resultGuidance({ overview, generationJobId, task }) {
  if (!task) return { headline: '正在读取结果', next: '稍等片刻，系统会恢复同一任务的服务端快照。', tone: 'neutral' };
  const hasCoreOutput = overview.evidenceCount + overview.analysisCount + overview.knowledgeCount + overview.briefCount > 0;
  if (task.state === 'failed' || task.state === 'blocked' || task.state === 'partial') {
    return {
      headline: hasCoreOutput ? '已有部分成果，仍有步骤需要处理' : '任务没有完成，需要先处理阻断',
      next: hasCoreOutput ? '先查看已保存的产物；需要继续时回执行页只重试失败步骤。' : '返回执行页查看失败原因，避免重复付费或重复写入。',
      tone: 'attention',
    };
  }
  if (generationJobId) {
    return { headline: '生成成品可查看', next: '在本页查看图片/视频预览、下载和版本历史。', tone: 'done' };
  }
  if (overview.briefCount > 0) {
    return { headline: 'Brief 草案已经生成', next: '先审核 Brief；需要生成图片或视频时再进入生成工作台。', tone: 'done' };
  }
  if (overview.knowledgeCount > 0) {
    return { headline: '知识卡已经沉淀', next: '可以继续组装 Brief，或回研究工作台补充更多证据。', tone: 'review' };
  }
  return { headline: '结果正在整理', next: '本页会优先展示用户可读摘要，完整链路和诊断默认收起。', tone: 'neutral' };
}

/**
 * 任务结果与审核页：规范路由 `/tasks/<taskId>/results`（旧 `#/ai-results/<taskId>` 兼容重定向）。
 *
 * 只读取真实服务端任务快照（harness read），结果五分类
 * （Evidence / Analysis / Knowledge / Brief / Artifact）全部从同一 snapshot
 * 的 result / result_data / artifact_refs 派生；各类型缺失时逐类显示明确
 * 空状态，绝不使用 demo/fixture/static success。非终态任务明确提示尚未
 * 产生结果；轮询更新原子替换整个 snapshot。
 */
export function TaskResultsPage({ detailId: taskId = '', onNavigate, harnessClient: providedHarnessClient, generationClient: providedGenerationClient }) {
  const harnessClient = useMemo(() => providedHarnessClient || createHarnessClient(), [providedHarnessClient]);
  const generationClient = useMemo(() => providedGenerationClient || createGenerationClient(), [providedGenerationClient]);
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showFullResult, setShowFullResult] = useState(false);
  const [generationJob, setGenerationJob] = useState(null);
  const [generationError, setGenerationError] = useState('');
  const [attachmentPreviews, setAttachmentPreviews] = useState({});
  const [briefRepairing, setBriefRepairing] = useState(false);
  const [briefRepairError, setBriefRepairError] = useState('');
  const pollGeneration = useRef(0);
  const pollInFlight = useRef(false);

  const validTaskId = isValidHarnessTaskId(taskId);

  const refresh = useCallback(async () => {
    if (!validTaskId) {
      setLoading(false);
      setError('');
      setTask(null);
      return;
    }
    try {
      const response = await harnessClient.read(taskId);
      const next = normalizeTaskSnapshot(response?.task);
      if (!next) throw new Error('服务端没有返回有效的任务记录。');
      setTask(next);
      setError('');
    } catch (caught) {
      setError(boundedMessage(caught));
      setTask(null);
    } finally {
      setLoading(false);
    }
  }, [harnessClient, taskId, validTaskId]);

  useEffect(() => { refresh(); }, [refresh]);

  // 活动任务有界轮询：queued/running 期间每 1.5s 原子替换整个 snapshot。
  useEffect(() => {
    if (!task || !['queued', 'running'].includes(task.state)) return undefined;
    const timer = globalThis.setInterval(async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      const generation = pollGeneration.current;
      try {
        const response = await harnessClient.read(task.id);
        if (generation !== pollGeneration.current) return;
        const next = normalizeTaskSnapshot(response?.task);
        if (next) setTask(next);
      } catch (caught) {
        if (generation !== pollGeneration.current) return;
        setError(boundedMessage(caught));
      } finally {
        if (generation === pollGeneration.current) pollInFlight.current = false;
      }
    }, POLL_INTERVAL_MS);
    return () => {
      pollGeneration.current += 1;
      pollInFlight.current = false;
      globalThis.clearInterval(timer);
    };
  }, [harnessClient, task]);

  const view = useMemo(() => taskSnapshotView(task), [task]);
  const chain = view?.chain || null;
  const sections = view?.sections || null;
  const technical = view?.technical || null;
  const presentationBlocks = useMemo(() => resolvePresentationBlocks(task), [task]);
  const finalResponse = task?.result?.final_response || '';
  const terminal = task && ['succeeded', 'reused', 'partial', 'failed', 'blocked', 'cancelled'].includes(task.state);
  const generationJobId = useMemo(() => findGenerationJobId(task?.result?.result_data), [task]);
  const attachmentPipeline = task?.result?.result_data?.attachment_pipeline || null;
  const privateAttachments = useMemo(() => attachmentBindings(attachmentPipeline), [attachmentPipeline]);
  const overview = useMemo(() => resultOverview({ attachmentPipeline, chain, sections, task }), [attachmentPipeline, chain, sections, task]);
  const guidance = useMemo(() => resultGuidance({ overview, generationJobId, task }), [overview, generationJobId, task]);
  const outcomeItems = useMemo(() => outcomeRoadmap({ overview, generationJobId, task }), [overview, generationJobId, task]);
  const notTerminalText = task ? `任务还在 ${stateLabel(task.state)}，尚未产生最终结果。` : '';

  useEffect(() => {
    let active = true;
    setGenerationJob(null);
    setGenerationError('');
    if (!generationJobId) return () => { active = false; };
    generationClient.status({ jobId: generationJobId }).then((response) => {
      if (active) setGenerationJob(response?.data || null);
    }).catch((caught) => {
      if (active) setGenerationError(boundedMessage(caught));
    });
    return () => { active = false; };
  }, [generationClient, generationJobId]);

  useEffect(() => {
    let active = true;
    setAttachmentPreviews({});
    if (privateAttachments.length === 0) return () => { active = false; };
    (async () => {
      const next = {};
      for (const binding of privateAttachments) {
        try {
          next[binding.ref] = await harnessClient.createAttachmentPreview({ ref: binding.ref, name: binding.name });
        } catch (caught) {
          next[binding.ref] = { error: boundedMessage(caught) };
        }
        if (active) setAttachmentPreviews({ ...next });
      }
    })();
    return () => { active = false; };
  }, [harnessClient, privateAttachments]);

  const downloadAttachment = useCallback(async (binding) => {
    try {
      const preview = await harnessClient.createAttachmentPreview({ ref: binding.ref, name: binding.name, download: true });
      globalThis.open?.(preview.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      setAttachmentPreviews((current) => ({ ...current, [binding.ref]: { error: boundedMessage(caught) } }));
    }
  }, [harnessClient]);

  const reassembleBrief = useCallback(async () => {
    if (briefRepairing || !technical?.project_id) return;
    setBriefRepairing(true);
    setBriefRepairError('');
    try {
      const response = await harnessClient.plan({
        requestId: newHarnessRequestId(),
        projectId: technical.project_id,
        intent: '重新组装当前项目的待审核 Brief',
      });
      const nextTaskId = response?.task?.id;
      if (!isValidHarnessTaskId(nextTaskId)) throw new Error('服务端没有返回有效的 Brief 重组任务。');
      onNavigate?.('ai-execution', nextTaskId);
    } catch (caught) {
      setBriefRepairError(boundedMessage(caught));
    } finally {
      setBriefRepairing(false);
    }
  }, [briefRepairing, harnessClient, onNavigate, technical?.project_id]);

  return (
    <main className="ai-task-page" data-testid="ai-task-results">
      <div className="ai-task-head">
        <div>
          <p className="eyebrow">任务结果与审核</p>
          <h2>{view?.intent ? '结果与审核' : '任务结果与审核'}</h2>
          <p>结果、产物、来源链与人工确认范围均来自真实服务端；刷新页面不会丢失当前任务。</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate?.('ai-execution', taskId)}>返回执行详情</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate?.('ai')}>返回新任务首页</button>
        </div>
      </div>

      {!validTaskId && !loading && (
        <div className="notice error" data-testid="ai-task-invalid-id" role="alert">
          任务编号格式无效，无法读取结果与审核。请从新任务首页选择一条真实任务。
        </div>
      )}

      {validTaskId && loading && <div className="skeleton skeleton-card" data-testid="ai-task-loading" />}

      {validTaskId && !loading && error && (
        <div className="notice error" data-testid="ai-task-read-error" role="alert">
          {error}
        </div>
      )}

      {validTaskId && !loading && task && !task.invalid && (
        <>
          <section className="ai-task-hero" data-testid="ai-task-hero">
            <div className="ai-task-identity">
              <span className={`status-badge ${task.state}`}>{view.stateLabel}</span>
            </div>
            {view.intent && <p className="ai-task-intent">{view.intent}</p>}
            {view.workflowTitle && <div className="ai-task-meta"><span>流程 {view.workflowTitle}</span></div>}
          </section>

          <section className={`ai-task-user-summary ${guidance.tone}`} data-testid="h6-results-user-summary">
            <div>
              <p className="eyebrow">结果怎么用</p>
              <h3>{guidance.headline}</h3>
              <p>{guidance.next}</p>
            </div>
            <div className="ai-task-user-actions">
              {(task.state === 'failed' || task.state === 'blocked' || task.state === 'partial') && <button className="ghost-button compact" type="button" onClick={() => onNavigate?.('ai-execution', task.id)}>处理阻断</button>}
              {overview.briefCount > 0 && <button className="ghost-button compact" type="button" onClick={() => onNavigate?.('generation')}>去生成工作台</button>}
              <button className="ghost-button compact" type="button" onClick={() => onNavigate?.('research')}>回研究工作台</button>
            </div>
          </section>

          <section className="ai-task-panel" data-testid="ai-task-review">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">审核状态</p>
                <h3>{view.stateLabel}</h3>
              </div>
            </div>
            <div className="ai-review-details" data-testid="ai-review-details">
              <div className="detail-card"><span>任务状态</span><div>{view.stateLabel}</div></div>
              <div className="detail-card"><span>计划阶段</span><div>{view.phase === 'planned' ? '等待人工确认' : view.phase === 'active' ? '已确认，执行中' : view.phase === 'attention' ? '需要处理' : '已结束'}</div></div>
            </div>
          </section>

          {view?.errorText && (
            <div className="notice error" data-testid="ai-task-error" role="alert">
              {view.errorText}
            </div>
          )}

          <section className="ai-task-panel ai-result-overview" data-testid="ai-task-result-overview">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">成果摘要</p>
                <h3>先看结论，再看产物流向</h3>
              </div>
            </div>
            <div className="ai-outcome-roadmap" data-testid="h7-outcome-roadmap">
              {outcomeItems.map((item) => (
                <article key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.text}</strong>
                  <p>{item.next}</p>
                </article>
              ))}
            </div>
            <div className="ai-result-overview-grid">
              <div className="detail-card"><span>来源媒体</span><div>{overview.mediaCount || privateAttachments.length || 0} 个附件</div></div>
              <div className="detail-card"><span>证据/分析</span><div>{overview.evidenceCount} 条证据 · {overview.analysisCount} 份分析</div></div>
              <div className="detail-card"><span>知识卡</span><div>{overview.knowledgeCount > 0 ? `${overview.knowledgeCount} 张已生成` : '尚未生成'}</div></div>
              <div className="detail-card"><span>Brief 草案</span><div>{overview.briefCount > 0 ? `${overview.briefCount} 份${overview.briefStatus ? ` · ${overview.briefStatus}` : ''}` : '尚未生成'}</div></div>
            </div>
            {overview.highlights.length > 0 ? (
              <div className="ai-analysis-highlights" data-testid="ai-task-analysis-highlights">
                {overview.highlights.map((item, index) => (
                  <article key={`${item.label}-${index}`}>
                    <span>{item.label}</span>
                    <p>{item.text}</p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="ai-task-empty" data-testid="ai-task-no-analysis-highlights">
                当前快照没有可直接展示的结构化分析摘要；下方仍保留完整执行报告、来源媒体和产物链。
              </div>
            )}
          </section>

          <section className="ai-task-panel" data-testid="ai-task-result">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">任务结果</p>
                <h3>{view.headline}</h3>
              </div>
            </div>
            {!terminal ? (
              <div className="ai-task-empty" data-testid="ai-task-no-result">
                {notTerminalText}
              </div>
            ) : !finalResponse && !chain?.evidence.length && !chain?.analysis.length && !chain?.knowledge.length && !chain?.brief.length && !chain?.generation.length && !task?.result?.result_data ? (
              <div className="ai-task-empty" data-testid="ai-task-no-result">
                该任务已结束，但服务端没有记录任何结果或产物。
              </div>
            ) : (
              <>
                {finalResponse && (
                  <div className="ai-result-copy" data-testid="ai-task-final-response">
                    {finalResponse.slice(0, 800)}{finalResponse.length > 800 ? '…' : ''}
                  </div>
                )}
                {finalResponse && (
                  <button className="ghost-button compact" type="button" aria-expanded={showFullResult} onClick={() => setShowFullResult((value) => !value)}>
                    {showFullResult ? '收起完整执行报告' : '查看完整执行报告'}
                  </button>
                )}
                {showFullResult && finalResponse && <div className="ai-result-copy" data-testid="ai-task-full-response">{finalResponse}</div>}
              </>
            )}
          </section>

          {presentationBlocks.length > 0 && <PresentationPanel blocks={presentationBlocks} />}

          {privateAttachments.length > 0 && (
            <section className="ai-task-panel" data-testid="ai-task-attachment-preview">
              <div className="ai-task-panel-head"><div><p className="eyebrow">私有附件与模型理解</p><h3>来源、内容分析与恢复预览</h3></div></div>
              <div className="ai-attachment-grid">
                {privateAttachments.map((binding) => (
                  <AttachmentPreview key={binding.ref} binding={binding} preview={attachmentPreviews[binding.ref]} onDownload={downloadAttachment} />
                ))}
              </div>
              {attachmentPipeline?.source?.content_text && <div className="ai-result-copy" data-testid="ai-task-attachment-content">{attachmentPipeline.source.content_text}</div>}
              {attachmentPipeline?.analysis?.result && (
                <details className="ai-result-copy ai-compact-json" data-testid="ai-task-attachment-analysis">
                  <summary>{attachmentPipeline.analysis.model || '多模态模型'} · 第 {attachmentPipeline.analysis.analysis_version || 1} 版完整分析明细</summary>
                  <pre>{JSON.stringify(attachmentPipeline.analysis.result, null, 2)}</pre>
                </details>
              )}
            </section>
          )}

          <details className="ai-task-panel ai-collapsed-panel" data-testid="ai-task-sections">
            <summary>
              <span><span className="eyebrow">完整产物</span><strong>Evidence / Analysis / Knowledge / Brief / Artifact</strong></span>
              <small>默认收起</small>
            </summary>
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">结果分类</p>
                <h3>Evidence · Analysis · Knowledge · Brief · Artifact</h3>
              </div>
            </div>
            <div className="ai-result-sections">
              {RESULT_SECTION_ORDER.map(([key, label]) => {
                const section = sections?.[key] || { present: false, items: [] };
                return (
                  <div className="ai-result-section" key={key} data-testid={`ai-task-section-${key}`}>
                    <div className="ai-result-section-head"><strong>{label}</strong>{section.present && <span>{section.items.length} 项</span>}</div>
                    {!terminal ? (
                      <div className="ai-task-empty">{notTerminalText}</div>
                    ) : !section.present ? (
                      <div className="ai-task-empty" data-testid={`ai-task-no-${key}`}>服务端没有记录该任务的 {label} 数据。</div>
                    ) : (
                      <ul className="ai-section-items" data-testid={`ai-task-${key}-items`}>
                        {section.items.map((item) => {
                          const readable = readableSectionItem(item, label);
                          return (
                            <li className="ai-readable-section-item" key={`${item.kind}-${item.id || item.summary || item.name}`}>
                              <div>
                                <span className="ai-section-kind">{readable.kind}</span>
                                <strong>{readable.title}</strong>
                              </div>
                              <code title={readable.id}>{readable.suffix}</code>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </details>

          <details className="ai-task-panel ai-collapsed-panel" data-testid="ai-task-chain">
            <summary>
              <span><span className="eyebrow">来源链</span><strong>产物与来源身份</strong></span>
              <small>{chain ? '可展开核查' : '暂无来源链'}</small>
            </summary>
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">来源链</p>
                <h3>产物与来源身份</h3>
              </div>
            </div>
            {!chain || (!chain.evidence.length && !chain.analysis.length && !chain.knowledge.length && !chain.brief.length && !chain.generation.length && !chain.other.length) ? (
              <div className="ai-task-empty" data-testid="ai-task-no-chain">
                服务端没有记录产物或来源身份。
              </div>
            ) : (
              <>
                <div className="ai-chain-meta">
                  {chain.project_id && <span>项目绑定 <code>{chain.project_id}</code></span>}
                  {chain.evidence.length > 0 && <span>证据 {chain.evidence.length} 条</span>}
                  {chain.analysis.length > 0 && <span>分析 {chain.analysis.length} 项</span>}
                  {chain.knowledge.length > 0 && <span>知识卡 {chain.knowledge.length} 张</span>}
                  {chain.brief.length > 0 && <span>Brief {chain.brief.length} 份</span>}
                  {chain.generation.length > 0 && <span>生成产物 {chain.generation.length} 项</span>}
                </div>
                <dl className="ai-chain-list" data-testid="ai-task-chain-list">
                  {chain.evidence.map((id) => <div key={`ev-${id}`}><dt>证据</dt><dd><code>{id}</code></dd></div>)}
                  {chain.analysis.map((id) => <div key={`an-${id}`}><dt>分析</dt><dd><code>{id}</code></dd></div>)}
                  {chain.knowledge.map((id) => <div key={`kc-${id}`}><dt>知识卡</dt><dd><code>{id}</code></dd></div>)}
                  {chain.brief.map((id) => <div key={`brf-${id}`}><dt>Brief</dt><dd><code>{id}</code></dd></div>)}
                  {chain.generation.map((id) => <div key={`g1x-${id}`}><dt>生成产物</dt><dd><code>{id}</code></dd></div>)}
                  {chain.other.map((id) => <div key={`other-${id}`}><dt>身份引用</dt><dd><code>{id}</code></dd></div>)}
                </dl>
              </>
            )}
            {chain?.brief?.length > 0 && technical?.project_id && (
              <div className="ai-brief-reassemble" data-testid="ai-task-brief-reassemble">
                <p>知识卡或来源发生变化时，可创建一个受修订号和指纹保护的新 Brief 版本；旧版本会保留。</p>
                <button className="primary-button" type="button" disabled={briefRepairing} onClick={reassembleBrief}>
                  {briefRepairing ? '正在创建安全计划…' : '重新组装 Brief'}
                </button>
                {briefRepairError && <div className="notice error" role="alert">{briefRepairError}</div>}
              </div>
            )}
          </details>

          {task?.result?.artifact_refs?.length > 0 && (
            <details className="ai-technical-details" data-testid="ai-task-artifact-refs">
              <summary>原始产物身份</summary>
              <div className="ai-artifacts">{task.result.artifact_refs.map((ref) => <code key={ref}>{ref}</code>)}</div>
            </details>
          )}

          {generationJobId && (
            <section className="ai-task-panel g1-page" data-testid="ai-task-generation-preview">
              <div className="ai-task-panel-head"><div><p className="eyebrow">生成成品</p><h3>预览、下载与版本历史</h3></div></div>
              {generationError && <div className="notice error" role="alert">{generationError}</div>}
              {!generationJob && !generationError && <div className="skeleton skeleton-card" />}
              {generationJob && <GenerationArtifactViewer artifacts={generationJob.artifacts || []} client={generationClient} jobId={generationJobId} onError={(caught) => setGenerationError(boundedMessage(caught))} />}
            </section>
          )}

          {technical && (
            <details className="ai-technical-details" data-testid="ai-task-technical-details">
              <summary>技术诊断（默认隐藏）</summary>
              <dl className="ai-task-technical">
                <div><dt>内部状态</dt><dd>{technical.state || '—'}</dd></div>
                <div><dt>任务编号</dt><dd><code>{technical.task_id}</code></dd></div>
                <div><dt>更新时间</dt><dd>{formatTime(technical.updated_at)}</dd></div>
              </dl>
              <details className="ai-technical-subdetails">
                <summary>展开完整内部字段</summary>
                <dl className="ai-task-technical">
                  <div><dt>project_id</dt><dd><code>{technical.project_id || '未绑定'}</code></dd></div>
                  {technical.request_id && <div><dt>request_id</dt><dd><code>{technical.request_id}</code></dd></div>}
                  {technical.plan_fingerprint && <div><dt>计划指纹</dt><dd><code>{technical.plan_fingerprint}</code></dd></div>}
                  {technical.request_fingerprint && <div><dt>请求指纹</dt><dd><code>{technical.request_fingerprint}</code></dd></div>}
                  <div><dt>创建时间</dt><dd>{formatTime(technical.created_at)}</dd></div>
                  <div><dt>审批字段</dt><dd><code>{JSON.stringify(technical.confirmation_approvals)}</code></dd></div>
                </dl>
              </details>
            </details>
          )}
        </>
      )}

      {validTaskId && !loading && !task && !error && (
        <div className="ai-task-empty" data-testid="ai-task-not-found">
          没有找到该任务的服务端记录。
        </div>
      )}
    </main>
  );
}
