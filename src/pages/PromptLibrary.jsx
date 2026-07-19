import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { PromptForm } from '../components/PromptForm';
import { platforms, promptCategories } from '../data/navigation';
import { listCharacters } from '../services/character-service';
import { createPrompt, deletePrompt, listPrompts, updatePrompt } from '../services/prompt-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

export function PromptLibrary({ userId }) {
  const [prompts, setPrompts] = useState([]);
  const [characters, setCharacters] = useState([]);
  const [filters, setFilters] = useState({ search: '', category: '', platform: '', character: '' });
  const [isCreating, setIsCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    const [nextPrompts, nextCharacters] = await Promise.all([
      listPrompts(userId, filters),
      listCharacters(userId),
    ]);
    setPrompts(nextPrompts);
    setCharacters(nextCharacters);
  }, [userId, filters]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  async function handleSave(payload) {
    try {
      if (editing) {
        await updatePrompt(editing.id, payload);
      } else {
        await createPrompt(userId, payload);
      }
      setEditing(null);
      setIsCreating(false);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleDelete(prompt) {
    try {
      await deletePrompt(prompt.id);
      if (selected?.id === prompt.id) setSelected(null);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Prompt Library</p>
          <h2>Prompt 库</h2>
          <p>沉淀文本、图像、视频、分析和 Workflow Prompt，可关联角色与平台。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setIsCreating(true)} disabled={!isSupabaseConfigured}>
          新建 Prompt
        </button>
      </div>

      <div className="filter-bar">
        <input placeholder="搜索标题或内容" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
          <option value="">全部分类</option>
          {promptCategories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
        </select>
        <select value={filters.platform} onChange={(event) => setFilters({ ...filters, platform: event.target.value })}>
          <option value="">全部平台</option>
          {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
        </select>
        <select value={filters.character} onChange={(event) => setFilters({ ...filters, character: event.target.value })}>
          <option value="">全部角色</option>
          {characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
        </select>
      </div>

      {(isCreating || editing) && (
        <PromptForm
          initialValue={editing}
          characters={characters}
          onSubmit={handleSave}
          onCancel={() => {
            setIsCreating(false);
            setEditing(null);
          }}
        />
      )}

      {message && <div className="notice error">{message}</div>}

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后这里会从 prompts 表读取 Prompt。" />
      ) : prompts.length === 0 ? (
        <EmptyState title="暂无 Prompt" description="保存你的第一条营销 Prompt，后续可直接用于 AI Studio。" />
      ) : (
        <div className="analysis-list">
          {prompts.map((prompt) => (
            <article className="analysis-card" key={prompt.id}>
              <button className="card-open" type="button" onClick={() => setSelected(prompt)}>查看</button>
              <div className="card-meta">
                <span>{promptCategories.find((category) => category.value === prompt.category)?.label || prompt.category}</span>
                <span>{prompt.platform || '通用平台'}</span>
                {prompt.characters?.name && <span>{prompt.characters.name}</span>}
              </div>
              <h3>{prompt.title}</h3>
              <p>{prompt.content}</p>
              <small>{formatDate(prompt.created_at)}</small>
              <div className="table-actions">
                <button type="button" onClick={() => setEditing(prompt)}>编辑</button>
                <button type="button" onClick={() => handleDelete(prompt)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      )}

      {selected && (
        <aside className="detail-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Prompt Detail</p>
              <h2>{selected.title}</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setSelected(null)}>关闭</button>
          </div>
          <p className="draft-preview">{selected.content}</p>
        </aside>
      )}
    </section>
  );
}
