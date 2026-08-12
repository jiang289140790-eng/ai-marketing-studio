import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatusBadge } from '../components/StatusBadge';
import { getAssets, loadGenerationTaskData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { buildAssetBusinessName, getAssetContext } from '../utils/asset-library-model';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import { formatDate, statusLabel } from '../utils/formatters';

const FILTERS = [
  ['queued', '排队中'],
  ['running', '运行中'],
  ['completed', '已完成'],
  ['failed', '失败'],
  ['cancelled', '已取消'],
];

function normalizedStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['pending', 'queued'].includes(value)) return 'queued';
  if (['running', 'generating'].includes(value)) return 'running';
  if (['success', 'completed'].includes(value)) return 'completed';
  if (['cancelled', 'canceled'].includes(value)) return 'cancelled';
  return value === 'failed' || value === 'error' ? 'failed' : 'queued';
}

export function GenerationTasksPage({
  activeCampaignId,
  auxiliaryMode = 'normal',
  campaignContext,
  dataScope = 'campaign',
  userId,
  detailId,
  onNavigate,
  routeParams = {},
}) {
  const [data, setData] = useState({ workflowRuns: [], characters: [], comfyWorkflows: [], assets: [], legacyAssets: [], contentPackages: [], campaigns: [] });
  const [filter, setFilter] = useState('queued');
  const [selectedId, setSelectedId] = useState(detailId || '');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  // P31 v2：草稿 → 图片生成准备 handoff
  const draftHandoff = useMemo(() => {
    if (!routeParams || !routeParams.draftId) return null;
    return {
      draftId: routeParams.draftId,
      title: routeParams.title || '',
      visualPlan: routeParams.visualPlan || '',
      aspectRatio: routeParams.aspectRatio || '1:1',
    };
  }, [routeParams]);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await loadGenerationTaskData();
      const scopeOptions = { scope: dataScope, campaignContext, activeCampaignId };
      setData({
        ...next,
        workflowRuns: filterRecordsForAuxiliaryScope(next.workflowRuns, scopeOptions),
        legacyAssets: filterRecordsForAuxiliaryScope(next.legacyAssets, scopeOptions),
      });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [activeCampaignId, campaignContext, dataScope, userId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (detailId) setSelectedId(detailId); }, [detailId]);

  const assets = useMemo(() => getAssets(data), [data]);
  const tasks = useMemo(() => data.workflowRuns.map((run) => {
    const input = run.input_data || {};
    const character = data.characters.find((row) => String(row.id) === String(run.character_id));
    const workflow = data.comfyWorkflows.find((row) => (
      String(row.id) === String(run.workflow_id)
      || row.name === run.tool_id
    ));
    const outputIds = new Set([...(run.asset_ids || []), run.output_data?.asset_id].filter(Boolean).map(String));
    const outputs = assets.filter((asset) => outputIds.has(String(asset.id)) || String(asset.generationJobId || '') === String(run.id));
    const packageId = input.content_package_id || input.contentPackageId || '';
    const contentPackage = data.contentPackages.find((row) => String(row.id) === String(packageId));
    const campaignId = input.campaign_id || contentPackage?.campaign_id || '';
    const campaign = data.campaigns.find((row) => String(row.id) === String(campaignId));
    return {
      ...run,
      normalizedStatus: normalizedStatus(run.status),
      character,
      workflow,
      outputs,
      contentPackage,
      campaign,
      day: Number(input.day || contentPackage?.source_insights?.day_index || outputs.map(getAssetContext).find((ctx) => ctx.day)?.day || 0) || null,
      provider: input.provider || run.output_data?.provider || workflow?.recommended_provider || '未上报',
      progress: run.status === 'success' ? 100 : Number(run.output_data?.progress || input.progress || (run.status === 'running' ? 50 : 0)),
    };
  }), [assets, data]);
  const visibleTasks = tasks.filter((task) => task.normalizedStatus === filter);
  const selected = tasks.find((task) => String(task.id) === String(selectedId)) || null;

  return (
    <section className="page-stack generation-tasks-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">执行过程</p>
          <h2>生成任务</h2>
          <p>这里只跟踪图片、视频和其它工作流的执行过程。任务完成后，真实文件进入素材库。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => onNavigate?.('workspace')}>在内容工作台创建任务</button>
      </div>
      {message && <div className={/失败|不可用/.test(message) ? 'notice error' : 'notice'}>{message}</div>}

      {/* P31 v2：草稿图片生成准备 */}
      {draftHandoff && (
        <div className="draft-handoff-panel" role="region" aria-label="准备从草稿生成图片">
          <div className="section-head">
            <div>
              <p className="eyebrow">图片生成准备</p>
              <h3>从草稿创建图片生成任务</h3>
            </div>
            <span className="status-badge approved">草稿已就绪</span>
          </div>
          <div className="draft-handoff-grid">
            <div className="detail-item"><span className="detail-label">草稿 ID</span><strong>{draftHandoff.draftId}</strong></div>
            <div className="detail-item"><span className="detail-label">标题</span><strong>{draftHandoff.title || '未命名'}</strong></div>
            <div className="detail-item"><span className="detail-label">画幅</span><strong>{draftHandoff.aspectRatio}</strong></div>
            <div className="detail-item detail-full"><span className="detail-label">视觉方案</span><strong>{draftHandoff.visualPlan || '暂无视觉描述'}</strong></div>
          </div>
          <p className="form-hint">
            来自 P31 内容工作台的草稿 handoff。你可以在此页面选择角色、LoRA 和工作流，基于上述视觉方案和画幅创建图片生成任务。草稿正文不会自动填充为生成 prompt——可根据需要在创建任务时手动组合。
          </p>
        </div>
      )}
      <div className="segmented-tabs generation-status-tabs">
        {FILTERS.map(([id, label]) => <button className={filter === id ? 'active' : ''} type="button" key={id} onClick={() => setFilter(id)}>{label}<strong>{tasks.filter((task) => task.normalizedStatus === id).length}</strong></button>)}
      </div>
      {loading ? (
        <div className="skeleton skeleton-card" />
      ) : !visibleTasks.length ? (
        <EmptyState title={`没有${statusLabel(filter)}任务`} description="生成任务必须从内容工作台发起，避免脱离内容、角色和素材上下文。" action={<button className="primary-button" type="button" onClick={() => onNavigate?.('workspace')}>进入内容工作台</button>} />
      ) : (
        <div className="generation-task-list">
          {visibleTasks.map((task) => (
            <article className="generation-task-card" key={task.id}>
              <div className="generation-task-head">
                <div><h3>{task.contentPackage?.title || `${task.character?.display_name || task.character?.name || '角色'}生成任务`}</h3><small>{task.campaign?.name || task.campaign?.title || '当前运营活动'} · {task.day ? `Day ${task.day}` : '未指定 Day'}</small></div>
                <StatusBadge status={task.normalizedStatus} />
              </div>
              <div className="generation-task-facts">
                <Fact label="角色" value={task.character?.display_name || task.character?.name || '未绑定'} />
                <Fact label="LoRA" value={task.character?.lora_info?.name || '未上报'} />
                <Fact label="工作流" value={task.workflow?.name || task.tool_id || '未上报'} />
                <Fact label="Provider" value={task.provider} />
                <Fact label="当前进度" value={`${task.progress}%`} />
                <Fact label="创建时间" value={formatDate(task.created_at)} />
                <Fact label="输出结果" value={task.outputs.length ? `${task.outputs.length} 个素材` : '等待回传'} />
                <Fact label="下一步" value={nextAction(task)} />
              </div>
              <div className="task-progress"><span style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} /></div>
              <div className="button-row">
                {task.outputs.length > 0 && <button className="primary-button compact" type="button" onClick={() => onNavigate?.('assets', task.outputs[0].id)}>查看结果</button>}
                {['queued', 'running'].includes(task.normalizedStatus) && (
                  <ExecutionButton
                    action="get_generation_job"
                    resourceType="generation_job"
                    resourceId={task.id}
                    payload={{ generation_job_id: task.id }}
                    onCompleted={() => refresh()}
                  >回传状态</ExecutionButton>
                )}
                {task.normalizedStatus === 'failed' && <button className="ghost-button compact" type="button" onClick={() => onNavigate?.('workspace', task.contentPackage?.id || '', { retry_job_id: task.id })}>准备重试</button>}
                {['queued', 'running'].includes(task.normalizedStatus) && <button className="ghost-button compact" type="button" disabled title="当前运行结构没有安全取消状态，避免伪造取消结果。">取消</button>}
                <button className="ghost-button compact" type="button" onClick={() => { setSelectedId(task.id); onNavigate?.('generation', task.id); }}>查看技术详情</button>
              </div>
              {task.normalizedStatus === 'failed' && <p className="quality-warning">重试会回到内容工作台重新确认参数和费用，不会在此自动调用付费工作流。</p>}
            </article>
          ))}
        </div>
      )}
      {selected && <GenerationTaskDrawer task={selected} mode={auxiliaryMode} onClose={() => { setSelectedId(''); onNavigate?.('generation'); }} onAsset={(id) => onNavigate?.('assets', id)} />}
    </section>
  );
}

