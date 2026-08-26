import { defineTool } from '@deepseek-ai/dsh-tools';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendTaskArtifactRefs } from './artifact-journal.mjs';
import { writeRequiredFailure } from './required-failure-journal.mjs';

const name = 'ams-harness-tools';
const inject = ['tools', 'systemPrompt'];

function runtimeContext() {
  let approval = {};
  try { approval = JSON.parse(process.env.AMS_TASK_APPROVAL || '{}'); } catch { approval = {}; }
  return {
    task_id: process.env.AMS_TASK_ID || '',
    user_id: process.env.AMS_USER_ID || '',
    project_id: process.env.AMS_PROJECT_ID || null,
    approval,
  };
}

async function loadClient() {
  const modulePath = process.env.AMS_TOOL_CLIENT_MODULE || '/app/tool-client.mjs';
  const module = await import(modulePath);
  const secretPath = process.env.AMS_TOOL_BRIDGE_SECRET_FILE || '';
  const bridgeSecret = secretPath ? readFileSync(secretPath, 'utf8').trim() : '';
  return module.createToolClient({
    bridgeUrl: process.env.AMS_TOOL_BRIDGE_URL,
    bridgeSecret,
    delegatedAuthorization: process.env.AMS_DELEGATED_AUTHORIZATION || '',
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

const DIRECT_TOOLS = [
  {
    name: 'ams_project_list',
    operation: 'workspace.project.list',
    description: 'List AI Marketing Studio projects available to the current user.',
    fields: [],
  },
  {
    name: 'ams_project_read',
    operation: 'workspace.project.read',
    description: 'Read the current or specified AMS project, including Evidence, Analysis, Knowledge, Brief and artifacts.',
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

function apply(ctx) {
  let requiredFailure = null;
  const manifest = String(process.env.AMS_CAPABILITY_MANIFEST || '[]').slice(0, 24_000);
  const conversationMode = ['agent', 'qa'].includes(process.env.AMS_CONVERSATION_MODE || '');
  ctx.systemPrompt.section({
    name: conversationMode ? 'ams:agent' : 'ams:operator',
    order: 40,
    text: (conversationMode ? [
      'You are DeepSeek Harness operating AI Marketing Studio through plugin tools.',
      'Answer ordinary questions directly and naturally. For actionable marketing work, prefer the specific ams_* tools registered by this plugin. Use ams_call only as a compatibility fallback for an operation that has no specific tool yet.',
      'Do not request or create a separate deterministic AMS execution plan.',
      'If the user goal is unclear, ask one concise clarification question instead of mapping it to a default workflow.',
      'Use the capability catalog as available tools, but you may choose the sequence yourself based on the user goal.',
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
    if (requiredFailure) {
      throw Object.assign(new Error('A required predecessor tool failed; dependent actions are blocked.'), {
        code: 'AMS_DEPENDENCY_BLOCKED',
      });
    }
    const operation = operationOverride || args.operation;
    const payload = args.payload && typeof args.payload === 'object' ? args.payload : {};
    const client = await loadClient();
    const context = runtimeContext();
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
        requiredFailure = {
          code: String(result?.code || 'AMS_REQUIRED_TOOL_FAILED'),
          operation,
        };
        writeRequiredFailure(process.env.DSH_HOME || process.env.HOME || '', context.task_id, requiredFailure);
        throw Object.assign(new Error('A required AI Marketing Studio tool failed.'), { code: requiredFailure.code });
      }
      appendTaskArtifactRefs(process.env.DSH_HOME || process.env.HOME || '', context.task_id, result);
      return result;
    } catch (error) {
      if (!requiredFailure) {
        requiredFailure = { code: String(error?.code || 'AMS_REQUIRED_TOOL_FAILED'), operation };
        writeRequiredFailure(process.env.DSH_HOME || process.env.HOME || '', context.task_id, requiredFailure);
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
      parameters[field] = {
        type: field === 'payload' || field === 'attachments' || field === 'evidence' || field === 'analysis' || field === 'card' || field === 'brief'
          ? 'object'
          : field === 'count'
            ? 'integer'
            : 'string',
        required: !(tool.optional || []).includes(field),
        additionalProperties: true,
      };
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

export { apply, inject, name };
