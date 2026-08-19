// G1 Edge Function 核心（generation-core.mjs）纯单元测试：
// 请求信封校验、有界字段、approval 构造、边界错误映射、角色阶梯。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_ALLOWLIST,
  BOUNDED_STATUS,
  G1_EDGE_SCHEMA_VERSION,
  buildBoundaryApproval,
  buildBoundaryRequest,
  deriveUserIdFromClaims,
  hasRequiredRole,
  mapBoundaryError,
  parseEdgeRequest,
} from '../supabase/functions/g1-generation-command/generation-core.mjs';

const PROJECT = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
const BRIEF = 'brief-111111111111111111111111';

function envelope(action, payload = {}) {
  return { schema_version: G1_EDGE_SCHEMA_VERSION, action, ...payload };
}

test('动作清单与角色阶梯：quote/status 只读 viewer；approve_submit 需要 operator', () => {
  assert.equal(ACTION_ALLOWLIST.quote.role, 'viewer');
  assert.equal(ACTION_ALLOWLIST.status.role, 'viewer');
  assert.equal(ACTION_ALLOWLIST.artifact.role, 'viewer');
  assert.equal(ACTION_ALLOWLIST.approve_submit.role, 'operator');
  assert.equal(hasRequiredRole('viewer', 'viewer'), true);
  assert.equal(hasRequiredRole('viewer', 'operator'), false);
  assert.equal(hasRequiredRole('operator', 'operator'), true);
  assert.equal(hasRequiredRole('admin', 'operator'), true);
  assert.equal(hasRequiredRole('hacker', 'viewer'), false);
});

test('身份只从已验证 claims 的 subject 派生；无效输入拒绝', () => {
  assert.equal(deriveUserIdFromClaims({ sub: 'user-1' }), 'user-1');
  assert.throws(() => deriveUserIdFromClaims({}), (error) => error?.code === 'INVALID_SUBJECT');
  assert.throws(() => deriveUserIdFromClaims({ sub: 'x'.repeat(201) }), (error) => error?.code === 'INVALID_SUBJECT');
});

test('quote 信封：合法请求通过；未知动作/字段/有界越界全部 fail closed', () => {
  const valid = envelope('quote', {
    project_id: PROJECT,
    brief_id: BRIEF,
    mode: 'image',
    prompt: '一只猫',
    aspect_ratio: '1:1',
  });
  const parsed = parseEdgeRequest(valid);
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.action, 'quote');

  assert.equal(parseEdgeRequest({ schema_version: G1_EDGE_SCHEMA_VERSION, action: 'delete' }).code, 'UNKNOWN_ACTION');
  assert.equal(parseEdgeRequest({ schema_version: 'other', action: 'quote' }).code, 'SCHEMA_VERSION_MISMATCH');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, sql: 'select 1' })).code, 'UNKNOWN_FIELDS');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: 'prj-bad', brief_id: BRIEF, mode: 'image', prompt: '猫' })).code, 'PROJECT_ID_INVALID');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'video_9d', prompt: '猫' })).code, 'MODE_INVALID');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: 'x'.repeat(2001) })).code, 'PROMPT_BOUNDS');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫', aspect_ratio: '99:1' })).code, 'ASPECT_RATIO_INVALID');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'video_t2v', prompt: '猫', duration_seconds: 11 })).code, 'DURATION_BOUNDS');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'video_t2v', prompt: '猫', resolution: '8k' })).code, 'RESOLUTION_INVALID');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'video_i2v', prompt: '猫', reference_asset_id: 'not-a-uuid' })).code, 'REFERENCE_ASSET_INVALID');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫', knowledge_card_ids: ['kc-zz'] })).code, 'KNOWLEDGE_CARD_IDS_INVALID');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫', evidence_ids: ['ev-zz'] })).code, 'EVIDENCE_IDS_INVALID');
  // 知识卡身份兼容 kc- 与 card- 两种既有生成约定。
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫', knowledge_card_ids: ['card-111111111111111111111111'] })).ok, true);
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫', knowledge_card_ids: ['kc-111111111111111111111111'] })).ok, true);
});

