// G1 验收 #3：Bailian 适配器对确定性 fake HTTP server 的全部行为。
//
// 覆盖：image（qwen-image-2.0 同步契约：端到端/无 async 头/精确 body/画幅
// 显式 size/同步结果解析）、t2v / i2v 提交（异步契约不变）、明确拒绝（4xx
// 永久请求契约失败，单次尝试）、网络/5xx/超时/无效响应/结果集不符
// （ambiguous，绝不自动重试）、轮询（PENDING→RUNNING→SUCCEEDED、FAILED、
// CANCELED、未知状态）、有界下载（超限即失败，绝不静默截断）、MIME 捕获、
// SHA-256、脱敏诊断（绝不泄漏 Authorization/密钥形态）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers';
import {
  ASPECT_RATIO_TO_SIZE,
  SUPPORTED_VIDEO_RESOLUTIONS,
  TASK_STATUS_CANCELED,
  TASK_STATUS_FAILED,
  TASK_STATUS_PENDING,
  TASK_STATUS_RUNNING,
  TASK_STATUS_SUCCEEDED,
  VIDEO_RESOLUTION_TO_PROVIDER,
  downloadResult,
  pollTask,
  resolveImageSize,
  resolveVideoResolution,
  sanitizeDiagnostics,
  sha256Buffer,
  sha256Hex,
  submitImage,
  submitVideo,
} from '../services/generation-worker/bailian-adapter.mjs';

const API_KEY = 'sk-test-provider-key-0123456789';

/** DashScope 同步生图成功响应（与 staging 契约一致的有界示例）。 */
const SYNC_IMAGE_PAYLOAD = {
  output: {
    choices: [{
      message: { role: 'assistant', content: [{ text: '一张猫图' }, { image: 'https://provider.example/result/sync.png' }] },
    }],
  },
  request_id: 'req-sync-001',
  usage: { input_tokens: 12, output_tokens: 88, total_tokens: 100 },
};

function startFakeProvider(handler) {
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const result = await handler({
        method: request.method,
        url: request.url,
        headers: request.headers,
        authorization: request.headers.authorization || '',
        body,
      });
      response.writeHead(result.status, { 'content-type': result.contentType || 'application/json' });
      response.end(result.body);
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{}');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function jsonResponse(status, payload) {
  return { status, contentType: 'application/json', body: JSON.stringify(payload) };
}

/** 视频异步提交成功响应（保持既有异步契约不变）。 */
function successTask(body) {
  const parsed = JSON.parse(body);
  const model = parsed.model || 'unknown';
  const kind = parsed.input && 'img_url' in parsed.input ? 'i2v' : 't2v';
  return jsonResponse(200, {
    output: { task_id: `task-${kind}-${model}`, task_status: 'PENDING' },
    request_id: 'req-1',
  });
}

test('image 同步提交：精确端到端契约（端点/无 async 头/input.messages/parameters，绝无遗留顶层字段）', async () => {
  let seen;
  const { server, base } = await startFakeProvider(async (request) => {
    if (request.method === 'POST' && request.url.includes('multimodal-generation/generation')) {
      seen = { headers: request.headers, authorization: request.authorization, body: request.body };
      return jsonResponse(200, SYNC_IMAGE_PAYLOAD);
    }
    return jsonResponse(404, {});
  });
  try {
    const result = await submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: '猫', negativePrompt: '模糊', aspectRatio: '1:1', baseUrl: base });
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.url, 'https://provider.example/result/sync.png');
    assert.equal(result.request_id, 'req-sync-001');
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 88, total_tokens: 100 });
    const body = JSON.parse(seen.body);
    assert.equal(body.model, 'qwen-image-2.0');
    assert.deepEqual(body.input, { messages: [{ role: 'user', content: [{ text: '猫' }] }] }, 'input.messages 必须精确');
    assert.deepEqual(body.parameters, { negative_prompt: '模糊', size: '1024*1024', n: 1, prompt_extend: true, watermark: false }, 'parameters 必须精确');
    // 绝对没有遗留异步字段。
    assert.equal(body.prompt, undefined, '不得携带遗留顶层 prompt');
    assert.equal(body.aspect_ratio, undefined, '不得携带遗留顶层 aspect_ratio');
    assert.equal(body.negative_prompt, undefined, '负面提示词只允许在 parameters 内');
    assert.equal(body.n, undefined, 'n 只允许在 parameters 内');
    // 无 async 头 + Bearer 认证。
    assert.equal(seen.headers['x-dashscope-async'], undefined, '同步契约绝不携带 X-DashScope-Async');
    assert.match(seen.authorization, /^Bearer sk-test/);
  } finally {
    await closeServer(server);
  }
});

