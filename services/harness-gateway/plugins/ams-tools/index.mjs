import { defineTool } from '@deepseek-ai/dsh-tools';
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

function apply(ctx) {
  let requiredFailure = null;
  ctx.systemPrompt.section({
    name: 'ams:operator',
    order: 40,
    text: [
      'You operate AI Marketing Studio only through the ams_call tool.',
      'Never invent an operation, user, project, revision, cost, source, or artifact identity.',
      'Read current state before proposing a write. Use exact returned identities and revision guards.',
      'For research.collect_url use payload {url} with only an optional exact bound project_id echo.',
      'For research.analyze_persisted use payload exactly {project_id,evidence_id}; never send evidence_ids, count, or a batch payload.',
      'To analyze multiple persisted Evidence records, call research.analyze_persisted once per exact evidence_id, sequentially, with a distinct idempotency_key and stop on the first failure.',
      'Paid calls, online writes, and handoff creation fail unless the trusted task approval grants them.',
      'Never request deletion, archival, arbitrary SQL, schema/Auth changes, production access, or social publishing.',
      'When a tool fails, report its exact bounded code and stop dependent actions.',
    ].join('\n'),
  });
  ctx.tools.register(defineTool({
    name: 'ams_call',
    description: 'Call one allowlisted AI Marketing Studio P19/P22 operation. Unknown or destructive operations fail closed.',
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
          'research.generate_similar',
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
      if (requiredFailure) {
        throw Object.assign(new Error('A required predecessor tool failed; dependent actions are blocked.'), {
          code: 'AMS_DEPENDENCY_BLOCKED',
        });
      }
      const client = await loadClient();
      const context = runtimeContext();
      try {
        const result = await client(args, context, execution?.signal);
        if (!result || result.ok === false) {
          requiredFailure = {
            code: String(result?.code || 'AMS_REQUIRED_TOOL_FAILED'),
            operation: args.operation,
          };
          writeRequiredFailure(process.env.DSH_HOME || process.env.HOME || '', context.task_id, requiredFailure);
          throw Object.assign(new Error('A required AI Marketing Studio tool failed.'), { code: requiredFailure.code });
        }
        appendTaskArtifactRefs(process.env.DSH_HOME || process.env.HOME || '', context.task_id, result);
        return result;
      } catch (error) {
        if (!requiredFailure) {
          requiredFailure = { code: String(error?.code || 'AMS_REQUIRED_TOOL_FAILED'), operation: args.operation };
          writeRequiredFailure(process.env.DSH_HOME || process.env.HOME || '', context.task_id, requiredFailure);
        }
        throw error;
      }
    },
    presentCall: (args) => ({ card: 'generic', title: args.operation, kind: 'action', rawInput: args.operation }),
  }));
}

export { apply, inject, name };
