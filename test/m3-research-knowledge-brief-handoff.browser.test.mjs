/* global fetch */
// M3 真实浏览器验收：启动生产 #/research 路由，在隔离 localStorage 中创建
// 在线闭环项目，真实点击 分析 → 知识卡 → Brief 批准 → 交接包 完整链，
// 验证版本菜单、费用绑定显示、审核记录审计、刷新恢复、项目切换隔离和
// 确定性本地分析「无费用」展示。
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

// M3 精确作用域：只读「活动目的地」下当前选中 Evidence 的结果容器。
// 目的地为条件渲染，[data-active-destination] 与 [data-destination] 双重
// 约束，再加 .p36-result-col 结果容器 —— 绝不读取隐藏、历史或其他项目节点。
const ACTIVE_ANALYZE = '.p36-destinations[data-active-destination="analyze"] [data-destination="analyze"]';
const ANALYZE_RESULT_COL = `${ACTIVE_ANALYZE} .p36-result-col`;
const OUTPUTS_CANVAS = '.p36-destinations[data-active-destination="outputs"] [data-destination="outputs"] .p36-canvas';

const seedScript = `
(async () => {
  localStorage.clear();
  const service = await import('/ai-marketing-studio/src/services/p19-workspace-service.js');
  const contracts = await import('/ai-marketing-studio/src/services/p19-contracts.js');
  const stores = await import('/ai-marketing-studio/src/services/p19-store.js');
  const fixedNow = () => '2026-08-14T08:00:00.000Z';
  const digest = async (text) => {
    const bytes = new TextEncoder().encode(text);
    const value = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const makeInput = async (projectIndex, index) => {
    const externalId = String(1900000000000000000n + BigInt(projectIndex * 100 + index));
    const text = 'M3 浏览器真实帖子 ' + projectIndex + '-' + index + '：验证在线闭环。';
    const contentSha = await digest(text);
    const sourceUrl = 'https://x.com/m3browser/status/' + externalId;
    return {
      source_url: sourceUrl,
      label: 'M3 浏览器帖子 ' + projectIndex + '-' + index,
      platform: 'X · Apify',
      content_text: text,
      recorded_at: '2026-08-13T07:00:00.000Z',
      provenance: {
        schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
        method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper',
        source_platform: 'x', source_id: 'm3-browser-' + projectIndex + '-' + index,
        external_id: externalId, source_url: sourceUrl, run_id: 'run-m3-browser',
        collected_at: '2026-08-13T07:00:00.000Z', usage_total_usd: 0.0123,
        budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        content_sha256: contentSha, collection_proof: '1999999999.' + 'c'.repeat(64),
        statement: 'M3 browser evidence.'
      },
      media_metadata: {
        filename: 'm3-' + projectIndex + '-' + index + '.txt',
        mime_type: 'text/plain; charset=utf-8', byte_size: new TextEncoder().encode(text).byteLength,
        last_modified: '2026-08-13T07:00:00.000Z', sha256: contentSha
      },
      source_metadata: {
        author: { name: 'M3 浏览器作者', handle: 'm3browser' + index, user_id: externalId },
        published_at: '2026-08-13T06:00:00.000Z',
        engagement: { likes: index * 1200, retweets: index * 240, replies: index * 80, quotes: index * 20, views: index * 50000, bookmarks: index * 400 }
      },
      media_assets: [{
        id: 'm-' + String(projectIndex).repeat(8) + String(index).repeat(16),
        tweet_id: externalId, external_id: externalId, canonical_tweet_url: sourceUrl,
        media_url: 'https://pbs.twimg.com/media/m3-' + projectIndex + '-' + index + '.jpg',
        order: 0, kind: 'image', mime_type: 'image/jpeg', dimensions: { width: 1200, height: 800 },
        byte_size: 180000, hash: { algorithm: 'sha256', kind: 'content', value: String(index).repeat(64) }
      }]
    };
  };
  const analyze = (record, index, version) => ({
    source_id: record.provenance.source_id, model: 'qwen3.5-omni-flash',
    result: {
      text_expression: '视觉表达与简洁文案形成传播合力。',
      hook: 'M3 浏览器钩子 ' + index + ' v' + version,
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
    executed_at: '2026-08-14T08:0' + version + ':00.000Z',
    usage: { total_tokens: 900 },
    cost: { actual_usd: 0.0042, recorded_cny: 0.05, reservation_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
    _request_identity: 'm3-browser:' + record.id + ':' + index + ':' + version
  });
  const store = stores.createP19Store();
  const projectIds = [];
  const evidenceIds = { a: [], b: [] };
  for (let projectIndex = 1; projectIndex <= 2; projectIndex += 1) {
    let project = await service.createProject({
      topic: projectIndex === 1 ? 'M3 浏览器在线闭环项目' : 'M3 浏览器切换隔离项目',
      objective: '验证真实浏览器闭环', audience: '测试用户', channel: 'X', constraints: ['只读来源'], now: fixedNow
    });
    const evidenceCount = projectIndex === 1 ? 2 : 1;
    for (let index = 1; index <= evidenceCount; index += 1) {
      const input = await makeInput(projectIndex, index);
      project = await service.addEvidence(project, input, { now: fixedNow, hasher: contracts.fingerprintOf });
      const record = project.evidence.find((item) => item.source_url === input.source_url);
      (projectIndex === 1 ? evidenceIds.a : evidenceIds.b).push(record.id);
      // 只有项目 A 预置版本化 Qwen 分析（两个显式版本：旧版保留、新版当前）。
      // 项目 B 必须从一条独立来源开始，绝不预置任何 Qwen model_analysis、
      // token、CNY/USD 费用或 reservation —— 之后由真实页面跑确定性本地分析。
      if (projectIndex === 1) {
        project = await service.recordVersionedReanalysis(project, record.id, analyze(record, index, 1), { now: fixedNow, hasher: contracts.fingerprintOf });
        project = await service.recordVersionedReanalysis(project, record.id, analyze(record, index, 2), { now: fixedNow, hasher: contracts.fingerprintOf });
      }
    }
    const saved = store.putProject(project);
    if (!saved.ok) throw new Error(saved.code + ': ' + saved.message);
    projectIds.push(project.id);
  }
  localStorage.setItem('p19_active_project_v1', projectIds[0]);
  localStorage.setItem('p21_research_view_mode_v1', 'full');
  return { projectIds, evidenceIds };
})()`;