test('t2v/i2v 异步契约不变：仍携带 X-DashScope-Async 与 task id 提交', async () => {
  const seen = [];
  const { server, base } = await startFakeProvider(async (request) => {
    if (request.method === 'POST' && request.url.includes('video-synthesis')) {
      seen.push({ headers: request.headers, body: JSON.parse(request.body) });
      return successTask(request.body);
    }
    return jsonResponse(404, {});
  });
  try {
    const t2v = await submitVideo({ apiKey: API_KEY, model: 'happyhorse-1.0-t2v', prompt: '海边日落', durationSeconds: 5, resolution: '720p', baseUrl: base });
    assert.equal(t2v.outcome, 'submitted');
    assert.equal(t2v.task_id, 'task-t2v-happyhorse-1.0-t2v');
    assert.equal(seen[0].body.model, 'happyhorse-1.0-t2v');
    assert.equal(seen[0].body.input.prompt, '海边日落');
    assert.equal(seen[0].body.input.img_url, undefined);
    assert.equal(seen[0].body.parameters.resolution, '720P', '视频边界必须把内部 720p 归一为线上精确 720P');
    assert.equal(seen[0].body.parameters.duration_seconds, 5);
    assert.equal(seen[0].headers['x-dashscope-async'], 'enable', '视频异步契约必须携带 X-DashScope-Async');
    const t2v1080 = await submitVideo({ apiKey: API_KEY, model: 'happyhorse-1.0-t2v', prompt: '海边日落', durationSeconds: 5, resolution: '1080p', baseUrl: base });
    assert.equal(t2v1080.task_id, 'task-t2v-happyhorse-1.0-t2v');
    assert.equal(seen[1].body.parameters.resolution, '1080P', '视频边界必须把内部 1080p 归一为线上精确 1080P');
    const i2v = await submitVideo({ apiKey: API_KEY, model: 'happyhorse-1.0-i2v', prompt: '参考图', imgUrl: 'https://storage.example/ref.png', resolution: '720p', baseUrl: base });
    assert.equal(i2v.task_id, 'task-i2v-happyhorse-1.0-i2v');
    assert.equal(seen[2].body.input.img_url, 'https://storage.example/ref.png');
    assert.equal(seen[2].body.input.prompt, '参考图');
  } finally {
    await closeServer(server);
  }
});

test('视频分辨率边界归一：720p→720P / 1080p→1080P；缺失/畸形/混合/未批准零 HTTP 调用', async () => {
  assert.deepEqual(VIDEO_RESOLUTION_TO_PROVIDER, { '720p': '720P', '1080p': '1080P' });
  assert.deepEqual(SUPPORTED_VIDEO_RESOLUTIONS, ['720p', '1080p']);
  assert.equal(resolveVideoResolution('720p'), '720P');
  assert.equal(resolveVideoResolution('1080p'), '1080P');
  assert.equal(resolveVideoResolution('720P'), null, '线上形态不是内部契约输入，必须拒绝（绝不猜测）');
  assert.equal(resolveVideoResolution('1080P'), null);
  assert.equal(resolveVideoResolution('4k'), null);
  assert.equal(resolveVideoResolution(''), null);

  // 缺失/畸形/混合/未批准值：零 provider 调用 + 有界诊断 + 显式不可重试。
  const calls = [];
  for (const bad of [undefined, null, '', '720P', '1080P', '4k', '720p ', ' 720p', '720P/1080P', 'banana', 720]) {
    await assert.rejects(
      submitVideo({
        apiKey: API_KEY, model: 'happyhorse-1.0-t2v', prompt: 'x', resolution: bad,
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () => { calls.push(String(bad)); throw new Error('must not be called'); },
      }),
      (error) => error?.code === 'VIDEO_RESOLUTION_UNSUPPORTED' && error?.ambiguous === false
        && /allowed: 720p, 1080p/.test(error.message),
      `视频分辨率 ${JSON.stringify(bad)} 必须在任何 provider 调用前本地失败`,
    );
  }
  assert.equal(calls.length, 0, '分辨率校验失败必须零 HTTP 调用');

  // 图片契约绝不改动：submitImage 不接受/不校验 resolution 参数（无此字段）。
  const { server, base } = await startFakeProvider(async (request) => {
    if (request.method === 'POST' && request.url.includes('multimodal-generation/generation')) {
      return jsonResponse(200, SYNC_IMAGE_PAYLOAD);
    }
    return jsonResponse(404, {});
  });
  try {
    const image = await submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base });
    assert.equal(image.outcome, 'succeeded', '图片契约必须保持不变');
  } finally {
    await closeServer(server);
  }
});

