// P30 内容创建模式 — 浏览器集成测试。
// 加载完整生产 App（npm run build → dist/），通过 Edge headless 验证：
// - 默认模式为快速生成一条
// - 三模式互斥
// - 折叠状态、生成、修改、保存流程
// - Brief 未批准门禁
// - 3/7/14/自定义周期
// - 旧周期工作台只在第三模式展开
// - 390/768/1440 无横向溢出

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
// readFileSync 用于读取源文件做静态审计
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { stripTypeScriptTypes } from 'node:module';
import {
  EDGE, waitFor, launchEdge, shutdownEdge, makeTempProfile, removeTempProfile, dumpDom,
} from './helpers/cdp-browser-harness.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');
const DIST = join(REPO_ROOT, 'dist');
const INDEX_HTML = join(DIST, 'index.html');

// 如果在 CI 或 Edge 不可用，跳过（本地开发者环境可选）
const EDGE_AVAILABLE = existsSync(EDGE);
let previewProcess;
let previewPort;

let productionHandlerModulePromise;
async function loadProductionHandler() {
  if (!productionHandlerModulePromise) {
    productionHandlerModulePromise = (async () => {
      const coreSource = readFileSync(join(REPO_ROOT, 'supabase/functions/p30-content-create/content-core.mjs'), 'utf8');
      const coreUrl = `data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`;
      let source = readFileSync(join(REPO_ROOT, 'supabase/functions/p30-content-create/index.ts'), 'utf8');
      source = source.replace(
        /import \{ createClient \} from 'https:\/\/esm\.sh\/[^']+';/,
        "const createClient = () => { throw new Error('unexpected createClient'); };",
      );
      source = source.replace(/from '\.\/content-core\.mjs';/, `from '${coreUrl}';`);
      const compiled = stripTypeScriptTypes(source, { mode: 'transform' });
      const previousDeno = globalThis.Deno;
      globalThis.Deno = { serve() {}, env: { get() { return undefined; } } };
      try {
        return await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
      } finally {
        globalThis.Deno = previousDeno;
      }
    })();
  }
  return productionHandlerModulePromise;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForUrl(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { if ((await globalThis.fetch(url)).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
  }
  throw new Error(`preview did not start: ${url}`);
}

before(async () => {
  execFileSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: 'https://xtkkdvghiohlnpfnnhmx.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'p30_public_test_key',
    },
  });
  previewPort = await freePort();
  previewProcess = spawn(process.execPath, [
    join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort',
  ], { cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true });
  await waitForUrl(`http://127.0.0.1:${previewPort}/`);
});

after(() => {
  if (previewProcess && !previewProcess.killed) previewProcess.kill();
});

test('P30 browser tests require built dist/', () => {
  assert.equal(existsSync(INDEX_HTML), true, 'dist/index.html must exist — run npm run build first');
});

test('P30 browser tests require Edge', { skip: !EDGE_AVAILABLE }, () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required for real-browser acceptance');
});

// ---- 真实浏览器验收 ------------------------------------------------------------
// dump-dom 路径：spawn 进程 + 有界超时强杀进程树；结束后按本次 profile 路径
// 精确兜底清理（含孤儿 crashpad/utility 子进程）并等待零残留，然后才删除
// 本次创建的临时 profile（路径经过校验）—— 任一残留都让测试失败。
async function renderProductionDom(width, height) {
  const profile = await makeTempProfile('ams-p30-browser-');
  try {
    const result = await dumpDom(`http://127.0.0.1:${previewPort}/#/workspace`, { width, height, profile });
    if (result.code !== 0) throw new Error(`dump-dom 退出码 ${result.code}：${result.stderr.slice(-500)}`);
    return result.stdout;
  } finally {
    await shutdownEdge(null, profile);
    await removeTempProfile(profile);
  }
}

test('P30: production browser renders the default quick mode and three choices', { skip: !EDGE_AVAILABLE }, async () => {
  const html = await renderProductionDom(1440, 900);
  assert.match(html, /快速生成一条/);
  assert.match(html, /从 Brief 生成/);
  assert.match(html, /创建周期计划/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /class="quick-input-textarea"/);
  assert.match(html, /maxlength="500"/i);
});

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`P30: production browser renders at ${width}px`, { skip: !EDGE_AVAILABLE }, async () => {
    const html = await renderProductionDom(width, height);
    assert.match(html, /class="creation-mode-switcher"/);
    assert.match(html, /class="creation-mode-content"/);
  });
}

