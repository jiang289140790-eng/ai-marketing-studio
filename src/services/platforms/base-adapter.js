export function adapterResult({ success = false, message_id = null, url = null, error = null, raw = null, platform = '' } = {}) {
  return {
    success,
    message_id,
    external_id: message_id,
    url,
    error,
    raw,
    platform,
  };
}

export function createPreparedAdapter(platform, setup = {}) {
  async function notConfigured(method) {
    return adapterResult({
      success: false,
      platform,
      error: `${platform}.${method} 已保留接口，但还没有配置真实 API / OAuth，不能作为已完成能力使用。`,
      raw: {
        method,
        required_config: setup.required_config || [],
        auth_type: setup.auth_type || 'oauth2',
        docs: setup.docs || null,
      },
    });
  }

  return {
    platform,
    setup,
    connect: () => notConfigured('connect'),
    disconnect: () => notConfigured('disconnect'),
    getAccount: () => notConfigured('getAccount'),
    fetchContent: () => notConfigured('fetchContent'),
    publish: () => notConfigured('publish'),
    getMetrics: () => notConfigured('getMetrics'),
  };
}

export const createPlaceholderAdapter = createPreparedAdapter;