test('终态轮询诊断：有界保留 provider_code/provider_message；畸形/泄密形状 fail-closed', async () => {
  // FAILED + 有界 code/message → 精确保留（与 staging 实测一致）。
  const { server: failServer, base: failBase } = await startFakeProvider(async () => (
    jsonResponse(200, {
      output: {
        task_status: TASK_STATUS_FAILED,
        code: 'InvalidParameter',
        message: "Input should be '1080P' or '720P': parameters.resolution",
      },
      request_id: 'req-fail-1',
    })
  ));
  try {
    const failed = await pollTask({ apiKey: API_KEY, taskId: 'task-fail', baseUrl: failBase });
    assert.equal(failed.status, TASK_STATUS_FAILED);
    assert.equal(failed.provider_code, 'InvalidParameter', '终态必须保留有界 provider_code');
    assert.equal(failed.provider_message, "Input should be '1080P' or '720P': parameters.resolution", '终态必须保留脱敏 provider_message');
    assert.equal(failed.request_id, 'req-fail-1', '终态必须保留血缘 request id');
  } finally {
    await closeServer(failServer);
  }

  // CANCELED + code → 同样保留。
  const { server: cancelServer, base: cancelBase } = await startFakeProvider(async () => (
    jsonResponse(200, { output: { task_status: TASK_STATUS_CANCELED, code: 'TaskCanceled', message: '任务已取消' } })
  ));
  try {
    const canceled = await pollTask({ apiKey: API_KEY, taskId: 'task-cancel', baseUrl: cancelBase });
    assert.equal(canceled.status, TASK_STATUS_CANCELED);
    assert.equal(canceled.provider_code, 'TaskCanceled');
    assert.equal(canceled.provider_message, '任务已取消');
  } finally {
    await closeServer(cancelServer);
  }

  // 非终态：绝不携带诊断。
  const { server: runServer, base: runBase } = await startFakeProvider(async () => (
    jsonResponse(200, { output: { task_status: TASK_STATUS_RUNNING, code: 'X', message: 'Y' } })
  ));
  try {
    const running = await pollTask({ apiKey: API_KEY, taskId: 'task-run', baseUrl: runBase });
    assert.equal(running.status, TASK_STATUS_RUNNING);
    assert.equal(running.provider_code, null, '非终态绝不透传诊断');
    assert.equal(running.provider_message, null);
  } finally {
    await closeServer(runServer);
  }

  // 畸形/超限/泄密形状 → fail-closed：超限 message 截断、泄密形态脱敏、
  // 非字符串/超长 code 置 null，绝不透传 raw 载荷。
  const secretMessage = 'Authorization: Bearer sk-terminal-leak-0123456789, 生成失败';
  const { server: malServer, base: malBase } = await startFakeProvider(async () => (
    jsonResponse(200, {
      output: {
        task_status: TASK_STATUS_FAILED,
        code: 'x'.repeat(200),
        message: `${secretMessage}${'x'.repeat(1000)}`,
      },
      request_id: 'req-mal-1',
    })
  ));
  try {
    const malformed = await pollTask({ apiKey: API_KEY, taskId: 'task-mal', baseUrl: malBase });
    assert.equal(malformed.status, TASK_STATUS_FAILED);
    assert.equal(malformed.provider_code, null, '超长 code 必须 fail-closed 为 null');
    assert.doesNotMatch(malformed.provider_message, /sk-terminal-leak/, '泄密形态必须脱敏');
    assert.doesNotMatch(malformed.provider_message, /Bearer sk-terminal/, 'Authorization 值必须脱敏');
    assert.ok(malformed.provider_message.length <= 241, 'message 必须被有界截断');
  } finally {
    await closeServer(malServer);
  }
});