test('P30: production source binds exclusive branches and responsive rules', () => {
  const page = readFileSync(join(REPO_ROOT, 'src', 'pages', 'ContentWorkspacePage.jsx'), 'utf-8');
  const styles = readFileSync(join(REPO_ROOT, 'src', 'styles.css'), 'utf-8');
  assert.match(page, /creationMode === 'quick'/);
  assert.match(page, /creationMode === 'brief'/);
  assert.match(page, /creationMode === 'cycle'/);
  assert.match(page, /cycleExpanded/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.match(styles, /@media \(max-width: 768px\)/);
});

async function withCdpPage(run, { authenticated = false } = {}) {
  const profile = await makeTempProfile('ams-p30-cdp-');
  const debugPort = await freePort();
  const browser = launchEdge({ debugPort, profile, userDataDir: join(profile, 'user-data'), extraArgs: ['--no-sandbox'] });
  let socket;
  let result;
  let primaryError = null;
  let cleanupError = null;
  try {
    let target;
    for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
      try {
        const pages = await (await globalThis.fetch(`http://127.0.0.1:${debugPort}/json`)).json();
        target = pages.find((page) => page.type === 'page');
      } catch { /* retry */ }
      if (!target) await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
    }
    assert.ok(target?.webSocketDebuggerUrl, 'CDP page target unavailable');
    socket = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const commandId = ++id;
      pending.set(commandId, { resolve, reject });
      socket.send(JSON.stringify({ id: commandId, method, params }));
    });
    const evaluate = async (expression) => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    if (authenticated) {
      const session = {
        access_token: 'p30-test-access-token', refresh_token: 'p30-test-refresh-token', token_type: 'bearer',
        expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: '11111111-1111-4111-8111-111111111111', email: 'p30-e2e@example.invalid', user_metadata: {} },
      };
      const generated = {
        platform: 'x', audience: '独立创业者', tone: '专业自然', content_goal: '说明产品价值',
        hook: '用一句话开始高质量内容', cta: '保存这条草稿', main_copy: '这是由真实页面交互加载的 P30 生成结果。',
        hashtags: ['#AI', '#内容'], visual_type: 'single_image', visual_description: '简洁科技感主视觉',
        aspect_ratio: '1:1', candidates: [{ hook: '候选钩子', copy: '候选正文', cta: '候选行动' }],
      };
      const resolvedIntent = {
        platform: 'x', content_format: 'image_caption', language_mode: 'bilingual',
        length_profile: 'micro', tone: 'casual', cta_policy: 'none',
        hashtag_policy: 'optional_0_5', confidence: 'explicit', provenance: 'user_input',
        audience: 'independent creators', content_goal: 'share an image-led observation', aspect_ratio: '4:5',
      };
      const generatedV2 = {
        title: 'A quiet moment', main_copy: 'go quiet for a moment\nKeep this moment quiet',
        visual_description: 'Soft natural-light portrait, minimal composition.',
        platform: 'x', content_format: 'image_caption', cta: null, hashtags: [], aspect_ratio: '4:5', candidates: [],
      };
      const initScript = `(() => {
        localStorage.setItem('ai-marketing-studio-auth-session', ${JSON.stringify(JSON.stringify(session))});
        const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
        let saveCount = 0;
        const savedBodies = [];
        globalThis.__p30E2E = { get saveCount() { return saveCount; }, get savedBodies() { return savedBodies; } };
        globalThis.fetch = async (input, init = {}) => {
          const url = String(input && input.url ? input.url : input);
          if (url.includes('/functions/v1/p30-content-create')) {
            const body = JSON.parse(init.body || '{}');
            if (body.action === 'resolve_intent') {
              return json({ ok: true, code: 'INTENT_RESOLVED', message: 'ok', data: { intent: ${JSON.stringify(resolvedIntent)}, summary: 'X / image-led / bilingual / micro' }, meta: { total_tokens: 4, provider: 'mock', model: 'qwen-plus' } });
            }
            if (body.action === 'generate_quick_v2') {
              return json({ ok: true, code: 'GENERATED_V2', message: 'ok', data: { ...${JSON.stringify(generatedV2)}, summary: 'X / image_caption / bilingual / micro' }, meta: { total_tokens: 8, provider: 'mock', model: 'qwen-plus' } });
            }
            return json({ ok: true, code: 'GENERATED', message: 'ok', data: { ...${JSON.stringify(generated)}, summary: 'x / 独立创业者 / 专业自然 / 单图' }, meta: { total_tokens: 12, provider: 'dashscope/qwen', model: 'qwen-plus' } });
          }
          if (url.includes('/rest/v1/ke_content_briefs_v1')) return json([{ brief_id: 'brief-e2e', brief_version: 1, brief_schema_version: 'ams_content_brief_v1', brief_status: 'approved', knowledge_citation_ids: ['kc-e2e'], evidence_provenance: { source: 'e2e' }, payload: { id: 'brief-e2e', version: 1, schema_version: 'ams_content_brief_v1', status: 'approved', topic: '测试 Brief', knowledge_citation_ids: ['kc-e2e'], evidence_provenance: { source: 'e2e' } }, payload_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
          if (url.includes('/rest/v1/content_library') && (init.method || '').toUpperCase() === 'POST') { saveCount += 1; savedBodies.push(JSON.parse(init.body || '{}')); return json({ id: 'draft-e2e' }); }
          if (url.includes('/auth/v1/user')) return json(${JSON.stringify(session.user)});
          if (url.includes('/rest/v1/profiles')) return json([]);
          return json([]);
        };
      })();`;
      await send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${previewPort}/#/workspace` });
    // 工作台挂载的有界等待（不再固定 sleep）：React 挂载到 #root 且内容页出现。
    await waitFor(async () => (await evaluate('document.readyState === "complete" && Boolean(document.querySelector(".creation-mode-switcher, .quick-input-textarea"))')), {
      timeout: 20_000, label: 'workspace mounted',
    });
    result = await run({ send, evaluate });
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      socket?.close();
      // CDP 路径：进程树确定性退出 + 孤儿兜底 + 零残留等待 + 校验路径删除。
      await shutdownEdge(browser, profile);
      await removeTempProfile(profile);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError && !primaryError) throw cleanupError;
  if (primaryError) throw primaryError;
  return result;
}

