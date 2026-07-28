# Proof

## Overview

Proof in ADE is **intentional**, not auto-captured. The agent does computer use however it wants — `claude`'s `computer_use`, the `codex` shell, a scripted browser, whatever. ADE does not wrap, proxy, or observe external tools. When the agent (or the user) decides that a moment deserves evidence, the agent runs the `ade proof` CLI or promotes an ADE Browser scratch observation with `ade browser proof`. Those commands are the intentional proof interface.

The old system sat upstream of the agent and tried to normalize every backend. It carried a readiness model, a policy surface (`off`/`auto`/`enabled`), per-phase coverage requirements, an auto-observer, and a separate tool-delivery path. Those control-plane layers are gone. What stays is a small CLI, the canonical artifact-and-owner-link tables, and lightweight collection views in chat.

The result: one interface for all models, no backend matrix, no coverage math. A proof set is a handful of captioned screenshots a reviewer can skim in under a minute.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` | Canonical ingest, list, delete, broken-record audit/prune/recovery, lane/project cleanup, review compatibility fields, and bounded preview reads. |
| `apps/desktop/src/main/services/computerUse/controlPlane.ts` | Owner-scoped snapshots used by the proof drawer. |
| `apps/desktop/src/main/services/computerUse/localComputerUse.ts` | Local capture capabilities plus artifact path/URI helpers. |
| `apps/desktop/src/main/services/state/kvDb.ts` | `computer_use_artifacts` / `computer_use_artifact_links` schema, including the optional lane ownership column used by lane cleanup. |
| `apps/desktop/src/shared/types/computerUseArtifacts.ts` | Cross-process artifact, availability, deletion, recovery, event, and owner contracts. |
| `apps/desktop/src/main/services/adeActions/registry.ts`, `apps/desktop/src/main/services/ipc/registerIpc.ts`, `apps/desktop/src/preload/preload.ts` | Runtime action, IPC, and renderer bridge for the proof surface. |
| `apps/ade-cli/src/cli.ts`, `apps/ade-cli/src/adeRpcServer.ts` | Typed `ade proof …` commands and JSON-RPC tools. |
| `apps/desktop/src/renderer/components/chat/ChatComputerUsePanel.tsx` | Full proof drawer, artifact tiles, preview states, and delete action. |
| `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`, `chatCardPrimitives.tsx` | Turn-time bucketing plus the collapsible inline proof filmstrip. |

## Runtime ownership

Proof storage and the broker are owned by the ADE runtime (`ade serve`) that owns the project. Artifacts on disk live under the runtime machine's `.ade/artifacts/computer-use/` directory; the SQLite rows live in that runtime's `.ade/ade.db`. For local projects that is the user's machine; for remote projects it is the remote machine. The desktop renderer and the headless ADE CLI both call into the broker over JSON-RPC; nothing about the proof pipeline lives in the renderer or in a separate host process.

That means: proof captured during a remote-runtime session lives on the remote host. Desktop transcript and drawer cards fetch bounded preview bytes through the same SSH-tunneled JSON-RPC channel as the rest of the remote project surface; raw artifact files are not synced back to the desktop machine, and proof is only viewable while the runtime that captured it is reachable.

---

## CLI reference

Common subcommands under `ade proof` print a JSON summary on success and exit non-zero on failure. Use `ade help proof` for the complete current flag list.

### `ade proof capture`

Take a screenshot now and file it as proof for the current session.

```
ade proof capture [--caption "<text>"] [--owner-kind chat|lane] [--owner-id <id>]
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
| any other allow-listed extension | `browser_verification` |

Example:

```
ade proof attach /tmp/playwright-run/checkout-success.png --caption "checkout flow completes on Firefox"
```

The file is copied into `.ade/artifacts/computer-use/`; the original is left in place. Internally `attach` calls the same `ingest_computer_use_artifacts` RPC tool with `backendStyle: "manual"` and `backendName: "ade-cli"`.

On-disk imports are intentionally allow-listed to renderable evidence types
(images, video, browser traces, and text/log files). Files such as `.env`,
databases, private keys, and certificates are rejected even when they are under
the project root. The broker resolves symlinks for both its allow- and deny-root
checks and opens the source with `O_NOFOLLOW` before copying.

### `ade proof list`

Print the proof set for the current session as JSON.

```
ade proof list [--owner-kind chat|lane] [--owner-id <id>] [--limit <n>]
```

No args: lists the inferred session. Primarily for agents to see what they have already captured.

### Other proof commands

