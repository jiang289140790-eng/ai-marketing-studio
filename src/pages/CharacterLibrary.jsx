import { useCallback, useEffect, useMemo, useState } from 'react';
import { CharacterForm } from '../components/CharacterForm';
import { EmptyState } from '../components/EmptyState';
import { MoreActionsMenu } from '../components/MoreActionsMenu';
import { StatusBadge } from '../components/StatusBadge';
import { useConfirmation } from '../contexts/confirmation-context';
import { createCharacter, deleteCharacter, updateCharacter } from '../services/character-service';
import { getAssets, loadWorkflowConfigData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import {
  characterStatusClass,
  evaluateCharacterReadiness,
} from '../utils/character-generation-readiness';
import { formatDate } from '../utils/formatters';

const DETAIL_TABS = [
  ['profile', '角色设定'],
  ['visual', '视觉身份'],
  ['lora', 'LoRA 与模型'],
  ['references', '参考图'],
  ['accounts', '绑定账号'],
  ['workflows', '工作流'],
  ['tests', '生成测试'],
  ['history', '版本历史'],
];

export function CharacterLibrary({
  activeCampaignId,
  auxiliaryMode = 'normal',
  campaignContext,
  dataScope = 'campaign',
  userId,
  detailId,
  onNavigate,
}) {
  const { confirm } = useConfirmation();
  const [data, setData] = useState({ characters: [], accounts: [], comfyWorkflows: [], workflowRuns: [], assets: [], legacyAssets: [] });
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selectedId, setSelectedId] = useState(detailId || '');
  const [detailTab, setDetailTab] = useState('profile');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await loadWorkflowConfigData();
      const scopeOptions = { scope: dataScope, campaignContext, activeCampaignId, includeGlobal: true };
      setData({
        ...next,
        characters: filterRecordsForAuxiliaryScope(next.characters, scopeOptions),
        accounts: filterRecordsForAuxiliaryScope(next.accounts, scopeOptions),
        workflowRuns: filterRecordsForAuxiliaryScope(next.workflowRuns, scopeOptions),
        legacyAssets: filterRecordsForAuxiliaryScope(next.legacyAssets, scopeOptions),
      });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [activeCampaignId, campaignContext, dataScope, userId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (detailId) setSelectedId(detailId); }, [detailId]);

  const assets = useMemo(() => getAssets(data), [data]);
  const characterRows = useMemo(() => data.characters
    .map((character) => ({
      character,
      readiness: evaluateCharacterReadiness(character, {
        accounts: data.accounts,
        assets,
        workflows: data.comfyWorkflows,
        runs: data.workflowRuns,
      }),
    }))
    .filter(({ character }) => {
      const text = `${character.name} ${character.description || ''} ${character.personality || ''}`.toLowerCase();
      return !search || text.includes(search.toLowerCase());
    }), [assets, data, search]);
  const selectedRow = characterRows.find(({ character }) => String(character.id) === String(selectedId)) || null;

  async function saveCharacter(payload) {
    try {
      if (editing) await updateCharacter(editing.id, payload);
      else await createCharacter(userId, payload);
      setMessage(editing ? '角色已更新。' : '角色已创建。');
      setEditing(null);
      setCreating(false);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function removeCharacter(character) {
    const accepted = await confirm({
      title: '删除角色？',
      message: `将删除“${character.name || '未命名角色'}”的持续生成身份和模型绑定。已有生成任务与素材不会删除。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!accepted) return;
    try {
      await deleteCharacter(character.id);
      setSelectedId('');
      setMessage('角色已删除。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function openDetail(character) {
    setSelectedId(character.id);
    setDetailTab('profile');
    onNavigate?.('characters', character.id);
  }

  return (
    <section className="page-stack character-asset-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">持续生成身份</p>
          <h2>角色库</h2>
          <p>角色库只管理长期复用的人物身份、视觉规范、LoRA 和推荐工作流；生成过程进入生成任务，真实文件进入素材库。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setCreating(true)}>新建角色</button>
      </div>

      <div className="filter-bar">
        <input placeholder="搜索角色、定位或性格" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {(creating || editing) && (
        <CharacterForm
          key={editing?.id || 'new-character'}
          initialValue={editing}
          onSubmit={saveCharacter}
          onCancel={() => { setCreating(false); setEditing(null); }}
        />
      )}
      {message && <div className={/失败|错误|不可用/.test(message) ? 'notice error' : 'notice'}>{message}</div>}

      {loading ? (
        <div className="skeleton-grid">{Array.from({ length: 3 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}</div>
      ) : !isSupabaseConfigured ? (
        <EmptyState title="等待数据服务配置" description="配置后这里会读取角色、LoRA、工作流与验证记录。" />
      ) : !userId ? (
        <EmptyState title="请先登录" description="登录后才能读取和管理角色库。" />
      ) : !characterRows.length ? (
        <EmptyState title="当前范围没有角色" description="请先新建角色，补充角色设定和视觉身份，再绑定 LoRA 与可用工作流。" action={<button className="primary-button" type="button" onClick={() => setCreating(true)}>新建角色</button>} />
      ) : (
        <div className="character-readiness-grid">
          {characterRows.map(({ character, readiness }) => (
            <CharacterReadinessCard
              key={character.id}
              character={character}
              readiness={readiness}
              onDetail={() => openDetail(character)}
              onEdit={() => setEditing(character)}
              onConfigure={() => { setEditing(character); setCreating(false); }}
              onTest={() => onNavigate?.('workspace', '', { character_id: character.id, action: 'generation_test' })}
              onDelete={() => removeCharacter(character)}
            />
          ))}
        </div>
      )}

      {selectedRow && (
        <CharacterDetailDrawer
          character={selectedRow.character}
          readiness={selectedRow.readiness}
          activeTab={detailTab}
          mode={auxiliaryMode}
          onTab={setDetailTab}
          onEdit={() => setEditing(selectedRow.character)}
          onTest={() => onNavigate?.('workspace', '', { character_id: selectedRow.character.id, action: 'generation_test' })}
          onClose={() => { setSelectedId(''); onNavigate?.('characters'); }}
        />
      )}
    </section>
  );
}

function CharacterReadinessCard({ character, readiness, onDetail, onEdit, onConfigure, onTest, onDelete }) {
  const lora = readiness.lora;
  const workflow = readiness.usableWorkflow;
  return (
    <article className="character-readiness-card">
      <div className="character-hero-image">
        {character.avatar
          ? <img src={character.avatar} alt={`${character.name} 角色主图`} />
          : readiness.referenceAssets[0]?.thumbnail
            ? <img src={readiness.referenceAssets[0].thumbnail} alt={`${character.name} 最近验证图`} />
            : <span>{String(character.display_name || character.name || '?').slice(0, 2)}</span>}
        <span className={`readiness-badge ${characterStatusClass(readiness.state)}`}>{readiness.label}</span>
      </div>
      <div className="character-readiness-body">
        <div className="panel-title">
          <div><h3>{character.display_name || character.name}</h3><small>{readiness.boundAccounts.map((account) => account.account_name).join('、') || '尚未绑定账号'}</small></div>
          <StatusBadge status={character.status || 'active'} />
        </div>
        <div className="character-spec-grid">
          <Spec label="LoRA 状态" value={readiness.hasLora ? (readiness.loraAccessible ? '已验证' : '不可访问') : '未绑定'} />
          <Spec label="LoRA 版本" value={lora.version || '—'} />
          <Spec label="基础模型" value={lora.base_model || workflow?.checkpoint || workflow?.model || '—'} />
          <Spec label="触发词" value={lora.trigger_word || lora.trigger_words || '—'} />
          <Spec label="推荐权重" value={lora.recommended_weight ?? lora.weight ?? character.recommended_params?.lora_weight ?? '—'} />
          <Spec label="默认工作流" value={workflow?.name || workflow?.id || '未启用'} />
          <Spec label="最近验证" value={formatDate(readiness.successfulRun?.completed_at || readiness.successfulRun?.created_at)} />
          <Spec label="当前阻塞" value={readiness.blocking} warning={readiness.state !== 'ready'} />
        </div>
        <div className="character-card-actions">
          <button className="primary-button compact" type="button" onClick={readiness.state === 'ready' ? onTest : onConfigure}>{readiness.state === 'ready' ? '生成测试' : '继续配置'}</button>
          <button className="ghost-button compact" type="button" onClick={onEdit}>编辑</button>
          <button className="ghost-button compact" type="button" onClick={onDetail}>查看详情</button>
          <MoreActionsMenu><button className="danger-action" type="button" onClick={onDelete}>删除角色</button></MoreActionsMenu>
        </div>
      </div>
    </article>
  );
}

function CharacterDetailDrawer({ character, readiness, activeTab, mode, onTab, onEdit, onTest, onClose }) {
  const lora = readiness.lora;
  return (
    <aside className="detail-drawer character-generation-drawer">
      <div className="detail-drawer-header">
        <div><p className="eyebrow">角色详情</p><h3>{character.display_name || character.name}</h3><p>{readiness.label} · {readiness.blocking}</p></div>
        <button className="ghost-button" type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="drawer-tabs">
        {DETAIL_TABS.map(([id, label]) => <button className={activeTab === id ? 'active' : ''} type="button" key={id} onClick={() => onTab(id)}>{label}</button>)}
      </div>
      <div className="drawer-body">
        {activeTab === 'profile' && <DetailGrid items={[
          ['人物身份', character.content_positioning || character.description],
          ['性格', character.personality || character.personality_traits],
          ['文案语气', character.prompt_templates?.copy_tone || character.personality],
          ['禁止风格', character.forbidden_styles],
        ]} />}
        {activeTab === 'visual' && <DetailGrid items={[
          ['外观描述', character.appearance],
          ['视觉规范', character.visual_spec],
          ['角色主图', character.avatar ? '已配置' : '未配置'],
          ['适用内容', character.suitable_content_types],
        ]} />}
        {activeTab === 'lora' && <DetailGrid items={[
          ['LoRA', lora.name || lora.model || '未绑定'],
          ['版本', lora.version],
          ['基础模型', lora.base_model || readiness.usableWorkflow?.checkpoint],
          ['触发词', lora.trigger_word || lora.trigger_words],
          ['推荐权重', lora.recommended_weight ?? lora.weight],
          ['可调范围', Array.isArray(lora.weight_range) ? lora.weight_range.join('–') : '—'],
          ['可访问状态', readiness.loraAccessible ? '可访问' : '不可用'],
        ]} />}
        {activeTab === 'references' && <AssetPreviewList assets={readiness.referenceAssets} avatar={character.avatar} />}
        {activeTab === 'accounts' && <SimpleList rows={readiness.boundAccounts} empty="尚未绑定账号" title={(row) => row.account_name} meta={(row) => row.platform} />}
        {activeTab === 'workflows' && <DetailGrid items={[
          ['默认工作流', readiness.usableWorkflow?.name || '未启用'],
          ['状态', readiness.usableWorkflow?.status || '不可用'],
          ['Provider', character.recommended_workflows?.[0]?.provider || '—'],
          ['基础模型', readiness.usableWorkflow?.checkpoint || readiness.usableWorkflow?.model || '—'],
        ]} />}
        {activeTab === 'tests' && <GenerationTestTab readiness={readiness} onTest={onTest} />}
        {activeTab === 'history' && <SimpleList rows={[...readiness.characterAssets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))} empty="暂无角色版本或验证素材" title={(row) => row.name} meta={(row) => formatDate(row.createdAt)} />}
        {mode === 'advanced' && <details className="technical-details" data-technical-detail><summary>高级技术详情</summary><pre>{JSON.stringify({ lora, workflows: character.recommended_workflows }, null, 2)}</pre></details>}
      </div>
      <div className="detail-drawer-footer">
        <button className="primary-button" type="button" onClick={readiness.state === 'ready' ? onTest : onEdit}>{readiness.state === 'ready' ? '生成测试' : '继续配置'}</button>
        <button className="ghost-button" type="button" onClick={onEdit}>编辑角色</button>
      </div>
    </aside>
  );
}

function GenerationTestTab({ readiness, onTest }) {
  return (
    <div className="drawer-section-grid">
      <DetailCard title="最近测试">{readiness.successfulRun ? '已通过' : '尚未通过'}</DetailCard>
      <DetailCard title="最近验证时间">{formatDate(readiness.successfulRun?.completed_at || readiness.successfulRun?.created_at)}</DetailCard>
      <DetailCard title="最近验证图">{readiness.referenceAssets[0]?.thumbnail || readiness.referenceAssets[0]?.url ? <img className="mini-validation-image" src={readiness.referenceAssets[0].thumbnail || readiness.referenceAssets[0].url} alt="最近验证图" /> : '暂无'}</DetailCard>
      <button className="primary-button" type="button" onClick={onTest}>进入内容工作台创建安全测试</button>
      <p className="security-note">此按钮只进入任务配置，不会自动调用付费工作流。</p>
    </div>
  );
}

function AssetPreviewList({ assets, avatar }) {
  const rows = avatar ? [{ id: 'avatar', thumbnail: avatar, name: '角色主图' }, ...assets] : assets;
  if (!rows.length) return <div className="drawer-empty"><strong>缺少参考图</strong><p>请先上传角色主图或审核一张生成结果。</p></div>;
  return <div className="reference-preview-grid">{rows.slice(0, 8).map((asset) => <figure key={asset.id}><img src={asset.thumbnail || asset.url} alt={asset.name || '角色参考图'} /><figcaption>{asset.name || '参考图'}</figcaption></figure>)}</div>;
}

function DetailGrid({ items }) {
  return <div className="drawer-section-grid">{items.map(([label, value]) => <DetailCard title={label} key={label}>{display(value)}</DetailCard>)}</div>;
}

function DetailCard({ title, children }) {
  return <section className="detail-card"><span>{title}</span><div>{children || '—'}</div></section>;
}

function SimpleList({ rows, empty, title, meta }) {
  if (!rows.length) return <div className="drawer-empty"><strong>{empty}</strong></div>;
  return <div className="drawer-list">{rows.map((row) => <article key={row.id}><strong>{title(row)}</strong><small>{meta(row)}</small></article>)}</div>;
}

function Spec({ label, value, warning }) {
  return <div><span>{label}</span><strong className={warning ? 'quality-warning' : ''}>{value || '—'}</strong></div>;
}

function display(value) {
  if (Array.isArray(value)) return value.join('、') || '—';
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${item}`).join('；') || '—';
  return value || '—';
}
