# Feature Path → Doc + Perf-Skill Mapping

Resolve changed file paths (or keyword arguments) to the canonical internal docs
under `docs/` and, where one exists, the performance skill that records measured
patterns for that surface. Load the doc set **and** open the perf skill before
editing that surface.

Internal docs live under `docs/` (rebuilt tree). The public Mintlify site
(`docs.json` + root-level `*.mdx`) is **out of scope** for context loading.

---

## Desktop — main-process services

| Path pattern | Feature docs | Perf skill |
|---|---|---|
| `apps/desktop/src/main/services/projects/` | `docs/features/project-home/` | `ade-perf-boot` |
| `apps/desktop/src/main/services/lanes/` | `docs/features/lanes/` | `ade-perf-lanes` |
| `apps/desktop/src/main/services/prs/`, `services/review/` | `docs/features/pull-requests/` | `ade-perf-prs` |
| `apps/desktop/src/main/services/proof/` | `docs/features/proof.md` | — |
| `apps/desktop/src/main/services/remoteRuntime/`, `services/localRuntime/`, `services/runtime/` | `docs/features/remote-runtime/` | `ade-perf-boot` |
| `apps/desktop/src/main/services/cto/` | `docs/features/cto/` + `linear-integration/` | — |
| `apps/desktop/src/main/services/ai/` | `docs/features/chat/` + `features/agents/` | `ade-perf-work` |
| `apps/desktop/src/main/services/chat/` | `docs/features/chat/` | `ade-perf-work` |
| `apps/desktop/src/main/services/automations/` | `docs/features/automations/` | — |
| `apps/desktop/src/main/services/computerUse/` | `docs/features/computer-use/` | — |
| `apps/desktop/src/main/services/deeplinks/` | `docs/features/deeplinks/` | — |
| `apps/desktop/src/main/services/orchestration/` | `docs/features/agents/` (orchestrator) | — |
| `apps/desktop/src/main/services/conflicts/` | `docs/features/conflicts/` | — |
| `apps/desktop/src/main/services/files/` | `docs/features/files-and-editor/` | `ade-perf-work` |
| `apps/desktop/src/main/services/history/` | `docs/features/history/` | — |
| `apps/desktop/src/main/services/onboarding/`, `services/config/` | `docs/features/onboarding-and-settings/` | `ade-perf-boot` |
| `apps/desktop/src/main/services/pty/`, `sessions/`, `processes/` | `docs/features/terminals-and-sessions/` | `ade-perf-work` |
| `apps/desktop/src/main/services/sync/` | `docs/features/sync-and-multi-device/` | — |
| `apps/desktop/src/main/services/git/` | `docs/ARCHITECTURE.md` (Git engine) + `lanes/` | `ade-perf-lanes` |
| `apps/desktop/src/main/services/ipc/`, `src/preload/` | `docs/ARCHITECTURE.md` (IPC contract) | — |
| `apps/desktop/src/main/main.ts`, app bootstrap | `docs/ARCHITECTURE.md` (Apps & Processes) | `ade-perf-boot` |

## Desktop — renderer

| Path pattern | Feature docs | Perf skill |
|---|---|---|
| `apps/desktop/src/renderer/components/lanes/**` | `docs/features/lanes/` | `ade-perf-lanes` |
| `apps/desktop/src/renderer/components/prs/**` | `docs/features/pull-requests/` | `ade-perf-prs` |
| `apps/desktop/src/renderer/components/chat/**`, Work tab panes (Tools, Git, Files, iOS, App Control, Browser) | `docs/features/chat/` + relevant feature | `ade-perf-work` |
| `apps/desktop/src/renderer/components/app/**` (App shell) | `docs/ARCHITECTURE.md` (UI framework) | `ade-perf-boot` |
| `apps/desktop/src/renderer/components/graph/**` | `docs/features/workspace-graph/` | — |
| `apps/desktop/src/renderer/components/<area>/**` | `docs/features/<same-area>/` (note: renderer dir names don't always equal feature dir names — e.g. `graph/`→`workspace-graph/`) | match by area above |
| `apps/desktop/src/renderer/state/` (incl. `appStore.ts`) | `docs/ARCHITECTURE.md` (UI framework) | `ade-perf-lanes` |
| `apps/desktop/src/shared/**` | `docs/ARCHITECTURE.md` + the touching feature's doc | — |

## ADE CLI & TUI

| Path pattern | Feature docs | Perf skill |
|---|---|---|
| `apps/ade-cli/src/tuiClient/**` | `docs/features/ade-code/README.md` + `ARCHITECTURE.md` (ADE CLI) | `ade-tui-web-preview` |
| `apps/ade-cli/**` (non-TUI) | `docs/ARCHITECTURE.md` (ADE CLI / Build/Test/Deploy) + `features/agents/` | — |

## iOS, web, CI

| Path pattern | Feature docs | Perf skill |
|---|---|---|
| `apps/ios/**` | `docs/features/sync-and-multi-device/ios-companion.md` + `features/ios-simulator/` | — |
| `apps/web/**` | `docs/ARCHITECTURE.md` (Apps & Processes) | — |
| `.github/workflows/**` | `docs/ARCHITECTURE.md` (Build/Test/Deploy) | — |

---

**Cross-cutting:** any change to `preload/`, `shared/ipc.ts`, or `registerIpc`
also loads `docs/ARCHITECTURE.md` (IPC + data plane sections). Keep IPC
contracts, preload types, shared types, and renderer usage in sync — see the
`runtime-backed null services` rule in the `/quality` skill's
`references/ade-review-rules.md` for the bug class this guards against.
