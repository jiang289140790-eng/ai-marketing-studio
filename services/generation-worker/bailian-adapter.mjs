// G1 Bailian (DashScope) 生成适配器（纯 ESM；fetch 可注入，本地确定性测试）。
//
// 契约（staging 部署时按 DashScope 官方 API 对齐；本仓库永远只对
// deterministic fake HTTP server 调用）：
//   - 图片（qwen-image-2.0，同步）：POST /api/v1/services/aigc/multimodal-generation/generation
//     body {model, input:{messages:[{role:'user',content:[{text}]}]},
//           parameters:{negative_prompt?, size, n: 1, prompt_extend, watermark}}
//     头部绝不含 x-dashscope-async（同步契约）；响应
//     {output:{choices:[{message:{content:[{text},{image}]}}]}, request_id, usage}
//     → 恰好一个有界 image 结果（n=1），无 provider task id、无轮询；
//   - 视频（t2v/i2v，异步）：POST /api/v1/services/aigc/video-generation/video-synthesis
//     body {model, input: {prompt, img_url?}, parameters: {resolution, duration_seconds}}
//     分辨率在视频边界归一：内部 720p/1080p → 线上精确 720P/1080P；缺失/
//     畸形/未批准值在零 provider 调用前失败（VIDEO_RESOLUTION_UNSUPPORTED）。
//   - 轮询：GET /api/v1/tasks/{task_id}
//     响应 {output: {task_status: PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED, results: [{url,...}]}}
//
// 安全规则：
//   - Secret 只来自调用方注入的 apiKey，绝不写入日志、诊断或 provider_state；
//   - 请求/响应全部有界（MAX_PROVIDER_RESPONSE_BYTES）；
//   - 结果判定有三种，每个错误都携带显式分类标记供 worker 精确消费：
//       rejected   → ambiguous=false（provider 明确 4xx 拒绝：InvalidParameter/
//                    无效 URL/input/model/size 等永久请求契约失败 → 单次尝试，
//                    绝不自动重试）；
//       local      → ambiguous=false（画幅未批准/畸形，未发起任何 provider
//                    调用 → 单次尝试，绝不自动重试）；
//       ambiguous  → ambiguous=true（网络/5xx/超时/响应无效/缺 request id/
//                    同步结果集不符，无法证明 → 绝不自动重试，作业进入
//                    needs_attention）；
//   - 未携带 ambiguous 标记的错误按 fail-closed 处理（worker 视为不可重试）；
//   - 诊断全部经过 sanitizeDiagnostics（有界 + 密钥脱敏）。

/* global AbortController */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';

export const TASK_STATUS_PENDING = 'PENDING';
export const TASK_STATUS_RUNNING = 'RUNNING';
export const TASK_STATUS_SUCCEEDED = 'SUCCEEDED';
export const TASK_STATUS_FAILED = 'FAILED';
export const TASK_STATUS_CANCELED = 'CANCELED';

export function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 注册表批准的画幅 → Qwen-Image 显式 size（W*H）。仅收录 Provider Registry
 * 的 allowed_aspect_ratios（迁移已部署，绝不改动）；其余画幅一律在发起任何
 * provider 调用前失败（fail closed，绝不猜测尺寸）。1:1 / 16:9 / 9:16 使用
 * DashScope 文档公布值；其余按同像素级、精确表达注册画幅的确定值。
 */
export const ASPECT_RATIO_TO_SIZE = Object.freeze({
  '1:1': '1024*1024',
  '4:3': '1152*864',
  '3:4': '864*1152',
  '16:9': '1280*720',
  '9:16': '720*1280',
  '21:9': '1344*576',
});

export const SUPPORTED_ASPECT_RATIOS = Object.freeze(Object.keys(ASPECT_RATIO_TO_SIZE));

/** 画幅 → Qwen-Image size；未批准/畸形返回 null（调用方必须在请求前处理）。 */
export function resolveImageSize(aspectRatio) {
  return ASPECT_RATIO_TO_SIZE[String(aspectRatio ?? '')] || null;
}

/**
 * 视频分辨率内部契约（G1 请求/SQL/UI 保持 720p / 1080p）→ Bailian 视频
 * 边界线上精确值（720P / 1080P）。仅在视频边界映射，绝不改动图片契约与
 * 内部契约；缺失/畸形/混合/未批准值一律返回 null（调用方必须在任何
 * provider 调用前失败）。
 */
export const VIDEO_RESOLUTION_TO_PROVIDER = Object.freeze({
  '720p': '720P',
  '1080p': '1080P',
});

