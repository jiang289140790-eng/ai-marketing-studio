/* global TextEncoder */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import {
  HarnessTaskQueue,
  validateTaskRequest,
} from '../services/harness-gateway/gateway-core.mjs';
import {
  MAX_PRESENTATION_BLOCKS,
  MAX_PRESENTATION_BYTES,
  PRESENTATION_SCHEMA_VERSION,
  derivePresentation,
  normalizePresentation,
} from '../services/harness-gateway/presentation/presentation-contract.mjs';
import {
  deriveStructuredBlocks as clientDeriveStructuredBlocks,
  layoutFlowSource,
  normalizePresentation as clientNormalizePresentation,
  parseFlowSource,
} from '../src/services/harness-presentation.js';
import { unownedChangedPaths } from './helpers/harness-integration-owned-paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const userId = '11111111-1111-4111-8111-111111111111';
const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';

const baseTask = {
  id: 'ht-11111111-1111-4111-8111-111111111111',
  state: 'succeeded',
  created_at: '2026-08-15T00:00:00.000Z',
  updated_at: '2026-08-15T00:00:01.000Z',
  request: {
    schema_version: 'ams_harness_gateway_v1',
    request_id: 'web-genui-1',
    user_id: userId,
    project_id: projectId,
    intent: 'Analyze the week and show a chart.',
    approval: { paid_external_calls: true, online_writes: true, handoff_creation: false },
  },
  result: { final_response: '', artifact_refs: ['prj-aaaaaaaaaaaaaaaaaaaaaaaa/evidence/ev-1'] },
  error: null,
};

function responseWithFences() {
  return [
    '分析完成，本周结果如下：',
    '',
    '```dsh-ui',
    JSON.stringify({
      title: '周报对比',
      items: [
        { type: 'chart', kind: 'bars', data: [{ label: '周一', value: 12 }, { label: '周二', value: 7 }, { label: '周三', value: 19 }] },
        { type: 'table', title: '平台分布', columns: ['平台', '数量'], rows: [['X', '3'], ['Reddit', '5']] },
        { type: 'mermaid', title: '采集流程', code: 'graph LR\nA[采集]-->B[分析]' },
        { type: 'steps', current: 1, steps: [{ title: '采集' }, { title: '分析' }, { title: '简报' }] },
        { type: 'callout', tone: 'info', title: '结论', content: '本周互动提升。' },
      ],
    }),
    '```',
    '',
    '```visualize',
    '<div class="metric"><strong>互动率</strong><span>+12.4%</span></div>',
    '```',
    '',
    '```mermaid',
    'flowchart TD\nStart[开始] --> End[结束]',
    '```',
  ].join('\n');
}

function queueWithRunner({ runner, initialTasks = [], onEvent = () => {} } = {}) {
  return new HarnessTaskQueue({
    runner,
    initialTasks,
    onEvent,
    validateRuntimeContext: () => ({ ok: true }),
  });
}

test('presentation normalization accepts exactly the versioned bounded contract', () => {
  const valid = {
    schema_version: PRESENTATION_SCHEMA_VERSION,
    blocks: [
      { kind: 'chart', title: '对比', chart: 'bars', data: [{ label: 'A', value: 3, color: '#ff0000' }] },
      { kind: 'flow', title: '流程', mermaid: 'graph LR\nA-->B' },
      { kind: 'table', title: '表格', columns: ['c1'], rows: [['x']] },
      { kind: 'summary', title: '摘要', text: 'text' },
      { kind: 'fragment', title: '卡片', html: '<div>ok</div>' },
      { kind: 'fallback', title: '降级', text: 'bad' },
    ],
  };
  assert.deepEqual(normalizePresentation(valid), valid);
  assert.equal(normalizePresentation(null), null);
  assert.equal(normalizePresentation({}), null);
  assert.equal(normalizePresentation({ schema_version: 'other', blocks: [] }), null);
  assert.equal(normalizePresentation({ schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [] }), null);
  assert.equal(normalizePresentation({ schema_version: PRESENTATION_SCHEMA_VERSION, blocks: 'x' }), null);
  assert.equal(
    normalizePresentation({ schema_version: PRESENTATION_SCHEMA_VERSION, blocks: Array.from({ length: MAX_PRESENTATION_BLOCKS + 1 }, () => ({ kind: 'fallback', text: 'x' })) }),
    null,
  );
});

