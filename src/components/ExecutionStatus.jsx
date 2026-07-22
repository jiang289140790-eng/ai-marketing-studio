import { useEffect, useState } from 'react';
import { getExecutionStatus } from '../services/execution-gateway';
import { StatusBadge } from './StatusBadge';

export function ExecutionStatus() {
  const [status, setStatus] = useState({ loading: true, connected: false, label: '正在检查执行网关...' });

  useEffect(() => {
    getExecutionStatus().then((nextStatus) => setStatus({ loading: false, ...nextStatus }));
  }, []);

  return (
    <div className="execution-status">
      <StatusBadge status={status.connected ? 'connected' : 'failed'} />
      <div>
        <strong>{status.label}</strong>
        {!status.connected && <small>{status.reason}</small>}
      </div>
    </div>
  );
}
