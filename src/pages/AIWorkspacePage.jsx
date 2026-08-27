import { useMemo, useState } from 'react';
import { readHarnessActiveProject } from '../services/harness-client.js';
import './AIWorkspacePage.css';

const DEFAULT_HARNESS_WEB_URL = 'https://harness-web.47-251-244-196.sslip.io';

function getHarnessWebUrl() {
  return String(
    import.meta.env.VITE_DSH_WEB_URL
      || import.meta.env.VITE_DEEPSEEK_HARNESS_WEB_URL
      || DEFAULT_HARNESS_WEB_URL,
  ).trim().replace(/\/$/, '');
}

function businessLinks(onNavigate) {
  return [
    { id: 'research', label: '研究与 Brief', description: 'Evidence、分析、Knowledge、Brief' },
    { id: 'knowledge', label: '知识库', description: '可复用营销知识' },
    { id: 'generation', label: '生成结果', description: '图片、视频、生成任务产物' },
    { id: 'assets', label: '素材库', description: '图片、视频与外部素材' },
    { id: 'characters', label: '角色库', description: '长期角色与视觉资产' },
    { id: 'publish', label: '发布中心', description: '人工确认后的发布准备' },
  ].map((item) => ({ ...item, onClick: () => onNavigate?.(item.id) }));
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
      <section className="official-harness-shell" aria-label="DeepSeek Harness 工作区">
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
            <h1>打开 DeepSeek Harness</h1>
            <p>当前浏览器阻止了嵌入视图，请用新窗口打开官方 Harness 工作区。</p>
            <button type="button" onClick={openHarness}>打开 Harness</button>
          </div>
        )}
      </section>

      <aside className="official-business-dock" aria-label="AMS 业务结果入口">
        <div>
          <strong>AMS 结果页</strong>
          <span>{activeProjectId ? `当前项目 ${activeProjectId}` : 'Harness 负责执行，AMS 只沉淀结果'}</span>
        </div>
        <div className="official-business-grid">
          {links.map((item) => (
            <button type="button" key={item.id} onClick={item.onClick} title={item.description}>
              {item.label}
            </button>
          ))}
        </div>
      </aside>
    </main>
  );
}
