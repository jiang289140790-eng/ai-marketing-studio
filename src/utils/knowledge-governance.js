const TEST_PATTERN = /(?:^|[\s:_-])(phase\s*[2789]|debug|test(?:ing)?|marker|fixture|mock|smoke)(?:$|[\s:_-])/i;
const TECHNICAL_PATTERN = /(asset\s+(image|video)|generation\s+job|agent\s+(run|log)|workflow\s+output|api\s+response|storage[_\s/:-]*path|signed[_\s-]*url)/i;
const URL_ONLY_PATTERN = /^\s*(https?:\/\/|storage:\/\/|\/storage\/)\S+\s*$/i;

export const KNOWLEDGE_CATEGORIES = [
  { id: 'account', label: '账号知识' },
  { id: 'content', label: '内容知识' },
  { id: 'strategy', label: '策略知识' },
  { id: 'platform', label: '平台知识' },
  { id: 'character', label: '角色知识' },
  { id: 'workflow', label: '工作流知识' },
  { id: 'system', label: '系统知识' },
];

export const KNOWLEDGE_STATUS_LABELS = {
  verified: '已验证',
  preliminary: '初步信号',
  pending: '待验证',
  expired: '过期',
  test: '测试',
  deprecated: '已废弃',
};

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function listValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function textValue(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== '');
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => textValue(item)).filter(Boolean).join('；');
  if (typeof value === 'object') return textValue(value.summary, value.conclusion, value.text, value.description);
  return String(value);
}

function normalizedText(value) {
  return textValue(value).toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function isTestKnowledge(item = {}) {
  const metadata = objectValue(item.metadata);
  const values = [
    item.type,
    item.title,
    item.content,
    metadata.source,
    metadata.source_type,
    metadata.environment,
    metadata.run_type,
    metadata.marker,
  ].filter(Boolean).join(' ');
  return metadata.is_test === true
    || metadata.test === true
    || ['test', 'testing', 'debug'].includes(String(metadata.environment || '').toLowerCase())
    || TEST_PATTERN.test(` ${values} `);
}

export function isTechnicalKnowledge(item = {}) {
  const metadata = objectValue(item.metadata);
  const type = normalizedText(item.type);
  const title = textValue(item.title);
  const content = textValue(item.content);
  if (['asset', 'asset_image', 'asset_video', 'generation_job', 'agent_run', 'workflow_output'].includes(type)) return true;
  if (TECHNICAL_PATTERN.test(`${title} ${type}`)) return true;
  if (URL_ONLY_PATTERN.test(content)) return true;
  if (
    metadata.asset_id
    || metadata.generation_job_id
    || metadata.workflow_output
    || metadata.api_response
    || metadata.storage_path
    || metadata.signed_url
  ) return true;
  return false;
}

export function getKnowledgeCategory(item = {}) {
  const metadata = objectValue(item.metadata);
  const tags = listValue(metadata.tags || item.tags).map(normalizedText);
  const type = normalizedText(item.type || metadata.type || metadata.category);
  const text = `${type} ${normalizedText(item.title)} ${tags.join(' ')}`;
  if (/account|账号|profile|persona/.test(text)) return 'account';
  if (/character|角色|lora/.test(text)) return 'character';
  if (/workflow|provider|model|comfy/.test(text)) return 'workflow';
  if (/strategy|策略|campaign/.test(text)) return 'strategy';
  if (/platform|x-api|x api|telegram|instagram|tiktok|youtube|market-research/.test(text)) return 'platform';
  if (/system|security|error|configuration|系统/.test(text)) return 'system';
  return 'content';
}

export function getKnowledgeSource(item = {}) {
  const metadata = objectValue(item.metadata);
  const raw = textValue(item.source, item.source_type, metadata.source, metadata.source_type, metadata.origin);
  const normalized = normalizedText(raw);
  if (/human|manual|user_feedback|approved/.test(normalized)) {
    return { id: 'human_approved', label: '人工批准结论', evidenceType: '人工判断', direct: true };
  }
  if (/x_api|x api|x_mcp|native_x|public_x_search|twitter/.test(normalized)) {
    return { id: 'x_native', label: 'X 原生或公开数据', evidenceType: '平台数据', direct: true };
  }
  if (/research|web_search|external|search/.test(normalized)) {
    return { id: 'external_inference', label: '外部搜索推断', evidenceType: '外部推断', direct: false };
  }
  if (/agent|analysis|model|ai/.test(normalized)) {
    return { id: 'ai_analysis', label: 'AI 分析', evidenceType: '模型推断', direct: false };
  }
  if (/system|workflow/.test(normalized)) {
    return { id: 'system', label: '系统记录', evidenceType: '系统数据', direct: true };
  }
  return { id: 'unknown', label: raw || '来源未标注', evidenceType: '待确认', direct: false };
}

export function getKnowledgeStatus(item = {}, now = new Date()) {
  const metadata = objectValue(item.metadata);
  if (isTestKnowledge(item)) return 'test';
  const explicit = normalizedText(metadata.knowledge_status || metadata.status || item.status);
  if (['verified', 'validated', 'approved'].includes(explicit) || metadata.human_approved === true) return 'verified';
  if (['preliminary', 'signal', 'initial_signal'].includes(explicit)) return 'preliminary';
  if (['expired', 'stale'].includes(explicit)) return 'expired';
  if (['deprecated', 'archived', 'abandoned'].includes(explicit)) return 'deprecated';
  const expiresAt = metadata.expires_at || metadata.expiry_at;
  if (expiresAt && new Date(expiresAt) < now) return 'expired';
  const confidence = normalizeConfidence(metadata.confidence ?? item.confidence);
  return confidence != null && confidence >= 70 ? 'preliminary' : 'pending';
}

export function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round((number <= 1 ? number * 100 : number) * 10) / 10;
}

