/* global AbortSignal, fetch */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendTaskArtifactRefs } from './artifact-journal.mjs';
import { writeRequiredFailure } from './required-failure-journal.mjs';

const name = 'ams-harness-tools';
const inject = ['tools', 'systemPrompt'];
const DEFAULT_NATIVE_SESSION_GATEWAY_URL = 'http://127.0.0.1:8790';
const DEFAULT_GATEWAY_HMAC_SECRET_FILE = '/run/secrets/ams_gateway_hmac_secret';
const DEFAULT_TOOL_BRIDGE_URL = 'https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/harness-tool-bridge';
const DEFAULT_TOOL_BRIDGE_SECRET_FILE = '/run/secrets/ams_tool_bridge_secret';

function environmentRuntime() {
  let approval = {};
  try { approval = JSON.parse(process.env.AMS_TASK_APPROVAL || '{}'); } catch { approval = {}; }
  return {
    task_id: process.env.AMS_TASK_ID || '',
    user_id: process.env.AMS_USER_ID || '',
    project_id: process.env.AMS_PROJECT_ID || null,
    approval,
  };
}

function nativeTaskId(sessionId) {
  const hex = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `ht-${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function signGatewayContext(secret, path, userId, timestamp, rawBody) {
  return createHmac('sha256', secret)
    .update(`POST\n${path}\n${userId}\n${timestamp}\n\n${rawBody}`)
    .digest('hex');
}

function stableSessionId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 192) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)) return '';
  return trimmed;
}

function nativeSessionIdFromExecution(execution) {
  const candidates = [
    execution?.agent?.id,
    execution?.agent?.sessionId,
    execution?.agentId,
    execution?.session?.id,
    execution?.sessionId,
    execution?.ctx?.agent?.id,
    execution?.ctx?.agent?.sessionId,
    execution?.ctx?.agentId,
    execution?.ctx?.session?.id,
    execution?.ctx?.sessionId,
    execution?.context?.agent?.id,
    execution?.context?.agent?.sessionId,
    execution?.context?.agentId,
    execution?.context?.session?.id,
    execution?.context?.sessionId,
  ];
  for (const candidate of candidates) {
    const sessionId = stableSessionId(candidate);
    if (sessionId) return sessionId;
  }
  const seen = new Set();
  const stack = [{ value: execution, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) continue;
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (/authorization|token|secret|password|cookie/i.test(key)) continue;
      if (/session|agent|thread|conversation/i.test(key)) {
        const sessionId = stableSessionId(nested);
        if (sessionId) return sessionId;
        if (nested && typeof nested === 'object') {
          for (const childKey of ['sessionId', 'agentId', 'threadId', 'conversationId', 'id']) {
            const childSessionId = stableSessionId(nested[childKey]);
            if (childSessionId) return childSessionId;
          }
        }
      }
      if (nested && typeof nested === 'object') stack.push({ value: nested, depth: depth + 1 });
    }
  }
  return '';
}

async function requestNativeContext({ path, rawBody }) {
  const secretPath = process.env.AMS_GATEWAY_HMAC_SECRET_FILE || DEFAULT_GATEWAY_HMAC_SECRET_FILE;
  const gatewaySecret = secretPath ? readFileSync(secretPath, 'utf8').trim() : '';
  if (gatewaySecret.length < 32) {
    throw Object.assign(new Error('Native Harness session authorization is unavailable.'), { code: 'NATIVE_SESSION_AUTH_UNAVAILABLE' });
  }
  const userId = 'ams-tools';
  const timestamp = String(Date.now());
  const signature = signGatewayContext(gatewaySecret, path, userId, timestamp, rawBody);
  const gatewayUrl = String(process.env.AMS_NATIVE_SESSION_GATEWAY_URL || DEFAULT_NATIVE_SESSION_GATEWAY_URL).replace(/\/$/, '');
  let response;
  try {
    response = await fetch(`${gatewayUrl}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-ams-user-id': userId,
        'x-ams-timestamp': timestamp,
        'x-ams-signature': signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw Object.assign(new Error('Native Harness session authorization is unavailable.'), { code: 'NATIVE_SESSION_AUTH_UNAVAILABLE' });
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.delegated_authorization) {
    throw Object.assign(new Error('A delegated bearer authorization is required.'), {
      code: String(result?.code || 'DELEGATED_AUTHORIZATION_REQUIRED'),
    });
  }
  return result;
}

