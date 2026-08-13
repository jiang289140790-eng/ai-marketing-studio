// P22/P29/P35 智能采集面板（采集目的地的主画布）。
//
// 渐进式重设计后，本组件只负责「采集」这一步：一个显著输入框（粘贴链接或输入
// 主题）+ 一个主按钮 → 公开来源预览卡（紧凑卡，媒体按顺序渲染）→ 显式「保存证据」。
// 分析、保存分析结果、相似帖子草稿分别位于 分析 / 创作 目的地（见
// P36ResearchDestinations.jsx），不会在本面板内出现，避免一条纵向长页面。
//
// 本组件不发起任何网络请求；所有网络副作用（collect / collectUrl）经由
// 页面持有的 P22 客户端与回调上抛，结果由页面持有（切换项目即失效）。

import { useEffect, useMemo, useState } from 'react';
import { createP22ResearchAssistClient, findP22Evidence, looksLikePublicUrl } from '../../services/p22-research-assist.js';

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

/** 单个来源预览卡：作者/时间/互动/媒体/正文 + 唯一主操作（保存证据 或 去分析）。 */
function SourceCard({ item, evidence, busy, working, onSaveEvidence, onGoAnalyze }) {
  const metadata = item.source_metadata || {};
  const author = metadata.author || {};
  const media = item.media_assets || [];
  return (
    <article className="p22-source-card p36-source-card">
      <div className="p22-source-head">
        <span className="p22-source-author">{author.name || author.handle || '未知作者'}{author.handle ? ` @${author.handle}` : ''}</span>
        <span className="p22-source-meta">{metadata.platform || 'X'} · {formatPublishedAt(metadata.published_at)}</span>
        <span className={evidence ? 'p22-saved-state' : 'p22-preview-state'}>
          {evidence ? '证据已保存' : '来源预览 · 未保存'}
        </span>
      </div>
      <div className="p22-source-label">{item.label}</div>
      <div className="p22-source-links">
        <a href={item.source_url} target="_blank" rel="noreferrer">查看原始来源</a>
        {media.length > 0 && <span>媒体 {media.length} 项</span>}
      </div>
      {media.length > 0 && <div className="p22-media-gallery" data-media-count={media.length}>{media.map((asset) => <MediaNode key={asset.id} asset={asset} />)}</div>}
      <p className="p22-source-text">{item.content_text}</p>
      {engagementLine(metadata.engagement) && <p className="p22-engagement">{engagementLine(metadata.engagement)}</p>}
      <div className="p36-source-actions">
        {!evidence ? (
          <button className="p19-btn p19-btn-primary" type="button" disabled={busy || Boolean(working)} onClick={() => onSaveEvidence(item)}>
            {working ? '保存中…' : '保存证据'}
          </button>
        ) : (
          <button className="p19-btn p19-btn-primary" type="button" onClick={() => onGoAnalyze(evidence.id)} title="在「分析」目的地打开这条来源的完整分析结果">
            去分析
          </button>
        )}
        {evidence && (
          <span className="p22-saved-state">已保存 · 下一步分析</span>
        )}
      </div>
    </article>
  );
}

/**
 * 采集目的地主面板：智能输入（粘贴链接或输入主题）+ 一个主按钮 + 紧凑来源卡。
 * 表单瞬态状态由页面持有（P36Destinations），本组件只负责渲染与回调上抛，
 * 因此切换目的地/项目时不会残留或跨项目泄漏。
 */
