/* global WebSocket, fetch */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import {
  P22_CNY_PER_USD, P22_EXECUTION_FLAGS, P22_LIMITS, boundedProviderRunId, buildQwenPrompt,
  issueCollectionProof, normalizeCollectedItems, normalizeXUrl, parseP22Request, parseQwenAnalyses,
  providerDiagnostic, publicError, runApifyCollectionSequence, verifyAnalyzeSources, verifyCollectionProof,
} from '../supabase/functions/p22-research-assist/assist-core.mjs';
import { createP22ResearchAssistClient, isP22Duplicate, toP19EvidenceInput } from '../src/services/p22-research-assist.js';
import { createP20OnlineStore } from '../src/services/p20-online-store.js';
import { clonePlain } from '../src/services/p19-contracts.js';
import { COMMAND_SCHEMA_VERSION, executeCommand } from '../supabase/functions/p19-workspace-command/command-core.mjs';

const hash = async (text) => createHash('sha256').update(text).digest('hex');
const TEST_SECRET = 'p22-test-secret-with-at-least-thirty-two-bytes';
const USER_ID = 'user-p22-a';
const COLLECTED_AT = '2026-08-12T00:00:00Z';
const RESERVATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function collectedItem(overrides = {}) {
  const [item] = await normalizeCollectedItems([
    { id: '123', url: 'https://x.com/user/status/123', text: '公开内容' },
  ], {
    provider: 'apify:xquik/x-tweet-scraper', run_id: 'run-1', collected_at: COLLECTED_AT,
    usage_total_usd: 0.01, budget_reservation_id: RESERVATION_ID,
  }, hash);
  const merged = { ...item, ...overrides };
  return { ...merged, collection_proof: await issueCollectionProof(TEST_SECRET, USER_ID, merged, { nowMs: Date.parse(COLLECTED_AT) }) };
}

async function p22EvidenceFixture() {
  const contentText = 'P22 exact collected body';
  const contentSha = await hash(contentText);
  const provenance = {
    schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
    method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper', source_platform: 'x',
    source_id: 'p22-source-1', external_id: '1900000000000000001',
    source_url: 'https://x.com/example/status/1900000000000000001',
    run_id: 'apify-run-p22-1', collected_at: '2026-08-12T00:00:00.000Z', usage_total_usd: 0.01,
    budget_reservation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', content_sha256: contentSha,
    collection_proof: `1999999999.${'a'.repeat(64)}`, statement: 'Server-bound P22 source evidence.',
  };
  return {
    source_url: provenance.source_url, label: 'P22 source', platform: 'X · Apify', content_text: contentText,
    recorded_at: provenance.collected_at, provenance,
    media_metadata: {
      filename: 'p22-source.txt', mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(contentText).byteLength,
      last_modified: provenance.collected_at, sha256: contentSha,
    },
  };
}

function p22CommandDb(projectId) {
  const state = { writes: [], evidence: new Map() };
  return {
    state,
    async getProject(userId, requestedProjectId) {
      if (userId !== USER_ID || requestedProjectId !== projectId) return null;
      return { id: projectId, version: 1, status: 'active' };
    },
    async listProjectEntities(userId, requestedProjectId) {
      if (userId !== USER_ID || requestedProjectId !== projectId) return { evidence: [], analyses: [], cards: [], brief: null, handoff: null };
      return { evidence: [...state.evidence.values()].map(clonePlain), analyses: [], cards: [], brief: null, handoff: null };
    },
    async writeEntity(userId, meta) {
      if (meta.entity_type === 'evidence' && state.evidence.has(meta.entity_id)) {
        const stale = new Error('P19_ENTITY_REVISION_STALE');
        stale.code = 'ENTITY_REVISION_STALE';
        throw stale;
      }
      state.writes.push({ userId, meta: clonePlain(meta) });
      if (meta.entity_type === 'evidence') state.evidence.set(meta.entity_id, clonePlain(meta.payload));
      return { outcome: 'applied', entity: { type: meta.entity_type, id: meta.entity_id } };
    },
  };
}

function evidenceCommand(projectId, evidence, key) {
  return {
    schema_version: COMMAND_SCHEMA_VERSION,
    command: 'evidence.create',
    idempotency_key: key,
    payload: { project_id: projectId, evidence },
    user_id: USER_ID,
    access_role: 'operator',
  };
}

test('P22 strict request bounds reject unknown fields and over-limit batches', () => {
  assert.deepEqual(parseP22Request({ action: 'status' }), { action: 'status' });
  assert.throws(() => parseP22Request({ action: 'status', token: 'x' }), (error) => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => parseP22Request({ action: 'collect', topic: 'x', count: 6 }), (error) => error.code === 'COUNT_OUT_OF_RANGE');
  assert.throws(() => parseP22Request({ action: 'analyze', items: [] }), (error) => error.code === 'ITEM_COUNT_OUT_OF_RANGE');
  assert.throws(() => parseP22Request({ action: 'analyze', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), (error) => error.code === 'ITEM_COUNT_OUT_OF_RANGE');
  assert.equal(P22_LIMITS.collect, 5);
  assert.equal(P22_LIMITS.analyze, 2);
  assert.equal(P22_LIMITS.cost_stabilize_polls, 3);
  assert.equal(P22_LIMITS.cost_stabilize_interval_ms, 1500);
  assert.deepEqual(P22_EXECUTION_FLAGS, { generation_executed: false, routing_executed: false, external_job_created: false, publish_executed: false });
});

test('P22 X normalization canonicalizes and deduplicates exact source evidence', async () => {
  assert.equal(normalizeXUrl('https://twitter.com/user/status/123?ref=x#y'), 'https://x.com/user/status/123');
  const rows = await normalizeCollectedItems([
    { id: '123', url: 'https://twitter.com/user/status/123?x=1', text: '公开内容 https://t.co/abc' },
    { id: '123', url: 'https://x.com/user/status/123', full_text: '公开内容' },
    { resultType: 'diagnostic', text: 'not content' },
  ], { provider: 'apify:test', run_id: 'run-1', collected_at: '2026-08-12T00:00:00Z', usage_total_usd: 0.01, budget_reservation_id: 'res-1' }, hash);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_url, 'https://x.com/user/status/123');
  assert.equal(rows[0].external_id, '123');
  assert.equal(rows[0].provenance.run_id, 'run-1');
  assert.throws(() => normalizeXUrl('https://example.com/post/1'), (error) => error.code === 'UNSUPPORTED_SOURCE');
});

test('P22 Qwen response remains bound one-to-one to selected sources', async () => {
  const first = await collectedItem({ id: 'a', source_url: 'https://x.com/a/status/1', content_text: 'A', label: 'A', external_id: '1', content_sha256: await hash('A') });
  first.collection_proof = await issueCollectionProof(TEST_SECRET, USER_ID, first, { nowMs: Date.parse(COLLECTED_AT) });
  const second = await collectedItem({ id: 'b', source_url: 'https://x.com/b/status/2', content_text: 'B', label: 'B', external_id: '2', content_sha256: await hash('B') });
  second.collection_proof = await issueCollectionProof(TEST_SECRET, USER_ID, second, { nowMs: Date.parse(COLLECTED_AT) });
  const items = [first, second];
  const parsed = parseP22Request({ action: 'analyze', items });
  assert.match(buildQwenPrompt(parsed.items), /只分析给定公开来源/);
  const result = parseQwenAnalyses({ choices: [{ message: { content: JSON.stringify({ analyses: [
    { source_id: 'a', summary: '摘要 A', signals: ['信号'], risks: [] },
    { source_id: 'b', summary: '摘要 B', signals: [], risks: ['风险'] },
  ] }) } }] }, parsed.items);
  assert.deepEqual(result.map((row) => row.source_id), ['a', 'b']);
  assert.equal(result[0].content_sha256, await hash('A'));
  assert.throws(() => parseQwenAnalyses({ choices: [{ message: { content: '{"analyses":[{"source_id":"a","summary":"x","signals":[],"risks":[]},{"source_id":"a","summary":"y","signals":[],"risks":[]}]}' } }] }, parsed.items), (error) => error.code === 'MODEL_SOURCE_BINDING_INVALID');
});

test('P22 Qwen output normalization is Unicode-safe, bounded and fail-closed', async () => {
  const item = await collectedItem({ id: 'unicode-source', source_url: 'https://x.com/a/status/99', content_text: 'A', label: 'A', external_id: '99', content_sha256: await hash('A') });
  item.collection_proof = await issueCollectionProof(TEST_SECRET, USER_ID, item, { nowMs: Date.parse(COLLECTED_AT) });
  const parsed = parseP22Request({ action: 'analyze', items: [item] });
  const normalized = parseQwenAnalyses({ choices: [{ message: { content: JSON.stringify({ analyses: [{
    source_id: item.id,
    summary: `  ${'😀'.repeat(301)}  `,
    signals: [`  ${'信号'.repeat(130)}\n  `],
    risks: ['  risk\n\tvalue  '],
  }] }) } }] }, parsed.items);

  assert.equal(Array.from(normalized[0].summary).length, 300);
  assert.equal(normalized[0].summary, '😀'.repeat(300));
  assert.equal(Array.from(normalized[0].signals[0]).length, 240);
  assert.equal(normalized[0].risks[0], 'risk value');
  assert.equal(normalized[0].source_id, item.id);
  assert.equal(normalized[0].source_url, item.source_url);
  assert.equal(normalized[0].content_sha256, item.content_sha256);

  const response = (analysis) => ({ choices: [{ message: { content: JSON.stringify({ analyses: [analysis] }) } }] });
  assert.throws(() => parseQwenAnalyses(response({ source_id: item.id, summary: '   ', signals: [], risks: [] }), parsed.items), (error) => error.code === 'MODEL_RESPONSE_INVALID' && error.details.field === 'summary');
  assert.throws(() => parseQwenAnalyses(response({ source_id: item.id, summary: 'ok', signals: ['   '], risks: [] }), parsed.items), (error) => error.code === 'MODEL_RESPONSE_INVALID' && error.details.field === 'signals');
  assert.throws(() => parseQwenAnalyses(response({ source_id: item.id, summary: 'ok', signals: [], risks: ['x', 'x', 'x', 'x', 'x', 'x'] }), parsed.items), (error) => error.code === 'MODEL_RESPONSE_INVALID' && error.details.field === 'risks');
  assert.throws(() => parseQwenAnalyses(response({ source_id: 'foreign', summary: 'ok', signals: [], risks: [] }), parsed.items), (error) => error.code === 'MODEL_SOURCE_BINDING_INVALID' && error.details.field === 'source_id');
  assert.match(buildQwenPrompt(parsed.items), /300 Unicode characters/);
});

