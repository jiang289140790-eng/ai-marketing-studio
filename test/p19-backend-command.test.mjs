// P19 本地后端命令契约对抗测试（未部署边界，纯核心模块直接测试）：
// JWT 边界校验（签名/过期/nbf/iss/aud）、JWT subject 身份派生、
// staging 角色阶梯、命令 allowlist、未知字段 fail closed、原子幂等重放、
// 所有权、payload 哈希、修订守卫（PROJECT_REVISION_STALE，409-equivalent）、
// 归档只读门禁（PROJECT_ARCHIVED，核心层 + 边界镜像双重强制）、
// 证据移除按逻辑 evidence_id、交接包只允许已批准 Brief。
//
// 内存 db 镜像事务性边界（api.p19_apply_entity_write / api.p19_remove_evidence）
// 的语义：先预留幂等键，再执行受修订保护的写入；同键并发请求在边界内
// 恰好一次 applied、其余 replay（真实并发由 SQL 集成测试验证）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_ALLOWLIST,
  COMMAND_SCHEMA_VERSION,
  deriveUserIdFromClaims,
  executeCommand,
  hasRequiredRole,
  parseCommandRequest,
} from '../supabase/functions/p19-workspace-command/command-core.mjs';
import { verifyJwtToken, DEFAULT_JWT_ISSUER, DEFAULT_JWT_AUDIENCE } from '../supabase/functions/p19-workspace-command/jwt-verify.mjs';
import { clonePlain, fingerprintOf, sha256Hex } from '../src/services/p19-contracts.js';
import { assembleBrief, deriveHandoffPackage } from '../src/services/p19-workspace-service.js';

const USER_A = '44444444-4444-4444-8444-444444444444';
const USER_B = '55555555-5555-5555-8555-555555555555';

function memoryDb(seed = {}) {
  const state = {
    commands: [],
    projects: new Map(),
    evidence: [],
    analyses: [],
    cards: [],
    briefs: [],
    handoffs: [],
    ...seed,
  };
  /** 幂等键预留：同 (user_id, idempotency_key) 已存在 → replay，否则先预留。 */
  function reserve(userId, meta) {
    const requestIdentity = JSON.stringify({
      command: meta.command,
      entity_type: meta.entity_type,
      entity_id: meta.entity_id,
      project_id: meta.project_id ?? meta.payload?.project_id ?? meta.payload?.id ?? null,
      request_summary: meta.request_summary || {},
      expected_base_version: meta.expected_base_version ?? null,
      expected_entity_fingerprint: meta.expected_entity_fingerprint ?? null,
    });
    const existing = state.commands.find((entry) => entry.user_id === userId && entry.idempotency_key === meta.idempotency_key);
    if (existing) {
      if (existing.request_identity !== requestIdentity) throw boundaryError('IDEMPOTENCY_CONFLICT');
      return { outcome: 'replayed', ledger: existing };
    }
    state.commands.push({
      user_id: userId,
      idempotency_key: meta.idempotency_key,
      command: meta.command,
      entity_type: meta.entity_type,
      entity_id: meta.entity_id,
      status: 'applied',
      request_summary: meta.request_summary || {},
      request_identity: requestIdentity,
      diagnostics: {},
    });
    return null;
  }
  /** 边界失败回滚预留（镜像事务回滚语义）。 */
  function rollbackReservation(userId, meta) {
    const index = state.commands.findIndex((entry) => entry.user_id === userId && entry.idempotency_key === meta.idempotency_key);
    if (index >= 0) state.commands.splice(index, 1);
  }
  function boundaryError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }
  async function writeEntity(userId, meta) {
    const reserved = reserve(userId, meta);
    if (reserved) return reserved;
    // 规范化哈希校验（镜像边界：声明哈希必须等于规范化 payload 的摘要）。
    if (meta.declared_sha) {
      const actual = await fingerprintOf(meta.payload);
      if (actual !== meta.declared_sha) {
        rollbackReservation(userId, meta);
        throw boundaryError('PAYLOAD_HASH_MISMATCH');
      }
    }
    // 归档边界镜像：已归档项目拒绝一切变更（归档迁移除外；归档命令对
    // 已归档项目在核心层短路为幂等无操作，边界只处理 active → archived）。
    const projectId = meta.table === 'p19_research_projects_v1' ? meta.payload.id : meta.payload.project_id;
    const projectRow = projectId ? state.projects.get(`${userId}:${projectId}`) : null;
    const archiving = meta.table === 'p19_research_projects_v1' && meta.payload.status === 'archived';
    if (projectRow && projectRow.status === 'archived' && !archiving) {
      rollbackReservation(userId, meta);
      throw boundaryError('PROJECT_ARCHIVED');
    }
    if (meta.table === 'p19_research_projects_v1') {
      const key = `${userId}:${meta.payload.id}`;
      const current = state.projects.get(key);
      const expectedBase = meta.expected_base_version;
      const latestVersion = current ? Number(current.version) : null;
      const baseOk = expectedBase === null || expectedBase === undefined
        ? latestVersion === null || latestVersion === undefined
        : latestVersion === expectedBase;
      if (!baseOk) {
        rollbackReservation(userId, meta);
        throw boundaryError('PROJECT_REVISION_STALE');
      }
      state.projects.set(key, clonePlain(meta.payload));
    } else {
      const table = state[meta.table === 'p19_evidence_records_v1' ? 'evidence'
        : meta.table === 'p19_analyses_v1' ? 'analyses'
          : meta.table === 'p19_knowledge_cards_v1' ? 'cards'
            : meta.table === 'p19_briefs_v1' ? 'briefs'
              : meta.table === 'p19_handoff_packages_v1' ? 'handoffs' : null];
      if (!table) {
        rollbackReservation(userId, meta);
        throw boundaryError('UNKNOWN_TABLE');
      }
      const row = clonePlain(meta.payload);
      row.user_id = userId;
      const index = table.findIndex((item) => item.user_id === userId && item.project_id === String(row.project_id || '') && item.id === String(meta.entity_id));
      const current = index >= 0 ? table[index] : null;
      const expectedFingerprint = meta.expected_entity_fingerprint ?? null;
      const baselineOk = current
        ? expectedFingerprint !== null && current.fingerprint === expectedFingerprint
        : expectedFingerprint === null;
      if (!baselineOk) {
        rollbackReservation(userId, meta);
        throw boundaryError('ENTITY_REVISION_STALE');
      }
      if (index >= 0) table[index] = row;
      else table.push(row);
    }
    return { outcome: 'applied', entity: { type: meta.entity_type, id: meta.entity_id } };
  }
  async function removeEvidence(userId, meta) {
    const reserved = reserve(userId, meta);
    if (reserved) return reserved;
    // 归档边界镜像：已归档项目拒绝证据移除。
    const projectRow = state.projects.get(`${userId}:${meta.project_id}`);
    if (projectRow && projectRow.status === 'archived') {
      rollbackReservation(userId, meta);
      throw boundaryError('PROJECT_ARCHIVED');
    }
    // 删除按逻辑 evidence_id（绝不按 uuid 主键）。
    const index = state.evidence.findIndex((item) => item.user_id === userId && item.project_id === meta.project_id && item.id === meta.evidence_id);
    if (index < 0) {
      rollbackReservation(userId, meta);
      throw boundaryError('EVIDENCE_NOT_FOUND');
    }
    if (!meta.expected_entity_fingerprint || state.evidence[index].fingerprint !== meta.expected_entity_fingerprint) {
      rollbackReservation(userId, meta);
      throw boundaryError('ENTITY_REVISION_STALE');
    }
    state.evidence.splice(index, 1);
    return { outcome: 'applied', entity: { type: 'evidence', id: meta.evidence_id } };
  }
  return {
    _state: state,
    async getProject(userId, projectId) {
      const project = state.projects.get(`${userId}:${projectId}`);
      return project ? JSON.parse(JSON.stringify(project)) : null;
    },
    async listProjectEntities(userId, projectId) {
      const pick = (rows) => rows.filter((row) => row.user_id === userId && row.project_id === projectId);
      const briefs = pick(state.briefs).slice().sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
      const handoffs = pick(state.handoffs).slice().sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
      return {
        evidence: pick(state.evidence).map((row) => clonePlain(row)),
        analyses: pick(state.analyses).map((row) => clonePlain(row)),
        cards: pick(state.cards).map((row) => clonePlain(row)),
        brief: briefs.length > 0 ? clonePlain(briefs[0]) : null,
        handoff: handoffs.length > 0 ? clonePlain(handoffs[0]) : null,
      };
    },
    writeEntity,
    removeEvidence,
  };
}

