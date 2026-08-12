import test from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex } from '../src/services/p19-contracts.js';
import {
  addEvidence,
  assembleBrief,
  buildKnowledgeCard,
  buildProjectWorkflowState,
  computeStaleness,
  createProject,
  deriveHandoffPackage,
  reviewBrief,
  runAnalysis,
} from '../src/services/p19-workspace-service.js';
import { buildProjectLineageRow } from '../src/services/p19-lineage.js';

async function addManualSource(project, suffix) {
  const body = `Manual evidence ${suffix}`;
  const hash = await sha256Hex(body);
  return addEvidence(project, {
    source_url: `https://example.com/manual/${suffix}`,
    label: `Manual ${suffix}`,
    platform: 'manual',
    content_text: body,
    recorded_at: '2026-08-12T08:00:00.000Z',
    provenance: { manual: true, method: 'manual_entry', statement: 'manual source' },
    media_metadata: { filename: '', mime_type: '', byte_size: 0, last_modified: '', sha256: hash },
  });
}

async function addCollectedSource(project, suffix) {
  const body = `Collected evidence ${suffix}`;
  const contentHash = await sha256Hex(body);
  return addEvidence(project, {
    source_url: `https://x.com/example/status/${suffix}`,
    label: `Collected ${suffix}`,
    platform: 'X 路 Apify',
    content_text: body,
    recorded_at: '2026-08-12T08:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false, method: 'apify_public_collection',
      provider: 'apify:xquik/x-tweet-scraper', source_platform: 'x', source_id: `p22-${contentHash.slice(0, 24)}`,
      external_id: String(suffix), source_url: `https://x.com/example/status/${suffix}`, run_id: `run-${suffix}`,
      collected_at: '2026-08-12T08:00:00.000Z', usage_total_usd: 0.01,
      budget_reservation_id: '55555555-5555-4555-8555-555555555555', content_sha256: contentHash,
      collection_proof: `1999999999.${'5'.repeat(64)}`, statement: 'server-bound source',
    },
    media_metadata: { filename: `${suffix}.txt`, mime_type: 'text/plain', byte_size: body.length, last_modified: '2026-08-12T08:00:00.000Z', sha256: contentHash },
  });
}

test('P24 deterministically turns collected-source knowledge into a reviewable and approved Brief', async () => {
  let project = await createProject({ topic: 'P24', objective: 'Review a sourced campaign direction', audience: 'operator', channel: 'X', constraints: [] });
  const body = 'A sourced public post with a concrete hook and supporting evidence.';
  const contentHash = await sha256Hex(body);
  project = await addEvidence(project, {
    source_url: 'https://x.com/example/status/24001', label: 'P24 source', platform: 'X · Apify', content_text: body,
    recorded_at: '2026-08-12T08:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false, method: 'apify_public_collection',
      provider: 'apify:xquik/x-tweet-scraper', source_platform: 'x', source_id: `p22-${contentHash.slice(0, 24)}`,
      external_id: '24001', source_url: 'https://x.com/example/status/24001', run_id: 'run-p24',
      collected_at: '2026-08-12T08:00:00.000Z', usage_total_usd: 0.01,
      budget_reservation_id: '44444444-4444-4444-8444-444444444444', content_sha256: contentHash,
      collection_proof: `1999999999.${'4'.repeat(64)}`, statement: 'server-bound source',
    },
    media_metadata: { filename: 'p24.txt', mime_type: 'text/plain', byte_size: body.length, last_modified: '2026-08-12T08:00:00.000Z', sha256: contentHash },
  });
  project = await runAnalysis(project, project.evidence[0].id);
  project = await buildKnowledgeCard(project, project.analyses[0].id);
  project = await assembleBrief(project, { now: () => '2026-08-12T08:01:00.000Z' });
  assert.equal(project.brief.status, 'pending_review');
  assert.equal(project.brief.evidence_provenance.local_only, false);
  assert.match(project.brief.evidence_provenance.statement, /服务端来源证明/);
  assert.deepEqual(project.brief.knowledge_citation_ids, [project.knowledge_cards[0].id]);
  let workflow = await buildProjectWorkflowState(project);
  assert.equal(workflow.steps.find((step) => step.id === 'brief').done, true);
  assert.equal(workflow.steps.find((step) => step.id === 'review').done, false);
  await assert.rejects(() => reviewBrief(project, { decision: 'approved', rationale: '' }), { code: 'RATIONALE_REQUIRED' });
  project = await reviewBrief(project, { decision: 'approved', rationale: '来源、引用与结构已人工核对', now: () => '2026-08-12T08:02:00.000Z' });
  workflow = await buildProjectWorkflowState(project);
  assert.equal(project.brief.status, 'approved');
  assert.equal(project.brief.review.decision.source, 'local_manual');
  assert.equal(workflow.steps.find((step) => step.id === 'review').done, true);
});

