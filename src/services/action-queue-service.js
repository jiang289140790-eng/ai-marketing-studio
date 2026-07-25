import { getDailyPlanApprovalStatus, getContentPackageDay, normalizeCampaignDailyPlan } from '../utils/campaign-daily-plan.js';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
const STRATEGY_REVIEW_STATUSES = new Set(['draft', 'review', 'pending', 'pending_approval']);
const APPROVED_STATUSES = new Set(['approved', 'completed', 'published', 'scheduled']);
const FAILED_STATUSES = new Set(['failed', 'error']);

export async function getUserActionQueue(options = {}) {
  const data = options.data || await loadActionQueueData();
  return buildUserActionQueue(data, options);
}

export function buildUserActionQueue(data = {}, options = {}) {
  const campaigns = data.campaigns || [];
  const strategies = data.strategies || [];
  const contentPackages = data.contentPackages || [];
  const contentItems = data.legacyContent || [];
  const assets = [...(data.legacyAssets || []), ...(data.assets || [])];
  const publishTasks = data.publishTasks || [];
  const runs = [...(data.agentRuns || []), ...(data.workflowRuns || [])];
  const accounts = data.accounts || [];
  const campaignById = new Map(campaigns.map((item) => [String(item.id), item]));
  const accountById = new Map(accounts.map((item) => [String(item.id), item]));
  const queue = [];

  for (const strategy of strategies) {
    const campaignId = strategy.campaign_id || '';
    const status = normalizedStatus(strategy.status);
    if (STRATEGY_REVIEW_STATUSES.has(status)) {
      queue.push(createAction({
        action_type: 'approve_strategy',
        entity_type: 'strategy_plan',
        entity_id: strategy.id,
        campaign_id: campaignId,
        title: '批准运营策略',
        summary: '策略需要你确认目标、内容方向和风险边界后才能进入正式计划。',
        priority: 'high',
        target_page: 'campaigns',
        target_id: strategy.id,
        recommended_action: '查看并批准策略',
      }, campaignById, accountById));
    }

    const plan = normalizeCampaignDailyPlan(strategy.daily_plan);
    const planStatus = getDailyPlanApprovalStatus(strategy);
    if (status === 'approved' && plan.length && planStatus !== 'approved') {
      queue.push(createAction({
        action_type: 'approve_7_day_plan',
        entity_type: 'strategy_plan',
        entity_id: strategy.id,
        campaign_id: campaignId,
        title: '批准 7 天内容计划',
        summary: `计划已生成 ${plan.length} 天，需要批准后才能创建正式内容包。`,
        priority: 'high',
        target_page: 'campaigns',
        target_id: strategy.id,
        recommended_action: '检查并批准 7 天计划',
      }, campaignById, accountById));
    }
  }

  for (const contentPackage of contentPackages) {
    const campaignId = contentPackage.campaign_id || '';
    const day = getContentPackageDay(contentPackage);
    if (day !== 1) continue;
    const workbench = packageWorkbench(contentPackage);
    const versions = contentItems.filter((item) => (
      String(item.content_package_id || item.generation_brief?.content_package_id || '') === String(contentPackage.id)
    ));
    const selectedVersionId = workbench.selected_version_id || contentPackage.selected_version_id;
    const selectedVersion = versions.find((item) => String(item.id) === String(selectedVersionId || ''));
    const hasCopy = Boolean(selectedVersionId || selectedVersion || contentPackage.body || contentPackage.content || contentPackage.hook);
    const packageAssets = assets.filter((asset) => (
      String(asset.content_package_id || asset.metadata?.content_package_id || '') === String(contentPackage.id)
    ));
    const usableAssets = packageAssets.filter(isUsableAsset);
    const approvedAssets = usableAssets.filter(isApprovedAsset);

    if (!hasCopy) {
      queue.push(createAction({
        action_type: 'generate_day1_content',
        entity_type: 'content_package',
        entity_id: contentPackage.id,
        campaign_id: campaignId,
        day: 1,
        title: '生成 Day 1 文案',
        summary: packageTopic(contentPackage) || 'Day 1 内容包已就绪，等待生成候选文案。',
        priority: 'high',
        target_page: 'workspace',
        target_id: contentPackage.id,
        recommended_action: '进入 Day 1 生成文案',
      }, campaignById, accountById));
      continue;
    }

    if (!workbench.copy_approved && !APPROVED_STATUSES.has(normalizedStatus(contentPackage.review_status))) {
      queue.push(createAction({
        action_type: 'review_copy',
        entity_type: 'content_package',
        entity_id: contentPackage.id,
        campaign_id: campaignId,
        day: 1,
        title: '审核 Day 1 文案',
        summary: selectedVersion?.title || packageTopic(contentPackage) || '候选文案已生成，等待人工确认主版本。',
        priority: 'high',
        target_page: 'workspace',
        target_id: contentPackage.id,
        recommended_action: '审核文案',
      }, campaignById, accountById));
      continue;
    }

    const jobs = runs.filter((run) => (
      String(run.content_package_id || run.input?.content_package_id || run.metadata?.content_package_id || '') === String(contentPackage.id)
    ));
    const activeJob = jobs.some((job) => ['queued', 'running', 'generating'].includes(normalizedStatus(job.status)));
    if (!usableAssets.length && !activeJob) {
      queue.push(createAction({
        action_type: 'generate_asset',
        entity_type: 'content_package',
        entity_id: contentPackage.id,
        campaign_id: campaignId,
        day: 1,
        title: '生成 Day 1 素材',
        summary: '文案已确认，下一步需要确认角色、LoRA 和工作流并创建素材。',
        priority: 'medium',
        target_page: 'workspace',
        target_id: contentPackage.id,
        recommended_action: '配置并生成素材',
      }, campaignById, accountById));
    } else if (usableAssets.length && !approvedAssets.length) {
      queue.push(createAction({
        action_type: 'confirm_asset',
        entity_type: 'content_package',
        entity_id: contentPackage.id,
        campaign_id: campaignId,
        day: 1,
        title: '确认 Day 1 主素材',
        summary: `已有 ${usableAssets.length} 个可用素材，等待选择主素材并人工批准。`,
        priority: 'medium',
        target_page: 'workspace',
        target_id: contentPackage.id,
        recommended_action: '查看并确认素材',
      }, campaignById, accountById));
    }
  }

  for (const task of publishTasks) {
    const contentPackage = contentPackages.find((item) => String(item.id) === String(task.content_package_id || ''));
    const campaignId = task.campaign_id || contentPackage?.campaign_id || '';
    const day = getContentPackageDay(contentPackage);
    const status = normalizedStatus(task.status);
    const approvalStatus = normalizedStatus(task.approval_status);
    if (FAILED_STATUSES.has(status) || task.last_error || task.error_summary) {
      queue.push(createAction({
        action_type: 'resolve_publish_failure',
        entity_type: 'publish_task',
        entity_id: task.id,
        campaign_id: campaignId,
        day,
        title: '处理发布失败',
        summary: task.error_summary || task.last_error || '发布任务失败，需要检查平台连接或任务参数。',
        priority: 'urgent',
        target_page: 'publish',
        target_id: task.id,
        recommended_action: '查看失败原因',
      }, campaignById, accountById));
    } else if (approvalStatus === 'pending' || ['pending', 'ready_for_review', 'draft'].includes(status)) {
      queue.push(createAction({
        action_type: 'approve_publish',
        entity_type: 'publish_task',
        entity_id: task.id,
        campaign_id: campaignId,
        day,
        title: '批准发布任务',
        summary: task.title || task.caption || '内容已进入发布预检，等待你确认账号、时间和安全条件。',
        priority: 'high',
        target_page: 'publish',
        target_id: task.id,
        recommended_action: '执行发布预检并批准',
      }, campaignById, accountById));
    }
  }

  for (const run of runs.filter(isMetricsFailure)) {
    queue.push(createAction({
      action_type: 'resolve_metrics_failure',
      entity_type: run.agent_name ? 'agent_run' : 'workflow_run',
      entity_id: run.id,
      campaign_id: run.campaign_id || run.input?.campaign_id || run.metadata?.campaign_id || '',
      day: Number(run.day || run.input?.day || 0) || null,
      title: '处理指标回收失败',
      summary: run.error_summary || run.error || run.last_error || '发布指标未能正常回收，分析优化数据可能不完整。',
      priority: 'urgent',
      target_page: 'analytics',
      target_id: run.id,
      recommended_action: '检查并重试指标回收',
    }, campaignById, accountById));
  }

  const deduplicated = [...new Map(queue.map((item) => [
    `${item.action_type}:${item.entity_type}:${item.entity_id}`,
    item,
  ])).values()];
  return deduplicated
    .filter((item) => !options.campaignId || String(item.campaign_id) === String(options.campaignId))
    .sort((left, right) => (
      (PRIORITY_ORDER[left.priority] ?? 9) - (PRIORITY_ORDER[right.priority] ?? 9)
      || Number(left.day || 99) - Number(right.day || 99)
      || left.title.localeCompare(right.title, 'zh-CN')
    ));
}

