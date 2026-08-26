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
    { id: 'research', label: '研究与 Brief', description: 'Evidence、分析、Knowledge、Brief' },
    { id: 'knowledge', label: '知识库', description: '沉淀可复用的营销知识' },
    { id: 'generation', label: '生成结果', description: '图片、视频、生成任务产物' },
    { id: 'assets', label: '素材库', description: '图片、视频与外部素材' },
    { id: 'characters', label: '角色库', description: '长期角色与视觉资产' },
    { id: 'publish', label: '发布中心', description: '人工确认后的发布准备' },
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
      <section className="official-harness-shell" aria-label="DeepSeek Harness 工作区">
        <div className="official-harness-header">
          <div>
            <p>AMS × DeepSeek Harness</p>
            <h1>AI 工作台</h1>
            <span>
              这里不再维护第二套固定规划器。你直接在官方 Harness 里说目标，
              AMS 只提供项目、插件工具和业务结果页。
            </span>
          </div>
          <div className="official-harness-status">
            <span>当前项目</span>
            <strong>{activeProjectId || '未绑定'}</strong>
            <button type="button" onClick={openHarness}>新窗口打开</button>
          </div>
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
            <p>当前浏览器阻止了嵌入视图，但 Harness 服务仍可用。</p>
            <button type="button" onClick={openHarness}>打开官方 Harness</button>
          </div>
        )}
      </section>

      <section className="official-business-links" aria-label="AMS 业务结果页">
        <div className="official-business-heading">
          <p>业务结果页</p>
          <h2>Harness 完成任务后，在这里看沉淀结果</h2>
        </div>
        <div className="official-business-grid">
          {links.map((item) => (
            <button type="button" key={item.id} onClick={item.onClick}>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
