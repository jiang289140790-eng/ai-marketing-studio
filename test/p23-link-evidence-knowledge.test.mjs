import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertUniqueRawCollectedPost,
  bindExactCollectedPost,
  identifyPublicPostUrl,
  issueCollectionProof,
  parseP22Request,
  runApifyCollectionSequence,
} from '../supabase/functions/p22-research-assist/assist-core.mjs';
import { sha256Hex } from '../src/services/p19-contracts.js';
import { looksLikePublicUrl, toP19EvidenceInput } from '../src/services/p22-research-assist.js';
import {
  addEvidence,
  buildKnowledgeCard,
  createProject,
  runAnalysis,
} from '../src/services/p19-workspace-service.js';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(payload)) };
}

test('P23 identifies and canonicalizes one exact X post, never a profile or search URL', () => {
  assert.equal(looksLikePublicUrl('https://x.com/example/status/1234567890'), true);
  assert.equal(looksLikePublicUrl('http://x.com/example/status/1234567890'), true, 'unsafe URL-like input must still reach fail-closed URL validation');
  assert.equal(looksLikePublicUrl('x.com/example/status/1234567890'), true, 'bare social URL-like input must not become a broad keyword search');
  assert.equal(looksLikePublicUrl('reddit.com/r/test/comments/abc/post'), true);
  assert.equal(looksLikePublicUrl('linkedin.com/posts/example_abc'), true);
  assert.equal(looksLikePublicUrl('research topic'), false);
  assert.deepEqual(identifyPublicPostUrl('https://twitter.com/example/status/1234567890?s=20#x'), {
    platform: 'x', supported: true, canonical_url: 'https://x.com/i/web/status/1234567890', external_id: '1234567890',
  });
  assert.deepEqual(parseP22Request({ action: 'collect_url', url: 'https://x.com/example/status/1234567890' }), {
    action: 'collect_url', url: 'https://x.com/i/web/status/1234567890', platform: 'x', external_id: '1234567890', count: 1,
  });
  assert.throws(() => parseP22Request({ action: 'collect_url', url: 'https://x.com/example' }), { code: 'INVALID_POST_URL' });
  assert.throws(() => parseP22Request({ action: 'collect_url', url: 'http://x.com/example/status/1234567890' }), { code: 'INVALID_SOURCE_URL' });
  assert.throws(() => parseP22Request({ action: 'collect_url', url: 'https://x.com/search?q=test' }), { code: 'INVALID_POST_URL' });
  assert.throws(() => parseP22Request({ action: 'collect_url', url: 'https://www.tiktok.com/@example/video/1' }), { code: 'UNSUPPORTED_PLATFORM' });
  assert.throws(() => parseP22Request({ action: 'collect_url', url: 'https://x.com/example/status/123', extra: true }), { code: 'UNKNOWN_FIELD' });
});

test('P23 sends one exact post through Actor startUrls and keeps the existing bounded cost sequence', async () => {
  const calls = [];
  let costReads = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    if (String(url).includes('/acts/')) return response({ data: { id: 'run_p23', defaultDatasetId: 'dataset_p23' } });
    if (String(url).includes('/dataset/items')) return response([{ id: '1234567890', text: 'Exact public post', url: 'https://x.com/example/status/1234567890' }]);
    if (String(url).includes('/actor-runs/')) {
      costReads += 1;
      return response({ data: { id: 'run_p23', defaultDatasetId: 'dataset_p23', status: 'SUCCEEDED', usageTotalUsd: costReads > 1 ? 0.01 : undefined } });
    }
    throw new Error('unexpected request');
  };
  const result = await runApifyCollectionSequence({
    token: 'synthetic-token', actorId: 'xquik/x-tweet-scraper', sourceUrl: 'https://x.com/example/status/1234567890', count: 1,
    maxItems: 5, maxTotalChargeUsd: 0.1, fetchImpl, sleepImpl: async () => {}, nowImpl: () => 0,
  });
  assert.deepEqual(JSON.parse(calls[0].body), {
    maxItems: 1, startUrls: [{ url: 'https://x.com/i/web/status/1234567890' }],
  });
  assert.equal(result.runId, 'run_p23');
  assert.equal(result.items.length, 1);
});

test('P23 exact result binding fails closed for wrong, missing and duplicate post identities', () => {
  const requested = { canonical_url: 'https://x.com/i/web/status/1234567890' };
  const exact = { external_id: '1234567890', source_url: 'https://x.com/example/status/1234567890' };
  assert.deepEqual(bindExactCollectedPost([exact], requested), [exact]);
  assert.throws(() => bindExactCollectedPost([], requested), { code: 'POST_NOT_FOUND' });
  assert.throws(() => bindExactCollectedPost([{ ...exact, external_id: '999', source_url: 'https://x.com/example/status/999' }], requested), { code: 'POST_NOT_FOUND' });
  assert.throws(() => bindExactCollectedPost([exact, { ...exact }], requested), { code: 'AMBIGUOUS_POST_RESULT' });
  assert.equal(assertUniqueRawCollectedPost([{ id: '1234567890', url: exact.source_url, text: 'exact' }], requested), true);
  assert.throws(() => assertUniqueRawCollectedPost([
    { id: '1234567890', url: exact.source_url, text: 'exact' },
    { id: '1234567890', url: exact.source_url, text: 'duplicate' },
  ], requested), { code: 'AMBIGUOUS_POST_RESULT' });
  assert.throws(() => assertUniqueRawCollectedPost([
    { id: '1234567890', url: exact.source_url, text: 'exact' },
    ...Array.from({ length: 4 }, () => ({ resultType: 'diagnostic' })),
    { id: '1234567890', url: exact.source_url, text: 'hidden duplicate' },
  ], requested), { code: 'PROVIDER_RESULT_LIMIT_EXCEEDED' });
});

