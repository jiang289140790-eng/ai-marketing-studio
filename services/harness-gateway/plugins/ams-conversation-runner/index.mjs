import z from '@deepseek-ai/schemastery';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

export const name = 'ams-conversation-runner';
export const inject = ['agentDefaultModel', 'agents', 'sessions'];
export const Config = z.object({ task: z.string().required() });

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function parseEnvelope(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('conversation envelope must be JSON'); }
  if (!value || value.schemaVersion !== 1 || typeof value.sessionId !== 'string'
    || !/^session-[0-9a-f-]{36}$/.test(value.sessionId)
    || typeof value.content !== 'string' || !value.content.trim()) {
    throw new Error('invalid conversation envelope');
  }
  return { sessionId: value.sessionId, content: value.content.trim() };
}

function setupSelection(selection) {
  // Agent setup may optionally return a prepared transaction exposing
  // `commit()`. Model selection installs directly into the agent context, so
  // do not leak its disposer/return value into that transaction contract.
  return (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined });
  };
}

async function run(ctx, raw, exit) {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const sessions = ctx.get('sessions');
  const defaultModel = ctx.get('agentDefaultModel');
  if (!agents || !sessions || !defaultModel) throw new Error('conversation services unavailable');
  const envelope = parseEnvelope(raw);
  const selection = defaultModel.currentSelection();
  const sessionId = SessionId(envelope.sessionId);
  let handle;
  try {
    handle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: setupSelection(selection),
    });
    write({ type: 'session_resumed', sessionId });
  } catch (error) {
    if (!String(error?.message || error).toLowerCase().includes('not found')) throw error;
    handle = await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: setupSelection(selection),
    });
    write({ type: 'session_created', sessionId });
  }

  const { agent } = handle;
  const firstSeq = agent.session.seq;
  const disposeEvents = ctx.on('session/event', (session, event) => {
    if (session.id === sessionId && event.seq >= firstSeq) write({ type: 'session_event', sessionId, event });
  }, { global: true });
  const onInput = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { if (JSON.parse(line).action === 'stop') agent.cancel({ kind: 'user' }); } catch { /* gateway-owned input */ }
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onInput);
  await agent.whenIdle();
  agent.followup(createUserMessage({ content: [{ type: 'text', text: envelope.content }], source: { kind: 'user' } }));
  await agent.whenIdle();
  await sessions.flush(agent.session);
  const end = agent.session.events.findLast((event) => event.seq >= firstSeq && event.type === 'turn/end');
  write({ type: 'conversation_completed', sessionId, reason: end?.data?.reason || { kind: 'error' } });
  process.stdin.off('data', onInput);
  disposeEvents();
  await handle.dispose();
  exit(end?.data?.reason?.kind === 'completed' || end?.data?.reason?.kind === 'aborted' ? 0 : 1);
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit');
  if (!exit) throw new Error('ams-conversation-runner requires appExit');
  run(ctx, config.task, exit).catch((error) => {
    process.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
}