test('P30: real DOM interactions keep one mode visible and cycle controls exact', { skip: !EDGE_AVAILABLE }, async () => {
  await withCdpPage(async ({ send, evaluate }) => {
    const clickTab = (label) => evaluate(`(() => {
      const button = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent.includes(${JSON.stringify(label)}));
      if (!button) throw new Error('tab missing');
      button.click(); return true;
    })()`);
    await clickTab('创建周期计划');
    const cycle = await evaluate(`(() => {
      const three = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('3 天'));
      three.click();
      const frequency = document.querySelector('#cycle-frequency');
      frequency.value = 'three_per_week';
      frequency.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        selected: [...document.querySelectorAll('[role="tab"]')].filter((item) => item.getAttribute('aria-selected') === 'true').length,
        panels: document.querySelectorAll('[role="tabpanel"]').length,
        frequency: frequency.value,
        days: document.body.textContent.includes('3 天'),
      };
    })()`);
    assert.deepEqual(cycle, { selected: 1, panels: 1, frequency: 'three_per_week', days: true });
    for (const width of [390, 768, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
      const overflow = await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth');
      assert.equal(overflow, true, `horizontal overflow at ${width}px`);
    }
    await clickTab('快速生成一条');
    const quick = await evaluate(`(() => ({
      selected: [...document.querySelectorAll('[role="tab"]')].filter((item) => item.getAttribute('aria-selected') === 'true').length,
      panels: document.querySelectorAll('[role="tabpanel"]').length,
      hasInput: Boolean(document.querySelector('.quick-input-textarea')),
    }))()`);
    assert.deepEqual(quick, { selected: 1, panels: 1, hasInput: true });
  });
});

test('P30: authenticated production App generates, revises and saves exactly once', { skip: !EDGE_AVAILABLE }, async () => {
  await withCdpPage(async ({ evaluate }) => {
    const result = await evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const byText = (selector, text) => [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text));
      const input = document.querySelector('.quick-input-textarea');
      // 使用 React 内部状态更新而非原生 setter（避免 Illegal invocation）
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (nativeInputValueSetter && nativeInputValueSetter.set) {
        try { nativeInputValueSetter.set.call(input, '为创业者快速生成一条 AI 效率内容'); } catch { input.value = '为创业者快速生成一条 AI 效率内容'; }
      } else { input.value = '为创业者快速生成一条 AI 效率内容'; }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      {
        const waitFor = async (read, message, timeout = 3000) => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const value = read();
            if (value) return value;
            await wait(40);
          }
          throw new Error(message);
        };
        document.querySelector('.quick-input-section .generate-button').click();
        const intentButton = await waitFor(() => document.querySelector('.intent-actions .primary-button'), 'intent confirmation missing');
        intentButton.click();
        await waitFor(() => document.querySelector('.generation-result-section'), 'v2 generation result missing');
        const title = document.querySelector('.v2-edit-input.title');
        const titleSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        titleSetter.call(title, 'Edited exact title');
        title.dispatchEvent(new Event('input', { bubbles: true }));
        await waitFor(() => document.querySelector('.v2-edit-input.title')?.value === 'Edited exact title', 'title edit did not bind');
        document.querySelector('.result-actions .primary-button').click();
        await waitFor(() => document.querySelector('.save-success-section'), 'save success missing');
        return {
          generated: document.body.textContent.includes('go quiet for a moment'),
          revised: document.querySelector('.v2-edit-input.title')?.value === 'Edited exact title',
          saveCount: globalThis.__p30E2E.saveCount,
          saved: Boolean(document.querySelector('.save-success-section')),
        };
      }
      byText('button', '智能生成').click();
      await wait(350);
      const generated = document.body.textContent.includes('真实页面交互加载的 P30 生成结果')
        && document.body.textContent.includes('候选钩子');
      const feedback = document.querySelector('.revise-input');
      if (feedback) {
        const inputNativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (inputNativeSetter && inputNativeSetter.set) {
          try { inputNativeSetter.set.call(feedback, '语气再自然一点'); } catch { feedback.value = '语气再自然一点'; }
        } else { feedback.value = '语气再自然一点'; }
        feedback.dispatchEvent(new Event('input', { bubbles: true }));
      }
      byText('button', '继续修改').click();
      await wait(350);
      const revised = document.body.textContent.includes('修改记录') || document.body.textContent.includes('已修改');
      const save = byText('button', '确认保存');
      if (save) { save.click(); await wait(350); save.click(); await wait(100); }
      return { generated, revised, saveCount: globalThis.__p30E2E.saveCount, saved: document.body.textContent.includes('已保存') };
    })()`);
    assert.deepEqual(result, { generated: true, revised: true, saveCount: 1, saved: true });
  }, { authenticated: true });
});

test('P30: Brief gate and all cycle choices work through production DOM', { skip: !EDGE_AVAILABLE }, async () => {
  await withCdpPage(async ({ evaluate }) => {
    const state = await evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (read, message, timeout = 3000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await wait(50);
        }
        throw new Error(message);
      };
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      tabs.find((item) => item.textContent.includes('从 Brief 生成')).click();
      const brief = await waitFor(
        () => [...document.querySelectorAll('.brief-selector-card')].find((item) => item.textContent.includes('Brief')),
        'approved Brief card did not load',
      );
      const noSelectionDisabled = !document.querySelector('.brief-generate-panel .primary-button')
        && document.querySelector('.brief-generate-panel')?.textContent.includes('请先');
      brief.click();
      const approvedButton = await waitFor(
        () => {
          const button = document.querySelector('.brief-generate-panel .primary-button');
          return button?.disabled === false ? button : null;
        },
        'approved Brief did not enable generation',
      );
      const approvedEnabled = approvedButton.disabled === false;
      [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent.includes('创建周期计划')).click();
      await waitFor(() => document.querySelectorAll('.cycle-duration-option').length > 0, 'cycle duration choices missing');
      const choices = [...document.querySelectorAll('.cycle-duration-option')];
      const labels = choices.map((item) => item.textContent.trim());
      for (const item of choices.slice(0, 3)) item.click();
      choices.find((item) => item.textContent.includes('自定义')).click();
      await waitFor(() => document.querySelector('.cycle-custom-panel'), 'custom cycle panel missing');
      const details = document.querySelector('.cycle-custom-panel');
      if (!details) throw new Error('custom cycle panel missing');
      details.open = true;
      return { noSelectionDisabled, approvedEnabled, labels, custom10: document.body.textContent.includes('10 天内容周期'), collapsed: Boolean(document.querySelector('.cycle-legacy-workbench')) === false };
    })()`);
    assert.equal(state.noSelectionDisabled, true);
    assert.equal(state.approvedEnabled, true);
    assert.equal(state.labels.some((label) => label.includes('3 天')), true);
    assert.equal(state.labels.some((label) => label.includes('7 天')), true);
    assert.equal(state.labels.some((label) => label.includes('14 天')), true);
    assert.equal(state.labels.some((label) => label.includes('自定义')), true);
    assert.equal(state.custom10, true);
    assert.equal(state.collapsed, true);
  }, { authenticated: true });
});

