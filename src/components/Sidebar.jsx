import { useState } from 'react';
import { navigationSections } from '../data/navigation';

const PRIMARY_NAV_IDS = new Set(['ai', 'research', 'generation', 'knowledge', 'connections']);

export function Sidebar({ activePage, onNavigate }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const logoSrc = `${import.meta.env.BASE_URL}ai-marketing-logo.png`;
  const activeNavigationId = activePage === 'dashboard' ? 'ai' : activePage;
  const primaryNavigationSections = navigationSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => PRIMARY_NAV_IDS.has(item.id)),
    }))
    .filter((section) => section.items.length > 0);

  function navigate(pageId) {
    onNavigate(pageId);
    setMobileOpen(false);
  }

  return (
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="sidebar-top">
        <div className="brand">
          <div className="brand-mark">
            <img src={logoSrc} alt="AI 营销工作室标志" />
          </div>
          <div className="brand-copy">
            <strong>AI 营销工作室</strong>
            <span>Staging 智能工作台</span>
          </div>
        </div>
        <button className="sidebar-toggle" type="button" aria-expanded={mobileOpen} aria-label="展开或收起导航" onClick={() => setMobileOpen((current) => !current)}>
          {mobileOpen ? '关闭' : '菜单'}
        </button>
      </div>

      <nav className="nav-list" aria-label="主导航">
        {primaryNavigationSections.map((section) => (
          <div className="nav-section" key={section.label}>
            <span className="nav-section-title">{section.label}</span>
            {section.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${activeNavigationId === item.id ? 'active' : ''}`}
                onClick={() => navigate(item.id)}
                type="button"
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-note">
        <span>安全边界</span>
        <p>浏览器只负责计划、确认和查看结果。Harness、模型密钥、生成与发布执行始终通过可信服务端。</p>
      </div>
    </aside>
  );
}
