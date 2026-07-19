function normalizeLines(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function createMarketingDraft(input) {
  const topic = input.topic || '未命名营销主题';
  const audience = input.audience || '目标受众';
  const platform = input.platform || 'X';
  const goal = input.goal || '提升互动与转化';
  const tone = input.tone || '专业、清晰、有行动号召';
  const points = normalizeLines(input.keyPoints);

  const body = [
    `目标：${goal}`,
    `受众：${audience}`,
    `平台：${platform}`,
    '',
    `开头：如果你正在关注「${topic}」，这条内容可以帮你更快判断下一步。`,
    '',
    points.length
      ? `核心要点：\n${points.map((point, index) => `${index + 1}. ${point}`).join('\n')}`
      : '核心要点：先明确问题，再给出方法，最后用一个简单行动引导用户互动。',
    '',
    `语气：${tone}`,
    '',
    '行动号召：如果你想要完整方案，可以保存这条内容，或者继续查看下一条拆解。',
  ].join('\n');

  return {
    title: `${topic}｜${platform} 营销草稿`,
    content_text: body,
    media_url: '',
    content_type: input.contentType || 'text',
    platform,
    account_category: input.accountCategory || 'brand',
    status: 'draft',
  };
}

export async function generateText() {
  throw new Error('Text generation adapter is reserved for GPT, Claude, Qwen, and n8n integration.');
}

export async function generateImage() {
  throw new Error('Image generation adapter is reserved for Qwen, ComfyUI, and n8n integration.');
}

export async function generateVideo() {
  throw new Error('Video generation adapter is reserved for Qwen, ComfyUI, and n8n integration.');
}
