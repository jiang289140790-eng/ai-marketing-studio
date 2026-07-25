const COMPLETED_STATUSES = new Set(['published', 'completed', 'archived']);
const REVIEWED_STATUSES = new Set(['approved', 'scheduled', 'published', 'completed']);

export function normalizeContentPackageSequence(contentPackages = [], strategies = []) {
  const strategyById = new Map((strategies || []).map((strategy) => [String(strategy.id), strategy]));
  const prepared = (contentPackages || []).map((contentPackage, originalIndex) => {
    const strategy = strategyById.get(String(contentPackage.strategyId || ''));
    const dailyPlan = normalizeStrategyDailyPlan(strategy);
    const dayIndex = readDayIndex(contentPackage, dailyPlan);
    return {
      contentPackage,
      originalIndex,
      dailyPlan,
      dayIndex,
      createdAt: contentPackage.createdAt || contentPackage.raw?.created_at || '',
      title: contentPackage.title || '',
    };
  });

  assignFallbackDays(prepared);

  const normalized = prepared
    .map(({ contentPackage, dayIndex, dailyPlan }) => {
      const planDay = dailyPlan[dayIndex - 1] || {};
      const status = contentPackage.reviewStatus || contentPackage.status || 'draft';
      const isCompleted = Boolean(
        contentPackage.approvedForPublishing
        || COMPLETED_STATUSES.has(String(status).toLowerCase())
        || COMPLETED_STATUSES.has(String(contentPackage.status).toLowerCase()),
      );
      const productionStep = resolveProductionStep(contentPackage, status, isCompleted);
      return {
        id: contentPackage.id,
        dayIndex,
        dayLabel: `Day ${dayIndex}`,
        pillar: readPillar(contentPackage) || planDay.pillar || contentPackage.title || '待定主题',
        platform: contentPackage.platform || planDay.platform || '待定平台',
        status,
        productionStep,
        isCurrent: false,
        isCompleted,
        isBlocked: productionStep.blocked,
        contentPackage,
      };
    })
    .sort(compareSequence);

  const currentIndex = normalized.findIndex((item) => !item.isCompleted);
  if (normalized.length) normalized[currentIndex >= 0 ? currentIndex : normalized.length - 1].isCurrent = true;
  return normalized;
}

export function normalizeStrategyDailyPlan(strategy) {
  const plan = strategy?.plan || strategy?.strategy || strategy?.output || {};
  const value = strategy?.daily_plan || plan.daily_plan || plan.weekly_plan || plan.content_calendar;
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.day || item?.date || `Day ${index + 1}`, item])
    : Object.entries(value);

  return entries.slice(0, 7).map(([day, item], index) => {
    const entry = typeof item === 'string' ? { pillar: item } : item || {};
    return {
      dayIndex: readPositiveInteger(entry.day_index || entry.plan_day || day) || index + 1,
      dayLabel: `Day ${index + 1}`,
      pillar: entry.pillar || entry.theme || entry.topic || entry.title || entry.content || '',
      platform: normalizeList(entry.platform || entry.platforms || entry.channel).join(' / '),
    };
  });
}

export function dayTitle(dayIndex, pillar) {
  return `Day ${dayIndex}｜${String(pillar || '待定主题').replace(/^Day\s*\d+\s*[｜|:：-]?\s*/i, '').trim() || '待定主题'}`;
}

function readDayIndex(item, dailyPlan) {
  const raw = item.raw || {};
  const sourceInsights = normalizeObject(raw.source_insights);
  const imageRequirements = normalizeObject(raw.image_requirements || item.imageRequirements);
  const videoRequirements = normalizeObject(raw.video_requirements || item.videoRequirements);
  const direct = [
    raw.day_index,
    raw.plan_day,
    raw.day,
    sourceInsights.day_index,
    sourceInsights.plan_day,
    sourceInsights.day,
    imageRequirements.day_index,
    imageRequirements.plan_day,
    videoRequirements.day_index,
    videoRequirements.plan_day,
  ].map(readPositiveInteger).find(Boolean);
  if (direct) return direct;

  const searchable = [
    item.title,
    raw.source_insights,
    sourceInsights.day_label,
    sourceInsights.pillar,
    imageRequirements.day_label,
    videoRequirements.day_label,
  ].map(stringify).join(' ');
  const parsed = readPositiveInteger(searchable);
  if (parsed) return parsed;

  const normalizedTitle = normalizeText(item.title);
  const matchIndex = dailyPlan.findIndex((planDay) => {
    const pillar = normalizeText(planDay.pillar);
    return pillar && normalizedTitle.includes(pillar);
  });
  return matchIndex >= 0 ? matchIndex + 1 : null;
}

function assignFallbackDays(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = String(item.contentPackage.strategyId || item.contentPackage.campaignId || 'unlinked');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  groups.forEach((group) => {
    const used = new Set(group.map((item) => item.dayIndex).filter(Boolean));
    const missing = group
      .filter((item) => !item.dayIndex)
      .sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.title, right.title) || left.originalIndex - right.originalIndex);
    let nextDay = 1;
    missing.forEach((item) => {
      while (used.has(nextDay)) nextDay += 1;
      item.dayIndex = nextDay;
      used.add(nextDay);
      nextDay += 1;
    });
  });
}

function resolveProductionStep(item, status, isCompleted) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (isCompleted) return { id: 'publish', label: '已进入发布队列', blocked: false };
  if (!item.copyConfirmed && !REVIEWED_STATUSES.has(normalizedStatus)) return { id: 'copy', label: '文案确认', blocked: false };
  if (!item.characterId || !(item.loraId || item.loraInfo)) return { id: 'role', label: '角色 / LoRA 确认', blocked: true };
  if (!(item.referenceAssetIds || []).length && !item.assetId) return { id: 'reference', label: '素材引用', blocked: true };
  if (!item.finalAssetId && !item.assetConfirmed && !['generated', 'review'].includes(normalizedStatus)) return { id: 'visual', label: '视觉生成', blocked: false };
  if (!item.approvedForPublishing) return { id: 'review', label: '结果审核', blocked: false };
  return { id: 'publish', label: '发布队列', blocked: false };
}

function readPillar(item) {
  const raw = item.raw || {};
  const sourceInsights = normalizeObject(raw.source_insights);
  const imageRequirements = normalizeObject(raw.image_requirements || item.imageRequirements);
  return sourceInsights.pillar
    || sourceInsights.theme
    || sourceInsights.topic
    || imageRequirements.pillar
    || imageRequirements.theme
    || String(item.title || '')
      .replace(/^Day\s*\d+\s*[｜|:：-]?\s*/i, '')
      .replace(/\s*[/／]\s*\d+\s*$/, '')
      .trim();
}

function compareSequence(left, right) {
  return left.dayIndex - right.dayIndex
    || compareText(left.contentPackage.createdAt, right.contentPackage.createdAt)
    || compareText(left.contentPackage.title, right.contentPackage.title);
}

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true });
}

function readPositiveInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  const text = String(value || '').trim();
  if (/^0?[1-9]\d*$/.test(text)) return Number(text);
  const match = text.match(/(?:day\s*0?([1-9]\d*)|第\s*0?([1-9]\d*)\s*(?:天|日))/i);
  const number = Number(match?.[1] || match?.[2]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return value.find((item) => item && typeof item === 'object') || {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value && typeof value === 'object') return Object.values(value).flat().map(String).filter(Boolean);
  return String(value || '').split(/[,，/]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value || '');
  } catch {
    return '';
  }
}
