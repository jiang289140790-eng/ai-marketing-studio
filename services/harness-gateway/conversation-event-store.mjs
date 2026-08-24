import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';

export function appendConversationEvent(file, event) {
  const fd = openSync(file, 'a', 0o600);
  try { appendFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
}

export function loadConversationEvents(file) {
  if (!file || !existsSync(file)) return [];
  const events = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try { const event = JSON.parse(line); if (event?.event_id) events.push(event); } catch { /* torn tail */ }
  }
  return events;
}
