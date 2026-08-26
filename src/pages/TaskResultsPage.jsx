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
  return String(error?.message || error || '?????').slice(0, 200);
}

function formatTime(value) {
  if (!value) return '?';
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
        <div><strong>{binding.name || 'attachment'}</strong><small>{mime} ? {Number(binding.size || 0).toLocaleString()} bytes</small></div>
        <button className="ghost-button compact" type="button" onClick={() => onDownload(binding)}>??</button>
      </div>
      {preview?.error ? (
        <div className="notice error" role="alert">{preview.error}</div>
      ) : !preview?.signedUrl ? (
        <div className="skeleton skeleton-card" />
      ) : mime.startsWith('image/') ? (
        <img className="ai-attachment-media" src={preview.signedUrl} alt={binding.name || '????'} />
      ) : mime.startsWith('video/') ? (
        <video className="ai-attachment-media" src={preview.signedUrl} controls preload="metadata" />
      ) : mime === 'application/pdf' ? (
        <iframe
          className="ai-attachment-document"
          src={preview.signedUrl}
          title={binding.name || 'PDF ????'}
          sandbox=""
          referrerPolicy="no-referrer"
        />
      ) : (
        <a className="ghost-button compact ai-attachment-open" href={preview.signedUrl} target="_blank" rel="noreferrer">????</a>
      )}
      <code>{String(binding.sha256 || '')}</code>
    </article>
  );
}

// ???????????????????? snapshot ???????????
const RESULT_SECTION_ORDER = [
  ['evidence', 'Evidence'],
  ['analysis', 'Analysis'],
  ['knowledge', 'Knowledge'],
  ['brief', 'Brief'],
  ['artifact', 'Artifact'],
];

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
    return value.map((item) => boundedDisplayText(item, Math.max(40, Math.floor(limit / 3)))).filter(Boolean).join('?').slice(0, limit);
  }
  if (typeof value === 'object') {
    return Object.entries(value).slice(0, 4).map(([key, item]) => `${key}: ${boundedDisplayText(item, 80)}`).filter(Boolean).join('?').slice(0, limit);
  }
  return '';
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
    briefStatus: task?.result?.result_data?.attachment_pipeline?.brief?.status || task?.result?.result_data?.brief?.status || '',
  };
}

