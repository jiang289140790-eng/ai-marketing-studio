import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const TASK_ID = /^ht-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;

function markerPath(home, taskId) {
  if (!TASK_ID.test(String(taskId || ''))) throw Object.assign(new Error('Task identity is invalid.'), { code: 'TASK_ID_INVALID' });
  const root = resolve(String(home || ''), 'task-required-failures');
  const file = resolve(root, `${taskId}.json`);
  if (!file.startsWith(`${root}${sep}`)) throw Object.assign(new Error('Failure marker escaped its root.'), { code: 'FAILURE_MARKER_PATH_INVALID' });
  return { root, file };
}

function normalize(value) {
  return {
    code: 'HARNESS_EXIT_FAILED',
    tool_code: SAFE_CODE.test(String(value?.tool_code || value?.code || ''))
      ? String(value.tool_code || value.code)
      : 'AMS_REQUIRED_TOOL_FAILED',
    operation: String(value?.operation || 'unknown').replace(/[^a-z0-9._-]/gi, '').slice(0, 80) || 'unknown',
    category: 'ams_tool_plugin',
    stage: 'tool_call',
    exit_code: null,
    summary: 'A required AI Marketing Studio tool failed; dependent actions were stopped.',
  };
}

export function writeRequiredFailure(home, taskId, value) {
  const { root, file } = markerPath(home, taskId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(normalize(value)), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

export function consumeRequiredFailure(home, taskId) {
  const { file } = markerPath(home, taskId);
  try { return normalize(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  finally { rmSync(file, { force: true }); }
}

export function clearRequiredFailure(home, taskId) {
  const { file } = markerPath(home, taskId);
  rmSync(file, { force: true });
}
