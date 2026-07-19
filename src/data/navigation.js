export const navigationItems = [
  { id: 'dashboard', label: 'Dashboard', icon: '●' },
  { id: 'accounts', label: '账号矩阵', icon: '●' },
  { id: 'content', label: '内容库', icon: '✓' },
  { id: 'ai-studio', label: 'AI生成', icon: '✦' },
  { id: 'assets', label: '素材库', icon: '■' },
  { id: 'characters', label: '角色库', icon: '●' },
  { id: 'prompts', label: 'Prompt库', icon: '◇' },
  { id: 'workflows', label: 'Workflow Center', icon: '⚙' },
  { id: 'agents', label: 'Agent Center', icon: '✧' },
  { id: 'intelligence', label: '内容情报', icon: '●' },
  { id: 'collection', label: '采集中心', icon: '●' },
  { id: 'automation', label: '自动化中心', icon: '✧' },
  { id: 'publish', label: '发布中心', icon: '↗' },
  { id: 'performance', label: '效果分析', icon: '↗' },
  { id: 'health', label: '系统健康', icon: '▦' },
  { id: 'report', label: '运营日报', icon: '▣' },
  { id: 'planner', label: '发布计划', icon: '●' },
  { id: 'analytics', label: '数据分析', icon: '↗' },
  { id: 'settings', label: '设置', icon: '⚙' },
];

export const platforms = ['X', 'Instagram', 'TikTok', 'YouTube', 'Telegram'];

export const platformAdapterIds = ['telegram', 'x', 'youtube', 'instagram', 'tiktok'];

export const collectorPlatforms = ['X', 'Instagram', 'TikTok', 'YouTube', 'Telegram', 'Reddit'];

export const contentStatuses = ['idea', 'researching', 'draft', 'generating', 'review', 'scheduled', 'published', 'analyzing', 'archived'];

export const publishTaskStatuses = ['draft', 'scheduled', 'publishing', 'published', 'failed'];

export const workflowRunStatuses = ['pending', 'running', 'success', 'failed'];

export const agentTypes = [
  { value: 'content_generator', label: '内容生成 Agent' },
  { value: 'asset_generator', label: '素材生成 Agent' },
  { value: 'analysis', label: '分析 Agent' },
];

export const agentStatuses = [
  { value: 'active', label: '启用' },
  { value: 'paused', label: '暂停' },
  { value: 'inactive', label: '停用' },
];

export const agentTaskStatuses = ['pending', 'running', 'success', 'failed'];

export const sourceTypes = [
  { value: 'telegram', label: 'Telegram频道' },
  { value: 'competitor_account', label: '竞争账号' },
  { value: 'channel', label: '频道' },
  { value: 'keyword', label: '关键词' },
  { value: 'hashtag', label: '标签' },
  { value: 'rss', label: 'RSS' },
  { value: 'manual', label: '手动来源' },
];

export const collectionFrequencies = [
  { value: 'manual', label: '手动' },
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
];

export const automationJobTypes = [
  { value: 'collector', label: 'Collector任务' },
  { value: 'agent', label: 'Agent任务' },
  { value: 'workflow', label: 'Workflow任务' },
  { value: 'platform', label: '平台任务' },
];

export const accountCategories = [
  { value: 'brand', label: '品牌账号' },
  { value: 'personal', label: '个人账号' },
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

export const contentTypes = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图文' },
  { value: 'video', label: '视频' },
  { value: 'carousel', label: '轮播图' },
  { value: 'ad', label: '广告' },
  { value: 'thread', label: '长帖/Thread' },
  { value: 'short_video', label: '短视频' },
];

export const assetTypes = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'prompt', label: 'Prompt' },
  { value: 'workflow', label: 'Workflow' },
  { value: 'lora', label: 'LoRA' },
];

export const promptCategories = [
  { value: 'general', label: '通用' },
  { value: 'caption', label: '社媒文案' },
  { value: 'image', label: '图像生成' },
  { value: 'video', label: '视频生成' },
  { value: 'analysis', label: '内容分析' },
  { value: 'workflow', label: '工作流' },
];