async function resolveRuntime(execution) {
  const environment = environmentRuntime();
  const delegatedAuthorization = String(process.env.AMS_DELEGATED_AUTHORIZATION || '').trim();
  if (delegatedAuthorization) return { context: environment, delegatedAuthorization };

  const sessionId = nativeSessionIdFromExecution(execution);
  let result;
  if (sessionId) {
    try {
      result = await requestNativeContext({
        path: '/v1/native-sessions/context',
        rawBody: JSON.stringify({ session_id: sessionId }),
      });
    } catch (error) {
      if (!['NATIVE_SESSION_CONTEXT_REQUIRED', 'NATIVE_SESSION_ID_INVALID', 'DELEGATED_AUTHORIZATION_REQUIRED'].includes(error?.code)) {
        throw error;
      }
      result = await requestNativeContext({ path: '/v1/native-sessions/current', rawBody: '{}' });
    }
  } else {
    result = await requestNativeContext({ path: '/v1/native-sessions/current', rawBody: '{}' });
  }
  const stableId = sessionId || `current:${result.user_id}:${result.project_id || 'no-project'}`;
  return {
    context: {
      task_id: nativeTaskId(stableId),
      user_id: result.user_id,
      project_id: result.project_id ?? null,
      approval: result.approval || {},
    },
    delegatedAuthorization: result.delegated_authorization,
  };
}

async function loadClient(delegatedAuthorization) {
  const modulePath = process.env.AMS_TOOL_CLIENT_MODULE || '/app/tool-client.mjs';
  const module = await import(modulePath);
  const secretPath = process.env.AMS_TOOL_BRIDGE_SECRET_FILE || DEFAULT_TOOL_BRIDGE_SECRET_FILE;
  const bridgeSecret = secretPath ? readFileSync(secretPath, 'utf8').trim() : '';
  return module.createToolClient({
    bridgeUrl: process.env.AMS_TOOL_BRIDGE_URL || DEFAULT_TOOL_BRIDGE_URL,
    bridgeSecret,
    delegatedAuthorization,
    allowInternalHttp: true,
  });
}

