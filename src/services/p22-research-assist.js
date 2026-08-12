import { supabase } from './supabase-client.js';
import { sha256Hex } from './p19-contracts.js';

export const P22_ASSIST_SCHEMA_VERSION = 'p22_research_assist_v1';
const MAX_MESSAGE = 240;
const SAFE_DETAIL_FIELDS = new Set(['provider', 'stage', 'status', 'run_id', 'run_status', 'reason']);

/** 只保留服务端有界诊断中的白名单字段；令牌、正文、URL 等一律丢弃。 */
function sanitizeDetails(details) {
  const output = {};
  for (const key of SAFE_DETAIL_FIELDS) {
    const value = details?.[key];
    if (key === 'status') {
      if (Number.isInteger(value) && value >= 100 && value <= 599) output.status = value;
      continue;
    }
    if (typeof value === 'string' && value.length > 0 && value.length <= 80) output[key] = value;
  }
  return output;
}

function safeError(code, message, details = {}, status = null) {
  const error = new Error(String(message || '智能研究服务暂时不可用。').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, MAX_MESSAGE));
  error.code = String(code || 'P22_REQUEST_FAILED').slice(0, 80);
  if (details && typeof details === 'object') error.details = sanitizeDetails(details);
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  return error;
}

export function createP22ResearchAssistClient({ client = supabase } = {}) {
  async function invoke(body) {
    if (!client) throw safeError('P22_NOT_CONFIGURED', 'Supabase staging 尚未配置。');
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (sessionError || !token) throw safeError('AUTH_REQUIRED', '请先登录后使用智能研究。');
    const { data, error } = await client.functions.invoke('p22-research-assist', {
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
    if (error) {
      const context = typeof error.context?.json === 'function' ? await error.context.json().catch(() => null) : null;
      const safeStatus = Number.isInteger(context?.status) ? context.status : Number.isInteger(error.context?.status) ? error.context.status : null;
      if (context && typeof context === 'object' && context.code) {
        throw safeError(context.code, context.message, context.details, safeStatus);
      }
      throw safeError('P22_UPSTREAM_UNAVAILABLE', '智能研究服务暂时不可用。', {}, safeStatus);
    }
    if (!data || data.ok !== true || data.schema_version !== P22_ASSIST_SCHEMA_VERSION) {
      throw safeError(data?.code || 'P22_RESPONSE_INVALID', data?.message || '智能研究返回了无效响应。', data?.details);
    }
    return data;
  }
  return Object.freeze({
    status: () => invoke({ action: 'status' }),
    collect: (topic, count = 5) => invoke({ action: 'collect', topic, count }),
    collectUrl: (url) => invoke({ action: 'collect_url', url }),
    analyze: (items) => invoke({ action: 'analyze', items }),
  });
}

export function looksLikePublicUrl(value) {
  const text = String(value || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  return /^(?:www\.)?(?:x\.com|twitter\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|reddit\.com|linkedin\.com)\//i.test(text)
    || /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\//i.test(text);
}

export function isP22Duplicate(project, item) {
  const sourceUrl = String(item?.source_url || '').trim();
  const hash = String(item?.content_sha256 || '').trim();
  return (project?.evidence || []).some((row) => {
    return String(row.source_url || '').trim() === sourceUrl
      && hash
      && String(row.media_metadata?.sha256 || row.provenance?.content_sha256 || '').trim() === hash;
  });
}

export function findP22Evidence(project, item) {
  const sourceUrl = String(item?.source_url || '').trim();
  const hash = String(item?.content_sha256 || '').trim();
  return (project?.evidence || []).find((row) => String(row.source_url || '').trim() === sourceUrl
    && hash
    && String(row.media_metadata?.sha256 || row.provenance?.content_sha256 || '').trim() === hash) || null;
}

export function p22ItemFromEvidence(evidence) {
  const provenance = evidence?.provenance;
  if (provenance?.schema_version !== 'p22_apify_evidence_provenance_v1' || provenance.manual !== false) return null;
  return {
    id: provenance.source_id,
    source_url: evidence.source_url,
    label: evidence.label,
    platform: 'x',
    content_text: evidence.content_text,
    external_id: provenance.external_id ?? null,
    content_sha256: provenance.content_sha256,
    collection_proof: provenance.collection_proof,
    provenance: {
      schema_version: 'p22_collected_source_v1',
      provider: provenance.provider,
      run_id: provenance.run_id,
      collected_at: provenance.collected_at,
      usage_total_usd: provenance.usage_total_usd,
      budget_reservation_id: provenance.budget_reservation_id,
    },
  };
}

function requireText(value, field, max) {
  const text = String(value ?? '');
  if (!text.trim() || text.length > max) throw safeError('P22_EVIDENCE_INVALID', `${field} 缺失或超过长度上限。`);
  return text;
}

export async function toP19EvidenceInput(item) {
  const provenance = item?.provenance || {};
  const contentText = requireText(item?.content_text, '来源正文', 5000);
  const declaredHash = String(item?.content_sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(declaredHash) || await sha256Hex(contentText) !== declaredHash) {
    throw safeError('P22_EVIDENCE_HASH_MISMATCH', '来源正文与 SHA-256 不一致，已拒绝保存。');
  }
  const sourceUrl = requireText(item?.source_url, '来源 URL', 1000);
  const collectedAt = requireText(provenance.collected_at, '采集时间', 80);
  const runId = requireText(provenance.run_id, '采集运行 ID', 200);
  const provider = requireText(provenance.provider, '采集提供方', 120);
  if (provider !== 'apify:xquik/x-tweet-scraper') throw safeError('P22_EVIDENCE_INVALID', '采集提供方不符合 P22 合同。');
  const usageTotalUsd = Number(provenance.usage_total_usd);
  if (!Number.isFinite(usageTotalUsd) || usageTotalUsd < 0 || usageTotalUsd > 10) {
    throw safeError('P22_EVIDENCE_INVALID', '采集费用证据无效。');
  }
  const sourceId = requireText(item?.id, '来源 ID', 160);
  const collectionProof = requireText(item?.collection_proof, '服务端来源证明', 256);
  const externalId = item?.external_id == null ? null : requireText(item.external_id, '平台内容 ID', 160);
  return {
    source_url: sourceUrl,
    label: String(item.label || 'X 公开内容').slice(0, 200),
    platform: 'X · Apify',
    content_text: contentText,
    recorded_at: collectedAt,
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1',
      manual: false,
      method: 'apify_public_collection',
      provider,
      source_platform: 'x',
      source_id: sourceId,
      external_id: externalId,
      source_url: sourceUrl,
      run_id: runId,
      collected_at: collectedAt,
      usage_total_usd: usageTotalUsd,
      budget_reservation_id: requireText(provenance.budget_reservation_id, '预算预留 ID', 80),
      content_sha256: declaredHash,
      collection_proof: collectionProof,
      statement: '该证据由 P22 通过 Apify 从 X 公开来源采集，并由服务端来源证明绑定正文、身份与采集运行。',
    },
    media_metadata: {
      filename: `p22-x-${String(externalId || sourceId).replace(/[^a-z0-9_-]/gi, '_').slice(0, 160)}.txt`,
      mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(contentText).byteLength,
      last_modified: collectedAt,
      sha256: declaredHash,
    },
  };
}
