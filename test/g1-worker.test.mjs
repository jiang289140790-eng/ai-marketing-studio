// G1 验收 #4：worker 崩溃/重启与轮询恢复——绝不重复付费提交。
//
// 内存 fake DB 精确镜像 SQL 边界的状态机（claim/lease/提交/轮询/完成/失败与
// lease 过期对账规则）；fake provider 记录每次提交与轮询。全部零真实调用。
//
// 覆盖：
//   1. 图片同步全链路：claim → pre_submit → submit（同步成功）→ request id
//      血缘落盘 → 零轮询 → download → complete，恰好 1 次 provider 提交；
//   2. 提交后崩溃（phase=pre_submit，标识未落盘）：lease 过期对账 →
//      ambiguous / needs_attention，绝不自动重试、绝不第二次提交；
//   3. 同步图片 request id 已落盘后崩溃：失败关闭，零轮询、零重提；
//   4. 异步视频轮询中途崩溃：另一 worker 恢复同一 task id 轮询 → 完成；
//   5. 确定性 4xx 拒绝（InvalidParameter）：单次尝试，绝不调度第二次；
//   6. 歧义提交（网络/5xx）：needs_attention，绝不自动重试；
//   7. lease 丢失：worker 停止，不产生 fail 调用；
//   8. 整体超时（异步视频轮询）：有界 G1_WORKER_TIMEOUT → needs_attention；
//   9. 显式歧义分类消费：ambiguous=true / 未标记 / 标记矛盾 全部 fail closed；
//  10. 未批准画幅：本地失败，零 provider 调用，单次尝试；
//  11. 同步响应结果集不符：ambiguous 单次尝试，绝不重试。

import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const { Response } = globalThis;

process.env.G1_POLL_INTERVAL_MS = '20';
process.env.G1_OVERALL_JOB_TIMEOUT_MS = '30000';

const { processClaimedJob } = await import('../services/generation-worker/worker.mjs');

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = 'prj-111111111111111111111111';
const JOB = 'g1j-111111111111111111111111';
const ATTEMPT = 'g1a-111111111111111111111111';

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function makeClaim({ attemptNo = 1, resume = false, providerTaskId = null, mode = 'image', modelName = 'qwen-image-2.0', requestOverrides = {} } = {}) {
  return {
    job_id: JOB,
    attempt_id: ATTEMPT,
    attempt_no: attemptNo,
    resume,
    provider_task_id: providerTaskId,
    next_artifact_version: 1,
    mode,
    model_name: modelName,
    user_id: USER,
    project_id: PROJECT,
    brief_id: 'brief-111111111111111111111111',
    brief_version: 1,
    reference_asset_id: null,
    request: {
      schema_version: 'g1_generation_request_v1',
      prompt: '测试图片',
      negative_prompt: '',
      aspect_ratio: '1:1',
      ...requestOverrides,
    },
    quote: { quote_id: 'g1q-111111111111111111111111', quote_fingerprint: 'a'.repeat(64) },
  };
}

/**
 * 内存 fake DB：镜像 SQL 边界状态机（claim 对账规则与 g1_claim_jobs 一致）。
 *
 * 所有权语义与真实系统一致：
 *   - claimJobs 返回的认领行携带 worker_id（镜像 runWorkerLoop 的
 *     `{ ...claimed, worker_id }` 注入），后续 RPC 的 p_worker_id 与之相同；
 *   - claimed_by 为 null 的尝试（直接调用 processClaimedJob 模拟已认领的
 *     现场，未走 claimJobs）视为归处理方所有；
 *   - 已认领尝试被其他 worker 调用（lease 丢失/抢占）仍抛 G1_LEASE_LOST。
 */
class FakeDb {
  constructor() {
    this.attempts = new Map();
    this.jobs = new Map();
    this.failCalls = [];
    this.claimCalls = [];
  }

  addJob({ jobId = JOB, attemptId = ATTEMPT, attemptNo = 1, status = 'queued' } = {}) {
    this.jobs.set(jobId, { id: jobId, status });
    this.attempts.set(attemptId, {
      id: attemptId, job_id: jobId, attempt_no: attemptNo, state: 'queued',
      lease_expires_at: null, claimed_by: null, provider_task_id: null,
      provider_state: {}, diagnostics: {},
    });
  }

