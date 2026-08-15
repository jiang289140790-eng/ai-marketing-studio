// Bounded SVG chart renderer for the persisted presentation chart block.
// Only finite, clamped values from the normalized contract reach this file;
// anything unexpected renders the shared fallback instead of crashing.

const PALETTE = ['#26d6be', '#8057ff', '#4ee5aa', '#71b4ff', '#f0b95c', '#ff8b96', '#9d7bff', '#5ad2a8'];

function formatValue(value) {
  return Number(value.toFixed(2)).toLocaleString('zh-CN');
}

function BarChart({ data }) {
  const width = 560;
  const height = 250;
  const padTop = 26;
  const padBottom = 46;
  const padLeft = 52;
  const maxAbs = Math.max(1, ...data.map((point) => Math.abs(point.value)));
  const plotHeight = height - padTop - padBottom;
  const plotWidth = width - padLeft - 12;
  const slot = plotWidth / Math.max(1, data.length);
  const zeroY = padTop + plotHeight / 2 + (maxAbs > 0 ? 0 : 0);
  const scale = (plotHeight / 2) / maxAbs;
  return (
    <svg className="harp-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="柱状图">
      <line x1={padLeft} y1={zeroY} x2={width - 12} y2={zeroY} stroke="#33425d" strokeWidth="1" />
      {data.map((point, index) => {
        const barWidth = Math.min(46, slot * 0.6);
        const center = padLeft + slot * index + slot / 2;
        const barHeight = Math.abs(point.value) * scale;
        const y = point.value >= 0 ? zeroY - barHeight : zeroY;
        const color = point.color || PALETTE[index % PALETTE.length];
        return (
          <g key={`bar-${index}`}>
            <rect x={center - barWidth / 2} y={y} width={barWidth} height={Math.max(1, barHeight)} rx={4} fill={color} opacity={0.88}>
              <title>{`${point.label}: ${formatValue(point.value)}`}</title>
            </rect>
            <text x={center} y={point.value >= 0 ? y - 6 : y + barHeight + 14} textAnchor="middle" className="harp-chart-value">
              {formatValue(point.value)}
            </text>
            <text x={center} y={height - 18} textAnchor="middle" className="harp-chart-label">
              {point.label.length > 8 ? `${point.label.slice(0, 7)}…` : point.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function LineChart({ data }) {
  const width = 560;
  const height = 250;
  const padTop = 22;
  const padBottom = 46;
  const padLeft = 52;
  const values = data.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.12 || 1;
  min -= pad;
  max += pad;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = width - padLeft - 12;
  const xFor = (index) => padLeft + (data.length === 1 ? plotWidth / 2 : (plotWidth * index) / (data.length - 1));
  const yFor = (value) => padTop + plotHeight * (1 - (value - min) / (max - min));
  const points = data.map((point, index) => `${xFor(index)},${yFor(point.value)}`).join(' ');
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: padTop + plotHeight * ratio,
    value: max - (max - min) * ratio,
  }));
  return (
    <svg className="harp-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="折线图">
      {gridLines.map((grid) => (
        <g key={`grid-${grid.y}`}>
          <line x1={padLeft} y1={grid.y} x2={width - 12} y2={grid.y} stroke="#24334d" strokeWidth="1" />
          <text x={padLeft - 8} y={grid.y + 4} textAnchor="end" className="harp-chart-axis">{formatValue(grid.value)}</text>
        </g>
      ))}
      <polyline points={points} fill="none" stroke="#26d6be" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {data.map((point, index) => (
        <g key={`dot-${index}`}>
          <circle cx={xFor(index)} cy={yFor(point.value)} r={4.5} fill="#0d1626" stroke="#26d6be" strokeWidth="2">
            <title>{`${point.label}: ${formatValue(point.value)}`}</title>
          </circle>
          <text x={xFor(index)} y={height - 18} textAnchor="middle" className="harp-chart-label">
            {point.label.length > 8 ? `${point.label.slice(0, 7)}…` : point.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function DonutChart({ data }) {
  const size = 250;
  const center = size / 2;
  const radius = 84;
  const circumference = 2 * Math.PI * radius;
  const total = data.reduce((sum, point) => sum + Math.max(0, point.value), 0) || 1;
  // Precompute segment offsets as a pure reduce projection so the render pass
  // stays free of reassignment (react-hooks/immutability).
  const segments = data.reduce((accumulated, point, index) => {
    const previous = accumulated[accumulated.length - 1];
    const start = previous ? previous.end : 0;
    const length = circumference * (Math.max(0, point.value) / total);
    return [...accumulated, { point, index, start, length, end: start + length }];
  }, []);
  return (
    <div className="harp-donut-wrap">
      <svg className="harp-chart-svg harp-donut" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="环形图">
        <circle cx={center} cy={center} r={radius} fill="none" stroke="#18243a" strokeWidth="26" />
        {segments.map(({ point, index, start, length }) => {
          const dash = `${Math.max(0, length - 3)} ${circumference - Math.max(0, length - 3)}`;
          return (
            <circle
              key={`segment-${index}`}
              cx={center} cy={center} r={radius} fill="none"
              stroke={point.color || PALETTE[index % PALETTE.length]} strokeWidth="26"
              strokeDasharray={dash} strokeDashoffset={-start}
            >
              <title>{`${point.label}: ${formatValue(point.value)}`}</title>
            </circle>
          );
        })}
        <text x={center} y={center - 6} textAnchor="middle" className="harp-donut-total">{formatValue(total)}</text>
        <text x={center} y={center + 18} textAnchor="middle" className="harp-donut-caption">合计</text>
      </svg>
      <ul className="harp-donut-legend">
        {data.map((point, index) => (
          <li key={`legend-${index}`}>
            <span className="harp-donut-swatch" style={{ background: point.color || PALETTE[index % PALETTE.length] }} />
            <span className="harp-donut-name">{point.label.length > 18 ? `${point.label.slice(0, 17)}…` : point.label}</span>
            <span className="harp-donut-value">{formatValue(point.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartBlock({ block }) {
  if (!block || !Array.isArray(block.data) || block.data.length === 0) {
    return (
      <figure className="harp-block harp-fallback" data-testid="presentation-block-fallback">
        <figcaption>{block?.title || '图表'}</figcaption>
        <div className="harp-fallback-body">图表数据为空或无效。</div>
      </figure>
    );
  }
  return (
    <figure className="harp-block harp-chart" data-testid="presentation-block-chart">
      <figcaption>{block.title || '图表'}</figcaption>
      <div className="harp-chart-scroll">
        {block.chart === 'line' && <LineChart data={block.data} />}
        {block.chart === 'donut' && <DonutChart data={block.data} />}
        {block.chart !== 'line' && block.chart !== 'donut' && <BarChart data={block.data} />}
      </div>
    </figure>
  );
}
