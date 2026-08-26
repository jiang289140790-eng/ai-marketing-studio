import { useMemo, useState } from 'react';
import { readHarnessActiveProject } from '../services/harness-client.js';
import './AIWorkspacePage.css';

const DEFAULT_HARNESS_WEB_URL = 'https://harness-web.47-251-244-196.sslip.io';

function getHarnessWebUrl() {
  return String(
    import.meta.env.VITE_DSH_WEB_URL
      || import.meta.env.VITE_DEEPSEEK_HARNESS_WEB_URL
      || DEFAULT_HARNESS_WEB_URL,
  ).trim();
}

function businessLinks(onNavigate) {
  return [
    { id: 'research', label: '研究与 Brief' },
    { id: 'knowledge', label: '知识库' },
    { id: 'generation', label: '生成结果' },
    { id: 'assets', label: '素材库' },
    { id: 'characters', label: '角色库' },
    { id: 'publish', label: '发布中心' },
  ].map((item) => ({
    ...item,
    onClick: () => onNavigate?.(item.id),
  }));
}

export function AIWorkspacePage({ onNavigate }) {
  const harnessWebUrl = getHarnessWebUrl();
  const activeProjectId = readHarnessActiveProject();
  const links = useMemo(() => businessLinks(onNavigate), [onNavigate]);
  const [frameUnavailable, setFrameUnavailable] = useState(false);

  const openHarness = () => {
    if (!harnessWebUrl) return;
    globalThis.open(harnessWebUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <main className="ai-workspace ai-official-harness-page" data-testid="ai-official-harness-page">
      <section className="official-harness-strip" aria-label="DeepSeek Harness 入口">
        <div>
          <p>AMS × DeepSeek Harness</p>
          <h1>直接使用官方 Harness</h1>
          <span>
            自然语言、规划、工具选择和执行交给 Harness；AMS 只负责项目绑定、业务结果、资产和人工确认。
          </span>
        </div>
        <div className="official-harness-actions">
          <button type="button" className="primary" onClick={openHarness}>
            新窗口打开 Harness
          </button>
          <button type="button" className="secondary-button" onClick={() => onNavigate?.('research')}>
            查看业务结果
          </button>
        </div>
      </section>

      <section className="official-harness-frame-card" aria-label="官方 DeepSeek Harness Web">
        <div className="official-harness-frame-toolbar">
          <span>
            当前项目：
            <strong>{activeProjectId || '未绑定'}</strong>
          </span>
          <small>如果嵌入视图异常，请点“新窗口打开 Harness”。</small>
        </div>
        {!frameUnavailable ? (
          <iframe
            title="DeepSeek Harness Web"
            src={harnessWebUrl}
            className="official-harness-frame"
            data-testid="official-harness-frame"
            onError={() => setFrameUnavailable(true)}
          />
        ) : (
          <div className="official-harness-fallback" role="status">
            <h2>官方 Harness 需要新窗口打开</h2>
            <p>浏览器阻止了嵌入视图，但服务仍可用。</p>
            <button type="button" className="primary" onClick={openHarness}>
              打开官方 Harness
            </button>
          </div>
        )}
      </section>

      <nav className="official-business-links" aria-label="AMS 业务结果入口">
        {links.map((item) => (
          <button type="button" key={item.id} onClick={item.onClick}>
            {item.label}
          </button>
        ))}
      </nav>
    </main>
  );
}
