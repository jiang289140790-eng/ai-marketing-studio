FROM node:22-bookworm-slim

WORKDIR /app
COPY services/harness-gateway/package.json services/harness-gateway/package-lock.json ./
COPY services/harness-gateway/plugins ./plugins
COPY services/harness-gateway/profile ./profile
COPY services/harness-gateway/profile-web ./profile-web
COPY services/harness-gateway/vendor ./vendor
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force
COPY services/harness-gateway/gateway-core.mjs services/harness-gateway/harness-runner.mjs services/harness-gateway/conversation-runner.mjs services/harness-gateway/conversation-delivery-queue.mjs services/harness-gateway/conversation-event-store.mjs services/harness-gateway/conversation-projector.mjs services/harness-gateway/conversation-sanitize.mjs services/harness-gateway/task-projector.mjs services/harness-gateway/model-proxy.mjs services/harness-gateway/state-store.mjs services/harness-gateway/server.mjs services/harness-gateway/tool-contract.mjs services/harness-gateway/tool-client.mjs services/harness-gateway/init-profile.mjs services/harness-gateway/start.mjs services/harness-gateway/home-lockdown.patch.yml services/harness-gateway/planner.mjs services/harness-gateway/deterministic-executor.mjs services/harness-gateway/workflow-catalog.mjs services/harness-gateway/capability-registry.mjs services/harness-gateway/execution-critic.mjs services/harness-gateway/project-task-memory.mjs services/harness-gateway/semantic-planner.mjs ./
COPY services/harness-gateway/presentation ./presentation

# Repository-root inputs imported by the deterministic planner/executor:
COPY package.json /package.json
COPY src /src
COPY supabase/functions/p22-research-assist/assist-core.mjs /supabase/functions/p22-research-assist/assist-core.mjs
# Repository-relative imports resolve /node_modules onto the service tree:
RUN ln -s /app/node_modules /node_modules

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
CMD ["node", "start.mjs"]
