import { useEffect, useMemo, useState } from 'react';
import { createP22ResearchAssistClient, findP22Evidence, looksLikePublicUrl, p22ItemFromEvidence } from '../../services/p22-research-assist.js';

/** 有界时间显示：ISO-8601 → UTC 紧凑文本；失败显示「时间未知」。 */
function formatPublishedAt(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return '时间未知';
  return `${text.slice(0, 16).replace('T', ' ')} UTC`;
}

function engagementLine(engagement) {
  if (!engagement || typeof engagement !== 'object') return null;
  const labels = [['likes', '点赞'], ['retweets', '转发'], ['replies', '评论'], ['quotes', '引用'], ['views', '浏览'], ['bookmarks', '收藏']];
  const parts = labels
    .filter(([key]) => Number.isInteger(engagement[key]))
    .map(([key, label]) => `${label} ${engagement[key]}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function MediaNode({ asset }) {
  const isVideo = asset.kind === 'video' || String(asset.mime_type || '').startsWith('video/');
  const common = { 'data-media-order': asset.order, 'aria-label': `媒体 ${asset.order + 1}` };
  if (isVideo) {
    return <video src={asset.media_url} controls preload="metadata" {...common} />;
  }
  return <img src={asset.media_url} alt={`媒体 ${asset.order + 1}`} loading="lazy" {...common} />;
}

export function P22ResearchAssistPanel({ project, busy, onSaveEvidence }) {
  const client = useMemo(() => createP22ResearchAssistClient(), []);
  const [status, setStatus] = useState(null);
  const [topic, setTopic] = useState(project.topic || '');
  const [items, setItems] = useState(() => (project.evidence || []).map(p22ItemFromEvidence).filter(Boolean));
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setTopic(project.topic || '');
    setItems((project.evidence || []).map(p22ItemFromEvidence).filter(Boolean));
    setMessage('');
    setError('');
  }, [project.id, project.topic, project.evidence]);

  useEffect(() => {
    let mounted = true;
    client.status().then((next) => { if (mounted) setStatus(next); }).catch((cause) => { if (mounted) setError(cause.message); });
    return () => { mounted = false; };
  }, [client]);

  const isUrlQuery = looksLikePublicUrl(topic);
  const canCollect = status?.role && ['operator', 'admin'].includes(status.role) && status.capabilities?.apify_configured;
  const act = async (callback) => {
    setWorking(true); setError(''); setMessage('');
    try { await callback(); } catch (cause) { setError(String(cause?.message || cause)); }
    finally { setWorking(false); }
  };
  const collect = () => act(async () => {
    // A new collection attempt owns the preview area. Never leave an older
    // source visible while a different URL/topic is loading or after it fails.
    setItems([]);
    const response = isUrlQuery
      ? await client.collectUrl(topic.trim())
      : await client.collect(topic.trim(), 5);
    setItems(response.items || []); setMessage('');
    setMessage(`已找到 ${response.items?.length || 0} 条公开来源；尚未保存。Apify 本次费用记录 ¥${response.cost?.recorded_cny ?? 0}。`);
  });
  const save = (item) => act(async () => {
    const ok = await onSaveEvidence(item);
    if (ok) setMessage('已保存证据并生成分析，内容策划草案（待你确认）已就绪。');
  });

  return (
    <div className="p22-assist" aria-label="智能找资料">
      <div className="p22-assist-head">
        <div><span className="p22-kicker">P22 · 智能研究</span><h4>智能找资料</h4></div>
        <span className="p22-budget">按实际使用记录费用</span>
      </div>
      <p className="p19-panel-note">粘贴 X 帖子链接读取完整来源（正文 + 作者 + 发布时间 + 互动 + 全部图片/视频）；一次点击保存图文证据并生成多模态分析，产出待你确认的内容策划草案，不自动批准、路由或发布。</p>
      {!status && !error && <p className="p19-meta-line">正在检查 staging 能力…</p>}
      {status && (
        <div className="p22-capabilities">
          <span className={status.capabilities.apify_configured ? 'ready' : 'missing'}>Apify：{status.capabilities.apify_configured ? '已配置' : '尚未配置'}</span>
          <span className={status.capabilities.qwen_configured ? 'ready' : 'missing'}>Qwen 多模态：{status.capabilities.qwen_configured ? '已配置' : '尚未配置'}</span>
          <span>权限：{status.role}</span>
          {status.cost_tracking && <span>今日已记录：Apify ¥{status.cost_tracking.apify.recorded_cny} · Qwen ¥{status.cost_tracking.qwen.recorded_cny}</span>}
        </div>
      )}
      {status && !['operator', 'admin'].includes(status.role) && <p className="p22-missing-note">当前账号为只读角色；智能采集和分析需要 operator。</p>}
      <div className="p22-query-row">
        <input value={topic} maxLength={1000} onChange={(event) => setTopic(event.target.value)} placeholder="粘贴 X 帖子链接，或输入研究主题" aria-label="帖子链接或研究主题" />
        <button className="p19-btn p19-btn-primary" type="button" disabled={busy || working || !canCollect || !topic.trim()} onClick={collect}>{isUrlQuery ? '读取这条帖子' : '查找公开来源'}</button>
      </div>
      {status && !status.capabilities.apify_configured && <p className="p22-missing-note">真实采集暂不可用：staging 尚未配置 APIFY_TOKEN。</p>}
      {error && <p className="p19-error-text" role="alert">{error}</p>}
      {message && <p className="p22-message" role="status">{message}</p>}
      {items.length > 0 && (
        <div className="p22-results">
          <div className="p22-result-toolbar"><b>来源预览（未保存）</b><span className="p22-preview-note">保存后生成多模态分析并进入内容策划草案</span></div>
          {items.map((item) => {
            const existingEvidence = findP22Evidence(project, item);
            const existingAnalysis = existingEvidence && (project.analyses || []).find((row) => row.evidence_id === existingEvidence.id
              && row.evidence_fingerprint === existingEvidence.fingerprint && row.evidence_version === existingEvidence.version);
            const existingCard = existingAnalysis && (project.knowledge_cards || []).find((row) => row.analysis_id === existingAnalysis.id
              && row.analysis_fingerprint === existingAnalysis.fingerprint);
            const pipelineComplete = Boolean(existingCard && project.brief?.knowledge_citation_ids?.includes(existingCard.id));
            const metadata = item.source_metadata || {};
            const author = metadata.author || {};
            const engagement = engagementLine(metadata.engagement);
            const media = item.media_assets || [];
            const modelAnalysis = existingAnalysis && existingAnalysis.model_analysis;
            return <article className="p22-source-card" key={item.id}>
              <div className="p22-source-head">
                <span className="p22-source-author">
                  {author.name || author.handle || '未知作者'}{author.handle ? ` @${author.handle}` : ''}
                </span>
                <span className="p22-source-meta">X · {formatPublishedAt(metadata.published_at)}</span>
                {existingEvidence
                  ? <span className="p22-saved-state" title={existingEvidence.id}>已保存为证据</span>
                  : <span className="p22-preview-state">预览未保存</span>}
              </div>
              <div className="p22-source-label">{item.label}</div>
              <div className="p22-source-links">
                <a href={item.source_url} target="_blank" rel="noreferrer">查看原始来源</a>
                {media.length > 0 && <span>媒体 {media.length} 项</span>}
              </div>
              {media.length > 0 && (
                <div className="p22-media-gallery" data-media-count={media.length}>
                  {media.map((asset) => <MediaNode key={asset.id} asset={asset} />)}
                </div>
              )}
              <p className="p22-source-text">{item.content_text}</p>
              {engagement && <p className="p22-engagement">{engagement}</p>}
              <small className="p22-media-hashes">
                正文 SHA-256：{item.content_sha256.slice(0, 16)}…
                {media.slice(0, 2).map((asset) => (
                  <span key={asset.id} title={`${asset.hash.algorithm}（${asset.hash.kind}）`}> · 媒体{asset.order + 1} {asset.hash.value.slice(0, 12)}…</span>
                ))}
                {media.length > 2 && <span> 等 {media.length} 项</span>}
                <span> · Run：{String(item.provenance?.run_id || '未提供').slice(0, 48)}</span>
              </small>
              {modelAnalysis && (
                <div className="p22-analysis-preview">
                  <b>多模态分析（已绑定保存）</b>
                  <p>{modelAnalysis.result.text_expression}</p>
                  {(modelAnalysis.result.media_analysis || []).map((row) => (
                    <small key={row.media_id}>画面（{row.media_id}）：{row.visual_content}</small>
                  ))}
                  <small>信号：{(modelAnalysis.result.signals || []).join('；') || '无'} · 风险：{(modelAnalysis.result.risks || []).join('；') || '无'}</small>
                </div>
              )}
              {existingAnalysis && !modelAnalysis && (
                <div className="p22-analysis-preview">
                  <b>确定性本地分析（已保存）</b>
                  <p>{existingAnalysis.result.summary.label}</p>
                  <small>信号：{(existingAnalysis.result.rules || []).map((rule) => rule.label).slice(0, 3).join('；')}</small>
                </div>
              )}
              <button className="p19-btn p19-btn-primary" type="button" disabled={busy || working || pipelineComplete} onClick={() => save(item)} title={pipelineComplete ? '草案已生成，可在下方审核' : '一次点击：保存证据 → 多模态分析 → 知识卡 → 内容策划草案'}>
                {pipelineComplete ? '已生成内容策划草案' : existingEvidence ? '继续生成分析并完成草案' : '保存图文证据并生成分析'}
              </button>
              {pipelineComplete && <small className="p22-preview-note">已保存为完整性绑定的多模态证据；草案待你确认（批准仅进入交接包，不生成、不路由、不发布）。</small>}
            </article>;
          })}
        </div>
      )}
    </div>
  );
}
