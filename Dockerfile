# API server only — skips Expo/mobile packages (avoids pnpm hoisted bin conflicts).
FROM node:24-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

ENV CI=true
ENV npm_config_user_agent=pnpm/10.0.0
ENV NODE_ENV=production
ENV PORT=8080

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY artifacts/api-server ./artifacts/api-server
COPY lib ./lib

RUN pnpm install --frozen-lockfile \
  --config.minimumReleaseAge=0 \
  --config.node-linker=isolated \
  --filter @workspace/api-server...

EXPOSE 8080

# Workspace libs export .ts; tsx is the supported production entry (same as dev).
CMD ["pnpm", "--filter", "@workspace/api-server", "exec", "tsx", "./src/index.ts"]