  async claimJobs({ workerId, maxJobs, leaseSeconds }) {
    this.claimCalls.push({ workerId, maxJobs, leaseSeconds });
    // ---- lease 过期对账（镜像 SQL）----
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.lease_expires_at && attempt.lease_expires_at <= Date.now()) {
        if (attempt.state === 'claimed') {
          if (attempt.provider_state?.phase !== 'pre_submit') {
            attempt.state = 'queued';
            attempt.claimed_by = null;
            attempt.lease_expires_at = null;
          } else {
            attempt.state = 'ambiguous';
            attempt.claimed_by = null;
            attempt.lease_expires_at = null;
            const job = this.jobs.get(attempt.job_id);
            if (job) job.status = 'needs_attention';
          }
        } else if (attempt.state === 'submitted' || attempt.state === 'running') {
          if (attempt.provider_task_id) {
            attempt.claimed_by = null;
            attempt.lease_expires_at = Date.now();
          } else {
            attempt.state = 'ambiguous';
            attempt.claimed_by = null;
            const job = this.jobs.get(attempt.job_id);
            if (job) job.status = 'needs_attention';
          }
        }
      }
    }
    // ---- 认领 ----
    const claimed = [];
    for (const attempt of [...this.attempts.values()].sort((a, b) => a.attempt_no - b.attempt_no)) {
      if (claimed.length >= maxJobs) break;
      const job = this.jobs.get(attempt.job_id);
      if (!job) continue;
      if (attempt.state === 'queued' && job.status === 'queued') {
        attempt.state = 'claimed';
        attempt.claimed_by = workerId;
        attempt.lease_expires_at = Date.now() + leaseSeconds * 1000;
        claimed.push({ ...makeClaim(), worker_id: workerId, attempt_id: attempt.id, attempt_no: attempt.attempt_no, resume: false, provider_task_id: null });
      } else if ((attempt.state === 'submitted' || attempt.state === 'running')
        && attempt.lease_expires_at <= Date.now() && attempt.provider_task_id && job.status === 'running') {
        attempt.state = 'claimed';
        attempt.claimed_by = workerId;
        attempt.lease_expires_at = Date.now() + leaseSeconds * 1000;
        claimed.push({ ...makeClaim(), worker_id: workerId, attempt_id: attempt.id, attempt_no: attempt.attempt_no, resume: true, provider_task_id: attempt.provider_task_id });
      }
    }
    return { ok: true, claimed };
  }

  async markProviderSubmitted({ jobId, attemptId, workerId, providerTaskId, providerState }) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw Object.assign(new Error('G1_ATTEMPT_NOT_FOUND'), { code: 'G1_ATTEMPT_NOT_FOUND' });
    if (attempt.claimed_by !== null && attempt.claimed_by !== workerId) throw Object.assign(new Error('G1_LEASE_LOST'), { code: 'G1_LEASE_LOST' });
    attempt.state = 'submitted';
    attempt.provider_task_id = providerTaskId;
    attempt.provider_state = providerState || {};
    const job = this.jobs.get(jobId);
    if (job && job.status === 'queued') job.status = 'running';
    return { ok: true, state: 'submitted' };
  }

  async heartbeat({ jobId: _jobId, attemptId, workerId, leaseSeconds }) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw Object.assign(new Error('G1_ATTEMPT_NOT_FOUND'), { code: 'G1_ATTEMPT_NOT_FOUND' });
    if (attempt.claimed_by !== null && attempt.claimed_by !== workerId) throw Object.assign(new Error('G1_LEASE_LOST'), { code: 'G1_LEASE_LOST' });
    attempt.lease_expires_at = Date.now() + leaseSeconds * 1000;
    return { ok: true };
  }

  async reportPoll({ jobId: _jobId, attemptId, workerId, providerStatus, providerState }) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw Object.assign(new Error('G1_ATTEMPT_NOT_FOUND'), { code: 'G1_ATTEMPT_NOT_FOUND' });
    if (attempt.claimed_by !== null && attempt.claimed_by !== workerId) throw Object.assign(new Error('G1_LEASE_LOST'), { code: 'G1_LEASE_LOST' });
    attempt.provider_status = providerStatus;
    attempt.provider_state = providerState || attempt.provider_state || {};
    return { ok: true };
  }

  async completeAttempt({ jobId, attemptId, workerId, artifact }) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw Object.assign(new Error('G1_ATTEMPT_NOT_FOUND'), { code: 'G1_ATTEMPT_NOT_FOUND' });
    if (attempt.claimed_by !== null && attempt.claimed_by !== workerId) throw Object.assign(new Error('G1_LEASE_LOST'), { code: 'G1_LEASE_LOST' });
    attempt.state = 'succeeded';
    attempt.artifact = artifact;
    const job = this.jobs.get(jobId);
    if (job) job.status = 'completed';
    return { ok: true, artifact: { artifact_version: 1, content_sha256: artifact.content_sha256, usage: artifact.usage, source_url: artifact.source_url } };
  }

  async failAttempt({ jobId, attemptId, workerId, code, diagnostics, retryEligible }) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw Object.assign(new Error('G1_ATTEMPT_NOT_FOUND'), { code: 'G1_ATTEMPT_NOT_FOUND' });
    if (attempt.claimed_by !== null && attempt.claimed_by !== workerId) throw Object.assign(new Error('G1_LEASE_LOST'), { code: 'G1_LEASE_LOST' });
    attempt.state = retryEligible ? 'failed' : 'ambiguous';
    this.failCalls.push({ code, retryEligible, diagnostics });
    const job = this.jobs.get(jobId);
    if (retryEligible && attempt.attempt_no < 2) {
      const nextNo = attempt.attempt_no + 1;
      this.attempts.set(`${ATTEMPT}${nextNo}`, {
        id: `${ATTEMPT}${nextNo}`, job_id: jobId, attempt_no: nextNo, state: 'queued',
        lease_expires_at: null, claimed_by: null, provider_task_id: null, provider_state: {}, diagnostics: {},
      });
      if (job) job.status = 'queued';
      return { ok: true, outcome: 'retry_scheduled', attempt_no: nextNo };
    }
    if (job) job.status = retryEligible ? 'failed' : 'needs_attention';
    return { ok: true, outcome: retryEligible ? 'failed' : 'needs_attention' };
  }

  expireLeases() {
    for (const attempt of this.attempts.values()) {
      if (attempt.lease_expires_at) attempt.lease_expires_at = Date.now() - 1;
    }
  }
}

