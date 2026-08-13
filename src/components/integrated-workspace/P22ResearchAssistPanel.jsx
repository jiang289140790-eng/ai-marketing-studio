import { useEffect, useMemo, useState } from 'react';
import { createP22ResearchAssistClient, findP22Evidence, looksLikePublicUrl, p22ItemFromEvidence } from '../../services/p22-research-assist.js';
import { getLatestAnalysisForEvidence } from '../../services/p19-workspace-service.js';

function formatPublishedAt(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return '时间未知';
  return `${text.slice(0, 16).replace('T', ' ')} UTC`;
}

function engagementLine(engagement) {
  if (!engagement || typeof engagement !== 'object') return null;
  const labels = [['likes', '点赞'], ['retweets', '转发'], ['replies', '评论'], ['quotes', '引用'], ['views', '浏览'], ['bookmarks', '收藏']];
  const parts = labels.filter(([key]) => Number.isInteger(engagement[key])).map(([key, label]) => `${label} ${engagement[key]}`);
  return parts.length ? parts.join(' · ') : null;
}

function MediaNode({ asset }) {
  const isVideo = asset.kind === 'video' || String(asset.mime_type || '').startsWith('video/');
  const common = { 'data-media-order': asset.order, 'aria-label': `媒体 ${asset.order + 1}` };
  return isVideo
    ? <video src={asset.media_url} controls preload="metadata" {...common} />
    : <img src={asset.media_url} alt={`媒体 ${asset.order + 1}`} loading="lazy" {...common} />;
}

function List({ title, values }) {
  if (!Array.isArray(values) || !values.length) return null;
  return <div className="p35-analysis-group"><b>{title}</b><ul>{values.map((value, index) => <li key={`${title}-${index}`}>{value}</li>)}</ul></div>;
}

function AnalysisResult({ analysis, saved }) {
  const result = analysis?.model_analysis?.result || analysis?.result || analysis || {};
  return (
    <section className="p35-analysis-result" aria-label="分析结果">
      <header><div><span className="p22-kicker">分析结果</span><h5>{result.hook || '内容结构与传播分析'}</h5></div><span className={saved ? 'p22-saved-state' : 'p22-preview-state'}>{saved ? `已保存 · 第 ${analysis.version || 1} 版` : '预览 · 未保存'}</span></header>
      {result.text_expression && <div className="p35-analysis-group"><b>表达与内容</b><p>{result.text_expression}</p></div>}
      {result.copy_pattern && <div className="p35-analysis-group"><b>文案结构</b><p>{result.copy_pattern}</p></div>}
      {(result.target_audience || result.audience_need_emotion) && <div className="p35-analysis-grid"><div><b>目标受众</b><p>{result.target_audience || '未识别'}</p></div><div><b>需求与情绪</b><p>{result.audience_need_emotion || '未识别'}</p></div></div>}
      {(result.media_analysis || []).map((row, index) => <div className="p35-analysis-group" key={row.media_id || index}><b>媒体 {index + 1}</b><p>{[row.visual_content, row.composition, row.people, row.scene, row.emotion].filter(Boolean).join('；')}</p>{row.visual_selling_points && <small>视觉卖点：{row.visual_selling_points}</small>}{row.style_pattern && <small>风格：{row.style_pattern}</small>}</div>)}
      <div className="p35-analysis-grid"><List title="传播驱动" values={result.virality_drivers} /><List title="可复用方法" values={result.reusable_methods} /></div>
      <List title="改写建议" values={result.rewrite_suggestions} />
      <div className="p35-analysis-grid"><List title="信号" values={result.signals} /><List title="风险" values={result.risks} /></div>
    </section>
  );
}