test('P23 confirmed source becomes exact Evidence, deterministic Analysis and Knowledge Card', async () => {
  const content = 'A concrete post with a strong hook, evidence, and a clear call to action.';
  const contentHash = await sha256Hex(content);
  const item = {
    id: `p22-${contentHash.slice(0, 24)}`,
    source_url: 'https://x.com/example/status/1234567890',
    label: 'Exact post', platform: 'x', content_text: content, external_id: '1234567890', content_sha256: contentHash,
    provenance: {
      schema_version: 'p22_collected_source_v1', provider: 'apify:xquik/x-tweet-scraper', run_id: 'run_p23',
      collected_at: '2026-08-12T03:00:00.000Z', usage_total_usd: 0.01,
      budget_reservation_id: '11111111-1111-4111-8111-111111111111',
    },
  };
  item.collection_proof = await issueCollectionProof('p23-synthetic-proof-secret-32-bytes-minimum', 'synthetic-user', item, { nowMs: Date.parse('2026-08-12T02:59:00.000Z') });
  const project = await createProject({ topic: 'P23 exact post', objective: 'Build attributable knowledge', audience: 'operator', channel: 'X', constraints: [] });
  const withEvidence = await addEvidence(project, await toP19EvidenceInput(item));
  const evidence = withEvidence.evidence[0];
  const replayed = await addEvidence(withEvidence, await toP19EvidenceInput(item));
  assert.equal(replayed.evidence.length, 1, 'same source and hash must replay idempotently');
  assert.equal(replayed.evidence[0].id, evidence.id);
  const otherSource = {
    ...item,
    id: `${item.id}-other`,
    source_url: 'https://x.com/other/status/2234567890',
    external_id: '2234567890',
    provenance: { ...item.provenance, run_id: 'run_p23_other' },
  };
  otherSource.collection_proof = await issueCollectionProof('p23-synthetic-proof-secret-32-bytes-minimum', 'synthetic-user', otherSource);
  const withOtherSource = await addEvidence(replayed, await toP19EvidenceInput(otherSource));
  assert.equal(withOtherSource.evidence.length, 2, 'same content at another source remains separately attributable');

  const changedContent = `${content} Updated.`;
  const changedHash = await sha256Hex(changedContent);
  const changedSourceVersion = {
    ...item,
    id: `p22-${changedHash.slice(0, 24)}`,
    content_text: changedContent,
    content_sha256: changedHash,
    provenance: { ...item.provenance, run_id: 'run_p23_changed' },
  };
  changedSourceVersion.collection_proof = await issueCollectionProof('p23-synthetic-proof-secret-32-bytes-minimum', 'synthetic-user', changedSourceVersion);
  const withChangedVersion = await addEvidence(withOtherSource, await toP19EvidenceInput(changedSourceVersion));
  assert.equal(withChangedVersion.evidence.length, 3, 'same source with changed content becomes a distinct immutable version');
  assert.notEqual(withChangedVersion.evidence[2].id, evidence.id);
  const withAnalysis = await runAnalysis(withEvidence, evidence.id);
  const analysis = withAnalysis.analyses[0];
  const withCard = await buildKnowledgeCard(withAnalysis, analysis.id);
  const card = withCard.knowledge_cards[0];
  assert.equal(analysis.evidence_id, evidence.id);
  assert.equal(card.analysis_id, analysis.id);
  assert.ok(card.evidence_links.every((link) => link.source_ref === evidence.id));
  assert.equal(evidence.provenance.external_id, '1234567890');
  assert.equal(evidence.provenance.content_sha256, contentHash);
});

test('P23 production page performs the confirmed Evidence → Analysis → Knowledge chain', () => {
  const page = readFileSync(join(process.cwd(), 'src', 'pages', 'ResearchWorkspacePage.jsx'), 'utf8');
  const panel = readFileSync(join(process.cwd(), 'src', 'components', 'integrated-workspace', 'P22ResearchAssistPanel.jsx'), 'utf8');
  assert.match(page, /addEvidence\(project, input\)/);
  assert.match(page, /runAnalysis\(persistedEvidence, evidence\.id\)/);
  assert.match(page, /buildKnowledgeCard\(persistedAnalysis, analysis\.id\)/);
  assert.match(panel, /collectUrl\(topic\.trim\(\)\)/);
  assert.match(panel, /Evidence、确定性分析和 Knowledge Card/);
});
