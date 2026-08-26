import { useEffect, useMemo, useState } from 'react';
import { harnessPlugins, navigationSections } from '../data/navigation';

// 侧栏核心插件与“更多工具”全部派生自 navigation.js 的唯一注册源
// （harnessPlugins + navigationSections）；组件内不再复制第二份菜单配置。
const corePlugins = harnessPlugins;

const secondarySections = navigationSections;

export function Sidebar({ activePage, collapsed = false, onCollapsedChange, onNavigate, routeParams = {}, routeView = '' }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const logoSrc = `${import.meta.env.BASE_URL}ai-marketing-logo.png`;
  // 规范任务路由 /tasks/... 高亮侧栏对应条目：新任务视图高亮 AI 工作台。
  const activeNavigationId = activePage === 'tasks'
    ? (routeView === 'new' ? 'ai' : activePage)
    : activePage === 'dashboard' ? 'ai' : activePage;
  const activeSectionLabel = useMemo(
    () => navigationSections.find((section) => section.items.some((item) => item.id === activeNavigationId))?.label,
    [activeNavigationId],
  );
  const [expandedSections, setExpandedSections] = useState(() => new Set([activeSectionLabel || secondarySections[0]?.label].filter(Boolean)));

  useEffect(() => {
    if (!activeSectionLabel) return;
    setExpandedSections((current) => {
      if (current.has(activeSectionLabel)) return current;
      const next = new Set(current);
      next.add(activeSectionLabel);
      return next;
    });
  }, [activeSectionLabel]);

  const allExpanded = secondarySections.every((section) => expandedSections.has(section.label));

  function navigate(pageId) {
    onNavigate(pageId);
    setMobileOpen(false);
  }

  function navigatePlugin(plugin) {
    onNavigate(plugin.route || plugin.id, '', plugin.routeParams || {});
    setMobileOpen(false);
  }

  function startNewTask() {
    onNavigate('ai', '', { new: String(Date.now()) });
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
    setExpandedSections(allExpanded ? new Set(activeSectionLabel ? [activeSectionLabel] : []) : new Set(secondarySections.map((section) => section.label)));
  }

  return (
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''} ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-top">
        <span className="sr-only">Staging 智能工作台</span>
        <div className="brand">
          <div className="brand-mark">
            <img src={logoSrc} alt="AI 营销工作室标志" />
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
        <button className="sidebar-toggle" type="button" aria-expanded={mobileOpen} aria-label="展开或收起导航" onClick={() => setMobileOpen((current) => !current)}>
          {mobileOpen ? '关闭' : '菜单'}
        </button>
      </div>

      <button className="harness-new-task" type="button" onClick={startNewTask}>
        <span className="nav-label">新任务</span>
        <span aria-hidden="true">＋</span>
      </button>

      <div className="harness-session-shortcuts" aria-label="最近会话">
        <span className="harness-sidebar-caption">会话</span>
        <button type="button" onClick={() => navigate('ai')}>
          <span className="nav-label">当前工作会话</span><span aria-hidden="true">•••</span>
        </button>
      </div>

      <nav className="nav-list" aria-label="主导航">
        <div className="nav-overview">
          <span>核心流程</span>
          <span>{corePlugins.length}</span>
        </div>
        <div className="harness-core-plugins">
          {corePlugins.map((plugin) => {
            const route = plugin.route || plugin.id;
            const requiredFocus = plugin.routeParams?.focus;
            const active = activeNavigationId === route && (requiredFocus ? routeParams.focus === requiredFocus : !routeParams.focus);
            return (
              <button
                key={plugin.id}
                className={`nav-item harness-core-plugin ${active ? 'active' : ''}`}
                data-testid={plugin.testId}
                onClick={() => navigatePlugin(plugin)}
                type="button"
                title={collapsed ? plugin.label : undefined}
                aria-label={collapsed ? plugin.label : undefined}
              >
                <span className="nav-icon">{plugin.icon}</span>
                <span className="nav-label">{plugin.label}</span>
              </button>
            );
          })}
        </div>

        <div className="nav-overview harness-more-heading">
          <span>管理与查看</span>
          <span className="sr-only">辅助业务页面</span>
          <button type="button" onClick={toggleAllSections}>{allExpanded ? '收起' : '展开'}</button>
        </div>
        {secondarySections.map((section) => {
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
