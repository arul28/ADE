# Proof

## Overview

Proof in ADE is **intentional**, not auto-captured. The agent does computer use however it wants — `claude`'s `computer_use`, the `codex` shell, a scripted browser, whatever. ADE does not wrap, proxy, or observe those tools. When the agent (or the user) decides that a moment deserves evidence, the agent runs the `ade proof` CLI. That single command is the entire interface.

The old system sat upstream of the agent and tried to normalize every backend. It carried a readiness model, a policy surface (`off`/`auto`/`enabled`), per-phase coverage requirements, an artifact broker, an auto-observer, and an MCP delivery path. All of that is gone. What stays is a tiny CLI, a single SQLite table, and a drawer in the UI.

The result: one interface for all models, no backend matrix, no coverage math. A proof set is a handful of captioned screenshots a reviewer can skim in under a minute.

---

## CLI reference

Three subcommands under `ade proof`. Each prints a JSON summary on success and exits non-zero on failure.

### `ade proof capture`

Take a screenshot now and file it as proof for the current session.

```
ade proof capture [--caption "<text>"] [--owner-kind chat|mission|lane] [--owner-id <id>]
```

- `--caption` — short free-text label. Prominent in the drawer grid.
- Owner flags — override inferred owner (see below). Rarely needed.

Example:

```
ade proof capture --caption "logged in as admin"
ade proof capture --caption "order #1234 submitted, confirmation visible"
```

Exit codes: `0` success, `2` capture failed (screencapture unavailable, unsupported OS), `3` owner could not be resolved.

### `ade proof attach`

Promote an existing image, video, or browser trace file to proof. Useful for headless-browser screenshots, Playwright traces rendered as PNG, or anything the agent produced out-of-band.

```
ade proof attach <path> [--caption "<text>"] [--title "<text>"] [--owner-kind ...] [--owner-id ...]
```

The CLI infers the proof kind from the file extension:

| Extension | Inferred kind |
|---|---|
| `.png`, `.jpg`/`.jpeg`, `.webp`, `.gif`, `.heic`/`.heif`, `.tif`/`.tiff` | `screenshot` |
| `.mov`, `.mp4`, `.m4v`, `.webm` | `video_recording` |
| `.zip`, `.har` | `browser_trace` |
| anything else | `browser_verification` |

Example:

```
ade proof attach /tmp/playwright-run/checkout-success.png --caption "checkout flow completes on Firefox"
```

The file is copied into `.ade/artifacts/computer-use/`; the original is left in place. Internally `attach` calls the same `ingest_computer_use_artifacts` RPC tool with `backendStyle: "manual"` and `backendName: "ade-cli"`.

### `ade proof list`

Print the proof set for the current session as JSON.

```
ade proof list [--owner-kind chat|mission|lane] [--owner-id <id>] [--limit <n>]
```

No args: lists the inferred session. Primarily for agents to see what they have already captured.

---

## Owner inference

The CLI resolves the owner of a capture from environment variables set by the desktop app when it spawns an agent subprocess:

| Env var | Owner kind | Precedence |
|---|---|---|
| `ADE_CHAT_SESSION_ID` | `chat` | highest |
| `ADE_MISSION_ID` | `mission` | middle |
| `ADE_LANE_ID` | `lane` | lowest |

Agents spawned inside ADE pick up the right owner automatically. If more than one var is set — e.g. a mission worker also has a lane — the highest-precedence kind wins.

If no env var is set and no `--owner-kind`/`--owner-id` flags are passed, `ade proof capture` exits with code `3`. This is deliberate: an un-owned proof has no home in the UI.

### Explicit owner on RPC tools

The `screenshot_environment`, `record_environment`, `ingest_computer_use_artifacts`, `get_environment_info`, `interact_gui`, and `list_computer_use_artifacts` JSON-RPC tools accept explicit `ownerKind` + `ownerId` fields. `resolveComputerUseOwners` in `apps/ade-cli/src/adeRpcServer.ts` is the single normalizer:

- Canonical kinds: `lane`, `mission`, `orchestrator_run`, `orchestrator_step`, `orchestrator_attempt`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`.
- Friendly aliases: `chat` → `chat_session`, `pr` → `github_pr`. Any other value raises a `JsonRpcError(invalidParams)` with an "Unsupported proof ownerKind" message.

Explicit owners are added in addition to the session identity inferred from `ADE_*` env vars, so an agent can attach the same artifact to its current chat plus a specific PR in one call.

---

## Storage

Images live on disk under the project's `.ade/` scaffold:

```
.ade/artifacts/computer-use/<uuid>.<ext>
```

(Path will move to `.ade/artifacts/proof/` in a future phase.)

Metadata is a single SQLite row per capture in `computer_use_artifacts`, with ownership links in `computer_use_artifact_links`. The columns relevant to the new system are a small subset of what the table carries today: `id`, `kind` (always `screenshot` for captures; `image` for attaches), `uri`, `mime_type`, `caption`, `created_at`, plus the owner link row.

There is no retention policy — captures persist until the project is cleaned up. Disk is the budget; nothing ages out automatically.

---

## Drawer UI

Proof surfaces in two places:

- **Chat** — the proof drawer below the composer shows a thumbnail grid for the current session. Captions are rendered in full below each thumbnail, not as hover tooltips. Click to preview at full size.
- **Mission detail** — the Proof tab shows the same grid for the mission, scoped by `ADE_MISSION_ID`.

Review controls (accept / reject / annotate) remain as first-class actions on each proof.

---

## For agents

When an agent session starts inside ADE, the system prompt includes a short priming directive:

> When you reach a checkpoint worth showing — a login succeeds, a form submits, an error reproduces, a test passes — run `ade proof capture --caption "<short description>"`. Captions are what reviewers skim; write them like a teammate is reading them.

A good proof set is three to eight captures with captions a reviewer can read in one pass. Avoid dumping a screenshot after every click. Avoid captions like "screenshot 3"; prefer the exact state being proven.

---

## Not supported

- **Video.** Removed in this rebuild. If the agent produces a video out-of-band, it cannot be attached as proof; attach a representative frame instead.
- **Cinematic post-processing.** No before/after stitching, no annotated overlays — deferred.
- **Cross-device sync.** Proof records replicate via cr-sqlite, but the image files do not — proof is viewable only on the device that produced it.
- **Auto-capture.** The old proof observer is gone. Nothing watches the agent and files screenshots for it.

Headless-browser screenshots *are* supported — use `ade proof attach` with the output file path.

`proof capture`, `proof record`, `proof environment`, `proof launch`, and `proof interact` set `preferHeadless: true` on the CLI plan: the connection layer drops to headless mode unless `--socket` is explicitly passed. This lets agent subprocesses capture proof without depending on the desktop socket being live; visual proof state still flows back to the broker on the next reconcile.

---

## Architecture

```
  agent (any model)
      │
      │  shell invocation
      ▼
  ade proof capture --caption "…"
      │
      │  JSON-RPC over .ade/ade.sock
      ▼
  proof action (main-process)
      │
      ├── screencapture  ─► .ade/artifacts/computer-use/<uuid>.png
      │
      └── computerUseArtifactBrokerService
              │
              │  SQLite insert
              ▼
          computer_use_artifacts + …_artifact_links
                                     │
                                     ▼
                          drawer UI (chat / mission)
```

The broker (`apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts`) is the only ingest path — both the `ade proof` CLI and any in-process call go through it. Supporting modules in the same directory:

- `controlPlane.ts` builds owner snapshots + backend status for the UI.
- `localComputerUse.ts` reports macOS-only proof-capture capabilities (`screencapture`, app launch, GUI interaction).
- `agentBrowserArtifactAdapter.ts` parses agent-browser output into `ComputerUseArtifactInput[]`.
- `syntheticToolResult.ts` produces tool-result stubs for the Claude compaction path.

Every piece upstream of the CLI is the agent's own business. Every piece downstream is a thin line to disk, a broker insert, and the drawer. No backend abstraction, no policy engine, no observer — the proof observer was deleted with this rebuild, along with `ComputerUsePolicy` and the Settings > Computer Use panel.
