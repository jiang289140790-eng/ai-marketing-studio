import { useCallback, useMemo, useRef, useState } from 'react';
import { ConfirmationContext } from './confirmation-context';

const EMPTY_CONFIRMATION = {
  open: false,
  title: '',
  message: '',
  confirmLabel: '确认',
  cancelLabel: '取消',
  danger: false,
};

export function ConfirmationProvider({ children }) {
  const [dialog, setDialog] = useState(EMPTY_CONFIRMATION);
  const resolverRef = useRef(null);

  const close = useCallback((confirmed) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    setDialog(EMPTY_CONFIRMATION);
  }, []);

  const confirm = useCallback((options = {}) => new Promise((resolve) => {
    resolverRef.current?.(false);
    resolverRef.current = resolve;
    setDialog({
      ...EMPTY_CONFIRMATION,
      ...options,
      open: true,
    });
  }), []);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmationContext.Provider value={value}>
      {children}
      {dialog.open && (
        <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) close(false);
        }}>
          <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-message">
            <span className={`confirmation-icon ${dialog.danger ? 'danger' : ''}`} aria-hidden="true">{dialog.danger ? '!' : '?'}</span>
            <h2 id="confirmation-title">{dialog.title}</h2>
            <p id="confirmation-message">{dialog.message}</p>
            <div className="button-row confirmation-actions">
              <button className="ghost-button" type="button" onClick={() => close(false)}>{dialog.cancelLabel}</button>
              <button className={dialog.danger ? 'danger-button' : 'primary-button'} type="button" onClick={() => close(true)} autoFocus>
                {dialog.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      )}
    </ConfirmationContext.Provider>
  );
}