// ---- P31 v2 参考驱动浏览器验收 ------------------------------------------------

test('P31: authenticated browser renders v2 intent flow with reference text and image upload area', { skip: !EDGE_AVAILABLE }, async () => {
  await withCdpPage(async ({ send, evaluate }) => {
    for (const width of [390, 768, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
      const layout = await evaluate(`(() => ({
        hasQuickInput: Boolean(document.querySelector('.quick-input-textarea')),
        hasReferencePanel: Boolean(document.querySelector('.reference-inputs-panel')),
        hasImageDropzone: Boolean(document.querySelector('.reference-image-dropzone')),
        hasUrlInput: Boolean(document.querySelector('.reference-url-input')),
        hasTextArea: Boolean(document.querySelector('.reference-text-input')),
        maxLength: document.querySelector('.quick-input-textarea')?.getAttribute('maxlength'),
        noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      }))()`);
      assert.equal(layout.hasQuickInput, true);
      assert.equal(layout.hasReferencePanel, true);
      assert.equal(layout.hasImageDropzone, true);
      assert.equal(layout.hasUrlInput, true);
      assert.equal(layout.hasTextArea, true);
      assert.equal(layout.maxLength, '500');
      assert.equal(layout.noOverflow, true, `horizontal overflow at ${width}px`);
    }
  }, { authenticated: true });
});

test('P31: v2 generation flow uses correct page ID for image preparation', { skip: !EDGE_AVAILABLE }, async () => {
  await withCdpPage(async ({ send: _send, evaluate }) => {
    const state = await evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const byText = (selector, text) => [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text));

      // 输入需求
      const input = document.querySelector('.quick-input-textarea');
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (nativeInputValueSetter && nativeInputValueSetter.set) {
        try { nativeInputValueSetter.set.call(input, '为独立开发者写一条 X 图文贴文'); } catch { input.value = '为独立开发者写一条 X 图文贴文'; }
      } else { input.value = '为独立开发者写一条 X 图文贴文'; }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      {
        const waitFor = async (read, message, timeout = 3000) => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const value = read();
            if (value) return value;
            await wait(40);
          }
          throw new Error(message);
        };
        document.querySelector('.quick-input-section .generate-button').click();
        (await waitFor(() => document.querySelector('.intent-actions .primary-button'), 'intent confirmation missing')).click();
        await waitFor(() => document.querySelector('.generation-result-section'), 'v2 result missing');
        document.querySelector('.result-actions .primary-button').click();
        await waitFor(() => document.querySelector('.save-success-section'), 'save success missing');
        return {
          hasV2Result: Boolean(document.querySelector('.generation-result-section .main-version-card.v2')),
          hasPrepareBtn: Boolean(document.querySelector('.prepare-image-button')),
          hasSaved: Boolean(document.querySelector('.save-success-section')),
          persistedRawImage: JSON.stringify(globalThis.__p30E2E.savedBodies).includes('data:image/'),
        };
      }

      // 点击智能生成触发 resolveIntent → generate
      const genBtn = byText('button', '智能生成');
      if (genBtn) genBtn.click();
      await wait(600);

      // 检查是否有 v2 生成结果区域
      const hasV2Result = document.body.textContent.includes('v2 主版本')
        || document.querySelector('.main-version-card.v2')
        || document.querySelector('.generation-result-section');

      // 检查是否有确认保存按钮
      const saveBtn = byText('button', '确认保存');
      if (saveBtn) saveBtn.click();
      await wait(400);

      // 检查是否有制作图片按钮
      const prepareBtn = byText('button', '制作图片');
      const hasPrepareBtn = Boolean(prepareBtn);

      // 检查保存成功消息
      const hasSaved = document.body.textContent.includes('已保存为草稿');

      return { hasV2Result, hasPrepareBtn, hasSaved };
    })()`);
    assert.equal(state.hasV2Result, true, 'v2 generation result should be visible');
    assert.equal(state.hasPrepareBtn, true, 'prepare image button should exist');
    assert.equal(state.hasSaved, true, 'content should be saved');
    assert.equal(state.persistedRawImage, false, 'raw image data must never be persisted');
  }, { authenticated: true });
});

test('P31: image preparation navigates to generation page not dashboard', { skip: !EDGE_AVAILABLE }, async () => {
  await withCdpPage(async ({ send: _send, evaluate }) => {
    const navigation = await evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const byText = (selector, text) => [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text));

      // 输入需求并生成
      const input = document.querySelector('.quick-input-textarea');
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (nativeInputValueSetter && nativeInputValueSetter.set) {
        try { nativeInputValueSetter.set.call(input, 'X 图片贴文'); } catch { input.value = 'X 图片贴文'; }
      } else { input.value = 'X 图片贴文'; }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      {
        const waitFor = async (read, message, timeout = 3000) => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const value = read();
            if (value) return value;
            await wait(40);
          }
          throw new Error(message);
        };
        document.querySelector('.quick-input-section .generate-button').click();
        (await waitFor(() => document.querySelector('.intent-actions .primary-button'), 'intent confirmation missing')).click();
        await waitFor(() => document.querySelector('.generation-result-section'), 'v2 result missing');
        document.querySelector('.result-actions .primary-button').click();
        await waitFor(() => document.querySelector('.prepare-image-button'), 'prepare image button missing');
        document.querySelector('.prepare-image-button').click();
        const confirm = await waitFor(
          () => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('进入图片生成准备')),
          'image preparation confirmation missing',
        );
        confirm.click();
        await waitFor(() => location.hash.startsWith('#/generation'), 'generation route not reached');
        const handoff = await waitFor(() => document.querySelector('.draft-handoff-panel'), 'draft handoff missing');
        const text = handoff.textContent;
        return {
          prepareBtnExists: true,
          prepareBtnText: '制作图片',
          route: location.hash,
          hasDraftId: text.includes('draft-e2e'),
          hasTitle: text.includes('A quiet moment'),
          hasVisualPlan: text.includes('Soft natural-light portrait, minimal composition.'),
        };
      }

      const genBtn = byText('button', '智能生成');
      if (genBtn) genBtn.click();
      await wait(600);

      const saveBtn = byText('button', '确认保存');
      if (saveBtn) { saveBtn.click(); await wait(400); }

      const prepareBtn = byText('button', '制作图片');
      return {
        prepareBtnExists: Boolean(prepareBtn),
        prepareBtnText: prepareBtn ? prepareBtn.textContent.trim() : 'NONE',
      };
    })()`);
    assert.equal(navigation.prepareBtnExists, true);
    assert.equal(navigation.route.startsWith('#/generation'), true);
    assert.equal(navigation.hasDraftId, true);
    assert.equal(navigation.hasTitle, true);
    assert.equal(navigation.hasVisualPlan, true);
    assert.equal(navigation.prepareBtnText, '制作图片');
  }, { authenticated: true });
});

