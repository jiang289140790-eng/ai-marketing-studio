// G1 私有生成 worker（Linux 兼容；Node >= 20）。
//
// 安全协议（绝不重复付费提交）：
//   1. claim 只拿到带 lease 的 attempt；job 绑定（Brief 指纹/项目修订/知识卡/
//      证据）在 SQL 认领时重新校验，过期则作业失败且不发起任何 provider 调用；
//   2. 新提交：先 report_poll(phase='pre_submit') 持久化「提交窗口开始」→
//      提交：
//      - 图片（qwen-image-2.0）为同步契约：成功即把真实 request_id 落盘为
//        provider_task_id 血缘标识（绝不伪造合成 task id），零轮询直接
//        有界下载 → 产物落盘 → complete_attempt；崩溃在标识落盘前 → 对账为
//        ambiguous（绝不重排重提）；标识落盘后但产物未完成 → 失败关闭，
//        绝不把 request id 当作异步 task id 轮询或重新提交付费操作；
//      - 视频（t2v/i2v）为异步契约：拿到 provider task id 立即
//        mark_provider_submitted；随后轮询同一 task id；终态 FAILED/
//        CANCELED 时有界保留 provider_code / provider_message 诊断，
//        needs_attention（retry_eligible=false），绝不重试、绝不重提、
//        绝不产生第二次尝试或产物；
//      - 确定性请求契约失败（4xx InvalidParameter/无效 URL/input/model/
//        size，或画幅未批准/畸形）→ fail_attempt(retry_eligible=false)：
//        单次尝试，绝不自动重试（重试必然再次失败，且可能重复付费）；
//      - 网络/5xx/超时/响应无效/缺 request id/同步结果集不符（adapter
//        显式标记 ambiguous=true，无法证明）→ fail_attempt(retry_eligible=
//        false) → needs_attention，绝不自动重试；
//      - lease 过期且 phase='pre_submit' 但标识未落盘 → SQL 对账标记
//        ambiguous（无法证明）；phase 未进入提交窗口 → 安全重排；
//   3. 恢复轮询：claim 返回 resume=true 时携带同一 provider_task_id，只轮询、
//      绝不重新提交；轮询期间心跳续租；lease 丢失即停止（另一 worker 接管
//      同一 task id 轮询是安全的）；
//   4. 产物：有界下载 → SHA-256/MIME/大小校验 → 上传私有确定性路径 →
//      complete_attempt（SQL 再次校验路径/哈希/MIME 并绑定精确血缘）。
//
// Secret 只从运行时环境/文件挂载读取（BAILIAN_API_KEY(_FILE)），绝不返回、
// 记录、持久化或暴露给浏览器；诊断全部经过 sanitizeDiagnostics。

import { createClient } from '@supabase/supabase-js';
import { setTimeout } from 'node:timers';
import {
  apiKeyFromEnv,
  CLAIM_MAX_JOBS,
  DIAGNOSTIC_MAX_CHARS,
  G1_WORKER_ID,
  LEASE_SECONDS,
  OVERALL_JOB_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  PROVIDER_BASE_URL,
  PROVIDER_POLL_TIMEOUT_MS,
  PROVIDER_SUBMIT_TIMEOUT_MS,
  maxArtifactBytesForMode,
} from './config.mjs';
import { createDbAdapter, isLeaseLostError } from './db-adapter.mjs';
import { createStorageAdapter, sha256Hex } from './storage-adapter.mjs';
import {
  TASK_STATUS_CANCELED,
  TASK_STATUS_FAILED,
  TASK_STATUS_SUCCEEDED,
  downloadResult,
  pollTask,
  sanitizeDiagnostics,
  submitImage,
  submitVideo,
} from './bailian-adapter.mjs';

function boundedDiagnostics(detail) {
  return { issues: [sanitizeDiagnostics(detail, DIAGNOSTIC_MAX_CHARS)] };
}

function parseArtifactDimensions(mime, byteSize) {
  // 有界占位：真实尺寸由下载字节内容在 staging 适配器阶段解析；本地
  // fake/确定性测试直接使用 0（无可用尺寸时为空）。绝不猜测尺寸。
  return { width: null, height: null, duration_seconds: null, byte_size: byteSize, mime };
}

