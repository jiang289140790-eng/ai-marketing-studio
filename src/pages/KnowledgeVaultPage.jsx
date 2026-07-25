import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { listKnowledgeHistory } from '../services/knowledge-governance-service';
import { readRows } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import { formatDate } from '../utils/formatters';
import {
  findKnowledgeDuplicates,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_STATUS_LABELS,
  normalizeKnowledge,
  sanitizeAdvancedKnowledgeData,
  summarizeKnowledge,
} from '../utils/knowledge-governance';

const PAGE_SIZE = 24;
const DETAIL_TABS = [
  ['conclusion', '结论'],
  ['evidence', '证据'],
  ['source', '来源'],
  ['scope', '适用范围'],
  ['relations', '关联对象'],
  ['usage', '使用历史'],
  ['versions', '版本历史'],
  ['advanced', '高级数据'],
];

function sourceClass(source) {
  if (source.id === 'x_native') return 'source-native';
  if (source.id === 'human_approved') return 'source-human';
  if (source.id === 'external_inference') return 'source-inference';
  return 'source-other';
}

function confidenceLabel(value) {
  if (value == null) return '待评估';
  return `${value}%`;
}

function scopeLabel(item, campaignContext) {
  const values = [
    ...item.platforms,
    ...item.accounts,
    ...item.campaigns,
  ].filter(Boolean);
  if (values.length) return values.slice(0, 3).join(' · ');
  if (item.campaign_id && String(item.campaign_id) === String(campaignContext?.campaign?.id)) {
    return campaignContext?.campaign?.name || '当前运营活动';
  }
  return '通用范围';
}

function readableEvidence(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => readableEvidence(item)).flat().filter(Boolean);
  if (typeof value === 'string') return [value];
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, entry]) => `${key}：${typeof entry === 'object' ? JSON.stringify(entry) : entry}`);
  }
  return [String(value)];
}

