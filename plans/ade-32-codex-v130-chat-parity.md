# ADE-32 — Codex app-server v0.130 chat parity (Tier A)

Status: proposed
Date: 2026-05-11
Linear: https://linear.app/ade-linear/issue/ADE-32
GitHub issue: https://github.com/arul28/ADE/issues/278

## Goal

Bump ADE's bundled Codex `app-server` to `rust-v0.130.0` and bring the work-tab chat (Electron) and the ADE TUI to user-visible parity with Codex's own desktop app and Codex CLI for **chat UX surfaces** — plans, goals, compaction, image input/output, web search rendering, image view, persistent history with search/fork/rollback, long-thread pagination, and a token-usage HUD.

Out of scope for this pass (deferred to a follow-up if/when needed):
- Hook system, plugin/marketplace browser, apps/connectors UI, MCP-in-app UI (the **runtime** for these is enabled by removing two `--disable` flags below; users configure them via the `codex` CLI / `~/.codex/`).
- Realtime voice, fs/process/command-exec RPCs, environments, dynamic client tools, multi-agent collaboration UI, memory mode, attestation, ChatGPT token refresh.

## Why now

The bundled binary currently floats to whatever `codex` is on the user's PATH. The v2 wire is stable and we already speak it, but the chat UI is shaped around the v1 mental model in several places (no plan card, no compaction event, no rich web search rendering, etc.). Codex CLI users on v0.13x see features we don't render, which is a visible quality gap when those same users sit down in ADE's work tab.

## Sources

Primary protocol sources (canonical — read these before coding each phase):

- Method + notification macro registry: https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/common.rs
- v2 module index: https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v2/mod.rs
- Item enum (every `ThreadItem` variant): https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs
- Thread RPCs: `…/v2/thread.rs`, `…/v2/thread_data.rs`
- Turn RPCs: `…/v2/turn.rs`
- Compaction + tokens: `…/v2/notification.rs`
- App-server README (human-readable protocol guide): https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md
- v1 → v2 migration doc: https://raw.githubusercontent.com/openai/codex/main/codex-rs/docs/protocol_v1.md
- Slash commands inventory: https://developers.openai.com/codex/cli/slash-commands

Reference (do not implement now, but cite when scope grows):

- Realtime: `…/v2/realtime.rs`
- fs RPCs: `…/v2/fs.rs`
- command/exec: `…/v2/command_exec.rs`

## ADE current state (audit)

ADE talks Codex v2 over stdio. Authoritative client lives at `apps/desktop/src/main/services/chat/agentChatService.ts` (18,847 lines). The TUI does **not** speak Codex protocol — it consumes the normalized `AgentChatEvent` envelope defined at `apps/desktop/src/shared/types/chat.ts:150-446` via the ADE RPC server. Any new Codex item therefore threads through three layers:

1. `agentChatService.ts` — handle the new Codex notification / send the new request.
2. `apps/desktop/src/shared/types/chat.ts` — add the new `AgentChatEvent` variant (47 today).
3. Both renderers — desktop component in `apps/desktop/src/renderer/components/chat/` AND TUI formatter in `apps/ade-cli/src/tuiClient/components/ChatView.tsx`.

Methods we already implement (verified at `agentChatService.ts:7793, 11259, 11349, 11381, 12142, 16319, 16699, 17796, 18486` etc.):

`initialize`, `thread/start`, `thread/resume`, `thread/archive`, `thread/name/set`, `turn/start`, `turn/steer`, `turn/interrupt`, `skills/list`, `collaborationMode/list`, `account/rateLimits/read`, `model/list`, `review/start`, `fuzzyFileSearch`.

Notifications handled (at `agentChatService.ts:10441-11021`):

`turn/started`, `turn/completed`, `turn/aborted`, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`, `item/reasoning/summaryPartAdded`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/plan/delta`, `turn/plan/updated`, `item/started`, `item/completed`, `codex/event/web_search_begin`, `thread/status/changed`, `error`, `account/rateLimits/updated`, `account/updated`, `account/login/completed`, `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, `thread/name/updated`, `thread/updated`.

Server→client requests answered: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`.

Gates in place that this plan touches:

- `agentChatService.ts:11059` — currently passes `--disable plugins --disable apps --disable browser_use --disable computer_use`. **Plan: drop `plugins` and `apps` from this list** so users with plugins/apps configured via the Codex CLI get them in ADE. Keep `browser_use` and `computer_use` disabled (ADE owns these via its own ai-tools layer).
- `agentChatService.ts:7800-7802` — triple-named reasoning effort fallback (`effort` / `reasoningEffort` / `reasoning_effort`). v0.130 standardizes on `effort`. Clean up.
- `experimentalRawEvents: false` (line 11059) stays off; Tier C content only.

## Implementation plan — phased, surface-by-surface

The user picked **parity in one pass** for desktop + TUI. Every numbered phase below ships both renderers together.

### Phase 0 — Bundle the binary and stabilize the handshake

1. **Pin and bundle `codex` v0.130.0** in the desktop installer and `apps/ade-cli` npm package. Files to change:
   - Release workflows: `.github/workflows/*release*.yml` — add a download step that fetches the `codex` binary for each target platform (macOS x64+arm64, Windows x64, Linux x64+arm64) from `https://github.com/openai/codex/releases/download/rust-v0.130.0/...`, verifies sha256, and stages it inside the app bundle.
   - Desktop packaging: extend `apps/desktop/build/` config to ship the binary under `resources/codex/` and resolve from there first.
   - CLI packaging: ship in `apps/ade-cli/bin/codex/` and resolve via `resolveCodexExecutable` at `apps/desktop/src/main/services/ai/codexExecutable.ts:18-42` — extend this resolver to check bundled paths before falling through to env / PATH.
   - Keep `CODEX_EXECUTABLE` / `CODEX_EXECUTABLE_PATH` env overrides for dev.
2. **Initialize handshake cleanup**:
   - Set `clientInfo.name = "ade_desktop"` (or `"ade_tui"` from the CLI), `clientInfo.version = ade package version`.
   - Set `capabilities.experimentalApi = true`.
   - Set `capabilities.optOutNotificationMethods = []` initially; later phases populate it for perf.
   - Stub server→client requests we don't answer yet: `attestation/generate` → return capability error; `account/chatgptAuthTokens/refresh` → return capability error; `item/tool/call` → return capability error. These cannot crash the runtime.
3. **Drop the `plugins` and `apps` `--disable` flags** at `agentChatService.ts:11059`. Keep `browser_use` and `computer_use`. Smoke-test that plugin-installed skills appear in `skills/list` for users who configured them via Codex CLI.
4. **Clean up the triple-named reasoning effort** at `agentChatService.ts:7800-7802` to only send `effort`. v0.130 canonical key is `effort`.
5. **Smoke test**: existing chats, approvals, reasoning, file diffs, command exec, /review still work end-to-end against the bundled binary.

### Phase 1 — Plan-mode card

What Codex emits today: `plan` item with `item/started` (with the structured plan steps), `item/plan/delta` for streaming explanation, `item/completed`. Also `turn/plan/updated { explanation, plan: [{ description, status: pending|inProgress|completed }] }`.

What ADE has: `turn/plan/updated` handled (logged) and `item/plan/delta` handled (mutates a `proposed-plan` text buffer). No structured rendering. There's an existing `ChatProposedPlanCard.tsx` for the Claude path that's a good visual template.

Changes:

1. Add `AgentChatEvent` variants:
   - `{ type: "plan_update", planId, steps: [{ id, description, status }], explanation, turnId, sessionId }`
   - Extend the existing in-place plan-delta accumulator to attach to the structured plan.
2. `agentChatService.ts` — replace the text-only plan handler with structured handling that:
   - On `item/started` for a `plan` item, emit `plan_update` with all steps in `pending`.
   - On `turn/plan/updated`, replace step list.
   - On `item/plan/delta`, append to `explanation` (markdown).
   - On `item/completed` for the plan item, finalize and mark inactive.
3. Desktop: rename / generalize `ChatProposedPlanCard.tsx` so it renders the structured plan with step checkboxes, current step highlighted, explanation panel underneath.
4. TUI: extend `ChatView.tsx` with a `plan` block renderer — bordered box, checkbox glyphs (`◉` / `◐` / `○`), explanation as dimmed text below.

### Phase 2 — Manual `/compact` and contextCompaction item

