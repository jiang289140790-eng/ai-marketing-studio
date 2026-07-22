import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { readOpsTable } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const PAGE_CONFIG = {
  campaigns: {
    eyebrow: 'Campaign Layer',
    title: 'Campaign 与策略',
    description: '这里承接本地 Command Center 的“目标 → 策略 → 审批”逻辑。AI 先生成策略，你只负责确认方向。',
    tables: [
      { key: 'campaigns', table: 'campaigns', label: 'Campaign', statusField: 'status' },
      { key: 'strategies', table: 'strategy_plans', label: '策略计划', statusField: 'status' },
    ],
    stats: [
      { label: 'Campaign', key: 'campaigns' },
      { label: '策略计划', key: 'strategies' },
      { label: '待审批', key: 'strategies', match: ['review', 'pending', 'draft'] },
    ],
    empty: '暂无 Campaign 或策略。后续 Strategy Agent 生成后会在这里审批。',
  },
  content: {
    eyebrow: 'Content Factory',
    title: '内容工厂',
    description: '这里承接“策略 → 内容包 → 审核 → 素材匹配 → 进入发布队列”的流程。',
    tables: [
      { key: 'packages', table: 'content_packages', label: '内容包', statusField: 'status' },
      { key: 'library', table: 'content_library', label: '内容库', statusField: 'status' },
    ],
    stats: [
      { label: '内容总数', key: 'combined' },
      { label: '待审核', key: 'combined', match: ['draft', 'review'] },
      { label: '已排期', key: 'combined', match: ['scheduled'] },
      { label: '已发布', key: 'combined', match: ['published'] },
    ],
    empty: '暂无内容。Analysis Agent / Content Agent 生成后会出现在这里。',
  },
  aiworks: {
    eyebrow: 'AI Works',
    title: 'AI 成果',
    description: '这里集中展示 AI 员工产出的账号画像、角色资产、Workflow 任务和素材结果。',
    tables: [
      { key: 'accountReports', table: 'account_intelligence_reports', label: '账号画像', statusField: 'status' },
      { key: 'agentRuns', table: 'agent_runs', label: 'Agent 运行', statusField: 'status' },
      { key: 'workflowRuns', table: 'workflow_runs', label: 'Workflow 运行', statusField: 'status' },
      { key: 'characters', table: 'characters', label: '角色资产', statusField: 'status' },
    ],
    stats: [
      { label: '账号画像', key: 'accountReports' },
      { label: 'Agent 运行', key: 'agentRuns' },
      { label: 'Workflow', key: 'workflowRuns' },
      { label: '角色资产', key: 'characters' },
    ],
    empty: '暂无 AI 成果。Agent 或 Workflow 运行后会沉淀到这里。',
  },
  publish: {
    eyebrow: 'Distribution Queue',
    title: '发布队列',
    description: '这里承接“内容审核通过 → 发布任务 → 人工批准 → 平台发布 → 指标回收”的流程。',
    tables: [
      { key: 'publishTasks', table: 'publish_tasks', label: '发布任务', statusField: 'status' },
      { key: 'publishMetrics', table: 'publish_metrics', label: '发布指标', statusField: 'status' },
    ],
    stats: [
      { label: '发布任务', key: 'publishTasks' },
      { label: '待发布', key: 'publishTasks', match: ['draft', 'scheduled', 'pending'] },
      { label: '已发布', key: 'publishTasks', match: ['published'] },
      { label: '失败', key: 'publishTasks', match: ['failed'] },
    ],
    empty: '暂无发布任务。内容通过终审后会进入这里。',
  },
  analytics: {
    eyebrow: 'Analytics Optimization',
    title: '分析优化',
    description: '这里不是普通报表，而是把表现、成本和失败原因写回策略记忆，推动下一轮内容优化。',
    tables: [
      { key: 'metrics', table: 'content_metrics', label: '内容指标', statusField: 'status' },
      { key: 'strategies', table: 'content_strategies', label: '优化策略', statusField: 'status' },
      { key: 'costs', table: 'cost_records', label: '成本记录', statusField: 'status' },
    ],
    stats: [
      { label: '指标记录', key: 'metrics' },
      { label: '优化策略', key: 'strategies' },
      { label: '成本记录', key: 'costs' },
    ],
    empty: '暂无分析数据。发布和指标回收后会在这里复盘。',
  },
  knowledge: {
    eyebrow: 'Knowledge Vault',
    title: '知识库',
    description: '这里是系统真正的长期记忆：账号理解、角色设定、内容模式、策略经验都会沉淀在这里。',
    tables: [
      { key: 'knowledge', table: 'knowledge_entries', label: '知识条目', statusField: 'status' },
      { key: 'contentMemory', table: 'content_memory', label: '内容记忆', statusField: 'status' },
      { key: 'strategyMemory', table: 'strategy_memory', label: '策略记忆', statusField: 'status' },
      { key: 'opportunities', table: 'content_opportunities', label: '内容机会', statusField: 'status' },
    ],
    stats: [
      { label: '知识条目', key: 'knowledge' },
      { label: '内容记忆', key: 'contentMemory' },
      { label: '策略记忆', key: 'strategyMemory' },
      { label: '机会线索', key: 'opportunities' },
    ],
    empty: '暂无知识沉淀。研究、账号分析和内容复盘完成后会写入这里。',
  },
};

