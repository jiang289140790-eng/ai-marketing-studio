import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseP22Request, parseQwenMultimodalAnalyses, publicError } from '../supabase/functions/p22-research-assist/assist-core.mjs';
import { validateEvidenceRecord } from '../src/services/p19-contracts.js';
import { runDeterministicRules } from '../src/services/p19-workspace-service.js';
import { toP19AttachmentEvidenceInput } from '../src/services/p22-research-assist.js';

const userId = '11111111-1111-4111-8111-111111111111';
const threadId = 'thr_22222222-2222-4222-8222-222222222222';
const taskId = 'ht-33333333-3333-4333-8333-333333333333';
const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';

function attachment(overrides = {}) {
  return {
    ref: `harness-thread-attachments:${userId}/${threadId}/req-1/source.png`,
    name: 'source.png',
    size: 1024,
    mime_type: 'image/png',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    action: 'inspect_attachments',
    project_id: projectId,
    thread_id: threadId,
    harness_task_id: taskId,
    attachments: [attachment()],
    idempotency_key: 'h5-exact-request-1',
    ...overrides,
  };
}

test('H5 attachment request preserves the exact trusted descriptors', () => {
  assert.deepEqual(parseP22Request(request()), request());
});

test('H5 attachment parser rejects foreign threads, duplicates, unknown fields and unsupported MIME', () => {
  assert.throws(() => parseP22Request(request({ attachments: [attachment({ ref: `harness-thread-attachments:${userId}/thr_44444444-4444-4444-8444-444444444444/req-1/source.png` })] })), (error) => error.code === 'ATTACHMENT_BINDING_INVALID');
  assert.throws(() => parseP22Request(request({ attachments: [attachment(), attachment()] })), (error) => error.code === 'ATTACHMENT_BINDING_INVALID');
  assert.throws(() => parseP22Request(request({ attachments: [{ ...attachment(), url: 'https://attacker.invalid' }] })), (error) => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => parseP22Request(request({ attachments: [attachment({ mime_type: 'application/octet-stream' })] })), (error) => error.code === 'ATTACHMENT_MIME_UNSUPPORTED');
});

test('H5 attachment parser enforces per-file and aggregate byte bounds', () => {
  assert.throws(() => parseP22Request(request({ attachments: [attachment({ size: 25 * 1024 * 1024 + 1 })] })), (error) => error.code === 'ATTACHMENT_SIZE_INVALID');
  const large = [attachment({ ref: `harness-thread-attachments:${userId}/${threadId}/r/a.png`, size: 21 * 1024 * 1024 }), attachment({ ref: `harness-thread-attachments:${userId}/${threadId}/r/b.png`, name: 'b.png', size: 21 * 1024 * 1024 })];
  assert.throws(() => parseP22Request(request({ attachments: large })), (error) => error.code === 'ATTACHMENT_TOTAL_SIZE_INVALID');
});

test('H5 accepts the bounded image, video, PDF and text attachment contract', () => {
  const attachments = [
    attachment(),
    attachment({ ref: `harness-thread-attachments:${userId}/${threadId}/req-1/source.mp4`, name: 'source.mp4', mime_type: 'video/mp4' }),
    attachment({ ref: `harness-thread-attachments:${userId}/${threadId}/req-1/source.pdf`, name: 'source.pdf', mime_type: 'application/pdf' }),
    attachment({ ref: `harness-thread-attachments:${userId}/${threadId}/req-1/source.md`, name: 'source.md', mime_type: 'text/markdown' }),
  ];
  assert.deepEqual(parseP22Request(request({ attachments })).attachments, attachments);
});

function qwenAttachmentResponse(content) {
  return { choices: [{ message: { content } }] };
}

