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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/dashboard` });
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/new') && document.readyState === 'complete'`), { label: 'AI workspace exact route and DOM readiness' });
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'AI workspace' });
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('今天想完成什么？')`), true);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.ai-overview > div').length`), 4, 'AI workspace exposes a compact operational overview');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="ai-command-center"]') !== null`), true, 'the primary natural-language command center is visible');
    assert.deepEqual(
      await cdp.evaluate(`Array.from(document.querySelectorAll('.harness-core-plugins .nav-label'), (item) => item.textContent)`),
      ['AI 工作台', '研究工作台', 'Evidence', 'Knowledge', 'Brief 审核', '生成中心', '成品库'],
      'Harness plugin rail exposes every real business destination',
    );
    await click(cdp, { selector: '[data-testid="harness-plugin-generation"]', label: 'generation business plugin' });
    await waitFor(() => cdp.evaluate(`location.hash === '#/generation'`), { label: 'generation plugin exact route' });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/dashboard` });
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'AI workspace restored after plugin route' });
    await click(cdp, { selector: '[data-testid="harness-plugin-research-evidence"]', label: 'Evidence business plugin' });
    await waitFor(() => cdp.evaluate(`location.hash === '#/research?focus=collect'`), { label: 'Evidence plugin exact focused route' });
    await waitForSelector(cdp, '.p19-workspace', { label: 'Evidence research workspace', timeout: 25_000 });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/dashboard` });
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'AI workspace restored after Evidence route' });
    assert.equal(await cdp.evaluate(`document.querySelector('.ai-capability-panel')?.open === false`), true, 'secondary capabilities remain collapsed until requested');
    assert.equal(await cdp.evaluate(`document.querySelector('.ai-history')?.open === false`), true, 'task history remains collapsed until requested');
    assert.equal(
      await cdp.evaluate(`document.querySelector('.ai-overview-disclosure').getBoundingClientRect().top < document.querySelector('[data-testid="ai-command-center"]').getBoundingClientRect().top`),
      true,
      'task overview stays above the command composer instead of floating below recent results',
    );
    assert.equal(
      await cdp.evaluate(`document.querySelectorAll('.nav-item').length`),
      22,
      'navigation renders each integrated destination once without duplicate task shortcuts',
    );
    assert.deepEqual(
      await cdp.evaluate(`Array.from(document.querySelectorAll('.nav-item .nav-label'), (item) => item.textContent)`),
      ['AI 工作台', '研究工作台', 'Evidence', 'Knowledge', 'Brief 审核', '生成中心', '成品库', 'AI 运营指挥中心', '运营活动', '内容计划', '内容工作台', '内容情报', '发布中心', '账号矩阵', '角色库', '提示词库', '数据分析', 'AI 复盘', '运营日报', '平台连接', '工作流与模型', '系统状态'],
      'grouped navigation preserves the complete integrated product map',
    );
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.harness-core-plugin').length`), 7, 'every core Harness plugin is directly discoverable');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-section-toggle').length`), 5, 'secondary product groups remain discoverable under more tools');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-item.active').length`), 1, 'default route exposes exactly one active navigation item');
    assert.equal(await cdp.evaluate(`document.querySelector('.nav-item.active .nav-label')?.textContent === 'AI 工作台'`), true, 'default route aliases only to the AI workspace navigation item');

    assert.equal(await cdp.evaluate(`document.querySelector('.app-shell').classList.contains('sidebar-collapsed')`), false, 'desktop navigation starts expanded on a fresh profile');
    await click(cdp, { selector: '.sidebar-collapse-toggle', label: 'collapse desktop sidebar' });
    await waitFor(() => cdp.evaluate(`document.querySelector('.app-shell').classList.contains('sidebar-collapsed')`), { label: 'desktop sidebar collapsed state' });
    await waitFor(() => cdp.evaluate(`document.querySelector('.sidebar').getBoundingClientRect().width <= 80`), { label: 'collapsed navigation icon rail width' });
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-item').length`), 22, 'collapsing the rail keeps every unique destination available');
    assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('.nav-label')).every((item) => getComputedStyle(item).display === 'none')`), true, 'collapsed navigation hides verbose labels');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-item.active').length`), 1, 'collapsed navigation preserves the active route');
    await click(cdp, { selector: '.sidebar-collapse-toggle', label: 'expand desktop sidebar' });
    await waitFor(() => cdp.evaluate(`!document.querySelector('.app-shell').classList.contains('sidebar-collapsed')`), { label: 'desktop sidebar expanded state' });
    assert.equal(await cdp.evaluate(`globalThis.localStorage.getItem('ams-sidebar-collapsed')`), 'false', 'sidebar preference is persisted safely');

    await click(cdp, { selector: '.ai-capability-panel > summary', label: 'expand suggested tasks' });
    await click(cdp, { selector: '.ai-suggestions button', index: 0, label: 'first suggested task' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-authoritative-plan"]') === null`), true, 'selecting a suggestion must not invent a client-side plan');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-submit"]').disabled`), false, 'a bounded intent can request the server plan without pre-approving execution');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('此步骤只生成计划，不调用付费工具，也不写入数据')`), true);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.ai-approvals input').length`), 0, 'approval controls appear only after an authoritative plan exists');

    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="harness-attachment-input"]');
      const transfer = new DataTransfer();
      transfer.items.add(new File(['bounded attachment text'], 'brief-notes.txt', { type: 'text/plain', lastModified: 1 }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitForSelector(cdp, '[data-testid="harness-attachments"]', { label: 'selected attachment tray' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-attachments"]').innerText.includes('brief-notes.txt')`), true, 'selected attachment is visibly bound to the task composer');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-attachments"]').innerText.includes('文本已读取')`), true, 'bounded text attachment content is read locally');
    await click(cdp, { selector: '[data-testid="harness-attachments"] button', label: 'remove selected attachment' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="harness-attachments"]') === null`), { label: 'attachment removed' });

    await cdp.send('Page.navigate', { url: `${baseUrl}#/generation` });
    await waitForSelector(cdp, '[data-testid="g2-flow"]', { label: 'generation workspace' });
    await click(cdp, { selector: '[data-testid="g2-workspace"] .primary-button', text: '交给 AI 编排', label: 'generation to Harness handoff' });
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/new') && new URLSearchParams(location.search).get('source') === 'generation'`), { label: 'bounded generation Harness context' });
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'AI workspace after generation handoff' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-intent"]')?.value.includes('先展示报价，等待我确认后再执行')`), true);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor(() => cdp.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), { label: 'H3 mobile layout settle' });
    assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`), false);

    await click(cdp, { selector: '.sidebar-toggle', text: '菜单', label: 'open mobile Harness navigation' });
    await click(cdp, { selector: '[data-testid="harness-plugin-research"]', label: 'mobile research plugin' });
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