/** 由 job 数据构造 provider 请求参数（与 bailian-adapter 契约一致）。 */
function buildProviderInput(claimed, reference, { fetchImpl = globalThis.fetch, apiKey = '' } = {}) {
  const request = claimed.request || {};
  const mode = claimed.mode;
  const common = {
    apiKey: apiKey || apiKeyFromEnv(),
    model: claimed.model_name,
    prompt: String(request.prompt || '').slice(0, 2000),
    negativePrompt: String(request.negative_prompt || '').slice(0, 500),
    aspectRatio: request.aspect_ratio || (mode === 'image' ? '1:1' : '16:9'),
    baseUrl: PROVIDER_BASE_URL,
    fetchImpl,
  };
  if (mode === 'image') {
    return { kind: 'image', params: { ...common, timeoutMs: PROVIDER_SUBMIT_TIMEOUT_MS } };
  }
  return {
    kind: 'video',
    params: {
      ...common,
      durationSeconds: Number(request.duration_seconds) || 5,
      resolution: request.resolution || '720p',
      imgUrl: mode === 'video_i2v' ? (reference?.url || null) : null,
      timeoutMs: PROVIDER_SUBMIT_TIMEOUT_MS,
    },
  };
}

/**
 * 处理一个已认领作业。`deps` 全部可注入（本地确定性测试）。
 * 返回 {outcome: 'completed'|'failed'|'needs_attention'|'retry_scheduled'|'released'}。
 */
