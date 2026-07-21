export const navigationItems = [
  { id: 'dashboard', label: '控制台', icon: '⌘' },
  { id: 'accounts', label: '账号矩阵', icon: '●' },
  { id: 'assets', label: '素材库', icon: '■' },
  { id: 'characters', label: '角色库', icon: '◆' },
  { id: 'content', label: '内容工厂', icon: '✓' },
  { id: 'intelligence', label: '情报中心', icon: '◌' },
  { id: 'publish', label: '发布中心', icon: '↗' },
  { id: 'analytics', label: '数据分析', icon: '↘' },
  { id: 'settings', label: '设置', icon: '⚙' },
];

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
