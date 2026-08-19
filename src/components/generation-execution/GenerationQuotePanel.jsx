import { useMemo, useState } from 'react';

// G1 报价与显式批准面板：展示不可变报价（模型/模式/有界费用区间/到期时间/
// 请求指纹/执行标志），并要求用户显式确认预估最大费用后才允许提交。
// 绝不展示 raw provider 载荷、SQL、堆栈或技术配置。

function formatCny(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `¥${numeric.toFixed(2)}` : '—';
}

function formatTime(value) {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

export function GenerationQuotePanel({ quote, onApprove, onDiscard, busy = false }) {
  const [confirmed, setConfirmed] = useState(false);
  const summary = useMemo(() => {
    const raw = quote && typeof quote === 'object' ? quote : {};
    return {
      modelName: raw.model_name || '—',
      mode: raw.mode || '—',
      provider: raw.provider || 'bailian',
      priceMin: formatCny(raw.price_cny_min),
      priceMax: formatCny(raw.price_cny_max),
      estimatedMax: formatCny(raw.estimated_max_cost_cny),
      expiresAt: formatTime(raw.expires_at),
      quoteId: raw.quote_id || '—',
      fingerprint: raw.quote_fingerprint || raw.quote_id || '—',
      requestSha: raw.request_sha256 || '—',
      willPay: raw.will_pay === true,
      willWrite: raw.will_write === true,
      willUseStorage: raw.will_use_storage === true,
      willExecute: raw.will_execute === true,
      briefVersion: raw.brief_version || '—',
      cardCount: Array.isArray(raw.knowledge_card_ids) ? raw.knowledge_card_ids.length : 0,
      evidenceCount: Array.isArray(raw.evidence_ids) ? raw.evidence_ids.length : 0,
    };
  }, [quote]);

  if (!quote) return null;

  return (
    <section className="g1-quote-panel" data-testid="g1-quote-panel" role="region" aria-label="生成报价预览">
      <div className="g1-panel-head">
        <div>
          <p className="eyebrow">不可变报价</p>
          <h3>请确认生成费用</h3>
        </div>
        <span className="status-badge approved">已报价</span>
      </div>
      <div className="g1-quote-grid">
        <div className="detail-item"><span className="detail-label">模型</span><strong>{summary.modelName}</strong></div>
        <div className="detail-item"><span className="detail-label">模式</span><strong>{summary.mode}</strong></div>
        <div className="detail-item"><span className="detail-label">费用区间（有界估算）</span><strong>{summary.priceMin} – {summary.priceMax}</strong></div>
        <div className="detail-item"><span className="detail-label">预估最大费用</span><strong data-testid="g1-quote-max">{summary.estimatedMax}</strong></div>
        <div className="detail-item"><span className="detail-label">报价到期</span><strong>{summary.expiresAt}</strong></div>
        <div className="detail-item"><span className="detail-label">绑定 Brief 版本</span><strong>第 {summary.briefVersion} 版</strong></div>
        <div className="detail-item"><span className="detail-label">引用知识卡 / 证据</span><strong>{summary.cardCount} / {summary.evidenceCount}</strong></div>
        <div className="detail-item"><span className="detail-label">执行标志</span><strong>{summary.willPay && summary.willExecute && summary.willWrite && summary.willUseStorage ? '付费生成 + 私有存储写入' : '未完整声明'}</strong></div>
      </div>
      <details className="g1-fingerprint-details">
        <summary>请求与报价指纹</summary>
        <p className="form-hint">报价指纹：<code>{summary.fingerprint}</code></p>
        <p className="form-hint">请求指纹：<code>{summary.requestSha}</code></p>
      </details>
      <p className="form-hint">
        报价不可变：任何 prompt / 模型 / 引用素材 / Brief 或项目修订变化都会在付费调用之前使报价失效。
        你确认的预估最大费用是本次付费生成费用的硬上限。
      </p>
      <label className="g1-approval-check">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} data-testid="g1-approval-check" />
        <span>我已确认预估最大费用为 <strong>{summary.estimatedMax}</strong>，并显式批准本次付费生成请求。</span>
      </label>
      <div className="button-row">
        <button className="primary-button" type="button" disabled={!confirmed || busy} onClick={() => onApprove?.()} data-testid="g1-approve-submit">
          {busy ? '正在提交…' : '批准并提交生成'}
        </button>
        <button className="ghost-button" type="button" disabled={busy} onClick={() => onDiscard?.()}>放弃报价</button>
      </div>
    </section>
  );
}
