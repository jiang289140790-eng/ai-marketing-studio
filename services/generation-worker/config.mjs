// G1 worker 配置：全部有界值来自运行时环境（Secret 只从环境/文件挂载读取，
// 绝不返回、记录、持久化或暴露给浏览器）。
//
// 边界约定：
//   - BAILIAN_API_KEY / BAILIAN_API_KEY_FILE：Bailian(DashScope) 密钥，
//     只存在于进程内存；任何诊断、日志、provider_state 都不包含其值；
//   - 所有请求/响应/下载/轮询/超时/诊断长度都有硬上限；
//   - 覆盖项仅供本地测试（fake provider 需要毫秒级节奏），生产使用默认值。

import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return Math.floor(parsed);
}

function readSecretFile(pathValue) {
  if (!pathValue) return '';
  try {
    return readFileSync(pathValue, 'utf8').trim();
  } catch {
    return '';
  }
}

export const G1_WORKER_ID = process.env.G1_WORKER_ID || `worker-${hostname()}`.slice(0, 64);

export const CLAIM_MAX_JOBS = boundedInt(process.env.G1_CLAIM_MAX_JOBS, 1, 1, 10);
export const LEASE_SECONDS = boundedInt(process.env.G1_LEASE_SECONDS, 300, 60, 3600);

export const POLL_INTERVAL_MIN_MS = boundedInt(process.env.G1_POLL_INTERVAL_MIN_MS, 5000, 100, 3600_000);
export const POLL_INTERVAL_MAX_MS = boundedInt(process.env.G1_POLL_INTERVAL_MAX_MS, 60_000, 100, 3_600_000);
export const POLL_INTERVAL_MS = boundedInt(process.env.G1_POLL_INTERVAL_MS, 10_000, 100, 3_600_000);
export const OVERALL_JOB_TIMEOUT_MS = boundedInt(process.env.G1_OVERALL_JOB_TIMEOUT_MS, 3_600_000, 1000, 86_400_000);

export const MAX_PROVIDER_RESPONSE_BYTES = boundedInt(process.env.G1_MAX_PROVIDER_RESPONSE_BYTES, 1 * 1024 * 1024, 4096, 16 * 1024 * 1024);
export const MAX_REFERENCE_DOWNLOAD_BYTES = boundedInt(process.env.G1_MAX_REFERENCE_DOWNLOAD_BYTES, 20 * 1024 * 1024, 1024, 100 * 1024 * 1024);
export const MAX_IMAGE_ARTIFACT_BYTES = boundedInt(process.env.G1_MAX_IMAGE_ARTIFACT_BYTES, 20 * 1024 * 1024, 1024, 100 * 1024 * 1024);
export const MAX_VIDEO_ARTIFACT_BYTES = boundedInt(process.env.G1_MAX_VIDEO_ARTIFACT_BYTES, 512 * 1024 * 1024, 1024, 1024 * 1024 * 1024);
export const DIAGNOSTIC_MAX_CHARS = boundedInt(process.env.G1_DIAGNOSTIC_MAX_CHARS, 4096, 256, 8192);

export const PROVIDER_BASE_URL = process.env.G1_PROVIDER_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';
export const PROVIDER_SUBMIT_TIMEOUT_MS = boundedInt(process.env.G1_PROVIDER_SUBMIT_TIMEOUT_MS, 60_000, 1000, 300_000);
export const PROVIDER_POLL_TIMEOUT_MS = boundedInt(process.env.G1_PROVIDER_POLL_TIMEOUT_MS, 30_000, 1000, 120_000);

export const STORAGE_BUCKET = process.env.G1_STORAGE_BUCKET || 'g1-generation-artifacts';

export function apiKeyFromEnv(env = process.env) {
  const file = env.BAILIAN_API_KEY_FILE || '';
  const fromFile = file ? readSecretFile(file) : '';
  return env.BAILIAN_API_KEY || fromFile || '';
}

/** 图片/视频下载上限（按 mode 的有界默认）。 */
export function maxArtifactBytesForMode(mode) {
  return mode === 'image' ? MAX_IMAGE_ARTIFACT_BYTES : MAX_VIDEO_ARTIFACT_BYTES;
}
