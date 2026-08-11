// 分析摘要卡：展示文本/多模态分析结论及关联证据
export function AnalysisCard({ item, isLinked }) {
  if (!item) return null;

  const insights = item.multimodalInsights || {};

  return (
    <article className={`iw-analysis-card ${isLinked ? 'linked' : ''}`}>
      <div className="iw-card-top">
        <span className="iw-card-type">{item.type === 'multimodal' ? '多模态分析' : '文本分析'}</span>
        {isLinked && <span className="iw-card-linked-badge">关联中</span>}
      </div>
      <strong className="iw-card-title">{item.title}</strong>
      <p className="iw-card-meta">
        关联证据：<code>{item.evidenceId}</code>
        {item.createdAt && <span> · {item.createdAt}</span>}
      </p>

      {item.textSummary && (
        <div className="iw-analysis-section">
          <span className="iw-section-label">文本摘要</span>
          <p>{item.textSummary}</p>
        </div>
      )}

      {Object.keys(insights).length > 0 && (
        <div className="iw-analysis-section">
          <span className="iw-section-label">多模态洞察</span>
          <dl className="iw-insight-grid">
            {Object.entries(insights).map(([key, value]) => (
              <div key={key}>
                <dt>{formatInsightKey(key)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {item.audienceInsight && (
        <div className="iw-analysis-section">
          <span className="iw-section-label">受众洞察</span>
          <p>{item.audienceInsight}</p>
        </div>
      )}

      {item.replicability && (
        <p className="iw-replicability">
          可复制性：<strong>{item.replicability}</strong>
        </p>
      )}

      <p className="iw-card-provenance">{item.provenance}</p>
    </article>
  );
}

function formatInsightKey(key) {
  const labels = {
    hook: '开场钩子',
    format: '内容格式',
    visualStructure: '视觉/叙事结构',
    pacing: '节奏',
    colorPalette: '色调',
    textOverlay: '文字叠加',
    informationDensity: '信息密度',
    audioStrategy: '音频策略',
    educationalDesign: '教学设计',
  };
  return labels[key] || key;
}
