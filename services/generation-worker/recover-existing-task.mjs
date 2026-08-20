// One-shot recovery entrypoint for an already-paid provider task. It has no
// provider submit path and never loops/retries an unclear result.
import { recoverExistingProviderTask, createWorkerClients } from './worker.mjs';

const jobId = process.env.G1_RECOVERY_JOB_ID || '';
const attemptId = process.env.G1_RECOVERY_ATTEMPT_ID || '';
const providerTaskId = process.env.G1_RECOVERY_PROVIDER_TASK_ID || '';
const workerId = process.env.G1_RECOVERY_WORKER_ID || 'g1-recovery-worker';
const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!jobId || !attemptId || !providerTaskId || !supabaseUrl || !serviceKey) {
  throw new Error('G1 recovery requires exact job, attempt and provider task identities plus the mounted staging runtime configuration.');
}

const { db, storage } = createWorkerClients({ supabaseUrl, serviceKey });
const result = await recoverExistingProviderTask(
  { jobId, attemptId, providerTaskId, workerId },
  { db, storage },
);

// Only emit bounded status metadata; never print URLs, credentials or provider
// payloads. Non-completion exits non-zero so deployment automation fails closed.
console.log(JSON.stringify({
  outcome: result?.outcome || 'unknown',
  code: result?.code || null,
  artifact_id: result?.artifact?.id || null,
  artifact_version: result?.artifact?.artifact_version || null,
}));

if (result?.outcome !== 'completed') process.exitCode = 1;