test('画幅 → Qwen-Image size：全部批准画幅显式映射；畸形/未批准零 HTTP 调用', async () => {
  assert.deepEqual(ASPECT_RATIO_TO_SIZE, {
    '1:1': '1024*1024', '4:3': '1152*864', '3:4': '864*1152',
    '16:9': '1280*720', '9:16': '720*1280', '21:9': '1344*576',
  });
  const seen = [];
  const { server, base } = await startFakeProvider(async (request) => {
    if (request.method === 'POST') {
      seen.push(JSON.parse(request.body));
      return jsonResponse(200, SYNC_IMAGE_PAYLOAD);
    }
    return jsonResponse(404, {});
  });
  try {
    for (const [ratio, size] of Object.entries(ASPECT_RATIO_TO_SIZE)) {
      const result = await submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', aspectRatio: ratio, baseUrl: base });
      assert.equal(result.outcome, 'succeeded');
      assert.equal(seen.at(-1).parameters.size, size, `${ratio} 必须显式映射为 ${size}`);
      assert.equal(seen.at(-1).parameters.n, 1);
      assert.equal(resolveImageSize(ratio), size);
    }
    const defaulted = await submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base });
    assert.equal(defaulted.outcome, 'succeeded');
    assert.equal(seen.at(-1).parameters.size, '1024*1024', '省略画幅必须使用批准的 1:1 默认值');
    assert.equal(seen.length, 7, '全部批准画幅及省略画幅各恰好一次提交');
  } finally {
    await closeServer(server);
  }

  // 畸形/未批准画幅：必须零 HTTP 调用 + 有界诊断 + 显式不可重试标记。
  const calls = [];
  for (const bad of ['2:3', '16:10', '1.5:1', '', 'banana', '16:9:2', null]) {
    await assert.rejects(
      submitImage({
        apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', aspectRatio: bad,
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () => { calls.push(String(bad)); throw new Error('must not be called'); },
      }),
      (error) => error?.code === 'ASPECT_RATIO_UNSUPPORTED' && error?.ambiguous === false
        && /allowed: 1:1, 4:3, 3:4, 16:9, 9:16, 21:9/.test(error.message),
      `未批准画幅 ${JSON.stringify(bad)} 必须在任何 provider 调用前本地失败`,
    );
  }
  assert.equal(calls.length, 0, '画幅校验失败必须零 HTTP 调用');
});

test('同步结果解析：恰好一个有界 image（n=1）；request_id/usage 有界保留', async () => {
  // 恰好一个 image（含伴生 text 条目）→ 成功，且 usage 有界保留。
  const { server: okServer, base: okBase } = await startFakeProvider(async () => jsonResponse(200, SYNC_IMAGE_PAYLOAD));
  try {
    const result = await submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: okBase });
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.url, 'https://provider.example/result/sync.png');
    assert.equal(result.request_id, 'req-sync-001');
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 88, total_tokens: 100 });
  } finally {
    await closeServer(okServer);
  }

  // 结果集不符（零 image / 两个 image / 非 http URL / 缺 choices / 缺
  // request id）→ PROVIDER_RESPONSE_INVALID，ambiguous=true。
  const badPayloads = [
    ['no-image', { output: { choices: [{ message: { content: [{ text: '只有文字' }] } }] }, request_id: 'r1' }],
    ['two-images', { output: { choices: [{ message: { content: [{ image: 'https://a/1.png' }, { image: 'https://a/2.png' }] } }] }, request_id: 'r1' }],
    ['two-images-across-choices', { output: { choices: [
      { message: { content: [{ image: 'https://a/1.png' }] } },
      { message: { content: [{ image: 'https://a/2.png' }] } },
    ] }, request_id: 'r1' }],
    ['bad-scheme', { output: { choices: [{ message: { content: [{ image: 'ftp://a/1.png' }] } }] }, request_id: 'r1' }],
    ['oversized-url', { output: { choices: [{ message: { content: [{ image: `https://a/${'x'.repeat(500)}` }] } }] }, request_id: 'r1' }],
    ['no-choices', { output: {}, request_id: 'r1' }],
    ['no-request-id', { output: { choices: [{ message: { content: [{ image: 'https://a/1.png' }] } }] } }],
    ['oversized-request-id', { output: { choices: [{ message: { content: [{ image: 'https://a/1.png' }] } }] }, request_id: 'r'.repeat(201) }],
  ];
  for (const [label, payload] of badPayloads) {
    const { server, base } = await startFakeProvider(async () => jsonResponse(200, payload));
    try {
      await assert.rejects(
        submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base }),
        (error) => error?.code === 'PROVIDER_RESPONSE_INVALID' && error?.ambiguous === true,
        `${label} 必须按歧义响应失败`,
      );
    } finally {
      await closeServer(server);
    }
  }

  // usage 有界：非法值被丢弃，绝不透传畸形元数据。
  const { server: uServer, base: uBase } = await startFakeProvider(async () => jsonResponse(200, {
    output: { choices: [{ message: { content: [{ image: 'https://a/1.png' }] } }] },
    request_id: 'r2',
    usage: { total_tokens: 100, input_tokens: -1, output_tokens: 'many' },
  }));
  try {
    const result = await submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: uBase });
    assert.deepEqual(result.usage, { total_tokens: 100 }, '非法 usage 值必须被有界丢弃');
  } finally {
    await closeServer(uServer);
  }
});

