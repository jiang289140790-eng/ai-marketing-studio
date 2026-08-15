/* global TextEncoder */
// Browser mirror of the gateway presentation contract. The gateway persists a
// bounded, versioned presentation payload on task results; this module
// re-validates every payload before rendering (defense in depth — a tampered
// or legacy payload can never reach the DOM unchecked) and derives the same
// bounded structured blocks the gateway derives for tasks without one.

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
export const MAX_FALLBACK_CHARS = 300;

const CHART_KINDS = new Set(['bars', 'line', 'donut']);
const FLOW_HEAD_RE = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i;
const FORBIDDEN_FLOW_LINE_RE = /^\s*(?:classDef|class|style|linkStyle|href|click|interpolate)\b/;
const FORBIDDEN_FLOW_TEXT_RE = /<|href\b|click\b/iu;
const SAFE_COLOR_RE = /^(?:#[\da-fA-F]{3,8}|rgba?\([^)]{0,64}\)|hsla?\([^)]{0,64}\))$/;
const SKELETON_TAG_RE = /<!doctype\b|<\s*(?:html|head|body)\b/iu;
const FORBIDDEN_FRAGMENT_RE = /<\s*(?:script|iframe|frame|object|embed)\b|\son[a-z]+\s*=/iu;
const FORBIDDEN_FRAGMENT_URL_RE = /(?:href|src)\s*=\s*["']\s*(?:javascript:|data:text\/html)/iu;
const BLOCK_ID_RE = /^[0-9a-f]{16}$/;
const BLOCK_FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const BLOCK_SOURCE_RE = /^[a-z-]{2,24}$/;

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

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

export function normalizePresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema_version !== PRESENTATION_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.blocks) || value.blocks.length === 0 || value.blocks.length > MAX_PRESENTATION_BLOCKS) return null;
  const blocks = [];
  for (const candidate of value.blocks.slice(0, MAX_PRESENTATION_BLOCKS)) {
    const block = normalizeBlock(candidate);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  const normalized = { schema_version: PRESENTATION_SCHEMA_VERSION, blocks };
  // The re-validation gate re-enforces the serialized byte ceiling so a
  // tampered or hand-built payload can never outgrow the transport budget.
  if (byteLength(JSON.stringify(normalized)) > MAX_PRESENTATION_BYTES) return null;
  return normalized;
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
        data.push({ label: boundedText(point.label, MAX_LABEL_CHARS), value, ...(safeColor(point.color) ? { color: safeColor(point.color) } : {}) });
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

// ---- Bounded mermaid subset parser (browser renderer front half) ----------
// Structural validation the renderer needs before layout: duplicate/conflicting
// node definitions, unknown shapes, subgraphs, and cycles all fail closed so
// the block degrades to a plain code view instead of executing anything.

export const MAX_FLOW_NODES = 30;
export const MAX_FLOW_EDGES = 40;
const MAX_FLOW_TEXT = 60;
const MAX_FLOW_SOURCE = 4_000;

const EDGE_RE = /^([\s\S]*?)\s*(-->|==>|---|-\.->)\s*(?:\|([^|]*)\|)?\s*([\s\S]*?)$/;
const BARE_ID_RE = /^[A-Za-z_][\w]*$/;

const SHAPES = [
  ['stadium', /^\(\[([\s\S]*?)\]\)$/],
  ['circle', /^\(\(([\s\S]*?)\)\)$/],
  ['round', /^\(([\s\S]*?)\)$/],
  ['hexagon', /^\{\{([\s\S]*?)\}\}$/],
  ['diamond', /^\{([\s\S]*?)\}$/],
  ['parallelogram', /^\[\/([\s\S]*?)\/\]$/],
  ['parallelogramAlt', new RegExp('^\\[\\\\' + '([\\s\\S]*?)' + '\\\\' + '\\]$')],
  ['flag', /^>([\s\S]*?)\]$/],
  ['rect', /^\[([\s\S]*?)\]$/],
];

function cleanFlowLabel(raw) {
  const text = String(raw ?? '').trim();
  const unquoted = text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"' ? text.slice(1, -1) : text;
  return unquoted.slice(0, MAX_FLOW_TEXT);
}

