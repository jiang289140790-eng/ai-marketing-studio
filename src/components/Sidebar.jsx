import { useEffect, useMemo, useState } from 'react';
import { navigationSections } from '../data/navigation';

export function Sidebar({ activePage, collapsed = false, onCollapsedChange, onNavigate }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const logoSrc = `${import.meta.env.BASE_URL}ai-marketing-logo.png`;
  const activeNavigationId = activePage === 'dashboard' ? 'ai' : activePage;
  const activeSectionLabel = useMemo(
    () => navigationSections.find((section) => section.items.some((item) => item.id === activeNavigationId))?.label,
    [activeNavigationId],
  );
  const [expandedSections, setExpandedSections] = useState(() => new Set(['智能工作', activeSectionLabel].filter(Boolean)));

  useEffect(() => {
    if (!activeSectionLabel) return;
    setExpandedSections((current) => {
      if (current.has(activeSectionLabel)) return current;
      const next = new Set(current);
      next.add(activeSectionLabel);
      return next;
    });
  }, [activeSectionLabel]);

  const allExpanded = expandedSections.size === navigationSections.length;

  function navigate(pageId) {
    onNavigate(pageId);
    setMobileOpen(false);
  }

  function toggleSection(label) {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function toggleAllSections() {
    setExpandedSections(allExpanded ? new Set(activeSectionLabel ? [activeSectionLabel] : []) : new Set(navigationSections.map((section) => section.label)));
  }

  return (
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''} ${collapsed ? 'collapsed' : ''}`}>
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
        <button className="sidebar-toggle" type="button" aria-expanded={mobileOpen} aria-label="展开或收起导航" onClick={() => setMobileOpen((current) => !current)}>
          {mobileOpen ? '关闭' : '菜单'}
        </button>
      </div>

      <nav className="nav-list" aria-label="主导航">
        <div className="nav-overview">
          <span>全部功能</span>
          <button type="button" onClick={toggleAllSections}>{allExpanded ? '收起' : '展开'}</button>
        </div>
        {navigationSections.map((section) => {
          const expanded = expandedSections.has(section.label);
          const sectionId = `nav-section-${section.items[0]?.id || section.label}`;
          return (
            <div className={`nav-section ${expanded ? 'expanded' : ''}`} key={section.label} data-nav-section={section.label}>
              <button
                className="nav-section-toggle"
                type="button"
                aria-expanded={expanded}
                aria-controls={sectionId}
                onClick={() => toggleSection(section.label)}
              >
                <span className="nav-section-title">{section.label}</span>
                <span className="nav-section-meta"><span>{section.items.length}</span><span aria-hidden="true">⌄</span></span>
              </button>
              <div className="nav-section-items" id={sectionId} hidden={!expanded && !collapsed}>
                {section.items.map((item) => (
                  <button
                    key={item.id}
                    className={`nav-item ${activeNavigationId === item.id ? 'active' : ''}`}
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
          );
        })}
      </nav>

      <div className="sidebar-note">
        <span>安全边界</span>
        <p>浏览器只负责计划、确认和查看结果。Harness、模型密钥、生成与发布执行始终通过可信服务端。</p>
      </div>
    </aside>
  );
}