What Codex emits: `contextCompaction` item streamed via `item/started` → `item/completed`. Triggered by client via `thread/compact/start`. The old `thread/compacted` notification is deprecated.

Changes:

1. Wire `thread/compact/start` request behind a `/compact` slash command in both surfaces (already routed through ADE's slash registry — add a Codex-only entry).
2. Add `AgentChatEvent` variant `{ type: "context_compaction", state: "started" | "completed", summary?, turnId, sessionId }`.
3. Desktop renderer: subtle inline "context compacted — N tokens reclaimed" chip.
4. TUI: dimmed notice line with same content.

### Phase 3 — Goals (`/goal`)

Methods: `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`. Notifications: `thread/goal/updated`, `thread/goal/cleared`.

Changes:

1. Add `AgentChatEvent` variant `{ type: "goal", state: "set" | "cleared", goal?: string, sessionId }`.
2. Slash commands `/goal <text>` and `/goal clear` in desktop composer and TUI composer routes.
3. Persist active goal in `ChatSession` so we can render a pinned banner above the message list ("Goal: X").
4. Desktop: persistent slim banner at the top of the chat pane, click-to-edit.
5. TUI: status line above prompt, same content.

### Phase 4 — Image input

Today ADE supports `localImage` attachments only (`agentChatService.ts:7784`). Codex also accepts `image: { url }` for clipboard-pasted or drag-dropped URLs.

Changes:

1. Composer detects image URLs / clipboard image data; for URL form, send `{ type: "image", url }`; for paste/file, stage to tmp dir and send `{ type: "localImage", path }` (current path).
2. TUI: support image paths via `@file.png` mention syntax that already exists; add a `--image <url>` flag for `ade chat send`.

### Phase 5 — imageGeneration + imageView items

Codex now emits `imageGeneration` items (when the model produces images) with `{ savedPath, revisedPrompt, result }`, and `imageView` items (when the model views an image as a tool call).

Changes:

1. Add `AgentChatEvent` variants:
   - `{ type: "image_generation", path, revisedPrompt, status, turnId, sessionId }`
   - `{ type: "image_view", path, source, turnId, sessionId }`
2. Desktop: image thumbnail in the message stream, click-to-zoom modal that already exists for attachment previews.
3. TUI: inline notice with path + `↗ open` keybind that calls `open <path>` via the system handler.

### Phase 6 — Rich `webSearch` item rendering

Today ADE logs `codex/event/web_search_begin` but doesn't render the structured `webSearch` item. The item carries a `query` and a `WebSearchAction` discriminated union: `search` (initial query), `open_page` (URL visited), `find_in_page` (in-page find).

Changes:

1. Add `AgentChatEvent` variant `{ type: "web_search", query, actions: WebSearchAction[], status, turnId, sessionId }` where `WebSearchAction` mirrors the Codex shape.
2. Desktop: collapsible "Web search: <query>" card listing each action (icons for search / open / find), URL hyperlinked.
3. TUI: nested list under "🔍 web search" header.

### Phase 7 — Token-usage HUD

`thread/tokenUsage/updated` is emitted on every turn boundary and resume. ADE already receives this — needs surfacing.

Changes:

1. Add `AgentChatEvent` variant `{ type: "token_usage", input, output, cacheRead, cacheWrite, total, sessionId }`.
2. Desktop: extend `ModelStatus` / footer area to show `1.2k in / 4.5k out (cached 800)` per turn, plus a running session total.
3. TUI: extend `ModelStatus.tsx` with the same numbers under the model name.

### Phase 8 — Thread history: resume picker + fork + unarchive + rollback

This is the biggest UX piece. Codex CLI's `/resume` UX is what we're matching.

Methods we'll add:

- `thread/list { searchTerm?, cursor?, sortKey?, sortDirection?, cwd?, sourceKinds?, archived?, modelProviders? }` returns `{ items: [...], nextCursor, backwardsCursor }`. Items include name, lastActivityAt, turn count, cwd, archived.
- `thread/read { threadId, includeTurns: boolean }` returns metadata + (optionally) all turns. Used for read-only preview before resuming.
- `thread/fork { threadId, ephemeral?: boolean }` — branch into new thread.
- `thread/unarchive { threadId }` — restore.
- `thread/rollback { threadId, lastN }` — drop trailing turns.

Changes:

1. Add a new `CodexHistoryService` wrapper in `agentChatService.ts` that owns these requests (they don't need to be tied to a running session — can be called on a one-shot app-server instance, but easier to reuse an existing managed session's runtime if one is open, else spawn a transient `codex app-server` and shut down).
2. IPC: expose `window.ade.codex.history.{list,read,fork,unarchive,rollback}` to the renderer.
3. Desktop: new "Codex history" picker (modal or right-pane drawer) — list with search box, cwd filter, archived toggle, per-row actions (resume / fork / unarchive / rollback). Triggered by `/resume` slash command and by a new toolbar entry in the work-tab chat header.
4. TUI: a new `ChatHistoryPalette` component (modeled on `MentionPalette.tsx`), opened by `Ctrl+R` or `/resume`. Same list + actions, keyboard-only.

### Phase 9 — Long-thread pagination

When resuming a long thread today, `thread/resume` returns everything. Codex now supports `thread/turns/list { threadId, cursor?, itemsView: "summary" | "full" | "notLoaded" }` so we can lazy-load.

Changes:

1. `thread/resume` continues to be the entry point but switch to `itemsView: "summary"` for the initial load (returns turn metadata + first/last item per turn).
2. Renderer requests `itemsView: "full"` on scroll-up for the next page of turns.
3. Persist scroll-restore state so users land where they left off.
4. TUI: same pagination via keyboard scrollback.

### Phase 10 — Notification opt-out for perf

Add `optOutNotificationMethods` to the `initialize` request based on which renderer is consuming:
- Desktop: keep deltas (visual streaming matters).
- TUI in non-interactive mode (`ade chat send <prompt> --print`): opt out of `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta` because we only print final state.

### Phase 11 — Verification + tests

Per repo testing memory: **only real-value tests, no brittle UI/render tests, shard test runs, run only related tests after focused changes.**

1. Protocol round-trip tests for each new request/notification in `agentChatService.test.ts` (we have an existing fixture harness; extend it with a fake app-server that emits the new notifications).
2. End-to-end smoke per phase: scripted `codex app-server` against a real bundled v0.130 binary in CI, run a turn through that exercises plan / compact / goal / image / web_search / pagination, assert the resulting `AgentChatEvent` envelope.
3. Manual: open the work-tab chat against each phase's feature, capture a screenshot, confirm rendering. For UI changes I'll start the dev server and exercise the flow in-browser before reporting done.

## Risk / open questions

1. **Binary size for the bundle.** `codex` is ~50MB per platform; bundling 5 platforms inflates installer size. Mitigation: only bundle the current platform per build target (already what electron-builder does for native modules), but we'll need to teach the workflow to download per-target.
2. **`thread/list` performance** with very large `~/.codex/sessions` dirs. Codex itself paginates. We must always pass `limit` (default 20) and use cursor pagination — never list all.
3. **Goal persistence vs ADE's per-lane session model.** Goals are per-thread in Codex; ADE's chat session is per-lane. Map 1:1.
4. **`thread/fork` ephemerality semantics** — when `ephemeral: true`, the forked thread isn't persisted to disk. Useful for "try this variation" UX, but we need to surface this in the fork UI so users know.
5. **Plugin / app discovery flake** — once we drop `--disable plugins --disable apps`, a misconfigured plugin in `~/.codex/` could log warnings. We should surface `configWarning` notifications in the chat as a subtle notice (one-line addition).

## Definition of done

- Bundled `codex` is `rust-v0.130.0`, verified on macOS arm64 and Windows x64 ADE builds.
- `--disable plugins` and `--disable apps` removed from the spawn invocation.
- Every Tier A feature renders in both desktop work-tab chat and TUI ChatView.
- `/resume`, `/compact`, `/goal`, `/plan` slash commands wired in both surfaces.
- Token usage visible in the model status footer of both surfaces.
- Plan, compaction, goal, image-gen, image-view, web-search items have dedicated visual treatment (not "text" fallback).
- New unit tests pass via `pnpm test --filter codex` (sharded).
- Manual smoke checklist run on a fresh worktree: see Phase 11.
