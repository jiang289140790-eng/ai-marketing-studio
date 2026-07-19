export function formatDate(value) {
  if (!value) return '—';

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function statusLabel(status) {
  const labels = {
    active: '正常',
    connected: '已连接',
    disconnected: '未连接',
    not_connected: '未连接',
    limited: '权限有限',
    expired: '已过期',
    inactive: '停用',
    needs_review: '需检查',
    idea: '想法',
    researching: '调研中',
    draft: '草稿',
    generating: '生成中',
    review: '待审核',
    scheduled: '已排期',
    publishing: '发布中',
    published: '已发布',
    analyzing: '分析中',
    archived: '已归档',
    queued: '排队中',
    pending: '等待中',
    running: '运行中',
    success: '成功',
    failed: '失败',
    paused: '暂停',
    unread: '未读',
    read: '已读',
    sent: '已发送',
    in_app: '站内通知',
    email: 'Email',
    ok: '正常',
    needs_attention: '需关注',
    workflow_failed: 'Workflow失败',
    publish_failed: '发布失败',
    collector_failed: '采集失败',
    agent_failed: 'Agent失败',
    automation_failed: '自动化失败',
    cost_alert: '成本提醒',
    system: '系统',
    content_generator: '内容生成 Agent',
    asset_generator: '素材生成 Agent',
    analysis: '分析 Agent',
    content_generation: '内容生成',
    asset_generation: '素材生成',
    competitor_account: '竞争账号',
    telegram: 'Telegram频道',
    channel: '频道',
    keyword: '关键词',
    hashtag: '标签',
    rss: 'RSS',
    manual: '手动',
    hourly: '每小时',
    daily: '每天',
    weekly: '每周',
    error: '异常',
    collector: 'Collector任务',
    agent: 'Agent任务',
    automation_workflow: 'Workflow任务',
    workflow: 'Workflow',
    platform: '平台任务',
    publish: '发布任务',
    brand: '品牌账号',
    personal: '个人账号',
    competitor: '竞品账号',
    inspiration: '灵感账号',
    image: '图片',
    video: '视频',
    audio: '音频',
    prompt: 'Prompt',
    lora: 'LoRA',
    text: '文本',
    carousel: '轮播图',
    ad: '广告',
    thread: '长帖/Thread',
    short_video: '短视频',
  };

  return labels[status] || status || '—';
}

export function compactNumber(value) {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

export function durationLabel(start, end) {
  if (!start) return '—';
  const startedAt = new Date(start).getTime();
  const endedAt = end ? new Date(end).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
