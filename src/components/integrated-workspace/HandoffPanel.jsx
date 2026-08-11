// P5 交接包面板：展示交接清单、执行标志和内容计划
export function HandoffPanel({ handoff, executionFlags }) {
  if (!handoff) {
    return (
      <div className="iw-panel iw-empty-panel">
        <span className="iw-empty-icon">—</span>
        <strong>暂无交接包</strong>
        <p>当前数据源中不包含 P5 兼容的交接包记录。</p>
      </div>
    );
  }

  const flags = executionFlags || handoff.executionFlags || {};
  const flagEntries = [
    ['generation_executed', '生成'],
    ['routing_executed', '路由'],
    ['network_executed', '网络'],
    ['publish_executed', '发布'],
  ];

  const allFalse = flagEntries.every(([key]) => flags[key] === false);

  return (
    <div className="iw-handoff-panel">
      <div className="iw-handoff-header">
        <div>
          <span className="iw-eyebrow">P5 交接包</span>
          <h3>{handoff.title}</h3>
          <span className="iw-badge iw-badge-info">{handoff.statusLabel || handoff.status}</span>
        </div>
      </div>

      {handoff.description && (
        <div className="iw-handoff-section">
          <p>{handoff.description}</p>
        </div>
      )}

      {/* 精确 ID */}
      <div className="iw-handoff-section">
        <h4>精确 ID</h4>
        <dl className="iw-id-grid">
          <div>
            <dt>交接包 ID</dt>
            <dd><code>{handoff.id}</code></dd>
          </div>
          {handoff.briefId && (
            <div>
              <dt>绑定 Brief</dt>
              <dd><code>{handoff.briefId}</code></dd>
            </div>
          )}
          {handoff.boundKnowledgeCardIds && handoff.boundKnowledgeCardIds.length > 0 && (
            <div>
              <dt>绑定知识卡</dt>
              <dd>
                {handoff.boundKnowledgeCardIds.map((id) => (
                  <code key={id} className="iw-id-chip">{id}</code>
                ))}
              </dd>
            </div>
          )}
          {handoff.boundEvidenceIds && handoff.boundEvidenceIds.length > 0 && (
            <div>
              <dt>绑定证据</dt>
              <dd>
                {handoff.boundEvidenceIds.map((id) => (
                  <code key={id} className="iw-id-chip">{id}</code>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* 执行标志 */}
      <div className="iw-handoff-section iw-flags-section">
        <h4>执行标志</h4>
        {allFalse && (
          <p className="iw-all-false-badge">
            ✓ 四项执行标志严格 false
          </p>
        )}
        <div className="iw-flag-grid">
          {flagEntries.map(([key, label]) => (
            <div
              className={`iw-flag-cell ${flags[key] ? 'on' : ''}`}
              key={key}
            >
              <span>{label}</span>
              <strong>{flags[key] ? '已执行' : '未执行'}</strong>
            </div>
          ))}
        </div>
      </div>

      {/* 内容计划 */}
      {handoff.contentPlan && handoff.contentPlan.length > 0 && (
        <div className="iw-handoff-section">
          <h4>内容计划（{handoff.contentPlan.length} 天）</h4>
          <div className="iw-plan-grid">
            {handoff.contentPlan.map((day, idx) => (
              <div className="iw-plan-day" key={idx}>
                <strong>Day {day.day || idx + 1}</strong>
                <span>{day.template}</span>
                <small>平台: {day.platform}</small>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* handoff 约束 */}
      {handoff.handoffConstraints && handoff.handoffConstraints.length > 0 && (
        <div className="iw-handoff-section">
          <h4>交接约束</h4>
          <ul className="iw-brief-list">
            {handoff.handoffConstraints.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {handoff.importOnly && (
        <p className="iw-import-note">
          import_only: true — 交接包仅供本地导入演示，不连接下游生产系统。
        </p>
      )}

      <p className="iw-card-provenance">{handoff.provenance}</p>
    </div>
  );
}
