// 证据浏览卡：展示来源身份、引用和采集状态
export function EvidenceCard({ item, isSelected, onSelect, compact }) {
  if (!item) return null;

  const source = item.sourceIdentity || {};

  if (compact) {
    return (
      <button
        className={`iw-evidence-card iw-compact ${isSelected ? 'selected' : ''}`}
        type="button"
        onClick={onSelect}
        aria-pressed={isSelected}
      >
        <span className="iw-card-platform">{item.platform}</span>
        <strong>{item.title || item.name}</strong>
        <small>{source.accountName ? `@${source.accountName}` : item.sourceLabel}</small>
      </button>
    );
  }

  return (
    <button
      className={`iw-evidence-card ${isSelected ? 'selected' : ''}`}
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
    >
      <div className="iw-card-top">
        <span className="iw-card-platform-badge">{item.platform}</span>
        <span className="iw-card-status">{item.captureStatusLabel || '验收演示数据'}</span>
      </div>
      <strong className="iw-card-title">{item.title}</strong>
      <div className="iw-card-source">
        <span>@{source.accountName || 'unknown'}</span>
        {source.displayName && <span>· {source.displayName}</span>}
        {source.followerCount != null && (
          <span>· {source.followerCount.toLocaleString()} 关注</span>
        )}
      </div>
      {item.summary && <p className="iw-card-summary">{item.summary}</p>}
      <div className="iw-card-metrics">
        {item.metrics && (
          <>
            <span>👁 {formatCompact(item.metrics.views)}</span>
            <span>❤ {formatCompact(item.metrics.likes)}</span>
            <span>💬 {formatCompact(item.metrics.comments)}</span>
          </>
        )}
      </div>
      <p className="iw-card-provenance">{item.provenance}</p>
      {item.sourceUrl && (
        <p className="iw-card-url">{item.sourceUrl}</p>
      )}
    </button>
  );
}

function formatCompact(n) {
  if (n == null) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
