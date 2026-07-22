export function getExecutionStatus() {
  return {
    connected: false,
    label: '执行服务未连接',
    reason:
      'GitHub Pages 是静态前端，不能直接携带 service role、平台 Token、MCP 凭据或 ComfyUI 内网地址。需要通过 Supabase Edge Function、可信 API 或本地 MCP Runtime 执行。',
  };
}

export function getUnavailableReason(actionName) {
  return `${actionName} 暂不可执行：当前线上站点只展示真实数据与审批流，执行动作需要连接可信 Agent/MCP 服务端。`;
}

export function isExecutionAvailable() {
  return getExecutionStatus().connected;
}