export const SUPPORTED_VIDEO_RESOLUTIONS = Object.freeze(Object.keys(VIDEO_RESOLUTION_TO_PROVIDER));

/** 内部分辨率 → provider 线上精确值；缺失/畸形/未批准返回 null。 */
export function resolveVideoResolution(resolution) {
  return VIDEO_RESOLUTION_TO_PROVIDER[String(resolution ?? '')] || null;
}

/** 有界 + 脱敏诊断：绝不包含 Authorization 头、密钥形态或超长原文。 */
export function sanitizeDiagnostics(text, maxChars = 4096) {
  const source = String(text ?? '').slice(0, maxChars * 2);
  const redacted = source
    .replace(/bearer\s+[a-zA-Z0-9._~-]{8,}/gi, 'Bearer <redacted>')
    .replace(/(sk-|AKLT|api[_-]?key[=:]\s*)[a-zA-Z0-9_-]{8,}/gi, '$1<redacted>')
    .replace(/authorization:\s*[^\s,;]+/gi, 'authorization: <redacted>');
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}

/** 有界错误；ambiguous=true（响应超过上限时无法证明 provider 是否已接受）。 */
function boundedError(code, message) {
  return Object.assign(new Error(String(message).slice(0, 240)), { code, ambiguous: true });
}

async function readBoundedResponse(response, limit) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw boundedError('PROVIDER_RESPONSE_TOO_LARGE', 'Provider response exceeded the bounded limit.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      try { await reader.cancel(); } catch { /* best-effort */ }
      throw boundedError('PROVIDER_RESPONSE_TOO_LARGE', 'Provider response exceeded the bounded limit.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs, headers, body, method = 'GET' }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
    const text = await readBoundedResponse(response, 1024 * 1024);
    if (!response.ok) {
      let detail = '';
      try {
        const parsed = JSON.parse(text);
        detail = String(parsed?.message || parsed?.code || '').slice(0, 240);
      } catch {
        detail = response.statusText || '';
      }
      if (response.status >= 400 && response.status < 500) {
        // 明确 4xx 拒绝：请求契约永久无效（InvalidParameter/无效 URL/input/
        // model/size 等）→ 显式 ambiguous=false；worker 按单次尝试收口，
        // 绝不自动重试（重试必然再次失败，且可能重复付费）。
        throw Object.assign(new Error(`Provider rejected the request: ${sanitizeDiagnostics(detail, 240)}`), {
          code: 'PROVIDER_REJECTED',
          provider_status: response.status,
          ambiguous: false,
        });
      }
      // 5xx：provider 可能已接受付费作业 → ambiguous=true，绝不自动重试。
      throw Object.assign(new Error(`Provider returned HTTP ${response.status}; outcome is ambiguous.`), {
        code: 'PROVIDER_HTTP_5XX',
        provider_status: response.status,
        ambiguous: true,
      });
    }
    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Provider request timed out; outcome is ambiguous.'), { code: 'PROVIDER_TIMEOUT', ambiguous: true });
    }
    // 已分类错误（PROVIDER_REJECTED / PROVIDER_RESPONSE_TOO_LARGE 等）原样重抛，
    // 保留其显式 ambiguous 标记。
    if (error?.code) throw error;
    throw Object.assign(new Error('Provider network request failed; outcome is ambiguous.'), { code: 'PROVIDER_NETWORK', ambiguous: true });
  } finally {
    clearTimeout(timer);
  }
}

function parseProviderJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw Object.assign(new Error('Provider response was not valid JSON; outcome is ambiguous.'), { code: 'PROVIDER_RESPONSE_INVALID', ambiguous: true });
  }
}

function extractTaskId(parsed) {
  const taskId = parsed?.output?.task_id ?? parsed?.task_id ?? null;
  if (typeof taskId !== 'string' || taskId.length < 1 || taskId.length > 200) {
    // 缺失 task id：无法证明 provider 是否已接受 → ambiguous=true。
    throw Object.assign(new Error('Provider submission response carried no task id; outcome is ambiguous.'), { code: 'PROVIDER_RESPONSE_INVALID', ambiguous: true });
  }
  return taskId;
}

