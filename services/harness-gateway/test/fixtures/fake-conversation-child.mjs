/* global setInterval */
const envelope = JSON.parse(process.argv.at(-1));
process.stdout.write(`${JSON.stringify({ type: 'session_resumed', sessionId: envelope.sessionId })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId: envelope.sessionId, event: { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '真实' } } } })}\n`);
if (envelope.content === 'wait-for-stop') {
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', () => {
    process.stdout.write(`${JSON.stringify({ type: 'conversation_completed', sessionId: envelope.sessionId, reason: { kind: 'aborted' } })}\n`);
    process.exit(0);
  });
} else if (envelope.content === 'error-after-completed') {
  process.stdout.write(`${JSON.stringify({ type: 'conversation_completed', sessionId: envelope.sessionId, reason: { kind: 'error' } })}\n`);
  setInterval(() => {}, 60_000);
} else {
  process.stdout.write(`${JSON.stringify({ type: 'conversation_completed', sessionId: envelope.sessionId, reason: { kind: 'completed' } })}\n`);
  if (envelope.content === 'terminal-with-trailing-frame') {
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId: envelope.sessionId, event: { seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '不得投影' } } } })}\n`);
  }
  if (envelope.content === 'hang-after-completed') setInterval(() => {}, 60_000);
}
