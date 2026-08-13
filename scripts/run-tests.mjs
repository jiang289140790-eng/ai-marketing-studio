#!/usr/bin/env node
// M1 工程基线：确定性完整测试调度器（npm test 的默认入口）。
//
// 问题背景：`node --test test/*.test.mjs` 把所有测试文件并发跑在同一 runner
// 里；多个真实 Edge 浏览器测试会同时 rm -rf dist/ + vite build / 启动
// vite dev/preview / 拉起 Edge headless，在 Windows 上互相争抢产生 EBUSY、
// renderer 崩溃和超时假失败（串行运行全部通过）。
//
// 本调度器：
//   - 枚举 test/*.test.mjs 全量集合（排序，确定性），全部执行，绝不默认跳过；
//   - 「浏览器/构建类」测试文件（源码含 msedge.exe / vite.js / npm run dev）
//     逐个串行执行，每个文件独立进程、独立资源；
//   - 其余普通测试并行执行（每个文件独立进程，池化并发），与历史行为等价；
//   - 输出每个文件的 pass/fail/skip 计数矩阵，漏跑即失败；
//   - 任一文件失败 → 退出码 1；
//   - 子进程超时或退出时确定性清理其整个进程树（Windows 上 SIGKILL 只杀
//     直接子进程，浏览器测试拉起的 Edge/vite 进程树会残留并污染下一测试），
//     不得通过整文件重试获得绿色。
//
// 环境变量：TEST_SERIAL=1 时全部串行（仅调试用，默认仍为并行 + 浏览器串行）。

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { killProcessTree } from '../test/helpers/cdp-browser-harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const TEST_DIR = join(ROOT, 'test');
const NODE = process.execPath;
const PER_FILE_TIMEOUT_MS = 40 * 60 * 1000; // 单文件安全上限（测试自带超时远小于此）

/** 浏览器/构建类：源码引用 Edge 可执行文件、vite.js 或 npm run dev。 */
function isBrowserClass(source) {
  return /msedge\.exe|vite\.js|npm run dev/i.test(source);
}

/** 运行单个 node --test 进程并解析 TAP 汇总。 */
function runOne(file, { serial }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(NODE, ['--test', '--test-reporter=tap', file], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      // 确定性清理整个进程树（含测试文件拉起的 Edge/vite 子树），
      // 兜底再 SIGKILL 直接子进程；不重试、不跳过，只记录失败。
      killProcessTree(child).catch(() => child.kill('SIGKILL'));
    }, PER_FILE_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tail = stdout.split('\n').filter((line) => /^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line));
      const summary = {};
      for (const line of tail) {
        const match = line.match(/^# (\w+) (\d+)/);
        if (match) summary[match[1]] = Number(match[2]);
      }
      resolve({
        file,
        serial,
        code,
        signal,
        summary,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

function formatSummary(summary) {
  return `tests=${summary.tests ?? '?'} pass=${summary.pass ?? '?'} fail=${summary.fail ?? '?'} skipped=${summary.skipped ?? '?'} todo=${summary.todo ?? '?'}`;
}

async function runPool(files, { concurrency, serial }) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      results.push(await runOne(file, { serial }));
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, files.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const discovered = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();

  const classified = discovered.map((name) => {
    const source = readFileSync(join(TEST_DIR, name), 'utf8');
    return { name, serialClass: isBrowserClass(source) };
  });
  const serialFiles = classified.filter((entry) => entry.serialClass).map((entry) => entry.name);
  const parallelFiles = classified.filter((entry) => !entry.serialClass).map((entry) => entry.name);

  const allSerial = process.env.TEST_SERIAL === '1';
  const serialPool = allSerial ? discovered : serialFiles;
  const parallelPool = allSerial ? [] : parallelFiles;

  console.log(`# 确定性完整测试调度（M1 工程基线）`);
  console.log(`发现 ${discovered.length} 个测试文件；串行（浏览器/构建类）${serialPool.length} 个，并行 ${parallelPool.length} 个。`);
  console.log('');

  const results = [];
  if (parallelPool.length) {
    console.log(`== 并行组（${parallelPool.length} 个文件，池并发 ${Math.min(availableParallelism(), parallelPool.length)}）==`);
    const parallelResults = await runPool(parallelPool.map((name) => join(TEST_DIR, name)), {
      concurrency: availableParallelism(),
      serial: false,
    });
    for (const result of parallelResults) results.push(result);
  }
  if (serialPool.length) {
    console.log(`== 串行组（浏览器/构建类，逐个执行）==`);
    for (const name of serialPool) {
      const result = await runOne(join(TEST_DIR, name), { serial: true });
      results.push(result);
    }
  }

  // ---- 结果矩阵 ----
  const byName = new Map(results.map((result) => [result.file, result]));
  let totalTests = 0;
  let totalPass = 0;
  let totalFail = 0;
  let totalSkipped = 0;
  console.log('');
  console.log('== 逐文件结果 ==');
  for (const name of discovered) {
    const result = byName.get(join(TEST_DIR, name));
    if (!result) {
      console.log(`[MISSING] ${name} —— 未执行，调度器漏跑（必须失败）`);
      process.exitCode = 1;
      continue;
    }
    const ok = result.code === 0;
    totalTests += result.summary.tests ?? 0;
    totalPass += result.summary.pass ?? 0;
    totalFail += result.summary.fail ?? 0;
    totalSkipped += result.summary.skipped ?? 0;
    const tag = result.serial ? '串行' : '并行';
    console.log(`${ok ? '[pass]' : '[FAIL]'} ${tag} ${name} —— ${formatSummary(result.summary)}，${(result.durationMs / 1000).toFixed(1)}s`);
    if (!ok) {
      console.log(`       exit=${result.code} signal=${result.signal ?? '-'}`);
      const tail = (result.stdout + '\n' + result.stderr).split('\n').filter(Boolean).slice(-25).join('\n');
      console.log(`       --- 输出尾部 ---\n${tail}\n       --- 输出尾部结束 ---`);
    }
  }

  // ---- 覆盖证明：每个发现文件都拿到了结果 ----
  const executedCount = discovered.filter((name) => byName.has(join(TEST_DIR, name))).length;
  if (executedCount !== discovered.length) {
    console.error(`覆盖不完整：发现 ${discovered.length} 个，仅执行 ${executedCount} 个。`);
    process.exitCode = 1;
  }

  console.log('');
  console.log(`总测试计数：tests=${totalTests} pass=${totalPass} fail=${totalFail} skipped=${totalSkipped}`);
  if (process.exitCode) {
    console.log(`结果：存在失败（exit ${process.exitCode}）`);
    process.exit(process.exitCode);
  }
  if (totalFail > 0) {
    console.log('结果：存在失败（fail>0）');
    process.exit(1);
  }
  console.log(`结果：全部 ${discovered.length} 个测试文件确定性通过。`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