function submitRequest({ apiKey, baseUrl, path, body, fetchImpl, timeoutMs, async = true }) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  // 同步契约（qwen-image-2.0）绝不携带 X-DashScope-Async；异步契约（视频）
  // 必须携带。
  if (async) headers['x-dashscope-async'] = 'enable';
  return fetchJson(`${String(baseUrl).replace(/\/$/, '')}/${path}`, {
    fetchImpl,
    timeoutMs,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** 有界同步结果集（n=1）：恰好一个 image 条目（允许伴生 text 条目）。 */
function extractSynchronousImage(parsed) {
  const invalid = (hint) => Object.assign(
    new Error(`Provider synchronous response carried no valid image result${hint ? ` (${hint})` : ''}; outcome is ambiguous.`),
    { code: 'PROVIDER_RESPONSE_INVALID', ambiguous: true },
  );
  const choices = parsed?.output?.choices;
  if (!Array.isArray(choices) || choices.length < 1 || choices.length > 10) throw invalid();
  const images = [];
  for (const choice of choices) {
    const content = choice?.message?.content;
    if (!Array.isArray(content) || content.length < 1 || content.length > 10) throw invalid();
    for (const entry of content) {
      if (!Object.prototype.hasOwnProperty.call(entry || {}, 'image')) continue;
      const url = entry?.image;
      if (typeof url !== 'string' || url.length < 1 || url.length > 500 || url !== url.trim()) {
        throw invalid('invalid image URL');
      }
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw invalid('invalid image URL');
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw invalid('invalid image URL');
      }
      images.push(url);
    }
  }
  if (images.length !== 1) throw invalid(images.length > 1 ? 'expected exactly one image' : 'no image found');
  return images[0];
}

/** 有界 usage 元数据：仅保留有限非负整数 token 计数，绝不透传畸形值。 */
function extractBoundedUsage(parsed) {
  const source = parsed?.usage;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return {};
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000) {
      usage[key] = Math.floor(value);
    }
  }
  return usage;
}

/**
 * 同步提交图片生成（qwen-image-2.0）并直接消费同步结果。
 * 返回 {outcome:'succeeded', url, request_id, usage}；绝不产生 provider
 * task id（无轮询）。画幅未批准/畸形 → 在任何 provider 调用前抛
 * ASPECT_RATIO_UNSUPPORTED（ambiguous=false，单次尝试）。
 * 其余抛错 code 仅为 PROVIDER_REJECTED（4xx 永久请求契约失败，单次尝试）
 * 或 ambiguous 类（网络/5xx/超时/无效响应/结果集不符，不可重试）。
 */
export async function submitImage({ apiKey, model, prompt, negativePrompt = '', aspectRatio = '1:1', promptExtend = true, watermark = false, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
  const size = resolveImageSize(aspectRatio);
  if (!size) {
    throw Object.assign(new Error(
      `Aspect ratio "${String(aspectRatio ?? '').slice(0, 40)}" is unsupported; allowed: ${SUPPORTED_ASPECT_RATIOS.join(', ')}.`,
    ), { code: 'ASPECT_RATIO_UNSUPPORTED', ambiguous: false });
  }
  const parameters = { size, n: 1, prompt_extend: Boolean(promptExtend), watermark: Boolean(watermark) };
  if (negativePrompt) parameters.negative_prompt = String(negativePrompt).slice(0, 500);
  const body = {
    model,
    input: { messages: [{ role: 'user', content: [{ text: String(prompt).slice(0, 2000) }] }] },
    parameters,
  };
  const text = await submitRequest({
    apiKey, baseUrl, path: 'services/aigc/multimodal-generation/generation', body, fetchImpl, timeoutMs, async: false,
  });
  const parsed = parseProviderJson(text);
  const url = extractSynchronousImage(parsed);
  const requestId = parsed?.request_id;
  if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 200 || requestId !== requestId.trim()) {
    // 无有效 request id：无法把付费操作标识落盘到既有血缘列 → 明确歧义。
    // 诊断不得包含可能带短期签名参数的结果 URL。
    throw Object.assign(new Error('Provider synchronous response carried no valid bounded request id; outcome is ambiguous.'), { code: 'PROVIDER_RESPONSE_INVALID', ambiguous: true });
  }
  return { outcome: 'succeeded', url, request_id: requestId, usage: extractBoundedUsage(parsed) };
}

/**
 * 提交视频生成（happyhorse t2v / i2v）。i2v 必须携带 imgUrl（worker 已把
 * 引用素材上传到私有存储并生成短时签名 URL）。
 *
 * 视频边界分辨率归一：内部 720p / 1080p → provider 线上精确 720P / 1080P；
 * 缺失/畸形/混合/未批准值在零 provider 调用前抛
 * VIDEO_RESOLUTION_UNSUPPORTED（ambiguous=false，单次尝试）。
 */