test('P22 frontend client uses authenticated function boundary and bounded errors', async () => {
  const calls = [];
  const client = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'u' } } }, error: null }) },
    functions: { invoke: async (name, options) => { calls.push({ name, options }); return { data: { ok: true, schema_version: 'p22_research_assist_v1', role: 'operator' }, error: null }; } },
  };
  await createP22ResearchAssistClient({ client }).status();
  assert.equal(calls[0].name, 'p22-research-assist');
  assert.equal(calls[0].options.body.action, 'status');
  assert.match(calls[0].options.headers.Authorization, /^Bearer /);
  const unauth = createP22ResearchAssistClient({ client: { auth: { getSession: async () => ({ data: {}, error: null }) } } });
  await assert.rejects(() => unauth.status(), (error) => error.code === 'AUTH_REQUIRED');
  assert.equal(publicError(new Error('Bearer secret-value')).code, 'INTERNAL_ERROR');
});

test('P22 saves collected content only through a valid P19 evidence input and rejects duplicates', async () => {
  const item = await collectedItem({ source_url: 'https://x.com/a/status/1', label: '来源', content_text: '正文', content_sha256: await hash('正文'), external_id: '1' });
  item.collection_proof = await issueCollectionProof(TEST_SECRET, USER_ID, item, { nowMs: Date.parse(COLLECTED_AT) });
  const input = await toP19EvidenceInput(item);
  assert.equal(input.platform, 'X · Apify');
  assert.equal(input.media_metadata.sha256, await hash('正文'));
  assert.equal(input.provenance.manual, false);
  assert.equal(input.provenance.run_id, 'run-1');
  assert.equal(input.provenance.source_url, item.source_url);
  assert.equal(input.provenance.collection_proof, item.collection_proof);
  assert.equal(isP22Duplicate({ evidence: [] }, item), false);
  assert.equal(isP22Duplicate({ evidence: [{ source_url: item.source_url, media_metadata: null }] }, item), false);
  assert.equal(isP22Duplicate({ evidence: [{ source_url: 'https://x.com/other/status/2', media_metadata: { sha256: await hash('正文') } }] }, item), false);
  assert.equal(isP22Duplicate({ evidence: [{ source_url: item.source_url, media_metadata: { sha256: await hash('正文') } }] }, item), true);
});

test('P22 evidence is server-verified before P19 persistence and retains exact provenance', async () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const evidence = await p22EvidenceFixture();
  const db = p22CommandDb(projectId);

  const unverified = await executeCommand(evidenceCommand(projectId, evidence, 'p22-unverified'), { db });
  assert.equal(unverified.code, 'P22_SOURCE_PROOF_UNVERIFIED');
  assert.equal(db.state.writes.length, 0);

  let verifiedRecord = null;
  const accepted = await executeCommand(evidenceCommand(projectId, evidence, 'p22-accepted'), {
    db,
    verifyP22Evidence: async (userId, record) => {
      assert.equal(userId, USER_ID);
      assert.equal(record.content_text, evidence.content_text);
      assert.deepEqual(record.provenance, evidence.provenance);
      verifiedRecord = clonePlain(record);
      return true;
    },
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(db.state.writes.length, 1);
  assert.deepEqual(db.state.writes[0].meta.payload.provenance, evidence.provenance);
  assert.deepEqual(db.state.writes[0].meta.payload.provenance, verifiedRecord.provenance);

  const replayedWithAnotherKey = await executeCommand(evidenceCommand(projectId, evidence, 'p22-accepted-after-lost-response'), {
    db,
    verifyP22Evidence: async () => true,
  });
  assert.equal(replayedWithAnotherKey.ok, true);
  assert.equal(replayedWithAnotherKey.applied, false);
  assert.equal(replayedWithAnotherKey.replayed, undefined);
  assert.equal(replayedWithAnotherKey.entity.id, accepted.entity.id, 'P22 identity must not depend on request time or idempotency key');
  assert.equal(db.state.evidence.size, 1, 'a lost response followed by retry must not create duplicate Evidence');
  assert.equal(db.state.writes.length, 1, 'exact replay must short-circuit before the SQL create boundary');

  const conflictingIdentity = { ...clonePlain(evidence), label: 'Conflicting label for the same immutable identity' };
  const conflict = await executeCommand(evidenceCommand(projectId, conflictingIdentity, 'p22-conflicting-identity'), {
    db,
    verifyP22Evidence: async () => true,
  });
  assert.equal(conflict.code, 'P22_EVIDENCE_IDENTITY_CONFLICT');
  assert.equal(db.state.writes.length, 1);

  const tampered = { ...clonePlain(evidence), content_text: `${evidence.content_text} tampered` };
  let verifierCalled = false;
  const hashRejected = await executeCommand(evidenceCommand(projectId, tampered, 'p22-hash-rejected'), {
    db, verifyP22Evidence: async () => { verifierCalled = true; return true; },
  });
  assert.equal(hashRejected.code, 'P22_EVIDENCE_HASH_MISMATCH');
  assert.equal(verifierCalled, false);
  assert.equal(db.state.writes.length, 1);

  const proofRejected = await executeCommand(evidenceCommand(projectId, evidence, 'p22-proof-rejected'), {
    db, verifyP22Evidence: async () => false,
  });
  assert.equal(proofRejected.code, 'P22_SOURCE_PROOF_INVALID');
  assert.equal(db.state.writes.length, 1);
});

test('P22 signed labels remain exact at 160, 161 and 200 characters through P19 verification', async () => {
  const nowMs = Date.parse(COLLECTED_AT);
  for (const length of [160, 161, 200]) {
    const label = 'L'.repeat(length);
    const item = await collectedItem({ label });
    item.collection_proof = await issueCollectionProof(TEST_SECRET, USER_ID, item, { nowMs });
    const evidence = await toP19EvidenceInput(item);
    assert.equal(evidence.label, label);
    const projectId = `prj-${String(length).padStart(24, '0')}`;
    const db = p22CommandDb(projectId);
    const result = await executeCommand(evidenceCommand(projectId, evidence, `p22-label-${length}`), {
      db,
      verifyP22Evidence: async (userId, record) => verifyCollectionProof(TEST_SECRET, userId, {
        id: record.provenance.source_id,
        source_url: record.source_url,
        label: record.label,
        platform: 'x',
        content_text: record.content_text,
        external_id: record.provenance.external_id,
        content_sha256: record.media_metadata.sha256,
        provenance: {
          schema_version: 'p22_collected_source_v1',
          provider: record.provenance.provider,
          run_id: record.provenance.run_id,
          collected_at: record.provenance.collected_at,
          usage_total_usd: record.provenance.usage_total_usd,
          budget_reservation_id: record.provenance.budget_reservation_id,
        },
      }, record.provenance.collection_proof, { nowMs }),
    });
    assert.equal(result.ok, true, `label length ${length}: ${JSON.stringify(result)}`);
    assert.equal(db.state.writes[0].meta.payload.label, label);
  }
});

test('manual P19 evidence remains manual and never enters the P22 proof path', async () => {
  const projectId = 'prj-bbbbbbbbbbbbbbbbbbbbbbbb';
  const db = p22CommandDb(projectId);
  let verifierCalled = false;
  const result = await executeCommand(evidenceCommand(projectId, {
    source_url: 'https://example.com/manual-source', label: 'Manual source', platform: 'manual',
    content_text: 'Human-entered evidence.', recorded_at: '2026-08-12T00:00:00.000Z',
    provenance: { manual: true, statement: 'Human-entered source.' }, media_metadata: null,
  }, 'manual-evidence'), { db, verifyP22Evidence: async () => { verifierCalled = true; return true; } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(verifierCalled, false);
  assert.equal(db.state.writes[0].meta.payload.provenance.manual, true);
  assert.deepEqual(db.state.writes[0].meta.payload.provenance, { manual: true, statement: 'Human-entered source.' });
});

test('P20 online save and refresh preserve exact P22 provenance without aliasing', async () => {
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const evidence = { ...(await p22EvidenceFixture()), id: 'ev-aaaaaaaaaaaaaaaaaaaaaaaa', project_id: projectId };
  let savedPayload = null;
  const store = createP20OnlineStore({
    commandClient: {
      async invoke(command, payload) {
        if (command === 'evidence.create') {
          savedPayload = clonePlain(payload);
          return { entity: { id: evidence.id } };
        }
        if (command === 'project.read') {
          return { data: { project: { id: projectId, topic: 'P22', evidence: [clonePlain(evidence)] } } };
        }
        throw new Error(`unexpected command ${command}`);
      },
    },
  });
  const refreshed = await store.execute('evidence.create', { project_id: projectId, evidence });
  assert.deepEqual(savedPayload.evidence.provenance, evidence.provenance);
  assert.deepEqual(refreshed.evidence[0].provenance, evidence.provenance);
  assert.notStrictEqual(refreshed.evidence[0].provenance, evidence.provenance);
});

test('P22 hashes the final persistable body and rejects later truncation', async () => {
  const long = '长'.repeat(9000);
  const [item] = await normalizeCollectedItems([{ id: 'long', url: 'https://x.com/u/status/999', text: long }], {
    provider: 'apify:xquik/x-tweet-scraper', run_id: 'run-long', collected_at: COLLECTED_AT,
    usage_total_usd: 0.02, budget_reservation_id: RESERVATION_ID,
  }, hash);
  assert.equal(item.content_text.length, 5000);
  assert.equal(item.content_sha256, await hash(item.content_text));
  item.collection_proof = await issueCollectionProof(TEST_SECRET, USER_ID, item, { nowMs: Date.parse(COLLECTED_AT) });
  const input = await toP19EvidenceInput(item);
  assert.equal(input.content_text, item.content_text);
  assert.equal(input.media_metadata.sha256, await hash(input.content_text));

  const oversized = { ...item, content_text: '超'.repeat(6000), content_sha256: await hash('超'.repeat(6000)) };
  await assert.rejects(() => toP19EvidenceInput(oversized), (error) => error.code === 'P22_EVIDENCE_INVALID');
});

test('P22 collection proof binds user, body, hash, URL and expiry', async () => {
  const nowMs = Date.parse(COLLECTED_AT);
  const item = await collectedItem();
  assert.equal(await verifyCollectionProof(TEST_SECRET, USER_ID, item, item.collection_proof, { nowMs }), true);
  for (const changed of [
    { ...item, content_text: `${item.content_text}伪造` },
    { ...item, content_sha256: 'f'.repeat(64) },
    { ...item, source_url: 'https://x.com/user/status/456' },
  ]) {
    await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, changed, item.collection_proof, { nowMs }), (error) => error.code === 'SOURCE_PROOF_INVALID');
  }
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, 'user-p22-b', item, item.collection_proof, { nowMs }), (error) => error.code === 'SOURCE_PROOF_INVALID');
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, item, item.collection_proof, { nowMs: nowMs + P22_LIMITS.proof_ttl_ms + 1 }), (error) => error.code === 'SOURCE_PROOF_EXPIRED');
  assert.throws(() => parseP22Request({ action: 'analyze', items: [{ ...item, collection_proof: undefined }] }), (error) => error.code === 'INVALID_REQUEST');
  assert.equal(await verifyAnalyzeSources(TEST_SECRET, USER_ID, [item], { nowMs }), true);
  await assert.rejects(
    () => verifyAnalyzeSources(TEST_SECRET, USER_ID, [{ ...item, content_text: `${item.content_text}tampered` }], { nowMs }),
    (error) => error.code === 'SOURCE_PROOF_INVALID',
  );
});