test('有界字符串 fail closed：超限输入绝不在校验前被截断（先截断后校验 = 溢出漏洞）', () => {
  // prompt 2001 字符必须拒绝（截断到 2000 会隐藏溢出）。
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: 'x'.repeat(2001) })).code, 'PROMPT_BOUNDS');
  // 2000 字符合法边界内通过。
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: 'x'.repeat(2000) })).ok, true);
  // negative_prompt 501 字符必须拒绝（原始长度，截断会隐藏溢出）。
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫', negative_prompt: 'x'.repeat(501) })).code, 'NEGATIVE_PROMPT_BOUNDS');
  // 恰好 500 字符边界内通过。
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫', negative_prompt: 'x'.repeat(500) })).ok, true);
  // 超长 project_id / brief_id / reference_asset_id：截断成合法前缀的漏洞必须关闭。
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: `prj-${'a'.repeat(24)}${'b'.repeat(41)}`, brief_id: BRIEF, mode: 'image', prompt: '猫' })).code, 'PROJECT_ID_INVALID');
  assert.equal(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: `brief-${'1'.repeat(24)}${'2'.repeat(41)}`, mode: 'image', prompt: '猫' })).code, 'BRIEF_ID_INVALID');
  assert.equal(parseEdgeRequest(envelope('quote', {
    project_id: PROJECT, brief_id: BRIEF, mode: 'video_i2v', prompt: '猫',
    reference_asset_id: `00000000-0000-4000-8000-000000000000${'a'.repeat(29)}`,
  })).code, 'REFERENCE_ASSET_INVALID');
});

test('approve_submit 信封：幂等键强制；approval 字段有界', () => {
  const base = {
    project_id: PROJECT,
    brief_id: BRIEF,
    mode: 'image',
    prompt: '猫',
    quote_id: `g1q-${'a'.repeat(24)}`,
    quote_fingerprint: 'f'.repeat(64),
    request_fingerprint: 'a'.repeat(64),
    estimated_max_cost_cny: 0.3,
    expires_at: '2026-08-16T00:30:00.000Z',
    source: 'browser',
    expected_revision: 1,
  };
  const parsed = parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k1' }));
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.idempotency_key, 'k1');
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base })).code, 'IDEMPOTENCY_KEY_INVALID', '缺少幂等键必须拒绝');
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k'.repeat(201) })).code, 'IDEMPOTENCY_KEY_INVALID');
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k1', quote_fingerprint: 'zz' })).code, 'QUOTE_FINGERPRINT_INVALID');
  // 指纹必须是精确 64 位小写十六进制：非十六进制字符 / 大写 / 长度错误全部拒绝
  // （'r' 不是十六进制字符，与请求指纹夹具的合法值严格区分）。
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k1', request_fingerprint: 'r'.repeat(64) })).code, 'REQUEST_FINGERPRINT_INVALID');
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k1', quote_fingerprint: 'A'.repeat(64) })).code, 'QUOTE_FINGERPRINT_INVALID');
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k1', quote_fingerprint: 'a'.repeat(63) })).code, 'QUOTE_FINGERPRINT_INVALID');
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k1', request_fingerprint: 'a'.repeat(65) })).code, 'REQUEST_FINGERPRINT_INVALID');
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k1', estimated_max_cost_cny: -1 })).code, 'ESTIMATED_MAX_COST_INVALID');
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k1', expires_at: 'garbage' })).code, 'APPROVAL_EXPIRY_INVALID');
  assert.equal(parseEdgeRequest(envelope('approve_submit', { ...base, idempotency_key: 'k1', expected_revision: 0 })).code, 'EXPECTED_REVISION_INVALID');
  // 只读动作可携带幂等键信封字段（Harness 边界统一携带；非提交动作忽略）。
  assert.equal(parseEdgeRequest(envelope('status', { project_id: PROJECT, job_id: `g1j-${'a'.repeat(24)}`, idempotency_key: 'k-ignored' })).ok, true);
  assert.equal(parseEdgeRequest(envelope('status', { project_id: PROJECT, job_id: 'g1x-zz' })).code, 'JOB_ID_INVALID');
  assert.equal(parseEdgeRequest(envelope('artifact', { project_id: PROJECT, job_id: `g1j-${'a'.repeat(24)}`, artifact_id: `g1x-${'a'.repeat(24)}` })).ok, true);
  assert.equal(parseEdgeRequest(envelope('artifact', { project_id: PROJECT, job_id: `g1j-${'a'.repeat(24)}`, artifact_id: 'zz' })).code, 'ARTIFACT_ID_INVALID');
  assert.equal(parseEdgeRequest(envelope('list', { project_id: PROJECT, limit: 99 })).code, 'LIMIT_INVALID');
});

