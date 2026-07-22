import { useState } from 'react';
import { useExecutionAction } from '../hooks/useExecutionAction';
import { getUnavailableReason } from '../services/execution-gateway';

export function ExecutionButton({
  children,
  action,
  actionName,
  resourceType,
  resourceId,
  payload,
  className = 'primary-button',
  reason,
  ready = true,
  showGatewayHint = false,
  onCompleted,
  ...props
}) {
  const [clickHint, setClickHint] = useState('');
  const execution = useExecutionAction({ action, resourceType, resourceId, payload, ready: ready && Boolean(action), onCompleted });
  const actionLabel = actionName || String(children);
  const localReason = reason || (!action ? getUnavailableReason(actionLabel) : '');
  const gatewayReason = execution.gateway.connected ? '' : '执行服务暂未连接，请查看上方连接状态';
  const disabledReason = localReason || gatewayReason;
  const disabled = Boolean(localReason) || !execution.canRun;
  const label = buttonLabel(children, execution.state.status);

  function handleDisabledClick() {
    if (!disabled) return;
    setClickHint(disabledReason || '当前暂不可执行');
    window.setTimeout(() => setClickHint(''), 2400);
  }

  return (
    <span className="execution-action" onMouseDown={handleDisabledClick} onClick={handleDisabledClick}>
      <button className={className} type="button" disabled={disabled} title={disabled ? disabledReason : ''} onClick={execution.run} {...props}>
        {label}
      </button>
      {localReason && <small>{localReason}</small>}
      {!localReason && showGatewayHint && gatewayReason && <small>{gatewayReason}</small>}
      {clickHint && <small className="inline-hint">{clickHint}</small>}
      {!disabled && execution.state.run?.id && <small>run_id：{execution.state.run.id}</small>}
      {execution.state.status !== 'ready' && execution.state.status !== 'unavailable' && (
        <small>{execution.state.status} · {execution.state.run?.progress ?? 0}%</small>
      )}
      {execution.state.error && <small className="inline-error">{execution.state.error}</small>}
    </span>
  );
}

function buttonLabel(children, status) {
  if (status === 'submitting') return '正在提交...';
  if (status === 'queued') return '已排队';
  if (status === 'running') return '运行中...';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '重试';
  return children;
}