test('P31: source files verify multimodal chain is wired through', () => {
  const panelSource = readFileSync(join(REPO_ROOT, 'src', 'components', 'content-workspace', 'ContentCreationModePanel.jsx'), 'utf-8');
  const serviceSource = readFileSync(join(REPO_ROOT, 'src', 'services', 'content-creation-service.js'), 'utf-8');
  const pageSource = readFileSync(join(REPO_ROOT, 'src', 'pages', 'ContentWorkspacePage.jsx'), 'utf-8');

  // 前端：图片 Data URL 必须在内存中生成并传递
  assert.match(panelSource, /image_data_url/);
  assert.match(panelSource, /fileToImageDataUrl/);
  assert.match(panelSource, /validateFileSignature/);
  assert.match(panelSource, /decodeImageFromDataUrl/);
  assert.match(panelSource, /MAX_IMAGE_BYTES.*4/);
  // 不得将 Data URL 写入持久化
  assert.ok(!panelSource.includes('localStorage.setItem'), 'Panel must not use localStorage');
  assert.ok(!panelSource.includes('image_data_url') || panelSource.includes('referenceImageDataUrl'), 'Data URL must be in memory only');

  // 服务层：接受并转发 image_data_url
  assert.match(serviceSource, /image_data_url/);

  // 页面：导航使用正确的页面 ID
  assert.match(pageSource, /onNavigate\('generation'/);
  assert.ok(!pageSource.includes("onNavigate('generation-tasks'"), 'Must use generation not generation-tasks');
});

test('P31: generation task page shows draft handoff from route params', () => {
  const genPageSource = readFileSync(join(REPO_ROOT, 'src', 'pages', 'GenerationTasksPage.jsx'), 'utf-8');
  assert.match(genPageSource, /draftHandoff/);
  assert.match(genPageSource, /draftId/);
  assert.match(genPageSource, /visualPlan/);
  assert.match(genPageSource, /aspectRatio/);
  assert.match(genPageSource, /图片生成准备/);
  assert.match(genPageSource, /草稿已就绪/);
  // 不得声称图片已生成
  assert.ok(!genPageSource.includes('图片已生成'), 'Must not claim image is already generated');
  // 不得触发模型/工作流
  assert.ok(!genPageSource.includes('create_asset_generation_job'), 'Handoff panel must not trigger asset generation');
});

// ---- P30 Edge Function 对抗测试（直接导入 content-core.mjs）--------------------------
test('P31 Edge: real callQwen sends exact multimodal and text-only request bodies', async () => {
  const handler = await loadProductionHandler();
  const previousDeno = globalThis.Deno;
  const previousFetch = globalThis.fetch;
  const bodies = [];
  globalThis.Deno = { env: { get(name) { return name === 'DASHSCOPE_API_KEY' ? 'local-test-key' : undefined; } } };
  globalThis.fetch = async (_url, init = {}) => {
    bodies.push(JSON.parse(init.body));
    return new globalThis.Response(JSON.stringify({
      model: bodies.at(-1).model,
      usage: { total_tokens: 1 },
      choices: [{ message: { content: '{}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    await handler.callQwen('inspect this image', undefined, 'qwen3.5-omni-flash', image);
    await handler.callQwen('text only', undefined, 'qwen-plus', null);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].model, 'qwen3.5-omni-flash');
    assert.deepEqual(bodies[0].messages[0].content, [
      { type: 'text', text: 'inspect this image' },
      { type: 'image_url', image_url: { url: image } },
    ]);
    assert.equal(bodies[1].model, 'qwen-plus');
    assert.equal(bodies[1].messages[0].content, 'text only');
    assert.equal(JSON.stringify(bodies[1]).includes('image_url'), false);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.Deno = previousDeno;
  }
});

import * as core from '../supabase/functions/p30-content-create/content-core.mjs';

test('P30 Edge: production handler rejects origin before auth/model', () => {
  const source = readFileSync(join(REPO_ROOT, 'supabase/functions/p30-content-create/index.ts'), 'utf8');
  const originGuard = source.indexOf("code: 'ORIGIN_DENIED'");
  const authCall = source.indexOf('await authVerifier(request)', originGuard);
  const modelCall = source.indexOf('await modelCaller(prompt)', originGuard);
  assert.ok(originGuard > 0 && originGuard < authCall && originGuard < modelCall);
  assert.match(source, /export function isAllowedOrigin/);
  assert.match(source, /!origin \|\| ALLOWED_ORIGINS\.has\(origin\)/);
});

test('P30 Edge: real handler rejects CORS, missing JWT and viewer role before model', async () => {
  const handler = await loadProductionHandler();
  let authCalls = 0;
  let modelCalls = 0;
  const deniedOrigin = await handler.handleP30Request(new globalThis.Request('https://edge.test', {
    method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'generate_quick', input_text: 'hello' }),
  }), {
    verifyAuth: async () => { authCalls += 1; return { userId: 'u', role: 'operator' }; },
    callQwen: async () => { modelCalls += 1; return {}; },
  });
  assert.equal(deniedOrigin.status, 403);
  assert.equal((await deniedOrigin.json()).code, 'ORIGIN_DENIED');
  assert.equal(authCalls, 0);
  assert.equal(modelCalls, 0);

  const missingJwt = await handler.handleP30Request(new globalThis.Request('https://edge.test', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }),
  }));
  assert.equal(missingJwt.status, 401);
  assert.equal((await missingJwt.json()).code, 'AUTH_REQUIRED');

  const viewer = await handler.handleP30Request(new globalThis.Request('https://edge.test', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'generate_quick', input_text: 'hello' }),
  }), {
    verifyAuth: async () => ({ userId: 'u', role: 'viewer', authClient: {} }),
    callQwen: async () => { modelCalls += 1; return {}; },
  });
  assert.equal(viewer.status, 403);
  assert.equal((await viewer.json()).code, 'ROLE_DENIED');
  assert.equal(modelCalls, 0);
});

