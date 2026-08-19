/* global WebSocket, fetch */
// M1 统一 CDP 浏览器测试工具（浏览器基础设施最终收口）。
//
// P20 / P32 / P30 浏览器测试共用的唯一 CDP 工具，提供：
//   1. 主 frame 导航提交的准确等待（Page.frameNavigated 计数；提交后 evaluate
//      必然命中新文档 —— 修复旧文档在提交前仍可被命中导致的时序竞态）；
//   2. 当前文档 URL/origin、document.readyState 与目标 DOM 挂载的有界等待；
//   3. 目标元素存在、可见、未 disabled 且可操作后才点击（单次 evaluate 内
//      完成查找 + 校验 + 点击，避免跨 evaluate 的过期引用）；
//   4. 有界失败诊断：URL、readyState、目标 selector、按钮摘要、正文短片段、
//      最后异常（全部限长，绝不输出无界正文）；
//   5. Edge 主进程及整个进程树（含孤儿 crashpad/utility 子进程）的确定性
//      关闭：taskkill /T /F + 按本次 profile 路径精确兜底清理 + 有界等待；
//   6. 只删除本次创建且路径经过校验的独立临时 profile。

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export function delay(ms) {
  return sleep(ms);
}

/** 有界轮询：条件满足返回其值，超时抛出；检查异常被吞掉并重试（记录最后错误）。 */
export async function waitFor(check, { timeout = 25_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

/** 本地空闲端口（先监听 0 取端口再关闭，无固定 sleep）。 */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---- CDP 客户端（请求/响应 + 事件派发） ----------------------------------------

export class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
      for (const listener of this.listeners) {
        try { listener(message); } catch { /* 监听器异常不破坏连接 */ }
      }
    });
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Browser evaluation failed');
    }
    return response.result?.value;
  }

  close() {
    try { this.socket.close(); } catch { /* noop */ }
  }
}

// ---- 页面事件跟踪（主 frame 导航提交 + 最后异常） -------------------------------

export function createPageTracker(client) {
  const state = {
    mainFrameId: null,
    navigations: [], // { url, at }
    exceptions: 0,
    lastException: null,
  };
  const off = client.onMessage((message) => {
    if (message.method === 'Page.frameNavigated') {
      const { frame } = message.params;
      if (frame.parentId === undefined || frame.parentId === null) {
        state.mainFrameId = frame.id;
        state.navigations.push({ url: frame.url, at: Date.now() });
      }
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      state.exceptions += 1;
      state.lastException = details.exception?.description || details.text || 'unknown';
    }
  });
  return { state, off };
}

async function waitForNavCommit(tracker, before, expectedPrefix, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const committed = tracker.state.navigations.slice(before)
      .find((nav) => !expectedPrefix || nav.url.startsWith(expectedPrefix));
    if (committed) return committed;
    await delay(100);
  }
  const seen = tracker.state.navigations.slice(before);
  throw new Error(
    `Timed out waiting for ${label} (main frame commit); seen ${seen.length} new frameNavigated: `
    + `${seen.map((nav) => nav.url.slice(0, 120)).join(' | ') || '(none)'}`,
  );
}

/** 初始/跨文档导航：发送 Page.navigate，等待主 frame 导航提交，再等新文档就绪。 */
export async function navigateAndWait(client, tracker, url, { timeout = 25_000, label } = {}) {
  const before = tracker.state.navigations.length;
  const result = await client.send('Page.navigate', { url });
  if (result.errorText) throw new Error(`Page.navigate failed (${label || url}): ${result.errorText}`);
  await waitForNavCommit(tracker, before, url, timeout, label ? `${label} navigation` : 'navigation');
  await waitForDocument(client, { readyState: 'complete', urlPrefix: url, timeout, label: label ? `${label} document` : 'document' });
}

/** 硬刷新：发送 Page.reload，先等主 frame 导航提交（旧文档在提交前仍可被
 *  evaluate 命中），再等新文档 readyState=complete。 */
export async function reloadAndWait(client, tracker, { timeout = 25_000, label = 'reload' } = {}) {
  const before = tracker.state.navigations.length;
  await client.send('Page.reload', { ignoreCache: true });
  await waitForNavCommit(tracker, before, undefined, timeout, `${label} navigation commit`);
  await waitForDocument(client, { readyState: 'complete', timeout, label: `${label} document` });
}

/** 当前文档 URL/origin/readyState 的有界等待。 */
export async function waitForDocument(client, { readyState = 'complete', urlPrefix, timeout = 25_000, label = 'document' } = {}) {
  return waitFor(async () => {
    const doc = await client.evaluate(`({ href: location.href, origin: location.origin, readyState: document.readyState })`);
    if (doc.readyState !== readyState) return null;
    if (urlPrefix && !doc.href.startsWith(urlPrefix)) return null;
    return doc;
  }, { timeout, label: `${label} readyState=${readyState}` });
}

// ---- 目标元素等待与点击 ----------------------------------------------------------