test('P24 Brief provenance follows only transitively cited Evidence, not unrelated project Evidence', async () => {
  let manualBrief = await createProject({ topic: 'manual cited', objective: 'mixed source binding', audience: 'operator', channel: 'X', constraints: [] });
  manualBrief = await addManualSource(manualBrief, 'manual-cited');
  manualBrief = await runAnalysis(manualBrief, manualBrief.evidence[0].id);
  manualBrief = await buildKnowledgeCard(manualBrief, manualBrief.analyses[0].id);
  manualBrief = await addCollectedSource(manualBrief, '24002');
  manualBrief = await assembleBrief(manualBrief, { now: () => '2026-08-12T08:03:00.000Z' });
  assert.equal(manualBrief.brief.evidence_provenance.local_only, true);
  assert.equal(manualBrief.brief.evidence_provenance.store, 'p19_local_store_v1');
  assert.match(manualBrief.brief.evidence_provenance.statement, /手工录入/);
  assert.equal((await computeStaleness(manualBrief)).brief_stale, false);

  let collectedBrief = await createProject({ topic: 'collected cited', objective: 'mixed source binding', audience: 'operator', channel: 'X', constraints: [] });
  collectedBrief = await addCollectedSource(collectedBrief, '24003');
  collectedBrief = await runAnalysis(collectedBrief, collectedBrief.evidence[0].id);
  collectedBrief = await buildKnowledgeCard(collectedBrief, collectedBrief.analyses[0].id);
  collectedBrief = await addManualSource(collectedBrief, 'manual-unused');
  collectedBrief = await assembleBrief(collectedBrief, { now: () => '2026-08-12T08:04:00.000Z' });
  assert.equal(collectedBrief.brief.evidence_provenance.local_only, false);
  assert.equal(collectedBrief.brief.evidence_provenance.store, 'p19_workspace_v1');
  assert.match(collectedBrief.brief.evidence_provenance.statement, /服务端来源证明/);
  assert.equal((await computeStaleness(collectedBrief)).brief_stale, false);
});

test('P24 Brief assembly fails closed on duplicate cited Evidence identities', async () => {
  let project = await createProject({ topic: 'duplicate binding', objective: 'fail closed', audience: 'operator', channel: 'X', constraints: [] });
  project = await addManualSource(project, 'duplicate');
  project = await runAnalysis(project, project.evidence[0].id);
  project = await buildKnowledgeCard(project, project.analyses[0].id);
  project.evidence.push(JSON.parse(JSON.stringify(project.evidence[0])));
  await assert.rejects(() => assembleBrief(project), { code: 'BRIEF_EVIDENCE_BINDING_INVALID' });
});

test('P24 fails closed on complete and partial foreign-project citation chains', async () => {
  let projectA = await createProject({ topic: 'project A', objective: 'strict ownership', audience: 'operator', channel: 'X', constraints: [] });
  let projectB = await createProject({ topic: 'project B', objective: 'foreign source', audience: 'operator', channel: 'X', constraints: [] });
  projectB = await addManualSource(projectB, 'foreign');
  projectB = await runAnalysis(projectB, projectB.evidence[0].id);
  projectB = await buildKnowledgeCard(projectB, projectB.analyses[0].id);

  projectA.evidence = JSON.parse(JSON.stringify(projectB.evidence));
  projectA.analyses = JSON.parse(JSON.stringify(projectB.analyses));
  projectA.knowledge_cards = JSON.parse(JSON.stringify(projectB.knowledge_cards));
  await assert.rejects(() => assembleBrief(projectA), { code: 'BRIEF_EVIDENCE_BINDING_INVALID' });

  const partialForeign = JSON.parse(JSON.stringify(projectB));
  partialForeign.evidence[0].project_id = projectA.id;
  await assert.rejects(() => assembleBrief(partialForeign), { code: 'BRIEF_EVIDENCE_BINDING_INVALID' });

  const validB = await assembleBrief(projectB, { now: () => '2026-08-12T08:05:00.000Z' });
  const contaminated = JSON.parse(JSON.stringify(validB));
  contaminated.id = projectA.id;
  contaminated.topic = projectA.topic;
  contaminated.objective = projectA.objective;
  contaminated.audience = projectA.audience;
  contaminated.channel = projectA.channel;
  contaminated.brief.project_id = projectA.id;
  assert.equal((await computeStaleness(contaminated)).brief_stale, true);
  assert.notEqual(buildProjectLineageRow(contaminated).state, 'COMPLETE');
});

test('P25 approved Brief derives an exact non-executing handoff with cited provenance', async () => {
  let project = await createProject({ topic: 'P25', objective: 'handoff closure', audience: 'operator', channel: 'X', constraints: [] });
  project = await addCollectedSource(project, '25001');
  project = await runAnalysis(project, project.evidence[0].id);
  project = await buildKnowledgeCard(project, project.analyses[0].id);
  project = await assembleBrief(project, { now: () => '2026-08-12T08:06:00.000Z' });
  project = await reviewBrief(project, { decision: 'approved', rationale: 'Evidence and card bindings checked.', now: () => '2026-08-12T08:07:00.000Z' });
  const approvedCardId = project.knowledge_cards[0].id;
  project = await addManualSource(project, 'uncited-after-approval');
  project = await runAnalysis(project, project.evidence[1].id);
  project = await buildKnowledgeCard(project, project.analyses[1].id);
  const uncitedPattern = project.knowledge_cards[1].generation_guidance.reusable_pattern;
  project = await deriveHandoffPackage(project, { now: () => '2026-08-12T08:08:00.000Z' });
  assert.equal(project.handoff.project_id, project.id);
  assert.equal(project.handoff.brief_provenance.brief_id, project.brief.id);
  assert.equal(project.handoff.evidence_provenance.local_only, false);
  assert.equal(project.handoff.evidence_provenance.store, 'p19_workspace_v1');
  assert.match(project.handoff.evidence_provenance.statement, /服务端来源证明/);
  assert.deepEqual(project.handoff.execution_flags, { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false });
  assert.deepEqual(project.handoff.knowledge_citations.map((item) => item.knowledge_id), [approvedCardId]);
  assert.equal(project.handoff.structural_guidance.reusable_patterns.includes(uncitedPattern), false);
  assert.equal((await buildProjectWorkflowState(project)).steps.find((step) => step.id === 'handoff').done, true);
});
