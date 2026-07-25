import { Component } from 'react';

export class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Page render failed', error, info);
  }

  componentDidUpdate(previousProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <section className="page-error-boundary" role="alert">
        <p className="eyebrow">页面加载异常</p>
        <h2>当前页面的一条业务数据无法正常显示</h2>
        <p>导航和其他页面仍可使用。请重新加载；如果问题持续，可返回运营指挥中心继续处理。</p>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>
            重新加载页面
          </button>
          <button className="ghost-button" type="button" onClick={() => this.props.onNavigate?.('dashboard')}>
            返回运营指挥中心
          </button>
        </div>
        <details>
          <summary>查看诊断信息</summary>
          <code>{error?.message || '未知页面错误'}</code>
        </details>
      </section>
    );
  }
}