function probeExpression(selector, { visible, enabled }) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    if (${visible ? 'true' : 'false'}) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return 'hidden';
    }
    if (${enabled ? 'true' : 'false'}) {
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true' || Boolean(el.closest('[disabled]'))) return 'disabled';
    }
    return 'ready';
  })()`;
}

/** 目标元素存在（可见、未 disabled 视选项）的有界等待；超时带诊断快照。 */
export async function waitForSelector(client, selector, { timeout = 15_000, label = selector, visible = true, enabled = true } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const probe = await client.evaluate(probeExpression(selector, { visible, enabled }));
      if (probe === 'ready') return;
      last = probe;
    } catch (error) {
      last = `evaluate-error: ${String(error.message).slice(0, 200)}`;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label} (last probe: ${last})`);
}

/**
 * 可操作点击：目标元素存在、可见、未 disabled 后才点击；text 与 selector 同时
 * 给出时在 selector 作用域内按文本查找；index 选择第 N 个匹配。单次 evaluate 内
 * 完成 查找 + 校验 + 点击，避免跨 evaluate 的过期引用。
 */
export async function click(client, { selector, text, index = 0, label, timeout = 15_000, visible = true, enabled = true } = {}) {
  if (!selector && !text) throw new Error('click requires selector or text');
  const scope = selector
    ? `[...document.querySelectorAll(${JSON.stringify(selector)})]`
    : `[...document.querySelectorAll('button, [role="button"]')]`;
  const target = text
    ? `${scope}.find((item) => item.textContent.includes(${JSON.stringify(text)}))`
    : `${scope}[${index}] || null`;
  const expression = `(() => {
    const el = ${target};
    if (!el) return 'missing';
    if (${visible ? 'true' : 'false'}) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return 'hidden';
    }
    if (${enabled ? 'true' : 'false'}) {
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true' || Boolean(el.closest('[disabled]'))) return 'disabled';
    }
    el.click();
    return 'clicked';
  })()`;
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const outcome = await client.evaluate(expression);
      if (outcome === 'clicked') return;
      last = outcome;
    } catch (error) {
      last = `evaluate-error: ${String(error.message).slice(0, 200)}`;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting to click ${label || text || selector} (last: ${last})`);
}

/** 有界失败诊断：URL、readyState、目标 selector、按钮摘要、正文短片段、最后异常。 */
export async function captureDiagnostics(client, { selector, label = '', tracker } = {}) {
  try {
    const snapshot = await client.evaluate(`(() => {
      const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null'};
      return {
        href: location.href.slice(0, 200),
        origin: location.origin,
        readyState: document.readyState,
        target: ${selector ? `{ exists: Boolean(target), tag: target?.tagName || null, disabled: target?.disabled ?? null }` : 'null'},
        buttons: [...document.querySelectorAll('button')].slice(0, 8).map((b) => (b.textContent || '').trim().slice(0, 40)).filter(Boolean),
        body: document.body.innerText.slice(0, 300),
      };
    })()`);
    const trackerInfo = tracker
      ? { navigations: tracker.state.navigations.length, lastException: tracker.state.lastException ? String(tracker.state.lastException).slice(0, 300) : null }
      : null;
    return `诊断快照(${label || 'page'}): ${JSON.stringify({ ...snapshot, ...trackerInfo })}`;
  } catch (error) {
    return `诊断快照不可用: ${String(error.message).slice(0, 300)}`;
  }
}

// ---- Edge 启动 / 目标发现 -------------------------------------------------------

/** 启动 Edge headless；profile 为本次独立临时目录（userDataDir 缺省即 profile）。 */
export function launchEdge({ debugPort, profile, userDataDir = profile, extraArgs = [] }) {
  return spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
    ...extraArgs,
  ], { stdio: 'ignore', windowsHide: true });
}

/** 等待 DevTools 出现 page 类型 target（有界）。 */
export async function waitForPageTarget(debugPort, { timeout = 20_000, label = 'Edge DevTools target' } = {}) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) return null;
    return (await response.json()).find((item) => item.type === 'page');
  }, { timeout, label });
}

// ---- 临时 profile（只删除本次创建且路径经过校验的独立目录） ----------------------

// 创建注册表：仅记录本模块 makeTempProfile 创建的精确路径与其有界前缀
// （所有权/身份凭据；伪造路径不可能出现在注册表内）。
const createdProfiles = new Map(); // 解析后路径 -> { prefix, basename }
// mkdtemp 的 6 字符随机后缀（固定有界）。
const TEMP_SUFFIX_RE = /^[A-Za-z0-9]{6}$/;

export async function makeTempProfile(prefix) {
  const profile = await mkdtemp(join(tmpdir(), prefix));
  const root = resolve(tmpdir());
  const resolved = resolve(profile);
  const name = basename(resolved);
  const suffix = name.slice(prefix.length);
  if (dirname(resolved) !== root || !name.startsWith(prefix)
    || suffix.length !== 6 || !TEMP_SUFFIX_RE.test(suffix)) {
    throw new Error(`临时 profile 路径校验失败: ${profile}`);
  }
  createdProfiles.set(resolved, { prefix, basename: name });
  return resolved;
}

export async function removeTempProfile(profile) {
  if (typeof profile !== 'string' || profile.length === 0) {
    throw new Error(`拒绝删除未通过校验的路径: ${String(profile)}`);
  }
  // 路径穿越（/.. 与 \..、. 段）一律拒绝；解析前先拒绝，解析后靠直接包含校验兜底。
  const segments = profile.split(/[\\/]+/);
  if (segments.includes('..') || segments.includes('.')) {
    throw new Error(`拒绝删除含路径穿越的路径: ${profile}`);
  }
  const root = resolve(tmpdir());
  const resolved = resolve(profile);
  const name = basename(resolved);
  const record = createdProfiles.get(resolved);
  if (!record) {
    throw new Error(`拒绝删除非本测试创建的路径: ${resolved}`);
  }
  // 直接包含：必须是临时根的直接子目录（解析后精确相等），不允许中间层/越界。
  if (dirname(resolved) !== root) {
    throw new Error(`拒绝删除不在临时根直接子目录的路径: ${resolved}`);
  }
  // 精确有界 basename：与创建时记录完全一致（前缀 + 6 字符 mkdtemp 后缀）。
  const suffix = name.slice(record.prefix.length);
  if (name !== record.basename || !name.startsWith(record.prefix)
    || suffix.length !== 6 || !TEMP_SUFFIX_RE.test(suffix)) {
    throw new Error(`拒绝删除前缀/身份不符的路径: ${resolved}`);
  }
  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') { createdProfiles.delete(resolved); return; }
    throw error;
  }
  // 符号链接/junction 等重解析歧义一律拒绝（只删真实目录本身）。
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`拒绝删除符号链接/非目录路径: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  createdProfiles.delete(resolved);
}

