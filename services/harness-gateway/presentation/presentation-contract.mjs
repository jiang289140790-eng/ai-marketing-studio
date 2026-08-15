/* global Buffer */
import { createHash } from 'node:crypto';
// Bounded, versioned presentation contract derived from Harness output.
//
// The gateway persists this payload on task results so the Harness page can
// render charts, flow diagrams, tables, fragments, and structured task
// results without executing model-authored markup as code. Every block
// carries a stable identity, an allowlisted source, and a bounded content
// fingerprint. Every function here is fail-closed: invalid input degrades to
// a bounded fallback block or null, and derivation can never throw into the
// task state machine, so a broken presentation can never change business
// writes or task failure semantics.

export const PRESENTATION_SCHEMA_VERSION = 'ams_harness_presentation_v1';
export const PRESENTATION_KINDS = Object.freeze(['chart', 'flow', 'table', 'summary', 'fragment', 'fallback']);
export const MAX_PRESENTATION_BLOCKS = 8;
export const MAX_PRESENTATION_BYTES = 16 * 1024;
export const MAX_FRAGMENT_BYTES = 12 * 1024;
export const MAX_MERMAID_CHARS = 4_000;
export const MAX_CHART_POINTS = 24;
export const MAX_TABLE_ROWS = 30;
export const MAX_TABLE_COLS = 8;
export const MAX_CELL_CHARS = 200;
export const MAX_SUMMARY_CHARS = 2_000;
export const MAX_TITLE_CHARS = 80;
export const MAX_LABEL_CHARS = 40;
export const MAX_FLOW_STEPS = 24;
export const MAX_FALLBACK_CHARS = 300;

