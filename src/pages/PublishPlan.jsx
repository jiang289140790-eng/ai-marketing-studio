import { useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { listPublishTasks } from '../services/content-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

export function PublishPlan({ userId }) {
  const [tasks, setTasks] = useState([]);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return;
    listPublishTasks(userId).then(setTasks).catch(() => setTasks([]));
  }, [userId]);

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Publishing Calendar</p>
          <h2>发布计划</h2>
          <p>这里只展示计划视图；发布任务的创建、状态和 Adapter 调用请到发布中心管理。</p>
        </div>
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后会从 publish_tasks 表读取发布计划。" />
      ) : tasks.length === 0 ? (
        <EmptyState title="暂无发布任务" description="在发布中心创建发布任务后，会同步出现在这里。" />
      ) : (
        <div className="timeline">
          {tasks.map((task) => (
            <article key={task.id} className="timeline-item">
              <div>
                <strong>{formatDate(task.scheduled_time || task.publish_time)}</strong>
                <p>{task.content_library?.title || '未关联内容'}</p>
              </div>
              <span>{task.platform}</span>
              <StatusBadge status={task.status} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
