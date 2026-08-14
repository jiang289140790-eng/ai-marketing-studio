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
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-item').length`), 4, 'simple navigation exposes four primary destinations');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-item.active').length`), 1, 'default route exposes exactly one active navigation item');
    assert.equal(await cdp.evaluate(`document.querySelector('.nav-item.active .nav-label')?.textContent === 'AI 工作台'`), true, 'default route aliases only to the AI workspace navigation item');

    await click(cdp, { selector: '.ai-suggestions button', index: 0, label: 'first suggested task' });
    await waitForSelector(cdp, '[data-testid="harness-plan"]', { label: 'bounded local plan' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-submit"]').disabled`), true, 'Harness model execution requires explicit paid approval');
    await cdp.evaluate(`(() => { const input = document.querySelector('.ai-approvals input'); input.click(); })()`);
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-submit"]').disabled`), false);
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('不会删除数据、修改权限、自动发布或访问 production')`), true);

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