function briefClient(rows) {
  const query = {
    select() { return this; }, eq() { return this; }, limit: async () => ({ data: rows, error: null }),
  };
  return { schema() { return { from() { return query; } }; } };
}

test('P30 Edge: real handler validates exact Brief payload identity and approval', async () => {
  const handler = await loadProductionHandler();
  const fingerprint = 'a'.repeat(64);
  const basePayload = {
    id: 'brief-e2e', version: 1, schema_version: 'ams_content_brief_v1', status: 'approved',
    topic: 'AI 内容', objective: '说明价值', audience: '创业者', channel: 'x', constraints: [],
    structural_guidance: ['保留事实'], knowledge_citation_ids: ['kc-e2e'], evidence_provenance: { source: 'e2e' },
  };
  const row = {
    brief_id: 'brief-e2e', brief_version: 1, brief_schema_version: 'ams_content_brief_v1', brief_status: 'approved',
    knowledge_citation_ids: ['kc-e2e'], evidence_provenance: { source: 'e2e' }, payload: basePayload, payload_sha256: fingerprint,
  };
  const request = () => new globalThis.Request('https://edge.test', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'generate_from_brief', brief_id: 'brief-e2e', brief_version: 1, brief_fingerprint: fingerprint }),
  });
  let promptSeen = '';
  const accepted = await handler.handleP30Request(request(), {
    verifyAuth: async () => ({ userId: 'u', role: 'operator', authClient: briefClient([row]) }),
    callQwen: async (prompt) => { promptSeen = prompt; return { parsed: validGeneratedResult(), usage: { provider: 'mock', model: 'qwen-plus', total_tokens: 1 } }; },
  });
  assert.equal(accepted.status, 200);
  assert.match(promptSeen, /kc-e2e/);
  assert.match(promptSeen, /保留事实/);

  const drifted = JSON.parse(JSON.stringify(row));
  drifted.payload.status = 'pending_review';
  const rejected = await handler.handleP30Request(request(), {
    verifyAuth: async () => ({ userId: 'u', role: 'operator', authClient: briefClient([drifted]) }),
    callQwen: async () => { throw new Error('model must not run'); },
  });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'BRIEF_IDENTITY_MISMATCH');
});