function SimilarDraftEditor({ draft, onChange, onSave, disabled, savedId }) {
  return <section className="p35-similar-draft" aria-label="相似帖子草稿">
    <header><div><span className="p22-kicker">相似帖子草稿</span><h5>基于已保存分析生成，可编辑</h5></div>{savedId && <span className="p22-saved-state">已保存到内容库</span>}</header>
    <label>标题<input value={draft.title} onChange={(event) => onChange('title', event.target.value)} maxLength={200} /></label>
    <label>正文<textarea value={draft.main_copy} onChange={(event) => onChange('main_copy', event.target.value)} maxLength={5000} rows={6} /></label>
    <div className="p35-analysis-grid"><label>行动引导<input value={draft.cta} onChange={(event) => onChange('cta', event.target.value)} maxLength={300} /></label><label>标签（空格分隔）<input value={(draft.hashtags || []).join(' ')} onChange={(event) => onChange('hashtags', event.target.value.split(/\s+/).filter(Boolean).slice(0, 10))} /></label></div>
    <label>媒体创意<textarea value={draft.media_idea} onChange={(event) => onChange('media_idea', event.target.value)} maxLength={1000} rows={3} /></label>
    <button className="p19-btn p19-btn-primary" type="button" disabled={disabled || Boolean(savedId)} onClick={onSave}>{savedId ? '草稿已保存' : '保存相似帖子草稿'}</button>
    <small>只保存为草稿；不会自动审核、路由或发布。</small>
  </section>;
}

