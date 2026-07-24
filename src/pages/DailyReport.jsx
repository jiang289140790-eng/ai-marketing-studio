import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { buildDailyReport, buildDataExport, downloadJson } from '../services/report-service';
import { isSupabaseConfigured } from '../services/supabase-client';

export function DailyReport({ userId }) {
  const [report, setReport] = useState(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    const nextReport = await buildDailyReport(userId);
    setReport(nextReport);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, [refresh]);

  async function handleExport() {
    try {
      const payload = await buildDataExport(userId);
      downloadJson(`ai-marketing-studio-backup-${new Date().toISOString().slice(0, 10)}.json`, payload);
      setMessage('重要数据备份已导出。');
    } catch (error) {
      setMessage(error.message);
    }
  }

  function handleReportDownload() {
    if (!report) return;
    downloadJson(`daily-ops-report-${report.report_for}.json`, report);
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">每日运营报告</p>
          <h2>运营日报</h2>
          <p>每天复盘昨日发现、生成、发布、表现、成本和下一步建议。</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={refresh} disabled={loading}>刷新报告</button>
          <button className="ghost-button" type="button" onClick={handleReportDownload} disabled={!report}>下载日报</button>
          <button className="primary-button" type="button" onClick={handleExport} disabled={!isSupabaseConfigured || !userId}>导出备份</button>
        </div>
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待数据服务配置" description="配置后会生成日报和重要数据备份。" />
      ) : !report ? (
        <EmptyState title="暂无报告" description="点击刷新报告生成昨日运营日报。" />
      ) : (
        <>
          <div className="stat-grid compact">
            <StatCard label="报告日期" value={report.report_for} hint="昨日运营数据" />
            <StatCard label="发现内容" value={report.discovered_content} hint="viral_contents" />
            <StatCard label="生成内容" value={report.generated_content} hint="workflow + content" />
            <StatCard label="发布内容" value={report.published_content} hint="publish_tasks published" />
            <StatCard label="采集指标" value={report.metrics_collected} hint="content_metrics" />
            <StatCard label="失败任务" value={report.failed_tasks.length} hint="待处理" />
          </div>

          <div className="stat-grid compact">
            <StatCard label="最佳内容" value={report.best_content} hint="最高表现内容" />
            <StatCard label="最佳账号" value={report.best_account} hint="最高转化/互动账号类型" />
            <StatCard label="昨日成本" value={Number(report.cost || 0).toFixed(4)} hint="tool_usage / cost_records" />
            <StatCard label="本月成本" value={Number(report.month_cost || 0).toFixed(4)} hint="个人AI运营成本" />
            <StatCard label="单条内容成本" value={Number(report.average_content_cost || 0).toFixed(4)} hint="本月成本 / 内容数" />
            <StatCard label="效果值" value={Number(report.effect_value || 0).toFixed(2)} hint="转化/收入/业务价值" />
          </div>

          {message && <div className="notice">{message}</div>}

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>失败任务</th>
                  <th>类型</th>
                  <th>错误详情</th>
                </tr>
              </thead>
              <tbody>
                {report.failed_tasks.map((task, index) => (
                  <tr key={`${task.title}-${index}`}>
                    <td>{task.title}</td>
                    <td>{task.type}</td>
                    <td>{task.message}</td>
                  </tr>
                ))}
                {report.failed_tasks.length === 0 && (
                  <tr>
                    <td colSpan="3">昨日暂无失败任务</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <article className="form-card">
            <p className="eyebrow">下一步行动</p>
            <h3>今日建议</h3>
            <ul>
              {report.recommendations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        </>
      )}
    </section>
  );
}
