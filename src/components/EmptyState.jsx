export function EmptyState({
  action,
  actionHref = '#/campaigns',
  actionLabel = '查看当前运营活动',
  description,
  icon = '✦',
  prerequisite = '请先完成当前运营活动的上一步。',
  reason,
  title,
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p>{reason || description || '当前数据范围内还没有可展示的记录。'}</p>
      <small>{prerequisite}</small>
      {action || <a className="ghost-button" href={actionHref}>{actionLabel}</a>}
    </div>
  );
}