export async function processClaimedJob(claimed, deps) {
  const { db, storage, logger = console, now = () => new Date() } = deps;
  const jobId = claimed.job_id;
  const attemptId = claimed.attempt_id;
  const workerId = claimed.worker_id || G1_WORKER_ID;
  const mode = claimed.mode;
  const apiKey = deps.apiKey || apiKeyFromEnv();

  const failAttempt = async (code, detail, retryEligible) => {
    const diagnostics = boundedDiagnostics(detail);
    const result = await db.failAttempt({ jobId, attemptId, workerId, code, diagnostics, retryEligible });
    return { outcome: result?.outcome || (retryEligible ? 'failed' : 'needs_attention') };
  };

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const overallTimeoutMs = deps.overallTimeoutMs || OVERALL_JOB_TIMEOUT_MS;
  try {
    // 恢复路径：同步图片的 request_id 只是付费调用血缘，不是可轮询 task id。
    // 当前 claim 合同不返回已生成图片 URL，因此中断后只能失败关闭；绝不把
    // request_id 发送到异步 tasks API，也绝不重新提交。异步视频保持原恢复轮询。
    if (claimed.resume === true || claimed.provider_task_id) {
      const taskId = claimed.provider_task_id;
      if (mode === 'image') {
        logger.warn(`[${jobId}] synchronous image result cannot be safely resumed from request id ${taskId}.`);
        return await failAttempt(
          'G1_SYNC_IMAGE_RESULT_UNAVAILABLE',
          'Synchronous image request was accepted, but its result URL is unavailable after worker recovery; no provider call or retry was attempted.',
          false,
        );
      }
      logger.info(`[${jobId}] resuming polling of provider task ${taskId}`);
      return await pollUntilTerminal({ jobId, attemptId, workerId, taskId, db, storage, mode, claimed, logger, now, apiKey, fetchImpl, overallTimeoutMs });
    }

    if (!apiKey) {
      return await failAttempt('G1_WORKER_API_KEY_MISSING', 'Bailian API key is not configured for the worker.', true);
    }

    // i2v：有界下载引用素材 → 上传私有 bucket → 短时签名 URL。
    let reference = null;
    if (mode === 'video_i2v') {
      const assetId = claimed.reference_asset_id;
      if (!assetId) {
        return await failAttempt('G1_REFERENCE_ASSET_REQUIRED', 'i2v job is missing its approved reference asset.', true);
      }
      const url = deps.referenceUrlFor ? deps.referenceUrlFor(assetId) : String(claimed.reference_url || '');
      if (!url) {
        return await failAttempt('G1_REFERENCE_ASSET_REQUIRED', 'i2v job has no reference asset URL; binding failed closed.', true);
      }
      try {
        const downloaded = await storage.downloadReference({ url, maxBytes: deps.maxReferenceBytes });
        reference = await storage.prepareReference({
          user: claimed.user_id,
          project: claimed.project_id,
          jobId,
          attemptId,
          buffer: downloaded.buffer,
          mime: downloaded.mime,
        });
      } catch (error) {
        return await failAttempt('G1_REFERENCE_PREPARE_FAILED', String(error?.message || 'Reference preparation failed.').slice(0, 400), true);
      }
    }

    // 提交窗口开始：持久化 phase='pre_submit'（lease 过期对账据此判定是否
    // 可能已接受付费作业）。
    await db.reportPoll({
      jobId, attemptId, workerId,
      providerStatus: 'pre_submit',
      providerState: {
        phase: 'pre_submit',
        mode,
        prompt_sha256: sha256Hex(String(claimed.request?.prompt || '')),
        ...(reference ? { reference_asset_id: claimed.reference_asset_id, reference_sha256: reference.content_sha256 } : {}),
      },
    });

    // 提交。确定性请求契约失败（4xx InvalidParameter/无效 URL/input/model/
    // size，或本地画幅校验失败）→ 单次尝试，绝不自动重试（重试必然再次
    // 失败，且可能重复付费）；其余（网络/5xx/超时/无效响应/缺 request id/
    // 结果集不符）→ ambiguous，绝不自动重试。
    const input = buildProviderInput(claimed, reference, { fetchImpl, apiKey });
    let submitted;
    try {
      submitted = input.kind === 'image'
        ? await submitImage(input.params)
        : await submitVideo(input.params);
    } catch (error) {
      // 显式分类消费：只有同时具备显式 ambiguous=false 且 code 属于确定性
      // 拒绝集合（PROVIDER_REJECTED=4xx 永久契约失败 / ASPECT_RATIO_
      // UNSUPPORTED=本地画幅校验失败）才按永久拒绝单次收口；其余（5xx/
      // 网络/超时/无效响应，以及任何未显式标记或标记矛盾的错误）一律按
      // ambiguous 处理，绝不自动重试。
      if (error?.ambiguous === false
        && (error?.code === 'PROVIDER_REJECTED' || error?.code === 'ASPECT_RATIO_UNSUPPORTED')) {
        return await failAttempt(
          error?.code === 'ASPECT_RATIO_UNSUPPORTED' ? 'G1_ASPECT_RATIO_UNSUPPORTED' : 'G1_PROVIDER_REJECTED',
          error.message,
          false,
        );
      }
      return await failAttempt('G1_PROVIDER_SUBMISSION_AMBIGUOUS', error.message, false);
    }

    if (input.kind === 'image') {
      // qwen-image-2.0 同步成功：立即把结果落为作业产物。provider 的
      // request_id 是本次付费操作的真实标识——落盘为 provider_task_id 血缘
      // 列（绝不伪造合成 task id），随后零轮询直接完成。崩溃在落盘前 →
      // phase 仍为 pre_submit → 对账 ambiguous；落盘后 → 恢复轮询同一
      // request id；若此后进程中断，恢复路径会失败关闭且零 provider 调用，
      // 因为 request id 不是可轮询的异步 task id。
      await db.markProviderSubmitted({
        jobId, attemptId, workerId,
        providerTaskId: submitted.request_id,
        providerState: {
          phase: 'submitted',
          mode,
          provider: 'bailian',
          request_id: submitted.request_id,
          usage: submitted.usage || {},
          submitted_at: now().toISOString(),
        },
      });
      logger.info(`[${jobId}] synchronous image result ${submitted.request_id}`);
      return await completeArtifactFromUrl({
        jobId, attemptId, workerId, mode, claimed,
        resultUrl: submitted.url,
        usage: submitted.usage || {},
        db, storage, logger, fetchImpl,
      });
    }

    await db.markProviderSubmitted({
      jobId, attemptId, workerId,
      providerTaskId: submitted.task_id,
      providerState: {
        phase: 'submitted',
        mode,
        request_id: submitted.request_id || null,
        provider: 'bailian',
        submitted_at: now().toISOString(),
      },
    });
    logger.info(`[${jobId}] submitted provider task ${submitted.task_id}`);
    return await pollUntilTerminal({ jobId, attemptId, workerId, taskId: submitted.task_id, db, storage, mode, claimed, logger, now, apiKey, fetchImpl, overallTimeoutMs });
  } catch (error) {
    if (isLeaseLostError(error)) {
      logger.warn(`[${jobId}] lease lost; stopping work on this attempt.`);
      return { outcome: 'released' };
    }
    logger.error(`[${jobId}] unexpected worker failure.`, error?.message);
    try {
      return await failAttempt('G1_WORKER_INTERNAL', String(error?.message || 'Worker failed unexpectedly.').slice(0, 400), false);
    } catch {
      return { outcome: 'released' };
    }
  }
}

