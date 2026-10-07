## What and why

<!-- What does this change do, and why is it needed? Link the issue if there is one (Closes #123). -->

## How it was tested

<!-- Steps you followed, and screenshots for UI changes. -->

## Checklist

- [ ] `pnpm typecheck`
- [ ] `pnpm format:check`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm --filter @abotica/i18n check`
- [ ] `pnpm build`
- [ ] New user-facing text uses i18n keys, added to both `en` and `ro`
- [ ] Schema changes come with a migration (`pnpm db:generate`)
- [ ] Docs updated if behavior, configuration or commands changed
