const REQUIRED_PLAN_FIELDS = [
  'day',
  'planned_date',
  'platform',
  'content_pillar',
  'content_role',
  'topic',
  'objective',
  'hook_type',
  'format',
  'media_requirement',
  'CTA',
  'notes',
];

export function normalizeCampaignDailyPlan(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value).map(([key, item]) => ({ ...(asObject(item)), day: asObject(item).day || key }))
      : [];

  return entries
    .map((raw, index) => {
      const item = asObject(raw);
      const day = parseDay(item.day) || index + 1;
      return {
        ...item,
        day,
        planned_date: item.planned_date || item.date || '',
        platform: firstText(item.platform, item.platforms, item.channel),
        content_pillar: item.content_pillar || item.pillar || item.theme || '',
        content_role: item.content_role || '',
        topic: item.topic || item.title || item.content || '',
        objective: item.objective || '',
        hook_type: item.hook_type || item.hook_template || '',
        format: item.format || '',
        media_requirement: item.media_requirement || item.visual_direction || '',
        CTA: item.CTA || item.cta || item.cta_template || '',
        notes: item.notes || '',
      };
    })
    .filter((item) => item.day >= 1 && item.day <= 7)
    .sort((a, b) => a.day - b.day);
}

export function getDailyPlanApprovalStatus(strategy) {
  const markers = Array.isArray(strategy?.source_insights) ? strategy.source_insights : [];
  const latest = [...markers].reverse().find((item) => (
    item?.type === 'daily_plan_approval' || item?.type === 'daily_plan_generation'
  ));
  if (latest?.type === 'daily_plan_generation') return 'review';
  return latest?.status || 'draft';
}

export function getContentPackageDay(contentPackage) {
  return Number(
    asObject(contentPackage?.source_insights).day_index
    || asObject(contentPackage?.image_requirements).day_index
    || String(contentPackage?.title || '').match(/day\s*(\d+)/i)?.[1]
    || 0,
  );
}

export function getCampaignDayRows(dailyPlan, contentPackages = []) {
  const packagesByDay = new Map(
    contentPackages.map((item) => [getContentPackageDay(item), item]).filter(([day]) => day),
  );
  return normalizeCampaignDailyPlan(dailyPlan).map((plan) => {
    const contentPackage = packagesByDay.get(plan.day);
    const workflow = asObject(asObject(contentPackage?.source_insights).workflow_status);
    const status = workflow.content_status
      || (contentPackage ? (plan.day === 1 ? '待生产' : '未开始') : (plan.day === 1 ? '待创建内容包' : '未开始'));
    return { ...plan, status, contentPackage };
  });
}

export function isCompleteSevenDayPlan(value) {
  const plan = normalizeCampaignDailyPlan(value);
  return plan.length === 7 && plan.every((item) => REQUIRED_PLAN_FIELDS.every((key) => (
    item[key] !== undefined && item[key] !== null && item[key] !== ''
  )));
}

function parseDay(value) {
  return Number(String(value || '').match(/\d+/)?.[0] || 0);
}

function firstText(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value.join(' / ');
    if (value) return String(value);
  }
  return '';
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
