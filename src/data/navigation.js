// 用户可见导航只保留 Harness 入口和 AMS 业务沉淀页。
// 旧固定规划器、调试页、提示词库、工作流配置仍可被历史深链访问，
// 但不再作为产品主入口展示。
export const navigationSections = [
  {
    label: 'AI 工作',
    items: [
      { id: 'ai', label: '进入 Harness', icon: '✦', testId: 'harness-entry' },
    ],
  },
  {
    label: '业务结果',
    items: [
      { id: 'research', label: '研究与 Brief', icon: '⌕', testId: 'harness-plugin-research' },
      { id: 'knowledge', label: '知识库', icon: '◇', testId: 'harness-plugin-knowledge' },
      { id: 'generation', label: '生成结果', icon: '▣', testId: 'harness-plugin-generation' },
      { id: 'publish', label: '发布中心', icon: '↗' },
    ],
  },
  {
    label: '业务资产',
    items: [
      { id: 'characters', label: '角色库', icon: '✦' },
      { id: 'assets', label: '素材库', icon: '■' },
    ],
  },
];

export const navigationItems = navigationSections.flatMap((section) => section.items);

export const harnessJourney = [
  { id: 'ai', key: 'new', label: '新任务', icon: '✦', testId: 'harness-journey-new' },
  { id: 'ai', key: 'session', label: '当前会话', icon: '⋯', testId: 'harness-journey-session' },
];

export const compatibilitySections = navigationSections.filter((section) => section.label !== 'AI 工作');

export const routablePageIds = Object.freeze([
  ...navigationItems.map((item) => item.id),
  'tasks',
  'prompts',
  'workflows',
  'health',
  'workspace',
  'intelligence',
  'data-analytics',
  'analytics',
  'dailyreport',
  'campaigns',
  'accounts',
  'connections',
]);

export const platforms = ['X', 'Instagram', 'TikTok', 'YouTube', 'Telegram', 'Discord'];

export const promptCategories = [
  { value: 'caption', label: '文案' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'viral_analysis', label: '分析' },
  { value: 'workflow', label: '工作流' },
  { value: 'system', label: '系统' },
];

export const platformAdapterIds = ['telegram', 'x', 'youtube', 'instagram', 'tiktok', 'discord'];

export const accountCategories = [
  { value: 'owned', label: '自有账号' },
  { value: 'competitor', label: '竞品账号' },
  { value: 'inspiration', label: '灵感账号' },
];

export const apiStatuses = [
  { value: 'not_connected', label: '未连接' },
  { value: 'connected', label: '已连接' },
  { value: 'limited', label: '权限有限' },
  { value: 'error', label: '异常' },
  { value: 'expired', label: '已过期' },
];

export const assetTypes = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'prompt', label: '提示词' },
  { value: 'workflow', label: '工作流' },
  { value: 'lora', label: 'LoRA' },
];

export const contentTypes = [
  { value: 'text', label: '纯文本' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'short_video', label: '短视频' },
  { value: 'carousel', label: '轮播图' },
  { value: 'thread', label: '长帖 / Thread' },
  { value: 'ad', label: '广告内容' },
];
