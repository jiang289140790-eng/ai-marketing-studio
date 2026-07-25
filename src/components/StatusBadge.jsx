import { statusLabel } from '../utils/formatters';

export function StatusBadge({ status }) {
  const normalized = String(status || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return <span className={`status-badge ${normalized}`} data-status={normalized}>{statusLabel(status)}</span>;
}
