// P16 世系审计面板：展示节点/边追踪、状态分布和世系详情
export function LineagePanel({ lineage, compact }) {
  if (!lineage) {
    return (
      <div className="iw-panel iw-empty-panel">
        <span className="iw-empty-icon">—</span>
        <strong>暂无世系数据</strong>
        <p>当前数据源中不包含世系审计记录。</p>
      </div>
    );
  }

  const entries = lineage.entries || [];
  const stateCounts = lineage.stateCounts || {};
  const definitions = lineage.definitions || {};

  const stateOrder = ['COMPLETE', 'PARTIAL', 'BROKEN', 'INVALID_SOURCE'];
  const stateConfig = {
    COMPLETE: { label: '完整', tone: 'success', icon: '✓' },
    PARTIAL: { label: '部分', tone: 'warning', icon: '~' },
    BROKEN: { label: '断裂', tone: 'error', icon: '✕' },
    INVALID_SOURCE: { label: '无效来源', tone: 'error', icon: '!' },
  };

  if (compact) {
    return (
      <div className="iw-lineage-compact">
        <div className="iw-lineage-state-strip">
          {stateOrder.map((state) => {
            const cfg = stateConfig[state] || { label: state, tone: 'muted', icon: '?' };
            const count = stateCounts[state] || 0;
            return (
              <div className={`iw-lineage-state-chip iw-tone-${cfg.tone}`} key={state}>
                <span>{cfg.icon}</span>
                <strong>{cfg.label}</strong>
                <small>{count}</small>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="iw-lineage-panel">
      <div className="iw-lineage-header">
        <div>
          <span className="iw-eyebrow">P16 世系审计</span>
          <h3>数据来源完整性与链路追踪</h3>
        </div>
        <span className="iw-badge iw-badge-info">{entries.length} 条记录</span>
      </div>

      {/* 状态定义 */}
      {Object.keys(definitions).length > 0 && (
        <div className="iw-lineage-section">
          <h4>状态含义</h4>
          <div className="iw-state-defs">
            {stateOrder.map((state) => {
              const def = definitions[state];
              if (!def) return null;
              return (
                <details className="iw-state-def" key={state}>
                  <summary>
                    <span className={`iw-state-dot iw-tone-${stateConfig[state]?.tone || 'muted'}`} />
                    {stateConfig[state]?.label || state}
                  </summary>
                  <p>{def}</p>
                </details>
              );
            })}
          </div>
        </div>
      )}

      {/* 状态分布 */}
      <div className="iw-lineage-section">
        <h4>状态分布</h4>
        <div className="iw-state-grid">
          {stateOrder.map((state) => {
            const cfg = stateConfig[state] || { label: state, tone: 'muted', icon: '?' };
            const count = stateCounts[state] || 0;
            return (
              <div className={`iw-state-card iw-tone-${cfg.tone}`} key={state}>
                <span className="iw-state-icon">{cfg.icon}</span>
                <strong>{cfg.label}</strong>
                <span className="iw-state-count">{count}</span>
                <small>{state}</small>
              </div>
            );
          })}
        </div>
      </div>

      {/* 世系条目列表 */}
      {entries.length > 0 && (
        <div className="iw-lineage-section">
          <h4>世系记录</h4>
          <div className="iw-lineage-entries">
            {entries.map((entry, idx) => {
              const state = entry.lineageState || '';
              const cfg = stateConfig[state] || { label: state, tone: 'muted', icon: '?' };
              return (
                <article className="iw-lineage-entry" key={entry.id || idx}>
                  <div className="iw-lineage-entry-head">
                    <span className={`iw-state-badge iw-tone-${cfg.tone}`}>
                      {cfg.icon} {cfg.label}
                    </span>
                    <strong>{entry.sourceLabel}</strong>
                  </div>
                  <div className="iw-lineage-entry-ids">
                    <code>node: {entry.nodeId}</code>
                    <code>edge: {entry.edgeId}</code>
                  </div>
                  <p className="iw-lineage-summary">{entry.summary}</p>
                  {entry.stateMeaning && (
                    <details className="iw-state-meaning">
                      <summary>状态含义</summary>
                      <p className="iw-state-meaning-text">{entry.stateMeaning}</p>
                    </details>
                  )}
                  {entry.verifiedAt && (
                    <small className="iw-verified-at">验证时间：{entry.verifiedAt}</small>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
