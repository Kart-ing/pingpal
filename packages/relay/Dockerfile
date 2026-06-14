# syntax=docker/dockerfile:1
# Multi-stage build for the PingPal relay. Builds the whole pnpm workspace
# (the relay depends on @pingpal/protocol) and ships only the relay + its
# production deps in a slim runtime image.
#
# Build from the REPO ROOT so the workspace is in context:
#   docker build -f packages/relay/Dockerfile -t pingpal-relay .

# ---- builder ---------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable

# Install deps with the lockfile first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay/package.json packages/relay/
RUN pnpm install --frozen-lockfile --filter @pingpal/relay...

# Bring in sources and build protocol + relay.
COPY packages/protocol packages/protocol
COPY packages/relay packages/relay
RUN pnpm --filter @pingpal/relay... build

# Prune to production dependencies only.
RUN pnpm --filter @pingpal/relay --prod deploy /out

# ---- runtime ---------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

# Run as the built-in non-root user.
USER node
COPY --chown=node:node --from=builder /out ./

EXPOSE 8787
CMD ["node", "dist/bin.js"]
