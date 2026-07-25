const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export const PROMPT_VARIABLE_DEFINITIONS = {
  character_trigger: { label: '角色触发词', example: 'emma_s1' },
  platform: { label: '发布平台', example: 'X' },
  content_goal: { label: '内容目标', example: '提高角色认知与互动' },
  hook_type: { label: '开头类型', example: '反差式提问' },
  visual_direction: { label: '视觉方向', example: '夜间城市生活方式摄影' },
  outfit: { label: '服装', example: '黑色简约夹克' },
  location: { label: '场景', example: '雨后霓虹街道' },
  camera: { label: '镜头', example: '35mm 中近景，浅景深' },
  cta: { label: '行动引导', example: '你更喜欢哪一种氛围？' },
};

export function extractPromptVariables(content = '') {
  const variables = [];
  const seen = new Set();
  for (const match of String(content).matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    variables.push({
      name,
      label: PROMPT_VARIABLE_DEFINITIONS[name]?.label || name,
      example: PROMPT_VARIABLE_DEFINITIONS[name]?.example || `示例 ${name}`,
    });
  }
  return variables;
}

export function renderPromptTemplate(content = '', values = {}) {
  return String(content).replace(VARIABLE_PATTERN, (_match, name) => (
    values[name] || PROMPT_VARIABLE_DEFINITIONS[name]?.example || `〔${name}〕`
  ));
}

export function promptTemplateVersion(prompt = {}) {
  return Number(prompt.templateMeta?.version || prompt.version || 1);
}

export function promptTemplateStatus(prompt = {}) {
  return prompt.templateMeta?.status || prompt.status || 'active';
}

export function calculatePromptSuccessRate(runs = []) {
  if (!runs.length) return null;
  const successful = runs.filter((run) => ['success', 'completed'].includes(String(run.status).toLowerCase())).length;
  return Math.round((successful / runs.length) * 100);
}

export function getPromptCategoryLabel(value) {
  return {
    caption: '文案',
    copy: '文案',
    image: '图片',
    video: '视频',
    viral_analysis: '分析',
    analysis: '分析',
    workflow: '工作流',
    system: '系统',
    general: '系统',
  }[value] || value || '系统';
}