function createAction(input, campaignById, accountById) {
  const campaign = campaignById.get(String(input.campaign_id || '')) || {};
  const accountId = campaign.metadata?.primary_account_id
    || firstId(campaign.target_accounts)
    || input.account_id;
  const account = accountById.get(String(accountId || '')) || {};
  const params = new globalThis.URLSearchParams();
  if (input.campaign_id) params.set('campaign_id', input.campaign_id);
  if (input.day) params.set('day', String(input.day));
  const detail = input.target_id ? `/${encodeURIComponent(input.target_id)}` : '';
  const query = params.toString() ? `?${params.toString()}` : '';
  return {
    action_type: input.action_type,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    campaign_id: input.campaign_id || null,
    day: input.day || null,
    title: input.title,
    summary: String(input.summary || '').replace(/\s+/g, ' ').trim(),
    priority: input.priority || 'medium',
    target_url: `#/${input.target_page}${detail}${query}`,
    recommended_action: input.recommended_action,
    campaign_name: campaign.name || campaign.title || '未命名运营活动',
    account_name: account.display_name || account.username || account.handle || account.account_name || '未关联账号',
    target_page: input.target_page,
    target_id: input.target_id || '',
    target_params: Object.fromEntries(params.entries()),
  };
}

function packageWorkbench(contentPackage) {
  const source = asObject(contentPackage.source_insights);
  return asObject(source.content_workbench || contentPackage.metadata?.content_workbench);
}

