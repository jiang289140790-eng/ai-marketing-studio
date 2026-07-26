import { Component } from 'react';
import { normalizeBusinessError } from '../utils/business-error';

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
    const businessError = normalizeBusinessError(error, {
      title: '当前页面暂时无法加载',
      impact: '只有当前页面受影响，导航和其他业务页面仍可继续使用。',
      recommendation: '重新加载页面；如持续出现，请返回运营指挥中心并记录错误编号。',
    });

    return (
      <section className="page-error-boundary" role="alert">
        <p className="eyebrow">页面加载异常</p>
        <h2>{businessError.title}</h2>
        <p>{businessError.message}</p>
        <p>业务影响：{businessError.impact}</p>
        <p>推荐操作：{businessError.recommendation}</p>
        <p>错误编号：{businessError.code} · {businessError.retryable ? '可以重试' : '需要人工检查'}</p>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>
            重新加载页面
          </button>
          <button className="ghost-button" type="button" onClick={() => this.props.onNavigate?.('dashboard')}>
            返回运营指挥中心
          </button>
        </div>
      </section>
    );
  }
}
