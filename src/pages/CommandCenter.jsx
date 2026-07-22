import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { ExecutionStatus } from '../components/ExecutionStatus';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import {
  countWhere,
  displayText,
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
      activeCampaigns: countWhere(data.campaigns, (item) => !['completed', 'archived', 'cancelled'].includes(String(item.status).toLowerCase())),
      pendingStrategies: countWhere(data.strategies, (item) => item.status === 'review'),
      pendingContent: countWhere(contentPackages, (item) => ['draft', 'review'].includes(item.reviewStatus || item.status)),
      generating: countWhere([...data.agentRuns, ...data.workflowRuns], (item) => ['running', 'queued', 'generating'].includes(item.status)),
      pendingPublish: countWhere(data.publishTasks, (item) => item.approval_status === 'pending' || item.status === 'pending'),
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
  const pipelineSteps = [
    {
      step: 1,
      label: '情报发现',
      status: summary.accountReports > 0 ? 'done' : data.insights.length > 0 ? 'active' : 'idle',
      count: summary.accountReports || data.insights.length,
    },
    { step: 2, label: '策略生成', status: data.strategies.length > 0 ? 'done' : 'idle', attention: summary.pendingStrategies, count: summary.pendingStrategies },
    { step: 3, label: '内容生产', status: summary.contentPackages.length > 0 ? 'done' : 'idle', attention: summary.pendingContent, count: summary.pendingContent },
    { step: 4, label: '素材生成', status: summary.generating > 0 ? 'active' : summary.assets.length > 0 ? 'done' : 'idle', count: summary.generating || summary.assets.length },
    { step: 5, label: '发布审批', status: data.publishTasks.length > 0 ? 'done' : 'idle', attention: summary.pendingPublish, count: summary.pendingPublish },
    { step: 6, label: '数据回收', status: data.contentMetrics.length > 0 ? 'done' : 'idle', count: data.contentMetrics.length },
  ];
  const actionItems = [
    { label: '待审批策略', description: '确认 AI 生成的定位、内容支柱和执行计划。', value: summary.pendingStrategies, page: 'campaigns', button: '去审批策略' },
    { label: '待审核内容', description: '检查文案、CTA、角色 LoRA 与最终素材。', value: summary.pendingContent, page: 'workspace', button: '去审核内容' },
    { label: '待确认发布', description: '确认发布时间、目标账号和发布安全条件。', value: summary.pendingPublish, page: 'publish', button: '去发布队列' },
    { label: '失败任务', description: '查看失败原因并决定重试、重生成或人工处理。', value: summary.failedTasks, page: 'health', button: '查看异常', danger: true },
  ];
  const latestReport = getLatest([...data.accountReports, ...data.accountProfiles], 1)[0];
  const latestStrategyMemory = getLatest(data.strategyMemory, 1)[0];
  const bestContentMemory = [...data.contentMemory]
    .sort((left, right) => Number(right.success_rate || right.score || 0) - Number(left.success_rate || left.score || 0))[0];
  const recommendations = [
    {
      emoji: '🔎',
      title: '账号情报发现',
      text: recommendationText(latestReport, ['key_findings', 'summary', 'analysis', 'report', 'description']),
      empty: '完成一次账号分析后，这里会显示最新的受众、内容模式和增长机会。',
    },
    {
      emoji: '🧭',
      title: '策略复盘教训',
      text: recommendationText(latestStrategyMemory, ['lessons_learned', 'learning', 'summary', 'description']),
      empty: '策略执行并回收数据后，这里会提示下一轮应该保留或调整的方向。',
    },
    {
      emoji: '⚡',
      title: '推荐内容模式',
      text: recommendationText(bestContentMemory, ['pattern', 'winning_pattern', 'recommendation', 'summary', 'description']),
      empty: '积累内容表现后，这里会推荐成功率最高的 Hook、结构和 CTA 模式。',
    },
  ];

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

      <section className="daily-ops-panel">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">AI DAILY OPS</p>
            <h3>今日运营工作流</h3>
            <p>实时读取 Supabase 状态，快速判断流程推进到哪一步、哪里需要人工确认。</p>
          </div>
          <StatusBadge status={summary.failedTasks ? 'failed' : summary.generating ? 'running' : 'success'} />
        </div>
        <div className="daily-ops-pipeline" aria-label="AI Daily Ops 六步工作流">
          {pipelineSteps.map((item) => <PipelineStep key={item.step} {...item} />)}
        </div>
      </section>

      <div className="stat-grid compact">
        <StatCard label="活跃 Campaign" value={loading ? '-' : summary.activeCampaigns} hint="当前运营目标" />
        <StatCard label="待你审批" value={loading ? '-' : summary.pendingStrategies + summary.pendingContent + summary.pendingPublish} hint="策略、内容与发布" />
        <StatCard label="已连接平台" value={loading ? '-' : summary.connectedAccounts} hint="可执行的平台连接" />
        <StatCard label="知识库条目" value={loading ? '-' : summary.knowledge.length} hint="Knowledge Vault 与运营记忆" />
      </div>

      <section className="attention-panel">
        <div className="section-head compact-head">
          <div><p className="eyebrow">ACTION CENTER</p><h3>需要你处理</h3></div>
          <span className="attention-total">{actionItems.reduce((total, item) => total + item.value, 0)} 项待办</span>
        </div>
        <div className="attention-grid">
          {actionItems.map((item) => <WorkItem key={item.label} {...item} onNavigate={onNavigate} />)}
        </div>
      </section>

      <section className="recommendation-panel">
        <div className="section-head compact-head">
          <div><p className="eyebrow">AI NEXT MOVE</p><h3>下一步建议</h3><p>从账号报告、策略记忆和内容记忆中提取最新可执行建议。</p></div>
          <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>打开知识库</button>
        </div>
        <div className="recommendation-grid">
          {recommendations.map((item) => <RecommendationCard key={item.title} {...item} />)}
        </div>
      </section>

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

function PipelineStep({ step, label, status, attention, count }) {
  const visualStatus = attention ? 'attention' : status;
  const icon = visualStatus === 'done' ? '✓' : visualStatus === 'active' ? '⚡' : visualStatus === 'attention' ? '!' : '·';
  return (
    <div className={`pipeline-step ${visualStatus}`}>
      <div className="pipeline-marker"><span>{icon}</span></div>
      <small>步骤 {step}</small>
      <strong>{label}</strong>
      <span className="pipeline-count">{count || 0}</span>
    </div>
  );
}

function WorkItem({ label, description, value, page, button, onNavigate, danger = false }) {
  return (
    <article className={`attention-card ${danger ? 'danger' : ''} ${value ? 'has-work' : 'clear'}`}>
      <div className="attention-card-head"><strong>{label}</strong><span>{value}</span></div>
      <p>{description}</p>
      <button className={value ? 'primary-button' : 'ghost-button'} type="button" onClick={() => onNavigate(page)}>{value ? button : '查看'}</button>
    </article>
  );
}

function RecommendationCard({ emoji, title, text, empty }) {
  return (
    <article className="recommendation-card">
      <span className="recommendation-icon">{emoji}</span>
      <div><h4>{title}</h4><p>{truncate(text || empty, 100)}</p></div>
    </article>
  );
}

function recommendationText(row, fields) {
  if (!row) return '';
  for (const field of fields) {
    const value = row[field];
    if (value != null && value !== '') return displayText(value, '');
  }
  return displayText(row, '');
}

function truncate(value, length) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
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
