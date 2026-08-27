// 导航唯一注册源。用户可见入口只保留 Harness 对话入口
// 和业务结果/资产业务页；旧固定规划器、调试页和后台配置页仍保留
// 路由兼容，但不再作为产品入口展示。
export const harnessJourney = [
  { id: 'ai', key: 'new', label: '新任务', icon: '✦', testId: 'harness-journey-new' },
  { id: 'ai', key: 'session', label: '当前会话', icon: '⋯', testId: 'harness-journey-session' },
];

export const compatibilitySections = [
  {
    label: '业务结果',
    items: [
      { id: 'research', label: '研究与 Brief', icon: '⌕', testId: 'harness-plugin-research' },
      { id: 'knowledge', label: '知识库', icon: '◈', testId: 'harness-plugin-knowledge' },
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

// 用户可见导航唯一来源：主旅程入口 + 业务页，每页只有一个定义。
export const navigationItems = [
  { id: 'ai', label: '新任务', icon: '✦' },
  ...compatibilitySections.flatMap((section) => section.items),
];

// 可见导航保持精简；旧页面仍在路由白名单中，以保证书签和历史深链接可用。
export const routablePageIds = Object.freeze([
  ...navigationItems.map((item) => item.id),
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
  { value: 'text', label: '纯文字' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'short_video', label: '短视频' },
  { value: 'carousel', label: '轮播图' },
  { value: 'thread', label: '长帖 / Thread' },
  { value: 'ad', label: '广告内容' },
];
