# Contributing

Thanks for helping. Bug reports, fixes, translations and focused features are welcome. For larger changes, open an issue first so we can agree on the approach before you write the code.

Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

Requirements: Node 22.13+ (24 recommended), pnpm 11 (`corepack enable`), Docker (on macOS: OrbStack or Docker Desktop).

```bash
cp .env.example .env
# set BETTER_AUTH_SECRET and VAULT_KEY: openssl rand -base64 32
pnpm install
pnpm infra:up        # in Docker: Postgres on 54329, Redis on 63799, the worker and its sandbox (ports on 127.0.0.1 only)
pnpm db:migrate
pnpm db:seed
pnpm dev             # web on http://localhost:3000
pnpm logs:worker     # the worker's output
```

The worker runs in Docker because the sandbox needs it on the sandbox network; its source is mounted and reloads on change. After changing any `package.json` (dependencies or a package's exports), run `pnpm infra:up` again to rebuild its image.

Agent runs need at least one connected provider (Settings > AI providers; keys are not read from `.env`). Telegram is optional: without a bot token (Settings > Telegram) the worker runs without the bot.

## Project layout

```
apps/web        Next.js 16 app: pages, server actions, chat API, webhooks
apps/worker     BullMQ workers (runs, schedules, maintenance, notifications), grammY bot
packages/core   Agent runner, provider fallback, tools, memory, tasks, approvals, vault, queues
packages/db     Drizzle schema (src/schema), migrations, seed
packages/i18n   Messages (messages/<locale>/<namespace>.json), translator, locale check
packages/sandbox  Sandboxed workspaces: Docker backend, egress proxy, sessions
deploy/         systemd and Caddy examples
```

Agents never run inside a web request: the web app enqueues a run, the worker executes it and streams through Redis. Keep it that way.

Where code goes:

- **Domain rules live in `packages/core`**, never only in a server action or a bot handler. If the web app and the worker (or an agent tool) both need a rule, it is a core function they both call. Core writes its own audit entries; callers do not repeat them.
- `packages/core/src` is split by domain, one folder each, with `index.ts` (the barrel) at the root:
  - `models/`: provider catalog, keys, fallback chain, subscriptions.
  - `agents/`: the runtime (runner, context, tools, MCP client) and agent configuration (`agent-config.ts`).
  - `runs/`: runs, run lifecycle, approvals, conversations.
  - `tasks/`: tasks, delegation, delegation reports, team rules.
  - `automations/`: schedules, triggers, trigger events, cron, webhooks and their signatures.
  - `projects/`: projects, repos, the GitHub and GitLab API, repo URLs.
  - `memory/`: memory, memory facts and scope, project knowledge.
  - `files/`: stored files, uploads, file types.
  - `sandbox/`: sandbox status and requests, the worker-only runtime, keys, policy, previews and the preview server.
  - `skills/`: skills, skill sources, `SKILL.md` parsing.
  - `mcp/`: MCP servers, bundled servers, stored values.
  - `platform/`: settings, kill switch, costs, budgets, limits, vault, audit and audit actions, app origins, safe fetch, slugs, return paths.
  - `telegram/`: the bot's configuration (token, allowed users, notification chat) and its status; the bot itself runs in the worker.
  - `infra/`: env, Redis, queues, live events, database errors.
- Other packages import core through `@abotica/core` (the barrel) or a subpath listed in `exports` in `packages/core/package.json`. A subpath keeps its public name (for example `@abotica/core/limits`) wherever the file lives; add an entry there before importing a new one. `sandbox-runtime`, `agents/mcp-runtime` and `agents/runner` are worker only and stay out of the barrel.
- Modules imported by client components must stay free of server-only imports; they are listed by path under `src/` in `packages/core/src/module-boundaries.test.ts`, which fails when one of them (or anything it imports) reaches server-only code. Add a module there before importing it from a client component.
- In `apps/web/src`: `server/queries` (reads, `get*` for one item or a view model, `list*` for arrays, each wrapped in `query()` so it checks the session; lint enforces it) and `server/actions` (writes, each wrapped in `action()`: `create*`, `update*`, `delete*`, `set*`, or a domain verb such as `startRun`). Pages, layouts and route handlers read through queries, not `@abotica/db` or core reads directly.
- `components/<feature>` for feature UI, `components/app` for pieces shared across features, `components/ui` and `components/ai-elements` are vendored (shadcn, AI Elements) with small i18n edits.
- Audit actions are `<entity>.<past-tense verb>` and listed in `packages/core/src/platform/audit-actions.ts`; a test checks that every action has a label in each locale.

## Conventions

- **TypeScript strict** (`strict` and `noUncheckedIndexedAccess` in `tsconfig.base.json`). `pnpm typecheck` must pass.
- **All user-facing text goes through i18n keys**, in the web UI, the Telegram bot, notifications and errors shown to the user. Add every new key to both `messages/en` and `messages/ro`. If you cannot write Romanian, add the English text to `ro` and say so in the PR; a maintainer will translate it.
- Errors meant for the user are thrown as `UserError` with a message key (see `packages/i18n/src/index.ts`).
- **No em dash or en dash characters** in copy or docs. Use a hyphen, a colon or rephrase. Use straight quotes.
- Follow the existing style of the file you edit. ESLint (one config, `eslint.config.mjs` at the root) runs in every package. Code is formatted with Prettier: run `pnpm format` before committing, CI runs `pnpm format:check`.
- Unit tests use Vitest and live next to the module as `*.test.ts`.
- Keep changes focused. Unrelated refactors belong in a separate PR.

## Checks before opening a PR

```bash
pnpm typecheck
pnpm format:check
pnpm lint
pnpm test
pnpm --filter @abotica/i18n check
pnpm build
```

CI runs the same commands on Node 22 and 24 and builds the Docker targets (`web`, `worker`, `worker-dev`, `migrate`, `docker-proxy`, `sandbox`). A tag `vX.Y.Z` runs `.github/workflows/release.yml`: it publishes `web`, `worker`, `migrate`, `docker-proxy` and `sandbox-base` to GHCR for amd64 and arm64, then creates the GitHub release that `install.sh` installs.

For changes to the agent loop, `pnpm --filter @abotica/core e2e` runs a live end-to-end check against your local database and a real provider: it creates a temporary agent, asks it to save a memory and create a task (which needs approval), approves it, waits for the continued run and deletes what it created. It needs the worker running and a provider key; pick the model with `E2E_PROVIDER` and `E2E_MODEL` (default `deepseek` / `deepseek-v4-flash`). The same goes for `e2e:sandbox` (commands, network policy, file handoff), `e2e:repos` (a project repository, its task worktree, git through its credential route; needs `E2E_GITHUB_TOKEN`, any token that reads public repositories), `e2e:stack` (MySQL, a Laravel app through Composer, root package installs, corepack), `e2e:previews` (static and live previews, private and public access, websockets, take-down and expiry), `e2e:mcp` (the bundled MCP servers, Playwright and Scrapling included) `e2e:team` (delegation through a project's manager) and `e2e:automation` (a specialist's schedule reporting up through the manager to the super agent, and a quiet one ending with nothingNew; with Telegram set up the super agent's answer goes to the notification chat, in a conversation the script removes afterwards); they need the worker with its sandbox (`pnpm infra:up`).

## Adding a language

1. Copy `packages/i18n/messages/en` to `packages/i18n/messages/<code>` and translate the values. Keep the keys and the `{placeholders}` unchanged.
2. In `packages/i18n/src/locales.ts`, add the code to `locales` and an entry to `localeNames` and `localeEnglishNames`; in `packages/i18n/src/index.ts`, add it to `messages`.
3. In `packages/i18n/src/messages.ts`, add the import block for the new files and export an object typed as `Messages`, like `ro`.
4. Run `pnpm --filter @abotica/i18n check` and `pnpm typecheck`.

## Database changes

1. Edit the schema in `packages/db/src/schema`.
2. Run `pnpm db:generate` to create a migration in `packages/db/migrations`.
3. Review the generated SQL, then apply it with `pnpm db:migrate`.
4. Commit the schema change and the migration (including `migrations/meta`) together.

Do not edit migrations that are already on `main`; add a new one instead.

## Commits and pull requests

- One logical change per PR, with a description of what changed and why, and how you tested it.
- Commit messages in the imperative mood, short subject line (e.g. "Add Telegram topic to project settings").
- Include screenshots for UI changes.
- Update the docs (README, DEPLOY.md) when behavior, configuration or commands change.
- All checks must pass before review.

By contributing you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).
