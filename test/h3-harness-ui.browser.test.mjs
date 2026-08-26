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

test('H3 real browser: conversation workspace is the simple default and business plugins remain reachable', { timeout: 90_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  const vitePort = await freePort();
  const debugPort = await freePort();
  const profile = await makeTempProfile('ams-h3-conversation-browser-');
  const vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    stdio: 'ignore', windowsHide: true,
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/dashboard` });
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/new') && document.readyState === 'complete'`), { label: 'canonical conversation route' });
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'conversation workspace' });
    await waitForSelector(cdp, '[data-testid="harness-intent"]', { label: 'conversation composer' });
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('今天想完成什么？')`), true);
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="conversation-transcript"]') !== null`), true);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="conversation-message"]').length`), 0, 'empty session does not invent messages');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-item').length`), 8, 'every visible business destination is registered once');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid^="harness-journey-"]').length`), 2, 'the native Harness journey exposes exactly two anchors');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-item.active, [data-testid="harness-journey-new"], [data-testid="harness-journey-session"].active').length >= 1`), true, 'the active journey remains visible');

    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-intent"]').placeholder.includes('Shift+Enter')`), true, 'composer exposes the multiline keyboard contract');

    await click(cdp, { selector: '[data-testid="harness-plugin-generation"]', label: 'generation business plugin' });
    await waitFor(() => cdp.evaluate(`location.hash === '#/generation'`), { label: 'generation plugin route' });
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/new` });
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'conversation workspace restored' });
    await click(cdp, { selector: '[data-testid="harness-plugin-research"]', label: 'research and Brief core route' });
    await waitFor(() => cdp.evaluate(`location.hash === '#/research'`), { label: 'research route' });
    await waitForSelector(cdp, '.p19-workspace', { label: 'research workspace', timeout: 25_000 });

    assert.equal(tracker.state.exceptions, 0, `browser exception: ${tracker.state.lastException || 'none'}`);
  } catch (error) {
    if (cdp) error.message += `\n${await captureDiagnostics(cdp)}`;
    throw error;
  } finally {
    tracker?.off();
    cdp?.close();
    await shutdownEdge(edge, profile);
    await killProcessTree(vite);
    await removeTempProfile(profile);
  }
});
