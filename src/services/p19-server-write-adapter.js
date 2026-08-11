// P19 前端服务端写入适配器：默认禁用（部署门禁）。
//
// 目的：记录未来授权 staging 写入边界的唯一调用入口契约，同时保证
// 在门禁开放之前浏览器绝不发出任何写入请求、绝不触碰任何私有表。
//
// 部署门禁（未满足前本适配器保持禁用）：
// 1. supabase/functions/p19-workspace-command 已部署并经过端到端验收
//    （JWT subject 派生、staging 角色、allowlist、幂等、哈希全部通过）；
// 2. 20260812000000_p19_workspace_command_contract_v1 迁移已在授权 staging 环境应用；
// 3. 应用运行时配置了函数 URL 与公开匿名令牌（无任何服务端密钥进入浏览器）。
//
// 禁用状态下 submitWorkspaceCommand 恒抛有界错误（SERVER_WRITE_DISABLED），
// 绝不 fetch、绝不写入、绝不读取私有表。本模块不导入任何 Supabase 客户端。

import { workbenchError } from './p19-workspace-service.js';

export const P19_SERVER_WRITE_ENABLED = false;

export const DEPLOYMENT_GATE_MESSAGE =
  '浏览器写入适配器默认禁用：p19-workspace-command 边界尚未部署，也没有任何浏览器写入授权。' +
  '本地编辑只保存在 p19_store_v1（localStorage），请使用导出/导入做本地备份。';

export function isServerWriteEnabled() {
  return P19_SERVER_WRITE_ENABLED === true;
}

/**
 * 提交一条版本化命令到未来的授权 staging 写入边界。
 * 当前恒禁用：直接抛有界错误，不发起任何请求。
 */
export async function submitWorkspaceCommand() {
  if (!isServerWriteEnabled()) {
    throw workbenchError('SERVER_WRITE_DISABLED', DEPLOYMENT_GATE_MESSAGE);
  }
  // 门禁开放后：仅允许向已部署的 p19-workspace-command 端点提交
  // p19_command_contract_v1 信封；仍不携带任何服务端密钥。
  throw workbenchError('SERVER_WRITE_DISABLED', DEPLOYMENT_GATE_MESSAGE);
}
