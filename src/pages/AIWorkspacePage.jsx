import { useMemo } from 'react';
import { readHarnessActiveProject } from '../services/harness-client.js';
import './AIWorkspacePage.css';

const DEFAULT_HARNESS_WEB_URL = 'https://harness-web.47-251-244-196.sslip.io';

function businessLinks(onNavigate) {
  return [
    { id: 'research', label: '研究与 Brief', detail: '查看 Evidence、分析、知识卡和待审核 Brief。' },
    { id: 'knowledge', label: '知识库', detail: '沉淀账号、内容、策略和复盘知识。' },
    { id: 'generation', label: '生成结果', detail: '查看图片、视频、Artifact、下载和版本历史。' },
    { id: 'assets', label: '素材库', detail: '管理可复用图片、视频、参考素材。' },
    { id: 'characters', label: '角色库', detail: '长期角色、视觉资产和账号人设。' },
    { id: 'publish', label: '发布中心', detail: '高风险发布动作统一人工确认。' },
  ].map((item) => ({
    ...item,
    onClick: () => onNavigate?.(item.id),
  }));
}

export function AIWorkspacePage({ onNavigate }) {
  const harnessWebUrl = String(
    import.meta.env.VITE_DSH_WEB_URL
      || import.meta.env.VITE_DEEPSEEK_HARNESS_WEB_URL
      || DEFAULT_HARNESS_WEB_URL,
  ).trim();
  const activeProjectId = readHarnessActiveProject();
  const links = useMemo(() => businessLinks(onNavigate), [onNavigate]);

  const openHarness = () => {
    if (!harnessWebUrl) return;
    globalThis.open(harnessWebUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <main className="ai-workspace ai-native-shell" data-testid="ai-native-shell">
      <section className="native-hero">
        <p className="eyebrow">AMS × DeepSeek Harness</p>
        <h1>只用 Harness 做事</h1>
        <p>
          自然语言、规划、工具选择和连续执行交给 DeepSeek Harness。
          AMS 网站只保留项目绑定、业务结果、资产和人工确认入口。
        </p>
        <div className="native-actions">
          <button type="button" className="primary" onClick={openHarness}>
            打开官方 Harness
          </button>
          <button type="button" className="secondary-button" onClick={() => onNavigate?.('research')}>
            查看业务结果
          </button>
        </div>
      </section>

      <section className="native-project-card">
        <span>当前项目</span>
        <strong>{activeProjectId || '尚未绑定'}</strong>
        <small>项目上下文会由 AMS 插件工具读取；不是在前端硬编码任务流程。</small>
      </section>

      <section className="native-business-grid" aria-label="业务结果入口">
        {links.map((item) => (
          <button type="button" key={item.id} onClick={item.onClick}>
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </button>
        ))}
      </section>

      <section className="native-boundary">
        <h2>现在的分工</h2>
        <ul>
          <li>Harness：理解目标、规划步骤、选择插件工具、执行和恢复任务。</li>
          <li>AMS 插件：研究采集、Evidence、Analysis、Knowledge、Brief、生成和 Storage。</li>
          <li>AMS 页面：只展示业务资产和可审核结果，不再维护第二套智能路由。</li>
        </ul>
      </section>
    </main>
  );
}