test('明确拒绝（4xx 业务错误）：PROVIDER_REJECTED（永久请求契约失败，单次尝试）', async () => {
  const { server, base } = await startFakeProvider(async () => (
    jsonResponse(400, { code: 'InvalidParameter', message: 'prompt 包含禁用词' })
  ));
  try {
    await assert.rejects(
      submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base }),
      (error) => error?.code === 'PROVIDER_REJECTED' && /禁用词/.test(error.message),
    );
  } finally {
    await closeServer(server);
  }
});

test('显式分类契约：4xx 拒绝 ambiguous=false（单次收口）；其余全部 ambiguous=true', async () => {
  // 确定性 4xx 拒绝 → 显式 ambiguous=false。
  const { server: rejectServer, base: rejectBase } = await startFakeProvider(async () => (
    jsonResponse(400, { code: 'InvalidParameter', message: 'prompt 包含禁用词' })
  ));
  try {
    await assert.rejects(
      submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: rejectBase }),
      (error) => error?.code === 'PROVIDER_REJECTED' && error?.ambiguous === false,
    );
  } finally {
    await closeServer(rejectServer);
  }

  // 每个无法证明结果的方向都必须显式 ambiguous=true：5xx、网络、超时、
  // 无效响应、缺 request id、超限响应、轮询未知状态。
  const scenarios = [];
  {
    const { server, base } = await startFakeProvider(async () => jsonResponse(503, { message: 'upstream busy' }));
    scenarios.push(['5xx', () => submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base }), () => closeServer(server)]);
  }
  {
    // fake server 会把 handler 抛错转成 500（5xx 路径）；网络失败必须注入
    // 确定性拒绝的 fetchImpl 才能精确覆盖 PROVIDER_NETWORK 分类。
    scenarios.push(['network', () => submitImage({
      apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    }), () => Promise.resolve()]);
  }
  {
    const { server, base } = await startFakeProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return jsonResponse(200, {});
    });
    scenarios.push(['timeout', () => submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base, timeoutMs: 50 }), () => closeServer(server)]);
  }
  {
    const { server, base } = await startFakeProvider(async () => jsonResponse(200, 'not json at all'));
    scenarios.push(['invalid-response', () => submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base }), () => closeServer(server)]);
  }
  {
    // 200 但没有同步 choices → 缺有界结果集（同步契约无 request id 通道）。
    const { server, base } = await startFakeProvider(async () => jsonResponse(200, { output: { task_status: 'PENDING' } }));
    scenarios.push(['missing-result-set', () => submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base }), () => closeServer(server)]);
  }
  {
    // 正文真正超过 1 MiB 有界上限（10KB 小响应只会命中无效结果集分类）。
    const { server, base } = await startFakeProvider(async () => (
      { status: 200, contentType: 'application/json', body: JSON.stringify({ output: { task_id: 'x'.repeat(1024 * 1024 + 1) } }) }
    ));
    scenarios.push(['oversize-response', () => submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base }), () => closeServer(server)]);
  }
  {
    const { server, base } = await startFakeProvider(async () => jsonResponse(200, { output: { task_status: 'MYSTERIOUS' } }));
    scenarios.push(['unknown-poll-status', () => pollTask({ apiKey: API_KEY, taskId: 'task-x', baseUrl: base }), () => closeServer(server)]);
  }
  for (const [label, act, close] of scenarios) {
    try {
      await assert.rejects(
        act(),
        (error) => error?.ambiguous === true,
        `${label} 必须显式标记 ambiguous=true`,
      );
    } finally {
      await close();
    }
  }
});

