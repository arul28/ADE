# Contributing to ADE

Contributions are wanted and encouraged. If a pull request is high quality and
useful, it gets merged. Only the maintainer (Arul) can merge or close PRs.

Bug reports and feature requests count too, especially on Windows, which is
still in beta and where the rough edges are easiest to find.

## Getting set up

```bash
npm run setup   # first time only
npm run dev     # rebuild the CLI, refresh the dev runtime, launch desktop
```

Everything else lives in
[docs/development/local-development.md](docs/development/local-development.md):
the full dev command matrix, running a lane worktree in isolation, previewing
the renderer without Electron, and packaging local Alpha and Beta builds.

## Before you submit

Run the smallest checks that cover what you changed:

- Desktop: `npm --prefix apps/desktop run typecheck`, the relevant Vitest files,
  and `npm --prefix apps/desktop run lint` for renderer or main process code
- ADE CLI: `npm --prefix apps/ade-cli run typecheck` and
  `npm --prefix apps/ade-cli run test`
- Docs: `node scripts/validate-docs.mjs`

TypeScript runs in strict mode and tests are Vitest. The best style guide is the
code already sitting around whatever you are changing, so keep changes focused
and match what is there.