test('P22 v2 proof survives display-only label normalization while binding exact persisted identity', async () => {
  const nowMs = Date.parse(COLLECTED_AT);
  const item = await collectedItem({ label: '  display label  ' });
  item.collection_proof = await issueCollectionProof(TEST_SECRET, USER_ID, item, { nowMs });
  assert.equal(await verifyCollectionProof(TEST_SECRET, USER_ID, { ...item, label: 'display label' }, item.collection_proof, { nowMs }), true);
  for (const changed of [
    { ...item, id: `${item.id}-foreign` },
    { ...item, external_id: `${item.external_id}-foreign` },
    { ...item, provenance: { ...item.provenance, run_id: `${item.provenance.run_id}-foreign` } },
    { ...item, provenance: { ...item.provenance, budget_reservation_id: `${item.provenance.budget_reservation_id}-foreign` } },
  ]) {
    await assert.rejects(
      () => verifyCollectionProof(TEST_SECRET, USER_ID, changed, item.collection_proof, { nowMs }),
      (error) => error.code === 'SOURCE_PROOF_INVALID',
    );
  }
});

test('P22 migration is service-role only, atomic and contains no new table or browser grant', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260812003000_p22_atomic_daily_budget_reservation.sql'), 'utf8');
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.ok((sql.match(/pg_advisory_xact_lock/gi) || []).length >= 2);
  assert.match(sql, /at time zone 'UTC'/i);
  assert.match(sql, /P22_DAILY_BUDGET_EXCEEDED/);
  assert.match(sql, /revoke all on function api\.p22_reserve_daily_budget[\s\S]+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function api\.p22_reserve_daily_budget[\s\S]+to service_role/i);
  assert.doesNotMatch(sql, /create\s+table/i);
  assert.doesNotMatch(sql, /grant\s+execute[\s\S]+to\s+(anon|authenticated)/i);
});

test('P26 removes cumulative daily caps while retaining bounded, service-only cost records', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260812091054_p26_remove_daily_provider_caps.sql'), 'utf8');
  assert.match(sql, /create or replace function api\.p22_reserve_daily_budget/i);
  assert.match(sql, /daily_cap_enabled', false/i);
  assert.match(sql, /recorded_without_daily_cap/i);
  assert.doesNotMatch(sql, /P22_DAILY_BUDGET_EXCEEDED/);
  assert.doesNotMatch(sql, /v_reserved\s*\+\s*p_amount_cny\s*>/i);
  assert.match(sql, /p_amount_cny\s*>\s*10\.0000/i);
  assert.match(sql, /revoke all on function api\.p22_reserve_daily_budget[\s\S]+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function api\.p22_reserve_daily_budget[\s\S]+to service_role/i);
  assert.doesNotMatch(sql, /create\s+table/i);
});

test('P22 production UI contains capability gates, explicit preview and save wording', () => {
  const component = readFileSync(join(process.cwd(), 'src', 'components', 'integrated-workspace', 'P22ResearchAssistPanel.jsx'), 'utf8');
  const page = readFileSync(join(process.cwd(), 'src', 'pages', 'ResearchWorkspacePage.jsx'), 'utf8');
  const edge = readFileSync(join(process.cwd(), 'supabase', 'functions', 'p22-research-assist', 'index.ts'), 'utf8');
  assert.match(component, /Apify：.*尚未配置/s);
  assert.match(component, /Qwen：.*尚未配置/s);
  assert.match(component, /来源预览（未保存）/);
  assert.match(component, /保存并生成可审核 Brief/);
  assert.match(component, /仅预览/);
  assert.match(component, /按实际使用记录费用/);
  assert.match(component, /今日已记录/);
  assert.doesNotMatch(component, /每日各\s*[≤<]=?\s*¥?10|今日剩余/);
  assert.match(page, /onlineMode && <P22ResearchAssistPanel/);
  assert.match(page, /P22ResearchAssistPanel key=\{project\.id\}/);
  assert.match(page, /toP19EvidenceInput/);
  assert.match(component, /setItems\(\(project\.evidence \|\| \[\]\)\.map\(p22ItemFromEvidence\)\.filter\(Boolean\)\)[\s\S]+setSelected\(\[\]\)[\s\S]+setAnalyses\(\[\]\)/);
  const analyzeBody = edge.slice(edge.indexOf('async function analyze'), edge.indexOf('Deno.serve'));
  assert.doesNotMatch(edge, /DAILY_BUDGET_EXCEEDED|今日\s*¥10\s*预算已不足/);
  assert.match(edge, /daily_cap_enabled:false/);
  assert.ok(analyzeBody.indexOf('verifyAnalyzeSources') >= 0);
  assert.ok(analyzeBody.indexOf('verifyAnalyzeSources') < analyzeBody.indexOf("Deno.env.get('DASHSCOPE_API_KEY')"));
  assert.ok(analyzeBody.indexOf('verifyAnalyzeSources') < analyzeBody.indexOf("recordProviderCost(db,userId,'qwen'"));
});

// ---------------------------------------------------------------------------
// P22 repair 2：文档化 Apify 序列 + fail-closed 提供方适配边界（无网络）
// ---------------------------------------------------------------------------

function fakeApifyResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const APIFY_RUN_ID = 'run-a1b2';
const APIFY_DATASET_ID = 'ds-a1b2';

/** 按文档化端点路由的 Apify 假边界；runs 依次供给 wait 与 cost 阶段的运行对象。 */
function apifyHarness({ start = { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID } } }, runs = [], dataset = { status: 200, body: [] } } = {}) {
  const calls = [];
  let runIndex = 0;
  const fetchImpl = async (url, init) => {
    const text = String(url);
    calls.push({ url: text, method: init?.method || 'GET', body: init?.body || null, auth: init?.headers?.Authorization || null });
    if (text.includes('/acts/') && (init?.method || 'GET') === 'POST') return fakeApifyResponse(start.status, start.body);
    if (text.includes('/dataset/items')) return fakeApifyResponse(dataset.status, dataset.body);
    if (text.includes('/actor-runs/')) {
      const fallback = { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.01 } } };
      const next = runs.length ? runs[Math.min(runIndex, runs.length - 1)] : fallback;
      runIndex += 1;
      return fakeApifyResponse(next.status, next.body);
    }
    throw new Error(`unexpected Apify URL: ${text}`);
  };
  return { fetchImpl, calls };
}

async function apifySequence(overrides = {}, options = {}) {
  const boundary = apifyHarness(overrides);
  const result = await runApifyCollectionSequence({
    token: 'apify-test-token',
    actorId: 'xquik/x-tweet-scraper',
    topic: '测试主题',
    count: 5,
    maxItems: P22_LIMITS.collect,
    maxTotalChargeUsd: P22_LIMITS.apify_reservation_cny / P22_CNY_PER_USD,
    sleepImpl: options.sleepImpl ?? (async () => {}),
    nowImpl: () => 0,
    fetchImpl: boundary.fetchImpl,
  });
  return { result, calls: boundary.calls };
}