test('presentation normalization fails closed per block and never echoes hostile content', () => {
  const hostile = {
    schema_version: PRESENTATION_SCHEMA_VERSION,
    blocks: [
      { kind: 'chart', chart: 'bars', data: [{ label: '<img src=x onerror=alert(1)>', value: 1 }] },
      { kind: 'flow', mermaid: 'graph LR\nA[<script>alert(1)</script>]-->B' },
      { kind: 'table', columns: ['<b>c</b>'], rows: [['<i>x</i>']] },
      { kind: 'fragment', html: '<script>window.pwned=1</script>' },
    ],
  };
  // chart survives with the hostile label as inert text (React escapes it);
  // flow and fragment fail validation and drop; the table renders as text.
  const normalized = normalizePresentation(hostile);
  assert.equal(normalized.blocks.length, 2);
  assert.deepEqual(normalized.blocks.map((block) => block.kind), ['chart', 'table']);

  const scriptOnly = {
    schema_version: PRESENTATION_SCHEMA_VERSION,
    blocks: [{ kind: 'fragment', html: '<script>alert(1)</script>' }],
  };
  assert.equal(normalizePresentation(scriptOnly), null);
  assert.equal(
    normalizePresentation({ schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'fragment', html: '<!doctype html><p>x</p>' }] }),
    null,
    'document skeletons are rejected',
  );
  assert.equal(
    normalizePresentation({ schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'fragment', html: '<a href="javascript:alert(1)">x</a>' }] }),
    null,
  );
  assert.equal(
    normalizePresentation({ schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'fragment', html: '<div onclick="alert(1)">x</div>' }] }),
    null,
  );
  assert.equal(
    normalizePresentation({ schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'flow', mermaid: 'sequenceDiagram\nA->>B: hi' }] }),
    null,
    'non-flowchart diagram kinds fail closed',
  );
  assert.equal(
    normalizePresentation({ schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'flow', mermaid: 'graph LR\nA-->B\nclick A "https://evil"' }] }),
    null,
  );
  assert.equal(
    normalizePresentation({ schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'chart', chart: 'bars', data: [{ label: 'A', value: Infinity }] }] }),
    null,
    'non-finite chart values fail closed',
  );
});

test('derivePresentation extracts bounded blocks from dsh-ui, visualize and mermaid fences', () => {
  const task = { ...baseTask, result: { ...baseTask.result, final_response: responseWithFences() } };
  const presentation = derivePresentation(task.result.final_response, task);
  assert.equal(presentation.schema_version, PRESENTATION_SCHEMA_VERSION);
  const kinds = presentation.blocks.map((block) => block.kind);
  assert.ok(kinds.includes('chart'), JSON.stringify(presentation));
  assert.ok(kinds.includes('table'));
  assert.ok(kinds.includes('flow'));
  assert.ok(kinds.includes('fragment'));
  assert.ok(kinds.includes('summary'));
  assert.ok(presentation.blocks.length <= MAX_PRESENTATION_BLOCKS);
  assert.ok(new TextEncoder().encode(JSON.stringify(presentation)).length <= MAX_PRESENTATION_BYTES);
  const chart = presentation.blocks.find((block) => block.kind === 'chart');
  assert.equal(chart.chart, 'bars');
  assert.deepEqual(chart.data.map((point) => point.value), [12, 7, 19]);
  const fragment = presentation.blocks.find((block) => block.kind === 'fragment');
  assert.match(fragment.html, /互动率/);
  // Structured blocks are appended so plain tasks still visualize.
  const summary = presentation.blocks.find((block) => block.kind === 'summary' && block.title === '任务概况');
  assert.match(summary.text, /Analyze the week and show a chart/);
});

test('derivePresentation degrades broken fences to bounded fallbacks without dropping valid blocks', () => {
  const response = [
    '```dsh-ui',
    '{not valid json',
    '```',
    '```dsh-ui',
    JSON.stringify({ items: [{ type: 'table', columns: ['k'], rows: [['v']] }] }),
    '```',
    '```dsh-ui',
    JSON.stringify({ items: [{ type: 'scene3d', meshes: [{ shape: 'box' }] }] }),
    '```',
    '```visualize',
    '<script>alert(1)</script>',
    '```',
  ].join('\n');
  const presentation = derivePresentation(response, baseTask);
  const kinds = presentation.blocks.map((block) => block.kind);
  assert.ok(kinds.includes('table'), 'valid blocks survive neighbouring failures');
  assert.ok(kinds.includes('fallback'), 'broken fences degrade to fallbacks');
  assert.ok(presentation.blocks.every((block) => block.kind !== 'fragment'), 'hostile fragments never persist');
});

