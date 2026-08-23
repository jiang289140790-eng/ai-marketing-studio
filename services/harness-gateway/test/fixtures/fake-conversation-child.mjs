const envelope = JSON.parse(process.argv.at(-1));
process.stdout.write(`${JSON.stringify({ type: 'session_resumed', sessionId: envelope.sessionId })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId: envelope.sessionId, event: { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '真实' } } } })}\n`);
if (envelope.content === 'wait-for-stop') {
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', () => {
    process.stdout.write(`${JSON.stringify({ type: 'conversation_completed', sessionId: envelope.sessionId, reason: { kind: 'aborted' } })}\n`);
    process.exit(0);
  });
} else {
  process.stdout.write(`${JSON.stringify({ type: 'conversation_completed', sessionId: envelope.sessionId, reason: { kind: 'completed' } })}\n`);
}
