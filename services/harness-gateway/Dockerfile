FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force
COPY gateway-core.mjs harness-runner.mjs model-proxy.mjs state-store.mjs server.mjs ./

RUN mkdir -p /data/gateway /data/harness /workspace \
  && chown -R node:node /data /workspace /app

USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    HARNESS_EXECUTABLE=/app/node_modules/.bin/dsh \
    HARNESS_WORKSPACE=/workspace \
    HARNESS_HOME=/data/harness \
    HARNESS_EVENT_FILE=/data/gateway/events.jsonl
EXPOSE 8790
CMD ["node", "server.mjs"]
