import { useMemo } from 'react';
import { layoutFlowSource, parseFlowSource } from '../../services/harness-presentation.js';

// Bounded mermaid subset renderer: flowchart/graph TD|TB|LR|RL|BT with node
// shapes and simple edges. Parsing and layout live in the pure
// harness-presentation service; anything outside the subset (subgraphs,
// cycles, classes, duplicate/conflicting ids, unknown shapes) fails closed
// and this block degrades to a plain code view.

function edgeGeometry(from, to) {
  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  const dx = tx - sx;
  const dy = ty - sy;
  const length = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / length;
  const uy = dy / length;
  const inset = to.shape === 'circle' ? 34 : 18;
  const halfW = to.width / 2 + inset;
  const halfH = to.height / 2 + inset;
  const scale = Math.min(
    Math.abs(dx) < 0.5 ? 1 : halfW / Math.abs(dx),
    Math.abs(dy) < 0.5 ? 1 : halfH / Math.abs(dy),
    1,
  );
  return {
    x1: sx,
    y1: sy,
    x2: tx - ux * scale * Math.abs(dx),
    y2: ty - uy * scale * Math.abs(dy),
    labelX: (sx + tx) / 2,
    labelY: (sy + ty) / 2 - 6,
  };
}

function nodeCenter(position) {
  return { x: position.x + position.width / 2, y: position.y + position.height / 2 };
}

function renderNodeShape(position) {
  const { x, y, width, height } = position;
  const center = nodeCenter(position);
  switch (position.shape) {
    case 'circle':
      return <circle cx={center.x} cy={center.y} r={Math.min(width, height) / 2} />;
    case 'round':
      return <rect x={x} y={y} width={width} height={height} rx={Math.min(18, height / 2)} />;
    case 'stadium':
      return <rect x={x} y={y} width={width} height={height} rx={height / 2} />;
    case 'diamond':
      return <polygon points={`${center.x},${y} ${x + width},${center.y} ${center.x},${y + height} ${x},${center.y}`} />;
    case 'hexagon':
      return <polygon points={`${x + width * 0.2},${y} ${x + width * 0.8},${y} ${x + width},${center.y} ${x + width * 0.8},${y + height} ${x + width * 0.2},${y + height} ${x},${center.y}`} />;
    case 'parallelogram':
      return <polygon points={`${x + 14},${y} ${x + width},${y} ${x + width - 14},${y + height} ${x},${y + height}`} />;
    case 'parallelogramAlt':
      return <polygon points={`${x},${y} ${x + width - 14},${y} ${x + width},${y + height} ${x + 14},${y + height}`} />;
    case 'flag':
      return <polygon points={`${x},${y} ${x + width},${y} ${x + width - 12},${center.y} ${x + width},${y + height} ${x},${y + height}`} />;
    default:
      return <rect x={x} y={y} width={width} height={height} rx={6} />;
  }
}

function FallbackSource({ title, reason, source }) {
  return (
    <figure className="harp-block harp-fallback" data-testid="presentation-block-fallback">
      <figcaption>{title || '流程图'}</figcaption>
      <div className="harp-fallback-body">{reason}</div>
      <pre className="harp-flow-source"><code>{String(source ?? '').slice(0, 1200)}</code></pre>
    </figure>
  );
}

export function FlowBlock({ block }) {
  const parsed = useMemo(() => parseFlowSource(block?.mermaid), [block?.mermaid]);
  if (!parsed) {
    return <FallbackSource title={block?.title} reason="流程图源码超出支持的边界，已降级为纯文本。" source={block?.mermaid} />;
  }
  const layout = layoutFlowSource(parsed);
  if (!layout) {
    return <FallbackSource title={block?.title} reason="流程图包含循环或不支持的语法，已降级为纯文本。" source={block?.mermaid} />;
  }
  return (
    <figure className="harp-block harp-flow" data-testid="presentation-block-flow">
      <figcaption>{block?.title || '流程图'}</figcaption>
      <div className="harp-flow-scroll">
        <svg className="harp-flow-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={block?.title || '流程图'}>
          <defs>
            <marker id="harp-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
              <path d="M0,0 L9,4.5 L0,9 z" fill="#7d8db0" />
            </marker>
          </defs>
          {layout.edges.map((edge, index) => {
            const from = layout.placed.get(edge.from);
            const to = layout.placed.get(edge.to);
            if (!from || !to) return null;
            const geometry = edgeGeometry(from, to);
            const dashed = edge.op === '-.->' || edge.op === '---';
            return (
              <g key={`edge-${index}`} className="harp-flow-edge">
                <line
                  x1={geometry.x1} y1={geometry.y1} x2={geometry.x2} y2={geometry.y2}
                  stroke="#7d8db0" strokeWidth={edge.op === '==>' ? 2.5 : 1.5}
                  strokeDasharray={dashed ? '5 4' : undefined}
                  markerEnd={edge.op === '---' ? undefined : 'url(#harp-arrow)'}
                />
                {edge.label && (
                  <text x={geometry.labelX} y={geometry.labelY} textAnchor="middle" className="harp-flow-edge-label">{edge.label}</text>
                )}
              </g>
            );
          })}
          {parsed.nodes.map((node) => {
            const position = layout.placed.get(node.id);
            if (!position) return null;
            const center = nodeCenter(position);
            return (
              <g key={node.id} className="harp-flow-node">
                {renderNodeShape(position)}
                <text x={center.x} y={center.y + 4.5} textAnchor="middle" className="harp-flow-node-text">
                  {node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}