/**
 * ????????????? `/tasks/<taskId>/results`?? `#/ai-results/<taskId>` ???????
 *
 * ?????????????harness read???????
 * ?Evidence / Analysis / Knowledge / Brief / Artifact?????? snapshot
 * ? result / result_data / artifact_refs ???????????????
 * ???????? demo/fixture/static success????????????
 * ??????????????? snapshot?
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
      if (!next) throw new Error('???????????????');
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

  // ?????????queued/running ??? 1.5s ?????? snapshot?
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
  const notTerminalText = task ? `???? ${stateLabel(task.state)}??????????` : '';

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
        intent: '???????????? Brief',
      });
      const nextTaskId = response?.task?.id;
      if (!isValidHarnessTaskId(nextTaskId)) throw new Error('?????????? Brief ?????');
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
          <p className="eyebrow">???????</p>
          <h2>{view?.intent ? '?????' : '???????'}</h2>
          <p>??????????????????????????????????????</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate?.('ai-execution', taskId)}>??????</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate?.('ai')}>???????</button>
        </div>
      </div>

      {!validTaskId && !loading && (
        <div className="notice error" data-testid="ai-task-invalid-id" role="alert">
          ???????????????????????????????????
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
            {view.workflowTitle && <div className="ai-task-meta"><span>?? {view.workflowTitle}</span></div>}
          </section>

          <section className="ai-task-panel" data-testid="ai-task-review">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">????</p>
                <h3>{view.stateLabel}</h3>
              </div>
            </div>
            <div className="ai-review-details" data-testid="ai-review-details">
              <div className="detail-card"><span>????</span><div>{view.stateLabel}</div></div>
              <div className="detail-card"><span>????</span><div>{view.phase === 'planned' ? '??????' : view.phase === 'active' ? '???????' : view.phase === 'attention' ? '????' : '???'}</div></div>
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
                <p className="eyebrow">????</p>
                <h3>???????????</h3>
              </div>
            </div>
            <div className="ai-result-overview-grid">
              <div className="detail-card"><span>????</span><div>{overview.mediaCount || privateAttachments.length || 0} ???</div></div>
              <div className="detail-card"><span>??/??</span><div>{overview.evidenceCount} ??? ? {overview.analysisCount} ???</div></div>
              <div className="detail-card"><span>???</span><div>{overview.knowledgeCount > 0 ? `${overview.knowledgeCount} ????` : '????'}</div></div>
              <div className="detail-card"><span>Brief ??</span><div>{overview.briefCount > 0 ? `${overview.briefCount} ?${overview.briefStatus ? ` ? ${overview.briefStatus}` : ''}` : '????'}</div></div>
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
                ?????????????????????????????????????????
              </div>
            )}
          </section>

          <section className="ai-task-panel" data-testid="ai-task-result">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">????</p>
                <h3>{view.headline}</h3>
              </div>
            </div>
            {!terminal ? (
              <div className="ai-task-empty" data-testid="ai-task-no-result">
                {notTerminalText}
              </div>
            ) : !finalResponse && !chain?.evidence.length && !chain?.analysis.length && !chain?.knowledge.length && !chain?.brief.length && !chain?.generation.length && !task?.result?.result_data ? (
              <div className="ai-task-empty" data-testid="ai-task-no-result">
                ???????????????????????
              </div>
            ) : (
              <>
                {finalResponse && (
                  <div className="ai-result-copy" data-testid="ai-task-final-response">
                    {finalResponse.slice(0, 800)}{finalResponse.length > 800 ? '?' : ''}
                  </div>
                )}
                {finalResponse && (
                  <button className="ghost-button compact" type="button" aria-expanded={showFullResult} onClick={() => setShowFullResult((value) => !value)}>
                    {showFullResult ? '????????' : '????????'}
                  </button>
                )}
                {showFullResult && finalResponse && <div className="ai-result-copy" data-testid="ai-task-full-response">{finalResponse}</div>}
              </>
            )}
          </section>

          {presentationBlocks.length > 0 && <PresentationPanel blocks={presentationBlocks} />}

          {privateAttachments.length > 0 && (
            <section className="ai-task-panel" data-testid="ai-task-attachment-preview">
              <div className="ai-task-panel-head"><div><p className="eyebrow">?????????</p><h3>????????????</h3></div></div>
              <div className="ai-attachment-grid">
                {privateAttachments.map((binding) => (
                  <AttachmentPreview key={binding.ref} binding={binding} preview={attachmentPreviews[binding.ref]} onDownload={downloadAttachment} />
                ))}
              </div>
              {attachmentPipeline?.source?.content_text && <div className="ai-result-copy" data-testid="ai-task-attachment-content">{attachmentPipeline.source.content_text}</div>}
              {attachmentPipeline?.analysis?.result && (
                <details className="ai-result-copy ai-compact-json" data-testid="ai-task-attachment-analysis">
                  <summary>{attachmentPipeline.analysis.model || '?????'} ? ? {attachmentPipeline.analysis.analysis_version || 1} ?????</summary>
                  <pre>{JSON.stringify(attachmentPipeline.analysis.result, null, 2)}</pre>
                </details>
              )}
            </section>
          )}

          <details className="ai-task-panel ai-collapsed-panel" data-testid="ai-task-sections">
            <summary>
              <span><span className="eyebrow">????</span><strong>Evidence / Analysis / Knowledge / Brief / Artifact</strong></span>
              <small>????</small>
            </summary>
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">????</p>
                <h3>Evidence ? Analysis ? Knowledge ? Brief ? Artifact</h3>
              </div>
            </div>
            <div className="ai-result-sections">
              {RESULT_SECTION_ORDER.map(([key, label]) => {
                const section = sections?.[key] || { present: false, items: [] };
                return (
                  <div className="ai-result-section" key={key} data-testid={`ai-task-section-${key}`}>
                    <div className="ai-result-section-head"><strong>{label}</strong>{section.present && <span>{section.items.length} ?</span>}</div>
                    {!terminal ? (
                      <div className="ai-task-empty">{notTerminalText}</div>
                    ) : !section.present ? (
                      <div className="ai-task-empty" data-testid={`ai-task-no-${key}`}>??????????? {label} ???</div>
                    ) : (
                      <ul className="ai-section-items" data-testid={`ai-task-${key}-items`}>
                        {section.items.map((item) => (
                          <li key={`${item.kind}-${item.id || item.summary || item.name}`}>
                            {item.id && <code>{item.id}</code>}
                            {(item.summary || item.name) && <span>{item.summary || item.name}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </details>

          <details className="ai-task-panel ai-collapsed-panel" data-testid="ai-task-chain">
            <summary>
              <span><span className="eyebrow">???</span><strong>???????</strong></span>
              <small>{chain ? '?????' : '?????'}</small>
            </summary>
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">???</p>
                <h3>???????</h3>
              </div>
            </div>
            {!chain || (!chain.evidence.length && !chain.analysis.length && !chain.knowledge.length && !chain.brief.length && !chain.generation.length && !chain.other.length) ? (
              <div className="ai-task-empty" data-testid="ai-task-no-chain">
                ???????????????
              </div>
            ) : (
              <>
                <div className="ai-chain-meta">
                  {chain.project_id && <span>???? <code>{chain.project_id}</code></span>}
                  {chain.evidence.length > 0 && <span>?? {chain.evidence.length} ?</span>}
                  {chain.analysis.length > 0 && <span>?? {chain.analysis.length} ?</span>}
                  {chain.knowledge.length > 0 && <span>??? {chain.knowledge.length} ?</span>}
                  {chain.brief.length > 0 && <span>Brief {chain.brief.length} ?</span>}
                  {chain.generation.length > 0 && <span>???? {chain.generation.length} ?</span>}
                </div>
                <dl className="ai-chain-list" data-testid="ai-task-chain-list">
                  {chain.evidence.map((id) => <div key={`ev-${id}`}><dt>??</dt><dd><code>{id}</code></dd></div>)}
                  {chain.analysis.map((id) => <div key={`an-${id}`}><dt>??</dt><dd><code>{id}</code></dd></div>)}
                  {chain.knowledge.map((id) => <div key={`kc-${id}`}><dt>???</dt><dd><code>{id}</code></dd></div>)}
                  {chain.brief.map((id) => <div key={`brf-${id}`}><dt>Brief</dt><dd><code>{id}</code></dd></div>)}
                  {chain.generation.map((id) => <div key={`g1x-${id}`}><dt>????</dt><dd><code>{id}</code></dd></div>)}
                  {chain.other.map((id) => <div key={`other-${id}`}><dt>????</dt><dd><code>{id}</code></dd></div>)}
                </dl>
              </>
            )}
            {chain?.brief?.length > 0 && technical?.project_id && (
              <div className="ai-brief-reassemble" data-testid="ai-task-brief-reassemble">
                <p>???????????????????????????? Brief ??????????</p>
                <button className="primary-button" type="button" disabled={briefRepairing} onClick={reassembleBrief}>
                  {briefRepairing ? '?????????' : '???? Brief'}
                </button>
                {briefRepairError && <div className="notice error" role="alert">{briefRepairError}</div>}
              </div>
            )}
          </details>

          {task?.result?.artifact_refs?.length > 0 && (
            <details className="ai-technical-details" data-testid="ai-task-artifact-refs">
              <summary>??????</summary>
              <div className="ai-artifacts">{task.result.artifact_refs.map((ref) => <code key={ref}>{ref}</code>)}</div>
            </details>
          )}

          {generationJobId && (
            <section className="ai-task-panel g1-page" data-testid="ai-task-generation-preview">
              <div className="ai-task-panel-head"><div><p className="eyebrow">????</p><h3>??????????</h3></div></div>
              {generationError && <div className="notice error" role="alert">{generationError}</div>}
              {!generationJob && !generationError && <div className="skeleton skeleton-card" />}
              {generationJob && <GenerationArtifactViewer artifacts={generationJob.artifacts || []} client={generationClient} jobId={generationJobId} onError={(caught) => setGenerationError(boundedMessage(caught))} />}
            </section>
          )}

          {technical && (
            <details className="ai-technical-details" data-testid="ai-task-technical-details">
              <summary>?????????</summary>
              <dl className="ai-task-technical">
                <div><dt>????</dt><dd>{technical.state || '?'}</dd></div>
                <div><dt>????</dt><dd><code>{technical.task_id}</code></dd></div>
                <div><dt>????</dt><dd>{formatTime(technical.updated_at)}</dd></div>
              </dl>
              <details className="ai-technical-subdetails">
                <summary>????????</summary>
                <dl className="ai-task-technical">
                  <div><dt>project_id</dt><dd><code>{technical.project_id || '???'}</code></dd></div>
                  {technical.request_id && <div><dt>request_id</dt><dd><code>{technical.request_id}</code></dd></div>}
                  {technical.plan_fingerprint && <div><dt>????</dt><dd><code>{technical.plan_fingerprint}</code></dd></div>}
                  {technical.request_fingerprint && <div><dt>????</dt><dd><code>{technical.request_fingerprint}</code></dd></div>}
                  <div><dt>????</dt><dd>{formatTime(technical.created_at)}</dd></div>
                  <div><dt>????</dt><dd><code>{JSON.stringify(technical.confirmation_approvals)}</code></dd></div>
                </dl>
              </details>
            </details>
          )}
        </>
      )}

      {validTaskId && !loading && !task && !error && (
        <div className="ai-task-empty" data-testid="ai-task-not-found">
          ??????????????
        </div>
      )}
    </main>
  );
}