function request(command, payload, idempotencyKey = 'key-1') {
  return { schema_version: COMMAND_SCHEMA_VERSION, command, idempotency_key: idempotencyKey, payload };
}

// ---- JWT subject 派生 ----

test('身份派生：只取 subject，忽略 user_metadata 与请求输入', () => {
  assert.equal(deriveUserIdFromClaims({ sub: USER_A, user_metadata: { sub: USER_B } }), USER_A);
  assert.equal(deriveUserIdFromClaims({ sub: '  ' + USER_A + '  ' }), USER_A, 'subject 修剪后使用');
  assert.throws(() => deriveUserIdFromClaims({}), /subject/);
  assert.throws(() => deriveUserIdFromClaims(null), /subject/);
  assert.throws(() => deriveUserIdFromClaims({ sub: 123 }), /subject/);
});

// ---- 角色阶梯 ----

test('角色阶梯：viewer < reviewer < operator < admin（与已验收映射一致）', () => {
  assert.equal(hasRequiredRole('viewer', 'viewer'), true);
  assert.equal(hasRequiredRole('viewer', 'operator'), false);
  assert.equal(hasRequiredRole('reviewer', 'operator'), false);
  assert.equal(hasRequiredRole('operator', 'reviewer'), true);
  assert.equal(hasRequiredRole('admin', 'operator'), true);
  assert.equal(hasRequiredRole('', 'viewer'), false);
  assert.equal(hasRequiredRole('hacker', 'viewer'), false);
});

// ---- 请求解析 ----

test('请求解析：未知命令 fail closed；schema 版本必须精确', () => {
  const unknown = parseCommandRequest({ schema_version: COMMAND_SCHEMA_VERSION, command: 'project.drop_all', idempotency_key: 'k', payload: {} });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_COMMAND');
  const badVersion = parseCommandRequest({ schema_version: 'p18_command_v1', command: 'project.create', idempotency_key: 'k', payload: {} });
  assert.equal(badVersion.code, 'SCHEMA_VERSION_MISMATCH');
  assert.equal(parseCommandRequest(request('project.create', {}, '')).code, 'IDEMPOTENCY_KEY_INVALID');
});

