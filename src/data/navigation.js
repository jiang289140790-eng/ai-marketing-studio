export const navigationSections = [
  {
    label: '总览',
    items: [{ id: 'dashboard', label: 'AI Command Center', icon: '◉' }],
  },
  {
    label: 'AI 运营',
    items: [
      { id: 'campaigns', label: 'Campaign 与策略', icon: '◆' },
      { id: 'workspace', label: '内容工作台', icon: '✓' },
      { id: 'publish', label: '发布队列', icon: '↗' },
      { id: 'aiworks', label: 'AI 成果', icon: '✦' },
      { id: 'analytics', label: '分析优化', icon: '↗' },
      { id: 'knowledge', label: '知识库', icon: '◇' },
    ],
  },
  {
    label: '资产中心',
    items: [
      { id: 'accounts', label: '账号矩阵', icon: '●' },
      { id: 'assets', label: '素材库', icon: '■' },
      { id: 'characters', label: '角色库', icon: '✦' },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'connections', label: '平台连接', icon: '🔗' },
      { id: 'health', label: '系统状态', icon: '▣' },
      { id: 'workflows', label: '工作流与模型配置', icon: '⚙' },
    ],
  },
];

export const navigationItems = navigationSections.flatMap((section) => section.items);

export const platforms = ['X', 'Instagram', 'TikTok', 'YouTube', 'Telegram', 'Discord'];

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
  { value: 'prompt', label: 'Prompt' },
  { value: 'workflow', label: 'Workflow' },
  { value: 'lora', label: 'LoRA' },
];