test('derivePresentation is bounded under adversarial volume and never throws', () => {
  const hugeTable = JSON.stringify({ items: [{ type: 'table', title: '大表', columns: ['c'], rows: Array.from({ length: 100 }, (_, index) => [`row-${index}`]) }] });
  const response = Array.from({ length: 20 }, (_, index) => `\`\`\`dsh-ui\n${hugeTable.replace('row-0', `row-${index}-0`)}\n\`\`\``).join('\n');
  const presentation = derivePresentation(response, baseTask);
  assert.ok(presentation.blocks.length <= MAX_PRESENTATION_BLOCKS);
  assert.ok(new TextEncoder().encode(JSON.stringify(presentation)).length <= MAX_PRESENTATION_BYTES);

  // Structured derivation is task-independent, so even a null task yields the
  // bounded structured summary block instead of throwing or returning null.
  assert.equal(derivePresentation(null, null).blocks.length, 1);
  assert.equal(derivePresentation('', null).blocks.length, 1);
  assert.equal(derivePresentation(undefined, baseTask).blocks.length >= 1, true);
  // A pathological nesting depth must not crash derivation.
  let deep = '{"items":[';
  for (let index = 0; index < 2000; index += 1) deep += '{"type":"row","items":[';
  deep += ']}'.repeat(2001);
  const pathological = derivePresentation(`\`\`\`dsh-ui\n${deep}\n\`\`\``, baseTask);
  assert.ok(pathological && pathological.blocks.length >= 1);
});

test('gateway persists the bounded versioned presentation without changing task semantics', async () => {
  const events = [];
  const queue = queueWithRunner({
    runner: async (request, taskId) => {
      assert.equal(taskId.startsWith('ht-'), true);
      return { final_response: responseWithFences(), artifact_refs: ['prj-aaaaaaaaaaaaaaaaaaaaaaaa/evidence/ev-1'] };
    },
    onEvent: (event) => events.push(event),
  });
  const submitted = queue.submit(baseTask.request);
  assert.equal(submitted.ok, true);
  await queue.whenIdle();
  const read = queue.read(submitted.task.id, userId);
  assert.equal(read.task.state, 'succeeded');
  assert.equal(read.task.result.presentation.schema_version, PRESENTATION_SCHEMA_VERSION);
  assert.equal(read.task.result.final_response.includes('dsh-ui'), true, 'raw response stays intact');
  assert.ok(read.task.result.presentation.blocks.length >= 1);
  const terminal = queue.submit(baseTask.request);
  assert.equal(terminal.replayed, true, 'idempotent replay semantics unchanged');
  assert.equal(terminal.task.result.presentation.schema_version, PRESENTATION_SCHEMA_VERSION, 'replayed terminal tasks keep their presentation');
});

test('presentation never changes failure or partial-completion semantics', async () => {
  const diagnostic = {
    code: 'HARNESS_EXIT_FAILED',
    category: 'model_upstream',
    stage: 'model_call',
    exit_code: 1,
    summary: 'Model upstream (DeepSeek proxy) rejected the request (HTTP 402).',
  };
  const failing = queueWithRunner({
    runner: async () => {
      const error = new Error('Harness process failed with code 1.');
      error.code = 'HARNESS_EXIT_FAILED';
      error.diagnostic = diagnostic;
      throw error;
    },
  });
  const submitted = failing.submit(baseTask.request);
  await failing.whenIdle();
  const read = failing.read(submitted.task.id, userId);
  assert.equal(read.task.state, 'failed');
  assert.equal(read.task.result, null, 'a failed task persists no result, presentation included');
  assert.deepEqual(read.task.error, diagnostic);

  const partial = queueWithRunner({
    runner: async () => {
      const error = new Error('required tool failed');
      error.code = 'AMS_REQUIRED_TOOL_FAILED';
      error.diagnostic = { ...diagnostic, tool_code: 'AMS_REQUIRED_TOOL_FAILED', operation: 'research.search_x' };
      error.partialResult = { final_response: '部分完成。', artifact_refs: [], partial_completion: false };
      throw error;
    },
  });
  const submittedPartial = partial.submit(baseTask.request);
  await partial.whenIdle();
  const readPartial = partial.read(submittedPartial.task.id, userId);
  assert.equal(readPartial.task.state, 'failed');
  assert.equal(readPartial.task.error.code, 'HARNESS_EXIT_FAILED', 'diagnostic shape stays exactly as the classifier produced');
  assert.equal(readPartial.task.error.tool_code, 'AMS_REQUIRED_TOOL_FAILED');
  assert.equal(readPartial.task.result.partial_completion, false);
  assert.equal(readPartial.task.result.presentation.schema_version, PRESENTATION_SCHEMA_VERSION, 'partial results still carry a safe presentation');
});