export function OpsDataPage({ type, userId, onNavigate }) {
  const config = PAGE_CONFIG[type];
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured || !config) return undefined;

    setLoading(true);
    Promise.all(
      config.tables.map(async (entry) => {
        const rows = await readOpsTable(entry.table);
        return [entry.key, rows];
      }),
    )
      .then((entries) => setData(Object.fromEntries(entries)))
      .finally(() => setLoading(false));

    return undefined;
  }, [config, userId]);

  const combinedRows = useMemo(() => {
    if (!config) return [];
    return config.tables.flatMap((entry) => (data[entry.key] || []).map((row) => ({ ...row, _label: entry.label })));
  }, [config, data]);

  if (!config) {
    return null;
  }

  if (!isSupabaseConfigured) {
    return (
      <section className="page-stack">
        <EmptyState title="等待 Supabase 配置" description="配置完成后，这个页面会读取真实数据。" />
      </section>
    );
  }

  if (!userId) {
    return (
      <section className="page-stack">
        <div className="hero-panel">
          <p className="eyebrow">{config.eyebrow}</p>
          <h2>请先登录</h2>
          <p>登录后才能读取你的个人运营数据。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">{config.eyebrow}</p>
        <h2>{config.title}</h2>
        <p>{config.description}</p>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('dashboard')}>回到总控台</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('accounts')}>账号矩阵</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>素材库</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>角色库</button>
        </div>
      </div>

      <div className="stat-grid compact">
        {config.stats.map((stat) => (
          <StatCard
            key={`${stat.label}-${stat.key}`}
            label={stat.label}
            value={loading ? '-' : statValue(stat, data, combinedRows)}
            hint={stat.key === 'combined' ? '跨内容表汇总' : stat.key}
          />
        ))}
      </div>

      <section className="table-card">
        {combinedRows.length ? (
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>名称</th>
                <th>状态</th>
                <th>平台 / 模型</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {combinedRows.map((row) => (
                <tr key={`${row._label}-${row.id || row.created_at || row.title}`}>
                  <td>{row._label}</td>
                  <td>
                    <strong>{row.title || row.name || row.agent_name || row.task_type || row.type || '未命名'}</strong>
                    <small className="row-subtitle">{row.summary || row.description || row.content_text || row.analysis || ''}</small>
                  </td>
                  <td><StatusBadge status={row.status || row.approval_status || 'pending'} /></td>
                  <td>{row.platform || row.model || row.provider || row.source || '—'}</td>
                  <td>{formatDate(row.created_at || row.updated_at || row.completed_at || row.collected_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title={loading ? '正在读取数据' : '暂无数据'} description={loading ? '正在从 Supabase 读取真实数据。' : config.empty} />
        )}
      </section>
    </section>
  );
}

function statValue(stat, data, combinedRows) {
  const rows = stat.key === 'combined' ? combinedRows : data[stat.key] || [];

  if (!stat.match) {
    return rows.length;
  }

  return rows.filter((row) => stat.match.includes(row.status || row.approval_status)).length;
}