function parseFlowNodeLine(line) {
  const idMatch = /^[A-Za-z_][\w]*/.exec(line);
  if (!idMatch) return null;
  const id = idMatch[0];
  const rest = line.slice(id.length).trim();
  if (!rest) return { id, label: id, shape: 'rect' };
  if (!BARE_ID_RE.test(id)) return null;
  for (const [shape, pattern] of SHAPES) {
    const match = pattern.exec(rest);
    if (match && match[0] === rest) return { id, label: cleanFlowLabel(match[1]), shape };
  }
  return null;
}

export function parseFlowSource(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_FLOW_SOURCE) return null;
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('%%'));
  const head = FLOW_HEAD_RE.exec(lines[0] || '');
  if (!head) return null;
  const direction = head[1].toUpperCase();
  const nodes = new Map();
  const edges = [];
  const ensureNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: id, shape: 'rect' });
    return nodes.get(id);
  };
  // Define a node (or upgrade a bare placeholder created by an earlier edge
  // line). Conflicting redefinitions with a different shape/label are
  // ambiguous mermaid; fail closed instead of guessing.
  const defineNode = (node) => {
    if (nodes.has(node.id)) {
      const existing = nodes.get(node.id);
      const placeholder = existing.label === existing.id && existing.shape === 'rect';
      if (placeholder) {
        nodes.set(node.id, node);
        return true;
      }
      if (existing.label === node.label && existing.shape === node.shape) return true;
      return false;
    }
    nodes.set(node.id, node);
    return true;
  };
  // One side of an edge: a bare id or an inline definition like `A[采集]`.
  const parseSide = (part) => {
    const trimmed = part.trim();
    if (BARE_ID_RE.test(trimmed)) return { id: trimmed, def: null };
    const node = parseFlowNodeLine(trimmed);
    return node ? { id: node.id, def: node } : null;
  };
  for (const raw of lines.slice(1)) {
    if (/^subgraph\b/i.test(raw) || /^end\s*$/i.test(raw)) return null;
    // Normalize the two worded label forms: `A -- label --> B` and
    // `A -. label .-> B` into the piped form the edge regex accepts.
    const line = raw
      .replace(/^([\s\S]*?)\s+--\s+([^>-][\s\S]*?)\s+-->/u, (_match, left, label) => `${left} -->|${label}| `)
      .replace(/^([\s\S]*?)\s+-\.\s+([^>-][\s\S]*?)\s+\.->/u, (_match, left, label) => `${left} -.->|${label}| `);
    if (/-->|==>|---|-\.->/.test(line)) {
      const match = EDGE_RE.exec(line);
      if (!match) return null;
      const [, fromChain, op, label, toChain] = match;
      const fromParts = fromChain.split('&').map(parseSide);
      const toParts = toChain.split('&').map(parseSide);
      if (!fromParts.length || !toParts.length || fromParts.some((part) => !part) || toParts.some((part) => !part)) return null;
      for (const part of [...fromParts, ...toParts]) {
        if (part.def && !defineNode(part.def)) return null;
        ensureNode(part.id);
        if (nodes.size > MAX_FLOW_NODES) return null;
      }
      for (const from of fromParts) {
        for (const to of toParts) {
          if (edges.length >= MAX_FLOW_EDGES) return null;
          edges.push({ from: from.id, to: to.id, op, label: label ? cleanFlowLabel(label) : '' });
        }
      }
      continue;
    }
    const node = parseFlowNodeLine(line);
    if (!node || !defineNode(node)) return null;
    if (nodes.size > MAX_FLOW_NODES) return null;
  }
  if (nodes.size === 0) return null;
  return { direction, nodes: [...nodes.values()], edges };
}

function estimateFlowWidth(label) {
  let units = 0;
  for (const character of label) units += character.charCodeAt(0) < 128 ? 7.5 : 12.5;
  return Math.min(200, Math.max(64, Math.ceil(units) + 28));
}

/**
 * Pure layout of a parsed flow: ranks by longest path, positions per rank.
 * Cycles (Kahn's algorithm leaves nodes unordered) fail closed with null so
 * the renderer degrades to the bounded code view.
 */
