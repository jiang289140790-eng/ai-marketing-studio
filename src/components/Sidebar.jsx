import { navigationSections } from '../data/navigation';

export function Sidebar({ activePage, onNavigate }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">AI</div>
        <div>
          <strong>AI Marketing</strong>
          <span>Studio</span>
        </div>
      </div>

      <nav className="nav-list" aria-label="主导航">
        {navigationSections.map((section) => (
          <div className="nav-section" key={section.label}>
            <span className="nav-section-title">{section.label}</span>
            {section.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${activePage === item.id ? 'active' : ''}`}
                onClick={() => onNavigate(item.id)}
                type="button"
              >
                <span>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
