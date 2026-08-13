/* global fetch */
// P32-C 真实浏览器验收：启动生产 #/research 路由，在隔离 localStorage 中创建
// 多帖项目，真实点击比较选择与综合按钮，验证 Evidence → latest Qwen analysis →
// exact Knowledge Cards → pending Brief 链、刷新恢复、项目切换清理和响应式布局。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  EDGE, freePort, waitFor, waitForPageTarget, CdpClient, createPageTracker,
  navigateAndWait, reloadAndWait, waitForSelector, click, captureDiagnostics,
  makeTempProfile, removeTempProfile, shutdownEdge, killProcessTree,
} from './helpers/cdp-browser-harness.mjs';

const ROOT = join(import.meta.dirname, '..');

const seedScript = `
(async () => {
  localStorage.clear();
  const service = await import('/ai-marketing-studio/src/services/p19-workspace-service.js');
  const contracts = await import('/ai-marketing-studio/src/services/p19-contracts.js');
  const stores = await import('/ai-marketing-studio/src/services/p19-store.js');
  const fixedNow = () => '2026-08-12T12:00:00.000Z';
  const digest = async (text) => {
    const bytes = new TextEncoder().encode(text);
    const value = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const makeInput = async (projectIndex, index) => {
    const externalId = String(1900000000000000000n + BigInt(projectIndex * 100 + index));
    const text = 'P32-C 浏览器真实帖子 ' + projectIndex + '-' + index + '：验证多帖综合洞察。';
    const contentSha = await digest(text);
    const sourceUrl = 'https://x.com/p32browser/status/' + externalId;
    return {
      source_url: sourceUrl,
      label: '浏览器帖子 ' + projectIndex + '-' + index,
      platform: 'X · Apify',
      content_text: text,
      recorded_at: '2026-08-12T08:00:00.000Z',
      provenance: {
        schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
        method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper',
        source_platform: 'x', source_id: 'p32c-browser-' + projectIndex + '-' + index,
        external_id: externalId, source_url: sourceUrl, run_id: 'run-p32c-browser',
        collected_at: '2026-08-12T08:00:00.000Z', usage_total_usd: 0.01,
        budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        content_sha256: contentSha, collection_proof: '1999999999.' + 'c'.repeat(64),
        statement: 'P32-C browser evidence.'
      },
      media_metadata: {
        filename: 'p32c-' + projectIndex + '-' + index + '.txt',
        mime_type: 'text/plain; charset=utf-8', byte_size: new TextEncoder().encode(text).byteLength,
        last_modified: '2026-08-12T08:00:00.000Z', sha256: contentSha
      },
      source_metadata: {
        author: { name: '浏览器作者' + index, handle: 'p32browser' + index, user_id: externalId },
        published_at: '2026-08-0' + index + 'T08:00:00.000Z',
        engagement: { likes: index * 1200, retweets: index * 240, replies: index * 80, quotes: index * 20, views: index * 50000, bookmarks: index * 400 }
      },
      media_assets: [{
        id: 'm-' + String(projectIndex).repeat(8) + String(index).repeat(16),
        tweet_id: externalId, external_id: externalId, canonical_tweet_url: sourceUrl,
        media_url: 'https://pbs.twimg.com/media/p32c-' + projectIndex + '-' + index + '.jpg',
        order: 0, kind: 'image', mime_type: 'image/jpeg', dimensions: { width: 1200, height: 800 },
        byte_size: 180000, hash: { algorithm: 'sha256', kind: 'content', value: String(index).repeat(64) }
      }]
    };
  };
  const analyze = (record, index) => ({
    source_id: record.provenance.source_id, model: 'qwen3.5-omni-flash',
    result: {
      text_expression: '视觉表达与简洁文案形成传播合力。',
      hook: '浏览器钩子 ' + index,
      copy_pattern: index % 2 ? '视觉前置 + 情绪共鸣' : '结果前置 + 数据证明',
      target_audience: '关注内容增长的创作者', audience_need_emotion: '获得确定性方法与灵感',
      media_analysis: record.media_assets.map((asset) => ({
        media_id: asset.id, visual_content: '高对比主体画面', composition: '中心构图',
        people: '单人', scene: '户外', emotion: index % 2 ? '轻松' : '惊喜',
        visual_selling_points: ['主体突出', '信息明确'], style_pattern: index % 2 ? '生活方式纪实' : '结果展示'
      })),
      virality_drivers: ['视觉冲击力', '情绪共鸣'], reusable_methods: ['首屏先给结果', '短句强化记忆'],
      rewrite_suggestions: ['加入明确行动提示'], signals: ['高互动率'], risks: ['避免夸大结论']
    },
    executed_at: '2026-08-12T12:00:00.000Z', usage: { total_tokens: 900 },
    _request_identity: 'p32c-browser:' + record.id + ':' + index
  });
  const store = stores.createP19Store();
  const projectIds = [];
  for (let projectIndex = 1; projectIndex <= 2; projectIndex += 1) {
    let project = await service.createProject({
      topic: projectIndex === 1 ? 'P32-C 浏览器综合项目' : 'P32-C 切换隔离项目',
      objective: '验证真实浏览器多帖综合链', audience: '测试用户', channel: 'X', constraints: ['只读来源'], now: fixedNow
    });
    const evidenceCount = projectIndex === 1 ? 3 : 2;
    for (let index = 1; index <= evidenceCount; index += 1) {
      const input = await makeInput(projectIndex, index);
      project = await service.addEvidence(project, input, { now: fixedNow, hasher: contracts.fingerprintOf });
      const record = project.evidence.find((item) => item.source_url === input.source_url);
      project = await service.recordVersionedReanalysis(project, record.id, analyze(record, index), { now: fixedNow, hasher: contracts.fingerprintOf });
    }
    const saved = store.putProject(project);
    if (!saved.ok) throw new Error(saved.code + ': ' + saved.message);
    projectIds.push(project.id);
  }
  localStorage.setItem('p19_active_project_v1', projectIds[0]);
  localStorage.setItem('p21_research_view_mode_v1', 'full');
  return projectIds;
})()`;