export function layoutFlowSource(parsed) {
  if (!parsed || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return null;
  const { direction, nodes, edges } = parsed;
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
  }
  const queue = nodes.filter((node) => (incoming.get(node.id) || 0) === 0).map((node) => node.id);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of outgoing.get(id) || []) {
      const remaining = (incoming.get(next) || 1) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) return null;
  const rank = new Map(order.map((id) => [id, 0]));
  for (const id of order) {
    const current = rank.get(id) || 0;
    for (const next of outgoing.get(id) || []) rank.set(next, Math.max(rank.get(next) || 0, current + 1));
  }
  const byRank = new Map();
  for (const node of nodes) {
    const value = rank.get(node.id) || 0;
    if (!byRank.has(value)) byRank.set(value, []);
    byRank.get(value).push(node);
  }
  const horizontal = direction === 'LR' || direction === 'RL';
  const gapX = horizontal ? 190 : 160;
  const gapY = horizontal ? 72 : 96;
  const placed = new Map();
  let maxX = 0;
  let maxY = 0;
  for (const [rankValue, members] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    const column = direction === 'RL' || direction === 'BT' ? -rankValue : rankValue;
    members.forEach((node, index) => {
      const width = node.shape === 'circle' ? 56 : estimateFlowWidth(node.label);
      const height = node.shape === 'circle' ? 56 : 40;
      const x = horizontal ? column * gapX : index * gapX;
      const y = horizontal ? index * gapY : column * gapY;
      placed.set(node.id, { x, y, width, height });
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    });
  }
  const minX = Math.min(0, ...nodes.map((node) => placed.get(node.id).x));
  const minY = Math.min(0, ...nodes.map((node) => placed.get(node.id).y));
  for (const position of placed.values()) {
    position.x -= minX;
    position.y -= minY;
  }
  return { direction, placed, width: maxX - minX + 24, height: maxY - minY + 24, edges };
}

export function isSafeFragment(html) {
  const text = String(html ?? '');
  if (!text.trim()) return false;
  if (byteLength(text) > MAX_FRAGMENT_BYTES) return false;
  if (SKELETON_TAG_RE.test(text)) return false;
  if (FORBIDDEN_FRAGMENT_RE.test(text)) return false;
  if (FORBIDDEN_FRAGMENT_URL_RE.test(text)) return false;
  return true;
}

// Mirrors the gateway's structured-block derivation so legacy tasks (no
// persisted presentation) still visualize their structured results, and the
// same bounded shapes render in both places.
export function deriveStructuredBlocks(task) {
  const blocks = [];
  const request = task?.request ?? {};
  const result = task?.result ?? {};
  blocks.push({
    kind: 'summary',
    title: '任务概况',
    text: [
      `task_id: ${boundedText(task?.id, 80)}`,
      `state: ${boundedText(task?.state, 20)}`,
      `intent: ${boundedText(request.intent, 400)}`,
      `project_id: ${boundedText(request.project_id || '—', 80)}`,
      `approvals: paid=${request.approval?.paid_external_calls === true} online_writes=${request.approval?.online_writes === true} handoff=${request.approval?.handoff_creation === true}`,
      `updated_at: ${boundedText(task?.updated_at, 40)}`,
    ].join('\n'),
  });
  const refs = Array.isArray(result.artifact_refs) ? result.artifact_refs.slice(0, MAX_TABLE_ROWS).map((ref) => boundedText(ref, MAX_CELL_CHARS)) : [];
  if (refs.length > 0) {
    blocks.push({ kind: 'table', title: '本次产物', columns: ['artifact_ref'], rows: refs.map((ref) => [ref]) });
  }
  if (task?.error) {
    blocks.push({
      kind: 'fallback',
      title: '任务诊断',
      text: `${boundedText(task.error.tool_code || task.error.code, 80)}: ${boundedText(task.error.message || task.error.summary, 240)}`.slice(0, MAX_FALLBACK_CHARS),
    });
  }
  return blocks.slice(0, MAX_PRESENTATION_BLOCKS);
}

export function resolvePresentationBlocks(task) {
  if (!task) return [];
  const raw = task.result?.presentation;
  if (raw && typeof raw === 'object') {
    const persisted = normalizePresentation(raw);
    if (persisted) return persisted.blocks;
    // A payload existed but failed validation: surface a bounded fallback
    // notice plus the structured blocks so the rejection is visible instead
    // of silently dropping the visualization.
    return [
      { kind: 'fallback', title: '任务结果可视化', text: '可视化载荷未能通过安全校验，已降级为文本。' },
      ...deriveStructuredBlocks(task).slice(0, MAX_PRESENTATION_BLOCKS - 1),
    ];
  }
  return deriveStructuredBlocks(task);
}
