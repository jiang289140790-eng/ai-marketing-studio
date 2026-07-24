import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { displayText, normalizeList, readRows } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const TYPE_FILTERS = [
  { id: 'all', label: '全部' }, { id: 'account', label: '账号' },
  { id: 'character', label: '角色' }, { id: 'content', label: '内容' },
  { id: 'strategy', label: '策略' }, { id: 'insight', label: '洞察' },
  { id: 'campaign', label: '运营活动' }, { id: 'research', label: '研究' },
];

function getTypeGroup(item) {
  const type = String(item.type || item.entry_type || item.category || '').toLowerCase();
  if (type.includes('account')) return 'account';
  if (type.includes('character')) return 'character';
  if (type.includes('strategy')) return 'strategy';
  if (type.includes('campaign')) return 'campaign';
  if (type.includes('research')) return 'research';
  if (type.includes('insight')) return 'insight';
  return 'content';
}

function getContent(item) {
  const value = item.content || item.summary || item.description || item.insight || item.metadata?.summary || '';
  return readableValue(value);
}

function readableValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return readableValue(JSON.parse(trimmed)); } catch { /* 保留普通文本 */ }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => readableValue(entry)).filter(Boolean).join('；');
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined && entry !== '')
      .map(([key, entry]) => `${friendlyKey(key)}：${readableValue(entry)}`)
      .join('\n');
  }
  return String(value);
}

function friendlyKey(key) {
  const labels = {
    hook: '开场钩子', cta: '行动引导', summary: '摘要', keywords: '关键词', tags: '标签',
    language_style: '语言风格', replicate_strategy: '可复刻策略', next_action: '下一步',
    source: '来源', importance: '重要性', campaign: '运营活动', account: '关联账号',
  };
  return labels[key] || String(key).replaceAll('_', ' ');
}

function getTags(item) {
  const source = item.metadata?.tags ?? item.tags ?? item.metadata?.keywords ?? item.keywords ?? [];
  return normalizeList(source).map((tag) => (typeof tag === 'object' ? tag.name || tag.label : tag)).filter(Boolean);
}

function getSearchText(item) {
  return [autoTitle(item), item.type, getContent(item), ...getTags(item), readableValue(item.metadata || {})]
    .filter(Boolean).join(' ').toLocaleLowerCase();
}

function autoTitle(item) {
  const explicit = String(item.title || '').trim();
  if (explicit && !/^(未命名(?:记录)?|untitled|knowledge|new entry|记录|运营记录|分析记录)$/i.test(explicit)) return explicit;
  const meta = item.metadata || {};
  const account = item.account_name || item.source_account || meta.account_name || meta.handle;
  const topic = item.topic || meta.topic || meta.subject || getTags(item)[0];
  const groupLabel = TYPE_FILTERS.find((filter) => filter.id === getTypeGroup(item))?.label || '知识';
  const contentHint = getContent(item).replace(/\s+/g, ' ').trim().slice(0, 36);
  return [account, topic, groupLabel].filter(Boolean).join(' · ') || (contentHint ? `${groupLabel} · ${contentHint}` : `${groupLabel}知识条目`);
}

function getSource(item) {
  const meta = item.metadata || {};
  return String(item.source || item.source_type || meta.source || meta.origin || '').trim();
}

function getAccount(item) {
  const meta = item.metadata || {};
  return String(item.account_name || item.source_account || meta.account_name || meta.handle || item.account_id || '').trim();
}