test('M3 real browser: versioned analysis with bound cost → Knowledge Card → approve Brief → Handoff, restore after refresh, isolate project switch', { timeout: 180_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  const vitePort = await freePort();
  const debugPort = await freePort();
  // 统一 cdp-browser-harness 只删除 /ams-(p20|p29|p30|p32)/ 前缀校验通过的
  // 本次独立临时 profile：复用 P32 合法前缀（ams-p32…），不修改 helper。
  const profile = await makeTempProfile('ams-p32c-m3-');
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
    const seeded = await cdp.evaluate(seedScript);
    assert.equal(seeded.projectIds.length, 2, '必须预置两个独立项目');
    assert.equal(seeded.evidenceIds.a.length, 2, '项目 A 必须预置两条来源');
    assert.equal(seeded.evidenceIds.b.length, 1, '项目 B 必须从一条独立来源开始');
    const projectIds = seeded.projectIds;
    const evidenceIds = seeded.evidenceIds;
    // 与种子 makeInput 同源计算来源 URL，作为「选中 Evidence 精确绑定」的判据。
    const externalIdFor = (projectIndex, index) => String(1900000000000000000n + BigInt(projectIndex * 100 + index));
    const bSourceUrl = `https://x.com/m3browser/status/${externalIdFor(2, 1)}`;
    const aFirstSourceUrl = `https://x.com/m3browser/status/${externalIdFor(1, 1)}`;
    const aSecondSourceUrl = `https://x.com/m3browser/status/${externalIdFor(1, 2)}`;
    // 精确字符串 → 正则：项目 A 的 URL / 证据 ID 必须整体按字面匹配，
    // 元字符全部按字面转义，绝不放宽为宽松前缀或子串代理。
    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 通过真实项目选择器切换项目；等待 key={project.id} 整棵重挂载（新组件默认
    // 回到「采集」目的地），再核对页面与持久化的活动项目绑定。
    const switchProject = async (index, label) => {
      await cdp.evaluate(`(() => {
        const select = document.querySelector('.p19-project-select select');
        const option = [...select.options].find((item) => item.value === ${JSON.stringify(projectIds[index])});
        if (!option) throw new Error('project option not found');
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[data-active-destination="collect"]'))`), { label: `${label}: destination remounted` });
      await waitFor(() => cdp.evaluate(`document.querySelector('.p19-project-select select')?.value === ${JSON.stringify(projectIds[index])}`), { label: `${label}: project select bound` });
      assert.equal(await cdp.evaluate(`localStorage.getItem('p19_active_project_v1')`), projectIds[index], `${label}: 持久化活动项目必须绑定项目 ${index + 1}`);
    };

    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('M3 浏览器在线闭环项目')`), { label: 'seeded project' });

    // ---- 分析目的地：版本菜单 + 费用绑定显示 ----
    await click(cdp, { selector: '[data-destination-tab="analyze"]', label: 'analyze destination tab' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'analyze'`), { label: 'analyze destination' });
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('${ANALYZE_RESULT_COL} [data-testid="m3-analysis-cost"]').length === 1`), { label: 'bound cost line in active analyze result container' });
    const costText = await cdp.evaluate(`(() => { const nodes = document.querySelectorAll('${ANALYZE_RESULT_COL} [data-testid="m3-analysis-cost"]'); return nodes.length === 1 ? nodes[0].textContent : ''; })()`);
    assert.equal(costText !== '', true, `活动 analyze 结果容器必须恰好一条费用行`);
    assert.match(costText, /qwen3\.5-omni-flash/, `模型身份必须显示：${costText}`);
    assert.match(costText, /900 tokens/, `用量必须绑定显示：${costText}`);
    assert.match(costText, /费用 ¥0\.05/, `实际费用必须绑定显示：${costText}`);
    assert.match(costText, /（\$0\.0042）/, `美元费用必须绑定显示：${costText}`);
    assert.match(costText, /预留 bbbbbbbb/, `预留身份必须绑定显示：${costText}`);
    // 版本菜单：两个显式版本，旧版保留。
    const versions = await cdp.evaluate(`[...document.querySelectorAll('.p36-version-history b')].map((node) => node.textContent).join(' ')`);
    assert.match(versions, /共 2 个版本/, `版本历史必须显示 2 个版本：${versions}`);

    // ---- 生成知识卡（当前分析 → 卡） ----
    await click(cdp, { selector: '.p36-result-actions button', text: '生成知识卡', label: 'generate knowledge card' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('知识卡已构建')`), { label: 'knowledge card saved' });
    await click(cdp, { selector: '[data-destination-tab="outputs"]', label: 'outputs destination tab' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'outputs'`), { label: 'outputs destination' });
    await click(cdp, { selector: '.p36-rail-item', text: '知识卡', label: 'cards rail item' });
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p19-card-item').length === 1`), { label: 'exactly one knowledge card' });

    // ---- Brief：组装 → 人工批准（审计记录写入） ----
    await click(cdp, { selector: '.p36-rail-item', text: 'Brief', label: 'brief rail item' });
    await waitForSelector(cdp, '.p19-panel', { label: 'brief panel' });
    // 种子数据只有证据与分析：先组装第一版 Brief。
    await click(cdp, { text: '生成内容策划草案', label: 'assemble brief' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('重新生成草案')`), { label: 'brief assembled' });
    // 填写确认意见（React 受控 textarea 用原生 setter 触发 input）。
    await cdp.evaluate(`(() => {
      const area = document.querySelector('.p19-brief-actions .p19-inline-field textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, 'M3 浏览器验收：人工批准');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click(cdp, { selector: '.p19-review-actions button', text: '批准草案', label: 'approve brief' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('已人工批准') || document.body.innerText.includes('已批准')`), { label: 'brief approved' });
    // 审核记录审计可见（旧决定保留审计）。
    const audit = await cdp.evaluate(`(() => {
      const node = document.querySelector('[data-testid="m3-decision-audit"]');
      return node ? node.textContent : '';
    })()`);
    assert.match(audit, /审核记录/, `审核记录审计必须可见：${audit}`);

    // ---- 交接包：从已批准 Brief 派生 ----
    await click(cdp, { selector: '.p36-rail-item', text: '交接包', label: 'handoff rail item' });
    await waitForSelector(cdp, '.p19-panel', { label: 'handoff panel' });
    await click(cdp, { text: '派生 P5 交接包', label: 'derive handoff' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('handoff-pkg-')`), { label: 'handoff derived' });
    const handoffText = await cdp.evaluate(`document.body.innerText`);
    assert.match(handoffText, /绑定 Brief .* 第 1 版（approved）/);
    assert.match(handoffText, /四项执行标志均为 false|执行标志/);

    // ---- 硬刷新恢复 ----
    await reloadAndWait(cdp, tracker, { label: 'hard refresh' });
    await waitForSelector(cdp, '[data-destination-tab="outputs"]', { label: 'destinations after refresh' });
    await click(cdp, { selector: '[data-destination-tab="outputs"]', label: 'outputs after refresh' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'outputs'`), { label: 'outputs destination after refresh' });
    await click(cdp, { selector: '.p36-rail-item', text: 'Brief', label: 'brief rail after refresh' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('已批准')`), { label: 'approved Brief after refresh' });
    await click(cdp, { selector: '.p36-rail-item', text: '交接包', label: 'handoff rail after refresh' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('handoff-pkg-')`), { label: 'handoff after refresh' });

    // ---- 项目切换隔离 ----
    await switchProject(1, '切到项目 B');
    assert.equal(await cdp.evaluate(`document.querySelector('.p19-project-select select').value`), projectIds[1], '项目 B 必须被选中');

    // 产物目的地：A 的知识卡/Brief/交接包/费用绝不泄漏到 B。
    await click(cdp, { selector: '[data-destination-tab="outputs"]', label: 'outputs for project B' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'outputs'`), { label: 'outputs destination for project B' });
    const outputsRailB = await cdp.evaluate(`document.querySelector('[data-destination="outputs"] .p36-rail')?.innerText || ''`);
    assert.doesNotMatch(outputsRailB, /知识卡（\d+）/, `项目 B 产物栏不得出现 A 的知识卡计数：${outputsRailB}`);
    await click(cdp, { selector: '.p36-rail-item', text: '知识卡', label: 'cards rail for project B' });
    await waitFor(() => cdp.evaluate(`document.querySelector('${OUTPUTS_CANVAS}')?.innerText.includes('还没有知识卡')`), { label: 'no cards in project B' });
    await click(cdp, { selector: '.p36-rail-item', text: 'Brief', label: 'brief rail for project B' });
    await waitFor(() => cdp.evaluate(`document.querySelector('${OUTPUTS_CANVAS}')?.innerText.includes('尚未生成')`), { label: 'no brief in project B' });
    const briefCanvasB = await cdp.evaluate(`document.querySelector('${OUTPUTS_CANVAS}')?.innerText || ''`);
    assert.doesNotMatch(briefCanvasB, /已批准|批准草案|审核记录/, `项目 B 不得出现 A 的已批准 Brief 或其审核记录：${briefCanvasB.slice(0, 300)}`);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-destination="outputs"] [data-testid="m3-decision-audit"]').length`), 0, '项目 B 不得存在审核记录审计节点');
    await click(cdp, { selector: '.p36-rail-item', text: '交接包', label: 'handoff rail for project B' });
    await waitFor(() => cdp.evaluate(`document.querySelector('${OUTPUTS_CANVAS}')?.innerText.includes('还没有交接包')`), { label: 'no handoff in project B' });
    const handoffCanvasB = await cdp.evaluate(`document.querySelector('${OUTPUTS_CANVAS}')?.innerText || ''`);
    assert.doesNotMatch(handoffCanvasB, /handoff-pkg-|绑定 Brief/, `项目 B 不得出现 A 的交接包：${handoffCanvasB.slice(0, 300)}`);
    const outputsTextB = await cdp.evaluate(`document.querySelector('[data-destination="outputs"]')?.innerText || ''`);
    assert.doesNotMatch(outputsTextB, /qwen3\.5-omni-flash|¥0\.05|0\.0042|预留 bbbbbbbb|M3 浏览器帖子 1-/, `A 的分析与费用不得泄漏进 B 的产物区：${outputsTextB.slice(0, 300)}`);

    // 分析目的地：确认当前项目与选中 Evidence 均精确绑定 B，再运行确定性分析。
    await click(cdp, { selector: '[data-destination-tab="analyze"]', label: 'analyze for project B' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'analyze'`), { label: 'analyze destination for project B' });
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('${ACTIVE_ANALYZE} .p36-rail-item.selected'))`), { label: 'evidence auto-selected in project B' });
    const bBinding = await cdp.evaluate(`(() => {
      const dest = document.querySelector('${ACTIVE_ANALYZE}');
      const railItems = [...dest.querySelectorAll('.p36-rail-item')];
      const selected = dest.querySelector('.p36-rail-item.selected');
      const summary = dest.querySelector('.p36-source-summary');
      return {
        railCount: railItems.length,
        selectedTitle: selected ? selected.getAttribute('title') : '',
        selectedText: selected ? selected.textContent : '',
        summaryHead: summary ? summary.querySelector('h3')?.textContent : '',
        summaryText: summary ? summary.textContent : '',
      };
    })()`);
    assert.equal(bBinding.railCount, 1, '项目 B 必须只有一条独立来源');
    assert.equal(bBinding.selectedTitle, bSourceUrl, `选中 Evidence 必须精确绑定 B 的来源：${bBinding.selectedTitle}`);
    assert.match(bBinding.selectedText, /M3 浏览器帖子 2-1/, `选中 Evidence 必须是 B 的帖子：${bBinding.selectedText}`);
    assert.match(bBinding.selectedText, /尚未分析/, `B 的来源在运行前必须尚未分析：${bBinding.selectedText}`);
    assert.equal(bBinding.summaryHead, 'M3 浏览器帖子 2-1', `选中来源摘要必须绑定 B：${bBinding.summaryHead}`);
    assert.match(bBinding.summaryText, /M3 浏览器真实帖子 2-1：验证在线闭环。/, `选中来源内容必须绑定 B：${bBinding.summaryText}`);
    const analyzeTextB = await cdp.evaluate(`document.querySelector('${ACTIVE_ANALYZE}')?.innerText || ''`);
    // 项目 A 的精确身份与数据绝不泄漏进 B 的分析区：A 的准确证据 ID、来源 URL、
    // 帖子标题、Qwen 模型身份、token/CNY/USD 费用与 reservation。通用界面文案
    // 「多模态模型分析」是 B 自身未分析状态的合法操作说明（P36 空态引导），
    // 不属于 A 的身份特征，不在禁止之列。
    assert.doesNotMatch(analyzeTextB, new RegExp(evidenceIds.a.map(escapeRegExp).join('|')), `A 的准确证据 ID 不得泄漏进 B 的分析区：${analyzeTextB.slice(0, 300)}`);
    assert.doesNotMatch(analyzeTextB, new RegExp([aFirstSourceUrl, aSecondSourceUrl].map(escapeRegExp).join('|')), `A 的准确来源 URL 不得泄漏进 B 的分析区：${analyzeTextB.slice(0, 300)}`);
    assert.doesNotMatch(analyzeTextB, /M3 浏览器帖子 1-1|M3 浏览器帖子 1-2/, `A 的准确帖子标题不得泄漏进 B 的分析区：${analyzeTextB.slice(0, 300)}`);
    assert.doesNotMatch(analyzeTextB, /qwen3\.5-omni-flash/, `A 的 Qwen 模型身份不得泄漏进 B 的分析区：${analyzeTextB.slice(0, 300)}`);
    assert.doesNotMatch(analyzeTextB, /900 tokens/, `A 的 token 用量不得泄漏进 B 的分析区：${analyzeTextB.slice(0, 300)}`);
    assert.doesNotMatch(analyzeTextB, /¥0\.05|（\$0\.0042）/, `A 的 CNY/USD 费用不得泄漏进 B 的分析区：${analyzeTextB.slice(0, 300)}`);
    assert.doesNotMatch(analyzeTextB, /预留 bbbbbbbb/, `A 的 reservation 不得泄漏进 B 的分析区：${analyzeTextB.slice(0, 300)}`);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('${ANALYZE_RESULT_COL} [data-testid="m3-analysis-cost"]').length`), 0, '运行前 B 的结果容器不得出现任何费用行（A 的费用绝不泄漏）');

    // 项目 B 确定性本地分析：无费用展示（绝不伪装为付费调用）。
    await click(cdp, { selector: `${ACTIVE_ANALYZE} .p36-result-actions button`, text: '运行确定性分析', label: 'run deterministic analysis in project B' });
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('${ANALYZE_RESULT_COL} [data-testid="m3-analysis-cost"]').length === 1`), { label: 'deterministic no-cost line in active analyze result container' });
    const detCost = await cdp.evaluate(`(() => { const nodes = document.querySelectorAll('${ANALYZE_RESULT_COL} [data-testid="m3-analysis-cost"]'); return nodes.length === 1 ? nodes[0].textContent : ''; })()`);
    assert.match(detCost, /未调用任何模型、不产生任何费用/, `确定性分析必须如实显示无费用：${detCost}`);
    // 严格证明不包含 Qwen、token、人民币/美元费用或 reservation。
    assert.doesNotMatch(detCost, /qwen/i, `确定性费用行不得包含 Qwen 身份：${detCost}`);
    assert.doesNotMatch(detCost, /tokens?/i, `确定性费用行不得包含 token 用量：${detCost}`);
    assert.doesNotMatch(detCost, /¥|￥/, `确定性费用行不得包含人民币费用：${detCost}`);
    assert.doesNotMatch(detCost, /\$\s*\d|usd|cny/i, `确定性费用行不得包含美元费用：${detCost}`);
    assert.doesNotMatch(detCost, /预留|reservation/i, `确定性费用行不得包含 reservation：${detCost}`);
    assert.doesNotMatch(detCost, /0\.0042|0\.05/, `确定性费用行不得包含 A 的精确费用数值：${detCost}`);
    const detDetailB = await cdp.evaluate(`document.querySelector('${ANALYZE_RESULT_COL}')?.innerText || ''`);
    assert.match(detDetailB, /确定性本地分析（未调用任何模型）/, `B 必须渲染确定性本地分析结果：${detDetailB.slice(0, 200)}`);
    assert.match(detDetailB, /deterministic_local/, `B 的结果必须标记 deterministic_local：${detDetailB.slice(0, 200)}`);
    const detPreB = await cdp.evaluate(`document.querySelector('${ANALYZE_RESULT_COL} .p19-pre')?.textContent || ''`);
    assert.ok(detPreB.includes('证据ID') && detPreB.includes(evidenceIds.b[0]), `确定性结果容器必须精确绑定项目 B 的证据：${detPreB.slice(0, 200)}`);

    // ---- 切回项目 A：已批准 Brief、Handoff、Qwen 分析身份与准确费用必须完整保留 ----
    await switchProject(0, '切回项目 A');
    assert.equal(await cdp.evaluate(`document.querySelector('.p19-project-select select').value`), projectIds[0], '项目 A 必须被重新选中');

    await click(cdp, { selector: '[data-destination-tab="outputs"]', label: 'outputs for project A again' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'outputs'`), { label: 'outputs destination for project A again' });
    const outputsRailA = await cdp.evaluate(`document.querySelector('[data-destination="outputs"] .p36-rail')?.innerText || ''`);
    assert.match(outputsRailA, /知识卡（1）/, `项目 A 的知识卡计数必须保留：${outputsRailA}`);
    await click(cdp, { selector: '.p36-rail-item', text: '知识卡', label: 'cards rail for project A again' });
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p19-card-item').length === 1`), { label: 'knowledge card of project A again' });

    await click(cdp, { selector: '.p36-rail-item', text: 'Brief', label: 'brief rail for project A again' });
    await waitFor(() => cdp.evaluate(`document.querySelector('${OUTPUTS_CANVAS}')?.innerText.includes('内容策划草案')`), { label: 'brief panel for project A again' });
    const briefCanvasA = await cdp.evaluate(`document.querySelector('${OUTPUTS_CANVAS}')?.innerText || ''`);
    assert.match(briefCanvasA, /已批准/, `A 的 Brief 必须保持已批准：${briefCanvasA.slice(0, 300)}`);
    assert.match(briefCanvasA, /第 1 版/, `A 的 Brief 必须仍是第 1 版：${briefCanvasA.slice(0, 300)}`);
    assert.match(briefCanvasA, /决定：批准/, `A 的人工批准决定必须保留：${briefCanvasA.slice(0, 300)}`);
    assert.match(briefCanvasA, /审核记录/, `A 的审核记录审计必须保留：${briefCanvasA.slice(0, 300)}`);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-destination="outputs"] [data-testid="m3-decision-audit"]').length`), 1, 'A 必须仍存在审核记录审计节点');

    await click(cdp, { selector: '.p36-rail-item', text: '交接包', label: 'handoff rail for project A again' });
    await waitFor(() => cdp.evaluate(`document.querySelector('${OUTPUTS_CANVAS}')?.innerText.includes('handoff-pkg-')`), { label: 'handoff of project A again' });
    const handoffCanvasA = await cdp.evaluate(`document.querySelector('${OUTPUTS_CANVAS}')?.innerText || ''`);
    assert.match(handoffCanvasA, /绑定 Brief/, `A 的交接包必须仍绑定 Brief：${handoffCanvasA.slice(0, 300)}`);
    assert.match(handoffCanvasA, /第 1 版（approved）/, `A 的交接包必须仍绑定已批准第 1 版：${handoffCanvasA.slice(0, 300)}`);

    await click(cdp, { selector: '[data-destination-tab="analyze"]', label: 'analyze for project A again' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'analyze'`), { label: 'analyze destination for project A again' });
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('${ACTIVE_ANALYZE} .p36-rail-item.selected'))`), { label: 'evidence auto-selected in project A again' });
    const aBinding = await cdp.evaluate(`(() => {
      const dest = document.querySelector('${ACTIVE_ANALYZE}');
      const selected = dest.querySelector('.p36-rail-item.selected');
      return {
        selectedTitle: selected ? selected.getAttribute('title') : '',
        selectedText: selected ? selected.textContent : '',
      };
    })()`);
    assert.equal(aBinding.selectedTitle, aFirstSourceUrl, `切回后选中 Evidence 必须仍绑定 A 的第一条来源：${aBinding.selectedTitle}`);
    assert.match(aBinding.selectedText, /M3 浏览器帖子 1-1/, `切回后选中 Evidence 必须仍是 A 的帖子：${aBinding.selectedText}`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('${ANALYZE_RESULT_COL} [data-testid="m3-analysis-cost"]').length === 1`), { label: 'bound cost line of project A again' });
    const aCostText = await cdp.evaluate(`(() => { const nodes = document.querySelectorAll('${ANALYZE_RESULT_COL} [data-testid="m3-analysis-cost"]'); return nodes.length === 1 ? nodes[0].textContent : ''; })()`);
    assert.match(aCostText, /qwen3\.5-omni-flash/, `切回后 A 的 Qwen 分析身份必须保留：${aCostText}`);
    assert.match(aCostText, /900 tokens/, `切回后 A 的用量必须保留：${aCostText}`);
    assert.match(aCostText, /费用 ¥0\.05/, `切回后 A 的准确费用必须保留：${aCostText}`);
    assert.match(aCostText, /（\$0\.0042）/, `切回后 A 的美元费用必须保留：${aCostText}`);
    assert.match(aCostText, /预留 bbbbbbbb/, `切回后 A 的预留身份必须保留：${aCostText}`);
    const aPreText = await cdp.evaluate(`document.querySelector('${ANALYZE_RESULT_COL} .p19-pre')?.textContent || ''`);
    assert.ok(aPreText.includes('证据ID') && aPreText.includes(evidenceIds.a[0]), `切回后 A 的结果容器必须精确绑定 A 的证据：${aPreText.slice(0, 200)}`);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
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