function qwenAttachmentAnalysis(item) {
  return JSON.stringify({ analyses: [{
    source_id: item.id,
    text_expression: 'A bounded description of the verified attachment.',
    media_analysis: [{
      media_id: item.media_assets[0].id,
      visual_content: 'A product scene with one clearly identified subject.',
      composition: 'Centered subject with a stable foreground and background.',
      people: 'No identifiable person is asserted.',
      scene: 'Indoor product demonstration.',
      emotion: 'Calm and informative.',
    }],
    virality_drivers: ['Clear subject'],
    reusable_methods: ['Lead with the result'],
    signals: ['Verified attachment'],
    risks: ['Avoid unsupported claims'],
  }] });
}

test('H5 accepts documented DashScope multimodal content strings and text-part arrays', () => {
  const item = {
    id: 'h5-att-aaaaaaaaaaaaaaaaaaaaaaaa', source_url: 'https://example.test/source', content_sha256: 'a'.repeat(64),
    media_assets: [{ id: 'media-aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'image' }],
  };
  const json = qwenAttachmentAnalysis(item);
  const stringResult = parseQwenMultimodalAnalyses(qwenAttachmentResponse(json), [item]);
  const arrayResult = parseQwenMultimodalAnalyses(qwenAttachmentResponse([{ type: 'text', text: json }]), [item]);
  const nativeArrayResult = parseQwenMultimodalAnalyses(qwenAttachmentResponse([{ text: `\`\`\`json\n${json}\n\`\`\`` }]), [item]);
  const nativeEnvelopeResult = parseQwenMultimodalAnalyses({ output: { choices: [{ message: { content: [{ type: 'text', text: json }] } }] } }, [item]);
  const structuredContentResult = parseQwenMultimodalAnalyses(qwenAttachmentResponse(JSON.parse(json)), [item]);
  assert.deepEqual(arrayResult, stringResult);
  assert.deepEqual(nativeArrayResult, stringResult);
  assert.deepEqual(nativeEnvelopeResult, stringResult);
  assert.deepEqual(structuredContentResult, stringResult);
  assert.equal(stringResult[0].media_analysis[0].media_id, item.media_assets[0].id);
});

test('H5 rejects missing or ambiguous response envelopes before reading model text', () => {
  const item = {
    id: 'h5-att-cccccccccccccccccccccccc', source_url: 'https://example.test/source', content_sha256: 'c'.repeat(64),
    media_assets: [{ id: 'media-cccccccccccccccccccccccc', kind: 'image' }],
  };
  const secretMarker = 'MODEL_TEXT_MUST_NOT_APPEAR';
  for (const [payload, reason] of [
    [{ output: {} }, 'RESPONSE_ENVELOPE_MISSING'],
    [{ choices: [{ message: { content: secretMarker } }], output: { choices: [{ message: { content: secretMarker } }] } }, 'RESPONSE_ENVELOPE_AMBIGUOUS'],
  ]) {
    let captured;
    assert.throws(() => parseQwenMultimodalAnalyses(payload, [item]), (error) => { captured = publicError(error); return true; });
    assert.equal(captured.code, 'MODEL_RESPONSE_INVALID');
    assert.equal(captured.details.reason, reason);
    assert.equal(JSON.stringify(captured).includes(secretMarker), false);
    assert.ok(Array.isArray(captured.details.response_shape.known_root_keys));
  }
});

test('H5 malformed model responses expose only bounded field diagnostics and no raw content', () => {
  const item = {
    id: 'h5-att-bbbbbbbbbbbbbbbbbbbbbbbb', source_url: 'https://example.test/source', content_sha256: 'b'.repeat(64),
    media_assets: [{ id: 'media-bbbbbbbbbbbbbbbbbbbbbbbb', kind: 'image' }],
  };
  const secretMarker = 'PRIVATE_ATTACHMENT_BODY_MUST_NOT_ESCAPE';
  for (const [content, reason] of [
    [[{ type: 'audio', audio: { data: secretMarker } }], 'CONTENT_PART_INVALID'],
    [`{ "analyses": [${secretMarker}] }`, 'JSON_INVALID'],
    [null, 'CONTENT_TYPE_INVALID'],
  ]) {
    let captured;
    assert.throws(() => parseQwenMultimodalAnalyses(qwenAttachmentResponse(content), [item]), (error) => { captured = publicError(error); return true; });
    assert.equal(captured.code, 'MODEL_RESPONSE_INVALID');
    assert.equal(captured.details.reason, reason);
    assert.equal(JSON.stringify(captured).includes(secretMarker), false);
    assert.ok(String(captured.details.field).length > 0 && String(captured.details.field).length < 96);
    assert.ok(captured.details.response_shape);
    assert.deepEqual(captured.diagnostics, captured.details);
    assert.equal(JSON.stringify(captured.details.response_shape).includes(secretMarker), false);
  }
});

test('H5 schema rejection preserves structural response shape without model values', () => {
  const item = {
    id: 'h5-att-dddddddddddddddddddddddd', source_url: 'https://example.test/source', content_sha256: 'd'.repeat(64),
    media_assets: [{ id: 'media-dddddddddddddddddddddddd', kind: 'image' }],
  };
  const secretMarker = 'PRIVATE_MODEL_VALUE_MUST_NOT_ESCAPE';
  const nonstandardKey = `private ${secretMarker}`;
  const content = {
    analyses: [{
      source_id: item.id,
      unexpected_field: secretMarker,
      [nonstandardKey]: secretMarker,
      media_analysis: [{
        media_id: item.media_assets[0].id,
        visual_content: secretMarker,
        composition: 'centered',
        people: 'unknown',
        scene: 'indoor',
        emotion: 'neutral',
      }],
    }],
  };
  let captured;
  assert.throws(() => parseQwenMultimodalAnalyses(qwenAttachmentResponse(content), [item]), (error) => {
    captured = publicError(error);
    return true;
  });
  assert.equal(captured.code, 'MODEL_RESPONSE_INVALID');
  assert.equal(captured.details.field, 'text_expression');
  assert.equal(captured.details.response_shape.json_root_type, 'object');
  assert.equal(captured.details.response_shape.analysis_count, 1);
  assert.equal(captured.details.response_shape.analysis_rows[0].field_types.unexpected_field, 'string');
  assert.ok(captured.details.response_shape.analysis_rows[0].keys.includes('<nonstandard-key>'));
  assert.equal(JSON.stringify(captured).includes(secretMarker), false);
  assert.ok(JSON.stringify(captured).length < 8192);
});

test('H5 Edge returns bounded diagnostics separately from compatibility details', async () => {
  const edge = await readFile(new globalThis.URL('../supabase/functions/p22-research-assist/index.ts', import.meta.url), 'utf8');
  assert.match(edge, /\.\.\.\(safe\.diagnostics\?\{diagnostics:safe\.diagnostics\}:\{\}\)/);
  assert.doesNotMatch(edge, /raw_response|response_body|model_content/);
});

test('H5 task page displays the server attempt count and bounded technical diagnostics without client-side guessing', async () => {
  const page = await readFile(new globalThis.URL('../src/pages/TaskExecutionPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /ai-task-step-attempts-/);
  assert.match(page, /\{step\.attempts\} 次/);
  assert.doesNotMatch(page, /step\.attempts\s*\+\s*1/);
  assert.match(page, /ai-task-step-diagnostics-/);
  assert.match(page, /step\.error\.field/);
  assert.match(page, /step\.error\.reason/);
  assert.match(page, /step\.error\.response_shape/);
});

test('H5 Edge verifies bytes and task ownership before one bounded model inspection', async () => {
  const edge = await readFile(new globalThis.URL('../supabase/functions/p22-research-assist/index.ts', import.meta.url), 'utf8');
  const body = edge.slice(edge.indexOf('async function inspectAttachments'), edge.indexOf('async function analyze('));
  assert.match(body, /harness_get_thread_by_task_v1/);
  assert.match(body, /harness_get_thread_v1/);
  assert.match(body, /storage\.from\(object\.bucket\)\.download\(object\.path\)/);
  assert.match(body, /bytes\.byteLength!==attachment\.size/);
  assert.match(body, /observedType!==attachment\.mime_type/);
  assert.doesNotMatch(body, /observedType&&observedType!==attachment\.mime_type/, 'missing object MIME must fail closed');
  assert.match(body, /sha256Bytes\(bytes\)/);
  assert.match(edge, /pdfjsSpecifier='npm:pdfjs-dist@4\.10\.38\/legacy\/build\/pdf\.mjs'/);
  assert.match(edge, /import\(pdfjsSpecifier\)/);
  assert.match(edge, /bytes\.byteLength>8\*1024\*1024/);
  assert.match(edge, /document\.numPages>50/);
  assert.match(body, /TextDecoder\('utf-8',\{fatal:true\}\)/);
  assert.match(body, /createSignedUrl\(object\.path,300\)/);
  assert.match(body, /qwen3\.5-omni-flash/);
  assert.match(body, /recordProviderCost\(db,userId,'qwen'/);
  assert.equal((body.match(/recordProviderCost\(/g) || []).length, 1, 'one provider reservation path');
  assert.equal((body.match(/fetch\('https:\/\/dashscope\.aliyuncs\.com/g) || []).length, 1, 'one model call path');
  assert.doesNotMatch(body, /service_role|SUPABASE_SERVICE_ROLE_KEY/);
});

function verifiedAttachmentItem(overrides = {}) {
  const contentText = overrides.content_text || 'Verified image analysis with bounded source identity.';
  const contentSha256 = createHash('sha256').update(contentText).digest('hex');
  return {
    id: 'h5-att-aaaaaaaaaaaaaaaaaaaaaaaa',
    platform: 'private_attachment',
    source_url: 'https://xtkkdvghiohlnpfnnhmx.supabase.co/storage/v1/object/authenticated/harness-thread-attachments/source.png',
    label: 'Verified attachment',
    content_text: contentText,
    content_sha256: contentSha256,
    collection_proof: `1999999999.${'c'.repeat(64)}`,
    provenance: {
      run_id: taskId,
      thread_id: threadId,
      collected_at: '2026-08-24T12:00:00.000Z',
      usage_total_usd: 0.01,
      budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      object_bindings: [{
        ref: `harness-thread-attachments:${userId}/${threadId}/req-1/source.png`,
        name: 'source.png',
        size: 1024,
        mime_type: 'image/png',
        sha256: 'd'.repeat(64),
      }],
    },
    ...overrides,
  };
}

test('H5 verified attachment becomes a valid P19 Evidence with exact object lineage and trust status', async () => {
  const input = await toP19AttachmentEvidenceInput(verifiedAttachmentItem());
  const record = {
    schema_version: 'p19_evidence_record_v1',
    id: 'ev-aaaaaaaaaaaaaaaaaaaaaaaa',
    project_id: projectId,
    ...input,
  };
  assert.deepEqual(validateEvidenceRecord(record), { valid: true, issues: [] });
  assert.deepEqual(input.provenance.object_bindings, verifiedAttachmentItem().provenance.object_bindings);
  assert.equal(input.platform, 'Private attachment (verified)');
  const trust = runDeterministicRules(record).find((entry) => entry.rule_id === 'manual_provenance_trust');
  assert.equal(trust.output.trust_status, 'verified_private_attachment');
});

test('H5 attachment Evidence fails closed on altered content or duplicate object binding', async () => {
  await assert.rejects(
    toP19AttachmentEvidenceInput(verifiedAttachmentItem({ content_sha256: '0'.repeat(64) })),
    (error) => error.code === 'H5_ATTACHMENT_HASH_MISMATCH',
  );
  const item = verifiedAttachmentItem();
  item.provenance.object_bindings.push(globalThis.structuredClone(item.provenance.object_bindings[0]));
  await assert.rejects(toP19AttachmentEvidenceInput(item), (error) => error.code === 'H5_ATTACHMENT_BINDING_INVALID');
});