test('tampered persisted presentations are re-validated on snapshot restore', () => {
  const validPresentation = { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'summary', title: '任务概况', text: 'ok' }] };
  const restored = queueWithRunner({
    runner: async () => ({ final_response: 'x' }),
    initialTasks: [
      { ...baseTask, result: { ...baseTask.result, presentation: validPresentation } },
      { ...baseTask, id: 'ht-22222222-2222-4222-8222-222222222222', request: { ...baseTask.request, request_id: 'web-genui-2' }, result: { ...baseTask.result, presentation: { schema_version: 'evil', blocks: [] } } },
    ],
  });
  const valid = restored.read('ht-11111111-1111-4111-8111-111111111111', userId);
  assert.deepEqual(valid.task.result.presentation, validPresentation);
  const tampered = restored.read('ht-22222222-2222-4222-8222-222222222222', userId);
  assert.equal(tampered.task.result.presentation, null, 'invalid persisted presentation degrades to null');
});

test('gateway and browser presentation contracts accept and reject identical payloads', () => {
  const corpus = [
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'chart', chart: 'donut', data: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }] },
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'flow', mermaid: 'graph TD\nA-->B' }] },
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'flow', mermaid: 'graph LR\nA-->B\nclick A "x"' }] },
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'fragment', html: '<div>ok</div>' }] },
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'fragment', html: '<svg onload="alert(1)"></svg>' }] },
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'fragment', html: '<iframe src="https://evil.example"></iframe>' }] },
    { schema_version: 'other', blocks: [{ kind: 'summary', text: 'x' }] },
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'chart', chart: 'bars', data: [{ label: 'A', value: NaN }] }] },
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'table', columns: ['c'], rows: [['x']] }, { kind: 'summary', text: 'y' }] },
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'summary', text: 'x', id: 'a'.repeat(16), source: 'dsh-ui', fingerprint: 'f'.repeat(64) }] },
    { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: [{ kind: 'summary', text: 'x', fingerprint: 'tampered' }] },
    {
      schema_version: PRESENTATION_SCHEMA_VERSION,
      blocks: Array.from({ length: 8 }, () => ({ kind: 'fragment', html: `<div>${'x'.repeat(12 * 1024)}</div>` })),
    },
  ];
  for (const payload of corpus) {
    assert.deepEqual(clientNormalizePresentation(payload), normalizePresentation(payload), JSON.stringify(payload));
  }
  const legacy = { ...baseTask, result: { ...baseTask.result, presentation: undefined } };
  const stripIdentity = (blocks) => blocks.map(({ id: _id, fingerprint: _fingerprint, source: _source, ...body }) => body);
  assert.deepEqual(clientDeriveStructuredBlocks(legacy), stripIdentity(derivePresentation('', legacy).blocks));
});