test('请求解析：每命令未知字段 fail closed', () => {
  const result = parseCommandRequest(request('project.create', { project: {}, evil: true }, 'k'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_FIELDS');
});

test('请求解析：allowlist 覆盖项目/证据/分析/卡/Brief/交接包/世系命令', () => {
  for (const command of [
    'project.create', 'project.update', 'project.archive',
    'evidence.create', 'evidence.update', 'evidence.remove',
    'analysis.create', 'card.create', 'brief.assemble', 'brief.decide',
    'handoff.create', 'lineage.audit',
  ]) {
    assert.ok(COMMAND_ALLOWLIST[command], `${command} 必须在 allowlist`);
    assert.ok(COMMAND_ALLOWLIST[command].role, `${command} 必须有角色要求`);
  }
  assert.equal(COMMAND_ALLOWLIST['brief.decide'].role, 'reviewer');
  assert.equal(COMMAND_ALLOWLIST['lineage.audit'].role, 'viewer');
  assert.equal(COMMAND_ALLOWLIST['handoff.create'].role, 'operator');
});

// ---- 角色拒绝 ----

test('命令执行：viewer 无权执行 operator 命令（ROLE_DENIED）', async () => {
  const db = memoryDb();
  const result = await executeCommand({
    ...request('project.create', { project: { topic: 't', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    user_id: USER_A,
    access_role: 'viewer',
  }, { db });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ROLE_DENIED');
  assert.equal(db._state.projects.size, 0, '被拒绝的命令不得写入');
});

// ---- 项目命令 ----

test('项目命令：create → update → archive 完整流（operator）', async () => {
  const db = memoryDb();
  const create = await executeCommand({
    ...request('project.create', { project: { topic: '主题', objective: '目标', audience: '受众', channel: '渠道', constraints: ['约束'] } }, 'k1'),
    user_id: USER_A,
    access_role: 'operator',
  }, { db });
  assert.equal(create.ok, true, JSON.stringify(create));
  assert.equal(create.applied, true);
  assert.equal(create.entity.type, 'project');
  const projectId = create.entity.id;

  const update = await executeCommand({
    ...request('project.update', { project_id: projectId, patch: { topic: '新主题' } }, 'k2'),
    user_id: USER_A,
    access_role: 'operator',
  }, { db });
  assert.equal(update.ok, true);
  assert.equal(db._state.projects.get(`${USER_A}:${projectId}`).topic, '新主题');

  const archive = await executeCommand({
    ...request('project.archive', { project_id: projectId }, 'k3'),
    user_id: USER_A,
    access_role: 'operator',
  }, { db });
  assert.equal(archive.ok, true);
  assert.equal(db._state.projects.get(`${USER_A}:${projectId}`).status, 'archived');
});

test('项目命令：payload_sha256 与内容不匹配被拒绝', async () => {
  const db = memoryDb();
  const result = await executeCommand({
    ...request('project.create', { project: { topic: '主题', objective: '目标', audience: '受众', channel: '渠道', constraints: [] } }, 'k1'),
    user_id: USER_A,
    access_role: 'operator',
    payload_sha256: '0'.repeat(64),
  }, { db });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAYLOAD_HASH_MISMATCH');
});

test('项目命令：跨用户所有权隔离（他人项目不可见）', async () => {
  const db = memoryDb();
  const create = await executeCommand({
    ...request('project.create', { project: { topic: 'A 的项目', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    user_id: USER_A,
    access_role: 'operator',
  }, { db });
  const result = await executeCommand({
    ...request('project.update', { project_id: create.entity.id, patch: { topic: 'x' } }, 'k2'),
    user_id: USER_B,
    access_role: 'operator',
  }, { db });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROJECT_NOT_FOUND');
});

// ---- 幂等 ----

test('幂等：同用户同幂等键重放返回 applied:false，绝不重复写入', async () => {
  const db = memoryDb();
  const base = {
    ...request('project.create', { project: { topic: '幂等项目', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'idem-key-1'),
    user_id: USER_A,
    access_role: 'operator',
  };
  const first = await executeCommand(base, { db });
  assert.equal(first.applied, true);
  const second = await executeCommand(base, { db });
  assert.equal(second.ok, true);
  assert.equal(second.applied, false);
  assert.ok(second.replay_of, '重放必须返回原记录');
  assert.equal(db._state.projects.size, 1, '重放不得重复写入');
});

test('幂等：同键换命令或换载荷必须返回 IDEMPOTENCY_CONFLICT', async () => {
  const db = memoryDb();
  const base = { ...request('project.create', { project: { topic: '原请求', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'identity-key'), user_id: USER_A, access_role: 'operator' };
  assert.equal((await executeCommand(base, { db })).ok, true);
  const changedPayload = await executeCommand({ ...base, payload: { project: { topic: '不同载荷', objective: 'o', audience: 'a', channel: 'c', constraints: [] } } }, { db });
  assert.equal(changedPayload.ok, false);
  assert.equal(changedPayload.code, 'IDEMPOTENCY_CONFLICT');
  const changedCommand = await executeCommand({ ...request('project.archive', { project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa' }, 'identity-key'), user_id: USER_A, access_role: 'operator' }, { db });
  assert.equal(changedCommand.ok, false);
  assert.equal(changedCommand.code, 'PROJECT_NOT_FOUND');
  assert.equal(db._state.commands.length, 1);
});

test('项目字段边界：命令入口 5000 通过，5001 明确失败且不截断', async () => {
  const db = memoryDb();
  const accepted = await executeCommand({
    ...request('project.create', { project: { topic: '题'.repeat(5000), objective: '目'.repeat(5000), audience: 'a', channel: 'c', constraints: [] } }, 'limit-ok'),
    user_id: USER_A, access_role: 'operator',
  }, { db });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const rejected = await executeCommand({
    ...request('project.create', { project: { topic: '题'.repeat(5001), objective: '目标', audience: 'a', channel: 'c', constraints: [] } }, 'limit-bad'),
    user_id: USER_A, access_role: 'operator',
  }, { db });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'PROJECT_INVALID');
});

// ---- 证据 / 分析 / 卡 / Brief ----

test('证据命令：畸形 URL 被拒绝；绑定项目不存在被拒绝', async () => {
  const db = memoryDb();
  const bad = await executeCommand({
    ...request('evidence.create', { project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', evidence: { source_url: 'bad', label: 'l', platform: 'p', content_text: 'c' } }, 'k1'),
    user_id: USER_A,
    access_role: 'operator',
  }, { db });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PROJECT_NOT_FOUND');
});

test('命令链：project → evidence → analysis → card → brief.assemble → brief.decide → handoff.create', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };

  const created = await executeCommand({ ...request('project.create', { project: { topic: '链', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'), ...role }, { db });
  const projectId = created.entity.id;
  const evidence = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: { source_url: 'https://example.com/x', label: '证据', platform: 'x', content_text: '这是证据文本内容。' } }, 'k2'),
    ...role,
  }, { db });
  assert.equal(evidence.ok, true);
  const evidenceId = evidence.entity.id;
  const storedEvidence = (await db.listProjectEntities(USER_A, projectId)).evidence.find((item) => item.id === evidenceId);

  const analysis = await executeCommand({
    ...request('analysis.create', {
      project_id: projectId,
      analysis: {
        schema_version: 'p19_analysis_v1',
        id: 'an-aaaaaaaaaaaaaaaaaaaaaaaa',
        project_id: projectId,
        evidence_id: evidenceId,
        kind: 'deterministic_local',
        rule_ids: ['source_url_shape'],
        provenance: { method: 'deterministic_local', generated_by: 'client_engine', model: null, executed_at: '2026-08-12T00:00:00Z', statement: '确定性本地' },
        result: { summary: { label: '确定性' }, rules: [] },
        evidence_fingerprint: storedEvidence.fingerprint,
        evidence_version: storedEvidence.version,
        version: 1,
        created_at: '2026-08-12T00:00:00Z',
        updated_at: '2026-08-12T00:00:00Z',
      },
    }, 'k3'),
    ...role,
  }, { db });
  assert.equal(analysis.ok, true, JSON.stringify(analysis));
  const storedAnalysis = (await db.listProjectEntities(USER_A, projectId)).analyses.find((item) => item.id === analysis.entity.id);

  // 非 deterministic_local 的分析被拒绝
  const fake = await executeCommand({
    ...request('analysis.create', {
      project_id: projectId,
      analysis: {
        schema_version: 'p19_analysis_v1',
        id: 'an-bbbbbbbbbbbbbbbbbbbbbbbb',
        project_id: projectId,
        evidence_id: evidenceId,
        kind: 'model_inference',
        rule_ids: [],
        provenance: { method: 'model_inference', model: 'qwen' },
        result: {},
      },
    }, 'k3b'),
    ...role,
  }, { db });
  assert.equal(fake.ok, false);
  assert.equal(fake.code, 'ANALYSIS_INVALID');

  const card = await executeCommand({
    ...request('card.create', {
      project_id: projectId,
      card: {
        schema_version: 'content_knowledge_card_v1',
        id: 'kc-aaaaaaaaaaaaaaaaaaaaaaaa',
        project_id: projectId,
        analysis_id: 'an-aaaaaaaaaaaaaaaaaaaaaaaa',
        source_observations: {
          post_text: '这是证据文本内容。',
          media: { duration_seconds: 0, resolution: 'local_metadata_only', audio_track_present: false,
            timeline: [
              { stage: 'start', time_range: 'na', visual_evidence: 's', audio_evidence: '无音轨' },
              { stage: 'middle', time_range: 'na', visual_evidence: 'm', audio_evidence: '无音轨' },
              { stage: 'end', time_range: 'na', visual_evidence: 'e', audio_evidence: '无音轨' },
            ],
            transcript_segments: [] },
          uncertainties: ['无画面'],
        },
        creative_analysis: {
          hook: '钩子', copy_device: '直述', semantic_layers: ['层'], visual_impact: '无视觉媒体',
          seductive_tone: '平稳', narrative_arc: '单句', audio_role: '无音轨',
          audience_response_mechanisms: ['机制'], replicable_features: ['特征'],
          risk_labels: { sexual_suggestiveness: 'none', platform_moderation: 'low', brand_suitability: 'broad', notes: [] },
        },
        evidence_links: [
          { claim: '一', evidence_type: 'post_text', source_ref: evidenceId, time_range: null, confidence: 0.9 },
          { claim: '二', evidence_type: 'metadata', source_ref: evidenceId, time_range: null, confidence: 0.8 },
          { claim: '三', evidence_type: 'metadata', source_ref: evidenceId, time_range: null, confidence: 0.7 },
        ],
        generation_guidance: { reusable_pattern: '模式', must_preserve: ['保留'], must_not_invent: ['不虚构'], prompt_ingredients: ['成分'], variation_space: ['变体'] },
        generation_readiness: { usable: true, score: 90, reasons: ['完成'], blockers: [] },
        analysis_fingerprint: storedAnalysis.fingerprint,
        analysis_version: 1,
        trust_status: 'manual_local',
        validation_status: 'validated_deterministic',
        version: 1,
        created_at: '2026-08-12T00:00:00Z',
        updated_at: '2026-08-12T00:00:00Z',
      },
    }, 'k4'),
    ...role,
  }, { db });
  assert.equal(card.ok, true, JSON.stringify(card));

  const entitiesBeforeBrief = await db.listProjectEntities(USER_A, projectId);
  const exactBrief = (await assembleBrief({
    ...(await db.getProject(USER_A, projectId)),
    evidence: entitiesBeforeBrief.evidence,
    analyses: entitiesBeforeBrief.analyses,
    knowledge_cards: entitiesBeforeBrief.cards,
    brief: null,
    handoff: null,
    handoffs: [],
  }, { now: () => '2026-08-12T00:00:01Z' })).brief;
  const brief = await executeCommand({
    ...request('brief.assemble', {
      project_id: projectId,
      brief: exactBrief,
      /* Historical hand-authored fixture retained only as a readable contract example.
      brief: {
        schema_version: 'ams_content_brief_v1',
        id: 'brief-aaaaaaaaaaaaaaaaaaaaaaaa',
        project_id: projectId,
        version: 1,
        status: 'pending_review',
        topic: '链', objective: 'o', audience: 'a', channel: 'c', constraints: [],
        knowledge_citation_ids: ['kc-aaaaaaaaaaaaaaaaaaaaaaaa'],
        structural_guidance: ['建议'],
        evidence_provenance: { local_only: true, store: 'p19_local_store_v1', created_from: 'selected_knowledge_cards', statement: '本地' },
        review: { schema_version: 'ams_brief_review_v1', brief_id: 'brief-aaaaaaaaaaaaaaaaaaaaaaaa', decision: null, comments: [] },
      },
      */
    }, 'k5'),
    ...role,
  }, { db });
  assert.equal(brief.ok, true, JSON.stringify(brief));
  const pendingBrief = (await db.listProjectEntities(USER_A, projectId)).brief;

  // 决策修订不匹配被拒绝
  const mismatch = await executeCommand({
    ...request('brief.decide', {
      project_id: projectId,
      expected_fingerprint: pendingBrief.fingerprint,
      decision: { brief_id: exactBrief.id, brief_version: 99, value: 'approved', source: 'local_manual', rationale: '批准', decided_by: 'tester', decided_at: '2026-08-12T00:00:00Z' },
    }, 'k6'),
    ...role,
  }, { db });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'DECISION_REVISION_MISMATCH');

  const decide = await executeCommand({
    ...request('brief.decide', {
      project_id: projectId,
      expected_fingerprint: pendingBrief.fingerprint,
      decision: { brief_id: exactBrief.id, brief_version: exactBrief.version, value: 'approved', source: 'local_manual', rationale: '批准', decided_by: 'tester', decided_at: '2026-08-12T00:00:00Z' },
    }, 'k7'),
    ...role,
  }, { db });
  assert.equal(decide.ok, true, JSON.stringify(decide));

  const staleDecision = await executeCommand({
    ...request('brief.decide', {
      project_id: projectId,
      expected_fingerprint: pendingBrief.fingerprint,
      decision: { brief_id: exactBrief.id, brief_version: exactBrief.version, value: 'return_for_revision', source: 'local_manual', rationale: '旧快照不得覆盖', decided_by: 'racing-reviewer', decided_at: '2026-08-12T00:00:01Z' },
    }, 'k7-stale'),
    ...role,
  }, { db });
  assert.equal(staleDecision.ok, false, JSON.stringify(staleDecision));
  assert.equal(staleDecision.code, 'ENTITY_REVISION_STALE');
  const decidedBrief = (await db.listProjectEntities(USER_A, projectId)).brief;
  assert.equal(decidedBrief.status, 'approved', '旧 Brief 快照不得覆盖已落盘的人工决定');
  assert.equal(decidedBrief.review.decision.value, 'approved');

  const entitiesBeforeHandoff = await db.listProjectEntities(USER_A, projectId);
  const exactHandoff = (await deriveHandoffPackage({
    ...(await db.getProject(USER_A, projectId)),
    evidence: entitiesBeforeHandoff.evidence,
    analyses: entitiesBeforeHandoff.analyses,
    knowledge_cards: entitiesBeforeHandoff.cards,
    brief: entitiesBeforeHandoff.brief,
    handoff: null,
    handoffs: [],
  }, { now: () => '2026-08-12T00:00:02Z' })).handoff;
  const handoff = await executeCommand({
    ...request('handoff.create', {
      project_id: projectId,
      handoff: exactHandoff,
      /* Historical hand-authored fixture retained only as a readable contract example.
      handoff: {
        schema_version: 'ams_external_handoff_package_v1',
        id: 'handoff-pkg-aaaaaaaaaaaaaaaaaaaaaaaa',
        version: 1,
        kind: 'external_generation_handoff_package',
        status: 'ready_for_external_import',
        payload_label: 'local_external_generation_handoff_package',
        is_external_task: false, submission_pending: true, local_only: true, repo_external: true,
        brief_provenance: { brief_id: 'brief-aaaaaaaaaaaaaaaaaaaaaaaa', brief_version: 1, brief_schema_version: 'ams_content_brief_v1', brief_status: 'approved' },
        human_decision: { value: 'approved', source: 'local_manual', rationale: '批准', decided_by: 'tester', decided_at: '2026-08-12T00:00:00Z' },
        topic: '链', objective: 'o',
        knowledge_citations: [{
          knowledge_id: 'kc-aaaaaaaaaaaaaaaaaaaaaaaa', type: 'content_knowledge_card_v1', title: '标题', excerpt: '摘要',
          evidence_refs: [evidenceId], evidence_completeness: { linked: 3, timeline: 'local_text' },
          trust_status: 'manual_local', validation_status: 'validated_deterministic',
        }],
        evidence_provenance: { local_only: true, store: 'p19_local_store_v1', created_from: 'approved_content_brief', knowledge_count: 1, statement: '本地' },
        structural_guidance: { reusable_patterns: ['p'], must_preserve: ['m'], variation_space: ['v'] },
        constraints: { must_not_invent: ['不虚构'], evidence_boundary: '仅本地' },
        external_project_boundary: { destination: 'external_generation_project', statement: '边界' },
        import_only: { manual_import_required: true },
        manual_feedback: null,
        execution_flags: { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false },
        source_trace: { origin: 'local_bridge', created_from: 'approved_content_brief' },
        project_id: projectId,
      },
      */
    }, 'k8'),
    ...role,
  }, { db });
  assert.equal(handoff.ok, true, JSON.stringify(handoff));
  assert.equal(handoff.entity.type, 'handoff');
  const forgedHandoff = clonePlain(exactHandoff);
  forgedHandoff.evidence_provenance.statement = 'forged provenance';
  const forged = await executeCommand({
    ...request('handoff.create', {
      project_id: projectId,
      expected_fingerprint: exactHandoff.fingerprint,
      handoff: forgedHandoff,
    }, 'k9'),
    ...role,
  }, { db });
  assert.equal(forged.ok, false, JSON.stringify(forged));
  assert.equal(forged.code, 'HANDOFF_PAYLOAD_MISMATCH');
});

test('handoff.create 门禁：Brief 未批准被拒绝（HANDOFF_BRIEF_NOT_APPROVED）', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };
  const created = await executeCommand({
    ...request('project.create', { project: { topic: 't', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    ...role,
  }, { db });
  const projectId = created.entity.id;
  const handoff = await executeCommand({
    ...request('handoff.create', {
      project_id: projectId,
      handoff: {
        schema_version: 'ams_external_handoff_package_v1',
        id: 'handoff-pkg-aaaaaaaaaaaaaaaaaaaaaaaa',
        version: 1,
        kind: 'external_generation_handoff_package',
        status: 'ready_for_external_import',
        payload_label: 'local_external_generation_handoff_package',
        is_external_task: false, submission_pending: true, local_only: true, repo_external: true,
        brief_provenance: { brief_id: 'brief-aaaaaaaaaaaaaaaaaaaaaaaa', brief_version: 1, brief_schema_version: 'ams_content_brief_v1', brief_status: 'pending_review' },
        human_decision: { value: 'approved', source: 'local_manual', rationale: 'r', decided_by: 't', decided_at: 'x' },
        topic: 't', objective: 'o',
        knowledge_citations: [],
        evidence_provenance: { local_only: true, store: 's', created_from: 'approved_content_brief', knowledge_count: 0, statement: 's' },
        structural_guidance: { reusable_patterns: [], must_preserve: [], variation_space: [] },
        constraints: { must_not_invent: [], evidence_boundary: 'b' },
        external_project_boundary: { destination: 'd', statement: 's' },
        import_only: { manual_import_required: true },
        manual_feedback: null,
        execution_flags: { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false },
        source_trace: { origin: 'local_bridge', created_from: 'approved_content_brief' },
        project_id: projectId,
      },
    }, 'k2'),
    ...role,
  }, { db });
  assert.equal(handoff.ok, false);
  assert.equal(handoff.code, 'HANDOFF_BRIEF_NOT_APPROVED');
});

test('lineage.audit：只读命令返回有界行（viewer 可执行）', async () => {
  const db = memoryDb();
  const created = await executeCommand({
    ...request('project.create', { project: { topic: 't', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    user_id: USER_A,
    access_role: 'viewer',
  }, { db });
  assert.equal(created.ok, false, 'viewer 不能写项目');
  assert.equal(created.code, 'ROLE_DENIED');

  // 预置一个属于 viewer 的项目后执行只读命令
  db._state.projects.set(`${USER_A}:prj-aaaaaaaaaaaaaaaaaaaaaaaa`, {
    id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', schema_version: 'p19_research_project_v1', version: 1, status: 'active',
    topic: 't', objective: 'o', audience: 'a', channel: 'c', constraints: [],
  });
  const audit = await executeCommand({
    ...request('lineage.audit', { project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa' }, 'k2'),
    user_id: USER_A,
    access_role: 'viewer',
  }, { db });
  assert.equal(audit.ok, true, JSON.stringify(audit));
  assert.equal(audit.entity.type, 'project');
  assert.ok(audit.diagnostics.lineage, '只读命令必须返回有界世系行');
});

// ---- JWT 边界校验（finding 4：过期 / 未生效 / 错误签发者 / 错误受众 / 坏签名）----

const NOW_MS = 2000000000000;

async function makeToken({ secret = 'test-secret-123', claims = {}, now = NOW_MS } = {}) {
  const full = {
    iss: DEFAULT_JWT_ISSUER,
    aud: DEFAULT_JWT_AUDIENCE,
    sub: USER_A,
    exp: Math.floor(now / 1000) + 3600,
    ...claims,
  };
  const encode = (value) => {
    const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(full)}`;
  const key = await globalThis.crypto.subtle.importKey(
    'raw', new globalThis.TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, new globalThis.TextEncoder().encode(data)));
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  const sigB64 = globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${data}.${sigB64}`;
}

async function expectJwtError(token, code) {
  await assert.rejects(
    () => verifyJwtToken(token, 'test-secret-123', { now: NOW_MS }),
    (error) => error && error.code === code,
  );
}

test('JWT：有效令牌通过校验且身份只来自 subject', async () => {
  const token = await makeToken({});
  const claims = await verifyJwtToken(token, 'test-secret-123', { now: NOW_MS });
  assert.equal(deriveUserIdFromClaims(claims), USER_A);
  assert.equal(claims.aud, 'authenticated');
});

test('JWT：过期令牌被拒绝（TOKEN_EXPIRED）', async () => {
  const token = await makeToken({ claims: { exp: Math.floor(NOW_MS / 1000) - 60 } });
  await expectJwtError(token, 'TOKEN_EXPIRED');
});

test('JWT：缺失 exp 被拒绝（绝不接受无过期时间的令牌）', async () => {
  const token = await makeToken({ claims: { exp: undefined } });
  await expectJwtError(token, 'TOKEN_EXPIRED');
});

test('JWT：尚未生效令牌被拒绝（TOKEN_NOT_YET_VALID，nbf 在未来）', async () => {
  const token = await makeToken({ claims: { nbf: Math.floor(NOW_MS / 1000) + 3600 } });
  await expectJwtError(token, 'TOKEN_NOT_YET_VALID');
});

test('JWT：错误签发者被拒绝（WRONG_ISSUER）', async () => {
  const token = await makeToken({ claims: { iss: 'evil-issuer' } });
  await expectJwtError(token, 'WRONG_ISSUER');
});

test('JWT：错误受众被拒绝（WRONG_AUDIENCE）', async () => {
  const token = await makeToken({ claims: { aud: 'service_role' } });
  await expectJwtError(token, 'WRONG_AUDIENCE');
});

test('JWT：坏签名 / 坏结构被拒绝（INVALID_TOKEN）', async () => {
  const token = await makeToken({});
  const tampered = `${token.slice(0, -4)}AAAA`;
  await expectJwtError(tampered, 'INVALID_TOKEN');
  await expectJwtError('not-a-jwt', 'INVALID_TOKEN');
  await expectJwtError('a.b.c.d', 'INVALID_TOKEN');
});

test('JWT：环境可覆盖期望 iss/aud（边界可配置，默认 supabase/authenticated）', async () => {
  const token = await makeToken({ claims: { iss: 'custom-issuer', aud: 'custom-audience' } });
  const claims = await verifyJwtToken(token, 'test-secret-123', { now: NOW_MS, expectedIssuer: 'custom-issuer', expectedAudience: 'custom-audience' });
  assert.equal(claims.sub, USER_A);
});

// ---- 修订守卫（finding 5：绝不从旧修订分支）----

test('修订守卫：并发写入后从旧修订更新被拒绝（PROJECT_REVISION_STALE）', async () => {
  const db = memoryDb();
  const created = await executeCommand({
    ...request('project.create', { project: { topic: '修订', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    user_id: USER_A,
    access_role: 'operator',
  }, { db });
  const projectId = created.entity.id;

  // 模拟竞态：getProject 读到旧快照（v1），而底层状态已被并发写为 v2。
  // 并发写入者基于 v1 写入 v2（base=1），随后旧快照上的更新（base=1）必须失败。
  const staleSnapshot = await db.getProject(USER_A, projectId);
  const racingDb = {
    ...db,
    getProject: async () => JSON.parse(JSON.stringify(staleSnapshot)),
  };
  await db.writeEntity(USER_A, {
    command: 'project.update',
    idempotency_key: 'race-key',
    entity_type: 'project',
    entity_id: projectId,
    request_summary: {},
    table: 'p19_research_projects_v1',
    payload: { ...staleSnapshot, topic: '并发主题', version: 2, updated_at: new Date().toISOString() },
    declared_sha: null,
    expected_base_version: 1,
  });

  const staleUpdate = await executeCommand({
    ...request('project.update', { project_id: projectId, patch: { topic: '旧修订上的更新' } }, 'k2'),
    user_id: USER_A,
    access_role: 'operator',
  }, { db: racingDb });
  assert.equal(staleUpdate.ok, false, JSON.stringify(staleUpdate));
  assert.equal(staleUpdate.code, 'PROJECT_REVISION_STALE');
  assert.equal(db._state.projects.get(`${USER_A}:${projectId}`).topic, '并发主题', '旧修订更新不得覆盖最新修订');
});

// ---- 证据移除按逻辑 evidence_id（finding 6）----

test('证据移除：按逻辑 evidence_id 移除，另一条证据不受影响；uuid 主键形状被拒绝', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };
  const created = await executeCommand({
    ...request('project.create', { project: { topic: '移除', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    ...role,
  }, { db });
  const projectId = created.entity.id;
  const first = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: { source_url: 'https://example.com/a', label: 'A', platform: 'x', content_text: 'a', recorded_at: '2026-08-12T00:00:00Z' } }, 'k2'),
    ...role,
  }, { db });
  await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: { source_url: 'https://example.com/b', label: 'B', platform: 'x', content_text: 'b', recorded_at: '2026-08-12T00:00:00Z' } }, 'k3'),
    ...role,
  }, { db });
  const firstRecord = (await db.listProjectEntities(USER_A, projectId)).evidence.find((item) => item.id === first.entity.id);
  const removed = await executeCommand({
    ...request('evidence.remove', { project_id: projectId, evidence_id: first.entity.id, expected_fingerprint: firstRecord.fingerprint }, 'k4'),
    ...role,
  }, { db });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  const entities = await db.listProjectEntities(USER_A, projectId);
  assert.equal(entities.evidence.length, 1, '只能按逻辑 id 移除目标证据');
  assert.equal(entities.evidence[0].label, 'B');
  // uuid 主键形状不是合法证据逻辑 id → EVIDENCE_ID_INVALID
  const bad = await executeCommand({
    ...request('evidence.remove', { project_id: projectId, evidence_id: '44444444-4444-4444-8444-444444444444' }, 'k5'),
    ...role,
  }, { db });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'EVIDENCE_ID_INVALID');
});

// ---- 幂等重放后证据移除（finding 7：边界原子预留镜像）----

test('幂等：证据移除同键重放返回 replay，绝不重复删除', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };
  const created = await executeCommand({
    ...request('project.create', { project: { topic: '幂等移除', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    ...role,
  }, { db });
  const projectId = created.entity.id;
  const evidence = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: { source_url: 'https://example.com/x', label: 'X', platform: 'x', content_text: 'x', recorded_at: '2026-08-12T00:00:00Z' } }, 'k2'),
    ...role,
  }, { db });
  const evidenceRecord = (await db.listProjectEntities(USER_A, projectId)).evidence.find((item) => item.id === evidence.entity.id);
  const base = {
    ...request('evidence.remove', { project_id: projectId, evidence_id: evidence.entity.id, expected_fingerprint: evidenceRecord.fingerprint }, 'k3'),
    user_id: USER_A,
    access_role: 'operator',
  };
  const first = await executeCommand(base, { db });
  assert.equal(first.applied, true);
  const replay = await executeCommand(base, { db });
  assert.equal(replay.ok, true);
  assert.equal(replay.applied, false);
  assert.ok(replay.replay_of, '重放必须返回原记录');
  const entities = await db.listProjectEntities(USER_A, projectId);
  assert.equal(entities.evidence.length, 0, '证据只被删除一次');
  assert.equal(db._state.commands.filter((entry) => entry.idempotency_key === 'k3').length, 1, '同键只有一条台账');
});

// ---- 声明的规范化哈希通过边界（finding 2 镜像）----

test('payload_sha256：与最终 payload 规范化摘要一致时通过（analysis.create 客户端可控载荷）', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };
  const created = await executeCommand({
    ...request('project.create', { project: { topic: '哈希', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    ...role,
  }, { db });
  const projectId = created.entity.id;
  const evidence = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: { source_url: 'https://example.com/h', label: 'H', platform: 'x', content_text: 'h', recorded_at: '2026-08-12T00:00:00Z' } }, 'k2'),
    ...role,
  }, { db });
  const analysis = {
    schema_version: 'p19_analysis_v1',
    id: 'an-aaaaaaaaaaaaaaaaaaaaaaaa',
    project_id: projectId,
    evidence_id: evidence.entity.id,
    kind: 'deterministic_local',
    rule_ids: ['source_url_shape'],
    provenance: { method: 'deterministic_local', generated_by: 'client_engine', model: null, executed_at: '2026-08-12T00:00:00Z', statement: '确定性本地' },
    result: { summary: { label: '确定性' }, rules: [] },
    evidence_fingerprint: 'a'.repeat(64),
    evidence_version: 1,
    version: 1,
    created_at: '2026-08-12T00:00:00Z',
    updated_at: '2026-08-12T00:00:00Z',
  };
  analysis.fingerprint = '';
  analysis.fingerprint = await fingerprintOf(analysis);
  // 客户端对「最终存储 payload」（analysis 原样 + project_id/schema_version）计算声明哈希。
  const declared = await fingerprintOf(clonePlain(analysis));
  const createdAnalysis = await executeCommand({
    ...request('analysis.create', { project_id: projectId, analysis }, 'k3'),
    user_id: USER_A,
    access_role: 'operator',
    payload_sha256: declared,
  }, { db });
  assert.equal(createdAnalysis.ok, true, JSON.stringify(createdAnalysis));
  // 错误的声明哈希被边界镜像拒绝
  const bad = await executeCommand({
    ...request('analysis.create', { project_id: projectId, analysis: { ...analysis, id: 'an-bbbbbbbbbbbbbbbbbbbbbbbb' } }, 'k4'),
    user_id: USER_A,
    access_role: 'operator',
    payload_sha256: declared,
  }, { db });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PAYLOAD_HASH_MISMATCH');
});

// ---- 归档只读门禁（finding 2：核心层 + 边界镜像双重强制）----

async function archiveFixture() {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };
  const created = await executeCommand({
    ...request('project.create', { project: { topic: '归档门禁', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    ...role,
  }, { db });
  const projectId = created.entity.id;
  const evidence = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: { source_url: 'https://example.com/x', label: 'X', platform: 'x', content_text: 'x', recorded_at: '2026-08-12T00:00:00Z' } }, 'k2'),
    ...role,
  }, { db });
  const archived = await executeCommand({
    ...request('project.archive', { project_id: projectId }, 'k3'),
    ...role,
  }, { db });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  return { db, projectId, evidenceId: evidence.entity.id, role };
}

test('归档只读门禁：归档后全部变更命令被拒绝（PROJECT_ARCHIVED，核心层）', async () => {
  const { db, projectId, evidenceId, role } = await archiveFixture();
  const cases = [
    ['project.update', { project_id: projectId, patch: { topic: 'x' } }],
    ['evidence.create', { project_id: projectId, evidence: { source_url: 'https://example.com/y', label: 'Y', platform: 'x', content_text: 'y', recorded_at: '2026-08-12T00:00:00Z' } }],
    ['evidence.update', { project_id: projectId, evidence_id: evidenceId, patch: { label: 'z' } }],
    ['evidence.remove', { project_id: projectId, evidence_id: evidenceId }],
    ['analysis.create', { project_id: projectId, analysis: {} }],
    ['card.create', { project_id: projectId, card: {} }],
    ['brief.assemble', { project_id: projectId, brief: {} }],
    ['brief.decide', { project_id: projectId, decision: { brief_id: 'brief-aaaaaaaaaaaaaaaaaaaaaaaa', brief_version: 1, value: 'approved', source: 'local_manual', rationale: 'r', decided_by: 't', decided_at: '2026-08-12T00:00:00Z' } }],
    ['handoff.create', { project_id: projectId, handoff: {} }],
  ];
  let index = 0;
  for (const [command, payload] of cases) {
    const result = await executeCommand({ ...request(command, payload, `arch-rej-${index += 1}`), ...role }, { db });
    assert.equal(result.ok, false, `${command} 必须被归档门禁拒绝`);
    assert.equal(result.code, 'PROJECT_ARCHIVED', `${command} 必须返回有界 PROJECT_ARCHIVED`);
    assert.ok(result.message.length <= 512, '诊断必须是有界文案');
  }
  // 只读世系审计仍可读归档项目。
  const audit = await executeCommand({ ...request('lineage.audit', { project_id: projectId }, 'audit-arch'), ...role }, { db });
  assert.equal(audit.ok, true, JSON.stringify(audit));
  // 归档快照未被任何被拒命令复活/修改。
  const project = await db.getProject(USER_A, projectId);
  assert.equal(project.status, 'archived');
  assert.equal(project.version, 2);
});

test('归档只读门禁：归档命令幂等——已归档项目再次归档为有界无操作', async () => {
  const { db, projectId, role } = await archiveFixture();
  const again = await executeCommand({ ...request('project.archive', { project_id: projectId }, 'k4'), ...role }, { db });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.applied, false);
  assert.equal(again.already_archived, true);
  const project = await db.getProject(USER_A, projectId);
  assert.equal(project.status, 'archived');
  assert.equal(project.version, 2, '幂等归档不得写新修订');
});

test('并发归档：数据库 already_archived 结果必须透传为 applied:false', async () => {
  const db = memoryDb();
  const active = await executeCommand({
    ...request('project.create', { project: { topic: '并发归档', objective: '目标', audience: '受众', channel: '渠道', constraints: [] } }, 'race-create'),
    user_id: USER_A,
    access_role: 'operator',
  }, { db });
  assert.equal(active.ok, true);
  const raceDb = {
    ...db,
    async writeEntity(_userId, meta) {
      return { outcome: 'applied', already_archived: true, entity: { type: meta.entity_type, id: meta.entity_id } };
    },
  };
  const result = await executeCommand({
    ...request('project.archive', { project_id: active.entity.id }, 'race-archive'),
    user_id: USER_A,
    access_role: 'operator',
  }, { db: raceDb });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.already_archived, true);
  assert.equal(result.entity.id, active.entity.id);
});

test('归档只读门禁：边界层不可绕过——直接对归档项目写入被镜像边界拒绝', async () => {
  const { db, projectId, evidenceId } = await archiveFixture();
  await assert.rejects(
    () => db.writeEntity(USER_A, {
      command: 'evidence.create',
      idempotency_key: 'bypass-1',
      entity_type: 'evidence',
      entity_id: 'ev-bbbbbbbbbbbbbbbbbbbbbbbb',
      request_summary: {},
      table: 'p19_evidence_records_v1',
      payload: {
        id: 'ev-bbbbbbbbbbbbbbbbbbbbbbbb', project_id: projectId, schema_version: 'p19_evidence_record_v1',
        source_url: 'https://example.com/b', label: 'B', platform: 'x', content_text: 'b',
        recorded_at: '2026-08-12T00:00:00Z', provenance: { manual: true },
      },
      declared_sha: null,
      expected_base_version: null,
    }),
    (error) => error && error.code === 'PROJECT_ARCHIVED',
    '边界必须拒绝归档项目上的实体写入',
  );
  await assert.rejects(
    () => db.removeEvidence(USER_A, {
      command: 'evidence.remove',
      idempotency_key: 'bypass-2',
      entity_type: 'evidence',
      entity_id: evidenceId,
      request_summary: {},
      project_id: projectId,
      evidence_id: evidenceId,
    }),
    (error) => error && error.code === 'PROJECT_ARCHIVED',
    '边界必须拒绝归档项目上的证据移除',
  );
  // 边界拒绝后不留台账（事务回滚镜像）。
  const ledger = db._state.commands.filter((entry) => entry.idempotency_key === 'bypass-1' || entry.idempotency_key === 'bypass-2');
  assert.equal(ledger.length, 0, '被拒命令不得留下幂等台账');
});

// ---- 修订守卫（finding 4：更新与归档冲突均为 PROJECT_REVISION_STALE，409-equivalent）----

test('修订守卫：归档冲突（旧修订上的归档）返回 PROJECT_REVISION_STALE', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };
  const created = await executeCommand({
    ...request('project.create', { project: { topic: '归档冲突', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'k1'),
    ...role,
  }, { db });
  const projectId = created.entity.id;
  const staleSnapshot = await db.getProject(USER_A, projectId);
  const racingDb = { ...db, getProject: async () => JSON.parse(JSON.stringify(staleSnapshot)) };
  // 竞态：并发者已把最新修订写到 v2，旧快照（v1）上的归档必须失败。
  await db.writeEntity(USER_A, {
    command: 'project.update',
    idempotency_key: 'race-arch',
    entity_type: 'project',
    entity_id: projectId,
    request_summary: {},
    table: 'p19_research_projects_v1',
    payload: { ...staleSnapshot, topic: '并发主题', version: 2, updated_at: '2026-08-12T00:00:00Z' },
    declared_sha: null,
    expected_base_version: 1,
  });
  const staleArchive = await executeCommand({
    ...request('project.archive', { project_id: projectId }, 'k2'),
    ...role,
  }, { db: racingDb });
  assert.equal(staleArchive.ok, false, JSON.stringify(staleArchive));
  assert.equal(staleArchive.code, 'PROJECT_REVISION_STALE');
  assert.equal(db._state.projects.get(`${USER_A}:${projectId}`).status, 'active', '旧修订上的归档不得执行');
});

test('P38 evidence.update refreshes same-identity provenance and verifies the new proof', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };
  const created = await executeCommand({ ...request('project.create', { project: { topic: 'P38', objective: 'rehydrate', audience: 'qa', channel: 'X', constraints: [] } }, 'p38-project'), ...role }, { db });
  const projectId = created.entity.id;
  const content = 'same persisted X post';
  const contentSha = await sha256Hex(content);
  const sourceUrl = 'https://x.com/example/status/2087399629654524194';
  const provenance = {
    schema_version: 'p22_apify_evidence_provenance_v1', manual: false, method: 'apify_public_collection',
    provider: 'apify:xquik/x-tweet-scraper', source_platform: 'x', source_id: 'p38-source', external_id: '2087399629654524194',
    source_url: sourceUrl, run_id: 'old-run', collected_at: '2026-08-12T00:00:00.000Z', usage_total_usd: 0.01,
    budget_reservation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', content_sha256: contentSha,
    collection_proof: `1999999999.${'a'.repeat(64)}`, statement: 'old verified proof',
  };
  const evidence = {
    source_url: sourceUrl, label: 'video', platform: 'X 路 Apify', content_text: content, recorded_at: provenance.collected_at, provenance,
    media_metadata: { filename: 'p38.txt', mime_type: 'text/plain; charset=utf-8', byte_size: 21, last_modified: provenance.collected_at, sha256: contentSha },
    media_assets: [{ id: 'm-111111111111111111111111', tweet_id: provenance.external_id, external_id: provenance.external_id, canonical_tweet_url: sourceUrl, media_url: 'https://video.twimg.com/ext_tw_video/old.mp4', order: 0, kind: 'video', mime_type: 'video/mp4', dimensions: { width: 720, height: 1280 }, byte_size: null, hash: { algorithm: 'sha256', kind: 'url', value: 'a'.repeat(64) } }],
  };
  let verifiedProof = '';
  const verify = async (_userId, record) => { verifiedProof = record.provenance.collection_proof; return true; };
  const added = await executeCommand({ ...request('evidence.create', { project_id: projectId, evidence }, 'p38-create'), ...role }, { db, verifyP22Evidence: verify });
  assert.equal(added.ok, true, JSON.stringify(added));
  const before = db._state.evidence.find((row) => row.id === added.entity.id);
  const refreshed = { ...provenance, run_id: 'new-run', collected_at: '2026-08-13T00:00:00.000Z', usage_total_usd: 0.02, budget_reservation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', collection_proof: `1999999998.${'b'.repeat(64)}`, statement: 'new media-bound proof' };
  const media = [{ id: 'm-222222222222222222222222', tweet_id: provenance.external_id, external_id: provenance.external_id, canonical_tweet_url: sourceUrl, media_url: 'https://video.twimg.com/ext_tw_video/new.mp4', order: 0, kind: 'video', mime_type: 'video/mp4', dimensions: { width: 720, height: 1280 }, byte_size: 4096, hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) } }];
  const updated = await executeCommand({ ...request('evidence.update', { project_id: projectId, evidence_id: before.id, expected_fingerprint: before.fingerprint, patch: { recorded_at: refreshed.collected_at, provenance: refreshed, media_assets: media } }, 'p38-update'), ...role }, { db, verifyP22Evidence: verify });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(verifiedProof, refreshed.collection_proof);
  const after = db._state.evidence.find((row) => row.id === before.id);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.provenance.run_id, 'new-run');
  assert.equal(after.media_assets[0].hash.kind, 'content');

  const rejected = await executeCommand({ ...request('evidence.update', { project_id: projectId, evidence_id: after.id, expected_fingerprint: after.fingerprint, patch: { provenance: { ...refreshed, external_id: 'wrong' } } }, 'p38-bad-identity'), ...role }, { db, verifyP22Evidence: verify });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'EVIDENCE_PROVENANCE_IDENTITY_MISMATCH');
});
