/* global Buffer */
import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_LINE_BYTES = 128 * 1024;
const MAX_EVENT_FILE_BYTES = 8 * 1024 * 1024;

export async function loadTaskSnapshots(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const latest = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
    try {
      const event = JSON.parse(line);
      if (event?.event === 'pruned' && event.task_id) latest.delete(event.task_id);
      else if (event?.task?.id && event.task_id === event.task.id) latest.set(event.task.id, event.task);
    } catch {
      // A torn final append is ignored; previous complete snapshots remain authoritative.
    }
  }
  return [...latest.values()];
}

export function appendTaskEvent(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify(event);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw Object.assign(new Error('Task event exceeds the persistence bound.'), { code: 'EVENT_TOO_LARGE' });
  appendFileSync(path, `${line}\n`, { encoding: 'utf8', flush: true });
  if (statSync(path).size > MAX_EVENT_FILE_BYTES) compactTaskEvents(path);
}

function compactTaskEvents(path) {
  const latest = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
    try {
      const event = JSON.parse(line);
      if (event?.event === 'pruned' && event.task_id) latest.delete(event.task_id);
      else if (event?.task?.id && event.task_id === event.task.id) latest.set(event.task.id, event);
    } catch {
      // Ignore a torn tail and compact only complete events.
    }
  }
  const temporary = `${path}.compact.tmp`;
  const output = [...latest.values()].map((event) => JSON.stringify(event)).join('\n');
  writeFileSync(temporary, output ? `${output}\n` : '', { encoding: 'utf8', flush: true });
  renameSync(temporary, path);
}
