export function SummaryBlock({ block }) {
  if (!block || typeof block.text !== 'string' || !block.text.trim()) return null;
  return (
    <figure className="harp-block harp-summary" data-testid="presentation-block-summary">
      <figcaption>{block.title || '摘要'}</figcaption>
      <pre className="harp-summary-body">{block.text}</pre>
    </figure>
  );
}

export function FallbackBlock({ block }) {
  return (
    <figure className="harp-block harp-fallback" data-testid="presentation-block-fallback">
      <figcaption>{block?.title || '提示'}</figcaption>
      <div className="harp-fallback-body">{block?.text || '该内容无法安全渲染。'}</div>
    </figure>
  );
}
