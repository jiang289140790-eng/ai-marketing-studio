// 知识卡：展示已验证的知识条目、引用溯源和置信度
export function KnowledgeCard({ item, isLinked }) {
  if (!item) return null;

  return (
    <article className={`iw-knowledge-card ${isLinked ? 'linked' : ''}`}>
      <div className="iw-card-top">
        <span className="iw-card-category">{item.category || '知识条目'}</span>
        {item.confidence != null && (
          <span className="iw-confidence">
            置信度：<strong>{(item.confidence * 100).toFixed(0)}%</strong>
          </span>
        )}
      </div>
      <strong className="iw-card-title">{item.title}</strong>
      <p className="iw-card-summary">{item.summary}</p>

      {item.tags && item.tags.length > 0 && (
        <div className="iw-tag-row">
          {item.tags.map((tag) => (
            <span className="iw-tag" key={tag}>{tag}</span>
          ))}
        </div>
      )}

      {item.sourceEvidenceIds && item.sourceEvidenceIds.length > 0 && (
        <div className="iw-source-section">
          <span className="iw-section-label">
            引用证据（{item.sourceEvidenceIds.length}）
          </span>
          <div className="iw-source-list">
            {item.sourceEvidenceIds.map((evId) => (
              <span className="iw-source-chip" key={evId}>
                <code>{evId}</code>
              </span>
            ))}
          </div>
        </div>
      )}

      {item.citations && item.citations.length > 0 && (
        <div className="iw-citations">
          {item.citations.map((citation, idx) => (
            <blockquote key={idx}>
              <code>{citation.evidenceId}</code>
              <p>"{citation.excerpt}"</p>
              {citation.sourceUrl && (
                <small>{citation.sourceUrl}</small>
              )}
            </blockquote>
          ))}
        </div>
      )}

      {item.applicablePlatforms && item.applicablePlatforms.length > 0 && (
        <div className="iw-platforms-row">
          <span className="iw-section-label">适用平台：</span>
          {item.applicablePlatforms.map((p) => (
            <span className="iw-platform-tag" key={p}>{p}</span>
          ))}
        </div>
      )}

      <p className="iw-card-provenance">{item.provenance}</p>
    </article>
  );
}
