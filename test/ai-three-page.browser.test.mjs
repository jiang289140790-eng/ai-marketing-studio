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
    await waitForSelector(cdp, '[data-testid="harness-intent"]', { label: 'composer' });
    assert.equal(await cdp.evaluate(`location.pathname.endsWith('/tasks/new')`), true);
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="conversation-workspace"]').classList.contains('is-empty')`), true);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="conversation-transcript"]').length`), 0);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.conversation-quick-prompts button').length`), 0);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.ai-task-flow button').length`), 0);
    const navLabels = await cdp.evaluate(`Array.from(document.querySelectorAll('.nav-item .nav-label'), (item) => item.textContent).filter(Boolean)`);
    assert.equal(new Set(navLabels).size, navLabels.length, 'sidebar labels remain unique');

    for (const [width, height] of [[1440, 1000], [1366, 900], [1024, 850], [768, 900], [390, 844]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
      await waitFor(async () => await cdp.evaluate(`innerWidth === ${width} && innerHeight === ${height}`), { label: `${width}px viewport settlement` });
      const layout = await cdp.evaluate(`(() => { const box = document.querySelector('.conversation-workspace').getBoundingClientRect(); const composer = document.querySelector('.conversation-composer').getBoundingClientRect(); return { boxWidth: box.width, boxHeight: box.height, composerBottom: composer.bottom, viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
      assert.equal(layout.overflow, false, `${width}px has no horizontal overflow`);
      assert.ok(layout.boxHeight < 260, `${width}px keeps the empty workspace compact: ${JSON.stringify(layout)}`);
      assert.ok(layout.composerBottom <= layout.viewport + 80, `${width}px composer remains immediately reachable: ${JSON.stringify(layout)}`);
      if (process.env.AMS_CAPTURE_ACCEPTANCE_SCREENSHOTS === '1') {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join(SCREENSHOT_DIR, `tasks-new-empty-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }

    await reloadAndWait(cdp, tracker, { label: 'conversation refresh' });
    await waitForSelector(cdp, '[data-testid="conversation-workspace"]', { label: 'conversation workspace after refresh' });
    assert.equal(await cdp.evaluate(`location.pathname.endsWith('/tasks/new')`), true);

    // H9 mobile direct-route acceptance: execution/results pages must render
    // truthfully even when the local browser has no configured backend.
    const taskId = 'ht-00000000-0000-4000-8000-000000000001';
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await navigateAndWait(cdp, tracker, `${baseUrl}tasks/${taskId}`, { label: 'mobile /tasks/:id' });
    await waitForSelector(cdp, '[data-testid="ai-task-execution"]', { label: 'mobile execution page' });
    await waitForSelector(cdp, '[data-testid="ai-task-read-error"]', { label: 'truthful unconfigured execution state' });
    assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'mobile execution route has no horizontal overflow');

    await navigateAndWait(cdp, tracker, `${baseUrl}tasks/${taskId}/results`, { label: 'mobile /tasks/:id/results' });
    await waitForSelector(cdp, '[data-testid="ai-task-results"]', { label: 'mobile results page' });
    await waitForSelector(cdp, '[data-testid="ai-task-read-error"]', { label: 'truthful unconfigured results state' });
    assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'mobile results route has no horizontal overflow');
  } finally {
    try { await cdp?.close(); } catch { /* noop */ }
    await shutdownEdge(debugPort);
    await killProcessTree(edge);
    await killProcessTree(vite);
    await removeTempProfile(profile);
  }
});
