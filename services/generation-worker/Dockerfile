FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force
COPY config.mjs bailian-adapter.mjs db-adapter.mjs storage-adapter.mjs worker.mjs recover-existing-task.mjs ./

USER node
ENV NODE_ENV=production
CMD ["node", "worker.mjs"]
