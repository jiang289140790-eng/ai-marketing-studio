import { useCallback, useEffect, useRef, useState } from 'react';
import { asyncActions, executeAction, getExecutionStatus, getRunStatus, isTerminalStatus } from '../services/execution-gateway';

export function useExecutionAction({ action, resourceType, resourceId, payload, ready = true, onCompleted } = {}) {
  const [gateway, setGateway] = useState({ loading: true, connected: false, reason: '正在检查执行网关...' });
  const [state, setState] = useState({ status: 'unavailable', run: null, error: '', message: '' });
  const pollingRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    getExecutionStatus().then((status) => {
      if (!mounted) return;
      setGateway({ loading: false, ...status });
      setState((previous) => ({
        ...previous,
        status: status.connected && ready ? 'ready' : 'unavailable',
        error: '',
      }));
    });
    return () => {
      mounted = false;
      if (pollingRef.current) window.clearInterval(pollingRef.current);
    };
  }, [ready]);

  const run = useCallback(async () => {
    if (!gateway.connected || !ready || !action) return null;
    setState({ status: 'submitting', run: null, error: '', message: '正在提交...' });
    try {
      const result = await executeAction({
        action,
        resourceType,
        resourceId,
        payload: typeof payload === 'function' ? payload() : payload,
      });
      const initialRun = result.run || { id: result.run_id, status: result.status || 'queued', progress: 5 };
      setState({ status: initialRun.status || 'queued', run: initialRun, error: '', message: '任务已提交。' });

      if (result.run_id && asyncActions.has(action)) {
        if (pollingRef.current) window.clearInterval(pollingRef.current);
        pollingRef.current = window.setInterval(async () => {
          try {
            const nextRun = await getRunStatus(result.run_id);
            setState({ status: nextRun.status, run: nextRun, error: nextRun.error_message || '', message: nextRun.result_summary?.message || '' });
            if (isTerminalStatus(nextRun.status)) {
              window.clearInterval(pollingRef.current);
              pollingRef.current = null;
              if (nextRun.status === 'completed') onCompleted?.(nextRun);
            }
          } catch (error) {
            setState((previous) => ({ ...previous, status: 'failed', error: error.message || '状态查询失败。' }));
            window.clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
        }, 2500);
      } else if (initialRun.status === 'completed' || !asyncActions.has(action)) {
        onCompleted?.(initialRun);
      }
      return result;
    } catch (error) {
      setState({ status: 'failed', run: error.runId ? { id: error.runId } : null, error: error.message || '执行失败。', message: '' });
      return null;
    }
  }, [action, gateway.connected, onCompleted, payload, ready, resourceId, resourceType]);

  return {
    gateway,
    state,
    run,
    canRun: gateway.connected && ready && state.status !== 'submitting' && state.status !== 'running' && state.status !== 'queued',
  };
}