test('P22 exact run→dataset→stable-cost→proof flow binds one explicit identity and issues a proof', async () => {
  const rawRows = [
    { id: '111', url: 'https://x.com/user/status/111', text: '第一条公开内容' },
    { id: '222', url: 'https://x.com/user/status/222', text: '第二条公开内容' },
  ];
  const { result, calls } = await apifySequence({
    start: { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID } } },
    runs: [
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.01 } } },
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.01 } } },
    ],
    dataset: { status: 200, body: rawRows },
  });
  assert.equal(result.runId, APIFY_RUN_ID);
  assert.equal(result.usageTotalUsd, 0.01);
  assert.equal(result.items.length, 2);
  assert.ok(!JSON.stringify(result).includes('collection_proof'), '适配器成功结果绝不携带证明');
  assert.match(calls[0].url, /^https:\/\/api\.apify\.com\/v2\/acts\/xquik~x-tweet-scraper\/runs\?maxTotalChargeUsd=/);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, 'Bearer apify-test-token');
  assert.deepEqual(JSON.parse(calls[0].body), { maxItems: 5, sort: 'Latest', searchTerms: ['测试主题'] });
  assert.equal(Object.hasOwn(JSON.parse(calls[0].body), 'input'), false, 'POST 请求体必须直接是 Actor 顶层输入，不得包裹 input');
  assert.match(calls[1].url, /\/actor-runs\/run-a1b2\?waitForFinish=/);
  assert.match(calls[2].url, /\/actor-runs\/run-a1b2\/dataset\/items\?limit=5&clean=true/);
  assert.equal(calls[3].url, `https://api.apify.com/v2/actor-runs/${APIFY_RUN_ID}`);
  assert.equal(calls[4].url, `https://api.apify.com/v2/actor-runs/${APIFY_RUN_ID}`);
  assert.equal(calls.filter((call) => call.url === `https://api.apify.com/v2/actor-runs/${APIFY_RUN_ID}`).length, 2, '稳定费用读取两次后收敛，费用来自同一运行');
  assert.ok(!JSON.stringify(calls).includes('x-apify-actor-run-id'), '运行身份绝不来自未文档化响应头');

  const normalized = await normalizeCollectedItems(result.items, {
    provider: 'apify:xquik/x-tweet-scraper', run_id: result.runId, collected_at: COLLECTED_AT,
    usage_total_usd: result.usageTotalUsd, budget_reservation_id: RESERVATION_ID,
  }, hash);
  const proven = [];
  for (const item of normalized) {
    const collectionProof = await issueCollectionProof(TEST_SECRET, USER_ID, item, { nowMs: Date.parse(COLLECTED_AT) });
    proven.push({ ...item, collection_proof: collectionProof });
  }
  assert.equal(proven.length, 2);
  assert.equal(proven[0].provenance.run_id, APIFY_RUN_ID);
  assert.equal(proven[0].provenance.usage_total_usd, 0.01);
  const input = await toP19EvidenceInput(proven[0]);
  assert.equal(input.provenance.run_id, APIFY_RUN_ID);
  assert.equal(input.provenance.usage_total_usd, 0.01);
  assert.equal(await verifyCollectionProof(TEST_SECRET, USER_ID, proven[0], proven[0].collection_proof, { nowMs: Date.parse(COLLECTED_AT) }), true);
});

test('P22 fail-closed adapter rejects every upstream HTTP non-2xx with stage and safe status', async () => {
  const scenarios = [
    { start: { status: 401, body: {} }, stage: 'start' },
    { runs: [{ status: 500, body: {} }], stage: 'wait' },
    { dataset: { status: 404, body: {} }, stage: 'dataset' },
    { runs: [
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
      { status: 403, body: {} },
    ], stage: 'cost' },
  ];
  for (const scenario of scenarios) {
    await assert.rejects(() => apifySequence(scenario), (error) => {
      assert.equal(error.code, 'APIFY_UPSTREAM_REJECTED', JSON.stringify(scenario));
      assert.equal(error.details.provider, 'apify');
      assert.equal(error.details.stage, scenario.stage, JSON.stringify(scenario));
      assert.equal(error.details.run_id, scenario.stage === 'start' ? undefined : 'run-a1b2', JSON.stringify(scenario));
      assert.ok(error.details.status >= 400 && error.details.status <= 599, JSON.stringify(scenario));
      assert.equal(error.status, 502);
      return true;
    });
  }
});

test('P22 fails closed on missing, malformed, duplicate and foreign run identities', async () => {
  await assert.rejects(() => apifySequence({ start: { status: 200, body: { data: {} } } }),
    (error) => error.code === 'APIFY_RUN_ID_INVALID' && error.details.reason === 'missing' && error.details.stage === 'start');
  await assert.rejects(() => apifySequence({ start: { status: 200, body: { data: { id: 'bad run id!' } } } }),
    (error) => error.code === 'APIFY_RUN_ID_INVALID' && error.details.reason === 'malformed' && error.details.stage === 'start');
  await assert.rejects(() => apifySequence({ start: { status: 200, body: { data: { id: 'run-a1b2', defaultDatasetId: 'ds-a1b2' } } }, runs: [{ status: 200, body: { data: { id: 'run-other', defaultDatasetId: 'ds-a1b2', status: 'SUCCEEDED' } } }] }),
    (error) => error.code === 'APIFY_RUN_ID_INVALID' && error.details.reason === 'foreign' && error.details.stage === 'wait');
  await assert.rejects(() => apifySequence({ runs: [{ status: 200, body: { data: [{ id: 'run-a1b2' }, { id: 'run-a1b2' }] } }] }),
    (error) => error.code === 'APIFY_RUN_ID_INVALID' && error.details.reason === 'duplicate' && error.details.stage === 'wait');
  await assert.rejects(() => apifySequence({ runs: [
    { status: 200, body: { data: { id: 'run-a1b2', defaultDatasetId: 'ds-a1b2', status: 'SUCCEEDED' } } },
    { status: 200, body: { data: { id: 'run-other', defaultDatasetId: 'ds-a1b2', status: 'SUCCEEDED', usageTotalUsd: 0.01 } } },
  ] }),
    (error) => error.code === 'APIFY_RUN_ID_INVALID' && error.details.reason === 'foreign' && error.details.stage === 'cost');
});

test('P22 fails closed on terminal failed runs with bounded run status', async () => {
  for (const runStatus of ['FAILED', 'TIMED-OUT', 'ABORTED']) {
    await assert.rejects(() => apifySequence({ runs: [{ status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: runStatus } } }] }), (error) => {
      assert.equal(error.code, 'APIFY_RUN_FAILED', runStatus);
      assert.equal(error.details.run_status, runStatus);
      assert.equal(error.details.stage, 'wait');
      assert.equal(error.status, 502);
      return true;
    });
  }
});

test('P22 fails closed with APIFY_TIMEOUT on strict wait budget exhaustion and on abort', async () => {
  let clock = 0;
  const fetchImpl = async (url, _init) => {
    const text = String(url);
    if (text.includes('/acts/')) return fakeApifyResponse(200, { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID } });
    clock += P22_LIMITS.apify_wait_ms + 1;
    return fakeApifyResponse(200, { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'RUNNING' } });
  };
  await assert.rejects(() => runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: 't', count: 1,
    maxItems: P22_LIMITS.collect, maxTotalChargeUsd: 0.1,
    fetchImpl, sleepImpl: async () => {}, nowImpl: () => clock,
  }), (error) => error.code === 'APIFY_TIMEOUT' && error.details.stage === 'wait' && error.status === 504);

  await assert.rejects(() => runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: 't', count: 1,
    maxItems: P22_LIMITS.collect, maxTotalChargeUsd: 0.1,
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
    sleepImpl: async () => {}, nowImpl: () => 0,
  }), (error) => error.code === 'APIFY_TIMEOUT' && error.status === 504);
});

test('P22 fails closed on invalid dataset payloads and mismatched dataset/run', async () => {
  await assert.rejects(() => apifySequence({ dataset: { status: 200, body: { run_id: 'run-other', items: [] } } }),
    (error) => error.code === 'APIFY_DATASET_INVALID' && error.details.reason === 'run_mismatch' && error.details.stage === 'dataset');
  await assert.rejects(() => apifySequence({ dataset: { status: 200, body: { run_id: APIFY_RUN_ID, items: 'not-an-array' } } }),
    (error) => error.code === 'APIFY_DATASET_INVALID' && error.details.reason === 'shape');
  await assert.rejects(() => apifySequence({ dataset: { status: 200, body: { items: 5 } } }),
    (error) => error.code === 'APIFY_DATASET_INVALID' && error.details.reason === 'shape');
  await assert.rejects(() => apifySequence({ dataset: { status: 200, body: { run_id: APIFY_RUN_ID, datasetId: 'ds-other', items: [] } } }),
    (error) => error.code === 'APIFY_DATASET_INVALID' && error.details.reason === 'dataset_mismatch' && error.details.stage === 'dataset');
  await assert.rejects(() => apifySequence({ dataset: { status: 200, body: { run_id: APIFY_RUN_ID, dataset_id: 'ds-other', items: [] } } }),
    (error) => error.code === 'APIFY_DATASET_INVALID' && error.details.reason === 'dataset_mismatch' && error.details.stage === 'dataset');
  await assert.rejects(() => runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: 't', count: 1,
    maxItems: P22_LIMITS.collect, maxTotalChargeUsd: 0.1,
    sleepImpl: async () => {}, nowImpl: () => 0,
    fetchImpl: async (url, _init) => {
      const text = String(url);
      if (text.includes('/acts/')) return fakeApifyResponse(200, { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID } });
      if (text.includes('/dataset/items')) return { ok: true, status: 200, json: async () => { throw new Error('not json'); } };
      return fakeApifyResponse(200, { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.01 } });
    },
  }), (error) => error.code === 'APIFY_DATASET_INVALID' && error.details.reason === 'unparseable');
});

