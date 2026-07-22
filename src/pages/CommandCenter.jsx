import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { ExecutionStatus } from '../components/ExecutionStatus';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import {
  countWhere,
  getAssets,
  getContentPackages,
  getKnowledgeItems,
  getLatest,
  loadCommandCenterData,
  normalizeStatus,
} from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const EMPTY_DATA = {
  accounts: [],
  accountProfiles: [],
  accountReports: [],
  campaigns: [],
  strategies: [],
  contentPackages: [],
  legacyContent: [],
  assets: [],
  legacyAssets: [],
  characters: [],
  publishTasks: [],
  publishMetrics: [],
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
    const allTasks = [...data.publishTasks, ...data.agentRuns, ...data.workflowRuns];

    return {
      contentPackages,
      assets,
      knowledge,
      pendingStrategies: countWhere(data.strategies, (item) => ['review', 'pending', 'draft'].includes(item.status)),
      pendingContent: countWhere(contentPackages, (item) => ['draft', 'review', 'generating'].includes(item.status)),
      generating: countWhere([...data.agentRuns, ...data.workflowRuns], (item) => ['running', 'queued', 'generating'].includes(item.status)),
      pendingPublish: countWhere(data.publishTasks, (item) => ['draft', 'scheduled', 'pending'].includes(item.status || item.approval_status)),
      failedTasks: countWhere(allTasks, (item) => ['failed', 'error'].includes(item.status)),
      connectedAccounts: countWhere(data.platformConnections, (item) => item.status === 'connected'),
      accountReports: data.accountReports.length + data.accountProfiles.length,
    };
  }, [data]);

  if (!isSupabaseConfigured) {
    return (
      <section className="page-stack">
        <EmptyState title="等待 Supabase 配置" description="配置完成后，Command Center 会读取真实运营数据。" />
      </section>
    );
  }

  if (!userId) {
    return (
      <section className="page-stack">
        <div className="hero-panel command-hero">
          <p className="eyebrow">AI Marketing OS</p>
          <h2>请先登录你的个人运营工作台</h2>
          <p>登录后，这里会直接显示待审批策略、待审核内容、生成任务、待发布审批、失败任务、最近账号智能报告和知识沉淀。</p>
        </div>
      </section>
    );
  }

  const latestRuns = getLatest([...data.agentRuns, ...data.workflowRuns], 5);
  const latestContent = getLatest(summary.contentPackages, 5);
  const latestKnowledge = getLatest(summary.knowledge, 5);

  return (
    <section className="page-stack">
      <div className="hero-panel command-hero">
        <div>
          <p className="eyebrow">AI Command Center</p>
          <h2>你管理方向，AI 员工负责推进每天的运营流水线</h2>
          <p>
            线上站点已按本地 Command Center 的真实流程重构：从 Campaign 目标，到策略审批、内容生成与审核、素材/角色选择、发布安全审批，
            最后沉淀到账号画像和知识库。页面只暴露业务决策，不再把数据库表和技术模块摊开给你操作。
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" type="button" onClick={() => onNavigate('campaigns')}>查看 Campaign 与策略</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>进入内容工作台</button>
          <ExecutionButton actionName="运行 Daily Ops Agent" reason="Daily Ops Agent 尚未加入本次 action allowlist，先接通单个业务动作。">运行今日 AI 运营</ExecutionButton>
        </div>
      </div>

      <ExecutionStatus />
      <DataReadErrors errors={data.__errors} />

      <div className="ops-alert-grid">
        <WorkItem label="待审批策略" value={summary.pendingStrategies} page="campaigns" onNavigate={onNavigate} />
        <WorkItem label="待审核内容" value={summary.pendingContent} page="workspace" onNavigate={onNavigate} />
        <WorkItem label="生成中任务" value={summary.generating} page="health" onNavigate={onNavigate} />
        <WorkItem label="待发布审批" value={summary.pendingPublish} page="publish" onNavigate={onNavigate} />
        <WorkItem label="失败任务" value={summary.failedTasks} page="health" onNavigate={onNavigate} danger />
      </div>

      <div className="stat-grid compact">
        <StatCard label="账号矩阵" value={loading ? '-' : data.accounts.length} hint={`${summary.connectedAccounts} 个平台连接已建立`} />
        <StatCard label="账号智能报告" value={loading ? '-' : summary.accountReports} hint="账号画像、复刻策略、风险记录" />
        <StatCard label="内容包" value={loading ? '-' : summary.contentPackages.length} hint="生成、素材、审核在同一张卡片" />
        <StatCard label="素材 / 角色" value={loading ? '-' : `${summary.assets.length}/${data.characters.length}`} hint="素材库 / 角色库" />
        <StatCard label="发布任务" value={loading ? '-' : data.publishTasks.length} hint="最终安全审批队列" />
        <StatCard label="知识沉淀" value={loading ? '-' : summary.knowledge.length} hint="Knowledge Vault 与运营记忆" />
      </div>

      <div className="dashboard-grid">
        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>最近 Agent / Workflow</h3>
            <button className="ghost-button" type="button" onClick={() => onNavigate('health')}>系统状态</button>
          </div>
          <RecordList rows={latestRuns} empty="还没有 Agent 或 Workflow 执行记录。" />
        </section>

        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>最近内容包</h3>
            <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>内容工作台</button>
          </div>
          <RecordList rows={latestContent} empty="策略审批后，内容包会进入这里。" />
        </section>

        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>最近知识与洞察</h3>
            <StatusBadge status={summary.knowledge.length ? 'success' : 'pending'} />
          </div>
          <RecordList rows={latestKnowledge} empty="账号分析、内容分析、策略复盘会沉淀到这里。" />
        </section>
      </div>
    </section>
  );
}

function DataReadErrors({ errors = [] }) {
  if (!errors.length) return null;
  return (
    <div className="error-banner">
      <strong>数据读取异常</strong>
      <span>部分统计可能不完整，请优先检查 Supabase 表结构、RLS 或网络。</span>
      <ul>
        {errors.slice(0, 5).map((error) => (
          <li key={`${error.key}-${error.message}`}>{error.message}</li>
        ))}
      </ul>
    </div>
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
            <small>{row.summary || row.description || row.status || row.model || row.sourceLabel || '运营记录'}</small>
          </div>
          <span>{formatDate(row.created_at || row.createdAt || row.updated_at || row.completed_at)}</span>
          {row.status && <StatusBadge status={normalizeStatus(row.status)} />}
        </article>
      ))}
    </div>
  );
}
