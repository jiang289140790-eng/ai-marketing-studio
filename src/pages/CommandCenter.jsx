import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import {
  countBy,
  getAssetRows,
  getContentRows,
  getKnowledgeRows,
  latestRows,
  loadCommandCenterData,
} from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const EMPTY_DATA = {
  campaigns: [],
  strategies: [],
  contentPackages: [],
  contentLibrary: [],
  publishTasks: [],
  contentMetrics: [],
  knowledgeEntries: [],
  contentMemory: [],
  strategyMemory: [],
  assets: [],
  assetLibrary: [],
  characters: [],
  accounts: [],
  platformConnections: [],
  accountReports: [],
  accountProfiles: [],
  agentRuns: [],
  workflowRuns: [],
  viralContents: [],
  contentAnalysis: [],
};

const opsSteps = [
  {
    title: '情报发现',
    page: 'knowledge',
    description: 'Research Agent 发现账号、爆款内容和市场机会。',
  },
  {
    title: '策略判断',
    page: 'campaigns',
    description: 'Strategy Agent 把目标拆成可执行的内容计划。',
  },
  {
    title: '内容生产',
    page: 'content',
    description: 'Content Factory 生成文案、平台版本和待审核内容包。',
  },
  {
    title: '素材生成',
    page: 'assets',
    description: 'Asset Factory / ComfyUI 生成图片、视频、LoRA 和 Workflow 资产。',
  },
  {
    title: '发布审批',
    page: 'publish',
    description: 'Distribution Center 汇总待发布、已发布和失败任务。',
  },
  {
    title: '复盘学习',
    page: 'analytics',
    description: 'Analytics Loop 把表现数据写回知识库，影响下一轮策略。',
  },
];

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
    const contentRows = getContentRows(data);
    const assetRows = getAssetRows(data);
    const knowledgeRows = getKnowledgeRows(data);
    const pendingStrategies = countBy(data.strategies, (item) => ['review', 'pending', 'draft'].includes(item.status));
    const pendingContent = countBy(contentRows, (item) => ['draft', 'review', 'generating'].includes(item.status));
    const pendingPublish = countBy(data.publishTasks, (item) => ['draft', 'scheduled', 'pending'].includes(item.status));
    const published = countBy(data.publishTasks, (item) => item.status === 'published');
    const failed = countBy(
      [...data.publishTasks, ...data.agentRuns, ...data.workflowRuns],
      (item) => item.status === 'failed',
    );

    return {
      contentRows,
      assetRows,
      knowledgeRows,
      pendingStrategies,
      pendingContent,
      pendingPublish,
      published,
      failed,
    };
  }, [data]);

  if (!isSupabaseConfigured) {
    return (
      <section className="page-stack">
        <EmptyState title="等待 Supabase 配置" description="配置 Supabase 后，线上总控台会读取真实运营数据。" />
      </section>
    );
  }

  if (!userId) {
    return (
      <section className="page-stack">
        <div className="hero-panel">
          <p className="eyebrow">Personal AI Ops Workspace</p>
          <h2>请先登录你的个人运营工作台</h2>
          <p>登录后，Command Center 会把账号矩阵、素材库、角色库和运营链路合成一个每日工作台。</p>
        </div>
      </section>
    );
  }

  const latestKnowledge = latestRows(summary.knowledgeRows, 4);
  const latestContent = latestRows(summary.contentRows, 4);
  const latestRuns = latestRows([...data.agentRuns, ...data.workflowRuns], 4);

  return (
    <section className="page-stack">
      <div className="hero-panel command-hero">
        <p className="eyebrow">AI Marketing OS · Command Center</p>
        <h2>你管理 AI 营销团队，系统推进每日运营</h2>
        <p>
          这里吸收了本地 Command Center 的整体逻辑：从情报发现、策略生成、内容生产、素材生成、发布审批到数据复盘。
          已上线的账号矩阵、素材库、角色库会成为这条链路里的核心资产。
        </p>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('accounts')}>管理账号矩阵</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>查看素材库</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>查看角色库</button>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="账号资产" value={loading ? '-' : data.accounts.length} hint="social_accounts" />
        <StatCard label="AI 内容" value={loading ? '-' : summary.contentRows.length} hint="content packages / library" />
        <StatCard label="素材资产" value={loading ? '-' : summary.assetRows.length} hint="assets / asset_library" />
        <StatCard label="知识记忆" value={loading ? '-' : summary.knowledgeRows.length} hint="Knowledge Vault" />
        <StatCard label="待审批发布" value={loading ? '-' : summary.pendingPublish} hint="publish queue" />
        <StatCard label="异常任务" value={loading ? '-' : summary.failed} hint="需要人工处理" />
      </div>

      <div className="ops-flow">
        {opsSteps.map((step, index) => (
          <button className="ops-step-card" type="button" key={step.title} onClick={() => onNavigate(step.page)}>
            <span>{index + 1}</span>
            <strong>{step.title}</strong>
            <small>{step.description}</small>
          </button>
        ))}
      </div>

      <div className="dashboard-grid">
        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>今日需要你看的事</h3>
            <span className="config-pill">人工审批点</span>
          </div>
          <div className="stack-list">
            <WorkItem label="待处理策略" value={summary.pendingStrategies} page="campaigns" onNavigate={onNavigate} />
            <WorkItem label="待审核内容" value={summary.pendingContent} page="content" onNavigate={onNavigate} />
            <WorkItem label="待审批发布" value={summary.pendingPublish} page="publish" onNavigate={onNavigate} />
            <WorkItem label="失败任务" value={summary.failed} page="analytics" onNavigate={onNavigate} danger />
          </div>
        </section>

        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>最新知识沉淀</h3>
            <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>进入知识库</button>
          </div>
          <RecordList rows={latestKnowledge} empty="还没有知识沉淀。Research Agent 或账号分析完成后会出现在这里。" />
        </section>

        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>最新内容包</h3>
            <button className="ghost-button" type="button" onClick={() => onNavigate('content')}>进入内容工厂</button>
          </div>
          <RecordList rows={latestContent} empty="还没有内容包。策略批准后会进入内容生产。" />
        </section>

        <section className="table-card mini-panel">
          <div className="panel-title">
            <h3>AI 执行记录</h3>
            <StatusBadge status={latestRuns[0]?.status || 'pending'} />
          </div>
          <RecordList rows={latestRuns} empty="还没有 AI 执行记录。" />
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
  if (!rows.length) {
    return <div className="empty-card-inline">{empty}</div>;
  }

  return (
    <div className="record-list">
      {rows.map((row) => (
        <article className="record-row" key={row.id || `${row.title}-${row.created_at}`}>
          <div>
            <strong>{row.title || row.name || row.agent_name || row.type || row.status || '未命名记录'}</strong>
            <small>{row.summary || row.description || row.platform || row.model || row.status || '运营数据'}</small>
          </div>
          <span>{formatDate(row.created_at || row.updated_at || row.completed_at)}</span>
        </article>
      ))}
    </div>
  );
}
