import { useState } from 'react';
import { useExecutionAction } from '../hooks/useExecutionAction';
import { classifyDisabledReason, getUnavailableReason } from '../services/execution-gateway';

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
  executionUnavailableReason,
  onCompleted,
  ...props
}) {
  const [clickHint, setClickHint] = useState('');
  const execution = useExecutionAction({ action, resourceType, resourceId, payload, ready: ready && Boolean(action), onCompleted });
  const actionLabel = actionName || String(children);
  const localReason = String(reason || '').trim();
  const gatewayReason = execution.gateway.connected ? '' : (executionUnavailableReason || getUnavailableReason(actionLabel));
  const unsupportedReason = action ? '' : `${actionLabel} 尚未接入安全执行网关。`;
  const disabledReason = localReason || gatewayReason || unsupportedReason;
  const disabledKind = classifyDisabledReason(disabledReason);
  const disabled = Boolean(localReason) || !execution.canRun;
  const label = buttonLabel(children, execution.state.status);

  function handleDisabledClick() {
    if (!disabled) return;
    setClickHint(disabledReason || '当前暂不可执行');
    window.setTimeout(() => setClickHint(''), 2400);
  }

  return (
    <span className="execution-action" data-disabled-kind={disabledKind || undefined} onMouseDown={handleDisabledClick} onClick={handleDisabledClick}>
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
