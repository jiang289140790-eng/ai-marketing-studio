import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { BusinessErrorNotice } from '../components/BusinessErrorNotice';
import { MoreActionsMenu } from '../components/MoreActionsMenu';
import { buildDailyReport, buildDataExport, downloadJson } from '../services/report-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { normalizeBusinessError } from '../utils/business-error';

export function DailyReport({
  activeCampaignId,
  auxiliaryMode = 'normal',
  campaignContext,
  dataScope = 'campaign',
  userId,
  onNavigate,
}) {
  const [report, setReport] = useState(null);
  const [message, setMessage] = useState('');
  const [businessError, setBusinessError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const refresh = useCallback(async ({ reveal = false } = {}) => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    try {
      setBusinessError(null);
      setMessage('');
      const nextReport = await buildDailyReport(userId, {
        scope: dataScope,
        campaignContext,
        activeCampaignId,
      });
      setReport(nextReport);
      if (reveal) setShowSummary(true);
    } catch (error) {
      setBusinessError(normalizeBusinessError(error, {
        title: '运营日报暂时无法生成',
        impact: '本次日报没有生成，现有运营数据不会被修改。',
        recommendation: '可以重试；如仍失败，请到系统状态查看错误编号。',
      }));
    } finally {
      setLoading(false);
    }
  }, [activeCampaignId, campaignContext, dataScope, userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleExport() {
    try {
      const payload = await buildDataExport(userId, {
        scope: dataScope,
        campaignContext,
        activeCampaignId,
      });
      downloadJson(`ai-marketing-studio-backup-${new Date().toISOString().slice(0, 10)}.json`, payload);
      setMessage('数据备份已导出。');
    } catch (error) {
      setBusinessError(normalizeBusinessError(error, {
        title: '数据备份暂时无法导出',
        impact: '没有下载新备份，线上数据不会被修改。',
        recommendation: '检查网络和当前登录状态后重试。',
      }));
    }
  }

  function handleReportDownload() {
    if (!report) return;
    downloadJson(`daily-ops-report-${report.report_for}.json`, report);
  }

  const canShowFullReport = Boolean(report?.has_activity || showSummary);

  return (
    <section className="page-stack daily-report-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">运营日报</p>
          <h2>昨天做了什么，今天要做什么</h2>
          <p>默认汇总当前 Campaign 的真实执行、发布、异常与下一步，不与数据分析或 AI 复盘重复。</p>
        </div>
        <div className="button-row">
          <button className="primary-button" type="button" disabled={loading} onClick={() => refresh({ reveal: true })}>生成今日运营日报</button>
          <button type="button" disabled={loading} onClick={() => refresh({ reveal: canShowFullReport })}>刷新</button>
          <button type="button" disabled={!report} onClick={handleReportDownload}>下载</button>
          <button type="button" onClick={() => setShowHistory((value) => !value)}>查看历史</button>
          <MoreActionsMenu>
            <button type="button" onClick={handleExport} disabled={!isSupabaseConfigured || !userId}>导出数据备份</button>
          </MoreActionsMenu>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}
      <BusinessErrorNotice error={businessError} advanced={auxiliaryMode === 'advanced'} />

      {!isSupabaseConfigured ? (
        <EmptyState title="等待数据服务配置" description="配置后才能读取执行记录并生成日报。" />
      ) : report && !report.has_activity && !showSummary ? (
        <EmptyState
          title="尚无已执行任务，无法生成完整日报"
          reason="当前 Campaign 昨日没有内容、工作流、发布或指标回收记录。"
          prerequisite="可以先生成一份当前执行摘要，或查看指挥中心待办。"
          action={(
            <div className="button-row">
              <button className="primary-button" type="button" onClick={() => setShowSummary(true)}>生成执行摘要</button>
              <a className="ghost-button" href="#/dashboard">查看指挥中心</a>
              <a className="ghost-button" href="#/publish">查看发布中心</a>
            </div>
          )}
        />
      ) : canShowFullReport ? (
        <DailyReportBody auxiliaryMode={auxiliaryMode} report={report} />
      ) : null}

      {showHistory && (
        <section className="table-card">
          <div className="panel-title"><div><p className="eyebrow">历史日报</p><h3>最近生成记录</h3></div></div>
          {report
            ? <article className="record-row"><strong>{report.report_for} 运营日报</strong><span>本次根据实时数据生成，未新建重复日报表。</span></article>
            : <div className="empty-card-inline">尚无可查看的日报记录。</div>}
        </section>
      )}

      {!userId && <button type="button" onClick={() => onNavigate('dashboard')}>返回指挥中心</button>}
    </section>
  );
}

function DailyReportBody({ auxiliaryMode, report }) {
  return (
    <>
      {!report.has_activity && <div className="notice warning">这是当前状态执行摘要，不是完整日报；昨日没有真实执行记录。</div>}
      {report.partial_data && (
        <div className="notice warning">
          部分数据源暂时不可用，本次日报已使用可读取的数据生成；缺失部分不会显示为 0。
          {auxiliaryMode === 'advanced' && report.unavailable_sources?.length > 0
            ? ` 脱敏来源：${report.unavailable_sources.join('、')}`
            : ''}
        </div>
      )}
      <div className="daily-report-grid">
        <ReportSection title="昨日完成" rows={report.yesterday_completed} empty="昨日没有完成记录。" />
        <ReportSection title="今日待办" rows={report.today_actions} empty="当前没有待办。" />
        <ReportSection
          title="发布表现"
          rows={[
            `已发布：${report.publish_performance.published}`,
            report.publish_performance.metrics_collected
              ? `已回收指标：${report.publish_performance.metrics_collected}`
              : '指标：平台暂不提供或尚未回收',
            report.publish_performance.best_content ? `最佳内容：${report.publish_performance.best_content}` : '',
          ]}
          empty="尚无发布表现。"
        />
        <ReportSection title="阻塞异常" rows={report.blockers} empty="当前没有影响业务的异常。" tone={report.blockers.length ? 'warning' : ''} />
        <ReportSection
          title="Agent 运行摘要"
          rows={[
            `运行 ${report.agent_summary.total} 次`,
            `完成 ${report.agent_summary.completed} 次`,
            `失败 ${report.agent_summary.failed} 次`,
          ]}
        />
        <ReportSection
          title="工作流任务摘要"
          rows={[
            `任务 ${report.workflow_summary.total} 个`,
            `完成 ${report.workflow_summary.completed} 个`,
            `运行中 ${report.workflow_summary.running} 个`,
            `失败 ${report.workflow_summary.failed} 个`,
          ]}
        />
      </div>

      <section className="table-card">
        <div className="panel-title"><div><p className="eyebrow">下一步建议</p><h3>今天优先推进</h3></div></div>
        <ol className="review-action-list">
          {(report.recommendations || []).slice(0, 5).map((item) => <li key={item}>{item}</li>)}
        </ol>
      </section>

      {auxiliaryMode === 'advanced' && report.failed_tasks.length > 0 && (
        <details className="table-card">
          <summary>技术错误详情</summary>
          {report.failed_tasks.map((task, index) => <p key={`${task.title}-${index}`}>{task.title}：{task.message}</p>)}
        </details>
      )}
    </>
  );
}

function ReportSection({ empty = '暂无记录。', rows = [], title, tone = '' }) {
  const values = (rows || []).filter(Boolean);
  return (
    <article className={`table-card daily-report-section ${tone}`}>
      <h3>{title}</h3>
      {values.length ? <ul>{values.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{empty}</p>}
    </article>
  );
}
