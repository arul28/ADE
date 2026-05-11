---
name: ade-perf-boot
description: Performance patterns discovered for ADE's cold launch and "main
  screen" surfaces — welcome / project picker, recent projects list, project
  open flow, remote runtime connect, iOS pairing. Read before editing files in
  apps/desktop/src/main/main.ts, the App shell (apps/desktop/src/renderer/components/app/**),
  project bootstrap services (apps/desktop/src/main/services/projects/**, lanes/**),
  remote runtime services, or anything in the app's pre-tab boot path.
  Append-only knowledge base populated by ade-autoresearch runs.
metadata:
  author: ade-autoresearch
  version: 0.1.0
  status: seed
---

# ade-perf-boot

Patterns discovered for ADE's cold launch and main-screen surfaces. Each entry has run-traced provenance — do not delete entries without explicit user approval.

## Scope

This tab covers the code paths that run before any per-tab UI is mounted, plus the project-level chrome that appears regardless of which tab is open:

- **Cold launch** — process spawn → main process bootstrap → renderer first paint → first interactive.
- **Welcome / project picker** — when no project is loaded.
- **Recent projects** — listing, rendering, icon resolution.
- **Project open flow** — `project.openRepo` IPC, the load + bind path.
- **Remote runtime** — `remoteRuntime.listTargets`, snapshot, connection lifecycle.
- **iOS / phone pairing** — pairing status, auth, etc.
- **App shell chrome** — sidebar, header, route transitions (the AppShell wrapping all tabs).

Use `ade-autoresearch boot` to run an optimization cycle against this surface.

## Scenarios this tab is benchmarked against

Defined in `apps/desktop/src/renderer/perf/scenarios/boot.ts`:

- `boot.cold-paint` — measures FCP / LCP / INP during cold launch (no driving).
- `boot.recent-projects` — `project.listRecent` IPC + welcome render.
- `boot.open-project` — `project.openRepo` round-trip for perf-pass.
- `boot.remote-runtime` — `remoteRuntime.listTargets` cost.
- `boot.idle-welcome` — 20s idle on welcome (no project) — catches background pollers.
- `boot.stress-launch` — 2min idle from cold — catches startup leaks.

The "no project" scenarios should be run with `--no-project` so the welcome screen renders:

```bash
node scripts/run-perf-scenario.mjs boot.idle-welcome run-id --no-project
```

## Patterns

_No patterns recorded yet — populated by the first `ade-autoresearch boot` run._

<!--
Template for new entries (the autoresearch skill appends these — don't edit by hand):

### Pattern: <one-line name>
- **Why it helped**: <bottleneck + metric delta>
- **How to recognize when to apply**: <signs in code that same pattern fits>
- **Anti-pattern**: <what NOT to do>
- **Verification**: <scenario + metric affected>
- **Provenance**: run `<runId>`, commit `<sha>`, fitness `<old> → <new>`
-->
