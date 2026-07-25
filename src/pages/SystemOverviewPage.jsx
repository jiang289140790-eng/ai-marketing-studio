import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { getExecutionStatus } from '../services/execution-gateway';
import { loadSystemStatusData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import { formatDate } from '../utils/formatters';
import {
  buildCoreServices,
  buildHealthExceptions,
  HEALTH_TIME_RANGES,
  sanitizeTechnicalDetails,
  summarizeRuntime,
} from '../utils/system-health-model';

const EMPTY = {
  agentRuns: [],
  workflowRuns: [],
  publishTasks: [],
  publishMetrics: [],
  contentMetrics: [],
  comfyWorkflows: [],
  legacyAssets: [],
};

export function SystemOverviewPage({
  activeCampaignId,
  auxiliaryMode = 'normal',
  campaignContext,
  dataScope = 'campaign',
  userId,
  onNavigate,
}) {
  const [data, setData] = useState(EMPTY);
  const [executionStatus, setExecutionStatus] = useState(null);
  const [timeRange, setTimeRange] = useState('24h');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [ignoredIds, setIgnoredIds] = useState(new Set());

  const runHealthCheck = useCallback(async ({ announce = false } = {}) => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    setMessage('');
    try {
      const [nextData, nextExecutionStatus] = await Promise.all([
        loadSystemStatusData(),
        getExecutionStatus({ force: true }),
      ]);
      setData({ ...EMPTY, ...nextData });
      setExecutionStatus(nextExecutionStatus);
      if (announce) setMessage('健康检查已完成：只执行了连通性、权限和能力读取，没有发布内容或启动付费生成。');
    } catch (error) {
      setMessage('健康检查未完整完成，请查看异常列表或稍后重试。');
      if (auxiliaryMode === 'advanced') setMessage(`健康检查未完整完成：${sanitizeTechnicalDetails(error.message)}`);
    } finally {
      setLoading(false);
    }
  }, [auxiliaryMode, userId]);

  useEffect(() => {
    runHealthCheck().catch(() => {});
  }, [runHealthCheck]);

  const scoped = useMemo(() => {
    const scopeOptions = { scope: dataScope, campaignContext, activeCampaignId };
    return {
      agentRuns: filterRecordsForAuxiliaryScope(data.agentRuns, scopeOptions),
      workflowRuns: filterRecordsForAuxiliaryScope(data.workflowRuns, scopeOptions),
      publishTasks: filterRecordsForAuxiliaryScope(data.publishTasks, scopeOptions),
      publishMetrics: filterRecordsForAuxiliaryScope(data.publishMetrics, scopeOptions),
      contentMetrics: filterRecordsForAuxiliaryScope(data.contentMetrics, scopeOptions),
      comfyWorkflows: filterRecordsForAuxiliaryScope(data.comfyWorkflows, { ...scopeOptions, includeGlobal: true }),
      legacyAssets: filterRecordsForAuxiliaryScope(data.legacyAssets, scopeOptions),
    };
  }, [activeCampaignId, campaignContext, data, dataScope]);

  const metricRows = useMemo(() => [...scoped.contentMetrics, ...scoped.publishMetrics].map((row) => ({
    ...row,
    status: row.status || 'completed',
    created_at: row.fetched_at || row.last_sync || row.collected_at || row.created_at,
  })), [scoped.contentMetrics, scoped.publishMetrics]);

  const rowsByKind = useMemo(() => ({
    agent: scoped.agentRuns,
    workflow: scoped.workflowRuns,
    publish: scoped.publishTasks,
    metrics: metricRows,
  }), [metricRows, scoped.agentRuns, scoped.publishTasks, scoped.workflowRuns]);

  const summary = useMemo(() => summarizeRuntime(rowsByKind, timeRange), [rowsByKind, timeRange]);
  const exceptions = useMemo(() => buildHealthExceptions(rowsByKind, timeRange)
    .filter((item) => !ignoredIds.has(item.id)), [ignoredIds, rowsByKind, timeRange]);
  const services = useMemo(() => buildCoreServices({
    configured: isSupabaseConfigured,
    userId,
    executionStatus,
    comfyWorkflows: scoped.comfyWorkflows,
    workflowRuns: scoped.workflowRuns,
    publishTasks: scoped.publishTasks,
    metricRows,
    assets: scoped.legacyAssets,
  }), [executionStatus, metricRows, scoped.comfyWorkflows, scoped.legacyAssets, scoped.publishTasks, scoped.workflowRuns, userId]);
  const abnormalServices = services.filter((service) => service.status !== 'healthy');
  const healthyServices = services.filter((service) => service.status === 'healthy');
  const rangeLabel = HEALTH_TIME_RANGES.find((item) => item.value === timeRange)?.label || '最近 24 小时';

  if (!isSupabaseConfigured) {
    return <EmptyState title="数据服务尚未配置" reason="系统无法判断运营是否可以继续。" prerequisite="先完成 Supabase 配置。" />;
  }
  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看系统状态。" />;

  return (
    <section className="page-stack system-health-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">系统状态</p>
          <h2>判断当前运营能否继续</h2>
          <p>普通视图只展示业务影响和下一步；SQL、调用栈、内网地址与原始 Provider 响应不会出现在这里。</p>
        </div>
        <div className="button-row">
          <label className="health-range-select">
            <span>时间范围</span>
            <select value={timeRange} onChange={(event) => setTimeRange(event.target.value)}>
              {HEALTH_TIME_RANGES.map((range) => <option key={range.value} value={range.value}>{range.label}</option>)}
            </select>
          </label>
          <button className="primary-button" type="button" disabled={loading} onClick={() => runHealthCheck({ announce: true })}>
            {loading ? '检查中…' : '运行健康检查'}
          </button>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}

      <section className="table-card core-services-panel">
        <div className="panel-title">
          <div><p className="eyebrow">核心服务</p><h3>{abnormalServices.length ? `${abnormalServices.length} 项需要关注` : '所有核心服务正常'}</h3><p>最近检查结果；服务状态不受任务时间筛选影响。</p></div>
          <span className={`health-overall ${abnormalServices.some((item) => item.status === 'error') ? 'error' : abnormalServices.length ? 'warning' : 'healthy'}`}>
            {abnormalServices.some((item) => item.status === 'error') ? '运营受阻' : abnormalServices.length ? '部分能力受限' : '可以继续'}
          </span>
        </div>
        {abnormalServices.length > 0 && (
          <div className="service-alert-grid">
            {abnormalServices.map((service) => <ServiceCard key={service.id} service={service} />)}
          </div>
        )}
        <details className="healthy-services-details">
          <summary>正常服务 {healthyServices.length} 项</summary>
          <div className="service-healthy-list">
            {healthyServices.map((service) => <span key={service.id}>✓ {service.name}</span>)}
          </div>
        </details>
      </section>

      <div className="stat-grid compact system-runtime-stats">
        <StatCard label="Agent 运行" value={summary.groups.find((item) => item.kind === 'agent')?.total || 0} hint={`${rangeLabel}内`} />
        <StatCard label="工作流运行" value={summary.groups.find((item) => item.kind === 'workflow')?.total || 0} hint={`${rangeLabel}内`} />
        <StatCard label="发布任务" value={summary.groups.find((item) => item.kind === 'publish')?.total || 0} hint={`${rangeLabel}内`} />
        <StatCard label="指标回收任务" value={summary.groups.find((item) => item.kind === 'metrics')?.total || 0} hint={`${rangeLabel}内`} />
        <StatCard label="失败任务" value={summary.failed} hint={`${rangeLabel}内；未开始不算失败`} />
        <StatCard label="等待过久" value={summary.overdue} hint={`${rangeLabel}内；等待超过 1 小时`} />
      </div>

      <section className="table-card completion-rate-panel">
        <div>
          <span>任务完成率 · {rangeLabel}</span>
          <strong>{summary.completionRate == null ? '暂无已结束任务' : `${summary.completionRate}%`}</strong>
          <small>{summary.formula}；草稿、未开始、排队和运行中任务不进入分母。</small>
        </div>
        <div className="completion-breakdown">
          <span>成功 {summary.successful}</span>
          <span>已结束 {summary.ended}</span>
          <span>失败 {summary.failed}</span>
        </div>
      </section>

      <section className="table-card health-exception-section">
        <div className="panel-title">
          <div><p className="eyebrow">异常列表</p><h3>真正影响流程的任务</h3><p>{rangeLabel}内失败或等待过久的记录。</p></div>
          <span>{exceptions.length} 条</span>
        </div>
        {exceptions.length ? (
          <div className="health-exception-list">
            {exceptions.map((item) => (
              <article key={item.id}>
                <div className="health-exception-main">
                  <div className="card-meta"><span>{item.impactObject}</span><span>{item.impactScope}</span><span>{item.errorCode}</span></div>
                  <h3>{item.title}</h3>
                  <p>{item.reason}</p>
                  <dl>
                    <div><dt>是否可重试</dt><dd>{item.retryable ? '可以，需先确认原因' : '不建议直接重试'}</dd></div>
                    <div><dt>推荐操作</dt><dd>{item.recommendation}</dd></div>
                    <div><dt>时间</dt><dd>{formatDate(item.time)}</dd></div>
                  </dl>
                  <div className="button-row">
                    <button className="primary-button" type="button" disabled={!item.retryable} onClick={() => onNavigate(item.targetPage)}>重试</button>
                    <button type="button" onClick={() => onNavigate(item.targetPage)}>打开相关页面</button>
                    <button type="button" onClick={() => setIgnoredIds((current) => new Set([...current, item.id]))}>忽略</button>
                  </div>
                </div>
                <details>
                  <summary>查看技术详情</summary>
                  {auxiliaryMode === 'advanced'
                    ? <pre>{JSON.stringify(item.technical, null, 2)}</pre>
                    : <p>切换页面顶部“高级模式”后可查看已脱敏技术详情。</p>}
                </details>
              </article>
            ))}
          </div>
        ) : <div className="empty-card-inline">{rangeLabel}内没有失败或等待过久任务。</div>}
      </section>

      <p className="health-check-safety">健康检查只读取服务连通性、权限、工作流、发布 dry-run 能力和指标读取能力；不会执行真实发布，也不会启动付费生成。</p>
    </section>
  );
}

function ServiceCard({ service }) {
  return (
    <article className={`service-alert-card ${service.status}`}>
      <div><strong>{service.name}</strong><span>{service.status === 'error' ? '异常' : '需关注'}</span></div>
      <p>{service.summary}</p>
      <small>业务影响：{service.impact}</small>
    </article>
  );
}