- `ade proof status --text` shows capture/back-end capabilities.
- `ade proof record --seconds <n>` records a short video proof where supported.
- `ade proof launch`, `ade proof interact`, and `ade proof environment` are lower-level computer-use helpers for capture workflows.
- `ade proof ingest --input-json ...` ingests externally produced artifacts directly through the proof broker.
- `ade proof rm <artifact-id> [<artifact-id>…]` irreversibly deletes the selected
  records and any stored files inside the artifact jail. Missing ids are
  reported but do not make deletion non-idempotent.
- `ade proof broken` lists records whose file is missing or whose historic URI
  never pointed into the artifact store.
- `ade proof prune` is the non-destructive broken-record listing; add
  `--broken` to delete every broken record.
- `ade proof recover <artifact-id>` re-imports a broken record when its original
  file still exists in an allowed project, lane-worktree, cache, temp, or
  browser-output root.

---

## Owner inference

The CLI resolves the owner of a capture from environment variables set by the desktop app when it spawns an agent subprocess:

| Env var | Owner kind | Precedence |
|---|---|---|
| `ADE_CHAT_SESSION_ID` | `chat` | highest |
| `ADE_LANE_ID` | `lane` | lowest |

Agents spawned inside ADE pick up the right owner automatically. If more than one var is set — e.g. a chat also has a lane — the highest-precedence kind wins.

If no env var is set and no `--owner-kind`/`--owner-id` flags are passed, `ade proof capture` exits with code `3`. This is deliberate: an un-owned proof has no home in the UI.

### Explicit owner on RPC tools

The `screenshot_environment`, `record_environment`, `ingest_computer_use_artifacts`, `get_environment_info`, `interact_gui`, and `list_computer_use_artifacts` JSON-RPC tools accept explicit `ownerKind` + `ownerId` fields. `resolveComputerUseOwners` in `apps/ade-cli/src/adeRpcServer.ts` is the single normalizer:

- Canonical kinds: `lane`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`.
- Friendly aliases: `chat` → `chat_session`, `pr` → `github_pr`. Any other value raises a `JsonRpcError(invalidParams)` with an "Unsupported proof ownerKind" message.

Explicit owners are added in addition to the session identity inferred from `ADE_*` env vars, so an agent can attach the same artifact to its current chat plus a specific PR in one call.

---

## Storage

Images live on disk under the project's `.ade/` scaffold on the runtime host:

```
<runtime host>/<project root>/.ade/artifacts/computer-use/<uuid>.<ext>
```

(Path will move to `.ade/artifacts/proof/` in a future phase.)

Metadata is a single SQLite row per capture in `computer_use_artifacts`, with ownership links in `computer_use_artifact_links`. The columns relevant to the proof surface include `id`, `kind`, `uri`, `mime_type`, `title`/`description`, `lane_id`, and `created_at`, plus the owner link rows. `lane_id` is resolved from an explicit lane owner or from the owning chat session; it is optional on the wire for compatibility with older runtimes.

There is no age-based retention policy. Captures persist until the user deletes
them, deletes their lane, clears project-local artifacts, or removes the proof
storage category in Settings. All of those paths delete matching database rows
with the bytes so the drawer never retains knowingly dead tiles. Archiving a
lane is non-destructive. For remote-runtime projects, the disk being filled is
the remote host's, not the desktop machine's.

Ingest resolves every item in a batch before inserting any row. A missing file,
denied source, disallowed extension, or path outside the allowed roots fails the
whole batch instead of leaving a half-committed retry. Relative paths resolve
from the caller's lane worktree (`callerRoot`) before the project root.

Each view includes an optional availability classification:

- `available` — URL-backed or stored bytes are readable.
- `missing_file` — a canonical artifact URI exists but the file is gone.
- `unimported` — a historic record points outside the artifact store.

Older hosts may omit the field; clients optimistically attempt the preview.

ADE browser-agent observations are intentionally not proof. `ade browser observe` and post-action browser observations write scratch PNG/JSON files under `.ade/cache/browser-observations/` for project collections and the current ADE channel's machine-local `browser-observations/personal/` root for personal collections. They include a bounded DOM element list plus console/network diagnostics by default for agent targeting, can add a numbered visual UI map with `--map`, and prune to the latest 3 observations per tab by default. DOM elements carry short-lived handles such as `obs-...:e:3` so agents can click/fill/press/wait without another hit-test, including same-origin iframe/open-shadow-root targets when the observation captured that context. `ade browser session start --tab <id>` only creates a reusable tab-targeting handle for repeated agent actions; session observations and traces are still scratch state until promoted. `ade browser trace --tab <id>` or `ade browser trace --browser-session <id>` exposes the bounded per-tab action log for debugging but remains scratch state. Promote only reviewer-facing checkpoints into proof through `ade browser proof --tab <id> --caption "..."`, `ade browser proof --browser-session <id> --caption "..."`, the shorthand `ade browser session proof <session-id> --caption "..."`, or the lower-level `ade proof attach` / `ingest` commands. The proof broker explicitly allows the project cache and personal browser scratch roots so browser scratch PNGs can be promoted without accepting arbitrary user-data files.

---

## Chat UI

Proof surfaces across chat and linked workflow contexts:

- **Chat transcript** — proof is bucketed by capture time into the turn that
  produced it. The turn rule shows a compact `N proof` control; expanding it
  reveals a horizontally scrollable filmstrip directly below that turn. It
  starts collapsed, remains in chronology when newer messages arrive, and is
  never pinned to the thread tail.
- **Proof drawer** — the current chat's complete collected set, with the same
  previews and captions plus irreversible artifact deletion. It is a
  collection view, not an approval workflow: there are no
  accept/reject/publish controls and local files are never handed to Finder
  just to see them.
- **iOS chat** — proof stays in the message timeline and the existing artifact
  sheet, with preview/share actions but no review-state chrome.
- **Lane and PR review** — linked proof can be surfaced alongside lane work and PR closeout.

Both clients resolve media through the owning runtime instead of opening the
runtime host's filesystem path. Desktop uses ADE's range-capable artifact
protocol for local media and `ade.proof.readArtifactPreview` for remote media;
the RPC response is capped at 10 MiB. The inline filmstrip can resolve local
project-relative artifacts synchronously; remote filmstrip tiles fall back to a
kind label and open the drawer, which performs the bounded runtime read. iOS requests artifact content over its
sync command surface and caches renderable images locally. When a runtime is
unreachable or a desktop remote preview exceeds its bound, the artifact remains
listed with an unavailable-preview state.

---

## For agents

When an agent session starts inside ADE, the system prompt includes a short priming directive:

> When you reach a checkpoint worth showing — a login succeeds, a form submits, an error reproduces, a test passes — run `ade proof capture --caption "<short description>"`. Captions are what reviewers skim; write them like a teammate is reading them.

A good proof set is three to eight captures with captions a reviewer can read in one pass. Avoid dumping a screenshot after every click. Avoid captions like "screenshot 3"; prefer the exact state being proven.

---

## Not supported

- **Cinematic post-processing.** No before/after stitching, no annotated overlays — deferred.
- **Offline artifact replication.** Proof records replicate via cr-sqlite, but
  image/video bytes do not. A connected desktop or phone streams a preview from
  the runtime that owns the project; the media is unavailable when that runtime
  cannot be reached.
- **Auto-capture.** The old proof observer is gone. Nothing watches the agent and files screenshots for it.

Headless-browser screenshots *are* supported — use `ade proof attach` with the output file path.

`proof capture`, `proof record`, `proof environment`, `proof launch`, and `proof interact` set `preferHeadless: true` on the CLI plan: the connection layer drops to headless mode unless `--socket` is explicitly passed. This lets agent subprocesses capture proof without depending on the machine runtime endpoint being live; visual proof state still flows back to the broker on the next reconcile.

---

## Architecture

```
  agent (any model, any runtime host)
      │
      │  shell invocation
      ▼
  ade proof capture --caption "…"
      │
      │  JSON-RPC over ~/.ade/sock/ade.sock when socket-backed
      ▼
  proof action (runtime: ade serve)
      │
      ├── screencapture  ─► <runtime host>/.ade/artifacts/computer-use/<uuid>.png
      │
      └── computerUseArtifactBrokerService
              │
              │  SQLite insert into <runtime host>/.ade/ade.db
              ▼
          computer_use_artifacts + …_artifact_links
                                     │
                                     ▼
                          drawer UI (renderer reads via
                          window.ade.proof.* → preload →
                          local or remote runtime RPC)
```

The broker (`apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts`) is the only ingest path — both the `ade proof` CLI and any in-process call go through it. The same module is loaded by the desktop main process for local projects and by the standalone `ade serve` runtime for headless / remote use. Supporting modules in the same directory:

- `controlPlane.ts` builds owner snapshots + backend status for the UI.
- `localComputerUse.ts` reports macOS-only proof-capture capabilities (`screencapture`, app launch, GUI interaction). Reflects the runtime host's environment, not the desktop machine's.

Provider execution can be provisioned by ADE (for example the signed direct Codex Computer Use MCP client), but proof remains explicit. Every piece downstream of `ade proof` is a thin line to disk, a broker insert, and the drawer. No passive observer promotes provider tool calls automatically — the proof observer was deleted with this rebuild, along with `ComputerUsePolicy` and the Settings > Computer Use panel.