// ---- Edge 进程树确定性关闭 ------------------------------------------------------

function runTaskKill(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('close', () => resolve());
    killer.once('error', () => resolve());
  });
}

/** 主进程及其直接进程树：taskkill /T /F 后等待真实退出（有界）。 */
export async function killProcessTree(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await runTaskKill(child.pid);
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, {
    timeout: 8_000, interval: 50, label: `process ${child.pid} tree exit`,
  });
}

const POWERSHELL_EDGE_SCRIPT = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`;

function runPowerShell(script) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', () => resolve({ stdout, stderr }));
    child.on('error', (error) => resolve({ stdout: '', stderr: String(error) }));
  });
}

/** 当前全部 msedge.exe 进程（PID + 命令行），供前后对比与精确兜底清理。 */
export async function edgeProcesses() {
  const { stdout, stderr } = await runPowerShell(POWERSHELL_EDGE_SCRIPT);
  if (!stdout && stderr) throw new Error(`无法枚举 Edge 进程: ${stderr.slice(0, 300)}`);
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const pid = Number(line.slice(0, tab));
    return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, commandLine: line.slice(tab + 1) };
  }).filter((item) => item.pid !== null);
}

/** 按本次 profile 路径匹配的 Edge 进程（命令行包含 profile 即属于本次）。 */
export function matchByProfile(profile) {
  return (entry) => entry.commandLine.includes(profile);
}

/** 精确兜底清理：按 profile 路径匹配并杀死残留（孤儿 crashpad/utility 等）。 */
export async function killEdgeProcessesMatching(match) {
  const targets = (await edgeProcesses()).filter(match);
  for (const target of targets) await runTaskKill(target.pid);
  return targets;
}

/** 有界等待：本次 profile 相关的 Edge 进程零残留。 */
export async function waitForNoEdgeProcesses(match, { timeout = 10_000 } = {}) {
  await waitFor(async () => (await edgeProcesses()).filter(match).length === 0, {
    timeout, interval: 500, label: 'no residual Edge processes',
  });
}

/** 确定性关闭：主进程树 + 孤儿子进程兜底 + 零残留等待（P30/P20/P32 统一出口）。 */
export async function shutdownEdge(edgeChild, profile, { timeout = 10_000 } = {}) {
  await killProcessTree(edgeChild);
  await killEdgeProcessesMatching(matchByProfile(profile));
  await waitForNoEdgeProcesses(matchByProfile(profile), { timeout });
}

// ---- dump-dom（P30 静态渲染路径） ------------------------------------------------

/** 以 --dump-dom 渲染页面并返回 stdout；进程树确定性退出，超时即强杀并报错。 */
export async function dumpDom(url, { width, height, profile, timeoutMs = 30_000 } = {}) {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-setuid-sandbox',
    `--user-data-dir=${join(profile, 'user-data')}`,
    `--window-size=${width},${height}`,
    '--virtual-time-budget=2000', '--dump-dom',
    url,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let stderr = '';
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child).catch(() => {});
  }, timeoutMs);
  return new Promise((resolve, reject) => {
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`dump-dom 超时（${timeoutMs}ms）: ${stderr.slice(-500)}`));
      else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr });
    });
  });
}
