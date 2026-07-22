export const ACTION_REGISTRY = {
  health: { tool: 'health_check', async: false },
  create_campaign: { tool: 'create_campaign', async: false },
  generate_strategy: { tool: 'generate_content_strategy', async: true },
  approve_strategy: { tool: 'approve_strategy', async: false, transform: (payload) => ({ ...payload, action: 'approve' }) },
  reject_strategy: { tool: 'approve_strategy', async: false, transform: (payload) => ({ ...payload, action: 'reject' }) },
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
    transform: (payload) => ({
      ...payload,
      dry_run: process.env.ALLOW_REAL_PUBLISH === 'true' ? payload?.dry_run !== false : true,
      real_publish_enabled: process.env.ALLOW_REAL_PUBLISH === 'true',
    }),
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