test('5xx / 网络失败 / 超时 / 无效响应：全部 ambiguous（绝不自动重试）', async () => {
  const { server, base } = await startFakeProvider(async () => jsonResponse(503, { message: 'upstream busy' }));
  try {
    await assert.rejects(
      submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: base }),
      (error) => error?.code === 'PROVIDER_HTTP_5XX' && error?.ambiguous === true,
    );
  } finally {
    await closeServer(server);
  }

  // 网络失败：fake HTTP server 会捕获 handler 抛错并回 500（那是 5xx 而不是
  // 网络失败），所以注入确定性拒绝的 fetchImpl 精确覆盖网络路径。
  await assert.rejects(
    submitImage({
      apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    }),
    (error) => error?.code === 'PROVIDER_NETWORK' && error?.ambiguous === true,
  );

  // 超时：provider 慢响应 → PROVIDER_TIMEOUT（客户端 50ms 超时，服务端 1s 后
  // 才返回；超时结果视为 ambiguous）。
  const { server: slowServer, base: slowBase } = await startFakeProvider(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return jsonResponse(200, {});
  });
  try {
    await assert.rejects(
      submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: slowBase, timeoutMs: 50 }),
      (error) => error?.code === 'PROVIDER_TIMEOUT' && error?.ambiguous === true,
    );
  } finally {
    await closeServer(slowServer);
  }

  // 成功响应但没有同步结果集 → 响应无效 → ambiguous。
  const { server: noTaskServer, base: noTaskBase } = await startFakeProvider(async () => (
    jsonResponse(200, { output: { task_status: 'PENDING' } })
  ));
  try {
    await assert.rejects(
      submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: noTaskBase }),
      (error) => error?.code === 'PROVIDER_RESPONSE_INVALID' && error?.ambiguous === true,
    );
  } finally {
    await closeServer(noTaskServer);
  }

  // 响应超过有界上限（>1 MiB 正文，绝非 10KB 小响应）→ 失败（绝不静默截断）。
  const { server: bigServer, base: bigBase } = await startFakeProvider(async () => (
    { status: 200, contentType: 'application/json', body: JSON.stringify({ output: { task_id: 'x'.repeat(1024 * 1024 + 1) } }) }
  ));
  try {
    await assert.rejects(
      submitImage({ apiKey: API_KEY, model: 'qwen-image-2.0', prompt: 'x', baseUrl: bigBase }),
      (error) => error?.code === 'PROVIDER_RESPONSE_TOO_LARGE' && error?.ambiguous === true,
    );
  } finally {
    await closeServer(bigServer);
  }
});

test('轮询：PENDING→RUNNING→SUCCEEDED 推进；FAILED/CANCELED/未知状态被识别', async () => {
  let pollCount = 0;
  const { server, base } = await startFakeProvider(async (request) => {
    if (request.method === 'GET' && request.url.includes('/tasks/')) {
      pollCount += 1;
      if (pollCount === 1) return jsonResponse(200, { output: { task_status: TASK_STATUS_PENDING } });
      if (pollCount === 2) return jsonResponse(200, { output: { task_status: TASK_STATUS_RUNNING } });
      return jsonResponse(200, { output: { task_status: TASK_STATUS_SUCCEEDED, results: [{ url: `${base}/result.png` }] } });
    }
    return jsonResponse(404, {});
  });
  try {
    const first = await pollTask({ apiKey: API_KEY, taskId: 'task-1', baseUrl: base });
    assert.equal(first.status, TASK_STATUS_PENDING);
    const second = await pollTask({ apiKey: API_KEY, taskId: 'task-1', baseUrl: base });
    assert.equal(second.status, TASK_STATUS_RUNNING);
    const third = await pollTask({ apiKey: API_KEY, taskId: 'task-1', baseUrl: base });
    assert.equal(third.status, TASK_STATUS_SUCCEEDED);
    assert.equal(third.results[0].url, `${base}/result.png`);
  } finally {
    await closeServer(server);
  }

  for (const terminal of [TASK_STATUS_FAILED, TASK_STATUS_CANCELED]) {
    const { server: tServer, base: tBase } = await startFakeProvider(async () => (
      jsonResponse(200, { output: { task_status: terminal } })
    ));
    try {
      const result = await pollTask({ apiKey: API_KEY, taskId: 'task-x', baseUrl: tBase });
      assert.equal(result.status, terminal);
    } finally {
      await closeServer(tServer);
    }
  }

  const { server: uServer, base: uBase } = await startFakeProvider(async () => (
    jsonResponse(200, { output: { task_status: 'MYSTERIOUS' } })
  ));
  try {
    await assert.rejects(
      pollTask({ apiKey: API_KEY, taskId: 'task-x', baseUrl: uBase }),
      (error) => error?.code === 'PROVIDER_RESPONSE_INVALID',
    );
  } finally {
    await closeServer(uServer);
  }
});