/**
 * Recover exactly one already-paid provider task whose persisted attempt is
 * ambiguous. This path has no submit capability: it reads the exact recovery
 * context, polls the exact existing provider task once, downloads/uploads the
 * terminal result, then asks SQL to atomically append the artifact and convert
 * that same attempt to succeeded. An unclear/non-success result is returned
 * without changing the database and must not be retried automatically.
 */
export async function recoverExistingProviderTask(target, deps) {
  const { db, storage, logger = console } = deps;
  const jobId = String(target?.jobId || '');
  const attemptId = String(target?.attemptId || '');
  const providerTaskId = String(target?.providerTaskId || '');
  const workerId = String(target?.workerId || G1_WORKER_ID).slice(0, 64);
  const apiKey = deps.apiKey || apiKeyFromEnv();
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const pollTaskImpl = deps.pollTaskImpl || pollTask;

  if (!jobId || !attemptId || !providerTaskId) {
    return { outcome: 'blocked', code: 'G1_RECOVERY_IDENTITY_INVALID' };
  }
  if (!apiKey) {
    return { outcome: 'blocked', code: 'G1_WORKER_API_KEY_MISSING' };
  }

  const context = await db.getAmbiguousRecoveryContext({ jobId, attemptId, providerTaskId });
  if (!context
    || context.job_id !== jobId
    || context.attempt_id !== attemptId
    || context.provider_task_id !== providerTaskId) {
    return { outcome: 'blocked', code: 'G1_RECOVERY_CONTEXT_MISMATCH' };
  }
  const mode = context.mode;
  if (!['video_t2v', 'video_i2v'].includes(mode)) {
    return { outcome: 'blocked', code: 'G1_RECOVERY_MODE_INVALID' };
  }
  const poll = await pollTaskImpl({
    apiKey,
    taskId: providerTaskId,
    baseUrl: PROVIDER_BASE_URL,
    fetchImpl,
    timeoutMs: PROVIDER_POLL_TIMEOUT_MS,
  });

  if (poll.status !== TASK_STATUS_SUCCEEDED) {
    return {
      outcome: 'not_recovered',
      code: poll.status === TASK_STATUS_FAILED
        ? 'G1_PROVIDER_FAILED'
        : poll.status === TASK_STATUS_CANCELED
          ? 'G1_PROVIDER_CANCELED'
          : 'G1_PROVIDER_RESULT_NOT_TERMINAL',
      provider_status: poll.status,
    };
  }

  const resultUrl = poll.results?.[0]?.url;
  if (!resultUrl) {
    return { outcome: 'not_recovered', code: 'G1_PROVIDER_RESULT_MISSING', provider_status: poll.status };
  }

  const downloaded = await downloadResult({
    url: resultUrl,
    maxBytes: maxArtifactBytesForMode(mode),
    fetchImpl,
  });
  const contentSha = sha256Hex(downloaded.buffer);
  const parsed = parseArtifactDimensions(downloaded.mime, downloaded.buffer.byteLength);
  const version = Number(context?.next_artifact_version) || 1;
  const path = await storage.uploadArtifact({
    user: context.user_id,
    project: context.project_id,
    jobId,
    version,
    contentSha,
    mime: downloaded.mime,
    buffer: downloaded.buffer,
  });

  const completed = await db.recoverAmbiguousAttempt({
    jobId,
    attemptId,
    providerTaskId,
    workerId,
    providerStatus: poll.status,
    artifact: {
      schema_version: 'g1_artifact_v1',
      content_sha256: contentSha,
      mime_type: parsed.mime,
      byte_size: parsed.byte_size,
      width: parsed.width,
      height: parsed.height,
      duration_seconds: parsed.duration_seconds,
      storage_path: path,
      source_url: resultUrl.length <= 500 ? resultUrl : null,
      usage: poll.usage || {},
      cost_cny: null,
    },
  });
  logger.info(`[${jobId}] recovered existing provider task into artifact ${completed?.artifact?.artifact_version}.`);
  return { outcome: 'completed', artifact: completed?.artifact || null };
}

