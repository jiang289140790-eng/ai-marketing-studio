import { normalizeBusinessError } from '../utils/business-error';

export function BusinessErrorNotice({ error, advanced = false }) {
  if (!error) return null;
  const normalized = error.message && error.code && error.impact
    ? error
    : normalizeBusinessError(error);

  return (
    <section className="notice error business-error-notice" role="alert">
      <strong>{normalized.title}</strong>
      <p>{normalized.message}</p>
      <dl className="business-error-facts">
        <div><dt>业务影响</dt><dd>{normalized.impact}</dd></div>
        <div><dt>推荐操作</dt><dd>{normalized.recommendation}</dd></div>
        <div><dt>错误编号</dt><dd>{normalized.code}</dd></div>
        <div><dt>是否可重试</dt><dd>{normalized.retryable ? '可以重试' : '需要人工检查'}</dd></div>
      </dl>
      {advanced && (
        <details>
          <summary>脱敏技术详情</summary>
          <code>{normalized.technicalDetail}</code>
        </details>
      )}
    </section>
  );
}
