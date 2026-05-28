## Symphony — multi-stage build.
##
## Stage 1 (deps): install npm + production deps.
## Stage 2 (build): TypeScript -> dist/.
## Stage 3 (runtime): minimal image, ships dist/ + node_modules + WORKFLOW.md.

# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-bookworm-slim
ARG GIT_SHA=unknown

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Copy the SDK-patch script BEFORE `npm install` — `package.json`'s
# `postinstall` script invokes it to strip a system-reminder tag that
# `@anthropic-ai/claude-agent-sdk` appends to file Read results, which
# causes autonomous agents to refuse to write code mid-dispatch.
COPY scripts/patch-claude-sdk.mjs ./scripts/patch-claude-sdk.mjs
RUN npm install

FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:${NODE_VERSION} AS runtime
# `gh` CLI is required by PR validation and Release specialists — the agent
# uses it to check CI status, list review threads, and merge PRs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl bash openssh-client gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y --auto-remove gnupg \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PATH="/app/node_modules/.bin:${PATH}" \
    SYMPHONY_BUILD_SHA="${GIT_SHA}"

LABEL org.opencontainers.image.revision="${GIT_SHA}"
LABEL org.opencontainers.image.title="symphony-orchestrator"

WORKDIR /app

# Production deps only (smaller runtime image).
COPY package.json package-lock.json* ./
COPY scripts/patch-claude-sdk.mjs ./scripts/patch-claude-sdk.mjs
RUN npm install --omit=dev \
 && node scripts/patch-claude-sdk.mjs

# Compiled JS + schema + workflow config.
COPY --from=build /app/dist ./dist
COPY src/audit/schema.sql ./schema.sql
# WORKFLOW.md is your deployment's config file. Bake it in or mount it via
# a volume — see docs/deploying.md. SYMPHONY_WORKFLOW_PATH picks which file
# main.ts loads. Defaults to /app/WORKFLOW.md.
COPY WORKFLOW.md ./WORKFLOW.md

# /tmp is writable by the node user on node:22-bookworm-slim.
# workspace.root: /tmp/symphony-workspaces is the default.

ENV SYMPHONY_WORKFLOW_PATH=/app/WORKFLOW.md \
    LOG_LEVEL=info

USER node
CMD ["node", "dist/main.js"]
