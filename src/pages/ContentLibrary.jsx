import { useCallback, useEffect, useMemo, useState } from 'react';
import { ContentForm } from '../components/ContentForm';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { accountCategories, contentStatuses, contentTypes, platforms } from '../data/navigation';
import { listAssets } from '../services/asset-service';
import { listCharacters } from '../services/character-service';
import { createContentItem, deleteContentItem, listContent, updateContentItem } from '../services/content-service';
import { generateImageAssetForContent } from '../services/media-gateway-service';
import { listPrompts } from '../services/prompt-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

export function ContentLibrary({ userId }) {
  const [items, setItems] = useState([]);
  const [assets, setAssets] = useState([]);
  const [characters, setCharacters] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const [filters, setFilters] = useState({ search: '', status: '', platform: '', contentType: '', accountCategory: '' });
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [generatingAssetId, setGeneratingAssetId] = useState('');
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    const [nextItems, nextAssets, nextCharacters, nextPrompts] = await Promise.all([
      listContent(userId, filters),
      listAssets(userId),
      listCharacters(userId),
      listPrompts(userId),
    ]);
    setItems(nextItems);
    setAssets(nextAssets);
    setCharacters(nextCharacters);
    setPrompts(nextPrompts);
  }, [userId, filters]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  const title = useMemo(() => (selected ? selected.title : '内容库'), [selected]);

  const stageCounts = useMemo(() => contentStatuses.reduce((map, status) => {
    map[status] = items.filter((item) => (item.pipeline_stage || item.status) === status).length;
    return map;
  }, {}), [items]);

  async function handleSave(payload) {
    try {
      if (editing) {
        await updateContentItem(editing.id, payload);
      } else {
        await createContentItem(userId, payload);
      }
      setEditing(null);
      setIsCreating(false);
      setSelected(null);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleDelete(item) {
    try {
      await deleteContentItem(item.id);
      if (selected?.id === item.id) setSelected(null);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleStageChange(item, stage) {
    try {
      await updateContentItem(item.id, { pipeline_stage: stage, status: stage });
      if (selected?.id === item.id) setSelected({ ...selected, pipeline_stage: stage, status: stage });
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleGenerateAsset(item) {
    setGeneratingAssetId(item.id);
    setMessage('');
    try {
      const result = await generateImageAssetForContent(userId, item);
      setMessage(`素材生成完成：已保存到素材库。Asset ID: ${result.asset_id || '—'}`);
      if (selected?.id === item.id) {
        setSelected({
          ...selected,
          asset_id: result.asset_id || selected.asset_id,
          media_url: result.url || selected.media_url,
        });
      }
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setGeneratingAssetId('');
    }
  }

  function relationSummary(item) {
    return [
      item.assets?.name && `素材：${item.assets.name}`,
      item.characters?.name && `角色：${item.characters.name}`,
      item.prompts?.title && `Prompt：${item.prompts.title}`,
    ].filter(Boolean);
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Content Pipeline</p>
          <h2>{title}</h2>
          <p>从内容情报到选题、生成、审核、排期、发布、分析，所有内容都在这里推进。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setIsCreating(true)} disabled={!isSupabaseConfigured}>
          新建内容
        </button>
      </div>

      <div className="stat-grid compact">
        <StatCard label="想法" value={stageCounts.idea || 0} hint="Content Intelligence → Idea" />
        <StatCard label="生成中" value={stageCounts.generating || 0} hint="Generation Agent / Workflow" />
        <StatCard label="待审核" value={stageCounts.review || 0} hint="发布前检查" />
        <StatCard label="已排期" value={stageCounts.scheduled || 0} hint="进入 Publish Center" />
        <StatCard label="已发布" value={stageCounts.published || 0} hint="等待数据反馈" />
        <StatCard label="分析中" value={stageCounts.analyzing || 0} hint="进入效果分析" />
      </div>

      {(isCreating || editing) && (
        <ContentForm
          initialValue={editing}
          assets={assets}
          characters={characters}
          prompts={prompts}
          onSubmit={handleSave}
          onCancel={() => {
            setIsCreating(false);
            setEditing(null);
          }}
        />
      )}

      {message && <div className="notice error">{message}</div>}

      <div className="filter-bar">
        <input placeholder="搜索标题" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
          <option value="">全部状态</option>
          {contentStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
        </select>
        <select value={filters.platform} onChange={(event) => setFilters({ ...filters, platform: event.target.value })}>
          <option value="">全部平台</option>
          {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
        </select>
        <select value={filters.contentType} onChange={(event) => setFilters({ ...filters, contentType: event.target.value })}>
          <option value="">全部类型</option>
          {contentTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
        </select>
        <select value={filters.accountCategory} onChange={(event) => setFilters({ ...filters, accountCategory: event.target.value })}>
          <option value="">全部账号类型</option>
          {accountCategories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
        </select>
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后这里会显示内容，并支持推进完整内容生产状态。" />
      ) : items.length === 0 ? (
        <EmptyState title="暂无内容" description="从内容情报保存选题，或在 AI Studio / Agent Center 生成第一条内容。" />
      ) : (
        <div className="content-grid">
          {items.map((item) => (
            <article className="content-card" key={item.id}>
              <button className="card-open" type="button" onClick={() => setSelected(item)}>查看详情</button>
              {item.media_url ? (
                item.content_type === 'video' ? <video src={item.media_url} /> : <img src={item.media_url} alt="" />
              ) : (
                <div className="media-placeholder">No Media</div>
              )}
              <div>
                <div className="card-meta">
                  <span>{item.platform || '未选平台'}</span>
                  <span>{contentTypes.find((type) => type.value === item.content_type)?.label || item.content_type}</span>
                  <span>{accountCategories.find((category) => category.value === item.account_category)?.label || '品牌账号'}</span>
                  <StatusBadge status={item.pipeline_stage || item.status} />
                </div>
                <h3>{item.title}</h3>
                <p>{item.content_text || item.idea_notes || '暂无正文'}</p>
                <div className="tag-row">
                  {relationSummary(item).map((label) => <span key={label} className="tag">{label}</span>)}
                </div>
                <small>{formatDate(item.created_at)}</small>
                <div className="table-actions">
                  <button type="button" onClick={() => setEditing(item)}>编辑</button>
                  <button type="button" onClick={() => handleGenerateAsset(item)} disabled={generatingAssetId === item.id}>
                    {generatingAssetId === item.id ? '生成中...' : '生成素材'}
                  </button>
                  <button type="button" onClick={() => handleDelete(item)}>删除</button>
                </div>
                <div className="status-actions" aria-label="内容状态管理">
                  {contentStatuses.map((status) => (
                    <button key={status} type="button" className={(item.pipeline_stage || item.status) === status ? 'active' : ''} onClick={() => handleStageChange(item, status)}>
                      {statusLabel(status)}
                    </button>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {selected && (
        <aside className="detail-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Content Detail</p>
              <h2>{selected.title}</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setSelected(null)}>关闭</button>
          </div>
          <p>{selected.content_text || selected.idea_notes || '暂无正文'}</p>
          <dl>
            <div><dt>平台</dt><dd>{selected.platform || '—'}</dd></div>
            <div><dt>类型</dt><dd>{contentTypes.find((type) => type.value === selected.content_type)?.label || selected.content_type}</dd></div>
            <div><dt>账号类型</dt><dd>{accountCategories.find((category) => category.value === selected.account_category)?.label || '品牌账号'}</dd></div>
            <div><dt>Pipeline</dt><dd><StatusBadge status={selected.pipeline_stage || selected.status} /></dd></div>
            <div><dt>素材</dt><dd>{selected.assets?.name || '—'}</dd></div>
            <div><dt>角色</dt><dd>{selected.characters?.name || '—'}</dd></div>
            <div><dt>Prompt</dt><dd>{selected.prompts?.title || '—'}</dd></div>
            <div><dt>发布链接</dt><dd>{selected.published_url ? <a href={selected.published_url} target="_blank" rel="noreferrer">打开</a> : '—'}</dd></div>
            <div><dt>创建时间</dt><dd>{formatDate(selected.created_at)}</dd></div>
          </dl>
        </aside>
      )}
    </section>
  );
}
