import { g1StatusLabel } from '../../services/generation-execution-service';

// G1 作业状态卡片：准确的 queued/running/completed/failed/needs_attention
// 状态、有界诊断（只显示代码与首条固定文案，绝不显示 raw 载荷/SQL/堆栈）、
// 产物预览入口与版本历史入口。

const STATUS_CLASS = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  needs_attention: 'attention',
};

function boundedDiagnosticsText(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return '';
  const code = String(diagnostics.code || '');
  const issues = Array.isArray(diagnostics.issues) ? diagnostics.issues.filter((entry) => typeof entry === 'string') : [];
  const first = issues[0] ? `：${issues[0].slice(0, 160)}` : '';
  return code ? `${code}${first}` : first;
}

export function GenerationJobCard({ job, onSelect, selected = false }) {
  const status = String(job.status || 'queued');
  const progress = status === 'completed' ? 100 : status === 'running' ? 45 : status === 'queued' ? 10 : 0;
  const diagnostics = boundedDiagnosticsText(job.diagnostics);
  const diagnosticsLabel = status === 'completed' && diagnostics
    ? `历史诊断（已恢复）：${diagnostics}`
    : diagnostics;
  return (
    <article
      className={`generation-task-card g1-job-card ${selected ? 'selected' : ''}`}
      data-testid="g1-job-card"
      data-status={status}
      onClick={() => onSelect?.(job.id)}
    >
      <div className="generation-task-head">
        <div>
          <h3>{job.model_name || '生成任务'}</h3>
          <small>{job.id} · 第 {job.brief_version || '—'} 版 Brief</small>
        </div>
        <span className={`status-badge ${STATUS_CLASS[status] || 'queued'}`} data-testid="g1-job-status">{g1StatusLabel(status)}</span>
      </div>
      <div className="generation-task-facts">
        <div><span>模式</span><strong>{job.mode}</strong></div>
        <div><span>尝试</span><strong>{job.attempt_count || 1} / {job.max_attempts || 2}</strong></div>
        <div><span>产物</span><strong>{job.artifact_count || 0} 个版本</strong></div>
        <div><span>更新于</span><strong>{job.updated_at ? new Date(job.updated_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</strong></div>
      </div>
      <div className="task-progress"><span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} /></div>
      {diagnosticsLabel && (
        <p
          className="quality-warning"
          data-testid="g1-job-diagnostics"
          data-diagnostic-state={status === 'completed' ? 'historical' : 'active'}
        >
          {diagnosticsLabel}
        </p>
      )}
      <div className="button-row">
        <button className="ghost-button compact" type="button" onClick={(event) => { event.stopPropagation(); onSelect?.(job.id); }}>查看详情与版本历史</button>
      </div>
    </article>
  );
}