function GenerationTaskDrawer({ task, mode, onClose, onAsset }) {
  return (
    <aside className="detail-drawer generation-task-drawer">
      <div className="detail-drawer-header"><div><p className="eyebrow">生成任务详情</p><h3>{task.contentPackage?.title || task.tool_id || '生成任务'}</h3><p>{statusLabel(task.normalizedStatus)} · {task.progress}%</p></div><button className="ghost-button" type="button" onClick={onClose}>关闭</button></div>
      <div className="drawer-body">
        <div className="drawer-section-grid">
          <DetailCard title="运营活动">{task.campaign?.name || '当前运营活动'}</DetailCard>
          <DetailCard title="Day">{task.day ? `Day ${task.day}` : '未指定'}</DetailCard>
          <DetailCard title="角色">{task.character?.name || '未绑定'}</DetailCard>
          <DetailCard title="LoRA">{task.character?.lora_info?.name || '未上报'}</DetailCard>
          <DetailCard title="工作流">{task.workflow?.name || task.tool_id || '未上报'}</DetailCard>
          <DetailCard title="Provider">{task.provider}</DetailCard>
        </div>
        <div className="drawer-list">
          {task.outputs.map((asset, index) => <article key={asset.id}><strong>{buildAssetBusinessName(asset, { characterName: task.character?.name, index: index + 1 })}</strong><button className="text-button" type="button" onClick={() => onAsset(asset.id)}>打开素材</button></article>)}
        </div>
        {mode === 'advanced' && <details className="technical-details" open data-technical-detail><summary>技术详情</summary><pre>{JSON.stringify({ id: task.id, workflow_id: task.workflow_id, tool_id: task.tool_id, status: task.status, error: task.error_message || task.last_error }, null, 2)}</pre></details>}
      </div>
    </aside>
  );
}

function nextAction(task) {
  if (task.normalizedStatus === 'completed') return task.outputs.length ? '审核输出素材' : '检查结果回传';
  if (task.normalizedStatus === 'failed') return '回内容工作台确认后重试';
  if (task.normalizedStatus === 'cancelled') return '无需处理';
  return '等待或回传状态';
}
function Fact({ label, value }) { return <div><span>{label}</span><strong>{value || '—'}</strong></div>; }
function DetailCard({ title, children }) { return <section className="detail-card"><span>{title}</span><div>{children}</div></section>; }

