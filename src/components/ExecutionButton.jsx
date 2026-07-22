import { getUnavailableReason } from '../services/execution-gateway';

export function ExecutionButton({ children, actionName, className = 'primary-button', reason, ...props }) {
  const disabledReason = reason || getUnavailableReason(actionName || String(children));

  return (
    <span className="execution-action">
      <button className={className} type="button" disabled title={disabledReason} {...props}>
        {children}
      </button>
      <small>{disabledReason}</small>
    </span>
  );
}
