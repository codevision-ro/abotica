# syntax=docker/dockerfile:1
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/i18n/package.json packages/i18n/
COPY packages/sandbox/package.json packages/sandbox/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS source
COPY . .

FROM source AS web-build
# Placeholders: modules read these lazily, nothing connects during the build.
RUN DATABASE_URL=postgres://build:build@localhost:5432/build pnpm --filter @abotica/web build

FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# The build script already copies static assets and public/ into the standalone folder.
COPY --from=web-build /app/apps/web/.next/standalone ./
# Runs as the base image's `node` user (uid 1000); the code stays root-owned and read-only to it.
# Writable: Next's cache, and the uploads folder, whose ownership a new named volume takes over.
RUN mkdir -p apps/web/.next/cache /data/uploads && chown node:node apps/web/.next/cache /data/uploads
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# One-off tasks (migrations, seed): only @abotica/db and its production dependencies (drizzle,
# postgres, tsx), run from source. tsx directly instead of the pnpm scripts: corepack keeps pnpm in
# root's home, which the `node` user cannot read.
FROM source AS migrate-build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @abotica/db deploy --legacy --prod /deploy

FROM base AS migrate
ENV NODE_ENV=production
COPY --from=migrate-build /deploy ./
USER node
CMD ["sh", "-c", "node_modules/.bin/tsx src/migrate.ts && node_modules/.bin/tsx src/seed.ts"]

# Only the worker and its production dependencies; workspace packages are copied in as TS source.
FROM source AS worker-build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @abotica/worker deploy --legacy --prod /deploy

# The worker runs from source with tsx (a production dependency of @abotica/worker).
# As the `node` user: it writes only to the uploads folder and /tmp, and reaches docker-proxy over TCP.
FROM base AS worker
ENV NODE_ENV=production
COPY --from=worker-build /deploy ./
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

# Development worker (docker-compose.yml): every dependency installed, the source mounted from the
# checkout and reloaded on change. Rebuilt by `docker compose up --build` when dependencies change.
FROM deps AS worker-dev
ENV NODE_ENV=development
WORKDIR /app/apps/worker
CMD ["node_modules/.bin/tsx", "watch", "src/index.ts"]

# docker-socket-proxy with Abotica's HAProxy template (deploy/docker-socket-proxy), so the compose
# files need no config file next to them. The API sections it opens are the defaults here; compose
# can still override them.
FROM tecnativa/docker-socket-proxy:v0.5.0 AS docker-proxy
ENV POST=1 CONTAINERS=1 EXEC=1 IMAGES=1 INFO=1 NETWORKS=1 VOLUMES=1 EVENTS=0
COPY deploy/docker-socket-proxy/haproxy.cfg.template /usr/local/etc/haproxy/haproxy.cfg.template

# Workspace containers where agents run commands (packages/sandbox, Docker backend). Two stages:
# `sandbox-base` is everything but the browser and is the one published; `sandbox` adds Chrome for
# Testing, downloaded where the image is built (the sandbox-image compose service, as
# abotica-sandbox:latest), so the published image never carries Google's binary. Runs read-only as
# uid 1000; the backend mounts the workspace volume at /workspace and a tmpfs at /opt/abotica/bundles.
FROM ghcr.io/astral-sh/uv:0.12.23 AS uv
FROM composer:2 AS composer
FROM mikefarah/yq:4 AS yq

