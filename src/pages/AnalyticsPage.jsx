import { useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { listViralAnalysis } from '../services/analytics-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { compactNumber, formatDate } from '../utils/formatters';

export function AnalyticsPage({ userId }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return;
    listViralAnalysis(userId).then(setItems).catch(() => setItems([]));
  }, [userId]);

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Viral Analysis</p>
          <h2>数据分析</h2>
          <p>先存竞争账号内容分析结果；后续接采集器、AI总结和趋势仪表盘。</p>
        </div>
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后这里会读取 viral_analysis 表。" />
      ) : items.length === 0 ? (
        <EmptyState title="暂无分析记录" description="导入竞争账号内容后，这里会显示 views、likes 和 AI 分析摘要。" />
      ) : (
        <div className="analysis-list">
          {items.map((item) => (
            <article key={item.id} className="analysis-card">
              <div className="card-meta">
                <span>{item.platform}</span>
                <span>{formatDate(item.created_at)}</span>
              </div>
              <h3>{item.account}</h3>
              <div className="metric-row">
                <strong>{compactNumber(item.views)} views</strong>
                <strong>{compactNumber(item.likes)} likes</strong>
              </div>
              <p>{item.analysis || '暂无分析'}</p>
              {item.content_url && <a href={item.content_url}>查看原内容</a>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
