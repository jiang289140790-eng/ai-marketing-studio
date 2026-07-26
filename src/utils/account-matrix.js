import { connectionIsActive, getUnifiedConnectionState } from './platform-connection-summary.js';

const REFERENCE_ROLES = new Set(['competitor', 'inspiration']);
const OWNED_ROLES = new Set(['owned', 'brand', 'personal']);
const DAMAGED_TEXT = /\uFFFD|\0|(?:Ã.|Â.|ä¸|æ—|çš„|é—|å­|鎴|璐﹀彿)|\?{2,}/;

export function getAccountRole(account = {}) {
  const role = String(
    account.account_role || account.account_type || account.account_category || 'owned',
  ).toLowerCase();
  if (OWNED_ROLES.has(role)) return 'owned';
  return REFERENCE_ROLES.has(role) ? role : 'owned';
}

export function isDamagedText(value) {
  return typeof value === 'string' && DAMAGED_TEXT.test(value);
}

export function safeBusinessText(value, fallback = '—') {
  if (value == null || value === '') return { text: fallback, damaged: false };
  if (isDamagedText(value)) return { text: '原内容损坏', damaged: true };
  return { text: String(value), damaged: false };
}

function normalizedHandle(account = {}) {
  return String(account.username || account.handle || account.account_name || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function normalizedUrl(account = {}) {
  const value = account.profile_url || account.account_url || '';
  return String(value).trim().replace(/\/+$/, '').toLowerCase();
}

function externalUserIds(account, connections) {
  return connections
    .filter((row) => String(row.account_id || '') === String(account.id || ''))
    .flatMap((row) => {
      const metadata = normalizeObject(row.metadata);
      return [
        metadata.external_user_id,
        metadata.platform_user_id,
        metadata.account_user_id,
      ].filter(Boolean).map(String);
    });
}

export function findDuplicateAccounts(accounts = [], connections = []) {
  const reasonsById = new Map();
  const indexes = [new Map(), new Map(), new Map()];
  accounts.forEach((account) => {
    const keys = [
      `${String(account.platform || '').toLowerCase()}|${normalizedHandle(account)}`,
      normalizedUrl(account),
      externalUserIds(account, connections),
    ];
    keys.forEach((rawKey, index) => {
      const values = Array.isArray(rawKey) ? rawKey : [rawKey];
      values.filter((value) => value && !String(value).endsWith('|')).forEach((value) => {
        const list = indexes[index].get(value) || [];
        indexes[index].set(value, [...list, account.id]);
      });
    });
  });
  const labels = ['平台和账号名相同', '主页链接相同', '平台用户 ID 相同'];
  indexes.forEach((index, indexNumber) => {
    index.forEach((ids) => {
      if (ids.length < 2) return;
      ids.forEach((id) => {
        reasonsById.set(id, [...(reasonsById.get(id) || []), labels[indexNumber]]);
      });
    });
  });
  return reasonsById;
}

function normalizeObject(value) {
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

function listValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function latest(rows, fields = ['updated_at', 'created_at']) {
  return [...rows].sort((left, right) => {
    const leftTime = new Date(fields.map((key) => left[key]).find(Boolean) || 0).getTime();
    const rightTime = new Date(fields.map((key) => right[key]).find(Boolean) || 0).getTime();
    return rightTime - leftTime;
  })[0] || null;
}

function campaignIncludesAccount(campaign, account) {
  const metadata = normalizeObject(campaign.metadata);
  const ids = [
    campaign.primary_account_id,
    campaign.account_id,
    metadata.primary_account_id,
    ...listValue(campaign.target_accounts),
    ...listValue(metadata.competitor_account_ids),
    ...listValue(metadata.inspiration_account_ids),
  ].map(String);
  return ids.includes(String(account.id))
    || ids.includes(normalizedHandle(account))
    || ids.includes(`@${normalizedHandle(account)}`);
}

function capabilityFromConnections(connections, kind) {
  const active = connections.filter(connectionIsActive);
  if (!active.length) return { state: 'not_connected', label: kind === 'publish' ? '不可发布' : '不可用' };
  const permissions = active.flatMap((row) => listValue(row.permissions));
  const tests = {
    read: /read|collect|content/i,
    publish: /write|publish|send|media/i,
    metrics: /metric|analytic|insight|stat/i,
  };
  if (permissions.some((permission) => tests[kind].test(String(permission)))) {
    return { state: 'available', label: '可用' };
  }
  return { state: 'needs_validation', label: '待验证' };
}

function brainState(account, profile, report) {
  if (report?.status === 'completed' || report?.account_brain || account.brain_data || profile) {
    return { state: 'completed', label: '已生成' };
  }
  if (report?.status === 'running') return { state: 'running', label: '分析中' };
  if (report?.status === 'failed') return { state: 'failed', label: '生成失败' };
  return { state: 'not_started', label: '未生成' };
}

export function buildAccountMatrixRows({
  accounts = [],
  connections = [],
  accountReports = [],
  viralContents = [],
  contentAnalysis = [],
  characters = [],
  campaigns = [],
  publishTasks = [],
} = {}) {
  const duplicates = findDuplicateAccounts(accounts, connections);
  return accounts.map((account) => {
    const role = getAccountRole(account);
    const accountConnections = connections.filter((row) => String(row.account_id || '') === String(account.id));
    const connectionState = getUnifiedConnectionState(accountConnections);
    const reports = accountReports.filter((row) => String(row.account_id || '') === String(account.id));
    const samples = viralContents.filter((row) => (
      String(row.social_account_id || '') === String(account.id)
      || String(row.account_id || '') === String(account.id)
    ));
    const analyses = contentAnalysis.filter((row) => String(row.social_account_id || '') === String(account.id));
    const relatedCampaigns = campaigns.filter((campaign) => campaignIncludesAccount(campaign, account));
    const profile = Array.isArray(account.account_profiles) ? account.account_profiles[0] : account.account_profiles;
    const report = latest(reports);
    const character = characters.find((row) => String(row.id || '') === String(account.character_id || '')) || null;
    const publishes = publishTasks.filter((task) => (
      accountConnections.some((row) => String(row.id) === String(task.platform_connection_id || ''))
      || String(task.platform_account_id || '') === String(account.id)
    ));
    const fieldsToCheck = [
      account.account_name, account.username, account.target_audience,
      account.content_strategy, account.strategy_summary,
    ];
    const warnings = [];
    if (fieldsToCheck.some(isDamagedText)) warnings.push('存在无法可靠恢复的乱码字段');
    const duplicateReasons = duplicates.get(account.id) || [];
    if (duplicateReasons.length) warnings.push(`疑似重复：${duplicateReasons.join('、')}`);
    if (role !== 'owned' && samples.length === 0) warnings.push('暂无有效内容样本');
    if (role !== 'owned' && !report) warnings.push('尚未生成账号分析报告');
    const confidence = Number(
      report?.confidence_score
      || profile?.confidence_score
      || normalizeObject(report?.account_brain).confidence_score
      || 0,
    );
    const patterns = listValue(
      report?.recommendations
      || normalizeObject(report?.account_brain).replicable_patterns
      || profile?.viral_patterns,
    );
    return {
      ...account,
      role,
      connections: accountConnections,
      connectionState,
      reports,
      latestReport: report,
      samples,
      analyses,
      campaigns: relatedCampaigns,
      character,
      publishes,
      lastPublish: latest(publishes, ['published_at', 'scheduled_at', 'updated_at', 'created_at']),
      lastAnalysis: latest([...reports, ...analyses], ['last_analyzed_at', 'updated_at', 'created_at']),
      brain: brainState(account, profile, report),
      profile,
      readCapability: capabilityFromConnections(accountConnections, 'read'),
      publishCapability: capabilityFromConnections(accountConnections, 'publish'),
      metricsCapability: capabilityFromConnections(accountConnections, 'metrics'),
      confidence,
      patterns,
      sourceLabel: samples.some((row) => row.source_platform) ? '平台采集' : samples.length ? '历史导入' : '尚无数据',
      dataWarnings: warnings,
      nextAction: role === 'owned'
        ? (!connectionState.oauthValid ? '连接平台' : !account.brain_data && !profile && !report ? '生成账号大脑' : '查看运营状态')
        : (!samples.length ? '抓取内容样本' : !report ? '分析账号' : '查看可复制模式'),
    };
  });
}

export function isReferenceAccount(account) {
  return REFERENCE_ROLES.has(getAccountRole(account));
}
