import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { MoreActionsMenu } from '../components/MoreActionsMenu';
import { StatusBadge } from '../components/StatusBadge';
import { useConfirmation } from '../contexts/confirmation-context';
import {
  assertAssetCanBeDeleted,
  createAsset,
  deleteAsset,
  uploadAsset,
} from '../services/asset-service';
import { getAssets, loadAssetLibraryData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import {
  buildAssetBusinessName,
  classifyAsset,
  getAssetContext,
  isAssetReferenced,
} from '../utils/asset-library-model';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import { formatDate, statusLabel } from '../utils/formatters';

const CATEGORY_TABS = [
  ['current', '当前内容'],
  ['final', '最终素材'],
  ['generated', '生成结果'],
  ['reference', '参考素材'],
  ['uploaded', '上传素材'],
  ['image', '图片'],
  ['video', '视频'],
  ['audio', '音频'],
];

export function AssetLibrary({
  activeCampaignId,
  auxiliaryMode = 'normal',
  campaignContext,
  dataScope = 'campaign',
  userId,
  detailId,
  onNavigate,
}) {
  const { confirm } = useConfirmation();
  const [data, setData] = useState({ assets: [], legacyAssets: [], characters: [], campaigns: [], contentPackages: [], publishTasks: [] });
  const [category, setCategory] = useState('current');
  const [search, setSearch] = useState('');
  const [day, setDay] = useState('1');
  const [modal, setModal] = useState('');
  const [selectedId, setSelectedId] = useState(detailId || '');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await loadAssetLibraryData();
      const scopeOptions = { scope: dataScope, campaignContext, activeCampaignId };
      setData({
        ...next,
        assets: filterRecordsForAuxiliaryScope(next.assets, scopeOptions),
        legacyAssets: filterRecordsForAuxiliaryScope(next.legacyAssets, scopeOptions),
        contentPackages: filterRecordsForAuxiliaryScope(next.contentPackages, scopeOptions),
        publishTasks: filterRecordsForAuxiliaryScope(next.publishTasks, scopeOptions),
      });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [activeCampaignId, campaignContext, dataScope, userId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (detailId) setSelectedId(detailId); }, [detailId]);

  const assets = useMemo(() => {
    const merged = getAssets(data);
    return merged.map((asset, index) => {
      const context = getAssetContext(asset);
      const character = data.characters.find((row) => String(row.id) === String(context.characterId));
      const campaign = data.campaigns.find((row) => String(row.id) === String(context.campaignId));
      return {
        ...asset,
        context,
        character,
        campaign,
        category: classifyAsset(asset),
        businessName: buildAssetBusinessName(asset, {
          characterName: character?.display_name || character?.name,
          campaignName: campaign?.name || campaign?.title,
          index: index + 1,
        }),
        referenced: isAssetReferenced(asset, {
          contentItems: [],
          publishTasks: data.publishTasks,
        }),
      };
    });
  }, [data]);

  const visibleAssets = useMemo(() => assets.filter((asset) => {
    const type = String(asset.type || '').toLowerCase();
    const dayMatches = dataScope !== 'campaign' || !day || !asset.context.day || String(asset.context.day) === String(day);
    const categoryMatches = ['image', 'video', 'audio'].includes(category)
      ? type === category
      : category === 'current' ? Boolean(asset.context.contentId)
        : category === 'final' ? Boolean(asset.isPrimary || asset.approvedForPublishing)
          : category === 'generated' ? Boolean(asset.generationJobId)
            : category === 'uploaded' ? asset.source === 'upload' || asset.context.source === 'upload'
              : asset.context.purpose === 'reference' || (!asset.context.contentId && !asset.generationJobId);
    const text = `${asset.businessName} ${asset.source || ''} ${asset.character?.name || ''}`.toLowerCase();
    return dayMatches && categoryMatches && (!search || text.includes(search.toLowerCase()));
  }), [assets, category, dataScope, day, search]);
  const selected = assets.find((asset) => String(asset.id) === String(selectedId)) || null;

  async function handleDelete(asset) {
    if (asset.sourceKey !== 'assets') {
      setMessage('生成结果属于生产记录，不能从素材库直接删除。可在详情中标记不可用或回到内容工作台处理。');
      return;
    }
    try {
      await assertAssetCanBeDeleted(asset);
    } catch (error) {
      setMessage(error.message);
      return;
    }
    const accepted = await confirm({
      title: '删除素材？',
      message: `确认删除“${asset.businessName}”？此操作不会影响其它版本。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!accepted) return;
    try {
      await deleteAsset(asset.id);
      setSelectedId('');
      setMessage('素材已删除。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack asset-consolidation-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">可用文件中心</p>
          <h2>素材库</h2>
          <p>只管理已经上传或生成的真实文件。角色身份留在角色库，执行进度进入生成任务。</p>
        </div>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => setModal('upload')}>上传素材</button>
          <button className="ghost-button" type="button" onClick={() => setModal('x')}>从 X 链接导入</button>
        </div>
      </div>

      <div className="asset-scope-strip">
        <span>当前运营活动<strong>{campaignContext?.campaign?.name || campaignContext?.campaign?.title || '未选择'}</strong></span>
        <label>当前 Day<select value={day} onChange={(event) => setDay(event.target.value)}><option value="">全部 Day</option>{[1, 2, 3, 4, 5, 6, 7].map((value) => <option value={value} key={value}>Day {value}</option>)}</select></label>
      </div>

      <div className="asset-library-toolbar">
        <div className="segmented-tabs asset-category-tabs">
          {CATEGORY_TABS.map(([id, label]) => <button className={category === id ? 'active' : ''} type="button" key={id} onClick={() => setCategory(id)}>{label}</button>)}
        </div>
        <input placeholder="搜索素材、角色或来源" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>

      {message && <div className={/失败|不能|不可用|缺少/.test(message) ? 'notice error' : 'notice'}>{message}</div>}

      {loading ? (
        <div className="skeleton-grid">{Array.from({ length: 6 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}</div>
      ) : !isSupabaseConfigured ? (
        <EmptyState title="等待素材存储配置" description="配置后这里会读取真实素材文件。" />
      ) : !userId ? (
        <EmptyState title="请先登录" description="登录后才能读取和管理素材库。" />
      ) : !visibleAssets.length ? (
        <EmptyState
          title="当前分类没有素材"
          reason={`当前运营活动 Day ${day || '全部'} 的“${CATEGORY_TABS.find(([id]) => id === category)?.[1]}”暂无记录。`}
          prerequisite="可以上传素材、从 X 链接导入，或在内容工作台创建生成任务。"
          action={<button className="primary-button" type="button" onClick={() => setModal('upload')}>上传素材</button>}
        />
      ) : (
        <div className="asset-business-grid">
          {visibleAssets.map((asset) => (
            <AssetBusinessCard
              asset={asset}
              key={asset.id}
              onOpen={() => { setSelectedId(asset.id); onNavigate?.('assets', asset.id); }}
              onDelete={() => handleDelete(asset)}
            />
          ))}
        </div>
      )}

      {modal && (
        <AssetImportModal
          type={modal}
          userId={userId}
          campaignId={activeCampaignId}
          day={day || '1'}
          characters={data.characters}
          onClose={() => setModal('')}
          onComplete={async (nextMessage) => { setModal(''); setMessage(nextMessage); await refresh(); }}
        />
      )}

      {selected && (
        <AssetDetailDrawer
          asset={selected}
          mode={auxiliaryMode}
          onClose={() => { setSelectedId(''); onNavigate?.('assets'); }}
          onDelete={() => handleDelete(selected)}
        />
      )}
    </section>
  );
}

function AssetBusinessCard({ asset, onOpen, onDelete }) {
  const url = asset.thumbnail || asset.url;
  const type = String(asset.type || 'image').toLowerCase();
  return (
    <article className="asset-business-card">
      <button className="asset-business-preview" type="button" onClick={onOpen}>
        {type === 'video' && asset.url
          ? <video src={asset.url} poster={asset.thumbnail} preload="metadata" />
          : type === 'audio'
            ? <span>音频</span>
            : url ? <img src={url} alt={asset.businessName} loading="lazy" /> : <span>{statusLabel(type)}</span>}
      </button>
      <div className="asset-business-body">
        <div className="panel-title"><h3>{asset.businessName}</h3><StatusBadge status={asset.status} /></div>
        <div className="asset-business-facts">
          <Fact label="类型" value={statusLabel(type)} />
          <Fact label="运营活动" value={asset.campaign?.name || asset.campaign?.title || '当前运营活动'} />
          <Fact label="Day" value={asset.context.day ? `Day ${asset.context.day}` : '未指定'} />
          <Fact label="角色" value={asset.character?.display_name || asset.character?.name || '未绑定'} />
          <Fact label="来源" value={sourceLabel(asset)} />
          <Fact label="用途" value={asset.context.purpose} />
          <Fact label="审核" value={asset.approvedForPublishing ? '已批准' : '待确认'} />
          <Fact label="最终素材" value={asset.isPrimary || asset.approvedForPublishing ? '是' : '否'} />
          <Fact label="关联内容" value={asset.contentId ? '1' : '0'} />
          <Fact label="创建时间" value={formatDate(asset.createdAt)} />
        </div>
        <div className="asset-card-actions">
          <button className="ghost-button compact" type="button" onClick={onOpen}>查看详情</button>
          <MoreActionsMenu>
            <button className="danger-action" type="button" onClick={onDelete}>{asset.referenced ? '查看删除限制' : '删除素材'}</button>
          </MoreActionsMenu>
        </div>
      </div>
    </article>
  );
}

function AssetImportModal({ type, userId, campaignId, day, characters, onClose, onComplete }) {
  const [form, setForm] = useState({ assetType: 'image', characterId: '', purpose: 'reference', rights: false, url: '', file: null });
  const [saving, setSaving] = useState(false);
  function update(field, value) { setForm((current) => ({ ...current, [field]: value })); }
  async function submit(event) {
    event.preventDefault();
    if (!form.rights) return;
    setSaving(true);
    try {
      const context = {
        campaignId,
        day: Number(day),
        characterId: form.characterId || null,
        purpose: form.purpose,
        rights: 'user_confirmed',
        source: type === 'x' ? 'x_link' : 'upload',
      };
      if (type === 'x') {
        await createAsset(userId, {
          name: 'X 链接参考素材',
          type: form.assetType,
          url: form.url,
          thumbnail: form.assetType === 'image' ? form.url : null,
          tags: ['x-import', `day-${day}`],
          source: 'manual',
          workflow: { asset_context: context, source_url: form.url },
        });
      } else {
        if (!form.file) throw new Error('请选择文件。');
        await uploadAsset(userId, form.file, { ...context, type: form.assetType, name: form.file.name, tags: [`day-${day}`] });
      }
      await onComplete(type === 'x' ? 'X 链接已导入素材库。' : '素材已上传。');
    } catch (error) {
      await onComplete(error.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="asset-import-modal" onSubmit={submit}>
        <div className="section-head"><div><p className="eyebrow">素材导入</p><h3>{type === 'x' ? '从 X 链接导入' : '上传素材'}</h3></div><button className="ghost-button" type="button" onClick={onClose}>关闭</button></div>
        <div className="form-grid">
          <label>类型<select value={form.assetType} onChange={(event) => update('assetType', event.target.value)}><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select></label>
          <label>角色<select value={form.characterId} onChange={(event) => update('characterId', event.target.value)}><option value="">不绑定角色</option>{characters.map((character) => <option value={character.id} key={character.id}>{character.display_name || character.name}</option>)}</select></label>
          <label>用途<select value={form.purpose} onChange={(event) => update('purpose', event.target.value)}><option value="reference">参考素材</option><option value="content">当前内容</option><option value="final">最终素材候选</option></select></label>
          {type === 'x'
            ? <label className="wide-field">X 帖文或媒体链接<input type="url" value={form.url} onChange={(event) => update('url', event.target.value)} required /></label>
            : <label className="wide-field">选择文件<input type="file" accept={`${form.assetType}/*`} onChange={(event) => update('file', event.target.files?.[0] || null)} required /></label>}
          <label className="wide-field checkbox-row"><input type="checkbox" checked={form.rights} onChange={(event) => update('rights', event.target.checked)} />我确认拥有该素材的使用权，可用于当前运营活动。</label>
        </div>
        <div className="button-row"><button className="primary-button" type="submit" disabled={!form.rights || saving}>{saving ? '处理中…' : '确认导入'}</button><button className="ghost-button" type="button" onClick={onClose}>取消</button></div>
      </form>
    </div>
  );
}

function AssetDetailDrawer({ asset, mode, onClose, onDelete }) {
  const raw = asset.raw || {};
  return (
    <aside className="detail-drawer asset-detail-drawer">
      <div className="detail-drawer-header"><div><p className="eyebrow">素材详情</p><h3>{asset.businessName}</h3><p>{asset.context.purpose} · {asset.approvedForPublishing ? '已批准' : '待确认'}</p></div><button className="ghost-button" type="button" onClick={onClose}>关闭</button></div>
      <div className="drawer-body">
        <div className="asset-detail-preview">{asset.thumbnail || asset.url ? <img src={asset.thumbnail || asset.url} alt={asset.businessName} /> : <span>暂无预览</span>}</div>
        <div className="drawer-section-grid">
          <DetailCard title="业务名称">{asset.businessName}</DetailCard>
          <DetailCard title="运营活动">{asset.campaign?.name || '当前运营活动'}</DetailCard>
          <DetailCard title="Day">{asset.context.day ? `Day ${asset.context.day}` : '未指定'}</DetailCard>
          <DetailCard title="角色">{asset.character?.name || '未绑定'}</DetailCard>
          <DetailCard title="来源">{sourceLabel(asset)}</DetailCard>
          <DetailCard title="审核状态">{asset.approvedForPublishing ? '已批准' : '待确认'}</DetailCard>
        </div>
        <details className="technical-details" data-technical-detail>
          <summary>高级技术详情</summary>
          <dl>
            <div><dt>原始文件名</dt><dd>{raw.name || raw.output_storage_path?.split('/').pop() || '—'}</dd></div>
            <div><dt>文件 URL</dt><dd>{asset.url || '—'}</dd></div>
            <div><dt>Storage 路径</dt><dd>{raw.output_storage_path || '—'}</dd></div>
            <div><dt>生成任务</dt><dd>{asset.generationJobId || '—'}</dd></div>
          </dl>
          {mode === 'advanced' && <pre>{JSON.stringify({ generation_params: raw.generation_params, metadata: raw.metadata }, null, 2)}</pre>}
        </details>
      </div>
      <div className="detail-drawer-footer"><button className="ghost-button" type="button" onClick={onClose}>关闭</button><MoreActionsMenu><button className="danger-action" type="button" onClick={onDelete}>删除素材</button></MoreActionsMenu></div>
    </aside>
  );
}

function Fact({ label, value }) { return <div><span>{label}</span><strong>{value || '—'}</strong></div>; }
function DetailCard({ title, children }) { return <section className="detail-card"><span>{title}</span><div>{children}</div></section>; }
function sourceLabel(asset) {
  if (asset.source === 'autodl') return 'AutoDL 生成';
  if (asset.source === 'upload') return '手动上传';
  if (asset.context.source === 'x_link') return 'X 链接导入';
  return asset.source || asset.context.source || '手动素材';
}
