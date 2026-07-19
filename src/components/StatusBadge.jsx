import { statusLabel } from '../utils/formatters';

export function StatusBadge({ status }) {
  return <span className={`status-badge ${status || 'unknown'}`}>{statusLabel(status)}</span>;
}