export function P22ResearchAssistPanel({ project, busy, onSaveEvidence, onSaveAnalysis, onSaveDraft }) {
  const client = useMemo(() => createP22ResearchAssistClient(), []);
  const [status, setStatus] = useState(null);
  const [topic, setTopic] = useState(project.topic || '');
  const [items, setItems] = useState(() => (project.evidence || []).map(p22ItemFromEvidence).filter(Boolean));
  const [analysisPreviews, setAnalysisPreviews] = useState({});
  const [drafts, setDrafts] = useState({});
  const [savedDraftIds, setSavedDraftIds] = useState({});
  const [workingKey, setWorkingKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setAnalysisPreviews({}); setDrafts({}); setSavedDraftIds({}); setMessage(''); setError('');
  }, [project.id]);

  useEffect(() => { setTopic(project.topic || ''); }, [project.id, project.topic]);

  useEffect(() => {
    const currentIds = new Set((project.evidence || []).map((row) => row.id));
    setItems((previous) => {
      const unsaved = previous.filter((item) => !findP22Evidence(project, item));
      const saved = (project.evidence || []).filter((row) => currentIds.has(row.id)).map(p22ItemFromEvidence).filter(Boolean);
      return [...unsaved, ...saved];
    });
  }, [project]);

  useEffect(() => {
    let mounted = true;
    client.status().then((next) => { if (mounted) setStatus(next); }).catch((cause) => { if (mounted) setError(cause.message); });
    return () => { mounted = false; };
  }, [client]);

  const isUrlQuery = looksLikePublicUrl(topic);
  const canUseAi = status?.role && ['operator', 'admin'].includes(status.role);
  const canCollect = canUseAi && status.capabilities?.apify_configured;
  const act = async (key, callback) => {
    setWorkingKey(key); setError(''); setMessage('');
    try { await callback(); } catch (cause) { setError(String(cause?.message || cause)); }
    finally { setWorkingKey(''); }
  };
  const collect = () => act('collect', async () => {
    setItems([]);
    const response = isUrlQuery ? await client.collectUrl(topic.trim()) : await client.collect(topic.trim(), 5);
    setItems(response.items || []);
    setMessage(`已找到 ${response.items?.length || 0} 条公开来源，尚未保存。Apify 本次费用记录 ¥${response.cost?.recorded_cny ?? 0}。`);
  });
  const saveEvidence = (item) => act(`save:${item.id}`, async () => {
    const ok = await onSaveEvidence(item);
    if (ok) setMessage('证据已保存。现在可以分析帖子或视频；分析结果不会自动保存。');
  });
  const analyzeEvidence = (evidence) => act(`analyze:${evidence.id}`, async () => {
    const response = await client.analyzePersisted(project.id, evidence.id);
    const result = (response.analyses || []).find((row) => row.source_id === evidence.provenance?.source_id);
    if (!result) throw new Error('分析结果未准确绑定当前证据，已停止。');
    setAnalysisPreviews((old) => ({ ...old, [evidence.id]: { result, usage: response.usage || {} } }));
    setMessage('分析完成。请先查看完整结果，确认后再保存。');
  });
  const saveAnalysis = (evidence, preview) => act(`save-analysis:${evidence.id}`, async () => {
    const saved = await onSaveAnalysis(evidence.id, preview.result, preview.usage);
    if (!saved) throw new Error('分析保存后未返回准确版本。');
    setAnalysisPreviews((old) => { const next = { ...old }; delete next[evidence.id]; return next; });
    setMessage('分析结果已保存为新版本。现在可以生成相似帖子草稿。');
  });
  const generateSimilar = (evidence, analysis) => act(`draft:${evidence.id}`, async () => {
    const response = await client.generateSimilar(project.id, evidence.id, analysis.id);
    setDrafts((old) => ({ ...old, [evidence.id]: { ...response.draft, model: response.draft?.model || 'qwen-plus', usage: response.usage || {} } }));
    setSavedDraftIds((old) => { const next = { ...old }; delete next[evidence.id]; return next; });
    setMessage('相似帖子草稿已生成。你可以修改后保存。');
  });
  const updateDraft = (evidenceId, field, value) => setDrafts((old) => ({ ...old, [evidenceId]: { ...old[evidenceId], [field]: value } }));
  const saveDraft = (evidence, analysis, draft) => act(`save-draft:${evidence.id}`, async () => {
    if (draft.evidence_id !== evidence.id || draft.evidence_version !== evidence.version || draft.evidence_fingerprint !== evidence.fingerprint) throw new Error('草稿绑定的证据版本已变化，请重新生成。');
    const boundAnalysis = (project.analyses || []).find((row) => row.id === draft.analysis_id
      && row.evidence_id === evidence.id && row.version === draft.analysis_version && row.fingerprint === draft.analysis_fingerprint);
    if (!boundAnalysis) throw new Error('草稿绑定的分析版本不存在或已失配，请重新生成。');
    const saved = await onSaveDraft(draft, evidence, boundAnalysis);
    setSavedDraftIds((old) => ({ ...old, [evidence.id]: saved?.id || 'saved' }));
  });

  return <div className="p22-assist" aria-label="智能找资料">
    <div className="p22-assist-head"><div><span className="p22-kicker">P35 · 智能研究</span><h4>从来源到可编辑内容</h4></div><span className="p22-budget">分析与生成均由你确认</span></div>
    <p className="p19-panel-note">读取并保存来源证据 → 查看分析结果 → 确认保存分析 → 生成相似帖子 → 编辑并保存草稿。不会自动审核、路由或发布。</p>
    {status && <div className="p22-capabilities"><span className={status.capabilities.apify_configured ? 'ready' : 'missing'}>Apify：{status.capabilities.apify_configured ? '已配置' : '未配置'}</span><span className={status.capabilities.qwen_configured ? 'ready' : 'missing'}>Qwen：{status.capabilities.qwen_configured ? '已配置' : '未配置'}</span><span>权限：{status.role}</span>{status.cost_tracking && <span>今日记录：Apify ¥{status.cost_tracking.apify.recorded_cny} · Qwen ¥{status.cost_tracking.qwen.recorded_cny}</span>}</div>}
    <div className="p22-query-row"><input value={topic} maxLength={1000} onChange={(event) => setTopic(event.target.value)} placeholder="粘贴 X 帖子链接，或输入研究主题" aria-label="帖子链接或研究主题" /><button className="p19-btn p19-btn-primary" type="button" disabled={busy || Boolean(workingKey) || !canCollect || !topic.trim()} onClick={collect}>{isUrlQuery ? '读取这条帖子' : '查找公开来源'}</button></div>
    {error && <p className="p19-error-text" role="alert">{error}</p>}{message && <p className="p22-message" role="status">{message}</p>}
    {items.length > 0 && <div className="p22-results"><div className="p22-result-toolbar"><b>来源与产物</b><span className="p22-preview-note">每一步都独立显示、独立确认</span></div>{items.map((item) => {
      const evidence = findP22Evidence(project, item);
      const latestAnalysis = evidence && getLatestAnalysisForEvidence(project, evidence.id);
      const analysis = latestAnalysis?.model_analysis ? latestAnalysis : (evidence
        ? (project.analyses || []).filter((row) => row.evidence_id === evidence.id && row.model_analysis).sort((a, b) => b.version - a.version)[0] || null
        : null);
      const preview = evidence && analysisPreviews[evidence.id];
      const draft = evidence && drafts[evidence.id];
      const metadata = item.source_metadata || {}; const author = metadata.author || {}; const media = item.media_assets || [];
      const sourceKind = media.some((asset) => asset.kind === 'video' || String(asset.mime_type || '').startsWith('video/')) ? '视频' : '帖子';
      return <article className="p22-source-card" key={item.id}>
        <div className="p22-source-head"><span className="p22-source-author">{author.name || author.handle || '未知作者'}{author.handle ? ` @${author.handle}` : ''}</span><span className="p22-source-meta">{metadata.platform || 'X'} · {formatPublishedAt(metadata.published_at)}</span><span className={evidence ? 'p22-saved-state' : 'p22-preview-state'}>{evidence ? '证据已保存' : '来源预览 · 未保存'}</span></div>
        <div className="p22-source-label">{item.label}</div><div className="p22-source-links"><a href={item.source_url} target="_blank" rel="noreferrer">查看原始来源</a>{media.length > 0 && <span>媒体 {media.length} 项</span>}</div>
        {media.length > 0 && <div className="p22-media-gallery" data-media-count={media.length}>{media.map((asset) => <MediaNode key={asset.id} asset={asset} />)}</div>}
        <p className="p22-source-text">{item.content_text}</p>{engagementLine(metadata.engagement) && <p className="p22-engagement">{engagementLine(metadata.engagement)}</p>}
        {!evidence && <button className="p19-btn p19-btn-primary" type="button" disabled={busy || Boolean(workingKey)} onClick={() => saveEvidence(item)}>保存证据</button>}
        {evidence && !preview && !analysis && <button className="p19-btn p19-btn-primary" type="button" disabled={busy || Boolean(workingKey) || !canUseAi} onClick={() => analyzeEvidence(evidence)}>分析此{sourceKind}</button>}
        {preview && <><AnalysisResult analysis={preview.result} saved={false} /><div className="p35-actions"><button className="p19-btn p19-btn-primary" type="button" disabled={busy || Boolean(workingKey)} onClick={() => saveAnalysis(evidence, preview)}>保存分析结果</button><button className="p19-btn" type="button" disabled={busy || Boolean(workingKey)} onClick={() => setAnalysisPreviews((old) => { const next = { ...old }; delete next[evidence.id]; return next; })}>放弃本次结果</button></div></>}
        {analysis && !preview && <><AnalysisResult analysis={analysis} saved /><div className="p35-actions"><button className="p19-btn p19-btn-primary" type="button" disabled={busy || Boolean(workingKey) || !canUseAi} onClick={() => generateSimilar(evidence, analysis)}>根据分析生成相似帖子</button><button className="p19-btn" type="button" disabled={busy || Boolean(workingKey) || !canUseAi} onClick={() => analyzeEvidence(evidence)}>追加新版分析</button></div><small>“追加新版分析”仅用于保留新的历史版本，不会覆盖旧分析。</small></>}
        {draft && <SimilarDraftEditor draft={draft} onChange={(field, value) => updateDraft(evidence.id, field, value)} onSave={() => saveDraft(evidence, analysis, draft)} disabled={busy || Boolean(workingKey)} savedId={savedDraftIds[evidence.id]} />}
      </article>;
    })}</div>}
  </div>;
}