test('P32-C real browser: select exact posts, synthesize knowledge and pending Brief, restore after refresh and isolate project switch', { timeout: 120_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  const vitePort = await freePort();
  const debugPort = await freePort();
  const profile = await makeTempProfile('ams-p32c-browser-');
  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT, env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }, stdio: 'ignore', windowsHide: true,
  });
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let tracker;
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}/ai-marketing-studio/`;
    await waitFor(async () => (await fetch(baseUrl)).ok, { label: 'Vite route' });
    const target = await waitForPageTarget(debugPort);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    tracker = createPageTracker(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await navigateAndWait(cdp, tracker, baseUrl, { label: 'base page' });
    const projectIds = await cdp.evaluate(seedScript);
    assert.equal(projectIds.length, 2);

    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P32-C 浏览器综合项目')`), { label: 'seeded project' });
    // P36 渐进式重设计：多帖比较位于「分析」目的地的高级工具区，先导航并展开。
    await click(cdp, { selector: '[data-destination-tab="analyze"]', label: 'analyze destination tab' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'analyze'`), { label: 'analyze destination' });
    await click(cdp, { selector: '.p36-advanced summary', text: '多帖比较', label: 'multipost comparison section' });
    // 展开后渲染比较选择；不依赖固定 sleep，直接有界等待三个选择出现。
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-compare-chip input').length === 3`), { label: 'comparison choices' });
    const initial = await cdp.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      brief: Boolean(document.querySelector('.p32-synthesis-brief-summary')),
      flags: [...document.querySelectorAll('.p19-flag-strip *')].map((node) => node.textContent).join(' ')
    }))()`);
    assert.equal(initial.overflow, false);
    assert.equal(initial.brief, false);

    await click(cdp, { selector: '.p32-compare-chip input', index: 0, label: 'first comparison post' });
    await click(cdp, { selector: '.p32-compare-chip input', index: 1, label: 'second comparison post' });
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-compare-chip input:checked').length === 2`), { label: 'two selected posts' });
    await waitForSelector(cdp, '.p32-synthesis-preview', { label: 'synthesis preview' });
    const preview = await cdp.evaluate(`(() => ({
      sections: document.querySelectorAll('.p32-synthesis-section').length,
      metrics: document.querySelectorAll('.p32-synthesis-metrics-row:not(.p32-synthesis-metrics-head)').length,
      chain: document.querySelectorAll('.p32-synthesis-chain-list li').length,
      buttonDisabled: [...document.querySelectorAll('button')].find((b) => b.textContent.includes('生成综合知识与待审核 Brief'))?.disabled
    }))()`);
    assert.equal(preview.sections, 6);
    assert.equal(preview.metrics, 2);
    assert.equal(preview.chain, 2);
    assert.equal(preview.buttonDisabled, false);

    await click(cdp, { text: '生成综合知识与待审核 Brief', label: 'synthesize brief button' });
    const synthesisResult = await waitFor(() => cdp.evaluate(`(() => {
      const outcome = document.querySelector('.p32-synthesis-outcome');
      const error = document.querySelector('.p19-error-banner');
      if (!outcome && !error) return null;
      return { ok: Boolean(outcome), text: (outcome || error).textContent };
    })()`), { label: 'synthesis outcome or bounded error' });
    assert.equal(synthesisResult.ok, true, `synthesis failed in production UI: ${synthesisResult.text}`);
    // P36：Brief 详情位于「产物」目的地，导航并选择 Brief 区。
    await click(cdp, { selector: '[data-destination-tab="outputs"]', label: 'outputs destination tab' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'outputs'`), { label: 'outputs destination' });
    await click(cdp, { selector: '.p36-rail-item', text: 'Brief', label: 'brief rail item' });
    await waitForSelector(cdp, '.p32-synthesis-brief-summary', { label: 'pending Brief' });
    const persisted = await cdp.evaluate(`(() => {
      const store = JSON.parse(localStorage.getItem('p19_workspace_store_v1'));
      const project = store.projects.find((item) => item.id === localStorage.getItem('p19_active_project_v1'));
      return {
        cards: project.knowledge_cards.length,
        briefStatus: project.brief?.status,
        selected: project.brief?.p32_synthesis?.selected_evidence_ids?.length,
        citations: project.brief?.knowledge_citation_ids?.length,
        decision: project.brief?.review?.decision?.value,
        handoff: project.handoff,
        flags: project.execution_flags,
      };
    })()`);
    assert.equal(persisted.cards, 2);
    assert.equal(persisted.briefStatus, 'pending_review');
    assert.equal(persisted.selected, 2);
    assert.equal(persisted.citations, 2);
    assert.equal(persisted.decision, undefined, 'pending Brief has no human decision yet');
    assert.equal(persisted.handoff, null);
    assert.deepEqual(persisted.flags, { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false });

    await reloadAndWait(cdp, tracker, { label: 'hard refresh' });
    await waitForSelector(cdp, '[data-destination-tab="outputs"]', { label: 'destinations after refresh' });
    await click(cdp, { selector: '[data-destination-tab="outputs"]', label: 'outputs destination tab after refresh' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'outputs'`), { label: 'outputs destination after refresh' });
    await click(cdp, { selector: '.p36-rail-item', text: 'Brief', label: 'brief rail item after refresh' });
    await waitForSelector(cdp, '.p32-synthesis-brief-summary', { label: 'Brief after refresh' });
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.p32-compare-chip input:checked').length`), 0, 'transient selection clears on refresh');

    await cdp.evaluate(`(() => {
      const select = document.querySelector('.p19-project-select select');
      select.value = ${JSON.stringify('PROJECT_2')};
      const option = [...select.options].find((item) => item.textContent.includes('切换隔离项目'));
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`.replace('PROJECT_2', projectIds[1]));
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P32-C 切换隔离项目')`), { label: 'project switch' });
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.p32-compare-chip input:checked').length`), 0);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    // 视口切换后的布局稳定是异步的：有界等待布局收敛，再断言无横向溢出。
    await waitFor(() => cdp.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), { label: 'mobile layout settle' });
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'), false, 'mobile page has no horizontal overflow');
  } catch (error) {
    if (cdp) {
      const extra = await captureDiagnostics(cdp, { tracker });
      if (!String(error.message).includes('诊断快照')) error.message += `\n${extra}`;
    }
    throw error;
  } finally {
    if (cdp) cdp.close();
    await shutdownEdge(edge, profile);
    await killProcessTree(vite);
    await removeTempProfile(profile);
  }
});
