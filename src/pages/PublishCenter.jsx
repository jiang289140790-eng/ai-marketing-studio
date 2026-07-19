import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { platforms, publishTaskStatuses } from '../data/navigation';
import { listContent } from '../services/content-service';
import { listCampaignLinks } from '../services/performance-service';
import { listPlatformConnections } from '../services/platform-connection-service';
import {
  createPublishTask,
  executePublishTask,
  getPublishHistory,
  summarizePublishTasks,
  syncPublishTaskMetrics,
  updatePublishTask,
} from '../services/publish-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

const initialForm = {
  content_id: '',
  platform_connection_id: '',
  campaign_id: '',
  platform: 'X',
  scheduled_time: '',
  status: 'scheduled',
};

function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function PublishCenter({ userId }) {
  const [tasks, setTasks] = useState([]);
  const [contentItems, setContentItems] = useState([]);
  const [connections, setConnections] = useState([]);
  const [campaignLinks, setCampaignLinks] = useState([]);
  const [filters, setFilters] = useState({ status: '', platform: '' });
  const [form, setForm] = useState(initialForm);
  const [editingTask, setEditingTask] = useState(null);
  const [message, setMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    const [nextTasks, nextContent, nextConnections, nextCampaignLinks] = await Promise.all([
      getPublishHistory(userId, filters),
      listContent(userId),
      listPlatformConnections(userId),
      listCampaignLinks(userId),
    ]);
    setTasks(nextTasks);
    setContentItems(nextContent);
    setConnections(nextConnections);
    setCampaignLinks(nextCampaignLinks);
  }, [userId, filters]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  const stats = useMemo(() => summarizePublishTasks(tasks), [tasks]);
  const selectedConnection = connections.find((connection) => connection.id === form.platform_connection_id);

  function updateForm(patch) {
    const nextForm = { ...form, ...patch };
    if (patch.platform_connection_id) {
      const connection = connections.find((item) => item.id === patch.platform_connection_id);
      if (connection?.platform) nextForm.platform = connection.platform;
    }
    setForm(nextForm);
  }

  function resetForm() {
    setEditingTask(null);
    setForm(initialForm);
  }

  function editTask(task) {
    setEditingTask(task);
    setForm({
      content_id: task.content_id || '',
      platform_connection_id: task.platform_connection_id || '',
      campaign_id: task.campaign_id || '',
      platform: task.platform || 'X',
      scheduled_time: toDateTimeLocal(task.scheduled_time || task.publish_time),
      status: task.status || 'scheduled',
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setIsBusy(true);
    setMessage('');

    try {
      const payload = {
        content_id: form.content_id,
        platform_connection_id: form.platform_connection_id || null,
        campaign_id: form.campaign_id || null,
        platform: selectedConnection?.platform || form.platform,
        scheduled_time: fromDateTimeLocal(form.scheduled_time),
        status: form.status,
      };

      if (editingTask) {
        await updatePublishTask(editingTask.id, {
          ...payload,
          published_at: payload.status === 'published' && !editingTask.published_at ? new Date().toISOString() : editingTask.published_at,
        });
      } else {
        await createPublishTask(userId, payload);
      }

      resetForm();
      await refresh();
      setMessage(editingTask ? '发布任务状态已更新。' : '发布任务已创建。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleExecute(task) {
    setIsBusy(true);
    setMessage('');
    try {
      const result = await executePublishTask(userId, task);
      await refresh();
      setMessage(
        result.status === 'published'
          ? '发布任务已执行完成。'
          : `已调用平台适配器，但当前仍是占位实现：${result.error_message}`,
      );
    } catch (error) {
      setMessage(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSyncMetrics(task) {
    setIsBusy(true);
    setMessage('');
    try {
      const result = await syncPublishTaskMetrics(userId, task);
      await refresh();
      setMessage(`指标同步完成：${result.metrics ? `views ${result.metrics.views} / engagement ${result.metrics.engagement}` : '已写入发布指标快照'}`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Publish Center</p>
          <h2>发布中心</h2>
          <p>把内容库里的草稿变成发布任务，统一管理待发布、发布中、已发布和失败记录。当前只调用平台适配器占位接口，不会真实发帖。</p>
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="待发布" value={stats.draft + stats.scheduled} hint="草稿 + 已排期任务" />
        <StatCard label="发布中" value={stats.publishing} hint="正在执行的任务" />
        <StatCard label="已发布" value={stats.published} hint="成功完成的发布任务" />
        <StatCard label="失败任务" value={stats.failed} hint="适配器或配置错误会进入这里" />
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置环境变量后，发布中心会从 publish_tasks、content_library 和 platform_connections 读取数据。" />
      ) : (
        <>
          <form className="form-card" onSubmit={handleSubmit}>
            <div className="section-head">
              <div>
                <p className="eyebrow">{editingTask ? 'Edit Publish Task' : 'New Publish Task'}</p>
                <h3>{editingTask ? '更新发布任务' : '创建发布任务'}</h3>
              </div>
              {editingTask && (
                <button className="ghost-button" type="button" onClick={resetForm}>
                  取消编辑
                </button>
              )}
            </div>

            <div className="form-grid">
              <label>
                内容
                <select value={form.content_id} onChange={(event) => updateForm({ content_id: event.target.value })} required disabled={Boolean(editingTask)}>
                  <option value="">选择内容库条目</option>
                  {contentItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} · {item.platform || '未选平台'}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                平台连接
                <select value={form.platform_connection_id} onChange={(event) => updateForm({ platform_connection_id: event.target.value })} disabled={Boolean(editingTask)}>
                  <option value="">不绑定连接，仅选择平台</option>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.platform} · {connection.social_accounts?.account_name || '未关联账号'} · {statusLabel(connection.status)}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                转化链接
                <select value={form.campaign_id} onChange={(event) => updateForm({ campaign_id: event.target.value })}>
                  <option value="">不绑定转化链接</option>
                  {campaignLinks
                    .filter((link) => !form.content_id || !link.content_id || link.content_id === form.content_id)
                    .map((link) => (
                      <option key={link.id} value={link.id}>
                        {link.utm_campaign || link.url} · {link.platform}
                      </option>
                    ))}
                </select>
              </label>

              <label>
                平台
                <select value={form.platform} onChange={(event) => updateForm({ platform: event.target.value })} disabled={Boolean(selectedConnection || editingTask)}>
                  {platforms.map((platform) => (
                    <option key={platform} value={platform}>
                      {platform}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                计划时间
                <input type="datetime-local" value={form.scheduled_time} onChange={(event) => updateForm({ scheduled_time: event.target.value })} />
              </label>

              <label>
                状态
                <select value={form.status} onChange={(event) => updateForm({ status: event.target.value })}>
                  {publishTaskStatuses.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="button-row">
              <button className="primary-button" type="submit" disabled={isBusy || !form.content_id}>
                {editingTask ? '保存状态' : '创建任务'}
              </button>
              <span className="muted-text">真实发布将在平台 Edge Function 接入后启用；现在只验证任务链路。</span>
            </div>
          </form>

          {message && <div className={message.includes('失败') || message.includes('must run') ? 'notice error' : 'notice'}>{message}</div>}

          <div className="filter-bar">
            <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
              <option value="">全部状态</option>
              {publishTaskStatuses.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
            <select value={filters.platform} onChange={(event) => setFilters({ ...filters, platform: event.target.value })}>
              <option value="">全部平台</option>
              {platforms.map((platform) => (
                <option key={platform} value={platform}>
                  {platform}
                </option>
              ))}
            </select>
          </div>

          {tasks.length === 0 ? (
            <EmptyState title="暂无发布任务" description="先从内容库选择一条内容，创建发布任务后会出现在这里。" />
          ) : (
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>内容</th>
                    <th>平台</th>
                    <th>连接账号</th>
                    <th>计划时间</th>
                    <th>转化链接</th>
                    <th>状态</th>
                    <th>结果</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.id}>
                      <td>{task.content_library?.title || '未关联内容'}</td>
                      <td>{task.platform}</td>
                      <td>{task.platform_connections?.social_accounts?.account_name || '未绑定'}</td>
                      <td>{formatDate(task.scheduled_time || task.publish_time)}</td>
                      <td>{task.campaign_links?.utm_campaign || (task.campaign_links?.url ? '已绑定' : '—')}</td>
                      <td><StatusBadge status={task.status} /></td>
                      <td>
                        {task.external_id || task.error_message || (task.published_at ? formatDate(task.published_at) : '—')}
                      </td>
                      <td>
                        <div className="table-actions">
                          <button type="button" onClick={() => editTask(task)} disabled={isBusy}>
                            编辑
                          </button>
                          <button type="button" onClick={() => handleExecute(task)} disabled={isBusy || task.status === 'publishing'}>
                            调用Adapter
                          </button>
                          {task.platform === 'Telegram' && (
                            <button type="button" onClick={() => handleSyncMetrics(task)} disabled={isBusy || task.status !== 'published'}>
                              同步指标
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
