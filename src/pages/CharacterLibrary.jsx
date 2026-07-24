import { useCallback, useEffect, useState } from 'react';
import { CharacterForm } from '../components/CharacterForm';
import { EmptyState } from '../components/EmptyState';
import { useConfirmation } from '../contexts/confirmation-context';
import { createCharacter, deleteCharacter, listCharacters, updateCharacter } from '../services/character-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';
import { hasLoraConfig, loraDisplayName, parseLoraConfig } from '../utils/lora';

export function CharacterLibrary({ userId, detailId, onNavigate }) {
  const { confirm } = useConfirmation();
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

  useEffect(() => {
    if (!detailId || !characters.length) return;
    setSelected(characters.find((character) => String(character.id) === String(detailId)) || null);
  }, [characters, detailId]);

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
    const accepted = await confirm({
      title: '删除角色？',
      message: `将删除“${character.name || '未命名角色'}”及其当前 LoRA 绑定信息。已有生成结果不会被删除。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!accepted) return;
    try {
      await deleteCharacter(character.id);
      if (selected?.id === character.id) {
        setSelected(null);
        onNavigate('characters');
      }
      setMessage('角色已删除。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function editCharacter(character) {
    setSelected(null);
    setIsCreating(false);
    setEditing(character);
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Character Brain</p>
          <h2>角色库</h2>
          <p>保存角色设定、外观、性格、Prompt 和 LoRA。未来 Asset Factory 会根据角色自动选择 LoRA、Workflow 和生成参数。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => {
          setEditing(null);
          setIsCreating(true);
        }} disabled={!isSupabaseConfigured || !userId}>
          新建角色
        </button>
      </div>

      <div className="filter-bar">
        <input placeholder="搜索角色、描述、性格" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <input placeholder="标签" value={filters.tag} onChange={(event) => setFilters({ ...filters, tag: event.target.value })} />
      </div>

      {(isCreating || editing) && (
        <CharacterForm
          key={editing?.id || 'new-character'}
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
        <div className="character-library-grid">
          {characters.map((character) => {
            const hasLora = hasLoraConfig(character.lora);
            const lora = parseLoraConfig(character.lora);
            return (
              <article className="character-card" key={character.id}>
                <button className="card-open" type="button" onClick={() => {
                  setSelected(character);
                  onNavigate('characters', character.id);
                }}>查看详情</button>
                <div className="character-card-media">
                  {character.avatar
                    ? <img src={character.avatar} alt={`${character.name} 角色头像`} />
                    : <div className="character-avatar-fallback">{character.name.slice(0, 2)}</div>}
                </div>
                <div className="character-card-body">
                  <div className="character-card-title">
                    <h3>{character.name}</h3>
                    <span className={`status-badge ${hasLora ? 'connected' : 'pending'}`}>
                      {hasLora ? '已绑定 LoRA' : '未绑定 LoRA'}
                    </span>
                  </div>
                  <p className="character-card-description">{character.description || character.personality || '暂无描述'}</p>
                  <div className="character-lora-summary">
                    <span>LoRA</span>
                    <strong>{loraDisplayName(character.lora)}</strong>
                    {hasLora && <small>权重 {lora.weight ?? 0.8} · {lora.image_enabled ? '图片' : ''}{lora.image_enabled && lora.video_enabled ? ' / ' : ''}{lora.video_enabled ? '视频' : ''}</small>}
                  </div>
                  <div className="tag-row">
                    {(character.tags || []).map((tag) => <span key={tag} className="tag">{tag}</span>)}
                  </div>
                  <small className="character-created-at">{formatDate(character.created_at)}</small>
                  <div className="character-card-actions">
                    <button type="button" onClick={() => editCharacter(character)}>{hasLora ? '编辑角色与 LoRA' : '配置 LoRA'}</button>
                    <button type="button" onClick={() => handleDelete(character)}>删除</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="character-detail-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setSelected(null);
            onNavigate('characters');
          }
        }}>
          <aside className="detail-panel character-detail-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">Character Detail</p>
                <h2>{selected.name}</h2>
              </div>
              <button className="ghost-button" type="button" onClick={() => {
                setSelected(null);
                onNavigate('characters');
              }}>关闭</button>
            </div>
            {selected.avatar && <img className="character-detail-avatar" src={selected.avatar} alt={`${selected.name} 角色头像`} />}
            <CharacterLoraDetails value={selected.lora} />
            <div className="character-detail-copy">
              <p><strong>描述：</strong>{selected.description || '—'}</p>
              <p><strong>性格：</strong>{selected.personality || '—'}</p>
              <p><strong>外观：</strong>{selected.appearance || '—'}</p>
              <p><strong>创建时间：</strong>{formatDate(selected.created_at)}</p>
            </div>
            <div className="character-prompt-block">
              <span>角色 Prompt</span>
              <p className="draft-preview">{selected.prompt || '暂无角色 Prompt'}</p>
            </div>
            <div className="button-row">
              <button className="primary-button" type="button" onClick={() => editCharacter(selected)}>编辑角色与 LoRA</button>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

function CharacterLoraDetails({ value }) {
  const lora = parseLoraConfig(value);
  const configured = hasLoraConfig(value);

  if (!configured) {
    return <div className="notice warning">该角色尚未绑定 LoRA，暂时不能用于角色一致性图片或视频生成。</div>;
  }

  return (
    <section className="character-detail-lora">
      <div className="character-detail-section-title">
        <h3>LoRA 配置</h3>
        <span className="status-badge connected">已绑定</span>
      </div>
      <dl>
        <div><dt>名称</dt><dd>{loraDisplayName(value)}</dd></div>
        <div><dt>模型</dt><dd>{lora.model || '—'}</dd></div>
        <div><dt>版本</dt><dd>{lora.version || '—'}</dd></div>
        <div><dt>文件</dt><dd>{lora.filename || '—'}</dd></div>
        <div><dt>权重</dt><dd>{lora.weight ?? 0.8}</dd></div>
        <div><dt>Workflow</dt><dd>{lora.workflow || '—'}</dd></div>
        <div><dt>生成能力</dt><dd>{lora.image_enabled ? '图片' : ''}{lora.image_enabled && lora.video_enabled ? ' / ' : ''}{lora.video_enabled ? '视频' : ''}</dd></div>
        <div><dt>触发词</dt><dd>{lora.trigger_words || '—'}</dd></div>
      </dl>
    </section>
  );
}
