import { useEffect, useMemo, useState } from 'react';
import { compatibilitySections, harnessJourney } from '../data/navigation';

// 侧栏主旅程与业务页面全部派生自 navigation.js 的唯一注册源
// （harnessJourney + compatibilitySections）；组件内不再复制第二份菜单配置。
const [journeyNew, journeySession] = harnessJourney;

const secondarySections = compatibilitySections;
const primaryBusinessIds = new Set(['research', 'knowledge', 'generation', 'characters']);

export function Sidebar({ activePage, collapsed = false, onCollapsedChange, onNavigate, routeView = '' }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const logoSrc = `${import.meta.env.BASE_URL}ai-marketing-logo.png`;
  // 规范任务路由 /tasks/... 高亮主旅程锚点：新任务视图高亮“新任务”，
  // 执行/结果视图高亮“当前会话”；兼容区条目按所在页面高亮。
  const journeyActiveKey = activePage === 'ai' || (activePage === 'tasks' && !routeView)
    ? 'new'
    : activePage === 'tasks' ? 'session' : null;
  const activeSectionLabel = useMemo(
    () => compatibilitySections.find((section) => section.items.some((item) => item.id === activePage))?.label,
    [activePage],
  );
  const [expandedSections, setExpandedSections] = useState(() => new Set([activeSectionLabel].filter(Boolean)));

  useEffect(() => {
    if (!activeSectionLabel) return;
    setExpandedSections((current) => {
      if (current.has(activeSectionLabel)) return current;
      const next = new Set(current);
      next.add(activeSectionLabel);
      return next;
    });
  }, [activeSectionLabel]);

  const primaryBusinessItems = secondarySections.flatMap((section) => section.items).filter((item) => primaryBusinessIds.has(item.id));
  const moreSections = secondarySections.map((section) => ({
    ...section,
    items: section.items.filter((item) => !primaryBusinessIds.has(item.id)),
  })).filter((section) => section.items.length > 0);
  const allExpanded = moreSections.every((section) => expandedSections.has(section.label));

  function navigate(pageId) {
    onNavigate(pageId);
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
    setExpandedSections(allExpanded ? new Set(activeSectionLabel ? [activeSectionLabel] : []) : new Set(moreSections.map((section) => section.label)));
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

      <button className="harness-new-task" type="button" data-testid={journeyNew.testId} onClick={startNewTask}>
        <span className="nav-label">{journeyNew.label}</span>
        <span aria-hidden="true">＋</span>
      </button>

      <div className="harness-session-shortcuts" aria-label="最近会话">
        <span className="harness-sidebar-caption">会话</span>
        <button
          type="button"
          data-testid={journeySession.testId}
          className={journeyActiveKey === 'session' ? 'active' : ''}
          onClick={() => navigate('ai')}
        >
          <span className="nav-label">{journeySession.label}</span><span aria-hidden="true">•••</span>
        </button>
      </div>

      <nav className="nav-list" aria-label="主导航">
        <div className="nav-overview harness-more-heading">
          <span>结果与资产</span>
          <span className="sr-only">常用结果和资产页面</span>
        </div>
        <div className="nav-section expanded" data-nav-section="常用入口">
          <div className="nav-section-items">
            {primaryBusinessItems.map((item) => (
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
        <div className="nav-overview harness-more-heading">
          <span>更多</span>
          <span className="sr-only">低频业务页面和插件连接页面</span>
          <button type="button" onClick={toggleAllSections}>{allExpanded ? '收起' : '展开'}</button>
        </div>
        {moreSections.map((section) => {
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
          );
        })}
      </nav>

      <details className="sidebar-note">
        <summary>边界说明</summary>
        <p>浏览器只负责对话、确认和查看结果；模型、生成与发布由服务端插件执行。</p>
      </details>
    </aside>
  );
}
