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
  onCompleted,
  ...props
}) {
  const execution = useExecutionAction({ action, resourceType, resourceId, payload, ready: ready && Boolean(action), onCompleted });
  const disabledReason = reason || (!action ? getUnavailableReason(actionName || String(children)) : execution.gateway.reason);
  const disabled = Boolean(reason) || !execution.canRun;
  const label = buttonLabel(children, execution.state.status);

  return (
    <span className="execution-action">
      <button className={className} type="button" disabled={disabled} title={disabled ? disabledReason : ''} onClick={execution.run} {...props}>
        {label}
      </button>
      {disabled && <small>{disabledReason}</small>}
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
