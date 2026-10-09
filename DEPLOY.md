# Deploy

Abotica runs on Linux (amd64 or arm64), macOS and Windows 10 or 11 (with Docker Desktop), from the images published with each release.

- **Install script** (recommended): one command installs Docker when it is missing, writes the configuration with fresh secrets and starts everything.
- **Docker by hand**: the same compose file and `.env`, written yourself.
- **Without Docker**: Postgres, Redis and Node already on the server, the project built from source. There is no sandbox: agents work without workspace tools and stdio MCP servers (the bundled Playwright and Scrapling included).

`GET /api/health` returns `200` when the web app can reach Postgres and Redis, `503` otherwise. It is public and exposes nothing besides the status, so it works well for an uptime monitor.

## Install script

```bash
curl -fsSL https://raw.githubusercontent.com/codevision-ro/abotica/main/install.sh | bash
```

It asks for a domain. With one, the bundled Caddy serves Abotica over HTTPS and obtains the certificates itself: point the domain and `*.preview.<domain>` (agents' previews) to the server and open ports 80 and 443. Without one, Abotica is reachable only from the machine itself, on `http://localhost:3000`.

What it does:

1. Installs Docker with [get.docker.com](https://get.docker.com) when it is missing (Linux; on macOS install [OrbStack](https://orbstack.dev) or Docker Desktop first). Docker Compose 2.23.1 or newer is required.
2. Downloads the compose file of the latest release into `/opt/abotica` (as root) or `~/abotica`, as `docker-compose.yml`.
3. On the first run, writes `.env` there: the release, the domain, and new values for `BETTER_AUTH_SECRET`, `VAULT_KEY`, `POSTGRES_PASSWORD` and `SETUP_CODE`.
4. Pulls the images and starts Postgres, Redis, the migrations and the seed, the web app, the worker, the sandbox, the daily backup and, with a domain, Caddy. The first start also builds the sandbox image, which takes a few minutes.

Then open the sign-up link it prints (`/signup?code=...`) and create your account. Creating the account needs `SETUP_CODE`, so nobody who finds the server first can claim it; the first account is the only one, and sign-up closes after it.

Options, also as environment variables: `--domain NAME` (`ABOTICA_DOMAIN`), `--dir PATH` (`ABOTICA_DIR`), `--version X.Y.Z` (`ABOTICA_VERSION`), `--yes` for no questions. For example:

```bash
curl -fsSL https://raw.githubusercontent.com/codevision-ro/abotica/main/install.sh | bash -s -- --domain abotica.example.com --yes
```

### Windows

With [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/codevision-ro/abotica/main/install.ps1 | iex
```

`install.ps1` does the same as `install.sh`: it offers to install Docker Desktop with winget when it is missing, starts it when it is not running, installs into `%USERPROFILE%\abotica`, writes `.env` on the first run, starts everything and opens the sign-up link. Options are environment variables set before the command, for example `$env:ABOTICA_DOMAIN = "abotica.example.com"`; `ABOTICA_DIR`, `ABOTICA_VERSION` and `ABOTICA_YES=1` work as well. Docker Desktop runs its containers in WSL2, which it sets up itself; the sandbox works the same as on Linux.

**Update:** run the same command again. It backs up the database into `backups/pre-update-<old version>-<date>.dump`, keeps `.env`, moves `ABOTICA_VERSION` to the latest release, downloads that release's compose file and restarts what changed. Migrations run on every start. **Settings > System** shows when a new release is out (a notice also goes to Telegram), with its release notes and this command.

**Runs in progress** when you update (or restart the worker): before changing anything, the installer counts the agent runs executing and asks whether to wait for them (up to 10 minutes), continue or abort; with `--yes` (`ABOTICA_YES=1` on Windows) it warns and continues. Settings > System shows the same count. When the worker stops, it takes no new runs and gives the ones in progress `WORKER_SHUTDOWN_DRAIN_MS` (default 30 seconds) to finish. The rest are stopped: each ends as cancelled with "Stopped because the worker is restarting", its conversation keeps the answer and steps so far (an interrupted tool call shows as stopped), a Telegram chat is told why it stopped, and its task, if it has one, is blocked with that reason and reported to whoever delegated it. Nothing resumes on its own after the restart: continue the conversation or the task when you want. Queued runs and runs waiting for approval are not touched; the new worker picks them up. Compose gives the worker 60 seconds to stop (`stop_grace_period`), so keep `WORKER_SHUTDOWN_DRAIN_MS` well below that.

**Roll back** to the version you had, with the dump taken before the update (migrations only move forward, so the database goes back with it):

```bash
docker compose stop web worker
docker compose exec -T backup pg_restore -h postgres -U abotica -d abotica --clean --if-exists /backups/pre-update-0.1.0-YYYYMMDD-HHMMSS.dump
curl -fsSL https://raw.githubusercontent.com/codevision-ro/abotica/main/install.sh | ABOTICA_VERSION=0.1.0 bash
```

On Windows the first two commands are the same in PowerShell, and the last one is `$env:ABOTICA_VERSION = "0.1.0"; irm https://raw.githubusercontent.com/codevision-ro/abotica/main/install.ps1 | iex`.

`VAULT_KEY` encrypts the keys and repository tokens saved from the UI. If you lose it or change it, the keys in the vault can no longer be read: keep a copy of `.env`.

## Docker by hand

In an empty folder:

```bash
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/codevision-ro/abotica/vX.Y.Z/docker-compose.prod.yml
```

and a `.env` next to it:

| Variable | Value |
|---|---|
| `ABOTICA_VERSION` | the release, e.g. `1.0.0` |
| `APP_URL`, `BETTER_AUTH_URL` | the public address, e.g. `https://abotica.example.com` |
| `BETTER_AUTH_SECRET`, `VAULT_KEY` | `openssl rand -base64 32` (each one separately) |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `SETUP_CODE` | `openssl rand -hex 24`; creating the account needs it (`/signup?code=...`) |
| `ABOTICA_DOMAIN`, `COMPOSE_PROFILES=https` | for the bundled Caddy (HTTPS); leave both out behind your own reverse proxy |
| `PREVIEW_URL` | `https://preview.abotica.example.com` (see [Previews](#previews)) |

Every other variable is optional; [Environment variables](#environment-variables) lists them all. Then `docker compose up -d`. To update, download the new release's compose file, change `ABOTICA_VERSION` and run `docker compose up -d` again.

`DATABASE_URL`, `REDIS_URL`, `UPLOADS_DIR` and `HOST_GATEWAY` are set by compose, not from `.env`. `HOST_GATEWAY` is how the containers reach the host: an address entered in the app as `http://localhost:11434` (Ollama on the host) is rewritten to it, so addresses are entered as the host sees them. The Ollama address, the embedding provider and the runs executed in parallel are set in the app (see [Settings from older `.env` files](#settings-from-older-env-files)). The web app, the worker and the migrations run as the unprivileged `node` user (uid 1000), not as root.

## Running it

The commands below run in the install folder, where `docker-compose.yml` and `.env` are.

### Telegram

Telegram is configured in the app, under **Settings > Telegram**; nothing goes in `.env` and nothing needs a restart.

1. Create a bot with @BotFather and paste its token under **Bot token**. It is checked with Telegram and stored encrypted in the vault.
2. Add your Telegram user ID under **Allowed users**. To find it, message @userinfobot, or send the bot a message: it replies with your ID while you are not on the list.
3. Optionally, set **Notification chat** to a group ID, for notifications in a forum group. Left empty, they go to the first allowed user.

The page shows whether the worker's bot is connected. An install that had these values in `.env` gets them copied into Settings once (see [Settings from older `.env` files](#settings-from-older-env-files)). The bot talks to `https://api.telegram.org`; `TELEGRAM_API_URL` points it at a local Bot API server or a proxy instead.

Commands: `/status`, `/tasks`, `/new` (new conversation), `/stop` (kill switch), `/resume` (turn the kill switch off). The bot accepts text, voice (transcribed through OpenAI), photos and files. Approvals arrive with Approve / Reject buttons. Only the super agent talks on Telegram, in every chat and in forum topics too: in a project's topic it knows which project the topic belongs to and hands the work to that project's manager. Managers answer only in the project's conversations on the web.

### HTTPS

The web app is published on `127.0.0.1:3000` (`WEB_PORT`) and the previews on `127.0.0.1:3100` (`PREVIEW_PORT`) only: ports Docker publishes bypass the host firewall (ufw included), so plain HTTP, login included, never reaches the network.

- **Bundled Caddy** (`COMPOSE_PROFILES=https`, which the install script sets when you give a domain): serves `ABOTICA_DOMAIN` and `*.preview.ABOTICA_DOMAIN` on ports 80 and 443.
- **Your own reverse proxy** on the host: leave the profile out and send the domain to `127.0.0.1:3000` and the previews to `127.0.0.1:3100`. `deploy/Caddyfile` is an example for a Caddy installed on the host. If you change `WEB_PORT` or `PREVIEW_PORT`, change the port in the proxy too (`deploy/Caddyfile` reads `PREVIEW_PORT` from Caddy's environment; the bundled Caddy follows both on its own).

### Backup and restore

The `backup` service writes into `./backups` once a day and keeps 14 days (`BACKUP_INTERVAL_SECONDS`, default `86400`, and `BACKUP_RETENTION_DAYS`, default `14`, in `.env` change both): `abotica-<date>.dump` (`pg_dump` of the database: memory, journals, tasks, conversations) and `uploads-<date>.tar.gz` (the uploads volume: your uploads, files agents share or hand to each other, knowledge files, one file per database row). The two belong together; copy `./backups` off the server as well.

Restore both from the same date, with the app stopped:

```bash
docker compose stop web worker
docker compose exec -T postgres \
  pg_restore -U abotica -d abotica --clean --if-exists < backups/abotica-YYYYMMDD-HHMM.dump
docker compose run --rm --no-deps -v "$PWD/backups:/backups:ro" \
  --entrypoint sh uploads-owner -c 'find /data/uploads -mindepth 1 -delete && tar -xzf /backups/uploads-YYYYMMDD-HHMM.tar.gz -C /data'
docker compose up -d
```

### Sandbox

Agents run commands, install packages and create files in a sandboxed workspace; stdio MCP servers run there too. With Docker, every workspace is its own container (one per project, one per chat without a project, one per stdio MCP server), built on the machine from the published `abotica-sandbox-base` image. Compose sets it all up:

- `sandbox-image` builds `abotica-sandbox:latest` (Debian 13) and exits: the published base plus Chrome for Testing, which it downloads from Google, so the published images never carry it. It has Python (pip, uv), Node 24 (npm; pnpm and yarn through corepack), PHP 8.4 with Composer and the extensions Laravel needs, gcc and make, MariaDB, PostgreSQL and Redis with their clients, git, curl, jq, yq, ripgrep, fd, tree, sqlite3, zip, poppler, ImageMagick, ffmpeg and pandoc, plus the bundled Playwright MCP and Scrapling with one Chromium (see below). More Debian packages for every workspace: `SANDBOX_APT_PACKAGES="tesseract-ocr libreoffice"` in `.env`, then `docker compose up -d`.
- `docker-proxy` gives the worker a filtered Docker API (containers, exec, images, networks, volumes). The Docker socket is root on the host, so the worker never gets it directly, and nothing else can reach the proxy.
- The `abotica-sandbox` network is internal: containers have no route out and cannot resolve names. Their traffic goes through a proxy inside the worker that applies the network policy of the workspace and refuses private, loopback and cloud metadata addresses. The same proxy adds the repository tokens to git's requests and the API keys of MCP servers' credential routes, so neither enters a container.

Commands run as an unprivileged user without capabilities, within the memory, CPU and process limits from **Settings > Sandbox**. A change to a limit applies to each container the next time it is opened while no command runs in it: the container is recreated, its volume (the workspace files) is kept. Agents with the **Run commands as root** tool can install system packages: their root commands get only the capabilities apt needs, and what they install outside the workspace lasts until the container is recreated (a new image or new limits). Database servers run per workspace when an agent starts them (`services start mysql`, `postgres` or `redis`), with their data in the workspace. A workspace container unused for 15 minutes is paused: what runs in it (database servers, the app behind a live preview) is frozen and carries on at the next command or preview visit. After 6 hours unused it is stopped, which ends those processes; database servers start again on the next command. A paused container keeps the memory its processes use (up to the limit in **Settings > Sandbox**), so on a small host lower that limit or pause sooner. Files stay in the `abotica-ws-<workspace>` volumes until the project, chat or MCP server is deleted or the workspace is reset from the project settings; workspaces of chats without a project are also removed after 30 days unused. The three times are the defaults: **Settings > Sandbox** changes them.

**gVisor** adds a second kernel boundary between the agents' code and the host; recommended on servers, since agents can run commands as root inside their containers. Install `runsc` and register it with Docker ([gvisor.dev/docs/user_guide/install](https://gvisor.dev/docs/user_guide/install/)); with the runtime on **Automatic**, Abotica uses it as soon as Docker reports it (**Settings > Sandbox > Check again**).

`docker compose down` cannot remove the `abotica-sandbox` network while workspace containers exist, because compose does not manage them. Remove them first:

```bash
docker rm -f $(docker ps -aq --filter label=abotica.sandbox=1)
```

The workspace volumes are kept; `docker volume ls --filter label=abotica.sandbox=1` lists them.

### Bundled MCP servers

Four MCP servers come with Abotica, enabled and offered to every agent (global); an agent can turn one off in its permissions, and under **MCP** you can disable one or offer it only to assigned agents. Agents do not get MCP tools up front: the prompt lists their names and the agent loads the ones it needs with `tool_search`.

- **Parallel Search** (web search) and **Context7** (library documentation): remote, used anonymously. An API key raises their limits: save it in the vault as `PARALLEL_API_KEY` or `CONTEXT7_API_KEY`.
- **Playwright** (browser automation) and **Scrapling** (scraping, including JavaScript and Cloudflare pages): stdio servers preinstalled in the sandbox image, run in the agent's workspace with access to any public host. Playwright saves screenshots in `/opt/abotica/mcp/out/playwright` inside the workspace container, read-only for agents. Both use one Chromium (the revision Scrapling's stealth mode needs), also on arm64 servers and Apple Silicon. Without Docker there is no sandbox, so these two are unavailable.

### Previews

Agents publish mockups and documents, and open apps they start, as preview links: `https://<code>.preview.abotica.example.com`, served by the worker on port 3100 (`PREVIEW_PORT`, bound to `127.0.0.1`). A live link (an app the agent started) stays open 24 hours and a static one (a copy of files) 7 days by default, renewed when it is extended or published again; **Settings > Previews** changes both. To enable them in production:

1. Set `PREVIEW_URL=https://preview.abotica.example.com` in `.env`.
2. Add a wildcard DNS record `*.preview.abotica.example.com` pointing to the server.
3. Route it to the worker in the reverse proxy. The bundled Caddy and `deploy/Caddyfile` do it with on-demand TLS: Caddy gets a certificate for a preview's subdomain on its first visit, after asking the worker whether that preview exists.

A separate domain for previews (for example `abotica-preview.com`) isolates them best; a subdomain of the app's domain works too, with the protections described in `SECURITY.md`. Locally nothing is needed: previews open at `http://<code>.preview.localhost:3100` (with another `PREVIEW_PORT`, set `PREVIEW_URL` to the same port). The development `docker-compose.yml` publishes that port, Postgres (54329) and Redis (63799) on `127.0.0.1` only, so other machines on the network cannot reach them.

### Optional services

Listed in `COMPOSE_PROFILES` in `.env`, comma separated (for example `COMPOSE_PROFILES=https,ollama`), then `docker compose up -d`.

**Ollama** (the embedding model run by an Ollama server instead of inside the worker, for example on a machine with a GPU). Pull the embedding model once:

```bash
docker compose exec ollama ollama pull embeddinggemma
```

Then, in **Settings > Models**, add Ollama and set its server address to `http://ollama:11434`, and choose Ollama under **Settings > Memory > Embeddings**. The embeddings stored so far are made again with Ollama in the background.

The model uses about 700 MB of RAM while loaded and unloads itself after 5 minutes of inactivity. It is the same model as the built-in one (EmbeddingGemma), which runs inside the worker and needs up to about 1 GB of RAM while it embeds.

## Environment variables

Read from `.env`. Only the ones marked required must be set; the compose files set the ones marked compose for their containers.

| Variable | Default | What it does |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | The public address of the app (required in production). |
| `BETTER_AUTH_URL` | | The same address, for sign-in (required in production). |
| `BETTER_AUTH_SECRET` | | Signs sessions (required): `openssl rand -base64 32`. |
| `VAULT_KEY` | | Encrypts the secrets saved in the app (required): `openssl rand -base64 32`. Keep a copy. |
| `SETUP_CODE` | | When set, creating the account needs it (`/signup?code=...`). |
| `ALLOW_SIGNUP` | `true` | `false` keeps sign-up closed, even before the first account exists. |
| `TRUSTED_ORIGINS` | | Other public origins (a tunnel, a second domain), comma separated. |
| `DATABASE_URL` | | Postgres (required; compose sets it). |
| `DATABASE_POOL_MAX` | `10` | Database connections per process (the web app and the worker each have a pool). |
| `REDIS_URL` | `redis://localhost:6379` | Redis (compose sets it). |
| `UPLOADS_DIR` | `apps/web/.data/uploads` | Stored files (compose sets it; required without Docker). |
| `MODELS_DIR` | `apps/worker/.data/models` | The built-in embedding model (EmbeddingGemma, about 330 MB), downloaded once (compose sets a volume). |
| `HOST_GATEWAY` | | The host as containers reach it (compose sets it). |
| `WORKER_SHUTDOWN_DRAIN_MS` | `30000` | Time runs in progress get to finish when the worker stops. |
| `SANDBOX_DOCKER_HOST` | | Docker API for the sandbox; unset means no sandbox (compose sets it). |
| `SANDBOX_DOCKER_NETWORK` | `abotica-sandbox` | Network of the sandbox containers (compose sets it). |
| `SANDBOX_IMAGE` | `abotica-sandbox:latest` | Image of the sandbox containers (compose sets it). |
| `PREVIEW_URL` | `http://preview.localhost:3100` | Base of preview links (see [Previews](#previews)). |
| `PREVIEW_PORT` | `3100` | Port the worker serves previews on; compose and the bundled Caddy follow it. |
| `CATALOG_URL` | `https://models.dev/api.json` | Model catalog (prices, context windows), refreshed every 12 hours. |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | Telegram Bot API, for a local Bot API server or a proxy. |
| `ABOTICA_VERSION` | `latest` | The release: the image tag in compose, and the version the update check compares. |
| `ABOTICA_RELEASES_REPO` | `codevision-ro/abotica` | GitHub repository whose releases the update check reads. |

Read only by `docker-compose.prod.yml`:

| Variable | Default | What it does |
|---|---|---|
| `ABOTICA_DOMAIN` | `localhost` | The domain the bundled Caddy serves, with `*.preview.<domain>`. |
| `COMPOSE_PROFILES` | | Optional services, comma separated: `https` (Caddy), `ollama`. |
| `POSTGRES_PASSWORD` | `abotica` | The database password. |
| `WEB_PORT` | `3000` | The web app's port on `127.0.0.1`. |
| `SANDBOX_APT_PACKAGES` | | More Debian packages for every workspace, space separated. |
| `BACKUP_INTERVAL_SECONDS` | `86400` | How often the `backup` service runs. |
| `BACKUP_RETENTION_DAYS` | `14` | Days the backups in `./backups` are kept. |

The installers also read `ABOTICA_DIR` (and `install.ps1` reads `ABOTICA_YES`, see [Install script](#install-script)), and the end-to-end checks `E2E_*` (`CONTRIBUTING.md`).

### Settings from older `.env` files

Some settings used to be environment variables and are now set in the app: the Telegram bot (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_NOTIFY_CHAT_ID`), `OLLAMA_BASE_URL`, `EMBEDDING_PROVIDER` and `RUN_CONCURRENCY`. The worker copies them into Settings once, at its first start after the update, without overwriting anything already set there; later changes to these lines have no effect, and they can be removed. OpenAI no longer embeds: an install that used it moves to the built-in model at the update, and its memory is embedded again in the background.

## Without Docker

### What the server needs

| Component | Version |
|---|---|
| Node.js | 22.13 or newer (24 recommended) |
| pnpm | 11, via `corepack enable` |
| PostgreSQL | 17, with the **pgvector** extension 0.5 or newer (HNSW indexes) |
| Redis | 7 or newer, with `maxmemory-policy noeviction` (required by BullMQ) |

The migrations run `CREATE EXTENSION IF NOT EXISTS vector`. If the user in `DATABASE_URL` is not allowed to create extensions, create it once as a superuser: `psql -d abotica -c 'CREATE EXTENSION vector'`.

### `.env`

Start from `.env.example` and set `APP_URL` and `BETTER_AUTH_URL` (the public address), `BETTER_AUTH_SECRET` and `VAULT_KEY` (`openssl rand -base64 32`, each one separately), plus:

```bash
DATABASE_URL=postgres://abotica:PASSWORD@localhost:5432/abotica
REDIS_URL=redis://localhost:6379
UPLOADS_DIR=/var/lib/abotica/uploads   # required: otherwise stored files end up in the build folder and are lost on the next build
```

### First install

```bash
git clone https://github.com/codevision-ro/abotica.git && cd abotica
git checkout vX.Y.Z               # the release to run
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate && pnpm db:seed
```

Then start `pnpm start:web` and `pnpm start:worker` however you prefer. Ready-to-copy examples in `deploy/`:

- `abotica-web.service`, `abotica-worker.service`: systemd services with automatic restart. Change `User` and `WorkingDirectory`.
- `Caddyfile`: automatic HTTPS in front of port 3000. Change the domain.

Do not run the processes as `root`, and give them a dedicated user.

### No sandbox without Docker

The sandbox needs Docker: the worker creates a container per workspace and must sit on the internal `abotica-sandbox` network, where its egress proxy is the only way out. A worker started with systemd is not on that network, so agents get no workspace tools and stdio MCP servers do not start (**Settings > Sandbox** says why). For the sandbox, use the Docker deployment above.

### Update

```bash
git fetch --tags && git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
sudo systemctl restart abotica-web abotica-worker
```

Runs in progress get `WORKER_SHUTDOWN_DRAIN_MS` (default 30 seconds) to finish, then they are stopped with their work so far saved, as with Docker. `deploy/abotica-worker.service` gives the worker 60 seconds to stop (`TimeoutStopSec`); keep the drain below it.

### Backup

Everything (memory, journals, tasks, conversations) is in Postgres; the files (your uploads, files agents share or hand to each other, knowledge files) are in `UPLOADS_DIR/files`, one file per database row, so back up both together. Example of a daily cron job for the database that keeps 14 days:

```cron
0 3 * * * pg_dump -Fc postgres://abotica:PASSWORD@localhost:5432/abotica > /var/backups/abotica/abotica-$(date +\%Y\%m\%d).dump && find /var/backups/abotica -name '*.dump' -mtime +14 -delete
```

### Ollama without Docker

Install it from ollama.com, run `ollama pull embeddinggemma`, then add Ollama in **Settings > Models** and choose it under **Settings > Memory > Embeddings**.

The bundled Playwright and Scrapling need the sandbox. To use Scrapling anyway, install it on the server (`pip install "scrapling[ai]"` and `scrapling install`, which downloads the browser into the worker user's home) and add your own server under **MCP > New**: transport `stdio`, command = the full path from `which scrapling`, argument `mcp`, with **Run in the sandbox** turned off. It then runs in the worker with the worker user's files (see `SECURITY.md`).