test('P22 fails closed on unavailable, invalid or over-reservation cost', async () => {
  for (const usage of [null, undefined, 'abc', -0.01]) {
    await assert.rejects(() => apifySequence({ runs: [
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: usage } } },
    ] }), (error) => {
      assert.equal(error.code, 'APIFY_COST_UNVERIFIABLE', String(usage));
      assert.equal(error.details.reason, 'unavailable', String(usage));
      assert.equal(error.details.stage, 'cost');
      return true;
    });
  }
  await assert.rejects(() => apifySequence({ runs: [
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 1 } } },
  ] }),
    (error) => error.code === 'APIFY_COST_ABOVE_RESERVATION' && error.details.stage === 'cost' && error.details.run_id === 'run-a1b2');
  let runCalls = 0;
  await assert.rejects(() => runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: 't', count: 1,
    maxItems: P22_LIMITS.collect, maxTotalChargeUsd: 0.1,
    sleepImpl: async () => {}, nowImpl: () => 0,
    fetchImpl: async (url, _init) => {
      const text = String(url);
      if (text.includes('/acts/')) return fakeApifyResponse(200, { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID } });
      if (text.includes('/dataset/items')) return fakeApifyResponse(200, []);
      runCalls += 1;
      if (runCalls === 1) return fakeApifyResponse(200, { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } });
      return { ok: true, status: 200, json: async () => { throw new Error('not json'); } };
    },
  }), (error) => error.code === 'APIFY_COST_UNVERIFIABLE' && error.details.reason === 'unparseable' && error.details.stage === 'cost');
});

test('P22 stabilizes preliminary cost to a final stable value before acceptance', async () => {
  const sleeps = [];
  const { result, calls } = await apifySequence({
    runs: [
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.01 } } },
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.02 } } },
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.02 } } },
    ],
  }, { sleepImpl: async (ms) => sleeps.push(ms) });
  assert.equal(result.usageTotalUsd, 0.02, '初步值 0.01 后稳定在 0.02，才作为最终费用证据');
  assert.equal(result.runId, APIFY_RUN_ID);
  const costCalls = calls.filter((call) => call.url === `https://api.apify.com/v2/actor-runs/${APIFY_RUN_ID}`);
  assert.equal(costCalls.length, 3, '稳定读取共 3 次（含首次）');
  assert.deepEqual(sleeps, [P22_LIMITS.cost_stabilize_interval_ms, P22_LIMITS.cost_stabilize_interval_ms]);
});

test('P22 fails closed when cost never stabilizes within the bounded poll budget', async () => {
  const sleeps = [];
  let clock = 0;
  const fetchImpl = async (url, _init) => {
    const text = String(url);
    if (text.includes('/acts/')) return fakeApifyResponse(200, { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID } });
    if (text.includes('/dataset/items')) return fakeApifyResponse(200, []);
    if (text.includes('waitForFinish')) return fakeApifyResponse(200, { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } });
    clock += 1;
    return fakeApifyResponse(200, { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.01 + clock * 0.01 } });
  };
  await assert.rejects(() => runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: 't', count: 1,
    maxItems: P22_LIMITS.collect, maxTotalChargeUsd: 0.1,
    fetchImpl, sleepImpl: async (ms) => sleeps.push(ms), nowImpl: () => 0,
  }), (error) => {
    assert.equal(error.code, 'APIFY_COST_UNVERIFIABLE');
    assert.equal(error.details.reason, 'unstable');
    assert.equal(error.details.stage, 'cost');
    assert.equal(error.details.run_id, APIFY_RUN_ID);
    assert.equal(error.status, 502);
    return true;
  });
  assert.equal(sleeps.length, P22_LIMITS.cost_stabilize_polls - 1, '轮询次数确定，无无限重试');
  assert.ok(sleeps.every((ms) => Number.isFinite(ms) && ms > 0 && ms <= P22_LIMITS.cost_stabilize_interval_ms), '等待间隔有界');
});

test('P22 fails closed on decreasing or contradictory cost observations', async () => {
  await assert.rejects(() => apifySequence({ runs: [
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.02 } } },
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.01 } } },
  ] }),
    (error) => error.code === 'APIFY_COST_UNVERIFIABLE' && error.details.reason === 'decreased' && error.details.stage === 'cost' && error.details.run_id === APIFY_RUN_ID);
});

// ---------------------------------------------------------------------------
// P22 repair 4：成本阶段运行状态一致性 —— 每次成本读取都必须保持 status === 'SUCCEEDED'
// ---------------------------------------------------------------------------

/**
 * 等待成功后第一个成本读取即出现状态漂移；第二次成本读取携带相同费用，作为旧实现
 * “两次连续相等即接受稳定费用”的陷阱。序列必须失败关闭：返回错误与调用记录，
 * 绝不返回稳定费用或到达证明签发。
 */
async function costStatusDriftError(runs) {
  const boundary = apifyHarness({ runs });
  let captured = null;
  try {
    await runApifyCollectionSequence({
      token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: 't', count: 1,
      maxItems: P22_LIMITS.collect, maxTotalChargeUsd: 0.1,
      fetchImpl: boundary.fetchImpl, sleepImpl: async () => {}, nowImpl: () => 0,
    });
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, '成本阶段状态漂移必须失败关闭，绝不返回稳定费用或签发证明');
  return { error: captured, calls: boundary.calls };
}

test('P22 cost reads drifting to terminal failure statuses fail closed as bounded APIFY_RUN_FAILED', async () => {
  for (const runStatus of ['FAILED', 'ABORTED', 'TIMED-OUT']) {
    const { error, calls } = await costStatusDriftError([
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: runStatus, usageTotalUsd: 0.01 } } },
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: runStatus, usageTotalUsd: 0.01 } } },
    ]);
    assert.equal(error.code, 'APIFY_RUN_FAILED', runStatus);
    assert.equal(error.message, '采集运行未成功完成。', runStatus);
    assert.equal(error.details.stage, 'cost', runStatus);
    assert.equal(error.details.run_status, runStatus, runStatus);
    assert.equal(error.details.run_id, APIFY_RUN_ID, runStatus);
    assert.equal(error.status, 502, runStatus);
    assert.ok(!JSON.stringify(error.details).includes('usageTotalUsd'), `${runStatus}: 诊断绝不携带费用`);
    assert.ok(!JSON.stringify(error.details).includes('0.01'), `${runStatus}: 诊断绝不携带费用值`);
    const costCalls = calls.filter((call) => call.url === `https://api.apify.com/v2/actor-runs/${APIFY_RUN_ID}`);
    assert.equal(costCalls.length, 1, `${runStatus}: 首次成本读取即失败关闭，绝不再读取或到达证明签发`);
  }
});

test('P22 cost reads with missing, transitional or unknown status fail closed and never accept equal cost', async () => {
  const scenarios = [
    { status: null, reason: 'status_missing' },
    { status: 'RUNNING', reason: 'status_transitional' },
    { status: 'READY', reason: 'status_transitional' },
    { status: 'FROZEN', reason: 'status_unknown' },
  ];
  for (const scenario of scenarios) {
    const driftBody = { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, usageTotalUsd: 0.01 } };
    if (scenario.status !== null) driftBody.data.status = scenario.status;
    const { error, calls } = await costStatusDriftError([
      { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
      { status: 200, body: driftBody },
      { status: 200, body: driftBody },
    ]);
    assert.equal(error.code, 'APIFY_COST_UNVERIFIABLE', JSON.stringify(scenario));
    assert.equal(error.message, '无法验证采集费用。', JSON.stringify(scenario));
    assert.equal(error.details.stage, 'cost', JSON.stringify(scenario));
    assert.equal(error.details.reason, scenario.reason, JSON.stringify(scenario));
    assert.equal(error.details.run_id, APIFY_RUN_ID, JSON.stringify(scenario));
    if (scenario.status !== null) assert.equal(error.details.run_status, scenario.status, JSON.stringify(scenario));
    assert.equal(error.status, 502, JSON.stringify(scenario));
    assert.ok(!JSON.stringify(error.details).includes('usageTotalUsd'), `${scenario.reason}: 诊断绝不携带费用`);
    assert.ok(!JSON.stringify(error.details).includes('0.01'), `${scenario.reason}: 诊断绝不携带费用值`);
    const costCalls = calls.filter((call) => call.url === `https://api.apify.com/v2/actor-runs/${APIFY_RUN_ID}`);
    assert.equal(costCalls.length, 1, `${scenario.reason}: 首次成本读取即失败关闭`);
  }
});

test('P22 fails closed when a later cost read contradicts an earlier SUCCEEDED observation', async () => {
  const { error, calls } = await costStatusDriftError([
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED', usageTotalUsd: 0.01 } } },
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'FAILED', usageTotalUsd: 0.01 } } },
  ]);
  assert.equal(error.code, 'APIFY_RUN_FAILED');
  assert.equal(error.details.stage, 'cost');
  assert.equal(error.details.run_status, 'FAILED');
  assert.equal(error.details.run_id, APIFY_RUN_ID);
  assert.equal(error.status, 502);
  const costCalls = calls.filter((call) => call.url === `https://api.apify.com/v2/actor-runs/${APIFY_RUN_ID}`);
  assert.equal(costCalls.length, 2, '第二次成本读取出现终态失败与首次观测矛盾，必须失败关闭，绝不到达证明签发');
});

test('P22 binds dataset identity across every stage and fails closed on any mismatch', async () => {
  await assert.rejects(() => apifySequence({ start: { status: 200, body: { data: { id: APIFY_RUN_ID } } } }),
    (error) => error.code === 'APIFY_RUN_ID_INVALID' && error.details.reason === 'dataset_missing' && error.details.stage === 'start');
  await assert.rejects(() => apifySequence({ start: { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: 'bad dataset id!' } } } }),
    (error) => error.code === 'APIFY_RUN_ID_INVALID' && error.details.reason === 'dataset_malformed' && error.details.stage === 'start');
  await assert.rejects(() => apifySequence({ runs: [{ status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: 'ds-other', status: 'SUCCEEDED' } } }] }),
    (error) => error.code === 'APIFY_RUN_ID_INVALID' && error.details.reason === 'dataset_foreign' && error.details.stage === 'wait');
  await assert.rejects(() => apifySequence({ runs: [
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: APIFY_DATASET_ID, status: 'SUCCEEDED' } } },
    { status: 200, body: { data: { id: APIFY_RUN_ID, defaultDatasetId: 'ds-other', status: 'SUCCEEDED', usageTotalUsd: 0.01 } } },
  ] }),
    (error) => error.code === 'APIFY_RUN_ID_INVALID' && error.details.reason === 'dataset_foreign' && error.details.stage === 'cost');
});

