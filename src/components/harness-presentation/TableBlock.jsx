export function TableBlock({ block }) {
  if (!block || !Array.isArray(block.columns) || block.columns.length === 0 || !Array.isArray(block.rows) || block.rows.length === 0) {
    return (
      <figure className="harp-block harp-fallback" data-testid="presentation-block-fallback">
        <figcaption>{block?.title || '表格'}</figcaption>
        <div className="harp-fallback-body">表格数据为空或无效。</div>
      </figure>
    );
  }
  return (
    <figure className="harp-block harp-table" data-testid="presentation-block-table">
      <figcaption>{block.title || '表格'}</figcaption>
      <div className="harp-table-scroll">
        <table>
          <thead>
            <tr>{block.columns.map((column, index) => <th key={`column-${index}`}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {block.columns.map((_, cellIndex) => (
                  <td key={`cell-${rowIndex}-${cellIndex}`} title={String(row[cellIndex] ?? '')}>{String(row[cellIndex] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
