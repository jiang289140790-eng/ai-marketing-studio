import { useCallback, useEffect, useState } from 'react';
import { AssetForm } from '../components/AssetForm';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { useConfirmation } from '../contexts/confirmation-context';
import { assetTypes } from '../data/navigation';
import { createAsset, deleteAsset, searchAssets, uploadAsset } from '../services/asset-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

function getAssetType(asset) {
  return String(asset.asset_type || asset.type || '').toLowerCase();
}

function getAssetUrl(asset) {
  return asset.url || asset.output_url || asset.media_url || asset.storage_url || '';
}

function getAssetThumbnail(asset) {
  return asset.thumbnail || asset.thumbnail_url || asset.preview_url || getAssetUrl(asset);
}

export function AssetLibrary({ userId, detailId, onNavigate }) {
  const { confirm } = useConfirmation();
  const [assets, setAssets] = useState([]);
  const [filters, setFilters] = useState({ search: '', type: '', tag: '' });
  const [isCreating, setIsCreating] = useState(false);
  const [uploadType, setUploadType] = useState('image');
  const [selected, setSelected] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      setAssets(await searchAssets(userId, filters));
    } finally {
      setIsLoading(false);
    }
  }, [userId, filters]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  useEffect(() => {
    if (!detailId || !assets.length) return;
    setSelected(assets.find((asset) => String(asset.id) === String(detailId)) || null);
  }, [assets, detailId]);

  async function handleCreate(payload) {
    try {
      await createAsset(userId, payload);
      setIsCreating(false);
      setMessage('资产已保存。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      await uploadAsset(userId, file, {
        type: uploadType,
        name: file.name,
        tags: [],
      });
      setMessage('文件已上传到素材库。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleDelete(asset) {
    const accepted = await confirm({
      title: '删除素材？',
      message: `将删除“${asset.name || '未命名素材'}”。引用该素材的内容包可能需要重新选择素材。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!accepted) return;
    try {
      await deleteAsset(asset.id);
      if (selected?.id === asset.id) {
        setSelected(null);
        onNavigate('assets');
      }
      setMessage('资产已删除。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function preview(asset) {
    const type = getAssetType(asset);
    const url = getAssetUrl(asset);
    const thumbnail = getAssetThumbnail(asset);
    if (type === 'image' && thumbnail) return <img src={thumbnail} alt={asset.name || '素材图片'} />;
    if (type === 'video' && url) return <video src={url} poster={asset.thumbnail || asset.thumbnail_url} controls />;
    if (type === 'audio' && url) return <audio src={url} controls />;
    if (thumbnail) return <img src={thumbnail} alt={asset.name || '素材预览'} />;
    return <div className="asset-placeholder library-asset-placeholder">{asset.prompt || asset.model || type || 'asset'}</div>;
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Asset Factory</p>
          <h2>素材库</h2>
          <p>统一管理图片、视频、音频、Prompt、Workflow 和 LoRA。后续可以继续接入 Civitai 模型资产与 ComfyUI 工作流。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setIsCreating(true)} disabled={!isSupabaseConfigured || !userId}>
          新建资产
        </button>
      </div>

      <div className="filter-bar">
        <input placeholder="搜索名称、Prompt、模型" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <select value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}>
          <option value="">全部类型</option>
          {assetTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
        </select>
        <input placeholder="标签" value={filters.tag} onChange={(event) => setFilters({ ...filters, tag: event.target.value })} />
      </div>

      <div className="form-card">
        <div className="form-grid">
          <label>
            上传类型
            <select value={uploadType} onChange={(event) => setUploadType(event.target.value)}>
              {assetTypes.filter((type) => ['image', 'video', 'audio'].includes(type.value)).map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </label>
          <label className="upload-box">
            上传图片 / 视频 / 音频
            <input
              type="file"
              accept={uploadType === 'video' ? 'video/*' : uploadType === 'audio' ? 'audio/*' : 'image/*'}
              onChange={handleFile}
              disabled={!isSupabaseConfigured || !userId}
            />
          </label>
        </div>
      </div>

      {isCreating && <AssetForm onSubmit={handleCreate} onCancel={() => setIsCreating(false)} />}
      {message && <div className={/失败|error|failed/i.test(message) ? 'notice error' : 'notice'}>{message}</div>}

      {isLoading ? (
        <div className="skeleton-grid" aria-label="素材库加载中">
          {Array.from({ length: 6 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}
        </div>
      ) : !isSupabaseConfigured ? (
        <EmptyState title="等待素材存储配置" description="配置后这里会读取真实素材，并支持上传与删除。" />
      ) : !userId ? (
        <EmptyState title="请先登录" description="登录后才能读取和管理你的素材库。" />
      ) : assets.length === 0 ? (
        <EmptyState title="暂无素材" description="上传文件，或者保存一个 Workflow / LoRA / Prompt 资产。" />
      ) : (
        <div className="asset-grid">
          {assets.map((asset) => (
            <article className="asset-card" key={asset.id}>
              <button className="card-open" type="button" onClick={() => {
                setSelected(asset);
                onNavigate('assets', asset.id);
              }}>预览</button>
              <div className={`library-asset ${getAssetType(asset) === 'video' ? 'video' : ''}`}>{preview(asset)}</div>
              <div>
                <div className="card-meta">
                  <StatusBadge status={getAssetType(asset)} />
                  {asset.source && <span>{asset.source}</span>}
                </div>
                <h3>{asset.name}</h3>
                <p>{asset.prompt || asset.model || '暂无说明'}</p>
                <div className="tag-row">
                  {(asset.tags || []).map((tag) => <span key={tag} className="tag">{tag}</span>)}
                </div>
                <small>{formatDate(asset.created_at)}</small>
                <div className="table-actions">
                  <button type="button" onClick={() => handleDelete(asset)}>删除</button>
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
              <p className="eyebrow">Asset Preview</p>
              <h2>{selected.name}</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => {
              setSelected(null);
              onNavigate('assets');
            }}>关闭</button>
          </div>
          <div className="asset-preview-large">{preview(selected)}</div>
          <dl>
            <div><dt>类型</dt><dd>{statusLabel(getAssetType(selected))}</dd></div>
            <div><dt>模型</dt><dd>{selected.model || '—'}</dd></div>
            <div><dt>来源</dt><dd>{selected.source || '—'}</dd></div>
            <div><dt>创建时间</dt><dd>{formatDate(selected.created_at)}</dd></div>
          </dl>
          {selected.prompt && <p className="draft-preview">{selected.prompt}</p>}
          {selected.workflow && <p className="draft-preview">这个素材已绑定 Workflow 配置，可在内容工作台中作为生成流程使用。</p>}
        </aside>
      )}
    </section>
  );
}
