export const ALLOWED_ACTIONS = [
  'create_campaign',
  'generate_strategy',
  'approve_strategy',
  'reject_strategy',
  'generate_content',
  'rewrite_content',
  'save_draft',
  'import_x_reference',
  'upload_reference_asset',
  'generate_character_image',
  'generate_character_video',
  'poll_asset_status',
  'review_generated_asset',
  'regenerate_asset',
  'finalize_content_package',
  'approve_publish',
  'reject_publish',
  'execute_publish',
  'sync_x_account',
  'analyze_account',
];

export function validateActionRequest(body) {
  if (!body || typeof body !== 'object') throw new Error('请求体为空。');
  if (!body.run_id) throw new Error('缺少 run_id。');
  if (!body.user_id) throw new Error('缺少 user_id。');
  if (!ALLOWED_ACTIONS.includes(body.action)) throw new Error('不允许的 action。');
  if (body.payload && JSON.stringify(body.payload).length > 64 * 1024) throw new Error('payload 过大。');
  return body;
}
