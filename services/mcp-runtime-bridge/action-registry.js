export const ACTION_REGISTRY = {
  health: { tool: 'health_check', async: false },
  create_campaign: { tool: 'create_campaign', async: false },
  generate_strategy: { tool: 'generate_content_strategy', async: true },
  approve_strategy: { tool: 'approve_strategy', async: false, transform: (payload) => ({ ...payload, action: 'approve' }) },
  reject_strategy: { tool: 'approve_strategy', async: false, transform: (payload) => ({ ...payload, action: 'reject' }) },
  generate_campaign_strategy: { tool: 'generate_campaign_strategy', async: true },
  approve_campaign_strategy: { tool: 'approve_campaign_strategy', async: false },
  generate_7_day_plan: { tool: 'generate_7_day_plan', async: true },
  approve_7_day_plan: { tool: 'approve_7_day_plan', async: false },
  create_content_packages_from_daily_plan: { tool: 'create_content_packages_from_daily_plan', async: false },
  get_campaign_day_status: { tool: 'get_campaign_day_status', async: false },
  start_campaign_day: { tool: 'start_campaign_day', async: false },
  generate_content_for_package: { tool: 'generate_content_for_package', async: true },
  list_content_versions: { tool: 'list_content_versions', async: false },
  select_content_version: { tool: 'select_content_version', async: false },
  revise_content: { tool: 'revise_content', async: true },
  approve_content: { tool: 'approve_content', async: false },
  request_content_revision: { tool: 'request_content_revision', async: false },
  get_content_readiness: { tool: 'get_content_readiness', async: false },
  get_character_for_campaign: { tool: 'get_character_for_campaign', async: false },
  list_character_loras: { tool: 'list_character_loras', async: false },
  create_asset_generation_job: { tool: 'create_asset_generation_job', async: true },
  get_generation_job: { tool: 'get_generation_job', async: false },
  retry_generation_job: { tool: 'retry_generation_job', async: true },
  list_assets_for_content: { tool: 'list_assets_for_content', async: false },
  attach_asset_to_content: { tool: 'attach_asset_to_content', async: false },
  set_primary_asset: { tool: 'set_primary_asset', async: false },
  approve_asset: { tool: 'approve_asset', async: false },
  generate_content: { tool: 'compose_content', async: true },
  rewrite_content: { tool: 'compose_content', async: true },
  save_draft: { tool: 'compose_content', async: false, transform: (payload) => ({ ...payload, move_to_review: false }) },
  generate_character_image: { tool: 'generate_character_image', async: true },
  generate_character_video: { tool: 'generate_character_video', async: true },
  poll_asset_status: { tool: 'poll_asset_status', async: false },
  review_generated_asset: { tool: 'review_generated_asset', async: false },
  regenerate_asset: { tool: 'regenerate_asset', async: true },
  finalize_content_package: { tool: 'finalize_content_package', async: false },
  approve_publish: { tool: 'approve_publish', async: false, transform: (payload) => ({ ...payload, action: 'approve' }) },
  reject_publish: { tool: 'approve_publish', async: false, transform: (payload) => ({ ...payload, action: 'reject' }) },
  execute_publish: {
    tool: 'execute_publish',
    async: true,
    transform: (payload) => {
      const realPublishEnabled = process.env.ALLOW_REAL_PUBLISH === 'true';
      const humanConfirmed = payload?.human_confirmed === true;
      const realPublishRequested = payload?.dry_run === false && payload?.preflight_only !== true;
      return {
        ...payload,
        dry_run: !(realPublishEnabled && humanConfirmed && realPublishRequested),
        human_confirmed: humanConfirmed,
        real_publish_enabled: realPublishEnabled,
      };
    },
  },
  analyze_account: { tool: 'analyze_account_intelligence', async: true },
};

export const NOT_CONFIGURED_ACTIONS = {
  sync_x_account: 'X MCP 同步需要在 Bridge 运行环境中配置 X MCP 授权。',
  import_x_reference: 'X 链接导入需要在 Bridge 运行环境中配置 X MCP 与私有 Storage 写入能力。',
  upload_reference_asset: '参考素材上传需要单独的受控上传接口，不能通过通用 MCP action 传二进制。',
};

export function getActionDefinition(action) {
  return ACTION_REGISTRY[action] || null;
}