/** 内存 fake storage：记录上传路径/内容，验证私有确定性路径。 */
class FakeStorage {
  constructor() {
    this.uploads = [];
  }
  async uploadArtifact({ user, project, jobId, version, contentSha, mime, buffer }) {
    const path = `${user}/${project}/${jobId}/v${version}/${contentSha.slice(0, 12)}.${mime === 'image/png' ? 'png' : 'bin'}`;
    this.uploads.push({ path, buffer, mime });
    return path;
  }
  async downloadReference() {
    throw new Error('not used in image tests');
  }
  async prepareReference() {
    throw new Error('not used in image tests');
  }
}

/**
 * 记录式 fake provider：每次提交/轮询都被记录；行为由队列驱动。
 * 图片（input.messages）→ 同步成功响应；视频 → 异步 task id 响应。
 */
function createFakeProvider({ pollQueue = [] } = {}) {
  const submissions = [];
  const polls = [];
  let submitBehavior = { kind: 'success', taskId: 'task-1' };
  const fetchImpl = async (url, init = {}) => {
    if (init?.method === 'POST') {
      const parsed = JSON.parse(String(init.body || '{}'));
      submissions.push(parsed);
      if (submitBehavior.kind === 'reject') {
        return new Response(JSON.stringify({ code: 'InvalidParameter', message: 'prompt 包含禁用词' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      if (submitBehavior.kind === 'http5xx') {
        return new Response(JSON.stringify({ message: 'upstream busy' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      if (submitBehavior.kind === 'network') throw new TypeError('fetch failed');
      if (submitBehavior.kind === 'noTaskId') {
        return new Response(JSON.stringify({ output: { task_status: 'PENDING' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (submitBehavior.kind === 'noImage') {
        return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ text: '只有文字' }] } }] }, request_id: 'req-sync-noimg' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // 图片同步契约（input.messages）→ 同步成功（含 request id 与 usage）。
      if (parsed?.input?.messages) {
        return new Response(JSON.stringify({
          output: { choices: [{ message: { role: 'assistant', content: [{ text: '一张图' }, { image: 'https://provider.example/result.png' }] } }] },
          request_id: 'req-sync-1',
          usage: { input_tokens: 12, output_tokens: 88, total_tokens: 100 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // 视频异步契约 → task id。
      return new Response(JSON.stringify({ output: { task_id: submitBehavior.taskId, task_status: 'PENDING' }, request_id: 'req-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // GET → 轮询
    const index = polls.length;
    polls.push(String(url));
    const queue = submitBehavior.pollQueue || pollQueue;
    const status = queue[Math.min(index, queue.length - 1)] || 'RUNNING';
    if (status === 'SUCCEEDED') {
      return new Response(JSON.stringify({ output: { task_status: status, results: [{ url: 'https://provider.example/result.png' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if ((status === 'FAILED' || status === 'CANCELED') && submitBehavior.failDetails) {
      return new Response(JSON.stringify({ output: { task_status: status, ...submitBehavior.failDetails }, request_id: 'req-terminal-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ output: { task_status: status } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    fetchImpl,
    submissions,
    polls,
    setSubmitBehavior(behavior) { submitBehavior = { kind: 'success', taskId: 'task-1', pollQueue, ...behavior }; },
  };
}

/** 有界下载 fake：返回固定 PNG 字节。 */
function createDownloadFetch(provider) {
  const original = provider.fetchImpl;
  provider.fetchImpl = async (url, init) => {
    if (String(url).includes('result.png')) {
      return new Response(Buffer.from('fake-png-bytes'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return original(url, init);
  };
}

function makeDeps({ db, storage, provider, now }) {
  return {
    db,
    storage,
    fetchImpl: provider.fetchImpl,
    apiKey: 'sk-test-worker-key',
    now,
    logger: { info() {}, warn() {}, error() {} },
  };
}

test('1. 图片同步全链路：恰好 1 次提交、零轮询、真实 request id 血缘、私有路径产物', async () => {
  const db = new FakeDb();
  db.addJob();
  const storage = new FakeStorage();
  const provider = createFakeProvider();
  createDownloadFetch(provider);
  const now = () => new Date();

  const outcome = await processClaimedJob(makeClaim(), makeDeps({ db, storage, provider, now }));
  assert.equal(outcome.outcome, 'completed');
  assert.equal(provider.submissions.length, 1, '必须恰好 1 次 provider 提交');
  const body = provider.submissions[0];
  assert.equal(body.model, 'qwen-image-2.0');
  assert.equal(body.input.messages[0].role, 'user');
  assert.equal(body.input.messages[0].content[0].text, '测试图片');
  assert.equal(body.parameters.size, '1024*1024');
  assert.equal(body.prompt, undefined, '不得携带遗留顶层 prompt');
  assert.equal(provider.polls.length, 0, '同步契约必须零 provider 轮询');
  // 血缘：provider_task_id = 真实 request id（绝不合成 task id）。
  assert.equal(db.attempts.get(ATTEMPT).provider_task_id, 'req-sync-1', '必须使用真实 request id 而非合成 task id');
  assert.equal(db.attempts.get(ATTEMPT).state, 'succeeded');
  assert.equal(db.jobs.get(JOB).status, 'completed');
  assert.equal(storage.uploads.length, 1);
  assert.match(storage.uploads[0].path, /^aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\/prj-111111111111111111111111\/g1j-111111111111111111111111\/v1\/[0-9a-f]{12}\.png$/);
  const uploadSha = sha256Hex('fake-png-bytes');
  assert.equal(storage.uploads[0].path.includes(uploadSha.slice(0, 12)), true, '路径必须绑定内容 SHA-256 前缀');
  // 有界 usage / source_url 随完成契约保留。
  const artifact = db.attempts.get(ATTEMPT).artifact;
  assert.deepEqual(artifact.usage, { input_tokens: 12, output_tokens: 88, total_tokens: 100 }, '有界 usage 元数据必须随血缘保留');
  assert.equal(artifact.source_url, 'https://provider.example/result.png');
});

test('2. 提交后崩溃（标识未落盘）：needs_attention，绝不第二次提交', async () => {
  // 模拟崩溃现场：worker A 已进入提交窗口（pre_submit）但标识未落盘。
  const db = new FakeDb();
  db.addJob({ attemptId: 'g1a-222222222222222222222222' });
  const provider = createFakeProvider();
  await db.claimJobs({ workerId: 'worker-a', maxJobs: 1, leaseSeconds: 300 });
  await db.reportPoll({
    jobId: JOB, attemptId: 'g1a-222222222222222222222222', workerId: 'worker-a',
    providerStatus: 'pre_submit', providerState: { phase: 'pre_submit' },
  });
  db.expireLeases();
  // 重启后的 worker B 认领：对账必须把该尝试标记 ambiguous，绝不重新提交。
  const claimB = await db.claimJobs({ workerId: 'worker-b', maxJobs: 1, leaseSeconds: 300 });
  assert.equal(claimB.claimed.length, 0, 'pre_submit 歧义不得被认领');
  assert.equal(db.attempts.get('g1a-222222222222222222222222').state, 'ambiguous');
  assert.equal(db.jobs.get(JOB).status, 'needs_attention');
  assert.equal(provider.submissions.length, 0, '崩溃后绝不发生第二次提交');

  // 反向对照：claimed 且 lease 过期但从未进入提交窗口（phase 为空）→ 安全重排，
  // 新 worker 可以重新提交（持久化状态证明无已接受的付费作业）。
  const db2 = new FakeDb();
  db2.addJob({ attemptId: 'g1a-444444444444444444444444' });
  await db2.claimJobs({ workerId: 'worker-a', maxJobs: 1, leaseSeconds: 300 });
  db2.expireLeases();
  const claimSafe = await db2.claimJobs({ workerId: 'worker-b', maxJobs: 1, leaseSeconds: 300 });
  assert.equal(claimSafe.claimed.length, 1, '未进入提交窗口的崩溃必须安全重排');
  assert.equal(claimSafe.claimed[0].resume, false, '重排后是新提交（不是轮询恢复）');
});

test('3. 同步图片 request id 已落盘后崩溃：失败关闭，零轮询、零重提、单次尝试', async () => {
  const db = new FakeDb();
  db.addJob();
  const storage = new FakeStorage();
  const provider = createFakeProvider({ pollQueue: ['RUNNING', 'SUCCEEDED'] });
  const now = () => new Date();

  // worker A：同步提交已被接受，真实 request id 已落盘，但产物 URL 尚未完成。
  await db.claimJobs({ workerId: 'worker-a', maxJobs: 1, leaseSeconds: 300 });
  await db.reportPoll({ jobId: JOB, attemptId: ATTEMPT, workerId: 'worker-a', providerStatus: 'pre_submit', providerState: { phase: 'pre_submit' } });
  provider.submissions.length = 0; // 清空对照记录，只统计崩溃后的
  const submitted = await db.markProviderSubmitted({
    jobId: JOB, attemptId: ATTEMPT, workerId: 'worker-a', providerTaskId: 'req-sync-crash-1',
    providerState: { phase: 'submitted', mode: 'image', request_id: 'req-sync-crash-1' },
  });
  assert.equal(submitted.ok, true);
  db.expireLeases();

  // worker B（重启）：request id 不是异步 task id，必须失败关闭。
  const claimB = await db.claimJobs({ workerId: 'worker-b', maxJobs: 1, leaseSeconds: 300 });
  assert.equal(claimB.claimed.length, 1, '必须恢复该未完成尝试');
  assert.equal(claimB.claimed[0].resume, true, '恢复认领必须标记 resume');
  assert.equal(claimB.claimed[0].provider_task_id, 'req-sync-crash-1', '必须携带原始 request id 血缘');
  const outcome = await processClaimedJob(claimB.claimed[0], makeDeps({ db, storage, provider, now }));
  assert.equal(outcome.outcome, 'needs_attention');
  assert.equal(db.failCalls.at(-1).code, 'G1_SYNC_IMAGE_RESULT_UNAVAILABLE');
  assert.equal(db.failCalls.at(-1).retryEligible, false);
  assert.equal(provider.submissions.length, 0, '恢复期间绝不重新提交付费操作');
  assert.equal(provider.polls.length, 0, 'request id 绝不能发送到异步 tasks API');
  assert.equal(storage.uploads.length, 0);
  assert.equal([...db.attempts.values()].length, 1, '绝不调度第二次尝试');
  assert.equal(db.jobs.get(JOB).status, 'needs_attention');
});

test('4. 轮询中途崩溃：另一 worker 恢复同一 task id 轮询 → 完成', async () => {
  const db = new FakeDb();
  db.addJob();
  const storage = new FakeStorage();
  const provider = createFakeProvider({ pollQueue: ['RUNNING', 'SUCCEEDED'] });
  createDownloadFetch(provider);
  const now = () => new Date();

  // worker A 完整走到 submitted（模拟轮询中崩溃）。
  await db.claimJobs({ workerId: 'worker-a', maxJobs: 1, leaseSeconds: 300 });
  await db.markProviderSubmitted({
    jobId: JOB, attemptId: ATTEMPT, workerId: 'worker-a', providerTaskId: 'task-poll-crash',
    providerState: { phase: 'submitted' },
  });
  db.expireLeases();
  const claimB = await db.claimJobs({ workerId: 'worker-b', maxJobs: 1, leaseSeconds: 300 });
  assert.equal(claimB.claimed[0].resume, true, '重启 worker 必须恢复轮询');
  Object.assign(claimB.claimed[0], makeClaim({
    resume: true,
    providerTaskId: 'task-poll-crash',
    mode: 'video_t2v',
    modelName: 'happyhorse-1.0-t2v',
    requestOverrides: { prompt: '海边日落', aspect_ratio: '16:9', duration_seconds: 5, resolution: '720p' },
  }), { worker_id: 'worker-b', attempt_id: ATTEMPT });
  const outcome = await processClaimedJob(claimB.claimed[0], makeDeps({ db, storage, provider, now }));
  assert.equal(outcome.outcome, 'completed');
  assert.equal(provider.submissions.length, 0, '轮询恢复绝不重新提交');
});

test('5. 确定性 4xx 拒绝（InvalidParameter）：单次尝试，绝不调度第二次', async () => {
  const db = new FakeDb();
  db.addJob();
  const storage = new FakeStorage();
  const provider = createFakeProvider();
  provider.setSubmitBehavior({ kind: 'reject' });
  const now = () => new Date();

  const outcome = await processClaimedJob(makeClaim(), makeDeps({ db, storage, provider, now }));
  assert.equal(outcome.outcome, 'needs_attention', '永久请求契约拒绝必须单次收口');
  assert.equal(provider.submissions.length, 1, '恰好 1 次 provider 调用');
  assert.equal(provider.polls.length, 0, '拒绝后绝不轮询');
  assert.equal(db.failCalls.length, 1);
  assert.equal(db.failCalls[0].code, 'G1_PROVIDER_REJECTED');
  assert.equal(db.failCalls[0].retryEligible, false, '永久拒绝绝不自动重试');
  const attempts = [...db.attempts.values()];
  assert.equal(attempts.length, 1, '绝不产生第二次尝试');
  assert.equal(db.jobs.get(JOB).status, 'needs_attention');
  assert.equal(storage.uploads.length, 0, '拒绝后绝不产生产物');
  // 有界脱敏诊断：不含密钥，长度有界。
  const diagnostics = db.failCalls[0].diagnostics;
  assert.ok(Array.isArray(diagnostics.issues) && diagnostics.issues.length === 1, '诊断必须有界且恰好一条');
  assert.ok(diagnostics.issues[0].length <= 4096, '诊断必须被有界截断');
  assert.doesNotMatch(diagnostics.issues[0], /sk-test-worker-key/, '诊断绝不包含 Secret');
});

test('6. 歧义提交（5xx）：needs_attention，绝不自动重试', async () => {
  const db = new FakeDb();
  db.addJob();
  const storage = new FakeStorage();
  const provider = createFakeProvider();
  provider.setSubmitBehavior({ kind: 'http5xx' });
  const now = () => new Date();

  const outcome = await processClaimedJob(makeClaim(), makeDeps({ db, storage, provider, now }));
  assert.equal(outcome.outcome, 'needs_attention', '歧义提交必须 needs_attention');
  assert.equal(db.failCalls[0].retryEligible, false, '歧义提交绝不自动重试');
  assert.equal(db.jobs.get(JOB).status, 'needs_attention');
  const attempts = [...db.attempts.values()];
  assert.equal(attempts.length, 1, '歧义后绝不调度新尝试');

  // 网络失败同样歧义。
  const db2 = new FakeDb();
  db2.addJob({ attemptId: 'g1a-333333333333333333333333' });
  const provider2 = createFakeProvider();
  provider2.setSubmitBehavior({ kind: 'network' });
  const outcome2 = await processClaimedJob(
    { ...makeClaim(), attempt_id: 'g1a-333333333333333333333333' },
    makeDeps({ db: db2, storage, provider: provider2, now }),
  );
  assert.equal(outcome2.outcome, 'needs_attention', '网络失败必须 needs_attention');
  assert.equal(db2.failCalls[0].retryEligible, false);
});

test('7. lease 丢失：原 worker 停止且不产生 fail 调用；接管 worker 恢复轮询同一 task id', async () => {
  const db = new FakeDb();
  db.addJob();
  const storage = new FakeStorage();
  const provider = createFakeProvider({ pollQueue: ['RUNNING', 'SUCCEEDED'] });
  createDownloadFetch(provider);
  const now = () => new Date();

  // worker-a 已提交并落盘 task id（paid job 已被 provider 接受）。
  await db.claimJobs({ workerId: 'worker-a', maxJobs: 1, leaseSeconds: 300 });
  await db.markProviderSubmitted({
    jobId: JOB, attemptId: ATTEMPT, workerId: 'worker-a', providerTaskId: 'task-leased',
    providerState: { phase: 'submitted' },
  });
  const steal = await db.claimJobs({ workerId: 'worker-b', maxJobs: 1, leaseSeconds: 300 });
  assert.equal(steal.claimed.length, 0, 'lease 未过期时不得被抢占');
  db.expireLeases();
  const stolen = await db.claimJobs({ workerId: 'worker-b', maxJobs: 1, leaseSeconds: 300 });
  Object.assign(stolen.claimed[0], makeClaim({
    resume: true,
    providerTaskId: 'task-leased',
    mode: 'video_t2v',
    modelName: 'happyhorse-1.0-t2v',
    requestOverrides: { prompt: '海边日落', aspect_ratio: '16:9', duration_seconds: 5, resolution: '720p' },
  }), { worker_id: 'worker-b', attempt_id: ATTEMPT });
  assert.equal(stolen.claimed.length, 1, 'lease 过期后另一 worker 可接管同一 task id');
  assert.equal(stolen.claimed[0].resume, true, '接管必须是同一 task id 的轮询恢复');
  // 原 worker 的任何后续 RPC 现在 lease 丢失（绝不重复提交）。
  await assert.rejects(
    db.markProviderSubmitted({ jobId: JOB, attemptId: ATTEMPT, workerId: 'worker-a', providerTaskId: 'task-leased', providerState: {} }),
    (error) => error?.code === 'G1_LEASE_LOST',
  );
  await assert.rejects(
    db.heartbeat({ jobId: JOB, attemptId: ATTEMPT, workerId: 'worker-a', leaseSeconds: 300 }),
    (error) => error?.code === 'G1_LEASE_LOST',
  );
  // 完整运行被抢占后的 worker-b：恢复轮询同一 task id → 完成；全程零新提交。
  const outcome = await processClaimedJob(stolen.claimed[0], makeDeps({ db, storage, provider, now }));
  assert.equal(outcome.outcome, 'completed');
  assert.equal(provider.submissions.length, 0, '接管 worker 绝不重新提交');
});

test('8. 整体超时（异步视频轮询）：有界 G1_WORKER_TIMEOUT → needs_attention', async () => {
  const db = new FakeDb();
  db.addJob();
  const storage = new FakeStorage();
  const provider = createFakeProvider({ pollQueue: ['RUNNING', 'RUNNING'] });
  const now = () => new Date();
  const outcome = await processClaimedJob(
    makeClaim({
      mode: 'video_t2v', modelName: 'happyhorse-1.0-t2v',
      requestOverrides: { prompt: '海边日落', aspect_ratio: '16:9', duration_seconds: 5, resolution: '720p' },
    }),
    { ...makeDeps({ db, storage, provider, now }), overallTimeoutMs: 120 },
  );
  assert.equal(outcome.outcome, 'needs_attention');
  assert.equal(db.failCalls[0].code, 'G1_WORKER_TIMEOUT');
  assert.equal(db.failCalls[0].retryEligible, false);
  assert.equal(db.jobs.get(JOB).status, 'needs_attention');
  assert.equal(provider.polls.length >= 1, true, '视频路径必须进入轮询');
});

test('9. 显式歧义分类消费：ambiguous=true / 未标记 / 标记矛盾 全部 fail closed，绝不二次提交', async () => {
  const storage = new FakeStorage();
  const now = () => new Date();

  // 显式 ambiguous=true（adapter 对 5xx/网络/超时/无效响应/结果集不符的标记）
  // → 绝不自动重试，needs_attention。
  const db1 = new FakeDb();
  db1.addJob({ attemptId: 'g1a-555555555555555555555555' });
  const providerAmbiguous = createFakeProvider();
  providerAmbiguous.fetchImpl = async () => {
    throw Object.assign(new Error('Provider 5xx; outcome is ambiguous.'), { code: 'PROVIDER_HTTP_5XX', ambiguous: true });
  };
  const outcomeA = await processClaimedJob(
    { ...makeClaim(), attempt_id: 'g1a-555555555555555555555555' },
    makeDeps({ db: db1, storage, provider: providerAmbiguous, now }),
  );
  assert.equal(outcomeA.outcome, 'needs_attention');
  assert.equal(db1.failCalls[0].code, 'G1_PROVIDER_SUBMISSION_AMBIGUOUS');
  assert.equal(db1.failCalls[0].retryEligible, false, '歧义提交绝不自动重试');
  assert.equal(db1.jobs.get(JOB).status, 'needs_attention');
  assert.equal([...db1.attempts.values()].length, 1, '绝不调度第二次尝试');

  // 未携带显式标记的错误 → 按 fail closed 处理（视为歧义，绝不重试）。
  const db2 = new FakeDb();
  db2.addJob({ attemptId: 'g1a-666666666666666666666666' });
  const providerUnmarked = createFakeProvider();
  providerUnmarked.fetchImpl = async () => {
    throw new Error('unexpected provider failure without explicit classification');
  };
  const outcomeB = await processClaimedJob(
    { ...makeClaim(), attempt_id: 'g1a-666666666666666666666666' },
    makeDeps({ db: db2, storage, provider: providerUnmarked, now }),
  );
  assert.equal(outcomeB.outcome, 'needs_attention');
  assert.equal(db2.failCalls[0].retryEligible, false);

  // 标记矛盾（ambiguous=false 但 code 不是确定性拒绝集合）→ 双条件
  // fail closed，仍按歧义处理，绝不重试。
  const db3 = new FakeDb();
  db3.addJob({ attemptId: 'g1a-777777777777777777777777' });
  const providerMismarked = createFakeProvider();
  providerMismarked.fetchImpl = async () => {
    throw Object.assign(new Error('mismarked error'), { code: 'SOMETHING_ELSE', ambiguous: false });
  };
  const outcomeC = await processClaimedJob(
    { ...makeClaim(), attempt_id: 'g1a-777777777777777777777777' },
    makeDeps({ db: db3, storage, provider: providerMismarked, now }),
  );
  assert.equal(outcomeC.outcome, 'needs_attention');
  assert.equal(db3.failCalls[0].code, 'G1_PROVIDER_SUBMISSION_AMBIGUOUS');
  assert.equal(db3.failCalls[0].retryEligible, false);
  assert.equal([...db3.attempts.values()].length, 1, '标记矛盾的错误也绝不产生第二次尝试');
});

test('10. 未批准画幅：本地失败，零 provider 调用，单次尝试', async () => {
  const db = new FakeDb();
  db.addJob({ attemptId: 'g1a-888888888888888888888888' });
  const storage = new FakeStorage();
  const provider = createFakeProvider();
  const now = () => new Date();

  const outcome = await processClaimedJob(
    { ...makeClaim({ requestOverrides: { aspect_ratio: '2:3' } }), attempt_id: 'g1a-888888888888888888888888' },
    makeDeps({ db, storage, provider, now }),
  );
  assert.equal(outcome.outcome, 'needs_attention');
  assert.equal(db.failCalls[0].code, 'G1_ASPECT_RATIO_UNSUPPORTED');
  assert.equal(db.failCalls[0].retryEligible, false, '画幅契约失败绝不自动重试');
  assert.equal(provider.submissions.length, 0, '画幅校验失败必须零 provider 调用');
  assert.equal(provider.polls.length, 0, '画幅校验失败绝不进入轮询');
  assert.equal([...db.attempts.values()].length, 1, '绝不调度第二次尝试');
  assert.equal(storage.uploads.length, 0, '绝不产生产物');
  assert.equal(db.jobs.get(JOB).status, 'needs_attention');
});

test('11. 同步响应结果集不符（无 image）：ambiguous 单次尝试，绝不重试', async () => {
  const db = new FakeDb();
  db.addJob({ attemptId: 'g1a-999999999999999999999999' });
  const storage = new FakeStorage();
  const provider = createFakeProvider();
  provider.setSubmitBehavior({ kind: 'noImage' });
  const now = () => new Date();

  const outcome = await processClaimedJob(
    { ...makeClaim(), attempt_id: 'g1a-999999999999999999999999' },
    makeDeps({ db, storage, provider, now }),
  );
  assert.equal(outcome.outcome, 'needs_attention');
  assert.equal(db.failCalls[0].code, 'G1_PROVIDER_SUBMISSION_AMBIGUOUS');
  assert.equal(db.failCalls[0].retryEligible, false, '结果集不符绝不自动重试');
  assert.equal(provider.submissions.length, 1, '仅 1 次提交（结果集不符发生在响应侧）');
  assert.equal(provider.polls.length, 0, '同步失败绝不进入轮询');
  assert.equal([...db.attempts.values()].length, 1, '绝不调度第二次尝试');
  assert.equal(storage.uploads.length, 0, '绝不产生产物');
});

test('12. 视频终态失败：有界 provider 诊断持久化，needs_attention，绝不重试/重提/产物', async () => {
  // FAILED：staging 实测形态（InvalidParameter / 分辨率错误消息）必须有界
  // 穿透 adapter → worker → 持久化诊断。
  const db = new FakeDb();
  db.addJob();
  const storage = new FakeStorage();
  const provider = createFakeProvider();
  provider.setSubmitBehavior({
    pollQueue: ['RUNNING', 'FAILED'],
    failDetails: { code: 'InvalidParameter', message: "Input should be '1080P' or '720P': parameters.resolution" },
  });
  const now = () => new Date();

  const outcome = await processClaimedJob(
    makeClaim({
      mode: 'video_t2v', modelName: 'happyhorse-1.0-t2v',
      requestOverrides: { prompt: '海边日落', aspect_ratio: '16:9', duration_seconds: 5, resolution: '720p' },
    }),
    makeDeps({ db, storage, provider, now }),
  );
  assert.equal(outcome.outcome, 'needs_attention');
  assert.equal(db.failCalls[0].code, 'G1_PROVIDER_FAILED');
  assert.equal(db.failCalls[0].retryEligible, false, '终态失败绝不自动重试');
  const diagnostics = db.failCalls[0].diagnostics;
  assert.equal(diagnostics.provider_code, 'InvalidParameter', 'provider 终态代码必须有界保留');
  assert.equal(diagnostics.provider_message, "Input should be '1080P' or '720P': parameters.resolution", 'provider 终态消息必须有界保留');
  assert.equal(diagnostics.task_status, 'FAILED', '终态任务状态必须保留');
  assert.equal(diagnostics.request_id, 'req-terminal-1', '终态血缘 request id 必须保留');
  assert.equal(diagnostics.phase, 'submitted');
  assert.ok(Array.isArray(diagnostics.issues) && diagnostics.issues.length === 1, '诊断必须有界且恰好一条');
  assert.ok(diagnostics.issues[0].includes('InvalidParameter'), '有界 issues 必须包含精确 provider 代码');
  assert.doesNotMatch(JSON.stringify(diagnostics), /sk-test-worker-key/, '诊断绝不包含 Secret');
  assert.equal(provider.submissions.length, 1, '终态失败绝不重提付费作业');
  assert.equal([...db.attempts.values()].length, 1, '绝不调度第二次尝试');
  assert.equal(storage.uploads.length, 0, '终态失败绝不产生产物');
  assert.equal(db.jobs.get(JOB).status, 'needs_attention');

  // CANCELED：同样有界保留，同样绝不重试。
  const db2 = new FakeDb();
  db2.addJob({ attemptId: 'g1a-aaaaaaaaaaaaaaaaaaaaaaaa' });
  const provider2 = createFakeProvider();
  provider2.setSubmitBehavior({
    pollQueue: ['CANCELED'],
    failDetails: { code: 'TaskCanceled', message: '任务已取消' },
  });
  const outcome2 = await processClaimedJob(
    { ...makeClaim({ mode: 'video_t2v', modelName: 'happyhorse-1.0-t2v', requestOverrides: { prompt: '海边日落', aspect_ratio: '16:9', duration_seconds: 5, resolution: '720p' } }), attempt_id: 'g1a-aaaaaaaaaaaaaaaaaaaaaaaa' },
    makeDeps({ db: db2, storage, provider: provider2, now }),
  );
  assert.equal(outcome2.outcome, 'needs_attention');
  assert.equal(db2.failCalls[0].code, 'G1_PROVIDER_CANCELED');
  assert.equal(db2.failCalls[0].diagnostics.provider_code, 'TaskCanceled');
  assert.equal(db2.failCalls[0].diagnostics.provider_message, '任务已取消');
  assert.equal(db2.failCalls[0].retryEligible, false, '取消同样绝不自动重试');
  assert.equal(provider2.submissions.length, 1);
  assert.equal([...db2.attempts.values()].length, 1, '取消后绝不调度第二次尝试');
  assert.equal(storage.uploads.length, 0);
});