test('边界请求/批准构造：只含 SQL 边界认识的字段', () => {
  const parsed = parseEdgeRequest(envelope('quote', {
    project_id: PROJECT,
    brief_id: BRIEF,
    mode: 'video_i2v',
    prompt: '参考图动画',
    negative_prompt: '模糊',
    duration_seconds: 5,
    resolution: '720p',
    reference_asset_id: '00000000-0000-4000-8000-000000000000',
    knowledge_card_ids: ['kc-111111111111111111111111'],
    evidence_ids: ['ev-111111111111111111111111'],
  }));
  const request = buildBoundaryRequest(parsed);
  assert.equal(request.schema_version, 'g1_generation_request_v1');
  assert.deepEqual(Object.keys(request).sort(), [
    'aspect_ratio', 'brief_id', 'duration_seconds', 'evidence_ids', 'knowledge_card_ids',
    'mode', 'negative_prompt', 'project_id', 'prompt', 'reference_asset_id', 'resolution',
    'schema_version',
  ].sort());
  // 缺省绑定（知识卡/证据）不发送 → SQL 从 Brief 精确引用集合派生。
  const minimal = parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫' }));
  const minimalRequest = buildBoundaryRequest(minimal);
  assert.equal(Object.hasOwn(minimalRequest, 'knowledge_card_ids'), false);
  assert.equal(Object.hasOwn(minimalRequest, 'evidence_ids'), false);

  const submit = parseEdgeRequest(envelope('approve_submit', {
    project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫',
    quote_id: `g1q-${'a'.repeat(24)}`, quote_fingerprint: 'f'.repeat(64),
    request_fingerprint: 'a'.repeat(64), estimated_max_cost_cny: 0.3,
    expires_at: '2026-08-16T00:30:00.000Z', source: 'harness', expected_revision: 2,
    idempotency_key: 'h-key',
  }));
  const approval = buildBoundaryApproval(submit);
  assert.equal(approval.quote_id, `g1q-${'a'.repeat(24)}`);
  assert.equal(approval.quote_fingerprint, 'f'.repeat(64));
  assert.equal(approval.request_fingerprint, 'a'.repeat(64));
  assert.equal(approval.estimated_max_cost_cny, 0.3);
  assert.equal(approval.source, 'harness');
  assert.equal(approval.expires_at, '2026-08-16T00:30:00.000Z');
});

test('buildBoundaryRequest 画幅契约：显式 aspect_ratio 精确保留（恰好一次）；缺省按 mode 派生', () => {
  // 显式提供 9:16（视频允许）→ 原样保留、恰好一次。
  const explicit = parseEdgeRequest(envelope('quote', {
    project_id: PROJECT, brief_id: BRIEF, mode: 'video_t2v', prompt: '猫', aspect_ratio: '9:16',
  }));
  const explicitRequest = buildBoundaryRequest(explicit);
  const aspectKeys = Object.keys(explicitRequest).filter((key) => key === 'aspect_ratio');
  assert.equal(aspectKeys.length, 1, 'aspect_ratio 必须恰好出现一次');
  assert.equal(explicitRequest.aspect_ratio, '9:16', '显式画幅必须精确保留');
  // 缺省派生与 SQL 边界一致：image → 1:1，video → 16:9。
  const image = buildBoundaryRequest(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'image', prompt: '猫' })));
  assert.equal(image.aspect_ratio, '1:1');
  const video = buildBoundaryRequest(parseEdgeRequest(envelope('quote', { project_id: PROJECT, brief_id: BRIEF, mode: 'video_i2v', prompt: '猫' })));
  assert.equal(video.aspect_ratio, '16:9');
});

test('边界错误映射：409 类冲突绝不降级为 INTERNAL_ERROR', () => {
  assert.equal(BOUNDED_STATUS.G1_QUOTE_STALE, 409);
  assert.equal(BOUNDED_STATUS.G1_QUOTE_EXPIRED, 409);
  assert.equal(BOUNDED_STATUS.G1_PROJECT_REVISION_STALE, 409);
  assert.equal(BOUNDED_STATUS.G1_IDEMPOTENCY_CONFLICT, 409);
  assert.equal(BOUNDED_STATUS.G1_APPROVAL_MISMATCH, 409);
  const mapped = mapBoundaryError(Object.assign(new Error('api.g1_approve_submit: G1_QUOTE_STALE'), { message: 'G1_QUOTE_STALE' }));
  assert.equal(mapped.code, 'G1_QUOTE_STALE', '完整 G1_ 前缀必须保留（绝不剥离）');
  // 代码嵌在更长消息中、多处出现取最后一次；前缀与 409 映射必须完整。
  const embedded = mapBoundaryError(new Error('api.g1_approve_submit raised G1_APPROVAL_MISMATCH after G1_QUOTE_STALE'));
  assert.equal(embedded.code, 'G1_QUOTE_STALE');
  assert.equal(BOUNDED_STATUS[embedded.code], 409, '保留前缀后必须命中 409 映射');
  assert.equal(BOUNDED_STATUS[mapBoundaryError(new Error('api.g1_get_job: G1_JOB_NOT_FOUND')).code], undefined, '非 409 类代码不误映射');
  assert.equal(mapBoundaryError(new Error('random failure')).code, undefined, '非边界错误原样透传');
  assert.equal(mapBoundaryError(new Error('api.g1_quote_request: G1_MODEL_UNAVAILABLE')).code, 'G1_MODEL_UNAVAILABLE');
});
