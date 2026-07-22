import { useState } from 'react';
import { navigationSections } from '../data/navigation';

export function Sidebar({ activePage, onNavigate }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  function navigate(pageId) {
    onNavigate(pageId);
    setMobileOpen(false);
  }

  return (
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="sidebar-top">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div className="brand-copy">
            <strong>AI Marketing OS</strong>
            <span>Command Center</span>
          </div>
        </div>
        <button className="sidebar-toggle" type="button" aria-expanded={mobileOpen} aria-label="展开或收起导航" onClick={() => setMobileOpen((current) => !current)}>
          {mobileOpen ? '关闭' : '菜单'}
        </button>
      </div>

      <nav className="nav-list" aria-label="主导航">
        {navigationSections.map((section) => (
          <div className="nav-section" key={section.label}>
            <span className="nav-section-title">{section.label}</span>
            {section.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${activePage === item.id ? 'active' : ''}`}
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
        <p>线上站点只做低权限前端控制台。MCP、平台 Token、ComfyUI 与发布执行必须通过可信服务端。</p>
      </div>
    </aside>
  );
}