test('every derived presentation block carries stable identity, allowlisted source, and bounded fingerprint', () => {
  const first = derivePresentation(responseWithFences(), baseTask);
  const second = derivePresentation(responseWithFences(), baseTask);
  for (const [index, block] of first.blocks.entries()) {
    assert.match(block.id, /^[0-9a-f]{16}$/);
    assert.match(block.source, /^[a-z-]{2,24}$/);
    assert.match(block.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(block, second.blocks[index], 'identity is content-derived and stable across derivations');
  }
  const sources = new Set(first.blocks.map((block) => block.source));
  for (const expected of ['dsh-ui', 'visualize', 'mermaid', 'structured']) assert.ok(sources.has(expected), `${expected} source present: ${[...sources]}`);
  // A mutated response changes the fingerprint of the affected block.
  const mutated = derivePresentation(responseWithFences().replace('互动提升。', '互动下降。'), baseTask);
  const changed = mutated.blocks.filter((block, index) => block.fingerprint !== first.blocks[index].fingerprint);
  assert.ok(changed.length >= 1);
  // Normalization of derived payloads round-trips exactly (identity survives).
  assert.deepEqual(normalizePresentation(first), first);
});

test('edge response ceiling still accommodates a maximum presentation envelope', () => {
  const edge = readFileSync(new URL('../supabase/functions/harness-command/index.ts', import.meta.url), 'utf8');
  assert.match(edge, /const MAX_RESPONSE = 192 \* 1024/);
  const task = {
    ok: true,
    task: {
      id: 'ht-11111111-1111-4111-8111-111111111111', state: 'succeeded',
      created_at: '2026-08-14T00:00:00.000Z', updated_at: '2026-08-14T00:00:01.000Z',
      request: {
        schema_version: 'ams_harness_task_v1', request_id: 'r'.repeat(200),
        intent: '😀'.repeat(6_000), project_id: '11111111-1111-4111-8111-111111111111',
        approval: { paid_external_calls: true, online_writes: true, generation_handoff: true },
      },
      result: {
        final_response: '结'.repeat(4096),
        artifact_refs: Array.from({ length: 50 }, () => '😀'.repeat(250)),
        presentation: {
          schema_version: PRESENTATION_SCHEMA_VERSION,
          blocks: Array.from({ length: MAX_PRESENTATION_BLOCKS }, (_, index) => ({
            kind: 'fragment', title: '卡片', html: `<div>${'数'.repeat(1000)}</div>`,
            ...(index === 0 ? {} : {}),
          })),
        },
      },
      error: null,
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(task)).length;
  assert.ok(bytes > 64 * 1024);
  assert.ok(bytes < 192 * 1024, `maximum envelope with presentation exceeded the declared cap: ${bytes}`);
});

test('adversarial dsh-ui payloads fail closed: prototype keys, duplicate ids, hostile fragments', () => {
  const prototype = [
    '```dsh-ui',
    '{"items":[{"__proto__":{"polluted":"yes"},"type":"table","columns":["c"],"rows":[["v"]]}]}',
    '```',
  ].join('\n');
  const derived = derivePresentation(prototype, baseTask);
  assert.equal(derived.blocks.some((block) => block.kind === 'table'), true, 'payload parses without crashing');
  assert.equal({}.polluted, undefined, 'prototype keys never pollute');
  assert.equal([].polluted, undefined);

  const nested = derivePresentation('```visualize\n<div>a<iframe src="https://evil.example"></iframe></div>\n```', baseTask);
  assert.equal(nested.blocks.some((block) => block.kind === 'fragment'), false, 'nested frames are rejected');
  assert.equal(nested.blocks.some((block) => block.kind === 'fallback'), true);

  // Derived steps flows sanitize hostile step labels and re-validate the
  // composed source before persisting.
  const hostileSteps = derivePresentation('```dsh-ui\n{"items":[{"type":"steps","steps":[{"title":"<script>alert(1)</script>"},{"title":"b]ad"}]}]}\n```', baseTask);
  const stepsFlow = hostileSteps.blocks.find((block) => block.kind === 'flow');
  assert.ok(stepsFlow, 'sanitized steps still produce a flow');
  assert.doesNotMatch(stepsFlow.mermaid, /</, 'hostile angle brackets never survive into the source');
  assert.doesNotMatch(stepsFlow.mermaid, /script|onerror/i, 'hostile script text is neutralized out of the label');
  assert.equal(normalizePresentation(hostileSteps) === null, false, 'derived hostile-steps payload re-validates');

  // The renderer's structural parser is the final gate for ambiguous flows:
  // conflicting duplicate id redefinitions and cycles fail closed.
  assert.equal(parseFlowSource('flowchart TD\nA[one]-->B\nA(two)-->C'), null, 'conflicting duplicate id redefinition fails closed');
  assert.equal(layoutFlowSource(parseFlowSource('graph LR\nA-->B\nB-->A')), null, 'cycles fail closed at layout');
  assert.equal(parseFlowSource('graph LR\nsubgraph X\nA-->B\nend'), null, 'subgraphs are unsupported and fail closed');
  const parsed = parseFlowSource('flowchart LR\nA[采集]-->B[分析]\nB-->C([简报])');
  assert.equal(parsed.nodes.length, 3);
  assert.equal(parsed.edges.length, 2);
  assert.ok(layoutFlowSource(parsed), 'acyclic flows lay out');
});

test('presentation never leaks one project into another task result', () => {
  const otherProject = 'prj-bbbbbbbbbbbbbbbbbbbbbbbb';
  const taskB = { ...baseTask, id: 'ht-22222222-2222-4222-8222-222222222222', request: { ...baseTask.request, request_id: 'web-other', project_id: otherProject, intent: 'Another project intent.' }, result: { final_response: 'plain', artifact_refs: [`${otherProject}/evidence/ev-x`] } };
  const presentationB = derivePresentation(taskB.result.final_response, taskB);
  const serialized = JSON.stringify(presentationB);
  assert.doesNotMatch(serialized, /prj-aaaaaaaaaaaaaaaaaaaaaaaa/, 'task B presentation never embeds project A identity');
  assert.doesNotMatch(serialized, /web-genui-1/);
  assert.doesNotMatch(serialized, /dsh-ui/);
  assert.match(serialized, /prj-bbbbbbbbbbbbbbbbbbbbbbbb/, 'task B presentation carries only its own bound project');
});

test('vendored promotion records the exact pinned tarballs and hashes', () => {
  const sources = readFileSync(new URL('../services/harness-gateway/vendor/SOURCES.md', import.meta.url), 'utf8');
  assert.match(sources, /@omdsh-dev\/dsh-genui.*0\.8\.3/s);
  assert.match(sources, /@dsh-external\/dsh-visualize.*0\.1\.2/s);
  assert.match(sources, /5849c50e475c995ca891b8089605fc8f85d91ab5c6c9d969367eedaaa22ef871/);
  assert.match(sources, /fc923de7b5f899c8d82d891fad24c42ab3d14517ea92d9051da98dfbe92d4acc/);
  assert.match(sources, /0e756efb7671e6b8413dde3d8e199c68fa89cbeb/);
  assert.match(sources, /e3254f762cbe4dbf796eca05d73a293f0e8e4a87/);
});

test('git diff --check is clean for the working tree', () => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  const output = execFileSync('git', ['diff', '--check'], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(output, '', `git diff --check reported whitespace errors:\n${output}`);
});

test('business write and failure semantics stay outside the presentation surface', () => {
  const core = readFileSync(new URL('../services/harness-gateway/gateway-core.mjs', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../services/harness-gateway/harness-runner.mjs', import.meta.url), 'utf8');
  // derivePresentation is the only presentation hook in the queue; the runner
  // (spawn, timeout, diagnostics) has no presentation knowledge.
  assert.match(core, /import \{ derivePresentation, normalizePresentation \} from '\.\/presentation\/presentation-contract\.mjs';/);
  assert.doesNotMatch(runner, /presentation/i);
  // The derivation call site sits inside the result assembly, never in the
  // transition/error path.
  assert.ok(core.indexOf('presentation: derivePresentation(') < core.indexOf('#transition(task, \'succeeded\')'));
  // No business module (P19/P22/bridge/edge writes) imports presentation code.
  const businessFiles = [
    'supabase/functions/p19-workspace-command/command-core.mjs',
    'supabase/functions/p22-research-assist/assist-core.mjs',
    'supabase/functions/harness-tool-bridge/bridge-core.mjs',
    'services/harness-gateway/tool-contract.mjs',
    'services/harness-gateway/tool-client.mjs',
  ];
  for (const file of businessFiles) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /presentation/i, `${file} must not depend on presentation`);
  }
});

test('the working-tree diff stays inside the owned path contract', () => {
  const unowned = unownedChangedPaths({ cwd: ROOT });
  assert.deepEqual(unowned, [], `改动超出授权路径: ${unowned.join(', ')}`);
});

test('gateway request validation is unchanged by presentation (regression)', () => {
  const checked = validateTaskRequest(baseTask.request);
  assert.equal(checked.ok, true);
  assert.equal(validateTaskRequest({ ...baseTask.request, presentation: 'x' }).code, 'UNKNOWN_FIELD');
});
