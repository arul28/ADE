# Lane story (Lanes tab overhaul) — locked spec

Status: **experimental**, behind Settings → General → Experiments → "Lanes tab overhaul".
Ships in three units built in parallel: (A) data + runtime, (B) experiment toggle,
(C) renderer. Nothing outside the toggle changes behavior for users who leave it off.

## Why

The Lanes tab is a control panel in a product where agents perform every git and
PR action. What humans need from it is narrative and accountability: what happened
in this lane, which agent chat did it, what is happening now, what is stuck. Today
none of that is persisted: lane origin, commit→chat attribution and PR/agent
transitions are all recomputed from current state or dropped at service
boundaries (`laneService.create`, `gitOperationsService.commit`, head watcher).

## Data model

### `lane_events` table (new, `kvDb.ts` `migrate()`)

```sql
create table if not exists lane_events (
  id text primary key,            -- ulid/uuid
  project_id text not null,
  lane_id text not null,
  kind text not null,             -- LaneEventKind
  ts text not null,               -- ISO-8601 event time
  actor_kind text not null,       -- human|agent|bot|system|unknown
  actor_session_id text,          -- chat session id when actor is an agent chat
  actor_provider text,            -- claude|codex|cursor|droid|... (captured at write; not in sqlite elsewhere)
  actor_model text,
  actor_login text,
  attribution text,               -- session|trailer|head-watch|inferred
  ref text,                       -- sha | pr id | chat session id | branch ref | child lane id
  branch_ref text,
  payload_json text not null,
  created_at text not null        -- insert time
);
create index if not exists idx_lane_events_lane_ts on lane_events(lane_id, ts);
create index if not exists idx_lane_events_lane_kind_ref on lane_events(lane_id, kind, ref);
```

Rules (from cr-sqlite constraints, `kvDb.ts`):
- CRR by default (single text PK, **no UNIQUE index**, FKs not relied on). Rows sync to
  phones; that is desired (iOS mini-spines later).
- Dedupe is app-side: `(lane_id, kind, ref)` is the identity for `commit`, `pr_*`,
  `chat_*`, `branch_switched`, `lane_spawned`; writer does select-then-insert.
- **Not** in `RETAINED_EVENT_LOG_TABLES` (30-day prune would erase the story).
  Bounded instead by: (1) milestone-only kinds, (2) rows deleted with their lane in
  `laneService` delete/cleanup (same place `checkpoints` are deleted), (3) per-lane cap
  of 4000 rows — on insert past the cap, oldest `commit`/`pr_checks` rows are dropped first.
- `pr_checks` and `pr_review` are written only on **transitions** (status changed),
  never on every poll.

`checkpoints` stays untouched (out of scope; documented as unused).

### Lane origin

No new column on `lanes`. Origin is the `lane_created` event's payload
(`LaneCreatedPayload`). `laneService.create/createChild/createFromUnstaged` gain an
optional `origin?: LaneCreationOrigin` argument; every caller that has context passes
it (chat auto-create → `chat` + chatSessionId + fromLaneId; CTO/RPC `lane.create` →
`agent-cli` + caller session; automations → `automation` + ruleId; Linear paths →
`linear` + identifier; PR import → `pr-import`; conflict → `conflict`; renderer dialog
and plain CLI → `human`; missing → `unknown`). When `origin.chatSessionId` belongs to
a chat in a *different* lane, the writer also records `lane_spawned` on that lane.

### Attribution of commits

1. **Recorded at write time** (`attribution: "session"`): `GitCommitArgs` gains
   optional `actorSessionId`. Threaded from: the RPC `commit_changes` tool
   (session id already known), `ade git commit` (`$ADE_CHAT_SESSION_ID`), the CTO
   `gitCommit` tool, and the Git pane (`human`). `gitOperationsService.commit()`
   (+ revert/cherry-pick/rebase-continue) writes the `commit` event(s) for the shas
   created (`git rev-list pre..post`).
2. **Head-watch / out-of-band** (`attribution: "head-watch"`): on `onHeadChanged`
   (git op finish or the head watcher) the writer lists `pre..post` shas not yet
   recorded and attributes each to the lane's single mid-flight chat session
   (`terminal_sessions` where `chat_session_id = id`, status running, lane match,
   `head_sha_start` set) if exactly one exists; if several, the one whose PTY had the
   most recent output; else `unknown`.
