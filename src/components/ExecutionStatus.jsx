import { useEffect, useState } from 'react';
import { getExecutionStatus } from '../services/execution-gateway';
import { StatusBadge } from './StatusBadge';

export function ExecutionStatus({ onStatus }) {
  const [status, setStatus] = useState({ loading: true, connected: false, label: '正在检查执行网关...', details: [] });

  useEffect(() => {
    getExecutionStatus({ force: true }).then((nextStatus) => {
      const resolved = { loading: false, ...nextStatus };
      setStatus(resolved);
      onStatus?.(resolved);
    });
  }, [onStatus]);

  return (
    <section className="execution-status-card" id="execution-gateway-status">
      <div className="execution-status-head">
        <div>
          <p className="eyebrow">执行网关状态</p>
          <h3>{status.connected ? '线上执行服务已连接' : '执行服务暂未连接'}</h3>
        </div>
        <StatusBadge status={status.connected ? 'connected' : 'pending'} />
      </div>

      {!status.connected && <p className="execution-status-summary">{status.reason || '等待连接状态返回。'}</p>}

      <div className="gateway-status-grid">
        {(status.details || []).map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <details className="gateway-details">
        <summary>查看连接详情</summary>
        <pre>{JSON.stringify(status.status || { loading: status.loading }, null, 2)}</pre>
      </details>
    </section>
  );
}
