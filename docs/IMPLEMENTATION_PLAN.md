# Implementation Plan

Last updated: 2026-02-10

This plan is the build order for ADE MVP. It is intentionally explicit about:

- what to build (desktop core, renderer UI, backend)
- which docs define the expected behavior
- exit criteria per phase so you know when to move on

UI source of truth:

- `features/UI_SPEC_LOCKED.md`
- `features/UI_COMPONENT_INVENTORY.md`

## Phase -1: Repo + Desktop Scaffold (Start From Nothing)

Status: DONE (2026-02-10)

References:

- Desktop structure: `architecture/DESKTOP_APP.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`
- UI component inventory: `features/UI_COMPONENT_INVENTORY.md`
- Onboarding/trust: `features/ONBOARDING_TRUST.md`

Scope:

- Create a production-shaped desktop app structure even if most features are stubs.
- Set up the renderer tech stack locked in `UI_SPEC_LOCKED.md`.

Desktop core (main process):

- Create the Electron main process skeleton with secure defaults.
- Create preload bridge with strict allowlist.
- Add an internal logging utility (structured logs; write to `.ade/logs/`).

Renderer UI:

- Implement `AppShell` with:
  - top bar (project selector placeholder)
  - left tab nav (all tabs exist)
  - main content area
- Implement Lanes cockpit layout skeleton:
  - 3 resizable panes + right inspector with sub-tabs
- Add a minimal command palette (modal with a few actions).

Persistence:

- Add local DB bootstrap (SQLite file stored under `.ade/` local state).
- Persist pane sizes/layout per project.

Exit criteria:

- App launches and shows all tabs per `UI_SPEC_LOCKED.md`.
- Resizable 3-pane layout works and persists after restart (even with placeholder content).

Checklist:

- [x] Scaffold `apps/desktop` with dev scripts (`dev`, `build`, `typecheck`)
- [x] Install UI stack deps per `UI_SPEC_LOCKED.md` (routing/state/panes/primitives/icons)
- [x] Implement `AppShell`, `TopBar`, `TabNav`
- [x] Implement split pane primitives and persist sizes per project
- [x] Create component folder structure per `UI_COMPONENT_INVENTORY.md`
- [x] Preload bridge with `app.ping() -> "pong"`
- [x] Settings tab placeholder (shows versions + environment)

Verification:

- `cd apps/desktop && npm run dev`
- Open **Lanes**, resize the 3 panes, quit/relaunch, confirm layout persists.
- Open **Settings**, confirm versions/environment render.

## Phase 0: Terminals + Session Tracking (Gating)

References:

- Terminals: `features/TERMINALS_AND_SESSIONS.md`
- Terminal command center: `features/TERMINAL_COMMAND_CENTER.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`
- UI component inventory: `features/UI_COMPONENT_INVENTORY.md`
- Security/privacy: `architecture/SECURITY_PRIVACY.md`

Scope:

- Make embedded terminals reliable and scalable first. Everything else depends on this.

Desktop core (main process):

- Implement `ptyService`:
  - create PTY session (cwd = lane worktree path)
  - stream output to renderer
  - accept input from renderer
  - resize
  - dispose
- Implement `sessionService`:
  - store session metadata (start/end, exit code, tool type, label/goal)
  - capture transcript to `.ade/transcripts/` (local-only by default)

IPC (typed):

- `pty.create({ laneId, cols, rows, title }) -> { ptyId }`
- `pty.write({ ptyId, data }) -> void`
- `pty.resize({ ptyId, cols, rows }) -> void`
- `pty.dispose({ ptyId }) -> void`
- Event: `pty.data({ ptyId, data })`
- Event: `pty.exit({ ptyId, exitCode })`

Security defaults (Phase 0):

- Renderer cannot read files or spawn processes directly.
- Preload exposes only explicit terminal/session APIs (strict allowlist).
- Transcripts remain local unless the user explicitly enables uploads/redaction. See `architecture/SECURITY_PRIVACY.md`.

Renderer UI:

- Implement `TerminalView` (xterm wrapper) and connect it to PTY IPC.
- Implement Terminals tab list view:
  - global session list with filters
  - jump-to-lane behavior (navigates to Lanes tab and focuses session)
- Implement Lanes inspector Terminals tab:
  - lane-scoped session tabs
  - only render an active xterm for the focused session (others show lightweight preview)

Exit criteria:

- Can run 3 concurrent terminals and type/resize reliably.
- Session end events are captured with metadata + transcript path.

Checklist:

- [ ] IPC channels for PTY streaming are implemented and typed
- [ ] `TerminalSessionRow` list renders 50+ sessions without UI lag (virtualize if needed)
- [ ] Transcript capture and basic redaction toggle exists (default off for uploads)
- [ ] Lane-scoped session list works in the Lanes inspector Terminals tab

## Phase 1: Project Onboarding + Lanes Cockpit + Diffs

References:

- Navigation/layout: `features/NAVIGATION_AND_LAYOUT.md`
- Lanes: `features/LANES.md`
- File viewer/diff/quick edit: `features/FILE_VIEWER_DIFF_QUICK_EDIT.md`
- Onboarding/trust: `features/ONBOARDING_TRUST.md`
- Git engine: `architecture/GIT_ENGINE.md`
- Data model: `architecture/DATA_MODEL.md`
- Configuration: `architecture/CONFIGURATION.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- User can open a repo, create lanes (worktrees), see changes, and operate from the Lanes tab.

Desktop core:

- Implement `projectService`:
  - open repo path
  - detect default base branch
  - initialize local `.ade/` state and `.git/info/exclude` rule
- Implement `laneService`:
  - create lane (branch + worktree)
  - rename, archive
  - compute status:
    - dirty
    - ahead/behind
    - base ref
- Implement `diffService`:
  - working tree diff and staged diff
  - commit diff (latest N)

Renderer UI:

- Lanes tab:
  - lane list (`LaneList`, `LaneRow`, badges)
  - lane inspector tabs exist and can deep link to Conflicts/PR
- Center pane changes view:
  - diff viewer (MVP: monaco diff or simpler diff list)
  - file tree toggle
  - quick edit for small changes

Exit criteria:

- Can open a repo, create 2-3 lanes, run terminals in each lane, and see accurate dirty/ahead/behind.
- Diff viewer shows lane changes and supports small quick edits.

Checklist:

- [ ] Lane list shows badges per `UI_SPEC_LOCKED.md` (dirty, ahead/behind placeholders OK)
- [ ] Lane “open folder” works
- [ ] Lane inspector exists with sub-tabs (Terminals/Packs/Conflicts/PR)
- [ ] Diff viewer for working tree + staged

## Phase 2: Project Home (Processes + Test Buttons) (SoloTerm-like)

References:

- Processes/tests: `features/PROCESSES_AND_TESTS.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`
- Configuration: `architecture/CONFIGURATION.md`

Scope:

- Provide global project process runner and test buttons with persistent config.

Desktop core:

- Implement `processService`:
  - spawn/stop/restart managed processes
  - capture logs to `.ade/logs/`
  - readiness checks (V1; MVP optional)
- Implement `testService`:
  - run test suites
  - store run history and exit codes

Renderer UI:

- Projects (Home) tab:
  - managed process list + log viewer
  - stack profile selector (even if single default)
  - “Start all / Stop all”
  - test suite buttons with last run badges
- Settings/config:
  - edit process/test definitions (UI writes `.ade/` config)

Exit criteria:

- Can start/stop the project stack from one place.
- Can run unit/lint tests via buttons and see last run status.

Checklist:

- [ ] Projects (Home) tab matches locked UI layout
- [ ] Test buttons exist and persist across restart
- [ ] Logs viewer supports search

## Phase 3: Deterministic Packs (Always In Sync)

References:

- Packs: `features/PACKS.md`
- Job engine: `architecture/JOB_ENGINE.md`
- Terminal command center: `features/TERMINAL_COMMAND_CENTER.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Packs update on session end/commit and are visible in the UI.

Desktop core:

- Implement `packService`:
  - project pack (baseline build + incremental updates)
  - lane pack update:
    - based on session deltas (head sha start/end, diff stats, files touched)
    - include test results and process state pointers
- Implement `jobEngine` pipeline:
  - on session end:
    - update lane pack
    - update project pack (bounded)

Renderer UI:

- Lane inspector Packs tab:
  - pack viewer
  - freshness indicators (deterministic timestamps)
- Session delta card surfaces:
  - show in terminal detail and in lane pack

Exit criteria:

- After any terminal session ends, lane pack updates within seconds (deterministic).
- Packs are viewable and linked to sessions.

Checklist:

- [ ] Pack file layout under `.ade/packs/`
- [ ] Pack viewer UI
- [ ] Freshness indicators

## Phase 4: Conflict Radar + Guided Sync + Conflicts UI

References:

- Conflict radar: `features/CONFLICT_RADAR.md`
- Conflict resolution: `features/CONFLICT_RESOLUTION.md`
- Git engine: `architecture/GIT_ENGINE.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`
- History graph: `features/HISTORY_GRAPH.md` (operations timeline data)

Scope:

- Predict conflicts early and show GitButler-like lane badges.
- Provide guided sync and conflict packs (deterministic).

Desktop core:

- Implement `conflictPredictionService` (dry-run):
  - per lane vs base
  - store predicted conflict files
- Implement `syncService`:
  - merge default, rebase optional
  - operation records with pre/post SHA for undo
- Implement `conflictPackService`:
  - build conflict pack for predicted conflicts
  - build conflict pack for active merge/rebase conflicts

Renderer UI:

- Lanes tab:
  - conflict predicted/active badges on `LaneRow`
  - lane Conflicts inspector tab shows file list + CTA to open conflicts window
- Conflicts tab:
  - aggregate list + detail viewer + pack viewer

Exit criteria:

- Conflicts appear in Lanes tab without the user clicking anything.
- Sync lane with base is guided and undoable.