3. **Trailer hint** (`attribution: "trailer"`): commit messages are parsed for
   `Co-Authored-By:` — `Claude …` → provider `claude`, `Cursor <cursoragent@…>` →
   `cursor`, `Codex`/`ChatGPT` → `codex`; used to fill provider when the session is
   unknown, and always stored in `payload.coAuthors`. ADE does **not** write trailers
   in v1 (rewriting user commit messages is out of scope; noted as a follow-up).

### PR events

Written at the poller diff site (`prPollingService` per-PR diff, where
`previousState/previousChecksStatus/previousReviewStatus` are known): `pr_opened`
(first sight or state → open), `pr_merged`, `pr_closed`, `pr_checks` (checks status
transition), `pr_review` (review status transition). Actor for `pr_opened`: the chat in
`pull_request_chat_sessions` if any (`agent`), else `human` with the PR author login.
`pr_review`: `bot` with reviewer login when a bot, else `human`. `pr_merged`: `human`
`merged_by_login`.

### Chat lifecycle

`chat_started` when a chat row is created (`agentChatService.createSessionInternal`
→ after `sessionService.create`), capturing provider/model/title. `chat_ended` on
session end/fail/settle (via the sessionService end/settle chokepoints, chat rows
only). Turn-level activity is **not** persisted (Sessions swimlane state comes from
live session state at read time).

### Branch switch & rebase

`branch_switched` from `laneService.switchBranch` (from/to). `rebase` from the lane
`onRebaseEvent`/auto-rebase completion.

### Read model: persisted ⊕ derived

`laneEventsService.list({laneId})` returns persisted rows **merged** with derived
events so pre-existing lanes and any missed writes still render:
- commits: `git log <base>..<branch>` (and, when the branch is fully merged, the PR's
  `commits_json` snapshot or `git log <mergeBase>..<lastKnownHead>`), each parsed for
  trailers; skipped if a persisted `commit` with the same sha exists.
- PRs: `pull_requests` rows for the lane (opened from `created_at`, merged from
  `merged_at`, closed from state) when no persisted `pr_*` exists.
- chats: `terminal_sessions` chat rows for the lane (`started_at`/`ended_at`), joined
  with live `agentChatService` provider/model when available (else the sidecar json).
- `lane_created` synthesized from `lanes.created_at` with `source: "unknown"` when absent.
Derived events carry `derived: true`. `branches` groups events by `branch_ref`
(current + `lane_branch_profiles`), `chats` gives the swimlane/tail data.
`summary({laneIds})` returns the compact digest for the List view (persisted-only
plus a cheap derived fallback of last commit/PR when empty).

## Runtime wiring (unit A)

- Service `apps/desktop/src/main/services/laneEvents/laneEventsService.ts` +
  `laneEventsServiceWiring.ts` (shared factory used by **both** `apps/ade-cli/src/bootstrap.ts`
  and `apps/desktop/src/main/main.ts`, holder pattern like search).
- Writer hooks: `onLifecycleEvent` (create/delete), `onHeadChanged`, git op finish,
  `switchBranch`, `onRebaseEvent`, `prPollingService` diff, chat create/end.
- Action domain **`lane_events`** in `adeActions/registry.ts`: allowlist `list`,
  `summary`; contracts with description/input/example; domain service builder returns
  null without the service. RPC scoping: reads are lane-scoped like `external-sessions`;
  denials use `policyDenied`, never `methodNotFound`.
- Push: `pushEvent("runtime", { type: "lane_events_changed", event })` /
  `emitProjectEvent(root, IPC.laneEventsChanged, …)` (debounced ≥250 ms per lane).
- Preload `window.ade.laneEvents = { list, summary, onChanged }` — **daemon-only**
  (`callProjectRuntimeActionIfBound`, no local IPC fallback), dual-leg subscription
  (local channel + remote pump; add to `hasRemoteRuntimeEventSubscribers`).
- Hosted web client: `adapter/laneEvents.ts` via sync remote commands
  `lanes.listEvents` / `lanes.eventsSummary` (`viewerAllowed: true`);
  `TABLE_DOMAINS["lane_events"] = "lanes"`.
