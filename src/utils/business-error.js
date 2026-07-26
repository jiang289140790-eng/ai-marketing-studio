const RAW_BACKEND_PATTERNS = [
  /postgrest/i,
  /schema cache/i,
  /relationship between/i,
  /foreign key/i,
  /constraint/i,
  /\bselect\b.+\bfrom\b/is,
  /\binsert\b.+\binto\b/is,
  /\bupdate\b.+\bset\b/is,
  /stack trace/i,
];

export function normalizeBusinessError(error, overrides = {}) {
  const raw = error instanceof Error ? error.message : String(error || '');
  const sourceCode = String(error?.code || '').trim();
  const category = classifyError(raw, sourceCode);
  const defaults = ERROR_DEFAULTS[category];

  return {
    title: overrides.title || defaults.title,
    message: overrides.message || defaults.message,
    impact: overrides.impact || defaults.impact,
    recommendation: overrides.recommendation || defaults.recommendation,
    code: overrides.code || buildErrorCode(category, sourceCode),
    retryable: overrides.retryable ?? defaults.retryable,
    technicalDetail: sanitizeTechnicalError(raw),
  };
}

export function safeErrorMessage(error, overrides = {}) {
  return normalizeBusinessError(error, overrides).message;
}

export function sanitizeTechnicalError(value) {
  return String(value || '未提供技术详情')
    .replace(/(token|secret|password|authorization|apikey|api_key)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(?::\d+)?[^\s]*/gi, '[内部地址已隐藏]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[敏感标识已隐藏]')
    .slice(0, 800);
}

export function containsRawBackendDetail(value) {
  const text = String(value || '');
  return RAW_BACKEND_PATTERNS.some((pattern) => pattern.test(text));
}

function classifyError(message, code) {
  const value = `${code} ${message}`.toLowerCase();
  if (/401|403|jwt|permission|not authorized|row-level security|rls/.test(value)) return 'permission';
  if (/relationship|schema cache|foreign key|pgrst|postgrest/.test(value)) return 'data_relation';
  if (/timeout|network|failed to fetch|connection|offline/.test(value)) return 'network';
  if (/not found|404|no rows/.test(value)) return 'not_found';
  if (/required|invalid|null value|violates/.test(value)) return 'validation';
  return 'unknown';
}

function buildErrorCode(category, sourceCode) {
  const suffix = sourceCode ? sourceCode.replace(/[^a-z0-9_-]/gi, '').slice(0, 16).toUpperCase() : '001';
  return `AMS-${ERROR_CODES[category]}-${suffix}`;
}

const ERROR_CODES = {
  permission: 'AUTH',
  data_relation: 'DATA',
  network: 'NET',
  not_found: 'MISS',
  validation: 'INPUT',
  unknown: 'UNEXPECTED',
};

const ERROR_DEFAULTS = {
  permission: {
    title: '当前账号暂时无法读取这部分数据',
    message: '数据访问权限未满足，请重新登录后再试。',
    impact: '本次操作未完成，现有数据不会被修改。',
    recommendation: '刷新登录状态；如果仍失败，请到系统状态查看权限检查。',
    retryable: true,
  },
  data_relation: {
    title: '数据关联暂时不可用',
    message: '相关业务数据暂时无法组合展示。',
    impact: '当前页面可能缺少部分数据，但不会影响已保存内容。',
    recommendation: '稍后重试；如持续出现，请在系统状态中查看错误编号。',
    retryable: true,
  },
  network: {
    title: '服务连接暂时不稳定',
    message: '当前请求未能连接到数据服务。',
    impact: '本次操作未完成，现有数据不会被修改。',
    recommendation: '检查网络后重试。',
    retryable: true,
  },
  not_found: {
    title: '没有找到对应数据',
    message: '当前范围内没有可处理的记录。',
    impact: '页面无法继续当前操作。',
    recommendation: '检查当前运营活动和数据范围后重试。',
    retryable: false,
  },
  validation: {
    title: '提交内容不完整',
    message: '请补齐必填信息后再试。',
    impact: '本次内容尚未保存。',
    recommendation: '检查页面标记的必填项。',
    retryable: true,
  },
  unknown: {
    title: '操作暂时未完成',
    message: '系统未能完成本次操作。',
    impact: '本次操作未完成，现有数据不会被修改。',
    recommendation: '可以重试一次；如仍失败，请记录错误编号并查看系统状态。',
    retryable: true,
  },
};