export function KnowledgeVaultPage({
  activeCampaignId,
  auxiliaryMode = 'normal',
  campaignContext,
  dataScope = 'campaign',
  userId,
  onNavigate,
}) {
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [showTechnical, setShowTechnical] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [detailTab, setDetailTab] = useState('conclusion');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    readRows('knowledge', { limit: 500 })
      .then((nextRows) => {
        if (!cancelled) setRows(nextRows);
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError.message || '知识记录读取失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [userId]);

  const normalizedAll = useMemo(() => rows.map(normalizeKnowledge), [rows]);
  const scopedRows = useMemo(() => filterRecordsForAuxiliaryScope(rows, {
    scope: dataScope,
    campaignContext,
    activeCampaignId,
  }), [activeCampaignId, campaignContext, dataScope, rows]);
  const scopedItems = useMemo(() => scopedRows.map(normalizeKnowledge), [scopedRows]);
  const summary = useMemo(() => summarizeKnowledge(normalizedAll), [normalizedAll]);
  const duplicateMap = useMemo(() => findKnowledgeDuplicates(normalizedAll), [normalizedAll]);

  const mainItems = useMemo(() => scopedItems.filter((item) => (
    !item.excludedFromMain
    || (auxiliaryMode === 'advanced' && showTechnical)
    || dataScope === 'test'
  )), [auxiliaryMode, dataScope, scopedItems, showTechnical]);

  const categoryCounts = useMemo(() => mainItems.reduce((result, item) => {
    result[item.category] = (result[item.category] || 0) + 1;
    return result;
  }, {}), [mainItems]);

  const sourceOptions = useMemo(() => (
    [...new Map(mainItems.map((item) => [item.source.id, item.source])).values()]
  ), [mainItems]);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return mainItems
      .filter((item) => (
        (activeCategory === 'all' || item.category === activeCategory)
        && (statusFilter === 'all' || item.status === statusFilter)
        && (sourceFilter === 'all' || item.source.id === sourceFilter)
        && (!needle || [
          item.title,
          item.conclusion,
          item.source.label,
          ...item.tags,
        ].join(' ').toLocaleLowerCase().includes(needle))
      ))
      .sort((a, b) => {
        const aCurrent = String(a.campaign_id || '') === String(activeCampaignId || '');
        const bCurrent = String(b.campaign_id || '') === String(activeCampaignId || '');
        if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
        return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
      });
  }, [activeCampaignId, activeCategory, mainItems, query, sourceFilter, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const visibleItems = filteredItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [activeCategory, dataScope, query, sourceFilter, statusFilter]);

  useEffect(() => {
    if (!selected?.id || !userId) {
      setHistory([]);
      return;
    }
    listKnowledgeHistory(userId, selected.id).then(setHistory).catch((nextError) => setMessage(nextError.message));
  }, [selected?.id, userId]);

  function openDetail(item, tab = 'conclusion') {
    setSelected(item);
    setDetailTab(tab);
  }

  function explainProtectedAction(action) {
    setMessage(`${action}需要通过可信执行网关写入。目前数据库仅开放知识读取权限，因此没有绕过 RLS 直接修改。`);
  }

  function openApplicationTarget(target) {
    setMessage('已为你保留知识来源和当前 Campaign；正式应用前仍需在目标页面人工确认。');
    onNavigate(target === 'strategy' ? 'campaigns' : 'workspace');
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能读取知识库。" />;
  }

  return (
    <section className="page-stack knowledge-governance-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">知识库语义治理</p>
          <h2>只保留能够复用的业务结论</h2>
          <p>素材、任务、运行日志和原始 API 响应仍保留在数据库，但默认回到各自业务页面，不再混入知识主列表。</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate('analytics')}>从 AI 复盘沉淀知识</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('intelligence')}>查看内容情报</button>
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="已验证知识" value={loading ? '—' : summary.verified} hint="有明确验证或人工批准" />
        <StatCard label="待验证假设" value={loading ? '—' : summary.pending} hint="初步信号与待验证结论" />
        <StatCard label="即将过期" value={loading ? '—' : summary.expiring} hint="已过期或 30 天内过期" />
        <StatCard label="测试记录" value={loading ? '—' : summary.test} hint="默认隐藏，可切换测试数据查看" />
      </div>

      <div className="knowledge-governance-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索结论、来源、标签或适用范围"
        />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="all">全部知识状态</option>
          {Object.entries(KNOWLEDGE_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
          <option value="all">全部来源</option>
          {sourceOptions.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
        </select>
        {auxiliaryMode === 'advanced' && (
          <label className="technical-record-toggle">
            <input type="checkbox" checked={showTechnical} onChange={(event) => setShowTechnical(event.target.checked)} />
            显示当前范围的技术归档
          </label>
        )}
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="notice error">{error}</div>}

      <div className="knowledge-governance-layout">
        <aside className="knowledge-category-sidebar">
          <button className={activeCategory === 'all' ? 'active' : ''} type="button" onClick={() => setActiveCategory('all')}>
            <span>全部知识</span><strong>{mainItems.length}</strong>
          </button>
          {KNOWLEDGE_CATEGORIES.map((category) => (
            <button
              className={activeCategory === category.id ? 'active' : ''}
              key={category.id}
              type="button"
              onClick={() => setActiveCategory(category.id)}
            >
              <span>{category.label}</span><strong>{categoryCounts[category.id] || 0}</strong>
            </button>
          ))}
          <div className="knowledge-governance-note">
            <strong>当前主列表已排除</strong>
            <span>素材与文件：{normalizedAll.filter((item) => item.exclusionReason === '技术或素材记录').length}</span>
            <span>测试记录：{summary.test}</span>
            <small>历史数据没有被删除。</small>
          </div>
        </aside>

        <main className="knowledge-semantic-list">
          <div className="knowledge-list-summary">
            <div>
              <strong>{filteredItems.length} 条可复用知识</strong>
              <span>每页最多 {PAGE_SIZE} 条，当前 Campaign 相关内容优先</span>
            </div>
            {duplicateMap.size > 0 && <span>{duplicateMap.size} 条存在疑似重复候选</span>}
          </div>

          {!loading && visibleItems.length ? visibleItems.map((item) => {
            const category = KNOWLEDGE_CATEGORIES.find((entry) => entry.id === item.category);
            const duplicates = duplicateMap.get(item.id) || [];
            return (
              <article className="knowledge-semantic-card" key={item.id}>
                <button className="card-open" type="button" onClick={() => openDetail(item)}>查看详情</button>
                <div className="card-meta">
                  <span>{category?.label || '内容知识'}</span>
                  <span className={`knowledge-source-badge ${sourceClass(item.source)}`}>{item.source.label}</span>
                  <span className={`knowledge-status-badge status-${item.status}`}>{KNOWLEDGE_STATUS_LABELS[item.status]}</span>
                </div>
                <h3>{item.title}</h3>
                <p>{item.conclusion || '这条知识尚未形成可读结论。'}</p>
                <div className="knowledge-card-footer">
                  <span>置信度：{confidenceLabel(item.confidence)}</span>
                  <span>适用范围：{scopeLabel(item, campaignContext)}</span>
                  <span>更新：{formatDate(item.updatedAt)}</span>
                  {duplicates.length > 0 && <button type="button" onClick={() => openDetail(item, 'relations')}>疑似重复 {duplicates.length}</button>}
                </div>
              </article>
            );
          }) : !loading && !error ? (
            <EmptyState
              title="当前范围没有可复用知识"
              reason="记录可能属于素材、生成任务、测试数据，或还未形成可复用结论。"
              prerequisite="先完成当前 Campaign 的内容复盘，或切换到全部历史范围。"
              actionHref="#/analytics"
              actionLabel="前往 AI 复盘"
            />
          ) : null}

          {pageCount > 1 && (
            <div className="knowledge-pagination">
              <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button>
              <span>第 {page} / {pageCount} 页</span>
              <button type="button" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>下一页</button>
            </div>
          )}
        </main>
      </div>

      {selected && (
        <aside className="detail-panel knowledge-detail-drawer">
          <div className="section-head">
            <div>
              <p className="eyebrow">知识详情</p>
              <h2>{selected.title}</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setSelected(null)}>关闭</button>
          </div>
          <div className="capability-tabs detail-tabs">
            {DETAIL_TABS.map(([value, label]) => (
              <button
                className={detailTab === value ? 'active' : ''}
                key={value}
                type="button"
                onClick={() => setDetailTab(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {detailTab === 'conclusion' && (
            <div className="knowledge-conclusion-panel">
              <p>{selected.conclusion}</p>
              <dl className="business-detail-list">
                <div><dt>类型</dt><dd>{KNOWLEDGE_CATEGORIES.find((entry) => entry.id === selected.category)?.label}</dd></div>
                <div><dt>状态</dt><dd>{KNOWLEDGE_STATUS_LABELS[selected.status]}</dd></div>
                <div><dt>置信度</dt><dd>{confidenceLabel(selected.confidence)}</dd></div>
                <div><dt>样本数</dt><dd>{selected.sampleCount || '未记录'}</dd></div>
                <div><dt>最后验证</dt><dd>{selected.lastValidatedAt ? formatDate(selected.lastValidatedAt) : '尚未验证'}</dd></div>
                <div><dt>最后使用</dt><dd>{selected.lastUsedAt ? formatDate(selected.lastUsedAt) : '尚未应用'}</dd></div>
              </dl>
            </div>
          )}
          {detailTab === 'evidence' && (
            <div className="knowledge-evidence-list">
              {readableEvidence(selected.evidence).length
                ? readableEvidence(selected.evidence).map((evidence, index) => <p key={`${selected.id}-evidence-${index}`}>{evidence}</p>)
                : <p>当前条目没有结构化证据，请在标记“已验证”前补充来源和样本。</p>}
            </div>
          )}
          {detailTab === 'source' && (
            <dl className="business-detail-list">
              <div><dt>来源</dt><dd>{selected.source.label}</dd></div>
              <div><dt>数据类型</dt><dd>{selected.source.evidenceType}</dd></div>
              <div><dt>直接证据</dt><dd>{selected.source.direct ? '是' : '否，属于推断或待确认来源'}</dd></div>
              <div><dt>来源引用</dt><dd>{selected.sourceRef || '未记录'}</dd></div>
            </dl>
          )}
          {detailTab === 'scope' && (
            <dl className="business-detail-list">
              <div><dt>适用平台</dt><dd>{selected.platforms.join('、') || '通用'}</dd></div>
              <div><dt>适用账号</dt><dd>{selected.accounts.join('、') || campaignContext?.primaryAccount?.account_name || '通用'}</dd></div>
              <div><dt>适用 Campaign</dt><dd>{selected.campaigns.join('、') || (selected.campaign_id ? campaignContext?.campaign?.name : '通用')}</dd></div>
            </dl>
          )}
          {detailTab === 'relations' && (
            <div className="knowledge-relation-panel">
              <pre>{JSON.stringify(selected.relatedObjects || {}, null, 2)}</pre>
              {(duplicateMap.get(selected.id) || []).length ? (
                <>
                  <strong>检测到 {(duplicateMap.get(selected.id) || []).length} 条疑似重复知识</strong>
                  <p>系统只提示合并，不会自动删除或覆盖任何历史记录。</p>
                  <button type="button" onClick={() => setMessage('重复候选已标记。请人工比较证据后再决定是否合并；本次未删除记录。')}>标记为待人工合并</button>
                </>
              ) : <p>没有检测到同标题、同来源引用、同内容哈希或同结论来源的重复项。</p>}
            </div>
          )}
          {detailTab === 'usage' && (
            <div className="knowledge-history-list">
              {history.filter((entry) => /suggest|apply|use/i.test(entry.action)).length
                ? history.filter((entry) => /suggest|apply|use/i.test(entry.action)).map((entry) => (
                  <article key={entry.id}><strong>{entry.action}</strong><span>{formatDate(entry.created_at)}</span></article>
                ))
                : <p>这条知识尚未应用到策略或内容。</p>}
            </div>
          )}
          {detailTab === 'versions' && (
            <div className="knowledge-history-list">
              {history.length ? history.map((entry) => (
                <article key={entry.id}><strong>{entry.action}</strong><span>{formatDate(entry.created_at)}</span></article>
              )) : <p>当前只有数据库原始版本，尚无后续变更记录。</p>}
            </div>
          )}
          {detailTab === 'advanced' && (
            auxiliaryMode === 'advanced'
              ? <pre className="knowledge-advanced-json">{JSON.stringify(sanitizeAdvancedKnowledgeData(selected.raw), null, 2)}</pre>
              : <p className="notice">切换页面顶部“高级模式”后可查看已脱敏的原始字段。</p>
          )}

          <div className="knowledge-detail-actions">
            <button className="primary-button" type="button" onClick={() => openApplicationTarget('strategy')}>应用到当前策略</button>
            <button type="button" onClick={() => openApplicationTarget('content')}>应用到下一条内容</button>
            <button type="button" onClick={() => explainProtectedAction('标记已验证')}>标记已验证</button>
            <button type="button" onClick={() => explainProtectedAction('标记待验证')}>标记待验证</button>
            <button type="button" onClick={() => explainProtectedAction('标记过期')}>标记过期</button>
            <button type="button" onClick={() => openDetail(selected, 'relations')}>合并重复知识</button>
            <button type="button" onClick={() => setDetailTab('source')}>查看来源</button>
          </div>
          <p className="knowledge-application-safety">“应用”只创建待审核建议，不会覆盖人工批准策略或直接修改正式内容。</p>
        </aside>
      )}
    </section>
  );
}
