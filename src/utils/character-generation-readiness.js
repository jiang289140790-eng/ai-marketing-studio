import { parseLoraConfig } from './lora.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function workflowId(value) {
  if (typeof value === 'string') return value;
  return value?.workflow_id || value?.id || value?.name || '';
}

function runTime(run) {
  return new Date(run.completed_at || run.created_at || 0).getTime();
}

function loraInfo(character) {
  return {
    ...parseLoraConfig(character.lora),
    ...asObject(character.lora_info),
  };
}

export function evaluateCharacterReadiness(character, {
  accounts = [],
  assets = [],
  workflows = [],
  runs = [],
} = {}) {
  const lora = loraInfo(character);
  const recommended = (character.recommended_workflows || []).map(workflowId).filter(Boolean);
  if (lora.workflow) recommended.push(lora.workflow);
  const usableWorkflow = workflows.find((workflow) => (
    recommended.includes(workflow.id)
    || recommended.includes(workflow.name)
  ) && ['active', 'enabled', 'ready'].includes(String(workflow.status || '').toLowerCase()));
  const characterRuns = runs
    .filter((run) => String(run.character_id || '') === String(character.id))
    .sort((left, right) => runTime(right) - runTime(left));
  const latestRun = characterRuns[0] || null;
  const successfulRun = characterRuns.find((run) => ['success', 'completed'].includes(String(run.status || '').toLowerCase())) || null;
  const resultAssetIds = new Set(characterRuns.flatMap((run) => run.asset_ids || []).map(String));
  const characterAssets = assets.filter((asset) => (
    String(asset.characterId || asset.character_id || asset.raw?.metadata?.character_id || '') === String(character.id)
    || resultAssetIds.has(String(asset.id))
  ));
  const referenceAssets = characterAssets.filter((asset) => (
    asset.raw?.metadata?.reference === true
    || asset.raw?.metadata?.usability === 'approved'
    || asset.approvedForPublishing
  ));
  const boundAccounts = accounts.filter((account) => String(account.character_id || '') === String(character.id));
  const profileComplete = Boolean(
    character.name
    && (character.appearance || Object.keys(asObject(character.visual_spec)).length)
    && (character.prompt || Object.keys(asObject(character.prompt_templates)).length),
  );
  const hasReference = Boolean(character.avatar || referenceAssets.length);
  const hasLora = Boolean(lora.name || lora.model || lora.filename || lora.autodl_path || lora.huggingface_repo);
  const loraAccessible = hasLora && (
    ['validated', 'available', 'ready', 'active'].includes(String(lora.status || '').toLowerCase())
    || Boolean(lora.filename || lora.autodl_path || lora.huggingface_repo)
  );
  const hasWorkflow = recommended.length > 0;
  const testPassed = Boolean(successfulRun);

  let state = 'ready';
  let label = '可生成';
  let blocking = '无阻塞';
  if (!hasLora) {
    state = 'lora_unavailable';
    label = 'LoRA 不可用';
    blocking = '尚未绑定 LoRA，请先配置角色模型。';
  } else if (!loraAccessible) {
    state = 'lora_unavailable';
    label = 'LoRA 不可用';
    blocking = 'LoRA 已登记，但文件可访问性尚未验证。';
  } else if (!hasWorkflow || !usableWorkflow) {
    state = 'workflow_unavailable';
    label = '工作流不可用';
    blocking = hasWorkflow ? '推荐工作流未启用。' : '尚未绑定推荐工作流。';
  } else if (!profileComplete) {
    state = 'incomplete';
    label = '配置不完整';
    blocking = '角色设定、视觉身份或基础提示词仍不完整。';
  } else if (!hasReference || !testPassed) {
    state = 'partial';
    label = '部分可用';
    blocking = !hasReference ? '缺少可用参考图。' : '尚无最近通过的生成测试。';
  }

  return {
    state,
    label,
    blocking,
    lora,
    profileComplete,
    hasReference,
    hasLora,
    loraAccessible,
    hasWorkflow,
    usableWorkflow,
    latestRun,
    successfulRun,
    testPassed,
    boundAccounts,
    characterAssets,
    referenceAssets,
  };
}

export function characterStatusClass(state) {
  if (state === 'ready') return 'available';
  if (state === 'partial') return 'warning';
  if (state === 'incomplete') return 'pending';
  return 'failed';
}

