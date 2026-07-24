import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { getAssets, loadKeys } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const EMPTY = { assets: [], legacyAssets: [], workflowRuns: [], agentRuns: [] };

export function AIWorksPage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    loadKeys(['assets', 'legacyAssets', 'workflowRuns', 'agentRuns'])
      .then((next) => setData({ ...EMPTY, ...next }))
      .finally(() => setLoading(false));
  }, [userId]);

  const assets = useMemo(() => getAssets(data), [data]);
  const generated = assets.filter((item) => item.source || item.model || item.workflow);
  const runs = [...data.workflowRuns, ...data.agentRuns];
  const failed = runs.filter((item) => ['failed', 'error'].includes(String(item.status).toLowerCase()));

  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看 AI 生成成果。" />;

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">AI 生成成果</p>
        <h2>统一查看图片、视频、角色模型与工作流生成结果</h2>
        <p>这里汇总内容工作台产生的视觉素材和运行记录。审核、重新生成与最终采用仍在同一张内容卡片中完成。</p>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('workspace')}>进入内容工作台</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>打开素材库</button>
        </div>
      </div>
      <div className="stat-grid compact">
        <StatCard label="全部成果" value={loading ? '-' : assets.length} hint="图片、视频及工作流素材" />
        <StatCard label="AI 生成" value={loading ? '-' : generated.length} hint="包含模型或工作流信息" />
        <StatCard label="运行记录" value={loading ? '-' : runs.length} hint="智能体与工作流" />
        <StatCard label="异常任务" value={loading ? '-' : failed.length} hint="可回到工作台重新生成" />
      </div>
      {assets.length ? (
        <div className="asset-grid">
          {assets.map((asset) => {
            const type = String(asset.asset_type || asset.type || 'asset').toLowerCase();
            const url = asset.url || asset.output_url || asset.media_url || asset.storage_url;
            const thumbnail = asset.thumbnail || asset.thumbnail_url || asset.preview_url;
            return (
              <article className="asset-card aiworks-card" key={asset.id}>
                <div className={`aiworks-thumb ${type === 'video' ? 'video' : ''}`}>
                  {type === 'video' && url ? (
                    <video src={url} poster={thumbnail} controls preload="metadata" />
                  ) : thumbnail || url ? (
                    <img src={thumbnail || url} alt={asset.name || ''} loading="lazy" />
                  ) : (
                    <div className="asset-placeholder">{asset.asset_type || asset.type || '素材'}</div>
                  )}
                </div>
                <div className="asset-card-body">
                  <div className="panel-title"><h3>{asset.name}</h3><StatusBadge status={asset.status} /></div>
                  <p>{asset.prompt || '暂无生成提示词'}</p>
                  <small>{asset.model || asset.workflow || asset.source || '手工素材'} · {formatDate(asset.createdAt)}</small>
                </div>
              </article>
            );
          })}
        </div>
      ) : <EmptyState title="暂无 AI 成果" description="在内容工作台生成图片或视频后，结果会自动出现在这里。" />}
    </section>
  );
}