/**
 * 有界下载已就绪结果 → SHA-256 → 私有确定性路径上传 → completeAttempt。
 * 图片同步路径与视频轮询成功路径共用；失败（网络/超限/上传/完成 RPC）按
 * fail-closed 冒泡（绝不重试，绝不重新提交付费操作）。
 */
async function completeArtifactFromUrl({ jobId, attemptId, workerId, mode, claimed, resultUrl, usage = {}, db, storage, logger, fetchImpl = globalThis.fetch }) {
  const maxBytes = maxArtifactBytesForMode(mode);
  const downloaded = await downloadResult({ url: resultUrl, maxBytes, fetchImpl });
  const contentSha = sha256Hex(downloaded.buffer);
  const parsed = parseArtifactDimensions(downloaded.mime, downloaded.buffer.byteLength);
  const version = Number(claimed.next_artifact_version) || 1;
  const path = await storage.uploadArtifact({
    user: claimed.user_id,
    project: claimed.project_id,
    jobId,
    version,
    contentSha,
    mime: downloaded.mime,
    buffer: downloaded.buffer,
  });
  const completed = await db.completeAttempt({
    jobId, attemptId, workerId,
    artifact: {
      schema_version: 'g1_artifact_v1',
      content_sha256: contentSha,
      mime_type: parsed.mime,
      byte_size: parsed.byte_size,
      width: parsed.width,
      height: parsed.height,
      duration_seconds: parsed.duration_seconds,
      storage_path: path,
      source_url: resultUrl,
      usage,
      cost_cny: null,
    },
  });
  logger.info(`[${jobId}] completed artifact ${completed?.artifact?.artifact_version} (${contentSha.slice(0, 12)})`);
  return { outcome: 'completed', artifact: completed?.artifact || null };
}

