export function MoreActionsMenu({ children, label = '更多' }) {
  return (
    <details className="more-actions-menu">
      <summary>{label}</summary>
      <div>{children}</div>
    </details>
  );
}
