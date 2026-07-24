import { generateAI } from './ai-gateway-service';

const OUTPUT_SCHEMAS = {
  rewrite_copy: {
    title: '',
    hook: '',
    body: '',
    cta: '',
    hashtags: [],
    keywords: [],
    tone: '',
    platform_notes: '',
  },
  generate_hook: {
    title: '',
    hook: '',
    body: '',
    cta: '',
    hashtags: [],
    keywords: [],
    tone: '',
    platform_notes: '',
  },
  generate_image_prompt: {
    subject: '',
    character: '',
    scene: '',
    clothing: '',
    expression: '',
    composition: '',
    lighting: '',
    color_palette: '',
    style: '',
    aspect_ratio: '',
    positive_prompt: '',
    negative_prompt: '',
    lora: '',
    lora_weight: 0.8,
  },
  generate_video_script: {
    video_type: '',
    duration: '',
    aspect_ratio: '',
    hook_3s: '',
    script: '',
    shots: [],
    camera_movement: '',
    character_action: '',
    scene_change: '',
    first_frame: '',
    last_frame: '',
    subtitle_style: '',
    bgm_style: '',
    negative_prompt: '',
  },
  generate_lora_prompt: {
    character_description: '',
    visual_identity: '',
    face_features: '',
    body_features: '',
    clothing_style: '',
    style_keywords: [],
    lora_prompt: '',
    lora_negative_prompt: '',
    recommended_weight: 0.8,
  },
  generate_strategy: {
    strategy_name: '',
    objective: '',
    audience: '',
    positioning: '',
    content_pillars: [],
    hook_rules: [],
    cta_rules: [],
    visual_rules: [],
    execution_steps: [],
    success_metrics: [],
  },
  viral_analysis_prompt: promptTemplateSchema('viral_analysis'),
  x_copy_prompt: promptTemplateSchema('caption'),
  image_prompt_template: promptTemplateSchema('image'),
  video_script_prompt: promptTemplateSchema('video'),
  lora_character_prompt: promptTemplateSchema('character'),
  account_persona_prompt: promptTemplateSchema('account_persona'),
};

function promptTemplateSchema(category) {
  return {
    title: '',
    category,
    content: '',
    platform: '',
    character: null,
    usage_notes: '',
  };
}

function compact(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
  }
  return value;
}

export function buildContentContext({
  contentPackage,
  campaign,
  strategy,
  account,
  accountProfile,
  character,
  lora,
  assets,
  viralContent,
  contentAnalysis,
  promptTemplate,
} = {}) {
  const item = contentPackage || {};
  return {
    content_title: item.title || '',
    platform: item.platform || account?.platform || '',
    campaign_goal: campaign?.goal || campaign?.objective || '',
    target_account: compact(account),
    account_profile: compact(accountProfile || account?.account_profiles?.[0] || account?.account_profile),
    content_strategy: compact(strategy),
    character: compact(character),
    lora: compact(lora || character?.lora_info || character?.lora),
    reference_assets: compact(assets || []),
    reference_viral_content: compact(viralContent),
    current_copy: {
      title: item.title || '',
      hook: item.hook || '',
      body: item.body || item.content_text || '',
      cta: item.cta || '',
      hashtags: item.tags || item.hashtags || [],
    },
    image_requirements: compact(item.imageRequirements || item.image_requirements || item.visual_brief || {}),
    video_requirements: compact(item.videoRequirements || item.video_requirements || {}),
    brand_rules: compact(
      promptTemplate?.brand_rules
      || strategy?.brand_rules
      || accountProfile?.brand_rules
      || account?.brand_rules
      || [],
    ),
    negative_rules: compact(
      character?.forbidden_styles
      || promptTemplate?.negative_rules
      || strategy?.negative_rules
      || [],
    ),
    content_analysis: compact(contentAnalysis),
    prompt_template: compact(promptTemplate),
  };
}

export function buildContextPrompt(mode, context, userInstruction = '') {
  const schema = OUTPUT_SCHEMAS[mode] || OUTPUT_SCHEMAS.rewrite_copy;
  const isTemplate = mode.endsWith('_prompt') || mode.endsWith('_template');
  return [
    '你是 AI Marketing Studio 的 Context AI。你必须基于给定业务上下文工作，不能虚构未提供的品牌事实、人物身份或授权信息。',
    `任务模式：${mode}`,
    userInstruction ? `用户补充要求：${userInstruction}` : '用户补充要求：无',
    isTemplate
      ? '请生成一个可重复使用的 Prompt 模板。模板中可以使用 {{变量名}}，并明确输入、限制与输出格式。'
      : '请生成可直接写回当前内容包的结果。',
    '只返回一个合法 JSON 对象，不要使用 Markdown 代码块，不要添加 JSON 之外的解释。',
    `输出 JSON 结构（保留全部字段）：${JSON.stringify(schema, null, 2)}`,
    `业务上下文：${JSON.stringify(context || {}, null, 2)}`,
  ].join('\n\n');
}

export async function generateContextAI({
  mode,
  context,
  userInstruction,
  model = 'qwen-plus',
}) {
  const provider = inferProvider(model);
  const gateway = await generateAI({
    agent_name: 'Context AI',
    prompt: buildContextPrompt(mode, context, userInstruction),
    model,
    provider,
    parameters: {
      temperature: mode === 'rewrite_copy' || mode === 'generate_hook' ? 0.72 : 0.45,
      max_output_tokens: 2200,
      response_format: { type: 'json_object' },
    },
    usage_type: mode.includes('analysis') ? 'analysis' : 'text_generation',
  });

  return {
    ...gateway,
    result: parseContextAIResult(gateway.content),
  };
}

export function parseContextAIResult(content) {
  if (content && typeof content === 'object') return content;
  const text = String(content || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text.slice(Math.max(0, text.indexOf('{')), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return { content: text };
  }
}

export function contextResultToPrompt(result, fallback = {}) {
  const content = result?.content || result?.positive_prompt || result?.script || JSON.stringify(result || {}, null, 2);
  return {
    title: result?.title || fallback.title || 'AI 生成 Prompt',
    category: result?.category || fallback.category || 'general',
    content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    platform: result?.platform || fallback.platform || null,
    character: result?.character || fallback.character || null,
  };
}

function inferProvider(model) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('qwen') || normalized.includes('dashscope') || normalized.includes('aliyun') || normalized.includes('bailian')) return 'qwen';
  if (normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('claude') || normalized.includes('anthropic')) return 'anthropic';
  return 'openai';
}