test('P22 normalized empty dataset result fails closed and never reaches proof issuance', async () => {
  const { result } = await apifySequence({ dataset: { status: 200, body: [] } });
  assert.deepEqual(result.items, []);
  await assert.rejects(() => normalizeCollectedItems(result.items, {
    provider: 'apify:xquik/x-tweet-scraper', run_id: result.runId, collected_at: COLLECTED_AT,
    usage_total_usd: result.usageTotalUsd, budget_reservation_id: RESERVATION_ID,
  }, hash), (error) => error.code === 'EMPTY_PROVIDER_RESULT' && error.status === 422);
});

test('P22 keeps maxItems and maxTotalChargeUsd bounded by existing limits even for oversized callers', async () => {
  const boundary = apifyHarness({});
  await runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: 't', count: 9999,
    maxItems: 9999, maxTotalChargeUsd: 9999,
    fetchImpl: boundary.fetchImpl, sleepImpl: async () => {}, nowImpl: () => 0,
  });
  const startBody = JSON.parse(boundary.calls[0].body);
  assert.equal(startBody.maxItems, P22_LIMITS.collect);
  assert.match(boundary.calls[0].url, new RegExp(`maxTotalChargeUsd=${P22_LIMITS.apify_reservation_cny / P22_CNY_PER_USD}`));
  assert.match(boundary.calls[2].url, /limit=5&clean=true/);
});

test('P22 sends the actor exact top-level input and rejects any wrapped input regression', async () => {
  const boundary = apifyHarness({});
  await runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: '测试主题', count: 5,
    maxItems: P22_LIMITS.collect, maxTotalChargeUsd: 0.1,
    fetchImpl: boundary.fetchImpl, sleepImpl: async () => {}, nowImpl: () => 0,
  });
  const rawBody = JSON.parse(boundary.calls[0].body);
  assert.deepEqual(rawBody, { maxItems: P22_LIMITS.collect, sort: 'Latest', searchTerms: ['测试主题'] });
  assert.equal(Object.hasOwn(rawBody, 'input'), false, '请求体必须是 Actor 顶层输入，出现 input 包裹即回归');
  const core = readFileSync(join(process.cwd(), 'supabase', 'functions', 'p22-research-assist', 'assist-core.mjs'), 'utf8');
  const bodyLine = core.split('\n').find((line) => line.includes('JSON.stringify({ maxItems'));
  assert.ok(bodyLine, '启动请求体必须以顶层 Actor 输入构造');
  assert.doesNotMatch(bodyLine, /["']input["']/);
  assert.match(bodyLine, /searchTerms:\s*\[boundedTopic\]/);

  const exactBoundary = apifyHarness({ dataset: { status: 200, body: [{ id: '2087047011753467912', text: 'exact', url: 'https://x.com/huihuiyufeifei/status/2087047011753467912' }] } });
  await runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper',
    sourceUrl: 'https://x.com/huihuiyufeifei/status/2087047011753467912?s=20', count: 1,
    maxItems: P22_LIMITS.collect, maxTotalChargeUsd: 0.1,
    fetchImpl: exactBoundary.fetchImpl, sleepImpl: async () => {}, nowImpl: () => 0,
  });
  const exactBody = JSON.parse(exactBoundary.calls[0].body);
  assert.deepEqual(exactBody, { maxItems: 1, tweetIds: ['2087047011753467912'] });
  assert.equal(Object.hasOwn(exactBody, 'startUrls'), false);
  assert.equal(exactBody.tweetIds[0], '2087047011753467912');
});

test('P22 provider diagnostics never leak tokens, bodies, URLs or raw upstream responses', async () => {
  const details = providerDiagnostic({ stage: 'start', status: 401, runId: 'https://user:sekrit@api.apify.com/run?token=abc', reason: 'transport' });
  const serialized = JSON.stringify(details);
  assert.ok(!serialized.includes('sekrit'));
  assert.ok(!serialized.includes('abc'));
  assert.ok(!serialized.includes('https://'));
  assert.equal(details.run_id, undefined);
  assert.deepEqual(Object.keys(details).sort(), ['provider', 'reason', 'stage', 'status']);
  assert.equal(boundedProviderRunId('valid-run_123'), 'valid-run_123');
  assert.equal(boundedProviderRunId('run with spaces'), null);
  assert.equal(boundedProviderRunId('a'.repeat(65)), null);
  assert.equal(boundedProviderRunId(12345), null);

  await assert.rejects(() => apifySequence({ start: { status: 401, body: { error: { message: 'Bearer sekrit-raw' } } } }), (error) => {
    const serializedError = JSON.stringify(error.details);
    assert.ok(!serializedError.includes('sekrit-raw'));
    assert.ok(!serializedError.includes('apify-test-token'));
    assert.deepEqual(Object.keys(error.details).sort(), ['provider', 'stage', 'status']);
    assert.equal(error.message, '公开来源服务拒绝请求。');
    return true;
  });
});

test('P22 browser service preserves bounded code, stage and safe status on non-2xx Edge responses', async () => {
  const session = { auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } }, error: null }) } };
  const httpError = (status, body) => ({
    message: 'Edge Function returned a non-2xx status code',
    context: { status, json: async () => body },
  });
  const bounded = createP22ResearchAssistClient({
    client: { ...session, functions: { invoke: async () => ({ data: null, error: httpError(502, { ok: false, code: 'APIFY_UPSTREAM_REJECTED', message: '公开来源服务拒绝请求。', details: { provider: 'apify', stage: 'start', status: 502, run_id: 'run-a1b2' } }) }) } },
  });
  await assert.rejects(() => bounded.collect('topic', 3), (error) => {
    assert.equal(error.code, 'APIFY_UPSTREAM_REJECTED');
    assert.equal(error.message, '公开来源服务拒绝请求。');
    assert.equal(error.status, 502);
    assert.deepEqual(error.details, { provider: 'apify', stage: 'start', status: 502, run_id: 'run-a1b2' });
    return true;
  });
  const opaque = createP22ResearchAssistClient({
    client: { ...session, functions: { invoke: async () => ({ data: null, error: httpError(502, '<html>gateway error</html>') }) } },
  });
  await assert.rejects(() => opaque.status(), (error) => {
    assert.equal(error.code, 'P22_UPSTREAM_UNAVAILABLE');
    assert.equal(error.status, 502);
    assert.ok(!error.message.includes('non-2xx'));
    assert.ok(error.message.includes('暂时不可用'));
    return true;
  });
  const noisy = createP22ResearchAssistClient({
    client: { ...session, functions: { invoke: async () => ({ data: null, error: httpError(503, { ok: false, code: 'APIFY_RUN_FAILED', message: '采集运行未成功完成。', details: { token: 'sekrit-token', body: '<leak>', provider: 'apify', run_id: 'run-a1b2', run_status: 'FAILED', reason: 'x'.repeat(200) } }) }) } },
  });
  await assert.rejects(() => noisy.collect('topic', 3), (error) => {
    assert.deepEqual(error.details, { provider: 'apify', run_id: 'run-a1b2', run_status: 'FAILED' });
    assert.ok(!JSON.stringify(error.details).includes('sekrit-token'));
    assert.equal(error.status, 503);
    return true;
  });
  const network = createP22ResearchAssistClient({
    client: { ...session, functions: { invoke: async () => ({ data: null, error: new Error('Failed to fetch') }) } },
  });
  await assert.rejects(() => network.status(), (error) => {
    assert.equal(error.code, 'P22_UPSTREAM_UNAVAILABLE');
    assert.ok(!error.message.includes('Failed to fetch'));
    return true;
  });
});