export function normalizeKnowledge(item = {}) {
  const metadata = objectValue(item.metadata);
  const source = getKnowledgeSource(item);
  const conclusion = textValue(
    metadata.conclusion,
    metadata.summary,
    item.content,
    item.insight_text,
    item.lessons_learned,
    item.description,
  );
  const title = textValue(item.title)
    || `${KNOWLEDGE_CATEGORIES.find((entry) => entry.id === getKnowledgeCategory(item))?.label || '知识'} · ${conclusion.slice(0, 28) || '未命名结论'}`;
  const platforms = listValue(metadata.platforms || metadata.platform || item.platform);
  const accounts = listValue(metadata.account_names || metadata.accounts || metadata.account || item.account_name || item.account_id);
  const campaigns = listValue(metadata.campaign_names || metadata.campaigns || metadata.campaign_name || metadata.campaign_id || item.campaign_id);
  const sampleCount = Number(metadata.sample_count ?? metadata.samples ?? metadata.evidence_count ?? 0);

  return {
    id: item.id,
    title,
    conclusion,
    category: getKnowledgeCategory(item),
    source,
    status: getKnowledgeStatus(item),
    confidence: normalizeConfidence(metadata.confidence ?? item.confidence),
    sampleCount: Number.isFinite(sampleCount) ? sampleCount : 0,
    platforms,
    accounts,
    campaigns,
    campaign_id: metadata.campaign_id || item.campaign_id || null,
    account_id: metadata.account_id || item.account_id || null,
    tags: listValue(metadata.tags || item.tags),
    sourceRef: textValue(metadata.source_ref, metadata.source_id, item.source_ref, item.source_id),
    contentHash: textValue(metadata.content_hash, item.content_hash),
    evidence: metadata.evidence || metadata.examples || metadata.sources || [],
    relatedObjects: metadata.related_objects || metadata.relations || {},
    lastValidatedAt: metadata.last_validated_at || metadata.verified_at || null,
    lastUsedAt: metadata.last_used_at || null,
    expiresAt: metadata.expires_at || null,
    createdAt: item.created_at,
    updatedAt: item.updated_at || item.created_at,
    excludedFromMain: isTechnicalKnowledge(item) || isTestKnowledge(item),
    exclusionReason: isTechnicalKnowledge(item) ? '技术或素材记录' : isTestKnowledge(item) ? '测试记录' : '',
    metadata,
    raw: item,
  };
}

export function findKnowledgeDuplicates(items = []) {
  const groups = new Map();
  const add = (key, item) => {
    if (!key) return;
    const values = groups.get(key) || [];
    values.push(item.id);
    groups.set(key, values);
  };

  items.forEach((item) => {
    add(`title:${normalizedText(item.title)}`, item);
    add(item.sourceRef ? `source:${normalizedText(item.sourceRef)}` : '', item);
    add(item.contentHash ? `hash:${item.contentHash}` : '', item);
    add(item.conclusion && item.source.id ? `conclusion:${normalizedText(item.conclusion)}:${item.source.id}` : '', item);
  });

  const duplicateIds = new Map();
  [...groups.values()].filter((ids) => ids.length > 1).forEach((ids) => {
    ids.forEach((id) => duplicateIds.set(id, [...new Set([...(duplicateIds.get(id) || []), ...ids.filter((other) => other !== id)])]));
  });
  return duplicateIds;
}

export function summarizeKnowledge(items = []) {
  return {
    verified: items.filter((item) => item.status === 'verified').length,
    pending: items.filter((item) => ['preliminary', 'pending'].includes(item.status)).length,
    expiring: items.filter((item) => {
      if (item.status === 'expired') return true;
      if (!item.expiresAt) return false;
      const days = (new Date(item.expiresAt).getTime() - Date.now()) / 86400000;
      return days >= 0 && days <= 30;
    }).length,
    test: items.filter((item) => item.status === 'test').length,
  };
}

export function sanitizeAdvancedKnowledgeData(value) {
  if (Array.isArray(value)) return value.map(sanitizeAdvancedKnowledgeData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (/(secret|token|authorization|api[_-]?key|password|signed[_-]?url)/i.test(key)) {
        return [key, '已隐藏'];
      }
      return [key, sanitizeAdvancedKnowledgeData(entry)];
    }),
  );
}