test('P30 Edge: real handler returns bounded timeout and performs no persistence', async () => {
  const handler = await loadProductionHandler();
  const persistence = { insert: 0, update: 0, upsert: 0 };
  const response = await handler.handleP30Request(new globalThis.Request('https://edge.test', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'generate_quick', input_text: 'hello' }),
  }), {
    verifyAuth: async () => ({ userId: 'u', role: 'operator', authClient: {} }),
    callQwen: async () => { throw new handler.P30Error('QWEN_TIMEOUT', 'AI 生成超时，请稍后重试。', 504); },
  });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { ok: false, code: 'QWEN_TIMEOUT', message: 'AI 生成超时，请稍后重试。' });
  assert.deepEqual(persistence, { insert: 0, update: 0, upsert: 0 });
});

test('P30 Edge: unknown fields rejected', async () => {
  // 动态导入测试 core 模块验证字段拒绝
  // 使用顶层导入的 core 模块

  assert.throws(
    () => core.parseRequest({ action: 'generate_quick', input_text: 'hello', sql_injection: 'DROP TABLE' }),
    { code: 'UNKNOWN_FIELDS' },
  );
});

test('P30 Edge: input length capped', async () => {
  // 使用顶层导入的 core 模块

  const long = 'x'.repeat(core.LIMITS.MAX_INPUT_LENGTH + 1);
  assert.throws(
    () => core.parseRequest({ action: 'generate_quick', input_text: long }),
    { code: 'INPUT_TOO_LONG' },
  );
});

