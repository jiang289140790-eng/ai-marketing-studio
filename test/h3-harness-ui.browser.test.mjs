/* global fetch */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  EDGE, freePort, waitFor, waitForPageTarget, CdpClient, createPageTracker,
  waitForSelector, click, captureDiagnostics,
  makeTempProfile, removeTempProfile, shutdownEdge, killProcessTree,
} from './helpers/cdp-browser-harness.mjs';
const ROOT = join(import.meta.dirname, '..');

test('H3 real browser: natural-language workspace is the simple default and advanced research remains reachable', { timeout: 90_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  const vitePort = await freePort();
  const debugPort = await freePort();
  const profile = await makeTempProfile('ams-p30-h3-browser-');
  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT,
    env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    stdio: 'ignore',
    windowsHide: true,
  });
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let tracker;
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}/ai-marketing-studio/`;
    await waitFor(async () => (await fetch(baseUrl)).ok, { label: 'H3 Vite route' });
    const target = await waitForPageTarget(debugPort);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    tracker = createPageTracker(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: `${baseUrl}#/dashboard` });
    await waitFor(() => cdp.evaluate(`location.href === ${JSON.stringify(`${baseUrl}#/dashboard`)} && document.readyState === 'complete'`), { label: 'AI workspace exact route and DOM readiness' });
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'AI workspace' });
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('告诉我你想完成什么')`), true);
    assert.equal(
      await cdp.evaluate(`document.querySelectorAll('.nav-item').length`),
      20,
      'navigation keeps every integrated product destination discoverable',
    );
    assert.deepEqual(
      await cdp.evaluate(`Array.from(document.querySelectorAll('.nav-item .nav-label'), (item) => item.textContent)`),
      ['AI 工作台', 'AI 运营指挥中心', '运营活动', '内容计划', '研究工作台', '内容工作台', '内容情报', '发布中心', '账号矩阵', '角色库', '素材库', '生成工作台', '提示词库', '数据分析', 'AI 复盘', '运营日报', '知识库', '平台连接', '工作流与模型', '系统状态'],
      'grouped navigation preserves the complete integrated product map',
    );
    assert.equal(await cdp.evaluate(`document.querySelector('[data-nav-section="智能工作"] .nav-section-toggle')?.getAttribute('aria-expanded')`), 'true', 'the active product group is expanded');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-section-toggle').length`), 6, 'every product group is directly discoverable');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-item.active').length`), 1, 'default route exposes exactly one active navigation item');
    assert.equal(await cdp.evaluate(`document.querySelector('.nav-item.active .nav-label')?.textContent === 'AI 工作台'`), true, 'default route aliases only to the AI workspace navigation item');

    await click(cdp, { selector: '.ai-suggestions button', index: 0, label: 'first suggested task' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-authoritative-plan"]') === null`), true, 'selecting a suggestion must not invent a client-side plan');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-submit"]').disabled`), false, 'a bounded intent can request the server plan without pre-approving execution');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('生成计划不会调用业务工具、产生费用或写入 staging')`), true);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.ai-approvals input').length`), 0, 'approval controls appear only after an authoritative plan exists');

    await cdp.send('Page.navigate', { url: `${baseUrl}#/generation` });
    await waitForSelector(cdp, '[data-testid="g2-flow"]', { label: 'generation workspace' });
    await click(cdp, { selector: '[data-testid="g2-workspace"] .primary-button', text: '交给 AI 编排', label: 'generation to Harness handoff' });
    await waitFor(() => cdp.evaluate(`location.hash.startsWith('#/ai?') && new URLSearchParams(location.hash.split('?')[1]).get('source') === 'generation'`), { label: 'bounded generation Harness context' });
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'AI workspace after generation handoff' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-intent"]')?.value.includes('先展示报价，等待我确认后再执行')`), true);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor(() => cdp.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), { label: 'H3 mobile layout settle' });
    assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`), false);

    await click(cdp, { selector: '.ai-hero .secondary-button', text: '进入高级研究模式', label: 'advanced research mode' });
    await waitFor(() => cdp.evaluate(`location.hash.startsWith('#/research')`), { label: 'advanced research route' });
    await waitForSelector(cdp, '.p19-workspace', { label: 'existing advanced research page', timeout: 25_000 });
  } catch (error) {
    if (cdp) error.message += `\n${await captureDiagnostics(cdp, { tracker })}`;
    throw error;
  } finally {
    if (cdp) cdp.close();
    await shutdownEdge(edge, profile);
    await killProcessTree(vite);
    await removeTempProfile(profile);
  }
});