function getBusinessDetails(item) {
  const meta = item.metadata || {};
  return [
    ['来源', item.source || item.source_type || meta.source || meta.origin],
    ['关联账号', item.account_name || item.source_account || meta.account_name || meta.handle || item.account_id],
    ['运营活动', item.campaign_name || meta.campaign_name || item.campaign_id],
    ['类型', item.type || item.entry_type || item.category || getTypeGroup(item)],
    ['重要性', item.importance || item.priority || meta.importance || meta.priority || meta.score],
    ['可复刻策略', item.replicate_strategy || meta.replicate_strategy || meta.reusable_strategy || meta.winner_rule],
    ['下一步', item.next_action || item.recommendation || meta.next_action || meta.recommendation],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
}

export function KnowledgeVaultPage({ userId, onNavigate }) {
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    readRows('knowledge', { limit: 500 })
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((nextError) => { if (!cancelled) setError(nextError.message || '知识记录读取失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  const counts = useMemo(() => items.reduce((result, item) => {
    const group = getTypeGroup(item);
    result[group] = (result[group] || 0) + 1;
    return result;
  }, {}), [items]);

  const sourceOptions = useMemo(() => [...new Set(items.map(getSource).filter(Boolean))].sort(), [items]);
  const accountOptions = useMemo(() => [...new Set(items.map(getAccount).filter(Boolean))].sort(), [items]);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) => (
      (activeType === 'all' || getTypeGroup(item) === activeType)
      && (sourceFilter === 'all' || getSource(item) === sourceFilter)
      && (accountFilter === 'all' || getAccount(item) === accountFilter)
      && (!needle || getSearchText(item).includes(needle))
    ));
  }, [accountFilter, activeType, items, query, sourceFilter]);

  if (!userId) return <EmptyState title="请先登录" description="登录后才能读取知识库与智能体运营记忆。" />;

  return (
    <section className="page-stack knowledge-vault-page">
      <div className="hero-panel knowledge-vault-hero">
        <div>
          <p className="eyebrow">知识库与智能体记忆</p>
          <h2>把账号、内容、策略与研究结果变成智能体可复用的知识</h2>
          <p>这里显示业务摘要、来源、关联账号、重要性、可复刻策略和下一步，不再把原始 JSON 直接摊给你。</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate('accounts')}>打开账号矩阵</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('analytics')}>查看分析优化</button>
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="知识记录" value={loading ? '-' : items.length} hint="从数据服务实时读取" />
        <StatCard label="当前结果" value={loading ? '-' : filteredItems.length} hint="搜索与分类筛选结果" />
        <StatCard label="知识类型" value={loading ? '-' : Object.keys(counts).length} hint="账号、内容、策略、研究等" />
        <StatCard label="最新写入" value={loading || !items[0] ? '-' : formatDate(items[0].created_at || items[0].updated_at)} hint="按数据返回顺序" />
      </div>

      <div className="knowledge-toolbar">
        <label className="knowledge-search"><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号、开场钩子、关键词、策略或研究报告…" /></label>
        <div className="knowledge-selectors">
          <label><span>来源</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">全部来源</option>{sourceOptions.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
          <label><span>账号</span><select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}><option value="all">全部账号</option>{accountOptions.map((account) => <option key={account} value={account}>{account}</option>)}</select></label>
        </div>
        <div className="knowledge-type-filters" aria-label="知识类型筛选">
          {TYPE_FILTERS.map((filter) => {
            const count = filter.id === 'all' ? items.length : (counts[filter.id] || 0);
            return <button className={activeType === filter.id ? 'active' : ''} key={filter.id} type="button" onClick={() => setActiveType(filter.id)}>{filter.label}<span>{count}</span></button>;
          })}
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {!loading && filteredItems.length > 0 ? (
        <div className="knowledge-grid">
          {filteredItems.map((item, index) => {
            const itemId = item.id || `${item.type || 'knowledge'}-${index}`;
            const content = getContent(item);
            const tags = getTags(item);
            const details = getBusinessDetails(item);
            const expanded = expandedId === itemId;
            const preview = content.length > 260 ? `${content.slice(0, 260)}…` : content;

            return (
              <article className={`knowledge-card${expanded ? ' expanded' : ''}`} key={itemId}>
                <div className="knowledge-card-topline"><span className={`knowledge-type-badge type-${getTypeGroup(item)}`}>{item.type || getTypeGroup(item)}</span><time>{formatDate(item.created_at || item.updated_at)}</time></div>
                <h3>{autoTitle(item)}</h3>
                <p className="knowledge-content">{expanded ? content : preview || '这条记录暂时没有正文摘要。'}</p>
                <div className="knowledge-business-details">
                  {details.map(([label, value]) => <div key={label}><span>{label}</span><strong>{displayText(value)}</strong></div>)}
                </div>
                {tags.length > 0 && <div className="knowledge-tags">{tags.slice(0, expanded ? tags.length : 8).map((tag) => <span key={String(tag)}>#{tag}</span>)}</div>}
                {(content.length > 260 || details.length > 4) && <button className="knowledge-expand" type="button" onClick={() => setExpandedId(expanded ? null : itemId)}>{expanded ? '收起详情' : '展开详情'}</button>}
              </article>
            );
          })}
        </div>
      ) : !loading && !error ? <EmptyState title="没有匹配的知识" description="尝试更换关键词或类型；MCP 新写入的知识也会在这里显示。" /> : null}
    </section>
  );
}