async function pollUntilTerminal({ jobId, attemptId, workerId, taskId, db, storage, mode, claimed, logger, now, apiKey, fetchImpl = globalThis.fetch, overallTimeoutMs = OVERALL_JOB_TIMEOUT_MS }) {
  // 整体超时与心跳节拍使用可注入时钟（测试用 fake clock 确定性推进，绝不
  // 依赖真实等待）；生产默认仍是系统时钟。
  const clock = now || (() => new Date());
  const startedAt = clock().getTime();
  let lastHeartbeat = 0;
  const overallTimeout = overallTimeoutMs;

  const heartbeat = async () => {
    if (clock().getTime() - lastHeartbeat < 120_000) return;
    await db.heartbeat({ jobId, attemptId, workerId, leaseSeconds: LEASE_SECONDS });
    lastHeartbeat = Date.now();
  };

  while (true) {
    if (clock().getTime() - startedAt > overallTimeout) {
      return await db.failAttempt({
        jobId, attemptId, workerId,
        code: 'G1_WORKER_TIMEOUT',
        diagnostics: boundedDiagnostics('Generation exceeded the overall bounded timeout.'),
        retryEligible: false,
      }).then(() => ({ outcome: 'needs_attention' })).catch((error) => {
        if (isLeaseLostError(error)) return { outcome: 'released' };
        throw error;
      });
    }
    await heartbeat();

    const poll = await pollTask({
      apiKey: apiKey || apiKeyFromEnv(),
      taskId,
      baseUrl: PROVIDER_BASE_URL,
      fetchImpl,
      timeoutMs: PROVIDER_POLL_TIMEOUT_MS,
    });
    await db.reportPoll({
      jobId, attemptId, workerId,
      providerStatus: poll.status,
      providerState: {
        phase: 'submitted',
        task_status: poll.status,
        request_id: poll.request_id || null,
        polled_at: now().toISOString(),
      },
    });

    if (poll.status === TASK_STATUS_SUCCEEDED) {
      const resultUrl = poll.results?.[0]?.url;
      if (!resultUrl) {
        return await db.failAttempt({
          jobId, attemptId, workerId,
          code: 'G1_PROVIDER_RESULT_MISSING',
          diagnostics: boundedDiagnostics('Provider reported success without a result URL.'),
          retryEligible: false,
        }).then(() => ({ outcome: 'needs_attention' })).catch((error) => {
          if (isLeaseLostError(error)) return { outcome: 'released' };
          throw error;
        });
      }
      return await completeArtifactFromUrl({
        jobId, attemptId, workerId, mode, claimed,
        resultUrl,
        db, storage, logger, fetchImpl,
      });
    }

    if (poll.status === TASK_STATUS_FAILED || poll.status === TASK_STATUS_CANCELED) {
      // provider 已接受任务并明确失败/取消：持久化状态已绑定 task id，绝不
      // 重新提交（唯一合法后续是人工介入或同一 task id 轮询）。有界保留
      // provider 终态诊断（provider_code / provider_message + 状态与血缘），
      // 绝不暴露 headers、token、签名 URL 或 raw 载荷；畸形诊断已由 adapter
      // fail-closed 为 null，绝不透传。
      const providerCode = typeof poll.provider_code === 'string' ? poll.provider_code : null;
      const providerMessage = typeof poll.provider_message === 'string' ? poll.provider_message : null;
      const detail = providerCode
        ? `Provider task reached ${poll.status}: ${providerCode}${providerMessage ? ` — ${providerMessage}` : ''}`
        : `Provider task reached terminal status ${poll.status}.`;
      return await db.failAttempt({
        jobId, attemptId, workerId,
        code: poll.status === TASK_STATUS_FAILED ? 'G1_PROVIDER_FAILED' : 'G1_PROVIDER_CANCELED',
        diagnostics: {
          issues: [sanitizeDiagnostics(detail, DIAGNOSTIC_MAX_CHARS)],
          provider_code: providerCode,
          provider_message: providerMessage,
          task_status: poll.status,
          request_id: poll.request_id || null,
          phase: 'submitted',
        },
        retryEligible: false,
      }).then(() => ({ outcome: 'needs_attention' })).catch((error) => {
        if (isLeaseLostError(error)) return { outcome: 'released' };
        throw error;
      });
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * worker 主循环：认领 → 处理 → 短退避后继续。`deps` 可注入（测试用内存
 * fake）；`shouldContinue` 允许测试驱动停止。
 */
export async function runWorkerLoop(deps) {
  const { db, logger = console, shouldContinue = () => true, claimIntervalMs = 2000 } = deps;
  const workerId = deps.workerId || G1_WORKER_ID;
  while (shouldContinue()) {
    let claimedResult;
    try {
      claimedResult = await db.claimJobs({ workerId, maxJobs: CLAIM_MAX_JOBS, leaseSeconds: LEASE_SECONDS });
    } catch (error) {
      logger.error('Claim failed; backing off.', error?.message);
      await new Promise((resolve) => setTimeout(resolve, claimIntervalMs));
      continue;
    }
    for (const claimed of claimedResult.claimed || []) {
      try {
        await processClaimedJob({ ...claimed, worker_id: workerId }, deps);
      } catch (error) {
        logger.error(`[${claimed.job_id}] processing failed.`, error?.message);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, claimIntervalMs));
  }
}

/** 独立入口：从环境读取配置并启动 worker。 */
export function createWorkerClients({ supabaseUrl, serviceKey }) {
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    db: createDbAdapter({ supabase }),
    storage: createStorageAdapter({ supabase }),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the worker runtime.');
  }
  const { db, storage } = createWorkerClients({ supabaseUrl, serviceKey });
  runWorkerLoop({ db, storage }).catch((error) => {
    console.error('Worker stopped.', error);
    process.exit(1);
  });
}