export async function submitVideo({ apiKey, model, prompt, durationSeconds = 5, resolution = null, imgUrl = null, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
  const wireResolution = resolveVideoResolution(resolution);
  if (!wireResolution) {
    throw Object.assign(new Error(
      `Video resolution "${String(resolution ?? '').slice(0, 40)}" is unsupported; allowed: 720p, 1080p.`,
    ), { code: 'VIDEO_RESOLUTION_UNSUPPORTED', ambiguous: false });
  }
  const input = { prompt };
  if (imgUrl) input.img_url = imgUrl;
  const body = { model, input, parameters: { resolution: wireResolution, duration_seconds: durationSeconds } };
  const text = await submitRequest({ apiKey, baseUrl, path: 'services/aigc/video-generation/video-synthesis', body, fetchImpl, timeoutMs });
  const parsed = parseProviderJson(text);
  return {
    outcome: 'submitted',
    task_id: extractTaskId(parsed),
    request_id: typeof parsed?.request_id === 'string' ? parsed.request_id.slice(0, 200) : null,
  };
}

/**
 * 有界提取终态 provider 诊断：仅保留有界 provider_code（≤80 字符）与
 * 经脱敏的 provider_message（≤240 字符）。畸形/超限/非字符串一律
 * fail-closed 为 null——绝不透传 headers、token、签名 URL 或 raw 载荷。
 */
function extractTerminalDiagnostics(parsed, status) {
  if (status !== TASK_STATUS_FAILED && status !== TASK_STATUS_CANCELED) {
    return { provider_code: null, provider_message: null };
  }
  const output = parsed?.output && typeof parsed.output === 'object' && !Array.isArray(parsed.output) ? parsed.output : {};
  const rawCode = typeof output.code === 'string' ? output.code.trim() : '';
  const rawMessage = typeof output.message === 'string' ? output.message.trim() : '';
  const providerCode = rawCode && rawCode.length <= 80 ? rawCode : null;
  const providerMessage = rawMessage ? sanitizeDiagnostics(rawMessage, 240) : null;
  return { provider_code: providerCode, provider_message: providerMessage };
}

/**
 * 轮询同一 provider task id（绝不重新提交）。返回
 * {status: PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED, results: [...],
 *  provider_code, provider_message}（终态时携带有界脱敏 provider 诊断）。
 */
export async function pollTask({ apiKey, taskId, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const text = await fetchJson(`${String(baseUrl).replace(/\/$/, '')}/tasks/${encodeURIComponent(taskId)}`, {
    fetchImpl,
    timeoutMs,
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const parsed = parseProviderJson(text);
  const status = String(parsed?.output?.task_status || parsed?.task_status || '').toUpperCase();
  if (![TASK_STATUS_PENDING, TASK_STATUS_RUNNING, TASK_STATUS_SUCCEEDED, TASK_STATUS_FAILED, TASK_STATUS_CANCELED].includes(status)) {
    throw Object.assign(new Error(`Provider returned an unknown task status "${sanitizeDiagnostics(status, 40)}".`), { code: 'PROVIDER_RESPONSE_INVALID', ambiguous: true });
  }
  const results = Array.isArray(parsed?.output?.results) ? parsed.output.results : [];
  const terminal = extractTerminalDiagnostics(parsed, status);
  return {
    status,
    results: results.slice(0, 10).map((entry) => ({
      url: typeof entry?.url === 'string' ? entry.url.slice(0, 500) : null,
    })).filter((entry) => entry.url),
    request_id: typeof parsed?.request_id === 'string' ? parsed.request_id.slice(0, 200) : null,
    ...terminal,
  };
}

/**
 * 有界下载产物字节。返回 {buffer, mime}；超过 maxBytes → 抛
 * ARTIFACT_TOO_LARGE（绝不静默截断）。
 */
export async function downloadResult({ url, maxBytes, fetchImpl = globalThis.fetch, timeoutMs = 120_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      throw Object.assign(new Error(`Result download failed with HTTP ${response.status}.`), { code: 'RESULT_DOWNLOAD_FAILED' });
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw Object.assign(new Error('Artifact download exceeded the bounded size.'), { code: 'ARTIFACT_TOO_LARGE' });
    const mime = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 80) || 'application/octet-stream';
    if (!response.body) throw Object.assign(new Error('Artifact download returned no body.'), { code: 'RESULT_DOWNLOAD_FAILED' });
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        throw Object.assign(new Error('Artifact download exceeded the bounded size.'), { code: 'ARTIFACT_TOO_LARGE' });
      }
      chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks), mime };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Artifact download timed out.'), { code: 'RESULT_DOWNLOAD_TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
