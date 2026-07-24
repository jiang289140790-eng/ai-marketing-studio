FROM node:22-alpine

ENV NODE_ENV=production \
    MCP_RUNTIME_BRIDGE_HOST=0.0.0.0 \
    MCP_RUNTIME_BRIDGE_PORT=8787 \
    MARKETING_STUDIO_MCP_DIR=/app/marketing-studio-mcp \
    MARKETING_STUDIO_MCP_COMMAND=node \
    MARKETING_STUDIO_MCP_ARGS='["/app/marketing-studio-mcp/server.js"]' \
    ALLOW_REAL_PUBLISH=false

WORKDIR /app/marketing-studio-mcp
COPY marketing-studio-mcp/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY marketing-studio-mcp/ ./

WORKDIR /app/bridge
COPY bridge/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bridge/ ./

EXPOSE 8787
CMD ["node", "server.js"]
