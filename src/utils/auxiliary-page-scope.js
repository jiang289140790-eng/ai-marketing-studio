const TEST_PATTERN = /(?:^|[\s_-])(phase\s*[2789]|debug|test(?:ing)?|fixture|mock|smoke|nightly|自动化测试|测试数据|回归测试)(?:$|[\s_-])/i;

export const AUXILIARY_DATA_SCOPES = [
  { value: 'campaign', label: '当前运营活动' },
  { value: 'account', label: '当前账号' },
  { value: 'history', label: '全部历史' },
  { value: 'test', label: '测试数据' },
];

const ID_FIELDS = {
  campaign: ['campaign_id', 'campaignId', 'source_campaign_id'],
  account: ['account_id', 'social_account_id', 'primary_account_id', 'target_account_id'],
  package: ['content_package_id', 'contentPackageId', 'package_id'],
  strategy: ['strategy_id', 'strategy_plan_id', 'source_strategy_id'],
  character: ['character_id', 'characterId'],
  publish: ['publish_task_id', 'publishTaskId'],
  workflow: ['workflow_id', 'workflowId', 'recommended_workflow_id'],
};

export function isTestRecord(record = {}) {
  const metadata = asObject(record.metadata);
  if (
    record.is_test === true
    || metadata.is_test === true
    || metadata.test === true
    || ['test', 'testing', 'debug'].includes(String(record.environment || metadata.environment || '').toLowerCase())
  ) return true;

  const text = [
    record.name,
    record.title,
    record.account_name,
    record.username,
    record.source,
    record.source_type,
    record.created_by,
    record.agent_name,
    metadata.source,
    metadata.created_by,
    metadata.campaign_type,
    metadata.run_type,
  ].filter(Boolean).join(' ');

  return TEST_PATTERN.test(` ${text} `);
}

export function filterRecordsForAuxiliaryScope(
  records = [],
  {
    scope = 'campaign',
    campaignContext,
    activeCampaignId,
    includeGlobal = false,
  } = {},
) {
  const rows = Array.isArray(records) ? records : [];
  if (scope === 'test') return rows.filter(isTestRecord);

  const productionRows = rows.filter((record) => !isTestRecord(record));
  if (scope === 'history') return productionRows;

  const identity = buildCampaignIdentity(campaignContext, activeCampaignId);
  return productionRows.filter((record) => {
    if (scope === 'account') {
      return hasIdentity(record, 'account', identity.primaryAccountIds)
        || isAccountEntity(record, identity.primaryAccountIds)
        || (includeGlobal && !hasAnyBusinessIdentity(record));
    }

    return hasIdentity(record, 'campaign', identity.campaignIds)
      || hasIdentity(record, 'account', identity.accountIds)
      || hasIdentity(record, 'package', identity.packageIds)
      || hasIdentity(record, 'strategy', identity.strategyIds)
      || hasIdentity(record, 'character', identity.characterIds)
      || hasIdentity(record, 'publish', identity.publishTaskIds)
      || hasIdentity(record, 'workflow', identity.workflowIds)
      || isAccountEntity(record, identity.accountIds)
      || isCharacterEntity(record, identity.characterIds)
      || (includeGlobal && !hasAnyBusinessIdentity(record));
  });
}

export function auxiliaryScopeLabel(scope) {
  return AUXILIARY_DATA_SCOPES.find((item) => item.value === scope)?.label || '当前运营活动';
}

function buildCampaignIdentity(context, activeCampaignId) {
  const campaignMetadata = asObject(context?.campaign?.metadata);
  const boundCharacters = (context?.characterBindings || []).map((item) => item.character).filter(Boolean);
  return {
    campaignIds: new Set([activeCampaignId, context?.campaign?.id].filter(Boolean).map(String)),
    accountIds: new Set([
      context?.primaryAccount?.id,
      ...(context?.competitorAccounts || []).map((item) => item.id),
    ].filter(Boolean).map(String)),
    primaryAccountIds: new Set([context?.primaryAccount?.id].filter(Boolean).map(String)),
    packageIds: new Set((context?.contentPackages || []).map((item) => String(item.id))),
    strategyIds: new Set([
      context?.currentStrategy?.id,
      ...(context?.contentPackages || []).map((item) => item.strategy_plan_id || item.strategy_id),
    ].filter(Boolean).map(String)),
    characterIds: new Set([
      ...((context?.characterBindings || []).map((item) => item.characterId || item.character?.id)),
      ...((context?.mediaAssets || []).map((item) => item.character_id)),
      campaignMetadata.default_character_id,
      campaignMetadata.character_id,
    ].filter(Boolean).map(String)),
    publishTaskIds: new Set((context?.publishTasks || []).map((item) => String(item.id))),
    workflowIds: new Set([
      campaignMetadata.workflow_id,
      campaignMetadata.default_workflow_id,
      ...boundCharacters.flatMap((item) => normalizeIds(
        item.recommended_workflows || item.recommended_workflow || item.workflow_id,
      )),
    ].filter(Boolean).map(String)),
  };
}

function hasIdentity(record, type, acceptedIds) {
  if (!acceptedIds.size) return false;
  return extractValues(record, ID_FIELDS[type]).some((value) => acceptedIds.has(String(value)));
}

function isAccountEntity(record, accountIds) {
  return Boolean(record?.id && accountIds.has(String(record.id)));
}

function isCharacterEntity(record, characterIds) {
  return Boolean(record?.id && characterIds.has(String(record.id)));
}

function hasAnyBusinessIdentity(record) {
  return Object.values(ID_FIELDS).some((fields) => extractValues(record, fields).length > 0);
}

function extractValues(record, fields) {
  const containers = [
    record,
    asObject(record?.metadata),
    asObject(record?.source_insights),
    asObject(record?.generation_brief),
    asObject(record?.input),
    asObject(record?.input_data),
    asObject(record?.output_data),
  ];
  return containers.flatMap((container) => fields.flatMap((field) => normalizeIds(container[field])));
}

function normalizeIds(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeIds);
  if (value && typeof value === 'object') {
    return normalizeIds(value.id || value.account_id || value.campaign_id || value.character_id);
  }
  return value == null || value === '' ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
