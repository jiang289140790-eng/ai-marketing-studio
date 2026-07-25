import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ContextAIBox } from '../components/ContextAIBox';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatusBadge } from '../components/StatusBadge';
import {
  applyContextAIResult,
  displayText,
  findById,
  getAssets,
  getContentPackages,
  loadContentWorkspaceData,
  normalizeList,
  saveContentProductionBinding,
} from '../services/ops-service';
import { buildContentContext } from '../services/context-ai-service';
import { createPrompt } from '../services/prompt-service';
import { getExecutionStatus } from '../services/execution-gateway';
import { isSupabaseConfigured } from '../services/supabase-client';
import { normalizeContentPackageSequence } from '../utils/content-package-sequence';
import {
  buildReadiness,
  CONTENT_STATUS_LABELS,
  deriveContentDisplayStatus,
  getVersionsForPackage,
  getWorkbenchMetadata,
  statusPrimaryAction,
} from '../utils/day1-content-workbench';
import {
  filterUsableAssets,
  getCharacterLoras,
  getRecommendedWorkflows,
  inspectAssetAvailability,
  listJobsForContent,
} from '../utils/day1-asset-workbench';
import { formatDate } from '../utils/formatters';

const EMPTY = {
  contentPackages: [],
  legacyContent: [],
  campaigns: [],
  strategies: [],
  accounts: [],
  assets: [],
  legacyAssets: [],
  characters: [],
  workflowRuns: [],
  comfyWorkflows: [],
  publishTasks: [],
};

const VIDEO_MODES = [
  ['text_to_video', '文生视频'],
  ['image_to_video', '图生视频'],
  ['first_frame', '首帧生视频'],
  ['first_last_frame', '首尾帧生视频'],
  ['reference_video', '参考视频生成'],
  ['character_lora_video', '角色模型视频'],
  ['multi_shot', '多镜头分段生成'],
];

const WORKFLOW_FILTERS = [
  ['all', '全部'],
  ['pending_review', '待审核'],
  ['pending_asset', '待生成素材'],
  ['generated_asset', '已生成素材'],
  ['pending_publish', '待发布'],
  ['published', '已发布'],
  ['failed', '失败'],
  ['test', '测试数据'],
];

const IMAGE_REQUIREMENT_FIELDS = [
  ['subject', '画面主体'],
  ['character', '人物角色'],
  ['scene', '场景'],
  ['clothing', '服装'],
  ['expression', '表情'],
  ['composition', '构图'],
  ['lighting', '光线'],
  ['color', '色调'],
  ['aspect_ratio', '图片比例'],
  ['size', '图片尺寸'],
  ['lora', '角色模型（LoRA）'],
  ['lora_weight', '角色模型权重'],
  ['positive_prompt', '正向提示词'],
  ['negative_prompt', '负向提示词'],
  ['reference_assets', '参考素材'],
];

const VIDEO_REQUIREMENT_FIELDS = [
  ['type', '视频类型'],
  ['script', '视频脚本'],
  ['duration', '时长'],
  ['aspect_ratio', '画幅'],
  ['shot_count', '镜头数量'],
  ['shots', '分镜'],
  ['camera_motion', '镜头运动'],
  ['character_action', '人物动作'],
  ['scene_change', '场景变化'],
  ['first_frame', '首帧要求'],
  ['last_frame', '尾帧要求'],
  ['reference_video', '参考视频'],
  ['lora', '角色模型（LoRA）'],
  ['model', '生成模型'],
  ['negative_prompt', 'negative prompt'],
];

export function ContentWorkspacePage({ userId, onNavigate, detailId, routeParams = {}, activeCampaignId, campaignContext }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeWorkflow, setActiveWorkflow] = useState('all');
  const [hideTests, setHideTests] = useState(true);
  const [gateway, setGateway] = useState({ loading: true, connected: false });
  const [selectedStrategyId, setSelectedStrategyId] = useState(routeParams.strategy_id || '');
  const [selectedPackageId, setSelectedPackageId] = useState(detailId || '');

  const refreshData = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    setLoadError('');
    try {
      const nextData = await loadContentWorkspaceData();
      setData({ ...EMPTY, ...nextData });
    } catch (error) {
      setLoadError(error?.message || '内容工作台数据读取失败');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refreshData();
    return undefined;
  }, [refreshData]);

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    getExecutionStatus().then((status) => {
      if (!cancelled) setGateway({ loading: false, ...status });
    });
    return () => { cancelled = true; };
  }, [userId]);

  const contentPackages = useMemo(() => {
    const all = getContentPackages(data);
    if (!activeCampaignId) return [];
    const contextIds = new Set((campaignContext?.contentPackages || []).map((item) => String(item.id)));
    return all.filter((item) => (
      String(item.campaignId || item.campaign_id || '') === String(activeCampaignId)
      || contextIds.has(String(item.id))
    ));
  }, [activeCampaignId, campaignContext?.contentPackages, data]);
  const assets = useMemo(() => getAssets(data), [data]);
  const allSequence = useMemo(
    () => normalizeContentPackageSequence(contentPackages, data.strategies),
    [contentPackages, data.strategies],
  );
  const strategyOptions = useMemo(() => {
    const ids = new Set(contentPackages.map((item) => item.strategyId).filter(Boolean).map(String));
    return (data.strategies || []).filter((strategy) => ids.has(String(strategy.id)));
  }, [contentPackages, data.strategies]);

  useEffect(() => {
    const detailPackage = contentPackages.find((item) => String(item.id) === String(detailId));
    const requested = routeParams.strategy_id || detailPackage?.strategyId || '';
    if (requested && contentPackages.some((item) => String(item.strategyId) === String(requested))) {
      setSelectedStrategyId(String(requested));
      return;
    }
    if (selectedStrategyId && contentPackages.some((item) => String(item.strategyId) === String(selectedStrategyId))) return;
    const next = allSequence.find((item) => item.isCurrent)?.contentPackage?.strategyId
      || allSequence[0]?.contentPackage?.strategyId
      || '';
    setSelectedStrategyId(next ? String(next) : '');
  }, [allSequence, contentPackages, detailId, routeParams.strategy_id, selectedStrategyId]);

  const strategyPackages = useMemo(() => (
    selectedStrategyId
      ? contentPackages.filter((item) => String(item.strategyId) === String(selectedStrategyId))
      : contentPackages
  ), [contentPackages, selectedStrategyId]);
  const daySequence = useMemo(
    () => normalizeContentPackageSequence(strategyPackages, data.strategies),
    [data.strategies, strategyPackages],
  );
  const workflowCounts = useMemo(() => WORKFLOW_FILTERS.reduce((result, [id]) => {
    result[id] = contentPackages.filter((item) => contentMatchesWorkflow(item, id, data, assets)).length;
    return result;
  }, {}), [assets, contentPackages, data]);
  const filteredPackages = useMemo(() => strategyPackages.filter((item) => {
    if (hideTests && activeWorkflow !== 'test' && isTestContent(item)) return false;
    return contentMatchesWorkflow(item, activeWorkflow, data, assets);
  }), [activeWorkflow, assets, data, hideTests, strategyPackages]);
  const visibleSequence = useMemo(() => {
    const allowed = new Set(filteredPackages.map((item) => String(item.id)));
    return daySequence.filter((item) => allowed.has(String(item.id)));
  }, [daySequence, filteredPackages]);

  useEffect(() => {
    const requestedDay = Number(routeParams.day);
    const detailMatch = visibleSequence.find((item) => String(item.id) === String(detailId));
    const dayMatch = Number.isFinite(requestedDay) && requestedDay > 0
      ? visibleSequence.find((item) => item.dayIndex === requestedDay)
      : null;
    const selectedStillExists = visibleSequence.find((item) => String(item.id) === String(selectedPackageId));
    const next = detailMatch || dayMatch || selectedStillExists || visibleSequence.find((item) => item.isCurrent) || visibleSequence[0];
    setSelectedPackageId(next?.id ? String(next.id) : '');
  }, [detailId, routeParams.day, selectedPackageId, visibleSequence]);

  const selectedSequence = visibleSequence.find((item) => String(item.id) === String(selectedPackageId))
    || visibleSequence.find((item) => item.isCurrent)
    || visibleSequence[0];
  const selectedItem = selectedSequence?.contentPackage;
  const selectedCampaign = findById(data.campaigns, selectedItem?.campaignId);
  const selectedStrategy = findById(data.strategies, selectedItem?.strategyId || selectedStrategyId);
  const selectedCharacter = findById(data.characters, selectedItem?.characterId);
  const selectedLora = getLoraInfo(selectedCharacter, selectedItem || {});
  const selectedLinkedAssets = selectedItem ? assetsForContent(selectedItem, assets) : [];
  const selectedRuns = selectedItem ? runsForContent(selectedItem, data.workflowRuns || []) : [];
  const selectedPublishTask = selectedItem
    ? (data.publishTasks || []).find((task) => String(task.content_package_id || task.content_id || '') === String(selectedItem.id))
    : null;
  const selectedGuide = selectedItem
    ? buildProductionGuide({
      item: selectedItem,
      character: selectedCharacter,
      lora: selectedLora,
      linkedAssets: selectedLinkedAssets,
      workflowRuns: selectedRuns,
      publishTask: selectedPublishTask,
      gateway,
    })
    : null;

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待数据服务配置" description="配置完成后，内容工作台会读取真实内容、素材、角色和生成任务。" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看内容工作台。" />;
  }

  return (
    <section className="page-stack content-workspace-page">
      {loadError && (
        <div className="notice error" role="alert">
          内容工作台数据读取失败：{loadError}
        </div>
      )}
      <div className="hero-panel">
        <p className="eyebrow">内容工作台</p>
        <h2>按策略日程推进每日内容生产</h2>
        <p>
          从 Day 1 开始，依次完成文案、角色模型、素材、视觉生成、结果审核和发布队列。
          页面只突出当前需要处理的一天和下一步动作。
        </p>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>打开素材库</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>打开角色库</button>
        </div>
      </div>

      {!gateway.loading && !gateway.connected && (
        <div className="execution-service-notice">
          <div><strong>执行服务暂未连接</strong><span>内容查看、编辑和审核不受影响；生成、导入与发布动作暂不可执行。</span></div>
          <button className="ghost-button" type="button" onClick={() => onNavigate('dashboard')}>查看运营指挥中心的执行服务状态</button>
        </div>
      )}

      {selectedSequence && selectedGuide && (
        <StrategyDayProgress
          campaign={selectedCampaign}
          strategy={selectedStrategy}
          sequence={visibleSequence}
          selected={selectedSequence}
          guide={selectedGuide}
          strategyOptions={strategyOptions}
          selectedStrategyId={selectedStrategyId}
          onStrategyChange={(strategyId) => {
            setSelectedStrategyId(strategyId);
            setSelectedPackageId('');
            onNavigate('workspace', '', { strategy_id: strategyId, day: 1 });
          }}
        />
      )}

      <div className="day-production-layout">
        <aside className="day-plan-panel" aria-label="七天内容计划">
          <div className="day-plan-panel-head">
            <div><span>策略日程</span><strong>{visibleSequence.length || 0} 天内容计划</strong></div>
            <small>按 Day 顺序生产</small>
          </div>
          <div className="day-plan-list">
            {visibleSequence.map((sequenceItem) => (
              <button
                type="button"
                key={sequenceItem.id}
                className={`day-plan-item ${String(sequenceItem.id) === String(selectedSequence?.id) ? 'active' : ''} ${sequenceItem.isCompleted ? 'completed' : ''} ${sequenceItem.isBlocked ? 'blocked' : ''}`}
                onClick={() => {
                  setSelectedPackageId(String(sequenceItem.id));
                  onNavigate('workspace', sequenceItem.id, {
                    strategy_id: sequenceItem.contentPackage.strategyId || selectedStrategyId,
                    day: sequenceItem.dayIndex,
                  });
                }}
              >
                <span className="day-plan-index">{sequenceItem.dayLabel}</span>
                <span className="day-plan-copy">
                  <strong>{sequenceItem.pillar}</strong>
                  <small>{sequenceItem.platform} · {sequenceItem.productionStep.label}</small>
                </span>
                <span className={`day-plan-state ${sequenceItem.isCompleted ? 'completed' : sequenceItem.isBlocked ? 'blocked' : 'pending'}`}>
                  {sequenceItem.isCompleted ? '完成' : sequenceItem.isBlocked ? '阻塞' : '进行中'}
                </span>
              </button>
            ))}
            {!visibleSequence.length && <div className="empty-card-inline">当前策略还没有可用的 Day 内容包。</div>}
          </div>
        </aside>

        <main className="current-day-production">
          {selectedItem ? (
            selectedSequence.dayIndex === 1 ? (
              <DayOneContentWorkbench
                key={`${selectedItem.sourceKey}-${selectedItem.id}`}
                item={selectedItem}
                data={data}
                assets={assets}
                onNavigate={onNavigate}
                onRefresh={refreshData}
              />
            ) : (
              <ContentPackageCard
                key={`${selectedItem.sourceKey}-${selectedItem.id}`}
                item={selectedItem}
                data={data}
                assets={assets}
                gateway={gateway}
                userId={userId}
                onNavigate={onNavigate}
                onRefresh={refreshData}
                initialOpen
                dayIndex={selectedSequence.dayIndex}
                strategyId={selectedStrategyId}
              />
            )
          ) : (
            <EmptyState
              title={loading ? '正在读取内容包' : '没有匹配的内容包'}
              description="批准策略后，Day 1 到 Day 7 的内容会按顺序显示在这里。"
            />
          )}
        </main>
      </div>

      <details className="content-workspace-secondary">
        <summary>筛选与查看其它内容</summary>
        <div className="content-workflow-toolbar">
          <div className="workflow-filter-list" aria-label="内容工作流筛选">
            {WORKFLOW_FILTERS.map(([id, label]) => (
              <button className={activeWorkflow === id ? 'active' : ''} type="button" key={id} onClick={() => setActiveWorkflow(id)}>
                {label}<span>{workflowCounts[id] || 0}</span>
              </button>
            ))}
          </div>
          <label className="hide-test-toggle">
            <input type="checkbox" checked={hideTests} onChange={(event) => setHideTests(event.target.checked)} />
            隐藏测试内容
          </label>
        </div>
      </details>

    </section>
  );
}