test('轮询成功兼容 output.video_url：保留完整签名 URL、去重且拒绝非 HTTP(S)', async () => {
  const signedUrl = 'https://provider.example/video.mp4?signature=' + 'a'.repeat(300);
  const { server, base } = await startFakeProvider(async () => (
    jsonResponse(200, {
      output: {
        task_status: TASK_STATUS_SUCCEEDED,
        results: [
          { url: signedUrl },
          { url: 'file:///tmp/not-allowed.mp4' },
        ],
        video_url: signedUrl,
      },
      request_id: 'req-video-url-1',
    })
  ));
  try {
    const result = await pollTask({ apiKey: API_KEY, taskId: 'task-video-url', baseUrl: base });
    assert.equal(result.status, TASK_STATUS_SUCCEEDED);
    assert.deepEqual(result.results, [{ url: signedUrl }], '两种 Provider 形状必须去重并完整保留签名 URL');
    assert.equal(result.request_id, 'req-video-url-1');
  } finally {
    await closeServer(server);
  }

  const { server: directServer, base: directBase } = await startFakeProvider(async () => (
    jsonResponse(200, { output: { task_status: TASK_STATUS_SUCCEEDED, video_url: signedUrl } })
  ));
  try {
    const direct = await pollTask({ apiKey: API_KEY, taskId: 'task-direct-video-url', baseUrl: directBase });
    assert.deepEqual(direct.results, [{ url: signedUrl }], '仅有 output.video_url 时仍必须得到可下载产物');
  } finally {
    await closeServer(directServer);
  }
});

test('下载：有界大小、MIME 捕获、SHA-256 校验（超限即失败）', async () => {
  const content = Buffer.from('fake-image-bytes');
  const { server, base } = await startFakeProvider(async (request) => {
    if (request.method === 'GET' && request.url.includes('result.png')) {
      return { status: 200, contentType: 'image/png', body: content.toString('binary') };
    }
    return jsonResponse(404, {});
  });
  try {
    const downloaded = await downloadResult({ url: `${base}/result.png`, maxBytes: 1024 });
    assert.equal(downloaded.mime, 'image/png');
    assert.equal(sha256Buffer(downloaded.buffer), sha256Hex('fake-image-bytes'));
    assert.deepEqual(downloaded.buffer, content);
    await assert.rejects(
      downloadResult({ url: `${base}/result.png`, maxBytes: 4 }),
      (error) => error?.code === 'ARTIFACT_TOO_LARGE',
    );
  } finally {
    await closeServer(server);
  }
});

test('脱敏诊断：绝不包含 Authorization/密钥形态；有界长度', () => {
  const raw = 'Authorization: Bearer sk-test-provider-key-0123456789, api_key=AKLT-secret-value, 常规错误文案';
  const sanitized = sanitizeDiagnostics(raw, 4096);
  assert.doesNotMatch(sanitized, /Bearer sk-test/, 'Authorization 值必须脱敏');
  assert.doesNotMatch(sanitized, /AKLT-secret-value/, 'AK 密钥形态必须脱敏');
  assert.match(sanitized, /常规错误文案/);
  assert.ok(sanitized.length <= 4096);
  const truncated = sanitizeDiagnostics('x'.repeat(10000), 100);
  assert.equal(truncated.length, 101, '诊断必须被有界截断');
  // 绝不返回原始 API key。
  assert.doesNotMatch(sanitizeDiagnostics(API_KEY, 4096), /sk-test-provider-key/);
});
