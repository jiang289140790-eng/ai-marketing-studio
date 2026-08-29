import { useState } from 'react';
import { compatibilitySections, harnessJourney } from '../data/navigation';

const [journeyNew, journeySession] = harnessJourney;
const secondarySections = compatibilitySections;
const primaryBusinessIds = new Set(['research', 'knowledge', 'generation', 'publish', 'characters', 'assets']);

export function Sidebar({ activePage, collapsed = false, onCollapsedChange, onNavigate }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const logoSrc = `${import.meta.env.BASE_URL}ai-marketing-logo.png`;

  function navigate(pageId) {
    onNavigate(pageId);
    setMobileOpen(false);
  }

  function startNewTask() {
    onNavigate('ai', '', { new: String(Date.now()) });
    setMobileOpen(false);
  }

  return (
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''} ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-top">
        <span className="sr-only">AI Marketing Studio</span>
        <div className="brand">
          <div className="brand-mark">
            <img src={logoSrc} alt="AI Marketing Studio" />
          </div>
          <div className="brand-copy">
            <strong>deepseek</strong>
            <span>HARNESS · AI 营销工作室</span>
          </div>
        </div>
        <button
          className="sidebar-collapse-toggle"
          type="button"
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-pressed={collapsed}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          onClick={() => onCollapsedChange?.(!collapsed)}
        >
          <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
        </button>
        <button
          className="sidebar-toggle"
          type="button"
          aria-expanded={mobileOpen}
          aria-label="打开或关闭导航"
          onClick={() => setMobileOpen((current) => !current)}
        >
          {mobileOpen ? '关闭' : '菜单'}
        </button>
      </div>

      <button className="harness-new-task" type="button" data-testid={journeyNew.testId} onClick={startNewTask}>
        <span className="nav-label">{journeyNew.label}</span>
        <span aria-hidden="true">+</span>
      </button>

      <nav className="nav-list" aria-label="主导航">
        <span className="sr-only" data-testid={journeySession.testId}>{journeySession.label}</span>
        {secondarySections.map((section) => (
          <div className="nav-section expanded" key={section.label} data-nav-section={section.label}>
            <div className="nav-overview">
              <span>{section.label}</span>
            </div>
            <div className="nav-section-items">
              {section.items.filter((item) => primaryBusinessIds.has(item.id)).map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${activePage === item.id ? 'active' : ''}`}
                  data-testid={item.testId}
                  onClick={() => navigate(item.id)}
                  type="button"
                  title={collapsed ? item.label : undefined}
                  aria-label={collapsed ? item.label : undefined}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <details className="sidebar-note">
        <summary>边界说明</summary>
        <p>Harness 负责对话、计划和工具执行；AMS 只保留登录、项目绑定、业务结果和资产沉淀。</p>
      </details>
    </aside>
  );
}
