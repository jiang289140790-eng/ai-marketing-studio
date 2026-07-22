import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { displayText, getKnowledgeItems, loadKeys } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const EMPTY = { knowledge: [], insights: [], contentMemory: [], strategyMemory: [], accountReports: [], accountProfiles: [] };

export function KnowledgeBasePage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    loadKeys(['knowledge', 'insights', 'contentMemory', 'strategyMemory', 'accountReports', 'accountProfiles'])
      .then((next) => setData({ ...EMPTY, ...next }))
      .finally(() => setLoading(false));
  }, [userId]);

  const items = useMemo(() => getKnowledgeItems(data), [data]);
  const filtered = items.filter((item) => JSON.stringify(item).toLowerCase().includes(query.toLowerCase()));

  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看 Knowledge Vault 与 Account Brain。" />;

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">KNOWLEDGE VAULT / ACCOUNT BRAIN</p>
        <h2>沉淀账号画像、内容规律、策略记忆与运营洞察</h2>
        <p>Agent 在生成策略和内容前会读取这里的知识，批准后的结果与发布反馈也会继续写回，形成持续学习闭环。</p>
        <div className="button-row"><button className="ghost-button" type="button" onClick={() => onNavigate('accounts')}>打开账号矩阵</button></div>
      </div>
      <div className="stat-grid compact">
        <StatCard label="知识记录" value={loading ? '-' : items.length} hint="全部可复用记忆" />
        <StatCard label="账号报告" value={loading ? '-' : data.accountReports.length} hint="Account Brain" />
        <StatCard label="内容记忆" value={loading ? '-' : data.contentMemory.length} hint="Hook、CTA 与风格" />
        <StatCard label="策略记忆" value={loading ? '-' : data.strategyMemory.length} hint="策略胜负与复盘" />
      </div>
      <div className="filter-bar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号、Hook、关键词、策略或洞察" /></div>
      {filtered.length ? (
        <div className="analysis-list">
          {filtered.slice(0, 60).map((item, index) => (
            <article className="analysis-card" key={item.id || index}>
              <div className="card-meta"><span>{item.entry_type || item.type || item.category || 'knowledge'}</span><span>{formatDate(item.updated_at || item.created_at)}</span></div>
              <h3>{item.title || item.name || item.account_name || item.username || '知识记录'}</h3>
              <p>{displayText(item.summary || item.content || item.insight || item.report || item.memory || item.description, '结构化知识已保存')}</p>
            </article>
          ))}
        </div>
      ) : <EmptyState title="暂无匹配知识" description="账号分析、策略批准和发布复盘后，知识会自动沉淀到这里。" />}
    </section>
  );
}
