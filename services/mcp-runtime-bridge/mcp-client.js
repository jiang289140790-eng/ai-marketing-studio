import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let clientPromise;
const MCP_TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || 45_000);

export async function getMcpClient() {
  if (clientPromise) return clientPromise;

  const mcpDir = process.env.MARKETING_STUDIO_MCP_DIR || 'E:\\projects\\video-generator\\mcp-servers\\marketing-studio';
  const serverPath = path.join(mcpDir, 'server.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: mcpDir,
    env: {
      ...process.env,
      MARKETING_STUDIO_BRIDGE: 'true',
    },
  });

  const client = new Client({ name: 'ai-marketing-studio-runtime-bridge', version: '0.1.0' }, { capabilities: {} });
  clientPromise = client.connect(transport).then(() => client);
  return clientPromise;
}

export async function listMcpTools() {
  const client = await getMcpClient();
  const response = await withTimeout(client.listTools(), 'MCP tools/list');
  return response.tools || [];
}

export async function callMcpTool(toolName, args) {
  const client = await getMcpClient();
  const response = await withTimeout(client.callTool({ name: toolName, arguments: args || {} }), `MCP tool ${toolName}`);
  const text = response.content?.find((item) => item.type === 'text')?.text;
  if (!text) return response;
  try {
    return JSON.parse(text);
  } catch {
    return { status: 'success', text };
  }
}

function withTimeout(promise, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} 超过 ${MCP_TOOL_TIMEOUT_MS}ms 未响应。`)), MCP_TOOL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}