function StrategyDayProgress({
  campaign,
  strategy,
  sequence,
  selected,
  guide,
  strategyOptions,
  selectedStrategyId,
  onStrategyChange,
}) {
  const stages = [
    ['copy', '文案确认', ['copy']],
    ['role', '角色 / LoRA 确认', ['role']],
    ['reference', '素材引用', ['reference']],
    ['visual', '视觉生成', ['image', 'video', 'results']],
    ['review', '结果审核', ['approval']],
    ['publish', '发布队列', ['publish']],
  ].map(([id, label, ids]) => {
    const related = guide.steps.filter((step) => ids.includes(step.id));
    const completed = related.length > 0 && related.every((step) => step.status === 'completed');
    const active = related.some((step) => step.id === guide.current.id);
    return { id, label, completed, active };
  });

  return (
    <section className="strategy-day-progress">
      <div className="strategy-day-progress-head">
        <div>
          <span>当前运营活动</span>
          <strong>{campaign?.name || campaign?.title || '未关联运营活动'}</strong>
        </div>
        <label>当前策略
          <select value={selectedStrategyId} onChange={(event) => onStrategyChange(event.target.value)}>
            {strategyOptions.map((option) => (
              <option value={option.id} key={option.id}>{option.name || option.title || option.id}</option>
            ))}
            {!strategyOptions.length && <option value="">{strategy?.name || strategy?.title || '未关联策略'}</option>}
          </select>
        </label>
        <div className="current-day-badge">
          <span>当前日程</span>
          <strong>{selected.dayLabel} / {Math.max(sequence.length, 1)}</strong>
        </div>
        <div>
          <span>当前生产阶段</span>
          <strong>{guide.current.label}</strong>
        </div>
      </div>
      <div className="strategy-production-stages" aria-label="当前 Day 生产阶段">
        {stages.map((stage, index) => (
          <div className={`strategy-production-stage ${stage.completed ? 'completed' : ''} ${stage.active ? 'active' : ''}`} key={stage.id}>
            <span>{stage.completed ? '✓' : index + 1}</span>
            <strong>{stage.label}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function DayOneContentWorkbench({ item, data, assets, onNavigate, onRefresh }) {
  const campaign = findById(data.campaigns, item.campaignId);
  const strategy = findById(data.strategies, item.strategyId);
  const account = findById(data.accounts, item.accountId);
  const metadata = getWorkbenchMetadata(item);
  const plan = safeJson(item.raw?.source_insights)?.plan_data || {};
  const versions = useMemo(
    () => getVersionsForPackage(data.legacyContent, item.id),
    [data.legacyContent, item.id],
  );
  const selectedVersion = versions.find((version) => String(version.id) === String(metadata.selected_version_id || ''));
  const [draft, setDraft] = useState(() => copyFromVersion(selectedVersion, item));
  const campaignDefaultCharacterId = campaign?.metadata?.default_character_id || campaign?.metadata?.character_id || '';
  const [selectedCharacterId, setSelectedCharacterId] = useState(item.characterId || campaignDefaultCharacterId);
  const selectedCharacter = findById(data.characters, selectedCharacterId) || findById(data.characters, item.characterId);
  const loraOptions = getCharacterLoras(selectedCharacter, item);
  const [selectedLoraKey, setSelectedLoraKey] = useState(item.loraId || '');
  const lora = loraOptions.find((option) => loraOptionKey(option) === selectedLoraKey) || loraOptions[0] || {};
  const [loraWeight, setLoraWeight] = useState(Number(item.loraInfo?.weight || lora.weight || lora.strength || 0.8));
  const [assetType, setAssetType] = useState('image');
  const workflowOptions = getRecommendedWorkflows(selectedCharacter, data.comfyWorkflows || [], assetType);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const selectedWorkflow = findById(workflowOptions, selectedWorkflowId) || workflowOptions[0] || null;
  const [runtimeBrokenAssetIds, setRuntimeBrokenAssetIds] = useState([]);
  const linkedAssets = assetsForContent(item, assets);
  const usableAssets = filterUsableAssets(linkedAssets).filter((asset) => !runtimeBrokenAssetIds.includes(String(asset.id)));
  const campaignAssetOptions = filterUsableAssets(assets.filter((asset) => (
    String(asset.campaignId || '') === String(item.campaignId || '')
    && String(asset.contentId || '') !== String(item.id)
    && Boolean(asset.raw?.asset_type)
  ))).filter((asset) => !runtimeBrokenAssetIds.includes(String(asset.id)));
  const brokenAssets = linkedAssets.filter((asset) => (
    !inspectAssetAvailability(asset).usable || runtimeBrokenAssetIds.includes(String(asset.id))
  ));
  const generationJobs = listJobsForContent(data.workflowRuns || [], item.id);
  const publishTask = (data.publishTasks || []).find((task) => String(task.content_package_id || task.content_id || '') === String(item.id));
  const primaryAsset = usableAssets.find((asset) => asset.isPrimary || asset.raw?.metadata?.is_primary)
    || usableAssets.find((asset) => String(asset.id) === String(metadata.primary_asset_id || ''));
  const readinessAssets = primaryAsset ? [primaryAsset] : usableAssets;
  const readiness = buildReadiness({
    contentPackage: item,
    copy: draft,
    assets: readinessAssets,
    publishTask,
    character: selectedCharacter,
    lora,
  });
  const displayStatus = deriveContentDisplayStatus({
    contentPackage: item,
    assets: usableAssets,
    publishTask,
    selectedVersionId: metadata.selected_version_id,
  });
  const approvedAsset = primaryAsset?.approvedForPublishing || primaryAsset?.raw?.approved_for_publishing
    ? primaryAsset
    : readiness.approvedAssets[0];
  const nextAction = statusPrimaryAction(displayStatus);
  const imageRequirements = normalizeRequirement(item.imageRequirements || item.assetRequirement);
  const videoRequirements = normalizeRequirement(item.videoRequirements || item.assetRequirement);
  const boundAccountIds = normalizeList(
    selectedCharacter?.bound_account_ids
    || selectedCharacter?.lora_info?.bound_account_ids
    || selectedCharacter?.prompt_templates?.bound_account_ids,
  );
  const boundAccounts = boundAccountIds
    .map((id) => findById(data.accounts, id))
    .filter(Boolean);
  const characterReferences = filterUsableAssets(assets.filter((asset) => (
    String(asset.characterId || asset.raw?.metadata?.character_id || '') === String(selectedCharacter?.id || '')
    && asset.raw?.metadata?.role === 'reference'
  )));
  const selectedReferenceAsset = characterReferences.find((asset) => item.referenceAssetIds?.map(String).includes(String(asset.id)))
    || characterReferences[0]
    || null;
  const generationReason = !selectedCharacter
    ? '请先选择角色'
    : !hasLora(lora)
      ? '所选角色还没有可用的 LoRA'
      : !metadata.copy_approved
        ? '文案批准后才能进入正式素材生成'
        : undefined;
  const journey = buildDayOneJourney({
    plan,
    strategy,
    metadata,
    generationJobs,
    usableAssets,
    approvedAsset,
    item,
    publishTask,
  });
  const currentJourneyStepId = journey.current.id;
  const [activeJourneyStep, setActiveJourneyStep] = useState(currentJourneyStepId);

  useEffect(() => {
    setDraft(copyFromVersion(selectedVersion, item));
  }, [item, selectedVersion]);

  useEffect(() => {
    setSelectedCharacterId(item.characterId || campaignDefaultCharacterId);
    setSelectedLoraKey(item.loraId || '');
    setLoraWeight(Number(item.loraInfo?.weight || 0.8));
  }, [campaignDefaultCharacterId, item.characterId, item.id, item.loraId, item.loraInfo?.weight]);

  useEffect(() => {
    setSelectedWorkflowId('');
  }, [assetType, selectedCharacterId]);

  useEffect(() => {
    setRuntimeBrokenAssetIds([]);
  }, [item.id]);

  useEffect(() => {
    setActiveJourneyStep(currentJourneyStepId);
  }, [currentJourneyStepId, item.id]);

  async function saveCharacterBinding() {
    await saveContentProductionBinding(item, {
      strategyId: item.strategyId || null,
      characterId: selectedCharacter?.id || null,
      loraId: lora.id || lora.model || lora.filename || null,
      loraInfo: hasLora(lora) ? { ...lora, weight: loraWeight } : null,
      referenceAssetIds: item.referenceAssetIds || [],
      referenceSource: item.referenceSource || '',
      generationMode: selectedWorkflow?.id || item.generationMode || 'character_lora_video',
    });
    await onRefresh();
  }

  function markRuntimeBrokenAsset(assetId) {
    setRuntimeBrokenAssetIds((current) => current.includes(String(assetId)) ? current : [...current, String(assetId)]);
  }

  return (
    <article className="day1-workbench-card">
      <header className="day1-context-header">
        <div>
          <p className="eyebrow">Day 1 内容工作台</p>
          <h2>{plan.topic || formatDayPackageTitle(item.title, 1)}</h2>
          <p>{plan.objective || campaign?.goal || '完成 Day 1 内容生产并进入待发布状态。'}</p>
        </div>
        <div className="day1-status-block">
          <span>当前状态</span>
          <strong>{CONTENT_STATUS_LABELS[displayStatus] || displayStatus}</strong>
          <small>下一步：{nextAction}</small>
        </div>
      </header>

      <div className="day1-context-grid">
        <Info label="运营活动" value={campaign?.name} />
        <Info label="运营账号" value={account?.account_name || account?.username} />
        <Info label="平台" value={item.platform} />
        <Info label="Day 1 主题" value={plan.topic || item.title} />
        <Info label="内容目标" value={plan.objective || campaign?.goal} />
        <Info label="内容支柱" value={plan.content_pillar || plan.pillar} />
        <Info label="开头类型" value={plan.hook_type || item.hook} />
        <Info label="计划发布时间" value={item.scheduledAt ? formatDate(item.scheduledAt) : plan.planned_date} />
        <Info label="角色" value={selectedCharacter?.display_name || selectedCharacter?.name || '待选择'} />
      </div>

      <nav className="day1-journey" aria-label="Day 1 生产流程">
        {journey.steps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            className={`${step.state} ${activeJourneyStep === step.id ? 'selected' : ''}`}
            disabled={step.state === 'waiting'}
            onClick={() => setActiveJourneyStep(step.id)}
          >
            <span>{step.state === 'completed' ? '✓' : index + 1}</span>
            <strong>{step.label}</strong>
            <small>{step.state === 'completed' ? '已完成' : step.state === 'current' ? '当前处理' : '等待上一步完成'}</small>
          </button>
        ))}
      </nav>

      <section className="day1-workbench-section plan-section" hidden={activeJourneyStep !== 'plan'}>
        <div className="section-head">
          <div><p className="eyebrow">1 · 计划说明</p><h3>Day 1 生产简报</h3></div>
          <StatusBadge status={strategy?.status || 'approved'} />
        </div>
        <div className="business-grid">
          <Info label="内容角色" value={plan.content_role} />
          <Info label="内容形式" value={plan.format} />
          <Info label="素材要求" value={plan.media_requirement} />
          <Info label="行动引导" value={plan.CTA || item.cta} />
          <Info label="计划备注" value={plan.notes} />
          <Info label="策略" value={strategy?.name || strategy?.title} />
        </div>
      </section>

      <section className="day1-workbench-section copy-section" hidden={activeJourneyStep !== 'copy'}>
        <div className="section-head">
          <div><p className="eyebrow">2 · 文案生成与审核</p><h3>候选版本与主版本</h3></div>
          {!metadata.copy_approved && (
            <ExecutionButton
              action="generate_content_for_package"
              actionName="生成 3 个候选版本"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ campaign_id: item.campaignId, content_package_id: item.id, candidate_count: 3 }}
              onCompleted={onRefresh}
            >
              生成 3 个候选版本
            </ExecutionButton>
          )}
        </div>

        <div className="content-version-grid">
          {versions.map((version) => {
            const selected = String(version.id) === String(metadata.selected_version_id || '');
            return (
              <article className={`content-version-card ${selected ? 'selected' : ''}`} key={version.id}>
                <div className="version-card-head">
                  <strong>版本 {version.versionNumber || '—'}</strong>
                  <span>{revisionTypeLabel(version.revisionType)}</span>
                </div>
                <h4>{version.hook || version.title}</h4>
                <p>{truncate(version.body, 180)}</p>
                <div className="button-row">
                  <ExecutionButton
                    action="select_content_version"
                    actionName="设为主版本"
                    className={selected ? 'ghost-button' : 'primary-button'}
                    resourceType="content_package"
                    resourceId={item.id}
                    ready={!metadata.copy_approved}
                    reason={metadata.copy_approved ? '文案已批准，如需切换请先要求修改' : undefined}
                    payload={{ campaign_id: item.campaignId, content_package_id: item.id, version_id: version.id }}
                    onCompleted={onRefresh}
                  >
                    {selected ? '当前主版本' : '设为主版本'}
                  </ExecutionButton>
                </div>
              </article>
            );
          })}
          {!versions.length && <div className="empty-card-inline">还没有候选版本。点击“生成 3 个候选版本”开始。</div>}
        </div>

        <div className="copy-editor-preview-grid">
          <div className="day1-copy-editor">
            <label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>开头<input value={draft.hook} onChange={(event) => setDraft({ ...draft, hook: event.target.value })} /></label>
            <label>正文<textarea rows="10" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></label>
            <label>行动引导<input value={draft.cta} onChange={(event) => setDraft({ ...draft, cta: event.target.value })} /></label>
            <label>标签<input value={draft.hashtags} onChange={(event) => setDraft({ ...draft, hashtags: event.target.value })} /></label>
            {!metadata.copy_approved && <div className="button-row">
              <ExecutionButton
                action="revise_content"
                actionName="保存为新版本"
                resourceType="content_package"
                resourceId={item.id}
                ready={Boolean(metadata.selected_version_id && draft.body.trim())}
                reason={!metadata.selected_version_id ? '请先选择主版本' : !draft.body.trim() ? '正文不能为空' : undefined}
                payload={{
                  campaign_id: item.campaignId,
                  content_package_id: item.id,
                  version_id: metadata.selected_version_id,
                  operation: 'manual_edit',
                  manual_content: {
                    title: draft.title,
                    hook: draft.hook,
                    body: draft.body,
                    cta: draft.cta,
                    hashtags: normalizeList(draft.hashtags),
                    language_style: selectedVersion?.languageStyle || item.languageStyle,
                  },
                }}
                onCompleted={onRefresh}
              >
                保存为新版本
              </ExecutionButton>
              {[
                ['shorten', '缩短'],
                ['enhance_hook', '增强开头'],
                ['add_question', '增加互动问题'],
                ['regenerate', '重新生成'],
              ].map(([operation, label]) => (
                <ExecutionButton
                  key={operation}
                  action="revise_content"
                  actionName={label}
                  className="ghost-button"
                  resourceType="content_package"
                  resourceId={item.id}
                  ready={Boolean(metadata.selected_version_id)}
                  reason={!metadata.selected_version_id ? '请先选择主版本' : undefined}
                  payload={{
                    campaign_id: item.campaignId,
                    content_package_id: item.id,
                    version_id: metadata.selected_version_id,
                    operation,
                  }}
                  onCompleted={onRefresh}
                >
                  {label}
                </ExecutionButton>
              ))}
              <ExecutionButton
                action="revise_content"
                actionName="改变语气"
                className="ghost-button"
                resourceType="content_package"
                resourceId={item.id}
                ready={Boolean(metadata.selected_version_id)}
                reason={!metadata.selected_version_id ? '请先选择主版本' : undefined}
                payload={() => ({
                  campaign_id: item.campaignId,
                  content_package_id: item.id,
                  version_id: metadata.selected_version_id,
                  operation: 'change_tone',
                  tone: window.prompt('请输入目标语气，例如：自然、克制、有亲和力') || '自然、有亲和力',
                })}
                onCompleted={onRefresh}
              >
                改变语气
              </ExecutionButton>
              <ExecutionButton
                action="revise_content"
                actionName="平台本地化"
                className="ghost-button"
                resourceType="content_package"
                resourceId={item.id}
                ready={Boolean(metadata.selected_version_id)}
                reason={!metadata.selected_version_id ? '请先选择主版本' : undefined}
                payload={{
                  campaign_id: item.campaignId,
                  content_package_id: item.id,
                  version_id: metadata.selected_version_id,
                  operation: 'localize',
                  locale: item.platform,
                }}
                onCompleted={onRefresh}
              >
                平台本地化
              </ExecutionButton>
            </div>}
          </div>

          <div className="platform-preview-card">
            <div className="platform-preview-head">
              <span>{item.platform || '平台'} 预览</span>
              <small>{account?.username ? `@${String(account.username).replace(/^@/, '')}` : account?.account_name}</small>
            </div>
            <strong>{draft.hook || draft.title || '等待选择主版本'}</strong>
            <p>{draft.body || '生成并选择候选版本后，这里会显示平台预览。'}</p>
            <p className="preview-cta">{draft.cta}</p>
            <div className="preview-tags">{normalizeList(draft.hashtags).map((tag) => <span key={tag}>{tag.startsWith('#') ? tag : `#${tag}`}</span>)}</div>
          </div>
        </div>

        <div className="copy-review-actions">
          {!metadata.copy_approved && (
            <ExecutionButton
              action="approve_content"
              actionName="批准文案"
              resourceType="content_package"
              resourceId={item.id}
              ready={Boolean(metadata.selected_version_id)}
              reason={!metadata.selected_version_id ? '请先选择主版本' : undefined}
              payload={{ campaign_id: item.campaignId, content_package_id: item.id, version_id: metadata.selected_version_id }}
              onCompleted={onRefresh}
            >
              批准文案
            </ExecutionButton>
          )}
          <ExecutionButton
            action="request_content_revision"
            actionName="要求修改"
            className="ghost-button"
            resourceType="content_package"
            resourceId={item.id}
            ready={Boolean(metadata.selected_version_id)}
            reason={!metadata.selected_version_id ? '请先选择主版本' : undefined}
            payload={() => ({
              campaign_id: item.campaignId,
              content_package_id: item.id,
              feedback: window.prompt('请输入修改意见') || '请根据审核意见修改文案。',
            })}
            onCompleted={onRefresh}
          >
            要求修改
          </ExecutionButton>
        </div>
      </section>

      <section
        className="day1-workbench-section production-section"
        hidden={!['visual', 'asset'].includes(activeJourneyStep)}
      >
        <div className="section-head">
          <div><p className="eyebrow">3 · 角色、LoRA 与素材</p><h3>视觉生产与素材确认</h3></div>
          <span className="context-sync-badge">{linkedAssets.length} 个关联素材</span>
        </div>
        <div className="day1-character-panel">
          <div className="production-binding-selectors">
            <label>角色来源
              <select
                value={selectedCharacterId}
                onChange={(event) => {
                  const nextCharacter = findById(data.characters, event.target.value);
                  const nextLora = getCharacterLoras(nextCharacter, item)[0];
                  setSelectedCharacterId(event.target.value);
                  setSelectedLoraKey(nextLora ? loraOptionKey(nextLora) : '');
                  setLoraWeight(Number(nextLora?.weight || nextLora?.strength || 0.8));
                }}
              >
                <option value="">请选择角色</option>
                {(data.characters || []).filter((character) => character.status !== 'archived').map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.display_name || character.name}
                    {String(character.id) === String(campaignDefaultCharacterId) ? '（Campaign 默认）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>LoRA
              <select value={hasLora(lora) ? loraOptionKey(lora) : ''} onChange={(event) => setSelectedLoraKey(event.target.value)}>
                {!loraOptions.length && <option value="">未配置 LoRA</option>}
                {loraOptions.map((option) => (
                  <option key={loraOptionKey(option)} value={loraOptionKey(option)}>
                    {option.name || option.model || option.filename} {option.version ? `· ${option.version}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>本次 LoRA 权重
              <input
                type="number"
                min="0"
                max="2"
                step="0.05"
                value={loraWeight}
                onChange={(event) => setLoraWeight(Number(event.target.value))}
              />
            </label>
            <button className="ghost-button" type="button" onClick={saveCharacterBinding} disabled={!selectedCharacter || !hasLora(lora)}>
              保存为 Day 1 覆盖配置
            </button>
          </div>
          <div className="character-context-summary">
            <Info label="人物身份" value={selectedCharacter?.content_positioning || selectedCharacter?.description} />
            <Info label="外观" value={selectedCharacter?.appearance || selectedCharacter?.visual_spec} />
            <Info label="性格" value={selectedCharacter?.personality || selectedCharacter?.personality_traits} />
            <Info label="文案语气" value={selectedCharacter?.prompt_templates?.copy_tone || selectedCharacter?.prompt_templates?.tone} />
            <Info label="基础 Prompt" value={selectedCharacter?.prompt || selectedCharacter?.prompt_templates?.base_prompt} />
            <Info label="Negative Prompt" value={selectedCharacter?.prompt_templates?.negative_prompt || selectedCharacter?.forbidden_styles} />
            <Info label="绑定账号" value={boundAccounts.map((entry) => entry.account_name || entry.username)} />
            <Info label="参考图" value={characterReferences.length ? `${characterReferences.length} 个可用` : '暂无可用参考图'} />
            <Info label="角色状态" value={selectedCharacter?.status || '待选择'} />
          </div>
          <p className="form-hint">这里保存的是当前 Day 1 覆盖配置，不会改写角色库的全局 LoRA、权重或推荐工作流。</p>
        </div>

        <div className="day1-generation-config">
          <div className="asset-type-tabs">
            <button className={assetType === 'image' ? 'active' : ''} type="button" onClick={() => setAssetType('image')}>图片任务</button>
            <button className={assetType === 'video' ? 'active' : ''} type="button" onClick={() => setAssetType('video')}>视频任务</button>
          </div>
          <label>推荐工作流
            <select value={selectedWorkflow?.id || ''} onChange={(event) => setSelectedWorkflowId(event.target.value)}>
              {!workflowOptions.length && <option value="">暂无可用工作流</option>}
              {workflowOptions.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name} · {workflow.version || '当前版本'}
                </option>
              ))}
            </select>
          </label>
          <Info label="角色参考素材" value={selectedReferenceAsset?.name || '不使用参考素材'} />
          <ExecutionButton
            action="create_asset_generation_job"
            actionName={`创建${assetType === 'image' ? '图片' : '视频'}生成任务`}
            resourceType="content_package"
            resourceId={item.id}
            reason={generationReason || (!selectedWorkflow ? `没有可用的${assetType === 'image' ? '图片' : '视频'}工作流` : undefined)}
            payload={{
              campaign_id: item.campaignId,
              content_package_id: item.id,
              content_item_id: metadata.selected_version_id,
              character_id: selectedCharacter?.id,
              asset_type: assetType,
              lora,
              lora_weight: loraWeight,
              workflow_id: selectedWorkflow?.id,
              reference_asset_id: selectedReferenceAsset?.id,
              prompt: assetType === 'image'
                ? imageRequirements.positive_prompt || `${draft.hook}。${draft.body}`
                : videoRequirements.script || `${draft.hook}。${draft.body}`,
              negative_prompt: imageRequirements.negative_prompt || videoRequirements.negative_prompt || lora.negative_prompt,
              provider: 'autodl',
            }}
            onCompleted={onRefresh}
          >
            创建{assetType === 'image' ? '图片' : '视频'}生成任务
          </ExecutionButton>
        </div>

        <div className="day1-generation-jobs">
          <div className="section-head compact"><strong>生成任务</strong><span>{generationJobs.length} 个</span></div>
          {generationJobs.map((job) => (
            <article className="generation-job-row" key={job.id}>
              <div>
                <strong>{job.assetType === 'video' ? '视频' : '图片'} · {job.workflowName}</strong>
                <small>{job.provider} · {formatDate(job.createdAt)}</small>
              </div>
              <span className={`status-badge ${job.status}`}>{job.statusLabel}</span>
              <progress max="100" value={job.progress} />
              {job.errorSummary && <small className="error-text">{job.errorSummary}</small>}
              <ExecutionButton
                action="get_generation_job"
                actionName="刷新任务进度"
                className="ghost-button"
                resourceType="workflow_run"
                resourceId={job.id}
                payload={{ generation_job_id: job.id }}
                onCompleted={onRefresh}
              >
                刷新进度
              </ExecutionButton>
              {['failed', 'cancelled', 'canceled'].includes(job.status) && (
                <ExecutionButton
                  action="retry_generation_job"
                  actionName="重试生成任务"
                  className="ghost-button"
                  resourceType="workflow_run"
                  resourceId={job.id}
                  payload={{ generation_job_id: job.id }}
                  onCompleted={onRefresh}
                >
                  重试
                </ExecutionButton>
              )}
            </article>
          ))}
          {!generationJobs.length && <div className="empty-card-inline">还没有生成任务。确认文案、角色、LoRA 和工作流后创建任务。</div>}
        </div>

        <div className="day1-asset-grid">
          {usableAssets.map((asset) => {
            const primary = String(asset.id) === String(primaryAsset?.id || '');
            const approved = asset.approvedForPublishing || asset.raw?.approved_for_publishing;
            return (
              <article className={`day1-asset-card ${approved ? 'approved' : ''} ${primary ? 'primary' : ''}`} key={asset.id}>
                <AssetPreview asset={asset} compact onBroken={() => markRuntimeBrokenAsset(asset.id)} />
                <div>
                  <strong>{asset.name}</strong>
                  <small>{asset.type} · {approved ? '已批准' : '待审核'} {primary ? '· 主素材' : ''}</small>
                </div>
                <div className="button-row">
                  <ExecutionButton
                    action="attach_asset_to_content"
                    actionName="关联到 Day 1"
                    className="ghost-button"
                    resourceType="asset"
                    resourceId={asset.id}
                    payload={{ campaign_id: item.campaignId, content_package_id: item.id, asset_id: asset.id, usage: 'candidate' }}
                    onCompleted={onRefresh}
                  >
                    关联
                  </ExecutionButton>
                  {!primary && (
                    <ExecutionButton
                      action="set_primary_asset"
                      actionName="设为主素材"
                      className="ghost-button"
                      resourceType="asset"
                      resourceId={asset.id}
                      payload={{ campaign_id: item.campaignId, content_package_id: item.id, asset_id: asset.id }}
                      onCompleted={onRefresh}
                    >
                      设为主素材
                    </ExecutionButton>
                  )}
                  {!approved && (
                    <ExecutionButton
                      action="approve_asset"
                      actionName="批准素材"
                      resourceType="asset"
                      resourceId={asset.id}
                      payload={{ campaign_id: item.campaignId, content_package_id: item.id, asset_id: asset.id, action: 'approve' }}
                      onCompleted={onRefresh}
                    >
                      批准素材
                    </ExecutionButton>
                  )}
                  <ExecutionButton
                    action="create_asset_generation_job"
                    actionName="重新生成素材"
                    className="ghost-button"
                    resourceType="asset"
                    resourceId={asset.id}
                    reason={generationReason}
                    payload={{
                      campaign_id: item.campaignId,
                      content_package_id: item.id,
                      content_item_id: metadata.selected_version_id,
                      character_id: selectedCharacter?.id,
                      asset_type: String(asset.type).includes('video') ? 'video' : 'image',
                      lora,
                      lora_weight: loraWeight,
                      prompt: asset.prompt || `${draft.hook}。${draft.body}`,
                      negative_prompt: asset.raw?.generation_params?.negative_prompt || lora.negative_prompt,
                      provider: asset.source || 'autodl',
                      reference_asset_id: asset.raw?.metadata?.reference_asset_id,
                      parameters: { parent_asset_id: asset.id },
                    }}
                    onCompleted={onRefresh}
                  >
                    重新生成
                  </ExecutionButton>
                  <ExecutionButton
                    action="approve_asset"
                    actionName="标记不可用"
                    className="ghost-button"
                    resourceType="asset"
                    resourceId={asset.id}
                    payload={{ campaign_id: item.campaignId, content_package_id: item.id, asset_id: asset.id, action: 'unavailable' }}
                    onCompleted={onRefresh}
                  >
                    标记不可用
                  </ExecutionButton>
                </div>
              </article>
            );
          })}
          {!usableAssets.length && <div className="empty-card-inline">暂无真实可用成果。排队中、失败、缺少文件或 URL 损坏的记录不会进入可用素材区。</div>}
        </div>
        {campaignAssetOptions.length > 0 && (
          <details className="day1-asset-picker">
            <summary>从当前 Campaign 素材库选择（{campaignAssetOptions.length}）</summary>
            <div className="day1-asset-grid">
              {campaignAssetOptions.map((asset) => (
                <article className="day1-asset-card" key={asset.id}>
                  <AssetPreview asset={asset} compact onBroken={() => markRuntimeBrokenAsset(asset.id)} />
                  <div><strong>{asset.name}</strong><small>{asset.type} · 可用成果</small></div>
                  <ExecutionButton
                    action="attach_asset_to_content"
                    actionName="关联到 Day 1"
                    resourceType="asset"
                    resourceId={asset.id}
                    payload={{ campaign_id: item.campaignId, content_package_id: item.id, asset_id: asset.id, usage: 'candidate' }}
                    onCompleted={onRefresh}
                  >
                    选择此素材
                  </ExecutionButton>
                </article>
              ))}
            </div>
          </details>
        )}
        {brokenAssets.length > 0 && (
          <details className="broken-assets-panel">
            <summary>{brokenAssets.length} 个损坏或未完成素材（已从可用素材中隐藏）</summary>
            {brokenAssets.map((asset) => (
              <div key={asset.id}>
                <strong>{asset.name}</strong>
                <span>
                  {runtimeBrokenAssetIds.includes(String(asset.id))
                    ? '图片或视频加载失败'
                    : inspectAssetAvailability(asset).reasons.join('；')}
                </span>
              </div>
            ))}
          </details>
        )}
      </section>

      <section
        className="day1-workbench-section readiness-section"
        hidden={!['review', 'publish'].includes(activeJourneyStep)}
      >
        <div className="section-head">
          <div><p className="eyebrow">4 · 风险、审核与发布准备</p><h3>待发布检查</h3></div>
          <span className={`status-badge ${readiness.readyForPublishTask ? 'approved' : 'draft'}`}>
            {readiness.readyForPublishTask ? '可创建待发布任务' : '尚未就绪'}
          </span>
        </div>
        <div className="readiness-check-grid">
          <Check label="已选择主版本" ok={readiness.checks.selectedVersion} />
          <Check label="文案完整" ok={readiness.checks.copyComplete} />
          <Check label="文案已人工批准" ok={readiness.checks.copyApproved} />
          <Check label="角色 / LoRA 可用" ok={readiness.checks.characterReady} />
          <Check label="素材已人工确认" ok={readiness.checks.mediaConfirmed} />
          <Check label="无阻断风险" ok={readiness.checks.risksClear} />
        </div>
        <div className="risk-check-panel">
          <strong>风险检查</strong>
          {!readiness.risks.blocking.length && !readiness.risks.warnings.length
            ? <p>未发现明显阻断项。</p>
            : (
              <ul>
                {readiness.risks.blocking.map((risk) => <li className="blocking" key={risk}>阻断：{risk}</li>)}
                {readiness.risks.warnings.map((risk) => <li key={risk}>提醒：{risk}</li>)}
              </ul>
            )}
        </div>
        <div className="button-row">
          <ExecutionButton
            action="finalize_content_package"
            actionName="创建待发布任务"
            resourceType="content_package"
            resourceId={item.id}
            ready={readiness.readyForPublishTask}
            reason={!readiness.readyForPublishTask ? '请先完成文案批准、素材确认和风险检查' : undefined}
            payload={{
              content_package_id: item.id,
              selected_asset_id: approvedAsset?.id,
              final_body: draft.body,
              final_cta: draft.cta,
              final_tags: normalizeList(draft.hashtags),
              scheduled_at: item.scheduledAt || null,
              platform_account_id: item.accountId,
            }}
            onCompleted={onRefresh}
          >
            创建待发布任务
          </ExecutionButton>
          {publishTask && <button className="ghost-button" type="button" onClick={() => onNavigate('publish', publishTask.id)}>查看发布准备</button>}
        </div>
        <p className="form-hint">这里只创建待发布任务；仍需在发布队列人工批准，不会自动发布。</p>
      </section>

      <section className="day1-workbench-section history-section" hidden={activeJourneyStep !== 'data'}>
        <div className="section-head"><div><p className="eyebrow">5 · 版本历史</p><h3>{versions.length} 个已保存版本</h3></div></div>
        <div className="version-history-list">
          {[...versions].reverse().map((version) => (
            <div className="version-history-row" key={version.id}>
              <strong>版本 {version.versionNumber}</strong>
              <span>{revisionTypeLabel(version.revisionType)}</span>
              <small>{formatDate(version.createdAt)}</small>
              <em>{String(version.id) === String(metadata.selected_version_id || '') ? '当前主版本' : ''}</em>
            </div>
          ))}
        </div>
      </section>

      <details className="day1-advanced-details">
        <summary>高级详情</summary>
        <div className="business-grid">
          <Info label="内容包 ID" value={item.id} />
          <Info label="策略 ID" value={item.strategyId} />
          <Info label="Campaign ID" value={item.campaignId} />
          <Info label="当前主版本 ID" value={metadata.selected_version_id} />
          <Info label="内部状态" value={item.raw?.source_insights} />
          <Info label="工作流记录" value={runsForContent(item, data.workflowRuns || [])} />
        </div>
      </details>
    </article>
  );
}

function buildDayOneJourney({
  plan,
  strategy,
  metadata,
  generationJobs,
  usableAssets,
  approvedAsset,
  item,
  publishTask,
}) {
  const publishStatus = String(publishTask?.status || '').toLowerCase();
  const generated = usableAssets.length > 0 || generationJobs.some((job) => (
    ['completed', 'ready'].includes(String(job.status || '').toLowerCase())
  ));
  const checks = [
    ['plan', '计划确认', Boolean(plan?.topic || plan?.content_pillar || strategy?.status === 'approved')],
    ['copy', '文案生成与审核', Boolean(metadata.copy_approved)],
    ['visual', '视觉内容生成', generated],
    ['asset', '素材确认', Boolean(approvedAsset)],
    ['review', '内容终审', Boolean(item.approvedForPublishing || ['approved', 'scheduled', 'published'].includes(String(item.reviewStatus || item.status || '').toLowerCase()))],
    ['publish', '发布准备', Boolean(publishTask)],
    ['data', '已发布与数据', publishStatus === 'published'],
  ];
  const currentIndex = checks.findIndex(([, , complete]) => !complete);
  const resolvedIndex = currentIndex === -1 ? checks.length - 1 : currentIndex;
  const steps = checks.map(([id, label, complete], index) => ({
    id,
    label,
    state: complete && index < resolvedIndex
      ? 'completed'
      : index === resolvedIndex
        ? 'current'
        : 'waiting',
  }));
  return { steps, current: steps[resolvedIndex] };
}

function ContentPackageCard({
  item,
  data,
  assets,
  gateway,
  userId,
  onNavigate,
  onRefresh,
  initialOpen = false,
  dayIndex = 1,
  strategyId = '',
}) {
  const campaign = findById(data.campaigns, item.campaignId);
  const strategy = findById(data.strategies, item.strategyId);
  const account = findById(data.accounts, item.accountId);
  const character = findById(data.characters, item.characterId);
  const lora = getLoraInfo(character, item);
  const linkedAssets = assetsForContent(item, assets);
  const workflowRuns = runsForContent(item, data.workflowRuns || []);
  const publishTask = (data.publishTasks || []).find((task) => String(task.content_package_id || task.content_id || '') === String(item.id));
  const productionGuide = buildProductionGuide({ item, character, lora, linkedAssets, workflowRuns, publishTask, gateway });
  const [studioOpen, setStudioOpen] = useState(initialOpen);
  const sectionIds = {
    studio: `content-${item.id}-studio`,
    copy: `content-${item.id}-copy`,
    media: `content-${item.id}-media`,
    results: `content-${item.id}-results`,
    approval: `content-${item.id}-approval`,
  };

  function openSection(target) {
    setStudioOpen(true);
    onNavigate('workspace', item.id, { strategy_id: strategyId || item.strategyId, day: dayIndex });
    window.setTimeout(() => document.getElementById(sectionIds[target])?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  useEffect(() => {
    setStudioOpen(initialOpen);
  }, [initialOpen]);

  function followNextStep() {
    if (productionGuide.current.status === 'completed') {
      if (dayIndex < 7) {
        onNavigate('workspace', '', { strategy_id: strategyId || item.strategyId, day: dayIndex + 1 });
      } else {
        onNavigate('publish');
      }
      return;
    }
    if (productionGuide.nextAction.page) {
      onNavigate(productionGuide.nextAction.page);
      return;
    }
    openSection(productionGuide.nextAction.target || 'studio');
  }

  return (
    <article className="content-package-card">
      <div className="content-card-header section-head">
        <div>
          <p className="eyebrow">{item.sourceLabel}</p>
          <h3>{formatDayPackageTitle(item.title, dayIndex)}</h3>
          <p className="body-preview">{truncate(displayText(item.body, '等待生成正文'), 220)}</p>
        </div>
        <div className="badge-stack">
          {isTestContent(item) && <span className="test-content-badge">测试内容</span>}
          <StatusBadge status={item.reviewStatus || item.status} />
          <StatusBadge status={item.platform} />
        </div>
      </div>

      <ProductionSteps guide={productionGuide} onNext={followNextStep} dayIndex={dayIndex} />

      <details className="content-card-context">
        <summary>查看内容、策略与素材概览</summary>
        <div className="content-card-meta">
          <Info label="运营活动" value={campaign?.name || campaign?.title} />
          <Info label="策略" value={strategy?.name || strategy?.title} />
          <Info label="平台" value={item.platform} />
          <Info label="目标账号" value={account?.account_name || account?.username || account?.account_url} />
          <Info label="角色 / 角色模型" value={`${character?.display_name || character?.name || '—'} · ${lora.name || lora.model || lora.filename || '—'}`} />
          <Info label="素材" value={linkedAssets.length} />
        </div>
        <div className="content-copy-summary">
          <Info label="开场钩子" value={item.hook} />
          <Info label="正文摘要" value={truncate(item.body, 160)} />
          <Info label="行动引导" value={item.cta} />
          <Info label="标签" value={item.tags} />
        </div>
        <div className="asset-strip" aria-label="内容素材预览">
          {linkedAssets.slice(0, 4).map((asset) => (
            <div className="asset-thumb" key={asset.id}>
              <AssetPreview asset={asset} compact />
              <span>{asset.name}</span>
            </div>
          ))}
          {!linkedAssets.length && <span className="muted-line">暂无素材，进入工作室添加参考或生成新素材。</span>}
        </div>
      </details>

      <div className="button-row content-card-quick-actions">
        <button className="primary-button" type="button" onClick={followNextStep}>
          {productionGuide.current.status === 'completed'
            ? dayIndex < 7 ? `进入 Day ${dayIndex + 1} 内容生成` : '查看发布队列'
            : productionGuide.current.id === 'role'
              ? `为 Day ${dayIndex} 选择角色 / LoRA`
              : productionGuide.nextAction.label}
        </button>
        <button className="ghost-button" type="button" onClick={() => openSection('studio')}>展开完整生产面板</button>
        {studioOpen && <button className="ghost-button" type="button" onClick={() => {
          setStudioOpen(false);
          onNavigate('workspace', '', { strategy_id: strategyId || item.strategyId, day: dayIndex });
        }}>收起工作室</button>}
      </div>

      <details
        className="generation-studio"
        id={sectionIds.studio}
        open={studioOpen}
        onToggle={(event) => {
          const nextOpen = event.currentTarget.open;
          setStudioOpen(nextOpen);
          onNavigate('workspace', nextOpen ? item.id : '', { strategy_id: strategyId || item.strategyId, day: dayIndex });
        }}
      >
        <summary>🎬 人物角色模型（LoRA）图片和视频生成</summary>
        <p className="strategy-link-note">关联策略：{strategy?.name || strategy?.title || '未找到关联策略，将只使用当前内容包要求'}</p>
        <ContentPackageStudio
          item={item}
          data={data}
          assets={assets}
          gateway={gateway}
          userId={userId}
          onNavigate={onNavigate}
          onRefresh={onRefresh}
          sectionIds={sectionIds}
          currentStep={productionGuide.current.id}
          dayIndex={dayIndex}
        />
      </details>
    </article>
  );
}

function ProductionSteps({ guide, onNext, dayIndex }) {
  const groupedSteps = [
    {
      id: 'copy',
      label: '文案确认',
      status: guide.steps.find((step) => step.id === 'copy')?.status || 'pending',
      hint: '标题、开场钩子、正文与行动引导',
    },
    {
      id: 'visual',
      label: '视觉生成',
      status: summarizeProductionStatus(guide.steps.filter((step) => ['role', 'reference', 'image', 'video', 'results'].includes(step.id))),
      hint: '角色、角色模型、素材与生成结果',
    },
    {
      id: 'review',
      label: '结果审核',
      status: summarizeProductionStatus(guide.steps.filter((step) => ['approval', 'publish'].includes(step.id))),
      hint: '确认素材并进入发布队列',
    },
  ];

  return (
    <section className="production-guide" aria-label="内容生产步骤">
      <div className="production-guide-head">
        <div>
          <p className="eyebrow">生产进度</p>
          <h4>当前步骤：{guide.current.label}</h4>
        </div>
        <span className={`production-current-status ${guide.current.status}`}>{productionStatusLabel(guide.current.status)}</span>
      </div>
      <div className="production-stepper">
        {groupedSteps.map((step, index) => (
          <div className={`production-step ${step.status} ${step.status !== 'completed' && !groupedSteps.slice(0, index).some((item) => item.status !== 'completed') ? 'current' : ''}`} key={step.id}>
            <span>{index + 1}</span>
            <div><strong>{step.label}</strong><small>{step.hint} · {productionStatusLabel(step.status)}</small></div>
          </div>
        ))}
      </div>
      <div className="production-next-action">
        <div><span>当前阻塞原因</span><strong>{guide.reason}</strong></div>
        <button className="ghost-button" type="button" onClick={onNext}>
          {guide.current.id === 'role' ? `为 Day ${dayIndex} 选择角色 / LoRA` : guide.nextAction.label}
        </button>
      </div>
    </section>
  );
}

function summarizeProductionStatus(steps) {
  if (steps.every((step) => step.status === 'completed')) return 'completed';
  if (steps.some((step) => step.status === 'needs_bridge')) return 'needs_bridge';
  if (steps.some((step) => step.status === 'pending')) return 'pending';
  return 'blocked';
}

function ContentPackageStudio({ item, data, assets, gateway, userId, onNavigate, onRefresh, sectionIds, currentStep, dayIndex }) {
  const campaign = findById(data.campaigns, item.campaignId);
  const account = findById(data.accounts, item.accountId);
  const referenceAccount = findById(data.accounts, item.referenceAccountId);
  const [selectedStrategyId, setSelectedStrategyId] = useState(item.strategyId || '');
  const [selectedCharacterId, setSelectedCharacterId] = useState(item.characterId || '');
  const [selectedLoraKey, setSelectedLoraKey] = useState(item.loraId || '');
  const [selectedAssetIds, setSelectedAssetIds] = useState(item.referenceAssetIds || []);
  const [bindingStatus, setBindingStatus] = useState({ loading: false, message: '', error: false });
  const [activeMediaPanel, setActiveMediaPanel] = useState('image');
  const [videoMode, setVideoMode] = useState(item.generationMode || 'character_lora_video');
  const [draft, setDraft] = useState(() => ({
    title: item.title || '',
    hook: item.hook || '',
    body: item.body || '',
    cta: item.cta || '',
    tags: normalizeList(item.tags).join(', '),
    scheduledAt: toLocalDateTimeValue(item.scheduledAt),
    feedback: '',
  }));
  const [xUrl, setXUrl] = useState('');
  const [referenceSource, setReferenceSource] = useState(item.referenceSource || item.sourceAccount || referenceAccount?.account_name || '');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [forceRemote, setForceRemote] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [selectedGeneratedId, setSelectedGeneratedId] = useState('');
  const [contextAI, setContextAI] = useState({ open: false, mode: 'rewrite_copy' });
  const selectedStrategy = findById(data.strategies, selectedStrategyId) || findById(data.strategies, item.strategyId);
  const selectedCharacter = findById(data.characters, selectedCharacterId) || findById(data.characters, item.characterId);
  const loraOptions = getLoraOptions(selectedCharacter, item);
  const lora = loraOptions.find((option) => loraOptionKey(option) === selectedLoraKey) || loraOptions[0] || {};
  const linkedAssets = assetsForContent(item, assets);
  const referenceAssets = assets.filter((asset) => {
    const metadata = safeJson(asset.raw?.metadata);
    return ['image', 'video'].includes(String(asset.type || asset.asset_type).toLowerCase())
      && asset.status === 'completed'
      && (metadata.role === 'reference' || asset.source === 'upload' || asset.source === 'x');
  });
  const selectedAssets = assets.filter((asset) => selectedAssetIds.includes(asset.id));
  const runs = runsForContent(item, data.workflowRuns || []);
  const publishTask = (data.publishTasks || []).find((task) => String(task.content_package_id || task.content_id) === String(item.id));
  const imageReq = normalizeRequirement(item.imageRequirements || item.assetRequirement);
  const videoReq = normalizeRequirement(item.videoRequirements || item.assetRequirement);
  const visualPrompt = displayText(
    activeMediaPanel === 'video'
      ? videoReq.script || videoReq.positive_prompt || videoReq.text
      : imageReq.positive_prompt || imageReq.prompt || imageReq.text,
    activeMediaPanel === 'video'
      ? `${draft.hook || draft.title}。围绕当前文案主题，以 ${selectedCharacter?.display_name || selectedCharacter?.name || '当前角色'} 为主角，生成竖版短视频脚本与镜头提示。`
      : `${draft.hook || draft.title}。${selectedCharacter?.display_name || selectedCharacter?.name || '原创 AI 角色'}，${imageReq.scene || '具有氛围感的真实场景'}，${imageReq.lighting || '电影感光线'}，${imageReq.aspect_ratio || '9:16'}。`,
  );
  const parsedX = parseXUrl(xUrl);
  const needsReference = activeMediaPanel === 'video'
    && ['image_to_video', 'first_frame', 'first_last_frame', 'reference_video', 'multi_shot'].includes(videoMode);
  const missingGenerationReason = !selectedCharacter
    ? '请先选择人物角色'
    : !hasLora(lora)
      ? '该角色还没有配置角色模型（LoRA），请先前往角色库配置'
      : activeMediaPanel === 'image' && lora.image_enabled === false
        ? '当前角色模型未启用图片生成'
        : activeMediaPanel === 'video' && lora.video_enabled === false
          ? '当前角色模型未启用视频生成'
      : needsReference && selectedAssetIds.length === 0 && selectedFiles.length === 0 && !parsedX
        ? '当前生成方式需要选择参考素材、上传文件或导入 X 链接'
        : undefined;
  const finalReviewReason = !draft.body.trim()
    ? '请先确认正文'
    : !draft.cta.trim()
      ? '请先确认行动引导'
      : selectedAssets.length === 0 && linkedAssets.length === 0
        ? '请先确认至少一个可用素材'
        : undefined;
  const referenceAssetKey = normalizeList(item.referenceAssetIds).join('|');

  useEffect(() => {
    setSelectedStrategyId(item.strategyId || '');
    setSelectedCharacterId(item.characterId || '');
    setSelectedLoraKey(item.loraId || '');
    setSelectedAssetIds(item.referenceAssetIds || []);
    setReferenceSource(item.referenceSource || item.sourceAccount || referenceAccount?.account_name || '');
    setVideoMode(item.generationMode || 'character_lora_video');
  }, [
    item.id,
    item.strategyId,
    item.characterId,
    item.loraId,
    item.generationMode,
    item.referenceAssetIds,
    item.referenceSource,
    item.sourceAccount,
    referenceAccount?.account_name,
    referenceAssetKey,
  ]);

  function toggleAsset(assetId) {
    setSelectedAssetIds((current) => (
      current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]
    ));
  }

  function handleCharacterSelection(characterId) {
    setSelectedCharacterId(characterId);
    const nextCharacter = findById(data.characters, characterId);
    const nextLora = getLoraOptions(nextCharacter, item)[0];
    setSelectedLoraKey(nextLora ? loraOptionKey(nextLora) : '');
  }

  async function saveProductionBinding() {
    setBindingStatus({ loading: true, message: '', error: false });
    try {
      await saveContentProductionBinding(item, {
        strategyId: selectedStrategyId || null,
        characterId: selectedCharacter?.id || null,
        loraId: lora.id || selectedLoraKey || null,
        loraInfo: hasLora(lora) ? lora : null,
        referenceAssetIds: selectedAssetIds,
        referenceSource,
        generationMode: videoMode,
      });
      await onRefresh();
      setBindingStatus({ loading: false, message: '生产关联已保存，内容包状态已刷新。', error: false });
    } catch (error) {
      setBindingStatus({
        loading: false,
        message: error?.message || '生产关联保存失败，请稍后重试。',
        error: true,
      });
    }
  }

  const generationPayload = {
    content_package_id: item.id,
    campaign_id: item.campaignId,
    strategy_id: selectedStrategyId || item.strategyId,
    character_id: selectedCharacter?.id,
    lora_id: lora.id || selectedLoraKey,
    lora_weight: lora.weight || lora.strength || 0.8,
    reference_asset_ids: selectedAssetIds,
    generation_mode: videoMode,
    image_requirements: item.imageRequirements,
    video_requirements: item.videoRequirements,
    target_platform: item.platform,
    aspect_ratio: imageReq.aspect_ratio || videoReq.aspect_ratio || '9:16',
    reference_source: referenceSource,
    force_remote: forceRemote,
    media_type: activeMediaPanel,
  };

  const contentAIContext = buildContentContext({
    contentPackage: {
      ...item,
      title: draft.title,
      hook: draft.hook,
      body: draft.body,
      cta: draft.cta,
      tags: normalizeList(draft.tags),
    },
    campaign,
    strategy: selectedStrategy,
    account,
    accountProfile: account?.account_profiles?.[0],
    character: selectedCharacter,
    lora,
    assets: selectedAssets.length ? selectedAssets : linkedAssets,
  });

  function openContextAI(mode) {
    setContextAI({ open: true, mode });
  }

  async function handleContextAIApply(result, metadata) {
    setBindingStatus({ loading: true, message: '', error: false });
    try {
      await applyContextAIResult(item, metadata.mode, result);
      if (['rewrite_copy', 'generate_hook'].includes(metadata.mode)) {
        setDraft((current) => ({
          ...current,
          title: result.title || current.title,
          hook: result.hook || current.hook,
          body: result.body || current.body,
          cta: result.cta || current.cta,
          tags: normalizeList(result.hashtags || current.tags).join(', '),
        }));
      }
      await onRefresh();
      setContextAI((current) => ({ ...current, open: false }));
      setBindingStatus({ loading: false, message: '上下文 AI 结果已应用并保存到当前内容。', error: false });
    } catch (error) {
      setBindingStatus({ loading: false, message: error?.message || '应用上下文 AI 结果失败。', error: true });
    }
  }

  async function handleContextAISavePrompt(payload) {
    await createPrompt(userId, payload);
    setBindingStatus({ loading: false, message: '提示词已保存到提示词库。', error: false });
  }

  async function handleFinalized() {
    await onRefresh();
    onNavigate('workspace', '', {
      strategy_id: item.strategyId || selectedStrategyId,
      day: Math.min(dayIndex + 1, 7),
    });
  }

  return (
    <div className="inline-content-studio" aria-label={`${item.title} 的内容生成工作室`}>
        <div className="studio-focus-grid">
          <details className="studio-focus-card studio-step-panel copy-focus-card" id={sectionIds.copy} defaultOpen={currentStep === 'copy'}>
            <summary>Day {dayIndex} · 文案确认</summary>
            <div className="studio-focus-heading">
              <div>
                <p className="eyebrow">当前文案</p>
                <h3>当前文案</h3>
              </div>
              <span className="context-sync-badge">策略已关联</span>
            </div>
            <label>标题
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label>开场钩子
              <textarea rows="2" value={draft.hook} onChange={(event) => setDraft({ ...draft, hook: event.target.value })} />
            </label>
            <label>正文摘要
              <textarea rows="5" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
            </label>
            <label>行动引导
              <input value={draft.cta} onChange={(event) => setDraft({ ...draft, cta: event.target.value })} />
            </label>
            <label>标签
              <input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
            </label>
            <div className="button-row">
              <button className="primary-button compact-action" type="button" onClick={() => openContextAI('rewrite_copy')}>✦ AI 优化文案</button>
              <ExecutionButton
                action="save_draft"
                actionName="保存草稿"
                className="ghost-button"
                resourceType="content_package"
                resourceId={item.id}
                payload={{ content_package_id: item.id, draft }}
              >
                保存草稿
              </ExecutionButton>
            </div>
          </details>

          <details className="studio-focus-card studio-step-panel visual-focus-card" id={sectionIds.media} defaultOpen={['role', 'reference', 'image', 'video'].includes(currentStep)}>
            <summary>Day {dayIndex} · 角色、素材与视觉生成</summary>
            <div className="studio-focus-heading">
              <div>
                <p className="eyebrow">视觉生成</p>
                <h3>视觉生成</h3>
              </div>
              <span className={`status-badge ${selectedCharacter && hasLora(lora) ? 'connected' : 'pending'}`}>
                {selectedCharacter && hasLora(lora) ? '角色模型可用' : '等待角色模型'}
              </span>
            </div>

            <div className="visual-mode-tabs" role="tablist" aria-label="视觉生成类型">
              <button className={activeMediaPanel === 'image' ? 'active' : ''} type="button" onClick={() => setActiveMediaPanel('image')}>▧ 图片生成</button>
              <button className={activeMediaPanel === 'video' ? 'active' : ''} type="button" onClick={() => setActiveMediaPanel('video')}>▶ 视频生成</button>
            </div>

            <div className="context-sync-strip">✓ 已同步文案主题、开场钩子、策略、角色与素材要求</div>

            <div className="visual-control-grid">
              <label>人物角色
                <select value={selectedCharacterId} onChange={(event) => handleCharacterSelection(event.target.value)}>
                  <option value="">请选择角色</option>
                  {(data.characters || []).filter((nextCharacter) => nextCharacter.status !== 'archived').map((nextCharacter) => (
                    <option key={nextCharacter.id} value={nextCharacter.id}>
                      {nextCharacter.display_name || nextCharacter.name || nextCharacter.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>角色模型（LoRA）
                <select
                  value={hasLora(lora) ? loraOptionKey(lora) : ''}
                  onChange={(event) => setSelectedLoraKey(event.target.value)}
                  disabled={!loraOptions.length}
                >
                  {!loraOptions.length && <option value="">未配置角色模型</option>}
                  {loraOptions.map((option) => (
                    <option key={loraOptionKey(option)} value={loraOptionKey(option)}>
                      {option.name || option.model || option.filename} · {option.version || '默认版本'} · 权重 {option.weight || option.strength || 0.8}
                    </option>
                  ))}
                </select>
              </label>
              <label>画面比例
                <div className="readonly-control">{displayText(imageReq.aspect_ratio || videoReq.aspect_ratio, '9:16')}</div>
              </label>
              <label>参考素材
                <div className="readonly-control">{selectedAssets.length ? `${selectedAssets.length} 个已选素材` : '尚未选择'}</div>
              </label>
            </div>

            {activeMediaPanel === 'video' && (
              <label className="visual-mode-select">视频生成方式
                <select value={videoMode} onChange={(event) => setVideoMode(event.target.value)}>
                  {VIDEO_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            )}

            <div className="focus-asset-picker">
              <div className="focus-asset-picker-head">
                <div>
                  <strong>参考素材</strong>
                  <span>已选择 {selectedAssetIds.length} 个；点击缩略图可选择或取消</span>
                </div>
                <button className="text-action" type="button" onClick={() => onNavigate('assets')}>打开素材库</button>
              </div>
              <div className="focus-asset-strip">
                {referenceAssets.slice(0, 8).map((asset) => (
                  <button
                    className={`focus-asset-item ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`}
                    type="button"
                    key={asset.id}
                    aria-pressed={selectedAssetIds.includes(asset.id)}
                    onClick={() => toggleAsset(asset.id)}
                  >
                    <AssetPreview asset={asset} compact />
                    <span>{asset.name}</span>
                    <small>{selectedAssetIds.includes(asset.id) ? '✓ 已选择' : asset.type}</small>
                  </button>
                ))}
                {!referenceAssets.length && (
                  <button className="focus-asset-empty" type="button" onClick={() => onNavigate('assets')}>
                    素材库暂无可用参考，前往上传或从 X 导入
                  </button>
                )}
              </div>
            </div>

            <label className="visual-prompt-editor">
              <span>{activeMediaPanel === 'image' ? '图片提示词' : '视频脚本与提示词'}</span>
              <textarea rows="5" value={visualPrompt} readOnly />
            </label>

            <div className="visual-generation-actions">
              <button className="text-action" type="button" onClick={() => openContextAI(activeMediaPanel === 'image' ? 'generate_image_prompt' : 'generate_video_script')}>
                重新生成{activeMediaPanel === 'image' ? '图片提示词' : '视频脚本'}
              </button>
              <ExecutionButton
                action={activeMediaPanel === 'image' ? 'generate_character_image' : 'generate_character_video'}
                actionName={activeMediaPanel === 'image' ? '立即生成图片' : '立即生成视频'}
                className="primary-button generate-now-button"
                resourceType="content_package"
                resourceId={item.id}
                payload={generationPayload}
                reason={missingGenerationReason}
                showGatewayHint
              >
                {activeMediaPanel === 'image' ? '▧ 立即生成图片' : '▶ 立即生成视频'}
              </ExecutionButton>
            </div>

            <div className="generation-preflight" aria-label="生成前检查">
              <Check label="角色已选择" ok={Boolean(selectedCharacter)} />
              <Check label="角色模型可用" ok={hasLora(lora)} />
              <Check label={selectedAssetIds.length ? `${selectedAssetIds.length} 个参考素材` : '参考素材可选'} ok={!needsReference || selectedAssetIds.length > 0 || selectedFiles.length > 0 || Boolean(parsedX)} />
              <Check label={gateway.connected ? '执行服务已连接' : '执行服务未连接'} ok={gateway.connected} />
            </div>

            <details className="focus-advanced-settings">
              <summary>高级设置与参考素材</summary>
              <div className="focus-advanced-content">
                <div>
                  <strong>当前关联</strong>
                  <p>{selectedStrategy?.name || selectedStrategy?.title || '未关联策略'} · {selectedCharacter?.display_name || selectedCharacter?.name || '未选择角色'}</p>
                </div>
                <button className="ghost-button" type="button" onClick={saveProductionBinding} disabled={bindingStatus.loading}>
                  {bindingStatus.loading ? '正在保存...' : '保存当前关联'}
                </button>
              </div>
            </details>
            {bindingStatus.message && <div className={`notice ${bindingStatus.error ? 'error' : ''}`}>{bindingStatus.message}</div>}
          </details>
        </div>

        <details className="studio-focus-card studio-step-panel result-focus-card" id={sectionIds.results} defaultOpen={['results', 'approval', 'publish'].includes(currentStep)}>
          <summary>Day {dayIndex} · 生成结果与审核</summary>
          <div className="studio-focus-heading">
            <div>
              <p className="eyebrow">生成结果</p>
              <h3>生成结果</h3>
            </div>
            <span className="context-sync-badge">{linkedAssets.length} 个可用素材</span>
          </div>
          <GenerationResults
            item={item}
            assets={linkedAssets}
            runs={runs}
            selectedId={selectedGeneratedId}
            onSelect={setSelectedGeneratedId}
          />
          <div className="review-checklist compact-review-checklist">
            <Check label="正文已确认" ok={Boolean(draft.body.trim())} />
            <Check label="行动引导已确认" ok={Boolean(draft.cta.trim())} />
            <Check label="角色 / LoRA 已确认" ok={Boolean(selectedCharacter && hasLora(lora))} />
            <Check label="可用素材已确认" ok={Boolean(selectedAssets.length || linkedAssets.length)} />
          </div>
          <div className="button-row">
            <ExecutionButton
              action="finalize_content_package"
              actionName={`审核通过并将 Day ${dayIndex} 加入发布队列`}
              resourceType="content_package"
              resourceId={item.id}
              payload={{
                content_package_id: item.id,
                selected_asset_id: selectedGeneratedId || null,
                selected_asset_ids: selectedAssetIds,
                final_body: draft.body,
                final_cta: draft.cta,
                final_tags: normalizeList(draft.tags),
                scheduled_at: draft.scheduledAt ? new Date(draft.scheduledAt).toISOString() : null,
                platform_account_id: item.accountId,
              }}
              reason={finalReviewReason}
              onCompleted={handleFinalized}
            >
              审核通过并加入发布队列
            </ExecutionButton>
          </div>
        </details>

        <details className="studio-advanced-workflow">
          <summary>完整设置、素材导入与终审发布</summary>
          <div className="studio-advanced-workflow-body">

        <section className="workspace-block">
          <h3>基础信息</h3>
          <div className="content-card-meta">
            <Info label="标题" value={item.title} />
            <Info label="平台" value={item.platform} />
            <Info label="运营活动" value={campaign?.name || campaign?.title} />
            <Info label="策略" value={selectedStrategy?.name || selectedStrategy?.title} />
            <Info label="目标账号" value={account?.account_name || account?.username} />
            <Info label="来源账号" value={referenceAccount?.account_name || item.sourceAccount} />
            <Info label="创建时间" value={formatDate(item.createdAt)} />
            <Info label="当前状态" value={item.status} />
            <Info label="发布队列" value={publishTask ? `${publishTask.status || 'pending'} · ${publishTask.id}` : '尚未进入发布队列'} />
          </div>
        </section>

        <section className="workspace-block production-binding-block">
          <div className="production-binding-heading">
            <div>
              <p className="eyebrow">生产关联</p>
              <h3>生产关联设置</h3>
              <p>保存后，策略、角色、角色模型和参考素材会写入当前内容包，刷新页面后仍会保留。</p>
            </div>
            <span className={`status-badge ${selectedCharacter && hasLora(lora) ? 'connected' : 'pending'}`}>
              {selectedCharacter && hasLora(lora) ? '角色模型可用' : '等待角色模型'}
            </span>
          </div>

          <div className="production-binding-selectors">
            <label>关联策略
              <select value={selectedStrategyId} onChange={(event) => setSelectedStrategyId(event.target.value)}>
                <option value="">不关联策略</option>
                {(data.strategies || []).map((nextStrategy) => (
                  <option key={nextStrategy.id} value={nextStrategy.id}>
                    {nextStrategy.name || nextStrategy.title || nextStrategy.id}
                  </option>
                ))}
              </select>
            </label>
            <label>人物角色
              <select value={selectedCharacterId} onChange={(event) => handleCharacterSelection(event.target.value)}>
                <option value="">请选择角色</option>
                {(data.characters || []).filter((character) => character.status !== 'archived').map((character) => {
                  const characterLora = getLoraInfo(character, item);
                  return (
                    <option key={character.id} value={character.id}>
                      {character.display_name || character.name || character.id} · {displayText(characterLora.name || characterLora.model, '未绑定角色模型')}
                    </option>
                  );
                })}
              </select>
            </label>
          </div>

          <div className="production-binding-preview">
            <div className="character-preview">
              {selectedCharacter?.avatar || selectedCharacter?.avatar_url
                ? <img src={selectedCharacter.avatar || selectedCharacter.avatar_url} alt="" />
                : <span>角色预览</span>}
            </div>
            <div className="content-card-meta">
              <Info label="人物角色" value={selectedCharacter?.display_name || selectedCharacter?.name} />
              <Info label="角色模型" value={lora.name || lora.model || lora.filename} />
              <Info label="模型版本" value={lora.version} />
              <Info label="默认权重" value={lora.weight || lora.strength} />
              <Info label="图片生成" value={booleanText(lora.image_enabled ?? lora.image)} />
              <Info label="视频生成" value={booleanText(lora.video_enabled ?? lora.video)} />
            </div>
          </div>

          <div>
            <h4>参考素材</h4>
            <div className="asset-selector-grid production-binding-assets">
              {referenceAssets.slice(0, 24).map((asset) => (
                <button
                  key={asset.id}
                  className={`asset-select-card ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`}
                  type="button"
                  aria-pressed={selectedAssetIds.includes(asset.id)}
                  onClick={() => toggleAsset(asset.id)}
                >
                  <AssetPreview asset={asset} />
                  <strong>{asset.name}</strong>
                  <small>{asset.type} · {asset.source || '素材库'}</small>
                </button>
              ))}
              {!referenceAssets.length && <div className="empty-card-inline">素材库中暂无可用的图片或视频参考素材。</div>}
            </div>
          </div>

          <div className="production-binding-footer">
            <div>
              <strong>已选 {selectedAssetIds.length} 个参考素材</strong>
              <span>{selectedStrategy ? `策略：${selectedStrategy.name || selectedStrategy.title}` : '未选择策略'} · {selectedCharacter ? `角色：${selectedCharacter.display_name || selectedCharacter.name}` : '未选择角色'}</span>
            </div>
            <button className="primary-button" type="button" disabled={bindingStatus.loading} onClick={saveProductionBinding}>
              {bindingStatus.loading ? '正在保存...' : '保存生产关联'}
            </button>
          </div>
          {bindingStatus.message && <div className={`notice ${bindingStatus.error ? 'error' : ''}`}>{bindingStatus.message}</div>}
        </section>

        <section className="workspace-block">
          <h3>文案内容</h3>
          <div className="editor-grid">
            <label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>开场钩子<input value={draft.hook} onChange={(event) => setDraft({ ...draft, hook: event.target.value })} /></label>
            <label>行动引导<input value={draft.cta} onChange={(event) => setDraft({ ...draft, cta: event.target.value })} /></label>
            <label>标签<input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></label>
          </div>
          <label className="full-editor">正文<textarea rows="7" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></label>
          <div className="content-card-meta">
            <Info label="关键词" value={item.keywords} />
            <Info label="语言风格" value={item.languageStyle} />
            <Info label="可复刻策略" value={item.replicateStrategy} />
            <Info label="发布建议" value={item.publishSuggestion} />
          </div>
          <label className="full-editor">给文案智能体的改写意见<textarea rows="3" value={draft.feedback} onChange={(event) => setDraft({ ...draft, feedback: event.target.value })} /></label>
          <div className="button-row">
            <button className="primary-button" type="button" onClick={() => openContextAI('rewrite_copy')}>AI 优化文案</button>
            <button className="ghost-button" type="button" onClick={() => openContextAI('generate_hook')}>AI 生成开场钩子</button>
            <ExecutionButton
              action="save_draft"
              actionName="保存草稿"
              className="ghost-button"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, draft }}
            >
              保存草稿
            </ExecutionButton>
            <ExecutionButton
              action="rewrite_content"
              actionName="智能体改写文案"
              className="ghost-button"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, feedback: draft.feedback, draft }}
              reason={!draft.feedback.trim() ? '请先填写改写意见' : undefined}
            >
              智能体改写
            </ExecutionButton>
            <ExecutionButton
              action="review_generated_asset"
              actionName="确认文案可用"
              className="ghost-button"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, review_type: 'copy', approved: true, draft }}
            >
              确认文案可用
            </ExecutionButton>
          </div>
        </section>

        <section className="workspace-block media-generation-shell">
          <div className="media-generation-heading">
            <div>
              <p className="eyebrow">视觉内容生成</p>
              <h3>选择要生成的内容</h3>
            </div>
            <span>点击图片或视频后展开对应设置</span>
          </div>
          <div className="media-generation-switch" role="group" aria-label="选择图片或视频生成">
            <button
              className={`media-generation-option ${activeMediaPanel === 'image' ? 'active' : ''}`}
              type="button"
              aria-expanded={activeMediaPanel === 'image'}
              onClick={() => setActiveMediaPanel((current) => current === 'image' ? null : 'image')}
            >
              <span className="media-generation-icon">▧</span>
              <span>
                <strong>图片生成</strong>
                <small>图片要求、角色模型、参考素材与生图</small>
              </span>
              <b>{activeMediaPanel === 'image' ? '收起' : '展开'}</b>
            </button>
            <button
              className={`media-generation-option ${activeMediaPanel === 'video' ? 'active' : ''}`}
              type="button"
              aria-expanded={activeMediaPanel === 'video'}
              onClick={() => setActiveMediaPanel((current) => current === 'video' ? null : 'video')}
            >
              <span className="media-generation-icon">▶</span>
              <span>
                <strong>视频生成</strong>
                <small>视频要求、生成方式、参考素材与生视频</small>
              </span>
              <b>{activeMediaPanel === 'video' ? '收起' : '展开'}</b>
            </button>
          </div>
        </section>

        {activeMediaPanel && (
          <div className="media-generation-panel">
            <section className="workspace-block media-requirement-block">
              <h3>{activeMediaPanel === 'image' ? '图片要求' : '视频要求'}</h3>
              {activeMediaPanel === 'image' ? (
                <RequirementGrid fields={IMAGE_REQUIREMENT_FIELDS} value={imageReq} empty="当前内容没有结构化图片要求。" />
              ) : (
                <RequirementGrid fields={VIDEO_REQUIREMENT_FIELDS} value={videoReq} empty="当前内容没有结构化视频要求。" />
              )}
            </section>

        <section className="workspace-block">
          <h3>当前关联角色与角色模型</h3>
          <div className="character-lora-panel">
            <div className="character-preview">
              {selectedCharacter?.avatar || selectedCharacter?.avatar_url ? <img src={selectedCharacter.avatar || selectedCharacter.avatar_url} alt="" /> : <span>角色预览</span>}
            </div>
            <div className="content-card-meta">
              <Info label="角色" value={selectedCharacter?.display_name || selectedCharacter?.name} />
              <Info label="角色模型" value={lora.name || lora.model || lora.filename} />
              <Info label="模型版本" value={lora.version} />
              <Info label="模型权重" value={lora.weight || lora.strength} />
              <div className="button-row">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => openContextAI(activeMediaPanel === 'image' ? 'generate_image_prompt' : 'generate_video_script')}
                >
                  {activeMediaPanel === 'image' ? 'AI 生成图片提示词' : 'AI 生成视频脚本'}
                </button>
                <button className="ghost-button" type="button" onClick={() => openContextAI('generate_lora_prompt')}>AI 补全角色 / 角色模型</button>
              </div>
              {activeMediaPanel === 'image' ? (
                <Info label="可用于图片" value={booleanText(lora.image_enabled ?? lora.image)} />
              ) : (
                <>
                  <Info label="可用于视频" value={booleanText(lora.video_enabled ?? lora.video)} />
                  <Info label="视频生成方式" value={displayText(videoModeLabel(videoMode))} />
                </>
              )}
              <Info label="素材库参考" value={selectedAssets.map((asset) => asset.name)} />
            </div>
          </div>
          {!hasLora(lora) && (
            <div className="warning-card">
              这个角色还没有配置角色模型。需要先在角色库绑定 LoRA 模型、版本和权重，才能做角色一致性图片/视频生成。
              <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>前往角色库配置</button>
            </div>
          )}
        </section>

        {activeMediaPanel === 'video' && (
          <section className="workspace-block">
          <h3>视频生成方式</h3>
          <label className="full-editor">生成方式
            <select value={videoMode} onChange={(event) => setVideoMode(event.target.value)}>
              {VIDEO_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <ModeInputs mode={videoMode} selectedAssets={selectedAssets} videoReq={videoReq} />
          </section>
        )}

        <section className="workspace-block">
          <h3>素材来源</h3>
          <div className="studio-controls-grid">
            <label>来源账号（可选）
              <input value={referenceSource} onChange={(event) => setReferenceSource(event.target.value)} placeholder="例如 @maisiewzil" />
            </label>
          </div>
          <div className="asset-source-grid">
            <div>
              <h4>上传本地文件</h4>
              <label className="upload-dropzone">
                <input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={(event) => setSelectedFiles(Array.from(event.target.files || []))}
                />
                <span>拖拽或选择图片 / 视频</span>
                <small>选择后会显示上传队列；真实上传通过执行网关进入素材库。</small>
              </label>
              <div className="upload-list">
                {selectedFiles.map((file) => (
                  <div key={`${file.name}-${file.size}`} className="upload-row">
                    <span>{file.name}</span>
                    <small>{Math.round(file.size / 1024)} KB · 待上传</small>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h4>粘贴 X 贴文链接导入</h4>
              <input value={xUrl} onChange={(event) => setXUrl(event.target.value)} placeholder="https://x.com/用户名/status/推文ID" />
              <div className="x-import-preview">
                {parsedX ? (
                  <>
                    <Info label="原始链接" value={xUrl} />
                    <Info label="来源账号" value={`@${parsedX.username}`} />
                    <Info label="推文 ID" value={parsedX.statusId} />
                    <Info label="预览" value="导入后显示正文与图片/视频预览" />
                  </>
                ) : (
                  <p>请输入 X / Twitter status 链接。Token 和 secret 只在服务端使用，不会返回前端。</p>
                )}
              </div>
              <label className="consent-row">
                <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />
                我确认有权将该素材作为本次生成参考
              </label>
              <label className="consent-row">
                <input type="checkbox" checked={forceRemote} onChange={(event) => setForceRemote(event.target.checked)} />
                实际提交到 AutoDL（可能产生费用）；不勾选只创建安全预演任务
              </label>
            </div>
          </div>
        </section>

        <section className="workspace-block">
          <h3>{activeMediaPanel === 'image' ? '生成图片' : '生成视频'}</h3>
          <div className="button-row">
            <ExecutionButton
              action="upload_reference_asset"
              actionName="上传到素材库"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, campaign_id: item.campaignId, character_id: selectedCharacter?.id, files: selectedFiles.map(fileToPayload), rights_asserted: rightsConfirmed, reference_source: referenceSource }}
              reason={!selectedFiles.length ? '请先选择本地图片或视频' : !rightsConfirmed ? '请先确认素材使用权限' : undefined}
            >
              上传到素材库
            </ExecutionButton>
            <ExecutionButton
              action="import_x_reference"
              actionName="从 X 链接导入"
              className="ghost-button"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, campaign_id: item.campaignId, character_id: selectedCharacter?.id, url: xUrl, rights_asserted: rightsConfirmed, reference_source: referenceSource }}
              reason={!parsedX ? '请填写有效的 X 贴文链接' : !rightsConfirmed ? '请先确认素材使用权限' : undefined}
            >
              从 X 链接导入
            </ExecutionButton>
            {activeMediaPanel === 'image' ? (
              <ExecutionButton
                action="generate_character_image"
                actionName="使用角色模型生成图片"
                resourceType="content_package"
                resourceId={item.id}
                payload={generationPayload}
                reason={missingGenerationReason}
              >
                使用角色模型生成图片
              </ExecutionButton>
            ) : (
              <ExecutionButton
                action="generate_character_video"
                actionName="使用角色模型生成视频"
                resourceType="content_package"
                resourceId={item.id}
                payload={generationPayload}
                reason={missingGenerationReason}
              >
                使用角色模型生成视频
              </ExecutionButton>
            )}
          </div>
        </section>
          </div>
        )}

        <section className="workspace-block">
          <h3>生成结果回传</h3>
          <GenerationResults
            item={item}
            assets={linkedAssets}
            runs={runs}
            selectedId={selectedGeneratedId}
            onSelect={setSelectedGeneratedId}
          />
        </section>

        <section className="workspace-block approval-block" id={sectionIds.approval}>
          <h3>终审与发布队列</h3>
          <div className="editor-grid final-review-editor">
            <label>最终贴文正文
              <textarea rows="5" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
            </label>
            <label>最终行动引导
              <input value={draft.cta} onChange={(event) => setDraft({ ...draft, cta: event.target.value })} />
            </label>
            <label>发布时间
              <input type="datetime-local" value={draft.scheduledAt} onChange={(event) => setDraft({ ...draft, scheduledAt: event.target.value })} />
            </label>
          </div>
          <div className="review-checklist">
            <Check label="正文已确认" ok={Boolean(draft.body.trim())} />
            <Check label="行动引导已确认" ok={Boolean(draft.cta.trim())} />
            <Check label="标签已确认" ok={Boolean(draft.tags.trim())} />
            <Check label="角色 / 角色模型已确认" ok={Boolean(selectedCharacter && hasLora(lora))} />
            <Check label="素材已确认" ok={Boolean(selectedAssets.length || linkedAssets.length)} />
            <Check label="素材权限已确认" ok={rightsConfirmed || linkedAssets.some((asset) => asset.rightsStatus)} />
          </div>
          <ExecutionButton
            action="finalize_content_package"
            actionName="审核通过并创建发布任务"
            resourceType="content_package"
            resourceId={item.id}
            payload={{
              content_package_id: item.id,
              selected_asset_id: selectedGeneratedId || null,
              selected_asset_ids: selectedAssetIds,
              final_body: draft.body,
              final_cta: draft.cta,
              final_tags: normalizeList(draft.tags),
              scheduled_at: draft.scheduledAt ? new Date(draft.scheduledAt).toISOString() : null,
              platform_account_id: item.accountId,
            }}
            reason={finalReviewReason}
            onCompleted={handleFinalized}
          >
            审核通过并进入发布队列
          </ExecutionButton>
          {publishTask && <p className="muted-line">已关联发布任务：{publishTask.id} · {displayText(publishTask.status)}</p>}
        </section>
          </div>
        </details>
        <ContextAIBox
          open={contextAI.open}
          mode={contextAI.mode}
          context={contentAIContext}
          onApply={handleContextAIApply}
          onSavePrompt={handleContextAISavePrompt}
          onClose={() => setContextAI((current) => ({ ...current, open: false }))}
        />
    </div>
  );
}

function RequirementGrid({ fields, value, empty }) {
  const entries = fields
    .map(([key, label]) => [label, value?.[key] ?? value?.[toCamel(key)]])
    .filter(([, nextValue]) => nextValue !== undefined && nextValue !== null && nextValue !== '');

  if (!entries.length && value?.text) entries.push(['说明', value.text]);
  if (!entries.length) return <div className="empty-card-inline">{empty}</div>;

  return (
    <div className="requirement-grid">
      {entries.map(([label, nextValue]) => (
        <Info key={label} label={label} value={nextValue} />
      ))}
    </div>
  );
}

function ModeInputs({ mode, selectedAssets, videoReq }) {
  if (mode === 'text_to_video') return <div className="empty-card-inline">文生视频会直接使用当前内容策略、视频脚本和角色模型。</div>;
  if (mode === 'image_to_video') return <ModeNotice title="图生视频" text="必须选择一张参考图片。系统会结合当前分镜和镜头运动生成视频。" selectedAssets={selectedAssets} />;
  if (mode === 'first_frame') return <ModeNotice title="首帧生视频" text="必须选择首帧图片。尾帧和运动由视频要求自动补充。" selectedAssets={selectedAssets} />;
  if (mode === 'first_last_frame') return <ModeNotice title="首尾帧生视频" text="需要首帧和尾帧参考，适合控制人物起止动作。" selectedAssets={selectedAssets} />;
  if (mode === 'reference_video') return <ModeNotice title="参考视频生成" text="必须选择参考视频，用于动作、镜头和节奏迁移。" selectedAssets={selectedAssets} />;
  if (mode === 'multi_shot') {
    return (
      <div className="shot-list">
        {(normalizeList(videoReq.shots) || []).slice(0, 8).map((shot, index) => (
          <div key={`${displayText(shot)}-${index}`} className="shot-card">
            <strong>镜头 {index + 1}</strong>
            <p>{displayText(shot)}</p>
          </div>
        ))}
        {!normalizeList(videoReq.shots).length && <div className="empty-card-inline">当前内容没有分镜列表，生成前建议先让智能体补充分镜。</div>}
      </div>
    );
  }
  return <div className="empty-card-inline">角色模型视频会使用已绑定角色模型（LoRA）的角色，并结合当前视频要求生成。</div>;
}

function ModeNotice({ title, text, selectedAssets }) {
  return (
    <div className="mode-notice">
      <strong>{title}</strong>
      <p>{text}</p>
      <small>已选参考素材：{selectedAssets.length ? selectedAssets.map((asset) => asset.name).join('、') : '暂无'}</small>
    </div>
  );
}

function GenerationResults({ item, assets, runs, selectedId, onSelect }) {
  const generatedAssets = assets.filter((asset) => {
    const metadata = safeJson(asset.raw?.metadata);
    return metadata.role === 'generated' || (asset.source && asset.source !== 'upload');
  });
  const selectedAsset = generatedAssets.find((asset) => String(asset.id) === String(selectedId));

  return (
    <div className="generation-result-layout">
      <div>
        <h4>工作流任务</h4>
        {runs.length ? runs.map((run) => (
          <article key={run.id} className="run-card">
            <div className="row-between">
              <strong>{run.tool_id || run.workflow_id || 'workflow_run'}</strong>
              <StatusBadge status={run.status} />
            </div>
            <Info label="run_id" value={run.id} />
            <Info label="成本" value={run.cost} />
            <Info label="开始" value={formatDate(run.created_at)} />
            <Info label="完成" value={formatDate(run.completed_at)} />
            <Info label="错误" value={run.error_message} />
            <div className="button-row">
              <ExecutionButton action="poll_asset_status" actionName="回传生成内容" className="ghost-button" resourceType="workflow_run" resourceId={run.id} payload={{ run_id: run.id, content_package_id: item.id }}>回传生成内容</ExecutionButton>
              <ExecutionButton action="regenerate_asset" actionName="重新生成" className="ghost-button" resourceType="workflow_run" resourceId={run.id} payload={{ run_id: run.id, content_package_id: item.id }}>重新生成</ExecutionButton>
            </div>
          </article>
        )) : <div className="empty-card-inline">暂无生成任务。提交图片或视频生成后，run_id、进度、错误和回传结果会显示在这里。</div>}
      </div>
      <div>
        <h4>已回传素材</h4>
        {generatedAssets.length ? (
          <>
            <div className="result-review-toolbar">
              <label>生成结果
                <select value={selectedId} onChange={(event) => onSelect(event.target.value)}>
                  <option value="">请选择生成结果</option>
                  {generatedAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.type} · {asset.status}{asset.raw?.approved_for_publishing ? ' · 已确认可用' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="button-row">
                <ExecutionButton action="poll_asset_status" actionName="回传生成内容" className="ghost-button" resourceType="asset" resourceId={selectedAsset?.id} payload={{ asset_id: selectedAsset?.id, content_package_id: item.id }} reason={!selectedAsset ? '请先选择生成结果' : undefined}>回传生成内容</ExecutionButton>
                <ExecutionButton action="review_generated_asset" actionName="确认这个内容能用" resourceType="asset" resourceId={selectedAsset?.id} payload={{ asset_id: selectedAsset?.id, content_package_id: item.id, approved: true }} reason={!selectedAsset ? '请先选择生成结果' : undefined}>确认这个内容能用</ExecutionButton>
                <ExecutionButton action="regenerate_asset" actionName="重新生成" className="ghost-button" resourceType="asset" resourceId={selectedAsset?.id} payload={{ asset_id: selectedAsset?.id, content_package_id: item.id }} reason={!selectedAsset ? '请先选择生成结果' : undefined}>重新生成</ExecutionButton>
              </div>
            </div>
            <div className="asset-selector-grid">
            {generatedAssets.map((asset) => (
              <article key={asset.id} className="asset-result-card">
                <AssetPreview asset={asset} />
                <strong>{asset.name}</strong>
                <small>{asset.type} · {asset.status} · {formatDate(asset.createdAt)}</small>
                <div className="button-row">
                  <ExecutionButton action="review_generated_asset" actionName="确认可用" className="ghost-button" resourceType="asset" resourceId={asset.id} payload={{ asset_id: asset.id, content_package_id: item.id, approved: true }}>确认可用</ExecutionButton>
                  <ExecutionButton action="review_generated_asset" actionName="驳回" className="ghost-button" resourceType="asset" resourceId={asset.id} payload={{ asset_id: asset.id, content_package_id: item.id, approved: false }}>驳回</ExecutionButton>
                </div>
              </article>
            ))}
            </div>
          </>
        ) : <div className="empty-card-inline">暂无生成结果。成功后会同时保存到素材库，并回到这张内容卡。</div>}
      </div>
    </div>
  );
}

function AssetPreview({ asset, compact = false, onBroken }) {
  const [failed, setFailed] = useState(false);
  const type = asset.type || asset.asset_type || 'asset';
  const url = asset.url || asset.output_url || asset.media_url || asset.storage_url;
  const thumbnail = asset.thumbnail || asset.thumbnail_url || asset.preview_url;
  const handleError = () => {
    setFailed(true);
    onBroken?.();
  };
  if (failed) {
    return <div className={`asset-placeholder ${compact ? 'compact-asset-preview' : ''}`}>素材无法加载</div>;
  }
  if (thumbnail || url) {
    if (String(type).toLowerCase().includes('video')) {
      return <video className={compact ? 'compact-asset-preview' : ''} src={url} poster={thumbnail} controls={!compact} muted onError={handleError} />;
    }
    return <img className={compact ? 'compact-asset-preview' : ''} src={thumbnail || url} alt={asset.name || '素材预览'} onError={handleError} />;
  }
  return <div className={`asset-placeholder ${compact ? 'compact-asset-preview' : ''}`}>{displayText(type, 'asset')}</div>;
}

function Info({ label, value }) {
  return (
    <section>
      <span>{label}</span>
      <strong>{displayText(value)}</strong>
    </section>
  );
}

function Check({ label, ok }) {
  return <span className={ok ? 'check-ok' : 'check-missing'}>{ok ? '✓' : '•'} {label}</span>;
}

function assetsForContent(item, assets) {
  const referenceIds = new Set([item.assetId, item.finalAssetId, ...item.referenceAssetIds].filter(Boolean).map(String));
  return assets.filter((asset) => (
    String(asset.contentId || '') === String(item.id)
    || referenceIds.has(String(asset.id))
  ));
}

function runsForContent(item, runs) {
  return (runs || []).filter((run) => {
    const input = run.input_data || {};
    return String(input.content_package_id || input.content_id || run.content_package_id || '') === String(item.id);
  });
}

function isTestContent(item) {
  const metadata = safeJson(item?.raw?.metadata);
  const marker = [
    item?.title,
    item?.sourceLabel,
    metadata.label,
    metadata.source,
    metadata.environment,
  ].filter(Boolean).join(' ').toLowerCase();

  return item?.raw?.is_test === true
    || item?.raw?.test_data === true
    || metadata.is_test === true
    || metadata.test_data === true
    || marker.includes('[test]')
    || marker.includes('[测试示例]')
    || marker.includes('测试示例');
}

function contentMatchesWorkflow(item, filter, data, assets) {
  if (filter === 'all') return true;
  if (filter === 'test') return isTestContent(item);

  const contentAssets = assetsForContent(item, assets);
  const contentRuns = runsForContent(item, data.workflowRuns || []);
  const publishTask = (data.publishTasks || []).find((task) => (
    String(task.content_package_id || task.content_id || '') === String(item.id)
  ));
  const states = [
    item.status,
    item.reviewStatus,
    item.approvalStatus,
    publishTask?.status,
    ...contentAssets.map((asset) => asset.status),
    ...contentRuns.map((run) => run.status),
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  const hasState = (...values) => values.some((value) => states.includes(value));
  const hasAsset = contentAssets.some((asset) => (
    Boolean(asset.url || asset.thumbnail)
    || ['completed', 'ready', 'approved', 'generated'].includes(String(asset.status).toLowerCase())
  ));

  if (filter === 'failed') return hasState('failed', 'error', 'cancelled');
  if (filter === 'published') return hasState('published');
  if (filter === 'pending_publish') {
    return !hasState('published', 'failed', 'error')
      && Boolean(publishTask || item.approvedForPublishing || hasState('approved', 'scheduled', 'ready_for_publish', 'publishing'));
  }
  if (filter === 'generated_asset') return !hasState('failed', 'error') && Boolean(hasAsset || item.assetConfirmed);
  if (filter === 'pending_asset') {
    return !hasAsset
      && !hasState('failed', 'error', 'published')
      && Boolean(item.copyConfirmed || item.approvedForPublishing || hasState('approved', 'copy_approved', 'pending_asset'));
  }
  if (filter === 'pending_review') {
    return !hasState('published', 'failed', 'error')
      && !item.approvedForPublishing
      && hasState('draft', 'review', 'pending', 'pending_review', 'ready_for_review');
  }

  return false;
}

function buildProductionGuide({ item, character, lora, linkedAssets, workflowRuns, publishTask, gateway }) {
  const copyDone = Boolean(item.copyConfirmed || item.approvedForPublishing || (item.body && item.cta));
  const roleDone = Boolean(character && hasLora(lora));
  const referenceDone = Boolean(item.referenceAssetIds?.length || linkedAssets.some((asset) => (
    asset.raw?.metadata?.role === 'reference' || ['upload', 'x', 'reference'].includes(String(asset.source || '').toLowerCase())
  )));
  const imageDone = linkedAssets.some((asset) => String(asset.type || '').toLowerCase().includes('image'));
  const videoDone = linkedAssets.some((asset) => String(asset.type || '').toLowerCase().includes('video'));
  const completedRun = workflowRuns.some((run) => ['completed', 'success'].includes(String(run.status || '').toLowerCase()));
  const activeRun = workflowRuns.some((run) => ['queued', 'running', 'generating'].includes(String(run.status || '').toLowerCase()));
  const resultDone = Boolean(imageDone || videoDone || completedRun || item.assetConfirmed);
  const finalDone = Boolean(item.approvedForPublishing || item.reviewStatus === 'approved' || item.approvalStatus === 'approved');
  const publishDone = Boolean(publishTask);
  const bridgeUnavailable = !gateway?.loading && !gateway?.connected;

  const blocked = (ready, fallback = 'blocked') => ready ? 'pending' : fallback;
  const steps = [
    { id: 'copy', label: '文案确认', status: copyDone ? 'completed' : 'pending', target: 'copy', reason: '文案尚未确认', action: '继续编辑文案' },
    { id: 'role', label: '角色 / 角色模型确认', status: roleDone ? 'completed' : blocked(copyDone), target: 'media', reason: '该内容还没有绑定角色或角色模型', action: '选择角色或配置角色模型' },
    { id: 'reference', label: '素材引用', status: referenceDone ? 'completed' : blocked(roleDone), target: 'media', reason: '还没有选择参考素材', action: '选择或导入参考素材' },
    { id: 'image', label: '图片生成', status: imageDone ? 'completed' : !roleDone ? 'blocked' : bridgeUnavailable ? 'needs_bridge' : 'pending', target: 'media', reason: bridgeUnavailable ? '执行服务暂未连接' : '图片尚未生成', action: bridgeUnavailable ? '查看执行网关状态' : '打开图片生成', page: bridgeUnavailable ? 'dashboard' : undefined },
    { id: 'video', label: '视频生成', status: videoDone ? 'completed' : !roleDone ? 'blocked' : bridgeUnavailable ? 'needs_bridge' : 'pending', target: 'media', reason: bridgeUnavailable ? '执行服务暂未连接' : '视频尚未生成', action: bridgeUnavailable ? '查看执行网关状态' : '打开视频生成', page: bridgeUnavailable ? 'dashboard' : undefined },
    { id: 'results', label: '结果回传', status: resultDone ? 'completed' : activeRun ? 'pending' : bridgeUnavailable ? 'needs_bridge' : 'blocked', target: 'results', reason: activeRun ? '生成任务仍在运行' : bridgeUnavailable ? '执行服务暂未连接' : '还没有可回传的生成结果', action: bridgeUnavailable ? '查看执行网关状态' : '查看生成结果', page: bridgeUnavailable ? 'dashboard' : undefined },
    { id: 'approval', label: '终审', status: finalDone ? 'completed' : resultDone ? 'pending' : 'blocked', target: 'approval', reason: resultDone ? '内容还没有完成终审' : '请先确认文案和生成素材', action: '进入内容终审' },
    { id: 'publish', label: '发布队列', status: publishDone ? 'completed' : finalDone ? 'pending' : 'blocked', target: 'approval', reason: finalDone ? '尚未创建发布任务' : '请先完成内容终审', action: finalDone ? '创建发布任务' : '进入内容终审' },
  ];
  const current = steps.find((step) => step.status !== 'completed') || steps[steps.length - 1];

  return {
    steps,
    current,
    reason: current.status === 'completed' ? '生产流程已完成' : current.reason,
    nextAction: { label: current.action, target: current.target, page: current.page },
  };
}

function productionStatusLabel(status) {
  return {
    completed: '已完成',
    pending: '待处理',
    blocked: '被阻塞',
    needs_bridge: '需要 Bridge',
  }[status] || '待处理';
}

function getLoraInfo(character, item) {
  return getLoraOptions(character, item)[0] || {};
}

function getLoraOptions(character, item) {
  const candidates = [
    item?.loraInfo,
    character?.lora_info,
    character?.lora,
    character?.loras,
    character?.lora_configs,
  ].flatMap((source) => {
    if (!source) return [];
    if (Array.isArray(source)) return source;
    if (typeof source === 'string') {
      const parsed = safeJson(source);
      if (Array.isArray(parsed)) return parsed;
      return Object.keys(parsed).length ? [parsed] : [{ name: source }];
    }
    return [source];
  }).filter((option) => option && typeof option === 'object');

  const seen = new Set();
  return candidates.filter((option) => {
    if (!hasLora(option)) return false;
    const key = loraOptionKey(option);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loraOptionKey(lora) {
  return String(lora?.id || lora?.model || lora?.filename || lora?.name || 'lora');
}

function copyFromVersion(version, item) {
  return {
    title: version?.title || item.title || '',
    hook: version?.hook || item.hook || '',
    body: version?.body || item.body || '',
    cta: version?.cta || item.cta || '',
    hashtags: normalizeList(version?.hashtags || item.tags).join(', '),
  };
}

function revisionTypeLabel(value) {
  const labels = {
    generated: 'AI 候选',
    manual_edit: '人工修改',
    shorten: '缩短',
    enhance_hook: '增强开头',
    add_question: '增加互动问题',
    change_tone: '改变语气',
    localize: '平台本地化',
    regenerate: '重新生成',
  };
  return labels[value] || value || '版本';
}

function safeJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function hasLora(lora) {
  return Boolean(lora?.name || lora?.model || lora?.filename || lora?.id);
}

function normalizeRequirement(value) {
  if (!value) return {};
  if (typeof value === 'string') return { text: value };
  if (Array.isArray(value)) return { text: value.map((item) => displayText(item)).join('；') };
  if (typeof value === 'object') return value;
  return { text: String(value) };
}

function truncate(value, length) {
  const text = displayText(value, '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function formatDayPackageTitle(title, dayIndex) {
  const value = String(title || '待生成内容')
    .replace(/^Day\s*\d+\s*[｜|:：-]?\s*/i, '')
    .replace(/\s*[/／]\s*\d+\s*$/, '')
    .trim();
  return `Day ${dayIndex}｜${value || '待生成内容'}`;
}

function booleanText(value) {
  if (value === undefined || value === null || value === '') return '未配置';
  return value ? '支持' : '不支持';
}

function toLocalDateTimeValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function videoModeLabel(value) {
  return VIDEO_MODES.find(([mode]) => mode === value)?.[1] || value;
}

function parseXUrl(value) {
  const match = String(value || '').trim().match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/i);
  if (!match) return null;
  return { username: match[1], statusId: match[2] };
}

function fileToPayload(file) {
  return {
    filename: file.name,
    content_type: file.type,
    file_size_bytes: file.size,
  };
}

function toCamel(value) {
  return value.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}
