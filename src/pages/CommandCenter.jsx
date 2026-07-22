import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import {
  countWhere,
  getAssets,
  getContentPackages,
  getKnowledgeItems,
  getLatest,
  loadCommandCenterData,
} from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const EMPTY_DATA = {
  accounts: [],
  accountProfiles: [],
  campaigns: [],
  strategies: [],
  contentPackages: [],
  legacyContent: [],
  assets: [],
  legacyAssets: [],
  characters: [],
  publishTasks: [],
  contentMetrics: [],
  knowledge: [],
  insights: [],
  contentMemory: [],
  strategyMemory: [],
  agentRuns: [],
  workflowRuns: [],
  platformConnections: [],
};

export function CommandCenter({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY_DATA);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    setLoading(true);
    loadCommandCenterData()
      .then((nextData) => setData({ ...EMPTY_DATA, ...nextData }))
      .finally(() => setLoading(false));
    return undefined;
  }, [userId]);

  const summary = useMemo(() => {
    const contentPackages = getContentPackages(data);
    const assets = getAssets(data);
    const knowledge = getKnowledgeItems(data);
    const pendingPublish = countWhere(data.publishTasks, (item) => ['draft', 'scheduled', 'pending'].includes(item.status || item.approval_status));
    const failedTasks = countWhere(
      [...data.publishTasks, ...data.agentRuns, ...data.workflowRuns],
      (item) => ['failed', 'error'].includes(item.status),
    );

    return {
      contentPackages,
      assets,
      knowledge,
      pendingStrategies: countWhere(data.strategies, (item) => ['review', 'pending', 'draft'].includes(item.status)),
      pendingContent: countWhere(contentPackages, (item) => ['draft', 'review', 'generating'].includes(item.status)),
      pendingPublish,
      failedTasks,
      connectedAccounts: countWhere(data.platformConnections, (item) => item.status === 'connected'),
    };
  }, [data]);

  if (!isSupabaseConfigured) {
    return (
      <section className="page-stack">
        <EmptyState title="等待 Supabase 配置" description="配置完成后，总控台会读取你的真实运营数据。" />
      </section>
    );
  }

  if (!userId) {
    return (
      <section className="page-stack">
        <div className="hero-panel">
          <p className="eyebrow">Personal AI Ops Workspace</p>
          <h2>请先登录你的个人运营工作台</h2>
          <p>登录后，这里会显示今日待处理事项、Agent 执行结果、最近内容、待批准发布和异常任务。</p>
        </div>
      </section>
    );
  }

  const latestRuns = getLatest([...data.agentRuns, ...data.workflowRuns], 4);
  const latestContent = getLatest(summary.contentPackages, 4);
  const latestPublish = getLatest(data.publishTasks, 4);

  return (
    <section className="page-stack">
      <div className="hero-panel command-hero">
        <p className="eyebrow">AI Command Center</p>
        <h2>今天你只需要审批关键决策，AI 团队继续往前跑</h2>
        <p>
          线上站点现在采用本地 Command Center 的核心操作方式：Campaign 负责目标与策略，内容工作台合并生成与审核，
          发布队列作为最终安全审批点。账号矩阵、素材库和角色库作为三个核心资产中心参与整个流程。
        </p>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('campaigns')}>创建或查看 Campaign</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>进入内容工作台</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('publish')}>检查发布队列</button>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="待审批策略" value={loading ? '-' : summary.pendingStrategies} hint="Agent 生成后等待你确认" />
        <StatCard label="待审核内容" value={loading ? '-' : summary.pendingContent} hint="文案、素材、终审在同一张卡片" />
        <StatCard label="待批准发布" value={loading ? '-' : summary.pendingPublish} hint="不会自动发布" />
        <StatCard label="异常任务" value={loading ? '-' : summary.failedTasks} hint="需要人工检查" />
        <StatCard label="账号资产" value={loading ? '-' : data.accounts.length} hint={`${summary.connectedAccounts} 个已连接平台账号`} />
        <StatCard label="素材与角色" value={loading ? '-' : `${summary.assets.length}/${data.characters.length}`} hint="素材库 / 角色库" />
      </div>

      <div className="dashboard-grid">
        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>今日待处理事项</h3>
            <span className="config-pill">人工决策</span>
          </div>
          <div className="stack-list">
            <WorkItem label="策略等待审批" value={summary.pendingStrategies} page="campaigns" onNavigate={onNavigate} />
            <WorkItem label="内容等待终审" value={summary.pendingContent} page="workspace" onNavigate={onNavigate} />
            <WorkItem label="发布等待批准" value={summary.pendingPublish} page="publish" onNavigate={onNavigate} />
            <WorkItem label="失败或异常任务" value={summary.failedTasks} page="health" onNavigate={onNavigate} danger />
          </div>
        </section>

        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>最近 Agent 执行结果</h3>
            <button className="ghost-button" type="button" onClick={() => onNavigate('health')}>查看系统状态</button>
          </div>
          <RecordList rows={latestRuns} empty="还没有 Agent 或 Workflow 执行记录。" />
        </section>

        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>最近内容</h3>
            <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>进入内容工作台</button>
          </div>
          <RecordList rows={latestContent} empty="还没有内容包。策略批准后会进入这里。" />
        </section>

        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>待批准发布</h3>
            <StatusBadge status={summary.pendingPublish ? 'pending' : 'success'} />
          </div>
          <RecordList rows={latestPublish} empty="暂无发布任务。" />
        </section>
      </div>
    </section>
  );
}

function WorkItem({ label, value, page, onNavigate, danger = false }) {
  return (
    <button className={`work-item ${danger ? 'danger' : ''}`} type="button" onClick={() => onNavigate(page)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </button>
  );
}

function RecordList({ rows, empty }) {
  if (!rows.length) return <div className="empty-card-inline">{empty}</div>;

  return (
    <div className="record-list">
      {rows.map((row) => (
        <article className="record-row" key={row.id || `${row.title}-${row.created_at || row.createdAt}`}>
          <div>
            <strong>{row.title || row.name || row.agent_name || row.type || row.platform || '未命名记录'}</strong>
            <small>{row.summary || row.description || row.status || row.model || '运营记录'}</small>
          </div>
          <span>{formatDate(row.created_at || row.createdAt || row.updated_at || row.completed_at)}</span>
        </article>
      ))}
    </div>
  );
}
