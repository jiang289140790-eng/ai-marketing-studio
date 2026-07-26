function listValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
    } catch {
      return value.split(/[\s,，、]+/).filter(Boolean);
    }
  }
  return [];
}

function objectValue(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function connectionIsActive(connection, now = new Date()) {
  if (connection?.is_connected === false) return false;
  if (connection?.expires_at && new Date(connection.expires_at).getTime() <= now.getTime()) return false;
  return connection?.status === 'connected' || connection?.is_connected === true;
}

export function getUnifiedConnectionState(rows = [], now = new Date()) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const activeRows = safeRows.filter((row) => connectionIsActive(row, now));
  const expiryValues = safeRows
    .map((row) => row.expires_at)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  const expired = expiryValues.some((value) => value <= now.getTime())
    || safeRows.some((row) => row.status === 'connected' && row.is_connected === false);
  return {
    registered: true,
    oauthValid: activeRows.length > 0,
    activeRows,
    registration: { state: 'registered', label: '账号已登记' },
    oauth: activeRows.length
      ? { state: 'available', label: 'OAuth 有效' }
      : expired
        ? { state: 'failed', label: 'OAuth 已过期' }
        : { state: 'not_connected', label: 'OAuth 未连接' },
  };
}

export function collectConnectionPermissions(rows = []) {
  return [...new Set(rows.flatMap((row) => {
    const metadata = objectValue(row.metadata);
    return listValue(row.permissions || metadata.permissions || metadata.scopes);
  }))];
}

function permissionCapability(permissions, pattern, activeCount, fallback = '待验证') {
  if (!activeCount) return { state: 'not_connected', label: '未连接' };
  if (permissions.some((permission) => pattern.test(permission))) return { state: 'available', label: '可用' };
  return { state: 'needs_validation', label: fallback };
}

function latestDate(rows) {
  return rows
    .flatMap((row) => [row.last_verified_at, row.last_sync, row.last_used_at, row.connected_at])
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
}

function tokenStatus(rows, now = new Date()) {
  const unified = getUnifiedConnectionState(rows, now);
  const credentialRows = unified.activeRows;
  if (!credentialRows.length) return unified.oauth;
  const expiries = credentialRows.map((row) => row.expires_at).filter(Boolean).map((value) => new Date(value));
  if (!expiries.length) return { state: 'unknown', label: '有效期未上报' };
  const latestExpiry = expiries.sort((left, right) => right.getTime() - left.getTime())[0];
  if (latestExpiry.getTime() <= now.getTime()) return { state: 'failed', label: '已过期' };
  if (latestExpiry.getTime() - now.getTime() < 7 * 86400000) return { state: 'warning', label: '即将过期' };
  return { state: 'available', label: '有效' };
}

function quotaStatus(rows) {
  const values = rows.map((row) => objectValue(row.metadata)).map((metadata) => ({
    status: metadata.credits_status || metadata.quota_status || metadata.rate_limit_status,
    remaining: metadata.credits_remaining ?? metadata.quota_remaining ?? metadata.rate_limit_remaining,
    limit: metadata.credits_limit ?? metadata.quota_limit ?? metadata.rate_limit_limit,
    reset: metadata.rate_limit_reset || metadata.quota_reset_at,
  })).filter((value) => value.status != null || value.remaining != null || value.limit != null);
  if (!values.length) return { state: 'unknown', label: '额度未上报', detail: '平台未返回可展示的额度信息' };
  const value = values[0];
  const depleted = String(value.status || '').toLowerCase() === 'depleted' || Number(value.remaining) === 0;
  if (depleted) {
    return {
      state: 'failed',
      label: '额度已用尽',
      detail: '读取、发布或指标回收可能暂时不可用',
    };
  }
  return {
    state: 'available',
    label: value.remaining == null ? String(value.status || '正常') : `剩余 ${value.remaining}${value.limit != null ? ` / ${value.limit}` : ''}`,
    detail: value.reset ? `预计重置：${value.reset}` : '以平台实际计费和限流为准',
  };
}

function webhookCapability(rows, permissions, adapter) {
  const adapterCapabilities = objectValue(adapter?.capabilities);
  if (!rows.some((row) => connectionIsActive(row))) return { state: 'not_connected', label: '未连接' };
  if (permissions.some((value) => /webhook|event/i.test(value)) || adapterCapabilities.webhook === true) {
    return { state: 'available', label: '已配置' };
  }
  return { state: 'needs_validation', label: '未验证' };
}

export function buildPlatformSummaries({
  cards = [],
  connections = [],
  accounts = [],
  adapters = [],
  gateway = {},
  now = new Date(),
} = {}) {
  return cards.map((card) => {
    const safeCard = { ...card };
    delete safeCard.requiredSecrets;
    delete safeCard.callbackUrl;
    const key = String(card.platform || '').toLowerCase();
    const rows = connections.filter((row) => String(row.platform || '').toLowerCase() === key);
    const unified = getUnifiedConnectionState(rows, now);
    const activeRows = unified.activeRows;
    const accountIds = new Set(rows.map((row) => row.account_id).filter(Boolean).map(String));
    const relatedAccounts = accounts.filter((account) => (
      String(account.platform || '').toLowerCase() === key
      || accountIds.has(String(account.id || ''))
    ));
    const permissions = collectConnectionPermissions(rows);
    const adapter = adapters.find((row) => String(row.platform || '').toLowerCase() === key);
    const read = permissionCapability(permissions, /read|collect|content/i, activeRows.length);
    const publish = permissionCapability(permissions, /write|publish|send|media/i, activeRows.length);
    const metrics = permissionCapability(permissions, /metric|analytic|insight|stat/i, activeRows.length);
    const xMcp = key === 'x'
      ? {
        state: gateway.connected && gateway.status?.x_mcp === 'connected' && gateway.status?.x_tools === true ? 'available' : 'failed',
        label: gateway.connected && gateway.status?.x_mcp === 'connected' && gateway.status?.x_tools === true ? '已连接' : '未就绪',
      }
      : null;
    const errors = rows
      .filter((row) => row.error_message || row.status === 'error')
      .map((row) => row.error_message || '连接状态异常');
    const safeRows = rows.map((sourceRow) => {
      const row = { ...sourceRow };
      delete row.connection_config;
      delete row.metadata;
      return row;
    });
    return {
      ...safeCard,
      rows: safeRows,
      activeRows: safeRows.filter((row) => connectionIsActive(row, now)),
      relatedAccounts,
      permissions,
      adapter,
      connectionState: activeRows.length ? { state: 'connected', label: 'OAuth 有效' } : { state: card.implemented ? unified.oauth.state : 'preparing', label: card.implemented ? unified.oauth.label : '准备中' },
      registrationState: { state: relatedAccounts.length ? 'registered' : 'not_started', label: relatedAccounts.length ? '账号已登记' : '尚未登记账号' },
      connectedCount: activeRows.length,
      accountCount: relatedAccounts.length,
      publishableCount: publish.state === 'available' ? relatedAccounts.length : 0,
      read,
      publish,
      metrics,
      webhook: webhookCapability(rows, permissions, adapter),
      token: tokenStatus(rows, now),
      quota: quotaStatus(rows),
      lastVerifiedAt: latestDate(rows),
      errors,
      xMcp,
    };
  });
}
