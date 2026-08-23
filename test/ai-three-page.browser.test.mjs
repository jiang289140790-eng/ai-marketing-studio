/* global fetch */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  EDGE, freePort, waitFor, waitForPageTarget, CdpClient, createPageTracker,
  navigateAndWait, reloadAndWait, waitForSelector, makeTempProfile,
  removeTempProfile, shutdownEdge, killProcessTree,
} from './helpers/cdp-browser-harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const SCREENSHOT_DIR = join(ROOT, 'acceptance-evidence', 'harness-conversation-20260823');

test('real browser: conversation workspace route, empty state, composer, responsive layout and refresh', { timeout: 180_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  const vitePort = await freePort();
  const debugPort = await freePort();
  const profile = await makeTempProfile('ams-conversation-browser-');
  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT,
    env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', VITE_HARNESS_EDGE_BASE_URL: '' },
    stdio: 'ignore', windowsHide: true,
  });
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}/ai-marketing-studio/`;
    await waitFor(async () => (await fetch(baseUrl)).ok, { label: 'Vite route' });
    const target = await waitForPageTarget(debugPort);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    const tracker = createPageTracker(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear();` });
    await navigateAndWait(cdp, tracker, `${baseUrl}tasks/new`, { label: '/tasks/new' });
    await waitForSelector(cdp, '[data-testid="conversation-workspace"]', { label: 'conversation workspace', timeout: 30_000 });
    await waitForSelector(cdp, '[data-testid="conversation-transcript"]', { label: 'conversation transcript' });
    await waitForSelector(cdp, '[data-testid="harness-intent"]', { label: 'composer' });
    assert.equal(await cdp.evaluate(`location.pathname.endsWith('/tasks/new')`), true);
    assert.match(await cdp.evaluate(`document.querySelector('[data-testid="conversation-transcript"]').innerText`), /今天想完成什么/);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.ai-task-flow button').length`), 3);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.ai-task-flow button')[1].disabled && document.querySelectorAll('.ai-task-flow button')[2].disabled`), true);
    const navLabels = await cdp.evaluate(`Array.from(document.querySelectorAll('.nav-item .nav-label'), (item) => item.textContent).filter(Boolean)`);
    assert.equal(new Set(navLabels).size, navLabels.length, 'sidebar labels remain unique');

    for (const [width, height] of [[1440, 1000], [1366, 900], [1024, 850], [768, 900], [390, 844]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
      const layout = await cdp.evaluate(`(() => { const box = document.querySelector('.conversation-workspace').getBoundingClientRect(); const composer = document.querySelector('.conversation-composer').getBoundingClientRect(); return { boxWidth: box.width, boxHeight: box.height, composerBottom: composer.bottom, viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
      assert.equal(layout.overflow, false, `${width}px has no horizontal overflow`);
      assert.ok(layout.boxHeight >= 400, `${width}px keeps the empty workspace useful without a forced blank transcript`);
      assert.ok(layout.composerBottom <= layout.viewport + 420, `${width}px composer remains reachable without nested-page overflow`);
      if (process.env.AMS_CAPTURE_ACCEPTANCE_SCREENSHOTS === '1') {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join(SCREENSHOT_DIR, `tasks-new-empty-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }

    await reloadAndWait(cdp, tracker, { label: 'conversation refresh' });
    await waitForSelector(cdp, '[data-testid="conversation-workspace"]', { label: 'conversation workspace after refresh' });
    assert.equal(await cdp.evaluate(`location.pathname.endsWith('/tasks/new')`), true);
  } finally {
    try { await cdp?.close(); } catch { /* noop */ }
    await shutdownEdge(debugPort);
    await killProcessTree(edge);
    await killProcessTree(vite);
    await removeTempProfile(profile);
  }
});
