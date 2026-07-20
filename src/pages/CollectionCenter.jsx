import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { StatCard } from '../components/StatCard';
import { collectionFrequencies, collectorPlatforms, sourceTypes } from '../data/navigation';
import { listSocialAccounts } from '../services/account-service';
import {
  createSource,
  createTask,
  deleteSource,
  deleteTask,
  getCollectorStats,
  listCollectionRuns,
  listCollectionTasks,
  listSources,
  runCollection,
  updateSource,
  updateTask,
} from '../services/collector-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

const defaultSource = {
  social_account_id: '',
  platform: 'Telegram',
  source_type: 'telegram',
  name: '',
  url: '',
  account: '',
  channel: '',
  username: '',
  category: '',
  status: 'active',
};

const defaultTask = {
  source_id: '',
  frequency: 'manual',
  status: 'active',
  next_run: '',
};

export function CollectionCenter({ userId }) {
  const [accounts, setAccounts] = useState([]);
  const [sources, setSources] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [runs, setRuns] = useState([]);
  const [sourceForm, setSourceForm] = useState(defaultSource);
  const [taskForm, setTaskForm] = useState(defaultTask);
  const [filters, setFilters] = useState({ search: '', platform: '', sourceType: '', status: '' });
  const [taskFilters, setTaskFilters] = useState({ status: '', frequency: '', sourceId: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    const [nextAccounts, nextSources, nextTasks, nextRuns] = await Promise.all([
      listSocialAccounts(userId),
      listSources(userId, filters),
      listCollectionTasks(userId, taskFilters),
      listCollectionRuns(userId),
    ]);
    setAccounts(nextAccounts.filter((account) => ['competitor', 'inspiration'].includes(account.account_role || account.account_type || account.account_category)));
    setSources(nextSources);
    setTasks(nextTasks);
    setRuns(nextRuns);
    setLoading(false);
  }, [userId, filters, taskFilters]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, [refresh]);

  const stats = useMemo(() => getCollectorStats(sources, tasks, runs), [sources, tasks, runs]);

  function setSourceField(field, value) {
    setSourceForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'social_account_id') {
        const account = accounts.find((item) => item.id === value);
        if (account) {
          next.platform = account.platform;
          next.name = account.account_name || account.username || '';
          next.account = account.username || account.account_name || '';
          next.username = account.username || '';
          next.url = account.account_url || '';
          next.category = account.account_role || account.account_type || account.account_category || '';
          if (account.platform === 'Telegram') {
            next.source_type = 'telegram';
            next.channel = normalizeTelegramChannel(account.account_url || account.username || account.account_name || '');
          }
        }
      }
      return next;
    });
  }

  function setTaskField(field, value) {
    setTaskForm((current) => ({ ...current, [field]: value }));
  }

  async function handleCreateSource(event) {
    event.preventDefault();
    try {
      await createSource(userId, sourceForm);
      setSourceForm(defaultSource);
      setMessage('采集数据源已保存。它已绑定账号矩阵中的账号，不会创建新账号。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleCreateTask(event) {
    event.preventDefault();
    try {
      await createTask(userId, taskForm);
      setTaskForm(defaultTask);
      setMessage('采集任务已创建。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleSourceStatus(source, status) {
    try {
      await updateSource(source.id, { status });
      setMessage(`数据源状态已更新为：${statusLabel(status)}。`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleTaskStatus(task, status) {
    try {
      await updateTask(task.id, { status });
      setMessage(`采集任务状态已更新为：${statusLabel(status)}。`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleRunCollection(task) {
    try {
      const run = await runCollection(userId, task);
      setMessage(`采集运行完成：写入 ${run.items_found} 条内容，耗时 ${run.duration_ms || 0}ms。`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Collection Center</p>
          <h2>Social Intelligence Collector</h2>
          <p>采集中心只管理采集配置和运行任务。账号必须来自账号矩阵 social_accounts，采集结果进入 viral_contents，再交给 Analysis Agent。</p>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="数据源" value={loading ? '—' : stats.sources} hint="content_sources" />
        <StatCard label="启用任务" value={loading ? '—' : stats.activeTasks} hint="active collection_tasks" />
        <StatCard label="运行记录" value={loading ? '—' : stats.runs} hint="collection_runs" />
        <StatCard label="入库内容" value={loading ? '—' : stats.itemsFound} hint="items_found 累计" />
      </div>

      <div className="stat-grid compact">
        <StatCard label="采集成功率" value={loading ? '—' : `${stats.successRate}%`} hint="success / total" />
        <StatCard label="热门平台" value={loading ? '—' : stats.topPlatform} hint="数据源最多的平台" />
      </div>

      <div className="studio-grid">
        <form className="form-card" onSubmit={handleCreateSource}>
          <p className="eyebrow">Content Sources</p>
          <h3>创建采集数据源</h3>
          <label>
            绑定账号
            <select value={sourceForm.social_account_id} onChange={(event) => setSourceField('social_account_id', event.target.value)} required>
              <option value="">从账号矩阵选择竞品/灵感账号</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.account_name || account.username} · {account.platform}</option>
              ))}
            </select>
          </label>
          <label>
            平台
            <select value={sourceForm.platform} onChange={(event) => setSourceField('platform', event.target.value)}>
              {collectorPlatforms.map((platform) => (
                <option key={platform} value={platform}>{platform}</option>
              ))}
            </select>
          </label>
          <label>
            来源类型
            <select value={sourceForm.source_type} onChange={(event) => setSourceField('source_type', event.target.value)}>
              {sourceTypes.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </label>
          <label>名称<input value={sourceForm.name} onChange={(event) => setSourceField('name', event.target.value)} required /></label>
          <label>URL<input value={sourceForm.url} onChange={(event) => setSourceField('url', event.target.value)} /></label>
          <label>Telegram Channel<input value={sourceForm.channel} onChange={(event) => setSourceField('channel', event.target.value)} placeholder="例如 durov 或 https://t.me/s/durov" /></label>
          <label>Telegram Username<input value={sourceForm.username} onChange={(event) => setSourceField('username', event.target.value)} placeholder="@channel_username" /></label>
          <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId}>保存数据源</button>
        </form>

        <form className="form-card" onSubmit={handleCreateTask}>
          <p className="eyebrow">Collection Tasks</p>
          <h3>创建采集任务</h3>
          <label>
            数据源
            <select value={taskForm.source_id} onChange={(event) => setTaskField('source_id', event.target.value)} required>
              <option value="">选择数据源</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.name} · {source.platform}</option>
              ))}
            </select>
          </label>
          <label>
            频率
            <select value={taskForm.frequency} onChange={(event) => setTaskField('frequency', event.target.value)}>
              {collectionFrequencies.map((frequency) => (
                <option key={frequency.value} value={frequency.value}>{frequency.label}</option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select value={taskForm.status} onChange={(event) => setTaskField('status', event.target.value)}>
              <option value="active">启用</option>
              <option value="paused">暂停</option>
              <option value="inactive">停用</option>
            </select>
          </label>
          <label>下次运行<input type="datetime-local" value={taskForm.next_run} onChange={(event) => setTaskField('next_run', event.target.value)} /></label>
          <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId}>保存采集任务</button>
        </form>
      </div>

      {message && <div className="notice">{message}</div>}

      <div className="filter-bar">
        <input placeholder="搜索数据源" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <select value={filters.platform} onChange={(event) => setFilters({ ...filters, platform: event.target.value })}>
          <option value="">全部平台</option>
          {collectorPlatforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
        </select>
        <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="paused">暂停</option>
          <option value="inactive">停用</option>
          <option value="error">异常</option>
        </select>
      </div>

      <div className="content-grid">
        {sources.map((source) => (
          <article className="content-card" key={source.id}>
            <div className="card-meta">
              <StatusBadge status={source.status} />
              <span className="tag">{source.platform}</span>
              <span className="tag">{statusLabel(source.source_type)}</span>
            </div>
            <h3>{source.name}</h3>
            <p>{source.social_accounts?.username || source.social_accounts?.account_name || source.channel || source.username || '未绑定账号'}</p>
            <small>最近同步：{formatDate(source.last_sync)} · Last ID：{source.last_message_id || '—'}</small>
            <div className="status-actions">
              <button type="button" onClick={() => handleSourceStatus(source, 'active')}>启用</button>
              <button type="button" onClick={() => handleSourceStatus(source, 'paused')}>暂停</button>
              <button type="button" onClick={() => handleSourceStatus(source, 'inactive')}>停用</button>
              {source.url && <a className="ghost-button" href={source.url} target="_blank" rel="noreferrer">打开来源</a>}
              <button type="button" onClick={() => deleteSource(source.id).then(refresh)}>删除</button>
            </div>
          </article>
        ))}
      </div>

      <div className="filter-bar">
        <select value={taskFilters.status} onChange={(event) => setTaskFilters({ ...taskFilters, status: event.target.value })}>
          <option value="">全部任务状态</option>
          <option value="active">启用</option>
          <option value="paused">暂停</option>
          <option value="inactive">停用</option>
          <option value="error">异常</option>
        </select>
        <select value={taskFilters.frequency} onChange={(event) => setTaskFilters({ ...taskFilters, frequency: event.target.value })}>
          <option value="">全部频率</option>
          {collectionFrequencies.map((frequency) => <option key={frequency.value} value={frequency.value}>{frequency.label}</option>)}
        </select>
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后这里会从 content_sources、collection_tasks、collection_runs 读取采集数据。" />
      ) : tasks.length === 0 ? (
        <EmptyState title="暂无采集任务" description="先选择账号矩阵中的账号创建数据源，再创建第一条采集任务。" />
      ) : (
        <div className="analysis-list">
          {tasks.map((task) => (
            <article className="analysis-card" key={task.id}>
              <div className="card-meta">
                <StatusBadge status={task.status} />
                <span>{task.content_sources?.name || '未知数据源'}</span>
                <span>{statusLabel(task.frequency)}</span>
              </div>
              <h3>{task.content_sources?.platform} · {statusLabel(task.content_sources?.source_type)}</h3>
              <p>{task.content_sources?.social_accounts?.username || task.content_sources?.account || task.content_sources?.url || '暂无来源详情'}</p>
              <div className="metric-row">
                <span>上次运行：{formatDate(task.last_run)}</span>
                <span>下次运行：{formatDate(task.next_run)}</span>
              </div>
              <div className="status-actions">
                <button type="button" onClick={() => handleRunCollection(task)}>运行采集</button>
                <button type="button" onClick={() => handleTaskStatus(task, 'active')}>启用</button>
                <button type="button" onClick={() => handleTaskStatus(task, 'paused')}>暂停</button>
                <button type="button" onClick={() => deleteTask(task.id).then(refresh)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>运行时间</th>
              <th>数据源</th>
              <th>状态</th>
              <th>发现数量</th>
              <th>耗时</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{formatDate(run.started_at)}</td>
                <td>{run.collection_tasks?.content_sources?.name || '未知数据源'}</td>
                <td><StatusBadge status={run.status} /></td>
                <td>{run.items_found}</td>
                <td>{run.duration_ms || 0}ms</td>
                <td>{run.error || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function normalizeTelegramChannel(value) {
  return String(value || '').replace('https://t.me/s/', '').replace('https://t.me/', '').replace(/^@/, '').trim();
}