function stableIdempotencyKey(context, operation, payload, explicit) {
  const value = String(explicit || '').trim();
  if (value) return value;
  const basis = JSON.stringify({
    task_id: context.task_id || 'no-task',
    user_id: context.user_id || 'no-user',
    project_id: context.project_id || null,
    operation,
    payload,
  });
  return `ams-${operation.replace(/[^a-z0-9]+/gi, '-')}-${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

function payloadFromArgs(args, fieldNames = []) {
  const payload = { ...(args.payload && typeof args.payload === 'object' ? args.payload : {}) };
  for (const field of fieldNames) {
    if (args[field] !== undefined) payload[field] = args[field];
  }
  return payload;
}

const PROJECT_ID_RE = /^prj-[0-9a-f]{24}$/;

function firstReadableProjectId(result) {
  const projects = Array.isArray(result?.data?.projects) ? result.data.projects : [];
  const project = projects.find((item) => item && typeof item === 'object' && PROJECT_ID_RE.test(String(item.id || '')));
  return project?.id || '';
}

async function ensureCurrentProjectPayload({ operation, payload, client, context, signal }) {
  if (operation !== 'workspace.project.read') return payload;
  if (PROJECT_ID_RE.test(String(payload.project_id || ''))) return payload;
  if (PROJECT_ID_RE.test(String(context.project_id || ''))) return { ...payload, project_id: context.project_id };

  const listPayload = {};
  const listResult = await client({
    schema_version: 'ams_harness_tool_v1',
    operation: 'workspace.project.list',
    payload: listPayload,
    idempotency_key: stableIdempotencyKey(context, 'workspace.project.list', listPayload, ''),
  }, context, signal);
  if (!listResult || listResult.ok === false) return payload;
  const projectId = firstReadableProjectId(listResult);
  return projectId ? { ...payload, project_id: projectId } : payload;
}

const DIRECT_TOOLS = [
  {
    name: 'ams_project_list',
    operation: 'workspace.project.list',
    description: 'List AI Marketing Studio projects available to the current user. Use this for AMS project discovery, not for local filesystem folders.',
    fields: [],
  },
  {
    name: 'ams_project_read',
    operation: 'workspace.project.read',
    description: 'Read the current or specified AI Marketing Studio business project, including Evidence, Analysis, Knowledge, Brief and artifacts. Mandatory for Chinese requests such as “查看当前项目状态”, “当前项目”, “项目状态”, “我现在能做什么”, or any AMS project status question. Do not answer those by inspecting the local Harness workspace directory.',
    fields: ['project_id'],
    optional: ['project_id'],
  },
  {
    name: 'ams_lineage_audit',
    operation: 'workspace.lineage.audit',
    description: 'Audit lineage across Evidence, Analysis, Knowledge Card, Brief, Handoff and Artifact records.',
    fields: ['project_id'],
  },
  {
    name: 'ams_research_collect_url',
    operation: 'research.collect_url',
    description: 'Collect one public URL, such as an X/Twitter post, as a research source.',
    fields: ['url', 'project_id'],
    optional: ['project_id'],
  },
  {
    name: 'ams_research_search_x',
    operation: 'research.search_x',
    description: 'Search public X/Twitter content for a keyword or topic.',
    fields: ['keyword', 'count', 'sort', 'project_id'],
    optional: ['count', 'sort', 'project_id'],
  },
  {
    name: 'ams_research_search_reddit',
    operation: 'research.search_reddit',
    description: 'Search public Reddit posts for a keyword, subreddit, sort and time window.',
    fields: ['keyword', 'count', 'sort', 'subreddit', 'time_filter', 'project_id'],
    optional: ['count', 'sort', 'subreddit', 'time_filter', 'project_id'],
  },
  {
    name: 'ams_research_analyze_persisted',
    operation: 'research.analyze_persisted',
    description: 'Run Qwen analysis for exactly one persisted Evidence record.',
    fields: ['project_id', 'evidence_id'],
  },
  {
    name: 'ams_research_inspect_attachments',
    operation: 'research.inspect_attachments',
    description: 'Inspect uploaded image or video attachments before creating Evidence.',
    fields: ['project_id', 'attachments'],
    optional: ['project_id'],
  },
  {
    name: 'ams_evidence_create',
    operation: 'workspace.evidence.create',
    description: 'Persist one validated Evidence record into the current AMS project.',
    fields: ['project_id', 'evidence'],
  },
  {
    name: 'ams_analysis_create',
    operation: 'workspace.analysis.create',
    description: 'Persist one model or deterministic analysis result for one exact Evidence record.',
    fields: ['project_id', 'analysis'],
  },
  {
    name: 'ams_knowledge_card_create',
    operation: 'workspace.card.create',
    description: 'Create a Knowledge Card from validated analysis and source provenance.',
    fields: ['project_id', 'card'],
  },
  {
    name: 'ams_brief_assemble',
    operation: 'workspace.brief.assemble',
    description: 'Assemble a pending-review Campaign Brief from exact Knowledge Card identities.',
    fields: ['project_id', 'expected_fingerprint', 'brief'],
  },
  {
    name: 'ams_generation_quote',
    operation: 'generation.quote',
    description: 'Create an immutable quote for Bailian image or video generation before paid submission.',
    fields: ['project_id', 'brief_id', 'kind', 'prompt', 'provider', 'model', 'payload'],
    optional: ['brief_id', 'provider', 'model', 'payload'],
  },
  {
    name: 'ams_generation_submit',
    operation: 'generation.submit',
    description: 'Submit exactly one approved generation quote for execution.',
    fields: ['project_id', 'quote_id', 'payload'],
    optional: ['payload'],
  },
  {
    name: 'ams_generation_status',
    operation: 'generation.status',
    description: 'Read the status of a generation job without creating a new paid call.',
    fields: ['project_id', 'job_id'],
  },
  {
    name: 'ams_generation_artifact',
    operation: 'generation.artifact',
    description: 'Read generated image or video Artifact metadata and storage URL.',
    fields: ['project_id', 'artifact_id', 'job_id'],
    optional: ['artifact_id', 'job_id'],
  },
];

const AMS_AGENT_PLAYBOOK = [
  'AMS business plugin playbook:',
  '1. Treat Harness as the agent loop. Do not ask AMS to create a separate fixed plan unless the user explicitly asks to inspect an old task.',
  '0. HARD AMS PROJECT RULE: For “查看当前项目状态”, “当前项目”, “当前项目状态”, “项目状态”, “有哪些 Evidence/Knowledge/Brief”, “我现在能做什么”, or any current AMS project question, call ams_project_read first. The local Harness workspace path such as /home/node/* is scratch storage and is never the AMS business project. Do not use Bash, pwd, ls, git status, or filesystem inspection to answer AMS project status before ams_project_read.',
  '1a. If the user asks "当前项目", "当前项目状态", "项目状态", "有哪些 Evidence/Knowledge/Brief", or "我现在能做什么" inside AI Marketing Studio, call ams_project_read first. These are AMS business project questions, not local workspace filesystem questions.',
  '2. For a URL/post analysis request, use: ams_project_read -> ams_research_collect_url -> ams_evidence_create -> ams_research_analyze_persisted -> ams_analysis_create -> ams_knowledge_card_create -> ams_brief_assemble when the user asks for a Brief.',
  '3. For topic search requests, use ams_research_search_x and/or ams_research_search_reddit, then persist selected source records with ams_evidence_create before analyzing them.',
  '4. For attachment image/video analysis, use ams_research_inspect_attachments, then ams_evidence_create, then the same Analysis -> Knowledge -> Brief path.',
  '5. For image/video generation, read the project/Brief first, then use ams_generation_quote. Only call ams_generation_submit after the user-approved paid scope is available.',
  '6. Use exact ids returned by tools. Never make up project_id, evidence_id, analysis_id, knowledge card id, brief id, quote id, job id, artifact id, revision or fingerprint.',
  '7. If a tool returns a bounded failure code, stop dependent steps and explain the exact next user-visible action.',
  '8. Keep user-facing answers short: what was created, where to review it, and what the next safe action is.',
].join('\n');

function apply(ctx) {
  const requiredFailures = new Map();
  const manifest = String(process.env.AMS_CAPABILITY_MANIFEST || '[]').slice(0, 24_000);
  const conversationMode = ['agent', 'qa'].includes(process.env.AMS_CONVERSATION_MODE || '');
  ctx.systemPrompt.section({
    name: conversationMode ? 'ams:agent' : 'ams:operator',
    order: 40,
    text: (conversationMode ? [
      'You are DeepSeek Harness operating AI Marketing Studio through plugin tools.',
      'Answer ordinary questions directly and naturally. For actionable marketing work, prefer the specific ams_* tools registered by this plugin. Use ams_call only as a compatibility fallback for an operation that has no specific tool yet.',
      'Hard rule: when the user asks to view/read/check the current project or project status, including “查看当前项目状态”, call ams_project_read before any shell, filesystem, web, or generic diagnostic tool. The filesystem workspace is not the AMS project.',
      'Do not request or create a separate deterministic AMS execution plan.',
      'If the user goal is unclear, ask one concise clarification question instead of mapping it to a default workflow.',
      'Use the capability catalog as available tools, but you may choose the sequence yourself based on the user goal.',
      AMS_AGENT_PLAYBOOK,
      `Current reviewed capability catalog: ${manifest}`,
    ] : [
      'You operate AI Marketing Studio only through the ams_call tool.',
    ]).concat([
      'Never invent an operation, user, project, revision, cost, source, or artifact identity.',
      'Read current state before proposing a write. Use exact returned identities and revision guards.',
      'For research.collect_url use payload {url} with only an optional exact bound project_id echo.',
      'For research.analyze_persisted use payload exactly {project_id,evidence_id}; never send evidence_ids, count, or a batch payload.',
      'To analyze multiple persisted Evidence records, call research.analyze_persisted once per exact evidence_id, sequentially, with a distinct idempotency_key and stop on the first failure.',
      'Paid calls, online writes, and handoff creation fail unless the trusted task approval grants them.',
      'Never request deletion, archival, arbitrary SQL, schema/Auth changes, production access, or social publishing.',
      'When a tool fails, report its exact bounded code and stop dependent actions.',
    ]).join('\n'),
  });

  async function callAms(args, execution, operationOverride = '') {
    const { context, delegatedAuthorization } = await resolveRuntime(execution);
    const failureKey = context.task_id;
    const requiredFailure = requiredFailures.get(failureKey);
    if (requiredFailure) {
      throw Object.assign(new Error('A required predecessor tool failed; dependent actions are blocked.'), {
        code: 'AMS_DEPENDENCY_BLOCKED',
      });
    }
    const operation = operationOverride || args.operation;
    const client = await loadClient(delegatedAuthorization);
    const initialPayload = args.payload && typeof args.payload === 'object' ? args.payload : {};
    const payload = await ensureCurrentProjectPayload({
      operation,
      payload: initialPayload,
      client,
      context,
      signal: execution?.signal,
    });
    const request = {
      schema_version: 'ams_harness_tool_v1',
      operation,
      payload,
      idempotency_key: stableIdempotencyKey(context, operation, payload, args.idempotency_key),
    };
    if (args.expected_revision !== undefined) request.expected_revision = args.expected_revision;
    try {
      const result = await client(request, context, execution?.signal);
      if (!result || result.ok === false) {
        const failure = {
          code: String(result?.code || 'AMS_REQUIRED_TOOL_FAILED'),
          operation,
        };
        requiredFailures.set(failureKey, failure);
        writeRequiredFailure(process.env.DSH_HOME || process.env.HOME || '', context.task_id, failure);
        throw Object.assign(new Error('A required AI Marketing Studio tool failed.'), { code: failure.code });
      }
      appendTaskArtifactRefs(process.env.DSH_HOME || process.env.HOME || '', context.task_id, result);
      return result;
    } catch (error) {
      if (!requiredFailures.has(failureKey)) {
        const failure = { code: String(error?.code || 'AMS_REQUIRED_TOOL_FAILED'), operation };
        requiredFailures.set(failureKey, failure);
        writeRequiredFailure(process.env.DSH_HOME || process.env.HOME || '', context.task_id, failure);
      }
      throw error;
    }
  }

  for (const tool of DIRECT_TOOLS) {
    const parameters = {
      idempotency_key: { type: 'string' },
      expected_revision: { type: 'integer' },
    };
    for (const field of tool.fields) {
      const fieldType = field === 'payload' || field === 'attachments' || field === 'evidence' || field === 'analysis' || field === 'card' || field === 'brief'
        ? 'object'
        : field === 'count'
          ? 'integer'
          : 'string';
      parameters[field] = { type: fieldType };
      if (fieldType === 'object') parameters[field].additionalProperties = true;
      if (!(tool.optional || []).includes(field)) parameters[field].required = true;
    }
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, execution) {
        const payload = payloadFromArgs(args, tool.fields);
        return callAms({ ...args, payload }, execution, tool.operation);
      },
      presentCall: () => ({ card: 'generic', title: tool.operation, kind: 'action', rawInput: tool.name }),
    }));
  }

  ctx.tools.register(defineTool({
    name: 'ams_call',
    description: 'Call one allowlisted AI Marketing Studio business operation: project, research, Evidence, Analysis, Knowledge, Brief, handoff, or generation. Unknown or destructive operations fail closed.',
    parameters: {
      schema_version: { type: 'string', required: true, enum: ['ams_harness_tool_v1'] },
      operation: {
        type: 'string',
        required: true,
        enum: [
          'workspace.project.list', 'workspace.project.read', 'workspace.lineage.audit',
          'workspace.project.create', 'workspace.project.update', 'workspace.evidence.create',
          'workspace.analysis.create', 'workspace.card.create', 'workspace.brief.assemble',
          'workspace.handoff.create', 'research.status', 'research.collect_url',
          'research.search_x', 'research.search_reddit', 'research.analyze_persisted',
          'research.generate_similar', 'research.inspect_attachments',
          'generation.quote', 'generation.submit', 'generation.status', 'generation.artifact',
        ],
      },
      payload: { type: 'object', required: true, additionalProperties: true },
      idempotency_key: { type: 'string', required: true },
      expected_revision: { type: 'integer' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, execution) {
      return callAms(args, execution);
    },
    presentCall: (args) => ({ card: 'generic', title: args.operation, kind: 'action', rawInput: args.operation }),
  }));
}

export { apply, inject, name, nativeSessionIdFromExecution, nativeTaskId, resolveRuntime, signGatewayContext };