test('P22 records bounded cost before the documented Apify sequence and issues proofs only after success', () => {
  const edge = readFileSync(join(process.cwd(), 'supabase', 'functions', 'p22-research-assist', 'index.ts'), 'utf8');
  const core = readFileSync(join(process.cwd(), 'supabase', 'functions', 'p22-research-assist', 'assist-core.mjs'), 'utf8');
  assert.ok(!edge.includes('x-apify-actor-run-id'), 'index.ts 不得再引用未文档化响应头');
  assert.ok(!/headers\s*\.\s*get\s*\(\s*['"]x-apify-actor-run-id/i.test(core), '适配器不得读取未文档化响应头');
  assert.ok(!edge.includes('run-sync-get-dataset-items'));
  assert.ok(!core.includes('run-sync-get-dataset-items'));
  const collectBody = edge.slice(edge.indexOf('async function collect'), edge.indexOf('async function analyze'));
  const reserveAt = collectBody.indexOf("recordProviderCost(db,userId,'apify'");
  const adapterAt = collectBody.indexOf('runApifyCollectionSequence(');
  const normalizeAt = collectBody.indexOf('normalizeCollectedItems(');
  const proofAt = collectBody.indexOf('issueCollectionProof(');
  assert.ok(reserveAt >= 0 && reserveAt < adapterAt, '预留必须发生在 Apify 序列之前');
  assert.ok(adapterAt >= 0 && adapterAt < normalizeAt && normalizeAt < proofAt, '证明只能在成功采集并规范化之后签发');
  assert.ok(!collectBody.includes('qwen'), 'collect 路径绝不预留 Qwen');
  assert.ok(!collectBody.includes('fetch('), 'collect 路径不直接发起上游请求');
  assert.ok(!/p22_(release|refund|delete)\w*/i.test(edge), '不存在释放、退款或删除预留的调用');
  assert.ok(!/\.delete\(/.test(edge));
  const analyzeBody = edge.slice(edge.indexOf('async function analyze'), edge.indexOf('Deno.serve'));
  assert.ok(analyzeBody.indexOf('verifyAnalyzeSources') < analyzeBody.indexOf("recordProviderCost(db,userId,'qwen'"), '分析必须先验证来源证明再记录 Qwen 费用');
  assert.ok(analyzeBody.indexOf("recordProviderCost(db,userId,'qwen'") < analyzeBody.indexOf('fetch('), '分析必须记录 Qwen 费用后再调用模型');
});

test('P22 Edge TypeScript parses locally without secrets or network', async () => {
  // index.ts 是 Deno 宿主包装器：本地用 tsc（TS7 原生编译器，纯解析不联网）检查语法。
  // 远程 esm.sh 导入替换为同目录无类型 stub，assist-core.mjs 原样复制，Deno 用环境声明补齐。
  const dir = await mkdtemp(join(tmpdir(), 'ams-p22-edge-tsc-'));
  try {
    const source = readFileSync(join(process.cwd(), 'supabase', 'functions', 'p22-research-assist', 'index.ts'), 'utf8');
    const rewritten = source.replace("from 'https://esm.sh/@supabase/supabase-js@2.110.7'", "from './stub.mjs'");
    await writeFile(join(dir, 'index.ts'), rewritten);
    await writeFile(join(dir, 'stub.mjs'), 'export const createClient = (...args) => null;\n');
    await writeFile(join(dir, 'deno.d.ts'), 'declare const Deno: any;\n');
    await writeFile(join(dir, 'assist-core.mjs'), readFileSync(join(process.cwd(), 'supabase', 'functions', 'p22-research-assist', 'assist-core.mjs'), 'utf8'));
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        noEmit: true, skipLibCheck: true, allowJs: true, checkJs: false, strict: false, noImplicitAny: false,
        module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', lib: ['ES2022', 'DOM'],
      },
      include: ['index.ts', 'deno.d.ts'],
    }));
    const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', dir], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `Edge TypeScript parse failed:\n${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function browserPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function browserWait(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function browserJson(response, status, body, origin = '') {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': origin || 'http://127.0.0.1',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  response.end(JSON.stringify(body));
}

async function browserBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function browserProject(raw, id) {
  return {
    schema_version: 'p19_research_project_v1', id, version: 1, status: 'active',
    topic: raw.topic, objective: raw.objective, audience: raw.audience, channel: raw.channel,
    constraints: raw.constraints || [],
    execution_flags: { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false },
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
    evidence: [], analyses: [], knowledge_cards: [], brief: null, handoff: null, handoffs: [], lineage: null,
    fingerprint: 'a'.repeat(64),
  };
}

function p22BrowserBoundary() {
  let project = null;
  let evidenceAttempts = 0;
  let failNextProjectRead = false;
  let created = 0;
  const p22Requests = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (request.method === 'OPTIONS') return browserJson(response, 200, {}, origin);
    if (request.url === '/auth/v1/user') return browserJson(response, 200, {
      id: '11111111-1111-4111-8111-111111111111', email: 'p22-browser@example.invalid',
      aud: 'authenticated', role: 'authenticated', user_metadata: { user_name: 'p22-browser' },
    }, origin);
    if (request.url?.startsWith('/rest/v1/')) return browserJson(response, 200, request.headers.accept?.includes('object+json') ? {} : [], origin);
    if (request.url === '/functions/v1/p22-research-assist' && request.method === 'POST') {
      const body = await browserBody(request);
      p22Requests.push(body);
      const base = {
        ok: true, schema_version: 'p22_research_assist_v1', role: 'operator',
        execution_flags: { generation_executed: false, routing_executed: false, external_job_created: false, publish_executed: false },
      };
      if (body.action === 'status') return browserJson(response, 200, {
        ...base, capabilities: { apify_configured: true, qwen_configured: false },
        cost_tracking: { daily_cap_enabled: false, apify: { recorded_cny: 12 }, qwen: { recorded_cny: 11 } },
      }, origin);
      if (body.action === 'collect') return browserJson(response, 200, {
        ...base, action: 'collect', cost: { recorded_cny: 0.1 },
        items: [{
          id: 'p22-browser-source-a', external_id: '1900000000000000001',
          source_url: 'https://x.com/example/status/1900000000000000001', label: 'Project A source preview',
          content_text: 'Project A collected preview must never survive a project switch.', content_sha256: 'a'.repeat(64),
          collection_proof: `1999999999.${'b'.repeat(64)}`, provenance: { run_id: 'p22-browser-run-a' },
        }],
      }, origin);
      if (body.action === 'collect_url') {
        const content = 'Exact URL evidence enters the knowledge chain.';
        const contentSha = createHash('sha256').update(content).digest('hex');
        return browserJson(response, 200, {
          ...base, action: 'collect_url', cost: { recorded_cny: 0.1 },
          items: [{
            id: `p22-${contentSha.slice(0, 24)}`, external_id: '1900000000000000002',
            source_url: 'https://x.com/example/status/1900000000000000002', label: 'Exact URL source',
            platform: 'x', content_text: content, content_sha256: contentSha,
            collection_proof: `1999999999.${'c'.repeat(64)}`,
            provenance: {
              schema_version: 'p22_collected_source_v1', provider: 'apify:xquik/x-tweet-scraper',
              run_id: 'p22-browser-url-run', collected_at: '2026-08-12T00:00:00.000Z', usage_total_usd: 0.01,
              budget_reservation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
            },
          }],
        }, origin);
      }
      return browserJson(response, 400, { ok: false, code: 'UNKNOWN_ACTION', message: 'Unsupported action.' }, origin);
    }
    if (request.url === '/functions/v1/p19-workspace-command' && request.method === 'POST') {
      const body = await browserBody(request);
      const envelope = { ok: true, schema_version: 'p19_command_contract_v1', command: body.command, applied: false };
      if (body.command === 'project.list') return browserJson(response, 200, { ...envelope, read_only: true, data: { projects: project ? [{ id: project.id, topic: project.topic, status: project.status }] : [] } }, origin);
      if (body.command === 'project.read') {
        if (failNextProjectRead) { failNextProjectRead = false; return browserJson(response, 503, { ok: false, code: 'SYNTHETIC_RECOVERY_READ_FAILURE', message: 'Synthetic recovery read failure.' }, origin); }
        return browserJson(response, 200, { ...envelope, read_only: true, data: { project } }, origin);
      }
      if (body.command === 'project.create') {
        created += 1;
        project = browserProject(body.payload.project, created === 1 ? 'prj-0123456789abcdef01234567' : 'prj-1123456789abcdef01234567');
        return browserJson(response, 200, { ...envelope, applied: true, entity: { type: 'project', id: project.id } }, origin);
      }
      if (body.command === 'evidence.create') {
        evidenceAttempts += 1;
        const canonical = {
          ...body.payload.evidence,
          id: `ev-${createHash('sha256').update(`${body.payload.evidence.source_url}|${body.payload.evidence.content_text}`).digest('hex').slice(0, 24)}`,
          fingerprint: 'e'.repeat(64),
        };
        const existing = project.evidence.find((row) => row.id === canonical.id);
        if (existing && (existing.source_url !== canonical.source_url || existing.provenance?.content_sha256 !== canonical.provenance?.content_sha256)) {
          return browserJson(response, 409, { ok: false, code: 'P22_EVIDENCE_IDENTITY_CONFLICT', message: 'Synthetic identity conflict.' }, origin);
        }
        if (!existing) project = { ...project, evidence: [...project.evidence, canonical], version: project.version + 1, fingerprint: 'b'.repeat(64) };
        if (evidenceAttempts === 1) {
          failNextProjectRead = true;
          return browserJson(response, 503, { ok: false, code: 'SYNTHETIC_RESPONSE_LOST', message: 'Synthetic response lost after apply.' }, origin);
        }
        return browserJson(response, 200, { ...envelope, applied: true, entity: { type: 'evidence', id: canonical.id } }, origin);
      }
      if (body.command === 'analysis.create') {
        const canonical = { ...body.payload.analysis, id: `an-${'1'.repeat(24)}`, fingerprint: 'f'.repeat(64) };
        project = { ...project, analyses: [...project.analyses.filter((row) => row.id !== canonical.id), canonical], version: project.version + 1, fingerprint: 'c'.repeat(64) };
        return browserJson(response, 200, { ...envelope, applied: true, entity: { type: 'analysis', id: canonical.id } }, origin);
      }
      if (body.command === 'card.create') {
        const canonical = { ...body.payload.card, id: `kc-${'2'.repeat(24)}`, fingerprint: '9'.repeat(64) };
        project = { ...project, knowledge_cards: [...project.knowledge_cards.filter((row) => row.id !== canonical.id), canonical], version: project.version + 1, fingerprint: 'd'.repeat(64) };
        return browserJson(response, 200, { ...envelope, applied: true, entity: { type: 'card', id: canonical.id } }, origin);
      }
      if (body.command === 'brief.assemble') {
        const canonical = { ...body.payload.brief, id: `brief-${'3'.repeat(24)}`, fingerprint: '8'.repeat(64) };
        canonical.review = { ...canonical.review, brief_id: canonical.id };
        project = { ...project, brief: canonical, version: project.version + 1, fingerprint: '7'.repeat(64) };
        return browserJson(response, 200, { ...envelope, applied: true, entity: { type: 'brief', id: canonical.id } }, origin);
      }
      if (body.command === 'brief.decide') {
        const value = body.payload.decision.value;
        project = {
          ...project,
          brief: {
            ...project.brief,
            status: value === 'approved' ? 'approved' : 'returned',
            review: {
              ...project.brief.review,
              decision: { ...body.payload.decision, source: 'local_manual' },
              comments: body.payload.decision.comments || [],
            },
            fingerprint: '6'.repeat(64),
          },
          version: project.version + 1,
          fingerprint: '5'.repeat(64),
        };
        return browserJson(response, 200, { ...envelope, applied: true, entity: { type: 'brief', id: project.brief.id } }, origin);
      }
      if (body.command === 'handoff.create') {
        const canonical = { ...body.payload.handoff, id: `handoff-pkg-${'4'.repeat(24)}`, fingerprint: '4'.repeat(64) };
        project = { ...project, handoff: canonical, handoffs: [canonical], version: project.version + 1, fingerprint: '3'.repeat(64) };
        return browserJson(response, 200, { ...envelope, applied: true, entity: { type: 'handoff', id: canonical.id } }, origin);
      }
      return browserJson(response, 400, { ok: false, code: 'UNKNOWN_COMMAND', message: 'Unsupported command.' }, origin);
    }
    return browserJson(response, 404, { code: 'NOT_FOUND' }, origin);
  });
  return { server, p22Requests, getProject: () => project };
}

