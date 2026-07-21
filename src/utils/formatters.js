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
    needs_review: '需要检查',
    error: '异常',
    pending: '等待中',
    running: '运行中',
    success: '成功',
    failed: '失败',
    owned: '自有账号',
    brand: '品牌账号',
    personal: '个人账号',
    competitor: '竞品账号',
    inspiration: '灵感账号',
    image: '图片',
    video: '视频',
    audio: '音频',
    prompt: 'Prompt',
    workflow: 'Workflow',
    lora: 'LoRA',
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
