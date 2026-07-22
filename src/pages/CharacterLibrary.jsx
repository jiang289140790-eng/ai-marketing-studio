import { useCallback, useEffect, useState } from 'react';
import { CharacterForm } from '../components/CharacterForm';
import { EmptyState } from '../components/EmptyState';
import { createCharacter, deleteCharacter, listCharacters, updateCharacter } from '../services/character-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

export function CharacterLibrary({ userId }) {
  const [characters, setCharacters] = useState([]);
  const [filters, setFilters] = useState({ search: '', tag: '' });
  const [isCreating, setIsCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setCharacters(await listCharacters(userId, filters));
  }, [userId, filters]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  async function handleSave(payload) {
    try {
      if (editing) {
        await updateCharacter(editing.id, payload);
        setMessage('角色已更新。');
      } else {
        await createCharacter(userId, payload);
        setMessage('角色已创建。');
      }
      setEditing(null);
      setIsCreating(false);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleDelete(character) {
    try {
      await deleteCharacter(character.id);
      if (selected?.id === character.id) setSelected(null);
      setMessage('角色已删除。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Character Brain</p>
          <h2>角色库</h2>
          <p>保存角色设定、外观、性格、Prompt 和 LoRA。未来 Asset Factory 会根据角色自动选择 LoRA、Workflow 和生成参数。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setIsCreating(true)} disabled={!isSupabaseConfigured || !userId}>
          新建角色
        </button>
      </div>

      <div className="filter-bar">
        <input placeholder="搜索角色、描述、性格" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <input placeholder="标签" value={filters.tag} onChange={(event) => setFilters({ ...filters, tag: event.target.value })} />
      </div>

      {(isCreating || editing) && (
        <CharacterForm
          initialValue={editing}
          onSubmit={handleSave}
          onCancel={() => {
            setIsCreating(false);
            setEditing(null);
          }}
        />
      )}

      {message && <div className={/失败|error|failed/i.test(message) ? 'notice error' : 'notice'}>{message}</div>}

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后这里会读取你的真实角色资产。" />
      ) : !userId ? (
        <EmptyState title="请先登录" description="登录后才能读取和管理你的角色库。" />
      ) : characters.length === 0 ? (
        <EmptyState title="暂无角色" description="创建第一个 AI 角色，用来沉淀虚拟模特、品牌人物或内容 IP。" />
      ) : (
        <div className="asset-grid">
          {characters.map((character) => (
            <article className="asset-card" key={character.id}>
              <button className="card-open" type="button" onClick={() => setSelected(character)}>查看</button>
              {character.avatar ? <img src={character.avatar} alt="" /> : <div className="prompt-card">{character.name.slice(0, 2)}</div>}
              <div>
                <h3>{character.name}</h3>
                <p>{character.description || character.personality || '暂无描述'}</p>
                <div className="tag-row">
                  {(character.tags || []).map((tag) => <span key={tag} className="tag">{tag}</span>)}
                </div>
                <small>{formatDate(character.created_at)}</small>
                <div className="table-actions">
                  <button type="button" onClick={() => setEditing(character)}>编辑</button>
                  <button type="button" onClick={() => handleDelete(character)}>删除</button>
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
              <p className="eyebrow">Character Detail</p>
              <h2>{selected.name}</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setSelected(null)}>关闭</button>
          </div>
          <dl>
            <div><dt>LoRA</dt><dd>{selected.lora || '—'}</dd></div>
            <div><dt>创建时间</dt><dd>{formatDate(selected.created_at)}</dd></div>
          </dl>
          <p><strong>描述：</strong>{selected.description || '—'}</p>
          <p><strong>性格：</strong>{selected.personality || '—'}</p>
          <p><strong>外观：</strong>{selected.appearance || '—'}</p>
          <p className="draft-preview">{selected.prompt || '暂无角色 Prompt'}</p>
        </aside>
      )}
    </section>
  );
}
