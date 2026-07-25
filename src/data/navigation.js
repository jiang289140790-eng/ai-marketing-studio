export const navigationSections = [
  {
    label: '总览',
    items: [{ id: 'dashboard', label: 'AI 运营指挥中心', icon: '◉' }],
  },
  {
    label: 'AI 运营',
    items: [
      { id: 'campaigns', label: '运营活动', icon: '◆' },
      { id: 'plan', label: '内容计划', icon: '▤' },
      { id: 'workspace', label: '内容工作台', icon: '✓' },
      { id: 'intelligence', label: '内容情报', icon: '⌕' },
      { id: 'publish', label: '发布中心', icon: '↗' },
    ],
  },
  {
    label: '资产中心',
    items: [
      { id: 'accounts', label: '账号矩阵', icon: '●' },
      { id: 'characters', label: '角色库', icon: '✦' },
      { id: 'assets', label: '素材库', icon: '■' },
      { id: 'generation', label: '生成任务', icon: '◫' },
      { id: 'prompts', label: '提示词库', icon: '✎' },
    ],
  },
  {
    label: '智能分析',
    items: [
      { id: 'data-analytics', label: '数据分析', icon: '▥' },
      { id: 'analytics', label: 'AI 复盘', icon: '◇' },
      { id: 'dailyreport', label: '运营日报', icon: '▦' },
      { id: 'knowledge', label: '知识库', icon: '🧠' },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'connections', label: '平台连接', icon: '🔗' },
      { id: 'workflows', label: '工作流与模型', icon: '⚙' },
      { id: 'health', label: '系统状态', icon: '▣' },
    ],
  },
];

export const navigationItems = navigationSections.flatMap((section) => section.items);

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