# Debian 13: PHP 8.4. The tools are what agents reach for while working on code and documents:
# runtimes (Python, Node with pnpm and yarn through corepack, PHP with the extensions Laravel needs),
# a compiler for native npm, pip and PECL modules, database servers and clients, and command-line
# helpers. The database servers run per workspace through `services` (packages/sandbox/image).
FROM node:24-trixie-slim AS sandbox-base
# PostgreSQL gets no system-wide cluster: each workspace initializes its own.
RUN mkdir -p /etc/postgresql-common/createcluster.d \
  && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.d/abotica.conf \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git jq ripgrep fd-find tree file patch procps lsof rsync xz-utils zip unzip tini \
    build-essential pkg-config \
    python3 python3-pip python3-venv \
    php-cli php-mbstring php-xml php-curl php-zip php-intl php-mysql php-pgsql php-sqlite3 php-gd php-bcmath \
    sqlite3 mariadb-server postgresql redis-server \
    poppler-utils imagemagick ffmpeg pandoc \
  && rm -rf /var/lib/apt/lists/* /var/lib/mysql \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && corepack enable
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
COPY --from=yq /usr/bin/yq /usr/local/bin/yq
# The bundled stdio MCP servers (packages/core/src/mcp/mcp-builtins.ts): Scrapling and Playwright MCP,
# with the system libraries Chromium needs; the browser itself comes in the `sandbox` stage.
# They share one Chromium, the revision Scrapling's patchright is built for (Playwright revision
# 1243, Chrome for Testing 153): its stealth fetcher passes Cloudflare only on that revision.
# @playwright/mcp 0.0.80 depends on a Playwright build with the same revision, so it finds that
# Chromium and no second browser is downloaded. When a Scrapling release moves patchright to a newer
# Chromium, bump @playwright/mcp to the release on the same revision, together. No headless shell
# (--no-shell): neither needs it. The same build runs on arm64 (Apple Silicon) and amd64.
# Browsers live outside HOME, which is the workspace volume; PLAYWRIGHT_BROWSERS_PATH stays set at
# runtime so both find them. Caches go to /tmp and are removed, so nothing lands in the image or
# under /workspace. License files shipped with the packages stay in place (THIRD_PARTY_NOTICES).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN export UV_NO_CACHE=1 npm_config_cache=/tmp/npm-cache \
  && uv venv /opt/scrapling --python /usr/bin/python3 \
  && VIRTUAL_ENV=/opt/scrapling uv pip install "scrapling[ai]==0.4.15" \
  && /opt/scrapling/bin/python -m playwright install-deps chromium \
  && npm install -g --prefix /usr/local @playwright/mcp@0.0.80 \
  && ln -s /opt/scrapling/bin/scrapling /usr/local/bin/scrapling \
  && rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache /root/.npm
COPY --chmod=0755 packages/sandbox/image/services /usr/local/bin/services
COPY --chmod=0755 packages/sandbox/image/abotica-proxy-run /usr/local/bin/abotica-proxy-run
# The base image's `node` user has uid 1000; the sandbox user takes its place. MCP servers run as
# their own user (uid 1001), so agent commands cannot read their environment or memory.
RUN userdel --remove node \
  && groupadd --gid 1000 sandbox \
  && useradd --uid 1000 --gid 1000 --home-dir /workspace/.home --no-create-home --shell /bin/bash sandbox \
  && groupadd --gid 1001 mcp \
  && useradd --uid 1001 --gid 1001 --home-dir /opt/abotica/mcp/home --no-create-home --shell /usr/sbin/nologin mcp \
  && mkdir -p /workspace/.home /opt/abotica/bundles \
  && chown -R sandbox:sandbox /workspace
# HOME is inside the workspace volume, so caches and `npm install -g` / `uv tool install` survive restarts.
ENV HOME=/workspace/.home \
  LANG=C.UTF-8 \
  NPM_CONFIG_PREFIX=/workspace/.home/.npm-global \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COMPOSER_NO_INTERACTION=1 \
  PATH=/workspace/.home/.npm-global/bin:/workspace/.home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER sandbox
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

# The image the workspace containers run: sandbox-base plus Chrome for Testing (the revision the
# base's Scrapling expects) and the extra Debian packages from SANDBOX_APT_PACKAGES in .env
# (space separated). docker-compose.prod.yml builds the same two steps on top of the published base.
FROM sandbox-base AS sandbox
ARG SANDBOX_APT_PACKAGES=""
USER root
RUN if [ -n "$SANDBOX_APT_PACKAGES" ]; then \
    apt-get update && apt-get install -y --no-install-recommends $SANDBOX_APT_PACKAGES \
    && rm -rf /var/lib/apt/lists/*; \
  fi \
  && HOME=/root /opt/scrapling/bin/python -m playwright install --no-shell chromium \
  && rm -rf /tmp/* /root/.cache
USER sandbox
