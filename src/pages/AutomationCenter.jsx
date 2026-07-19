import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { StatCard } from '../components/StatCard';
import { automationJobTypes } from '../data/navigation';
import {
  createJob,
  deleteJob,
  getAutomationStats,
  getJobHistory,
  listJobs,
  runJob,
  updateJob,
} from '../services/automation-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

const defaultJob = {
  name: '',
  type: 'collector',
  schedule: '{\n  "frequency": "manual"\n}',
  target: '{\n  "target_id": ""\n}',
  config: '{\n  "mode": "simulation"\n}',
  status: 'active',
  next_run: '',
};

function automationTypeLabel(type) {
  return automationJobTypes.find((item) => item.value === type)?.label || statusLabel(type);
}

export function AutomationCenter({ userId }) {
  const [jobs, setJobs] = useState([]);
  const [runs, setRuns] = useState([]);
  const [jobForm, setJobForm] = useState(defaultJob);
  const [filters, setFilters] = useState({ search: '', type: '', status: '' });
  const [runFilters, setRunFilters] = useState({ jobId: '', status: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    const [nextJobs, nextRuns] = await Promise.all([
      listJobs(userId, filters),
      getJobHistory(userId, runFilters),
    ]);
    setJobs(nextJobs);
    setRuns(nextRuns);
    setLoading(false);
  }, [userId, filters, runFilters]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, [refresh]);

  const stats = useMemo(() => getAutomationStats(jobs, runs), [jobs, runs]);

  function setJobField(field, value) {
    setJobForm((current) => ({ ...current, [field]: value }));
  }

  async function handleCreateJob(event) {
    event.preventDefault();
    try {
      await createJob(userId, jobForm);
      setJobForm(defaultJob);
      setMessage('自动化任务已创建。');
      await refresh();
    } catch (error) {
      setMessage(`创建失败：${error.message}`);
    }
  }

  async function handleJobStatus(job, status) {
    try {
      await updateJob(job.id, { status });
      setMessage(`自动化任务状态已更新为：${statusLabel(status)}。`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleRunJob(job) {
    try {
      const run = await runJob(userId, job);
      setMessage(`任务运行完成：${statusLabel(run.status)}。已通过内部 runner 驱动 ${automationTypeLabel(job.type)}。`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleDeleteJob(job) {
    try {
      await deleteJob(job.id);
      setMessage(`已删除自动化任务：${job.name}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Automation Orchestrator</p>
          <h2>自动化中心</h2>
          <p>统一管理 Collector、Agent 和 Workflow 自动任务。第一阶段只做任务管理、状态管理和执行记录。</p>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="自动任务数量" value={loading ? '—' : stats.jobs} hint="automation_jobs" />
        <StatCard label="启用任务" value={loading ? '—' : stats.activeJobs} hint="active 状态" />
        <StatCard label="今日运行次数" value={loading ? '—' : stats.todayRuns} hint="今日 automation_runs" />
        <StatCard label="成功率" value={loading ? '—' : `${stats.successRate}%`} hint="success / total" />
      </div>

      <div className="stat-grid compact">
        <StatCard label="成功任务" value={loading ? '—' : stats.successRuns} hint="success automation_runs" />
        <StatCard label="失败任务" value={loading ? '—' : stats.failedRuns} hint="failed automation_runs" />
        <StatCard label="生成数量" value={loading ? '—' : stats.generatedCount} hint="Agent + Workflow 成功次数" />
        <StatCard label="采集数量" value={loading ? '—' : stats.collectedCount} hint="Collector items_found" />
      </div>

      <div className="studio-grid">
        <form className="form-card" onSubmit={handleCreateJob}>
          <p className="eyebrow">Create Job</p>
          <h3>创建自动化任务</h3>
          <label>
            名称
            <input value={jobForm.name} onChange={(event) => setJobField('name', event.target.value)} required />
          </label>
          <label>
            类型
            <select value={jobForm.type} onChange={(event) => setJobField('type', event.target.value)}>
              {automationJobTypes.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select value={jobForm.status} onChange={(event) => setJobField('status', event.target.value)}>
              <option value="active">启用</option>
              <option value="paused">暂停</option>
              <option value="failed">失败</option>
            </select>
          </label>
          <label>
            下次运行
            <input type="datetime-local" value={jobForm.next_run} onChange={(event) => setJobField('next_run', event.target.value)} />
          </label>
          <label className="wide-field">
            Schedule JSON
            <textarea value={jobForm.schedule} onChange={(event) => setJobField('schedule', event.target.value)} />
          </label>
          <label className="wide-field">
            Target JSON
            <textarea value={jobForm.target} onChange={(event) => setJobField('target', event.target.value)} />
          </label>
          <label className="wide-field">
            Config JSON
            <textarea value={jobForm.config} onChange={(event) => setJobField('config', event.target.value)} />
          </label>
          <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId}>保存自动化任务</button>
        </form>

        <article className="form-card">
          <p className="eyebrow">Runtime Slots</p>
          <h3>后续运行器</h3>
          <p>当前已能驱动内部 Collector、Agent 和 Workflow。后续可把同一个 runner 接到 n8n、Cron 或 Queue Worker。</p>
          <div className="tag-row">
            <span className="tag">n8n</span>
            <span className="tag">Cron</span>
            <span className="tag">Queue Worker</span>
            <span className="tag">Manual Run</span>
          </div>
        </article>
      </div>

      {message && <div className="notice">{message}</div>}

      <div className="filter-bar">
        <input placeholder="搜索自动任务" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <select value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}>
          <option value="">全部类型</option>
          {automationJobTypes.map((type) => (
            <option key={type.value} value={type.value}>{type.label}</option>
          ))}
        </select>
        <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="paused">暂停</option>
          <option value="failed">失败</option>
        </select>
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后这里会从 automation_jobs 和 automation_runs 读取自动化任务。" />
      ) : jobs.length === 0 ? (
        <EmptyState title="暂无自动化任务" description="创建第一条 Collector、Agent 或 Workflow 自动化任务。" />
      ) : (
        <div className="content-grid">
          {jobs.map((job) => (
            <article className="content-card" key={job.id}>
              <div className="card-meta">
                <StatusBadge status={job.status} />
                <span className="tag">{automationTypeLabel(job.type)}</span>
              </div>
              <h3>{job.name}</h3>
              <p>下次运行：{formatDate(job.next_run)}</p>
              <div className="tag-row">
                <span className="tag">上次：{formatDate(job.last_run)}</span>
                <span className="tag">{job.schedule?.frequency || 'manual'}</span>
              </div>
              <pre className="code-preview">{JSON.stringify({ target: job.target, config: job.config }, null, 2)}</pre>
              <div className="status-actions">
                <button type="button" onClick={() => handleRunJob(job)}>手动运行</button>
                <button type="button" onClick={() => handleJobStatus(job, 'active')}>启用</button>
                <button type="button" onClick={() => handleJobStatus(job, 'paused')}>暂停</button>
                <button type="button" onClick={() => handleDeleteJob(job)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="filter-bar">
        <select value={runFilters.jobId} onChange={(event) => setRunFilters({ ...runFilters, jobId: event.target.value })}>
          <option value="">全部任务历史</option>
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>{job.name}</option>
          ))}
        </select>
        <select value={runFilters.status} onChange={(event) => setRunFilters({ ...runFilters, status: event.target.value })}>
          <option value="">全部运行状态</option>
          <option value="queued">排队中</option>
          <option value="running">运行中</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
        </select>
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>开始时间</th>
              <th>任务</th>
              <th>类型</th>
              <th>状态</th>
              <th>结果 / 日志</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{formatDate(run.started_at)}</td>
                <td>{run.automation_jobs?.name || '未知任务'}</td>
                <td>{automationTypeLabel(run.automation_jobs?.type)}</td>
                <td><StatusBadge status={run.status} /></td>
                <td><pre className="code-preview">{JSON.stringify(run.result || {}, null, 2)}</pre></td>
                <td>{run.error || '—'}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan="6">暂无运行记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
