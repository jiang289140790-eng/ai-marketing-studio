import { useCallback, useEffect, useState } from 'react';

// G1 私有产物查看器：经 Edge Function 获取短时签名 URL 后预览/下载；
// 展示精确 Brief/知识卡/证据血缘与版本历史。绝不公开 bucket、绝不长期缓存 URL。

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function GenerationArtifactViewer({ artifacts = [], client, jobId, onError }) {
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);

  const openArtifact = useCallback(async (artifactId) => {
    setLoading(true);
    try {
      const result = await client.artifact({ jobId, artifactId });
      setSelected({ ...(result?.data?.artifact || {}), signed_url: result?.data?.signed_url || '' });
    } catch (error) {
      onError?.(error);
    } finally {
      setLoading(false);
    }
  }, [client, jobId, onError]);

  useEffect(() => {
    if (artifacts.length > 0 && !selected) openArtifact(artifacts[0].id);
  }, [artifacts, openArtifact, selected]);

  if (!artifacts.length) {
    return <p className="form-hint">还没有产物。作业完成后，私有产物会出现在这里（版本历史保留每次生成）。</p>;
  }

  const isVideo = String(selected?.mime_type || '').startsWith('video/');
  return (
    <section className="g1-artifact-viewer" data-testid="g1-artifact-viewer" role="region" aria-label="生成产物">
      <div className="g1-panel-head">
        <div>
          <p className="eyebrow">私有产物</p>
          <h3>预览与版本历史</h3>
        </div>
      </div>
      <div className="g1-version-rail" data-testid="g1-version-history">
        {artifacts.map((artifact) => (
          <button
            type="button"
            key={artifact.id}
            className={`g1-version-item ${selected?.id === artifact.id ? 'active' : ''}`}
            onClick={() => openArtifact(artifact.id)}
          >
            <strong>v{artifact.artifact_version}</strong>
            <small>{artifact.mime_type}</small>
            <small>{formatBytes(artifact.byte_size)}</small>
          </button>
        ))}
      </div>
      {loading && <div className="skeleton skeleton-card" />}
      {selected && !loading && (
        <div className="g1-artifact-stage" data-testid="g1-artifact-stage">
          {selected.signed_url ? (
            isVideo
              ? <video controls src={selected.signed_url} data-testid="g1-artifact-video" />
              : <img src={selected.signed_url} alt="生成产物" data-testid="g1-artifact-image" />
          ) : (
            <p className="quality-warning">短时签名链接不可用（可能已过期，请重新打开）。</p>
          )}
          <div className="g1-artifact-meta">
            <div className="detail-item"><span className="detail-label">内容指纹</span><strong><code>{selected.content_sha256 || '—'}</code></strong></div>
            <div className="detail-item"><span className="detail-label">模型</span><strong>{selected.model_name || '—'} v{selected.model_version || '—'}</strong></div>
            <div className="detail-item"><span className="detail-label">尺寸</span><strong>{selected.width ? `${selected.width}×${selected.height}` : formatBytes(selected.byte_size)}</strong></div>
            <div className="detail-item"><span className="detail-label">绑定 Brief</span><strong>第 {selected.brief_version || '—'} 版（{selected.brief_id || '—'}）</strong></div>
            <div className="detail-item"><span className="detail-label">知识卡</span><strong>{Array.isArray(selected.knowledge_card_ids) ? selected.knowledge_card_ids.length : 0} 张</strong></div>
            <div className="detail-item"><span className="detail-label">证据</span><strong>{Array.isArray(selected.evidence_ids) ? selected.evidence_ids.length : 0} 条</strong></div>
          </div>
          <a className="primary-button compact" href={selected.signed_url} download data-testid="g1-artifact-download">下载（短时签名链接）</a>
        </div>
      )}
    </section>
  );
}