function packageTopic(contentPackage) {
  const source = asObject(contentPackage.source_insights);
  return source.topic || source.pillar || contentPackage.title || '';
}

function isUsableAsset(asset) {
  if (asset.metadata?.storage_missing) return false;
  const status = normalizedStatus(asset.status || asset.generation_status);
  return ['completed', 'ready', 'approved', 'published'].includes(status)
    && Boolean(asset.output_url || asset.url || asset.storage_path || asset.output_storage_path);
}

function isApprovedAsset(asset) {
  return asset.is_primary === true
    || asset.approved === true
    || normalizedStatus(asset.review_status || asset.approval_status || asset.status) === 'approved';
}

function isMetricsFailure(run) {
  if (!FAILED_STATUSES.has(normalizedStatus(run.status))) return false;
  const haystack = [
    run.agent_name,
    run.workflow_name,
    run.task_type,
    run.type,
    run.action,
    run.tool_name,
  ].join(' ').toLowerCase();
  return /(metric|analytics|insight|performance|指标|数据回收)/.test(haystack);
}

function firstId(value) {
  const item = Array.isArray(value) ? value[0] : value;
  return typeof item === 'string' ? item : item?.id || item?.account_id || item?.social_account_id;
}

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function loadActionQueueData() {
  const { loadCommandCenterData } = await import('./ops-service.js');
  return loadCommandCenterData();
}