class BrowserCdp {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => killer.once('close', resolve));
  await sleep(150);
}

test('P22 real production page clears preview state when switching projects', { timeout: 75_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required for the real-browser acceptance');
  const boundaryPort = await browserPort(); const vitePort = await browserPort(); const debugPort = await browserPort();
  const boundary = p22BrowserBoundary();
  await new Promise((resolve) => boundary.server.listen(boundaryPort, '127.0.0.1', resolve));
  const profile = await mkdtemp(join(tmpdir(), 'ams-p22-browser-'));
  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, VITE_SUPABASE_URL: `http://127.0.0.1:${boundaryPort}`, VITE_SUPABASE_ANON_KEY: 'p22-public-browser-test-key' },
    stdio: 'ignore', windowsHide: true,
  });
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}/ai-marketing-studio/`;
    await browserWait(async () => (await fetch(baseUrl)).ok, 'Vite route');
    const target = await browserWait(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (!response.ok) return null;
      return (await response.json()).find((item) => item.type === 'page');
    }, 'Edge target');
    cdp = new BrowserCdp(target.webSocketDebuggerUrl); await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: baseUrl });
    await browserWait(() => cdp.evaluate('document.readyState === "complete"'), 'base page');
    const payload = Buffer.from(JSON.stringify({ sub: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.p22`;
    const auth = await cdp.evaluate(`(async () => { const { supabase } = await import('/ai-marketing-studio/src/services/supabase-client.js'); const { data, error } = await supabase.auth.setSession({ access_token: ${JSON.stringify(token)}, refresh_token: 'p22-browser-refresh' }); return { ok: !error && Boolean(data?.session?.user?.id) }; })()`);
    assert.deepEqual(auth, { ok: true });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await browserWait(() => cdp.evaluate(`Boolean([...document.querySelectorAll('button')].find((button) => button.textContent.includes('新建项目')))`), 'research page');
    const createProject = async (values) => {
      await browserWait(() => cdp.evaluate(`Boolean(document.querySelector('.p19-project-bar button.p19-btn-primary')) && !document.querySelector('.p19-project-bar button.p19-btn-primary').disabled`), 'new project action');
      await cdp.evaluate(`document.querySelector('.p19-project-bar button.p19-btn-primary').click()`);
      await browserWait(() => cdp.evaluate(`Boolean(document.querySelector('.p19-create-panel form'))`), 'project form');
      await cdp.evaluate(`(() => { const fields=[...document.querySelectorAll('.p19-create-panel input, .p19-create-panel textarea')]; const values=${JSON.stringify(values)}; fields.forEach((field,index)=>{ const proto=field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(field,values[index]); field.dispatchEvent(new Event('input',{bubbles:true})); }); document.querySelector('.p19-create-panel button[type="submit"]').click(); })()`);
    };
    await createProject(['Project A', 'Collect preview', 'Team A', 'X', 'A only']);
    await browserWait(() => cdp.evaluate(`Boolean(document.querySelector('.p22-query-row input')) && !document.querySelector('.p22-query-row button').disabled`), 'P22 capability');
    await cdp.evaluate(`document.querySelector('.p22-query-row button').click()`);
    await browserWait(() => cdp.evaluate(`document.querySelectorAll('.p22-source-card').length===1 && document.body.innerText.includes('Project A source preview')`), 'A preview');
    await cdp.evaluate(`(() => { const input=document.querySelector('.p22-query-row input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'https://x.com/example/status/1900000000000000002'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await browserWait(() => cdp.evaluate(`document.querySelector('.p22-query-row button').textContent.includes('读取这条帖子')`), 'exact URL mode');
    await cdp.evaluate(`document.querySelector('.p22-query-row button').click()`);
    await browserWait(() => cdp.evaluate(`document.body.innerText.includes('Exact URL source')`), 'exact URL preview');
    await cdp.evaluate(`[...document.querySelectorAll('.p22-source-card button')].find((button) => button.textContent.includes('保存并生成可审核 Brief')).click()`);
    await browserWait(() => boundary.getProject()?.evidence.length === 1 && boundary.getProject()?.analyses.length === 0, 'partial Evidence persistence');
    await sleep(750);
    const retryState = await cdp.evaluate(`(() => { const button=document.querySelector('.p22-source-card button'); return { exists:Boolean(button), disabled:button?.disabled, cards:document.querySelectorAll('.p22-source-card').length, busy:document.body.innerText.includes('正在执行'), text:button?.textContent || '', alert:document.querySelector('[role="alert"]')?.textContent || '' }; })()`);
    assert.equal(retryState.exists, true, `partial-success source card disappeared: ${JSON.stringify(retryState)}`);
    assert.equal(retryState.disabled, false, `partial-success retry stayed disabled: ${JSON.stringify(retryState)}`);
    await cdp.evaluate(`document.querySelector('.p22-source-card button').click()`);
    await browserWait(() => cdp.evaluate(`document.body.innerText.includes('Evidence → 确定性分析 → Knowledge Card → 可审核 Brief')`), 'reviewable brief chain completion');
    assert.equal(boundary.getProject().evidence.length, 1);
    assert.equal(boundary.getProject().analyses.length, 1);
    assert.equal(boundary.getProject().knowledge_cards.length, 1);
    assert.equal(boundary.getProject().brief.status, 'pending_review');
    assert.equal(boundary.getProject().analyses[0].evidence_id, boundary.getProject().evidence[0].id);
    assert.equal(boundary.getProject().knowledge_cards[0].analysis_id, boundary.getProject().analyses[0].id);
    await browserWait(() => cdp.evaluate(`Boolean([...document.querySelectorAll('button')].find((button) => button.textContent.includes('批准 Brief')))`), 'brief review controls');
    await cdp.evaluate(`(() => { const field=document.querySelector('.p19-brief-actions textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(field,'来源和知识绑定已人工核对'); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await browserWait(() => cdp.evaluate(`!([...document.querySelectorAll('button')].find((button) => button.textContent.includes('批准 Brief'))?.disabled)`), 'review rationale gate');
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('批准 Brief')).click()`);
    await browserWait(() => boundary.getProject()?.brief?.status === 'approved', 'online manual Brief approval');
    await browserWait(() => cdp.evaluate(`Boolean(document.querySelector('#p21-step-handoff button.p19-btn-primary')) && !document.querySelector('#p21-step-handoff button.p19-btn-primary').disabled`), 'handoff action');
    await cdp.evaluate(`document.querySelector('#p21-step-handoff button.p19-btn-primary').click()`);
    await browserWait(() => Boolean(boundary.getProject()?.handoff), 'online handoff persistence');
    assert.equal(boundary.getProject().handoff.brief_provenance.brief_id, boundary.getProject().brief.id);
    assert.equal(boundary.getProject().handoff.evidence_provenance.local_only, false);
    assert.deepEqual(boundary.getProject().handoff.execution_flags, { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false });
    await cdp.send('Page.reload', { ignoreCache: true });
    await browserWait(() => cdp.evaluate(`document.body.textContent.includes(${JSON.stringify(`handoff-pkg-${'4'.repeat(24)}`)})`), 'handoff survives reload');
    await browserWait(() => cdp.evaluate(`!document.querySelector('.p19-project-bar button.p19-btn-primary').disabled`), 'review save completion');
    await createProject(['Project B', 'Clean scope', 'Team B', 'Research', 'No A state']);
    await browserWait(() => cdp.evaluate(`document.body.innerText.includes('Project B') && document.querySelectorAll('.p22-source-card').length===0`), 'B clean state');
    assert.equal(await cdp.evaluate(`document.querySelector('.p22-query-row input').value`), 'Project B');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('Project A source preview')`), false);
    assert.equal(boundary.p22Requests.filter((item) => item.action === 'collect').length, 1);
    assert.equal(boundary.p22Requests.filter((item) => item.action === 'collect_url').length, 1);
  } finally {
    cdp?.close(); await stopProcess(edge); await stopProcess(vite);
    await new Promise((resolve) => boundary.server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('P22 collection proof uses a dedicated cross-function secret, never the database service key', () => {
  const assistEdge = readFileSync(join(process.cwd(), 'supabase', 'functions', 'p22-research-assist', 'index.ts'), 'utf8');
  const commandEdge = readFileSync(join(process.cwd(), 'supabase', 'functions', 'p19-workspace-command', 'index.ts'), 'utf8');
  assert.match(assistEdge, /Deno\.env\.get\('P22_COLLECTION_PROOF_SECRET'\)/);
  assert.match(commandEdge, /Deno\.env\.get\('P22_COLLECTION_PROOF_SECRET'\)/);
  assert.doesNotMatch(assistEdge, /proofSecret\s*:\s*service/);
  assert.doesNotMatch(commandEdge, /verifyP22EvidenceRecord\(serviceKey/);
});