const MAX_FENCES = 8;
const CHART_KINDS = new Set(['bars', 'line', 'donut']);
const SAFE_COLOR_RE = /^(?:#[\da-fA-F]{3,8}|rgba?\([^)]{0,64}\)|hsla?\([^)]{0,64}\))$/;
const SKELETON_TAG_RE = /<!doctype\b|<\s*(?:html|head|body)\b/iu;
const FORBIDDEN_FRAGMENT_RE = /<\s*(?:script|iframe|frame|object|embed)\b|\son[a-z]+\s*=/iu;
const FORBIDDEN_FRAGMENT_URL_RE = /(?:href|src)\s*=\s*["']\s*(?:javascript:|data:text\/html)/iu;
const BLOCK_ID_RE = /^[0-9a-f]{16}$/;
const BLOCK_FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const BLOCK_SOURCE_RE = /^[a-z-]{2,24}$/;
const FLOW_HEAD_RE = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i;
const FORBIDDEN_FLOW_LINE_RE = /^\s*(?:classDef|class|style|linkStyle|href|click|interpolate)\b/;
const FORBIDDEN_FLOW_TEXT_RE = /<|href\b|click\b/iu;
const FENCE_RE = /```(dsh-ui|visualize|dsh-visualize|mermaid)[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;

// Interactive or unsupported dsh-ui component types that have no meaning in a
// bounded task-result view. Container types are recursed into instead.
const UNSUPPORTED_COMPONENTS = new Set([
  'button', 'input', 'textarea', 'select', 'checkbox', 'switch', 'slider',
  'radio', 'submit', 'quiz', 'tabs', 'accordion', 'avatar', 'plot',
  'scene3d', 'timeline', 'file-tree', 'breadcrumb', 'copy', 'divider',
  'spacer', 'diff',
]);
const CONTAINER_COMPONENTS = new Set(['row', 'col', 'grid', 'card']);

function boundedText(value, limit) {
  return String(value ?? '').slice(0, limit);
}

function safeTitle(value) {
  return boundedText(value, MAX_TITLE_CHARS);
}

function safeColor(value) {
  const text = String(value ?? '').trim();
  return text.length <= 64 && SAFE_COLOR_RE.test(text) ? text : undefined;
}

function finiteNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

function fallbackBlock(title, text) {
  return { kind: 'fallback', title: safeTitle(title) || 'Presentation', text: boundedText(text, MAX_FALLBACK_CHARS) };
}

function blockFingerprint(block) {
  const { id: _id, fingerprint: _fingerprint, ...content } = block;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * Attach the stable block identity (content-derived, 16 hex), the allowlisted
 * derivation source, and the bounded content fingerprint (SHA-256 of the
 * block body excluding identity fields). Recomputable at any boundary.
 */
function stampBlock(block, source) {
  const stamped = { ...block, source };
  stamped.id = createHash('sha256').update(`${source}:${block.kind}:${JSON.stringify(block)}`).digest('hex').slice(0, 16);
  stamped.fingerprint = blockFingerprint(stamped);
  return stamped;
}

function withBlockIdentity(candidate, block) {
  if (candidate.id !== undefined) {
    if (typeof candidate.id !== 'string' || !BLOCK_ID_RE.test(candidate.id)) return null;
    block.id = candidate.id;
  }
  if (candidate.source !== undefined) {
    if (typeof candidate.source !== 'string' || !BLOCK_SOURCE_RE.test(candidate.source)) return null;
    block.source = candidate.source;
  }
  if (candidate.fingerprint !== undefined) {
    if (typeof candidate.fingerprint !== 'string' || !BLOCK_FINGERPRINT_RE.test(candidate.fingerprint)) return null;
    block.fingerprint = candidate.fingerprint;
  }
  return block;
}

export function normalizePresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema_version !== PRESENTATION_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.blocks)) return null;
  if (value.blocks.length > MAX_PRESENTATION_BLOCKS) return null;
  const blocks = [];
  for (const candidate of value.blocks.slice(0, MAX_PRESENTATION_BLOCKS)) {
    const block = normalizeBlock(candidate);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  const normalized = { schema_version: PRESENTATION_SCHEMA_VERSION, blocks };
  // The persistence gate re-enforces the serialized byte ceiling so a
  // tampered or hand-built payload can never outgrow the transport budget.
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_PRESENTATION_BYTES) return null;
  return normalized;
}

export function normalizeBlock(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  if (candidate.kind !== 'fallback' && !PRESENTATION_KINDS.includes(candidate.kind)) return null;
  const title = safeTitle(candidate.title);
  let block = null;
  switch (candidate.kind) {
    case 'chart': {
      if (!CHART_KINDS.has(candidate.chart)) return null;
      if (!Array.isArray(candidate.data)) return null;
      const data = [];
      for (const point of candidate.data.slice(0, MAX_CHART_POINTS)) {
        if (!point || typeof point !== 'object' || Array.isArray(point)) continue;
        const value = finiteNumber(point.value, -1e9, 1e9);
        if (value === undefined) continue;
        data.push({
          label: boundedText(point.label, MAX_LABEL_CHARS),
          value,
          ...(safeColor(point.color) ? { color: safeColor(point.color) } : {}),
        });
      }
      if (data.length === 0) return null;
      block = { kind: 'chart', title, chart: candidate.chart, data };
      break;
    }
    case 'flow': {
      if (typeof candidate.mermaid !== 'string') return null;
      const mermaid = boundedText(candidate.mermaid, MAX_MERMAID_CHARS);
      if (!isValidFlowSource(mermaid)) return null;
      block = { kind: 'flow', title, mermaid };
      break;
    }
    case 'table': {
      if (!Array.isArray(candidate.columns) || !Array.isArray(candidate.rows)) return null;
      const columns = candidate.columns.slice(0, MAX_TABLE_COLS).map((cell) => boundedText(cell, MAX_CELL_CHARS));
      if (columns.length === 0) return null;
      const rows = candidate.rows.slice(0, MAX_TABLE_ROWS)
        .filter((row) => Array.isArray(row))
        .map((row) => row.slice(0, columns.length).map((cell) => boundedText(cell, MAX_CELL_CHARS)));
      if (rows.length === 0) return null;
      block = { kind: 'table', title, columns, rows };
      break;
    }
    case 'summary': {
      const text = boundedText(candidate.text, MAX_SUMMARY_CHARS);
      if (!text.trim()) return null;
      block = { kind: 'summary', title, text };
      break;
    }
    case 'fragment': {
      if (typeof candidate.html !== 'string') return null;
      const html = boundedText(candidate.html, MAX_FRAGMENT_BYTES);
      if (!isSafeFragment(html)) return null;
      block = { kind: 'fragment', title, html };
      break;
    }
    case 'fallback': {
      const text = boundedText(candidate.text, MAX_FALLBACK_CHARS);
      if (!text.trim()) return null;
      block = { kind: 'fallback', title, text };
      break;
    }
    default:
      return null;
  }
  return withBlockIdentity(candidate, block);
}

export function isValidFlowSource(source) {
  const lines = String(source).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  if (!FLOW_HEAD_RE.test(lines[0])) return false;
  for (const line of lines.slice(1)) {
    if (FORBIDDEN_FLOW_LINE_RE.test(line)) return false;
    if (FORBIDDEN_FLOW_TEXT_RE.test(line)) return false;
  }
  return true;
}

export function isSafeFragment(html) {
  const text = String(html ?? '');
  if (!text.trim()) return false;
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAGMENT_BYTES) return false;
  if (SKELETON_TAG_RE.test(text)) return false;
  if (FORBIDDEN_FRAGMENT_RE.test(text)) return false;
  if (FORBIDDEN_FRAGMENT_URL_RE.test(text)) return false;
  return true;
}

function deriveStructuredBlocks(task) {
  const blocks = [];
  const request = task?.request ?? {};
  const result = task?.result ?? {};
  const lines = [
    `task_id: ${boundedText(task?.id, 80)}`,
    `state: ${boundedText(task?.state, 20)}`,
    `intent: ${boundedText(request.intent, 400)}`,
    `project_id: ${boundedText(request.project_id || '—', 80)}`,
    `approvals: paid=${request.approval?.paid_external_calls === true} online_writes=${request.approval?.online_writes === true} handoff=${request.approval?.handoff_creation === true}`,
    `updated_at: ${boundedText(task?.updated_at, 40)}`,
  ];
  blocks.push({ kind: 'summary', title: '任务概况', text: lines.join('\n') });
  const refs = Array.isArray(result.artifact_refs) ? result.artifact_refs.slice(0, MAX_TABLE_ROWS).map((ref) => boundedText(ref, MAX_CELL_CHARS)) : [];
  if (refs.length > 0) {
    blocks.push({ kind: 'table', title: '本次产物', columns: ['artifact_ref'], rows: refs.map((ref) => [ref]) });
  }
  if (task?.error) {
    blocks.push(fallbackBlock('任务诊断', `${boundedText(task.error.tool_code || task.error.code, 80)}: ${boundedText(task.error.message || task.error.summary, 240)}`));
  }
  return blocks;
}

function walkSpecItems(items, emit, state) {
  if (!Array.isArray(items) || state.depth > 8 || state.nodes >= 200) return;
  for (const item of items.slice(0, 200 - state.nodes)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    state.nodes += 1;
    const type = typeof item.type === 'string' ? item.type : '';
    if (CONTAINER_COMPONENTS.has(type)) {
      state.depth += 1;
      walkSpecItems(item.items, emit, state);
      state.depth -= 1;
      continue;
    }
    if (type === 'chart') emit(deriveChartBlock(item));
    else if (type === 'mermaid') emit(deriveFlowBlock(item));
    else if (type === 'table') emit(deriveTableBlock(item));
    else if (type === 'steps') emit(deriveStepsFlowBlock(item));
    else if (type === 'text' || type === 'callout' || type === 'list' || type === 'keyvalue' || type === 'stat' || type === 'progress' || type === 'badge' || type === 'link' || type === 'code' || type === 'json') emit(deriveSummaryBlock(item));
    else if (UNSUPPORTED_COMPONENTS.has(type)) emit(fallbackBlock(item.title || '组件', `不支持的组件类型：${boundedText(type, 40)}`));
  }
}

function deriveChartBlock(item) {
  const data = [];
  for (const point of (Array.isArray(item.data) ? item.data : []).slice(0, MAX_CHART_POINTS)) {
    if (!point || typeof point !== 'object') continue;
    const value = finiteNumber(point.value, -1e9, 1e9);
    if (value === undefined) continue;
    data.push({
      label: boundedText(point.label, MAX_LABEL_CHARS),
      value,
      ...(safeColor(point.color) ? { color: safeColor(point.color) } : {}),
    });
  }
  if (data.length === 0) return fallbackBlock(item.title || '图表', '图表数据为空或无效。');
  return { kind: 'chart', title: safeTitle(item.title) || '图表', chart: CHART_KINDS.has(item.kind) ? item.kind : 'bars', data };
}

function deriveFlowBlock(item) {
  const mermaid = typeof item.code === 'string' ? boundedText(item.code, MAX_MERMAID_CHARS) : '';
  if (!isValidFlowSource(mermaid)) return fallbackBlock(item.title || '流程', '流程图源码无效或超出边界。');
  return { kind: 'flow', title: safeTitle(item.title) || '流程图', mermaid };
}

function deriveStepsFlowBlock(item) {
  // Step labels are model-authored text placed inside generated mermaid node
  // brackets: strip characters that would break the bracket syntax, replace
  // hostile directive keywords with an inert marker, then re-validate the
  // composed source exactly like any other flow block.
  const steps = (Array.isArray(item.steps) ? item.steps : []).slice(0, MAX_FLOW_STEPS)
    .map((step) => boundedText(step && typeof step === 'object' ? step.title || step.desc || '' : step, MAX_LABEL_CHARS)
      .replace(/[[\]<>]/g, ' ')
      .replace(/\b(?:script|onerror|javascript|href|click)\b/gi, '•')
      .trim());
  const current = Number.isSafeInteger(item.current) ? item.current : -1;
  if (steps.length === 0 || steps.every((step) => !step)) return fallbackBlock(item.title || '步骤', '步骤数据为空。');
  const source = [
    'flowchart TD',
    ...steps.map((step, index) => `S${index}[${index === current ? '（当前）' : ''}${step}]`),
    ...steps.slice(0, -1).map((_, index) => `S${index}-->S${index + 1}`),
  ].join('\n');
  if (!isValidFlowSource(source)) return fallbackBlock(item.title || '步骤', '步骤数据无法构成安全的流程图。');
  return { kind: 'flow', title: safeTitle(item.title) || '执行步骤', mermaid: source };
}

function deriveTableBlock(item) {
  const columns = (Array.isArray(item.columns) ? item.columns : []).slice(0, MAX_TABLE_COLS).map((cell) => boundedText(cell, MAX_CELL_CHARS));
  const rows = (Array.isArray(item.rows) ? item.rows : []).slice(0, MAX_TABLE_ROWS)
    .filter((row) => Array.isArray(row))
    .map((row) => row.slice(0, columns.length).map((cell) => boundedText(cell, MAX_CELL_CHARS)));
  if (columns.length === 0 || rows.length === 0) return fallbackBlock(item.title || '表格', '表格数据为空或超出边界。');
  return { kind: 'table', title: safeTitle(item.title) || '表格', columns, rows };
}

function deriveSummaryBlock(item) {
  const lines = [];
  const title = safeTitle(item.title);
  if (title) lines.push(`# ${title}`);
  if (item.type === 'text') lines.push(boundedText(item.content, 800));
  else if (item.type === 'callout') lines.push(`${item.tone ? `[${boundedText(item.tone, 20)}] ` : ''}${boundedText(item.content, 800)}`);
  else if (item.type === 'list') {
    for (const entry of (Array.isArray(item.items) ? item.items : []).slice(0, 12)) {
      lines.push(`- ${boundedText(entry && typeof entry === 'object' ? `${entry.title || ''}${entry.desc ? `：${entry.desc}` : ''}` : entry, 300)}`);
    }
  } else if (item.type === 'keyvalue') {
    for (const pair of (Array.isArray(item.pairs) ? item.pairs : []).slice(0, 12)) {
      lines.push(`${boundedText(pair?.key, 100)}: ${boundedText(pair?.value, 200)}`);
    }
  } else if (item.type === 'stat') lines.push(`${boundedText(item.label, 100)}: ${boundedText(item.value, 100)}${item.delta ? ` (${boundedText(item.delta, 40)})` : ''}`);
  else if (item.type === 'progress') lines.push(`${boundedText(item.label, 100)}: ${boundedText(item.valueLabel, 40)}`);
  else if (item.type === 'badge') lines.push(boundedText(item.label, 100));
  else if (item.type === 'link') lines.push(`${boundedText(item.label, 100)} → ${boundedText(item.href, 300)}`);
  else if (item.type === 'code') lines.push(boundedText(item.code, 800));
  else if (item.type === 'json') {
    try { lines.push(boundedText(JSON.stringify(item.value), 800)); } catch { lines.push('(json)'); }
  }
  const text = lines.filter((line) => line.trim()).join('\n').slice(0, MAX_SUMMARY_CHARS);
  if (!text.trim()) return fallbackBlock(title || '文本', '文本内容为空。');
  return { kind: 'summary', title: title || '摘要', text };
}

function deriveFragmentBlock(title, html) {
  if (!isSafeFragment(html)) return fallbackBlock(title || '可视化', '可视化片段无效或超出安全边界。');
  return { kind: 'fragment', title: safeTitle(title) || '可视化', html: boundedText(html, MAX_FRAGMENT_BYTES) };
}

/**
 * Derive the bounded versioned presentation for one task result. Never
 * throws: any unexpected failure returns null, and the caller persists the
 * task exactly as before (presentation is additive and non-authoritative).
 */
export function derivePresentation(finalResponse, task) {
  try {
    const response = String(finalResponse ?? '');
    const blocks = [];
    const fenceCount = { value: 0 };
    FENCE_RE.lastIndex = 0;
    for (const match of response.matchAll(FENCE_RE)) {
      if (fenceCount.value >= MAX_FENCES || blocks.length >= MAX_PRESENTATION_BLOCKS) break;
      fenceCount.value += 1;
      const language = match[1].toLowerCase();
      const body = match[2] ?? '';
      if (language === 'dsh-ui') {
        try {
          const spec = JSON.parse(body);
          const emit = (block) => { if (block && blocks.length < MAX_PRESENTATION_BLOCKS) blocks.push(stampBlock(block, 'dsh-ui')); };
          walkSpecItems(spec && typeof spec === 'object' && Array.isArray(spec.items) ? spec.items : [spec], emit, { depth: 0, nodes: 0 });
        } catch {
          if (blocks.length < MAX_PRESENTATION_BLOCKS) blocks.push(stampBlock(fallbackBlock('GenUI', 'GenUI 围栏不是有效 JSON，已降级为文本。'), 'dsh-ui'));
        }
      } else if (language === 'visualize' || language === 'dsh-visualize') {
        if (blocks.length < MAX_PRESENTATION_BLOCKS) blocks.push(stampBlock(deriveFragmentBlock('可视化', body), 'visualize'));
      } else if (language === 'mermaid') {
        if (blocks.length < MAX_PRESENTATION_BLOCKS) blocks.push(stampBlock(isValidFlowSource(boundedText(body, MAX_MERMAID_CHARS))
          ? { kind: 'flow', title: '流程图', mermaid: boundedText(body, MAX_MERMAID_CHARS) }
          : fallbackBlock('流程图', '流程图源码无效或超出边界。'), 'mermaid'));
      }
    }
    for (const block of deriveStructuredBlocks(task)) {
      if (blocks.length >= MAX_PRESENTATION_BLOCKS) break;
      blocks.push(stampBlock(block, 'structured'));
    }
    if (blocks.length === 0) return null;
    let presentation = { schema_version: PRESENTATION_SCHEMA_VERSION, blocks };
    // Enforce the serialized byte ceiling by dropping the lowest-value tail
    // blocks (structured extras first); every block is individually bounded
    // so a single oversized block can never survive the total budget.
    while (Buffer.byteLength(JSON.stringify(presentation), 'utf8') > MAX_PRESENTATION_BYTES && presentation.blocks.length > 1) {
      presentation = { schema_version: PRESENTATION_SCHEMA_VERSION, blocks: presentation.blocks.slice(0, -1) };
    }
    return Buffer.byteLength(JSON.stringify(presentation), 'utf8') <= MAX_PRESENTATION_BYTES ? presentation : null;
  } catch {
    return null;
  }
}