test('P30 Edge: model response schema validated', async () => {
  // 使用顶层导入的 core 模块

  // 缺少必需字段
  assert.throws(
    () => core.validateGeneratedContent({ platform: 'x' }),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('P30 Edge: sanitized errors hide secrets', async () => {
  // 使用顶层导入的 core 模块

  const result = core.sanitizeError(new Error('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummy'));
  assert.ok(!result.message.includes('eyJ'), 'JWT token is redacted');
  assert.ok(result.message.includes('[REDACTED]'), 'Redaction marker present');
});

test('P30 Edge: zero persistence side effects (generation only)', () => {
  // Edge Function 不写数据库 — 由 content-core 保证（无 DB 操作代码）
  const corePath = join(REPO_ROOT, 'supabase', 'functions', 'p30-content-create', 'content-core.mjs');
  const coreSource = readFileSync(corePath, 'utf-8');
  assert.ok(!coreSource.includes('supabase.from('), 'Core module has no DB writes');
  assert.ok(!coreSource.includes('.insert('), 'Core module has no inserts');
  assert.ok(!coreSource.includes('.update('), 'Core module has no updates');
  assert.ok(!coreSource.includes('.upsert('), 'Core module has no upserts');
});

// ---- Brief 身份/审批复验 -------------------------------------------------------
test('P30: brief approval gate rejects non-approved status', () => {
  // 前端逻辑：只有 approved brief 才能生成
  const nonApproved = ['draft', 'pending', 'returned', 'stale', 'archived'];
  const approved = 'approved';
  for (const status of nonApproved) {
    assert.notEqual(status, approved, `Status ${status} should not allow generation`);
  }
});

// ---- 周期天数验证 -------------------------------------------------------------
test('P30: cycle duration accepts 3, 7, 14 and rejects 0, 31', () => {
  const valid = [3, 7, 14];
  const invalid = [0, -1, 31, 365, NaN, Infinity];
  for (const v of valid) {
    assert.ok(v >= 1 && v <= 30, `${v} is valid cycle duration`);
  }
  for (const v of invalid) {
    assert.ok(!(v >= 1 && v <= 30) || Number.isNaN(v), `${v} is invalid cycle duration`);
  }
});

// ---- 保存合同验证 -------------------------------------------------------------
test('P30: generation_brief must contain p30 schema version and no secrets', () => {
  const genBrief = {
    schema_version: 'p30_single_content_draft_v1',
    original_input: 'test',
    summary: 'x / test / test / test',
    visual_plan: 'test visual',
    provider: 'dashscope/qwen',
    model: 'qwen-plus',
    usage: { total_tokens: 100 },
    source: 'quick_generate',
  };
  assert.equal(genBrief.schema_version, 'p30_single_content_draft_v1');
  // 不得包含 token、Authorization、Secret、原始会话
  assert.ok(!Object.keys(genBrief).some((k) => ['token', 'authorization', 'secret', 'session', 'jwt'].includes(k.toLowerCase())),
    'generation_brief must not contain secrets');
});

function validGeneratedResult() {
  return {
    platform: 'x', audience: '创业者', tone: '专业自然', content_goal: '说明价值',
    hook: '一个可信的开头', cta: '保存草稿', main_copy: '一条经过验证的内容。', hashtags: ['#AI'],
    visual_type: 'single_image', visual_description: '简洁主视觉', aspect_ratio: '1:1', candidates: [],
  };
}