Checklist:

- [ ] Conflict prediction runs on session end and base updates (best-effort)
- [ ] Conflicts tab skeleton is navigable and shows conflict packs
- [ ] Undo last sync works reliably

## Phase 5: Hosted Agent (AWS) + Mirror Sync + Proposal Flow

References:

- Hosted agent: `architecture/HOSTED_AGENT.md`
- Cloud backend (AWS): `architecture/CLOUD_BACKEND.md`
- AWS stack decision: `architecture/AWS_STACK_DECISION.md`
- Security/privacy: `architecture/SECURITY_PRIVACY.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Deploy AWS backend with SST.
- Desktop authenticates via Cognito Hosted UI GitHub login.
- Mirror sync uploads blobs/manifests to S3.
- Conflicts tab can request a proposal job and display proposals.

Backend (AWS via SST):

- Cognito user pool + hosted UI + GitHub OAuth federation.
- API Gateway + Lambda endpoints:
  - create/register project
  - presigned S3 uploads for blobs
  - upload manifest (snapshot)
  - enqueue job
  - poll jobs
  - fetch artifact metadata + signed download
- DynamoDB tables for metadata + jobs + artifacts.
- SQS queue + worker Lambda that:
  - reads mirror state from S3
  - calls provider-agnostic LLM gateway module
  - writes artifacts (narratives, patch diffs) back to S3

Desktop core:

- Implement `authService`:
  - open browser to hosted UI
  - loopback callback capture
  - token storage in OS keychain
- Implement `mirrorSyncService`:
  - exclude patterns
  - forced sync on session end
  - coalesced sync (threshold)
- Implement `hostedJobsClient`:
  - enqueue proposal job for a conflict pack
  - poll status and download artifacts

Renderer UI:

- Settings:
  - hosted agent enable/disable
  - mirror excludes editor
- Conflicts tab:
  - “Generate proposals” + progress
  - proposals list + diff viewer + apply controls

Exit criteria:

- Can sign in via GitHub and register a project.
- Can sync a lane snapshot to S3.
- Can request a conflict proposal job and display the proposed patch.

Checklist:

- [ ] SST deploy works for `dev` stage
- [ ] Cognito GitHub login works from desktop
- [ ] Presigned upload path works for blobs and manifests
- [ ] Worker consumes jobs and writes artifacts
- [ ] Desktop can fetch proposals and show them as diffs

## Phase 6: GitHub PR Integration

References:

- PRs: `features/PULL_REQUESTS_GITHUB.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Create/link PR per lane and show status; global PRs tab shows stacked chains + parallel list.

Desktop core:

- Implement `prService`:
  - link PR metadata to lane
  - create PR (GitHub API)
  - poll checks/reviews status
- Implement `prDescriptionService`:
  - draft from deterministic packs
  - optionally add hosted narrative sections

Renderer UI:

- Lane inspector PR tab:
  - create/link, status, update description
- PRs tab:
  - stacked chain view (aligned to stack graph)
  - parallel PR list

Exit criteria:

- Lane -> PR flow works end-to-end.

Checklist:

- [ ] PR create/link/update
- [ ] Status chips for checks/reviews
- [ ] PRs tab skeleton and navigation

## Phase 7: Stacks + Restack + Land Stack (V1)

References:

- Stacks/restack: `features/STACKS_AND_RESTACK.md`
- PR stacking: `features/PULL_REQUESTS_GITHUB.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Make stacked lanes and restack flows first-class and aligned with PR chains.

Desktop core:

- Implement stack model persistence (parent/child).
- Implement restack operation (dependency order).

Renderer UI:

- Stack graph is real (not placeholder) and shows blocked lanes.
- PRs tab chain aligns with stack graph.

Exit criteria:

- Parent changes can be propagated to children with a single restack action.

Checklist:

- [ ] Create stacked lane flow
- [ ] Restack action with progress UI
- [ ] Land stack flow (guided) (V1)

## Phase 8: Automations + Actions

References:

- Automations: `features/AUTOMATIONS_ACTIONS.md`
- Job engine: `architecture/JOB_ENGINE.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Allow users to wire triggers to actions (packs/tests/sync).

Desktop core:

- Implement scheduler (cron-like or presets).
- Implement action runner and logs.

Renderer UI:

- Settings tab includes automations enable/disable and last-run status.

Exit criteria:

- A scheduled test run works and is visible in UI.

Checklist:

- [ ] `actions.yaml` schema and persistence
- [ ] Scheduler + logs

## Phase 9: History (Timeline + Graph V1)

References:

- History graph: `features/HISTORY_GRAPH.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- MVP timeline view from operations/sessions/packs.
- V1 graph view reusing stack graph library.

Desktop core:

- Ensure all operations write complete records (pre/post SHAs).

Renderer UI:

- History timeline + filters
- Event detail with jump links
- Graph view (V1)

Exit criteria:

- User can answer “what happened?” without leaving ADE.

Checklist:

- [ ] Timeline view
- [ ] Event detail panel