- CLI: `ade lane events <laneId|--lane> [--json|--text] [--since] [--limit]`.
- Docs: this file, `docs/features/lanes/README.md` file map + IPC surface, CLI help
  regen, `ade actions list` contracts.

## Experiment toggle (unit B)

- Pref `experimentsLanesStoryEnabled: boolean` (default false) in the app-scoped
  user-preferences blob (`appStore.ts`, all four sites + setter
  `setExperimentsLanesStoryEnabled`, mirrored into per-project surface stores).
- Settings → General tab gets a group **Experiments** with one card
  `general.experiments` (anchor `experiments`), toggle label "Lanes tab overhaul",
  description "Replaces the lane panes with a story timeline of commits, PRs and
  agents. Experimental." Manifest entry + `settingsManifest.test.ts`.

## Renderer (unit C)

Seam: `LanesPage.tsx` body region (`visibleLaneIds.length` switch, ~L3559). When the
pref is on, render `<LaneStoryBody …/>` in place of the pane tiling; header
(title, branch selector, filter, NEW LANE, stack graph) and tab strip stay. A
`List | Timeline` segmented control is added to the header (right side) only when
the pref is on.

`components/lanes/story/`:
- `LaneStoryBody.tsx` — view switch state (per-project, persisted like other view
  state), routes to List/Timeline.
- `LaneStoryList.tsx` — one row per lane: index, name+branch, compact spine (from
  `laneEvents.summary`), agents (`useLaneAgents`) with live dot + status hint, PR chips.
  Click → select lane + Timeline.
- `LaneStoryTimeline.tsx` — for the selected lane: header (name, branch, PR chips,
  summary sentence), filter chips (Commits/PRs/CI/Reviews/Lanes/Sessions), git readout
  (`base ↑↓ · remote ↑↓ · CLEAN/DIRTY`) + `Pull (rebase)` + `Push` + `Git ▾` which
  opens the existing `LaneGitActionsPane` in a floating sheet; the story canvas
  (event-ordered x, one row per branch, forks drawn from `forkPointSha`/order, gap
  markers ≥4h, cards staggered above/below with connectors, agent-colored nodes,
  provider logos, GitHub avatar for humans, review→fix causality arc, session
  swimlanes, live/idle/ended tail at each branch end); inline expanding card on
  click with detail + actions (Jump to chat → existing chat deep-link/anchor when
  chatSessionId known; View diff → LaneDiffPane; Open PR → PRs route); compact
  time-proportional heat scrubber bottom-right with hover key.
- `laneStoryModel.ts` — pure layout/derivation (positions, folding of long
  same-agent commit runs into a segment when >8, gap markers, heat buckets, summary
  sentence, provider→color) with unit tests.
- `useLaneEvents.ts` / `useLaneEventsSummary.ts` — hooks over
  `window.ade.laneEvents` with `onChanged` refresh (coalesced), pinned-runtime aware.
- Background: `.ade-lane-story-bg` in `index.css` — slow shifting multi-stop aurora
  gradient (accent-tinted, subtle, `contain: strict`, disabled under reduced-motion,
  light-theme variant). Cards are glass (`.ade-glass-card` tokens), no left-border
  accents; agent colors: Claude `#D97757`, Cursor `#9CC7FF`, Codex `#10A37F`,
  Droid/others via `ProviderLogo` + `laneRailTint`; PR/CI green `--color-success`,
  review `--color-info`, lane `--color-accent`.
- Wheel scrolls the canvas horizontally; opening a lane settles to the right edge.

Non-goals (v1): Graph tab changes, iOS UI, CTO narrated summaries, writing commit
trailers, scrubber-driven time travel, compare-lanes.

## Acceptance

- Toggle off → Lanes tab is byte-for-byte today's behavior.
- Toggle on → List and Timeline render for every lane in the project using real
  data; a lane created before this ship shows a full derived story.
- New commits made by an agent chat through `commit_changes`/`ade git commit` show
  that chat's provider/model within one poll; terminal commits show within the head
  watcher interval with head-watch attribution.
- PR open/merge/checks/review transitions appear as events without restart.
- `ade lane events <id> --text` prints the story; `ade actions list --domain lane_events`
  documents both actions.
- Tests: service (write/dedupe/derive/cap), registry, preload subscription, CLI plan,
  sync command, model unit tests, settings manifest.