export function P22CollectPanel({
  project,
  busy,
  onSaveEvidence,
  onGoAnalyze,
  topic,
  onTopicChange,
  items,
  message,
  error,
  workingKey,
  onCollect,
}) {
  const client = useMemo(() => createP22ResearchAssistClient(), []);
  const [status, setStatus] = useState(null);
  const [capabilityError, setCapabilityError] = useState('');

  useEffect(() => {
    let mounted = true;
    let retryTimer = null;
    let inFlight = false;
    const probe = async (attempt = 0) => {
      if (!mounted || inFlight) return;
      inFlight = true;
      try {
        const next = await client.status();
        if (!mounted) return;
        setStatus(next);
        setCapabilityError('');
      } catch (cause) {
        if (!mounted) return;
        if (attempt < 2) {
          retryTimer = window.setTimeout(() => probe(attempt + 1), 800 * (attempt + 1));
        } else {
          setCapabilityError(String(cause?.message || cause));
        }
      } finally {
        inFlight = false;
      }
    };
    const probeOnFocus = () => probe(0);
    probe(0);
    window.addEventListener('focus', probeOnFocus);
    return () => {
      mounted = false;
      if (retryTimer) window.clearTimeout(retryTimer);
      window.removeEventListener('focus', probeOnFocus);
    };
  }, [client]);

  const isUrlQuery = looksLikePublicUrl(topic);
  const canUseAi = status?.role && ['operator', 'admin'].includes(status.role);
  const canCollect = canUseAi && status.capabilities?.apify_configured;
  const capabilitiesReady = Boolean(canCollect);

  return (
    <div className="p22-assist p36-collect" aria-label="智能找资料">
      <div className="p22-assist-head">
        <div>
          <span className="p22-kicker">采集公开来源</span>
          <h4>粘贴链接或输入主题，找到并保存来源</h4>
        </div>
        <span className="p22-budget">保存后才可分析 · 每步都由你确认</span>
      </div>
      {status && (
        <div className="p22-capabilities">
          <span className={status.capabilities.apify_configured ? 'ready' : 'missing'}>Apify：{status.capabilities.apify_configured ? '已配置' : '未配置'}</span>
          <span className={status.capabilities.qwen_configured ? 'ready' : 'missing'}>Qwen：{status.capabilities.qwen_configured ? '已配置' : '未配置'}</span>
          <span>权限：{status.role}</span>
          {status.cost_tracking && <span>今日记录：Apify ¥{status.cost_tracking.apify.recorded_cny} · Qwen ¥{status.cost_tracking.qwen.recorded_cny}</span>}
        </div>
      )}
      {capabilityError && <p className="p19-error-text" role="alert">{capabilityError}</p>}
      <div className="p22-query-row">
        <input
          value={topic}
          maxLength={1000}
          onChange={(event) => onTopicChange(event.target.value)}
          placeholder="粘贴 X 帖子链接，或输入研究主题"
          aria-label="帖子链接或研究主题"
        />
        <button
          className="p19-btn p19-btn-primary p36-hero"
          type="button"
          disabled={busy || Boolean(workingKey) || !capabilitiesReady || !topic.trim()}
          onClick={() => onCollect(topic.trim(), isUrlQuery)}
          title={!capabilitiesReady ? '公开来源采集能力未就绪（需要登录且 Apify 已配置）' : isUrlQuery ? '读取这条帖子的公开内容' : '查找与主题相关的公开来源'}
        >
          {workingKey ? '读取中…' : isUrlQuery ? '读取这条帖子' : '查找公开来源'}
        </button>
      </div>
      {!canUseAi && status && (
        <p className="p19-meta-line">当前账号无 operator/admin 权限：只能查看本机已保存来源，不能采集或调用模型分析。</p>
      )}
      {error && <p className="p19-error-text" role="alert">{error}</p>}
      {message && <p className="p22-message" role="status">{message}</p>}
      {items.length > 0 && (
        <div className="p22-results">
          <div className="p22-result-toolbar">
            <b>找到的来源（保存后才可分析）</b>
            <span className="p22-preview-note">每条来源独立显示、独立确认保存</span>
          </div>
          {items.map((item) => {
            const evidence = findP22Evidence(project, item);
            return (
              <SourceCard
                key={item.id}
                item={item}
                evidence={evidence}
                busy={busy}
                working={workingKey === `save:${item.id}`}
                onSaveEvidence={onSaveEvidence}
                onGoAnalyze={onGoAnalyze}
              />
            );
          })}
        </div>
      )}
      {items.length === 0 && !message && !error && (
        <p className="p19-empty-note p36-collect-hint">
          支持两种方式：粘贴一条 X 帖子链接读取该帖子；或输入主题词查找公开帖子。找到后点击「保存证据」才会写入当前项目。
        </p>
      )}
    </div>
  );
}

// 兼容旧导入名：旧版 P22ResearchAssistPanel 的「分析/草稿」职责已迁移到
// 分析/创作目的地；保留默认导出指向采集面板，避免破坏既有引用。
export default P22CollectPanel;
