# External Session Import

Users often run AI coding CLIs outside ADE in ordinary terminal windows:
Claude Code, Codex, Cursor `cursor-agent`, Factory Droid, and OpenCode. Those
tools persist their own sessions on disk, or expose a provider-native session
list. ADE's external-session import feature lets the user browse those sessions
from the Work surface and continue one inside ADE.

The user-facing mental model is a 2x2:

| Target | Continue | Copy |
|---|---|---|
| ADE chat | Continue the provider session as a native ADE chat with imported history. Claude and Codex only. | Create a provider copy and open that copy as a native ADE chat. Claude and Codex only. |
| CLI session | Continue the provider session in a tracked ADE terminal. | Start a copied provider session in a tracked ADE terminal when the provider supports it. |

"Continue" means ADE uses the original provider-native session. The user should
not also keep that same session active in another terminal. "Copy" means ADE
starts from a provider fork; the original provider session remains untouched.

The reverse direction also matters: sessions created or imported in ADE remain
resumable from the provider CLI because ADE records and, for fresh launches,
seeds the provider-native identifiers. Tracked CLI sessions persist
`TerminalResumeMetadata`; Claude chat imports seed `sdkSessionId` and mirror a
Claude session pointer; Codex chat imports bind the ADE session to the provider
thread id. Fresh ADE launches follow the same rule: for example Claude CLI can
receive a preassigned `--session-id`, while Codex/Cursor/Droid/OpenCode
continuation metadata is recorded as soon as ADE knows the provider target.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/externalSessions/externalSessionsService.ts` | Service entry point. Runs provider discovery, applies the capabilities matrix, filters project/all scope, detects already-imported sessions, validates import ids, enforces optional lane cwd scope, builds CLI resume/fork commands, delegates chat import, and creates tracked PTYs. |
| `apps/desktop/src/main/services/externalSessions/discoveryUtils.ts` | Shared discovery helpers: safe stat/read, top-N mtime sorting, JSONL prefix/suffix scans, one record classifier shared by prompt extraction and the recent-`messages` sampler, provider-wrapper cleanup, the preview-only markup-density gate, word-boundary clipping, title cleanup, cwd slug helpers, shell quoting, and path-inside checks. |
| `apps/desktop/src/main/services/externalSessions/discoverClaude.ts` | Discovers resumable Claude CLI JSONL transcripts under `CLAUDE_CONFIG_DIR` or `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`; reads `ai-title`/custom titles and excludes SDK entrypoints. |
| `apps/desktop/src/main/services/externalSessions/discoverCodex.ts` | Discovers interactive Codex rollout JSONL files under `CODEX_HOME/sessions/YYYY/MM/DD/` (default `~/.codex`), enriches them from `session_index.jsonl`, and maintains the rebuildable cwd/importability index used by project-scoped discovery. |
| `apps/desktop/src/main/services/externalSessions/discoverCursor.ts` | Discovers current Cursor sessions from `~/.cursor/chats/<workspace-md5>/<agentId>/store.db`, merges legacy transcript previews from `~/.cursor/projects/.../agent-transcripts`, uses `.workspace-trusted` for exact cwd recovery, and excludes SDK `agent-<uuid>` sessions. |
| `apps/desktop/src/main/services/externalSessions/discoverDroid.ts` | Discovers Factory Droid JSONL sessions under `~/.factory/sessions/<escaped-cwd>/`, using the `session_start` row for id/cwd/title. |
| `apps/desktop/src/main/services/externalSessions/discoverOpenCode.ts` | Discovers OpenCode sessions by running `opencode session list --pure --format json --max-count <N>` in the requested/project cwd. |
| `apps/desktop/src/main/services/externalSessions/claudeSessionTransplant.ts` | Non-destructive Claude transcript transplant. For forks it copies JSONL rows, rekeys `sessionId`, hard-links without clobbering, and leaves the source untouched; for moves it can link/unlink when requested by other callers. |
| `apps/desktop/src/shared/cliLaunch.ts` | Canonical CLI launch/resume/fork command builders. External import uses `buildTrackedCliResumeCommand`, `withCodexNoAltScreen`, provider permission/model mappings, and shell quoting from here. |
| `apps/desktop/src/shared/types/externalSessions.ts` | Canonical DTOs shared by desktop IPC, ADE actions, sync remote commands, `ade code`, and iOS. |
| `apps/desktop/src/main/services/chat/externalChatHistoryImport.ts` | Converts external Claude JSONL and Codex app-server thread history into ADE chat event envelopes with byte/event caps and provenance/truncation notices. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Owns `importExternalChatSession`. Creates the ADE chat session, imports Claude/Codex history, seeds Claude `sdkSessionId` or Codex `threadId`, persists provenance, and cleans up failed Codex forks. Statically imports the Claude transplant module for the packaged brain bundle. |
| `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/main/services/ipc/registerIpc.ts` | Defines and registers `ade.externalSessions.list` and `ade.externalSessions.import` for the legacy desktop in-process fallback. |
| `apps/desktop/src/preload/preload.ts`, `apps/desktop/src/preload/global.d.ts` | Exposes `window.ade.externalSessions.list/import`. The bridge first calls the bound project runtime's `external-sessions` ADE action domain and falls back to desktop IPC only when no runtime is bound. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | Registers the `external-sessions` ADE action domain (`list`, `import`) against the runtime service. |
| `apps/desktop/src/main/main.ts` | Constructs `externalSessionsService` for desktop-owned project runtimes and injects it into IPC, ADE actions, sync, and runtime context. |
| `apps/ade-cli/src/bootstrap.ts` | Constructs the same service for the headless ADE brain/runtime so remote-bound desktop windows and the mobile sync host expose the feature. |
| `apps/ade-cli/src/adeRpcServer.ts` | Authorizes `run_ade_action` calls. Non-CTO callers are lane-scoped for `external-sessions`; CTO callers can use the domain unscoped. |
| `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`, `apps/desktop/src/main/services/sync/syncRemoteCommandService.ts` | Registers `work.listExternalSessions` and `work.importExternalSession` for paired controllers. The desktop file is a re-export of the ade-cli implementation. |
| `apps/desktop/src/shared/types/sync.ts` | Sync command DTO aliases for external-session list/import payloads and results. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionBrowser.tsx` | Desktop two-stage browser/details flow: provider filters, search (which spans the sampled `messages` text, not just titles), project/all scope, progressive scans, full details with a bounded scrollable message sample, target lane selection, imported/active badges, Open-in-ADE, and safe action dispatch. The dialog height is content-driven rather than pinned, because the details stage is far shorter than the list stage. |
| `apps/desktop/src/shared/externalSessionAffordances.ts`, `apps/desktop/src/renderer/components/terminals/importSessions/affordances.ts` | Canonical capability-to-action mapper for the 2x2 Continue/Copy x ADE-chat/CLI-session policy, plus the renderer compatibility export. Shared directly with the TUI. |
| `apps/desktop/src/renderer/components/terminals/importSessions/sessionPresentation.ts` | Pure desktop heading/time/anchor helpers. Provider titles win, then the opening prompt (`preview`), then cwd + relative time. `sessionAnchors` returns the row's "started"/"latest" pair and drops whichever one the heading is already showing, so a row never prints the same sentence twice. |
| `apps/desktop/src/renderer/components/terminals/importSessions/contract.ts` | Renderer bridge/types/display helpers for external sessions. |
| `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts` | Adopts import results into the Work surface and focuses existing imported sessions without re-importing. |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx`, `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx`, `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` | Wires the import browser into the Work draft/new-session surface and routes imported or already-imported sessions to the selected Work tab. |
| `apps/ade-cli/src/tuiClient/externalSessionBrowser.ts`, `apps/ade-cli/src/tuiClient/components/RightPane.tsx` | ADE Code TUI helpers and right-pane rendering for the same external-session DTOs and affordance mapper. |
| `apps/ios/ADE/Models/RemoteModels.swift` | iOS Codable mirrors for `ExternalSessionSummary`, `ExternalSessionMessage`, capabilities, imported refs, and import results. `messages` decodes through `ADELossyArray`, and `ExternalSessionMessage` rejects any role other than `user`/`assistant`, so a bad element is dropped instead of taking the whole summary down. A new key must be added in all three places inside the summary struct — `CodingKeys`, the memberwise `init`, and `init(from:)` — or it silently decodes as nil. |
| `apps/ios/ADE/Services/SyncService.swift` | iOS client methods for `work.listExternalSessions` (including the exact `sessionId` lookup) and `work.importExternalSession` (model, permission mode, reasoning effort, and fast mode). |
| `apps/ios/ADE/Views/Work/WorkNewChatScreen.swift` | Adds the Import session affordance when a concrete lane is selected. |
| `apps/ios/ADE/Views/Work/WorkImportSessionScreen.swift`, `apps/ios/ADE/Views/Work/WorkExternalSessionAffordances.swift` | iOS two-stage browser/details flow plus pure action policy. Mirrors the capability model, target lane selection, project/all scope, provider chips/logos, Open-in-ADE, imported/active badges, started/latest row anchors, the model + reasoning + fast-mode + permission controls shown before a chat import, and persisted-summary navigation after import. `workExternalSessionProviderName` is the one provider-label map both files use. |
| `apps/ios/ADE/Views/Work/WorkRootComponents.swift`, `apps/ios/ADE/Views/Work/WorkStatusAndFormattingHelpers.swift`, `apps/ios/ADE/Views/Components/ADEDesignSystem.swift` | Shared iOS provider logos, fallback symbols, and provider accent colors consumed by the import screen. |

## Architecture

### Discovery

`externalSessionsService.list` fans out to one provider module per requested
provider, catches provider-specific failures, merges the rows, filters to the
current project scope unless `scope: "all"` is requested, and returns
`ExternalSessionSummary[]` sorted by `updatedAt` descending.

File-backed providers are stat-first. Discovery gathers candidate files, sorts
by mtime, and reads a bounded recent candidate window. Claude keeps scanning
past filtered SDK transcripts until it has filled the requested CLI-session
limit. Codex all-history discovery uses a larger bounded window so
non-interactive rollouts cannot starve valid CLI results. Codex project-scoped
discovery instead refreshes a rebuildable cwd/importability index under
`$ADE_HOME/cache/external-sessions/`: it stats the rollout inventory, reads the
`session_meta` prefix only for new or changed files, and filters the complete
index without a fixed file-count ceiling. The cheap JSONL read is bounded by
`JSONL_SCAN_BYTE_LIMIT` and `JSONL_SCAN_LINE_LIMIT`; meaningful user prompt
counts are only computed for files under `MESSAGE_COUNT_MAX_BYTES`.
Provider metadata, assistant/tool rows, local-command wrappers, and duplicate
Codex storage representations do not inflate `messageCount`. OpenCode is the
exception because its supported interface is the CLI list command, so discovery
runs `opencode session list --pure --format json --max-count <limit>` in the
requested cwd, project root, or home directory. The list schema does not expose
a preview or prompt count, and discovery deliberately avoids an expensive
per-session `opencode export` fan-out.

Titles and previews are deliberately separate:

- `title` is a real provider-persisted title, or `null`. Discovery must not use
  the first user message as a title.
- `preview` is the thread's **opening prompt** — the first real human message,
  after ADE guidance and provider transport-wrapper stripping. It is what the
  row heading falls back to when the provider persisted no title, which is the
  common case for Claude CLI transcripts. Synthetic Claude
  `<local-command-caveat>`, `<command-name>`, `<local-command-stdout>`, and
  Codex environment/AGENTS payloads must never become previews. There is no
  separate first-prompt field: an alias of `preview` is one more thing to keep
  in sync across the DTO, the sync command, the iOS mirror, and two renderers,
  for no information the summary did not already carry.
- `messages` is a bounded sample of recent user/assistant exchanges, oldest to
  newest, capped by `EXTERNAL_SESSION_MESSAGES_MAX_COUNT` (8) and clipped per
  message by `EXTERNAL_SESSION_MESSAGE_MAX_LENGTH` (320). Claude derives it from
  the tail of its existing prefix + suffix scan at no extra I/O cost; Codex
  reads a bounded rollout suffix (64 KiB while browsing, 128 KiB for an exact
  `sessionId` lookup) and skips `.jsonl.zst` rollouts entirely. Cursor, Droid,
  and OpenCode leave it absent rather than paying for new I/O — OpenCode in
  particular must not gain a per-session `opencode export` fan-out.

`messages` is **optional and nullable**, and must stay that way. The iOS mirror
decodes every field with `decodeIfPresent`, and a decode failure there drops the
entire summary through a swallowing `try?`, so the import screen would show an
empty "No sessions found" state with no error. `messages` additionally decodes
through a lossy array wrapper, so one malformed element costs that element, not
the session. Add new optional keys; never re-type an existing one.

Two rules keep previews honest:

- **Wrapper rejection is not an allow-list.** The named noise-tag list still
  exists, but it cannot be complete — a `<task-notification>` blob shipped to
  users as a preview precisely because it was not on it. Preview selection
  therefore also rejects text that is predominantly markup
  (`EXTERNAL_SESSION_MARKUP_TEXT_MIN_RATIO`), and wrapper stripping handles tags
  whose closing half fell outside the read window.

  That density gate is **preview-only**. It runs where a preview or a `messages`
  sample is chosen, never inside `cleanExternalSessionUserText`, because that
  cleaner also feeds `externalChatHistoryImport` and therefore the imported chat
  transcript. Rejecting markup-heavy or very short turns there would silently
  delete real user messages from someone's history — a pasted JSX snippet, or a
  reply as ordinary as "ok". Message counting must not use it either.
- **`preview` may only come from *prefix* records.** Claude's scan array is
  prefix ++ tail, so a loop that simply took the first record yielding text
  would fall through into the tail and surface a background-task receipt as the
  opening prompt. Recent `messages` are the only thing sourced from the tail.

Clipping snaps to a word boundary and never ends inside a tag; a hard `slice`
produces visibly bisected markup such as `<stat…`.

The desktop and iOS rows use the real title when present, then the opening
prompt, then a path/time heading. Placeholder titles such as "New Session" are
normalized to null. Both surfaces suppress an anchor that would repeat the
heading, so a one-message thread with no provider title shows its prompt once.

The service also stamps:

- `alreadyImported` and `importedSessionRef`, by scanning ADE
  `terminal_sessions` resume metadata and Claude session pointers. Chat refs
  outrank CLI refs so the UI can offer one "Open in ADE" action.
- `possiblyActive`, when the backing file mtime is within the recent active
  window.
- `cwdMatchesRequestedLane`, comparing the provider cwd to the requested lane
  cwd when known.

### Capabilities matrix

The backend is the source of truth for action availability. The renderer and
iOS app only map capability flags to buttons.

| Capability | Meaning |
|---|---|
| `resumeInPlace` | The provider can continue the original session in the cwd where it was created. |
| `resumeInDifferentCwd` | The provider can continue the original session while running in the target ADE lane cwd. |
| `fork` | The provider can start a copied/branched session without mutating the original. |
| `forkIntoDifferentCwd` | The provider can start that copy in the target ADE lane cwd even when the source cwd differs. |
| `importToChat` | ADE can convert the provider history into a native ADE chat and continue from there. |

Current provider flags:

| Provider | Flags | Why |
|---|---|---|
| Claude | `resumeInPlace`, `fork`, `forkIntoDifferentCwd`, `importToChat` | Claude CLI resume is cwd-scoped. Same-cwd CLI fork uses `--fork-session`; cross-cwd copy rewrites cwd/session ids in a copied JSONL under the target lane. A cross-folder ADE chat therefore offers Copy, not a misleading Continue action. |
| Codex | all five | Codex app-server threads are portable across cwd for ADE's purposes. CLI resume/fork runs in the lane cwd, and chat import uses app-server `thread/read` plus `thread/fork` for forks. |
| Cursor | `resumeInPlace` only | `cursor-agent` resumes are cwd-scoped and there is no supported fork path. SDK-origin `agent-<uuid>` transcripts are excluded because `cursor-agent --resume` would start empty. |
| Droid | `resumeInPlace`, plus `fork` and `forkIntoDifferentCwd` only when the installed CLI exposes `--fork` | Droid resume is cwd-locked. Factory documents `droid --fork`, but older installed CLIs do not support it, so ADE probes `droid --help` and disables fork until support is confirmed. |
| OpenCode | `resumeInPlace`, `fork` | OpenCode sessions are project/cwd-scoped. ADE can use `--session`, `--continue`, and `--fork` in the original cwd; it rejects cross-lane copies rather than attaching a source-folder process to the wrong lane. |

These are provider maxima, not unconditional per-row permissions. Discovery
also checks whether the session has a usable source cwd. Missing/unavailable
folders disable actions that would launch there; a Claude row with a known but
currently missing source folder can still be copied/transplanted, while a row
with no trustworthy cwd exposes no import action. Import revalidates the same
constraints server-side.

The first Droid list call can be conservative. Service construction starts the
`droid --help` probe immediately, but `list()` reports fork as unavailable until
the async probe resolves. Import does not have that race: Droid fork import
awaits the probe before launching or refusing.

### CLI target

`externalSessionsService.importExternalSession` validates the provider and
session id (strict UUIDs for Claude/Codex; bounded provider-safe ids for the
other CLIs), resolves the target lane cwd, optionally enforces caller lane scope,
finds a currently resumable external summary, chooses the run cwd, builds
`TerminalResumeMetadata`, then builds a provider command.

Resume commands come from `buildTrackedCliResumeCommand` in
`apps/desktop/src/shared/cliLaunch.ts`. Fork commands mostly reuse the same
builder and provider-specific flags:

When an import does not explicitly override model or permission mode, the
resume command preserves provider state. ADE does not inject Claude plan mode,
Cursor `--model auto`, Droid spec/off settings, or an OpenCode ask-policy
config merely because the import UI omitted an override.

- Claude same-cwd fork appends `--fork-session` to the Claude resume command.
- Claude cross-cwd fork calls `transplantClaudeSession` first, then resumes the
  copied/rekeyed session id from the lane cwd.
- Codex fork rewrites the tracked resume command from `resume` to `fork` and
  preserves `--no-alt-screen`.
- Droid fork launches `droid --fork <id>` after the installed-CLI probe says
  `--fork` exists.
- OpenCode fork appends `--fork` to the OpenCode tracked resume command and
  runs in the source project cwd.

The final spawn is a tracked `ptyService.create` call with `tracked: true`,
provider `toolType`, `startupCommand`, direct shell launch fields, and
`resumeMetadata`. The import path currently lets `ptyService` allocate a fresh
ADE session id, so it does not pass `allowNewSessionId`; that flag is required
only for create/resume callers that preassign a new `sessionId`. Future changes
that preassign external-import session ids must set `allowNewSessionId: true`
or `ptyService.create` will treat the request as a missing-session resume.

`resumeMetadata.importedFrom` records the original provider id and whether the
ADE session opened or forked it. That metadata is what lets later Work
continuation, `ade.pty.resumeSession`, and duplicate-import detection find the
provider target again.

Successful imports return the persisted `TerminalSessionSummary` or
`AgentChatSessionSummary` with the provider/ADE ids. Desktop and iOS install
that summary before navigating, so the first render cannot race database sync
and fall into a blank “session unavailable” state.

### Chat target

Only Claude and Codex support `target: "chat"`.
`externalSessionsService.importExternalSession` delegates those imports to
`agentChatService.importExternalChatSession`, which creates a normal
lane-scoped `AgentChatSession`, stamps `importedFrom`, appends imported
history events, and binds future turns to the provider-native id.

`externalChatHistoryImport.ts` is the history converter. It reads at most the
last 32 MB of file-backed transcript bytes and keeps the newest 2,000 imported
content events. The importer prepends system notices for provenance and
truncation, then maps user/assistant text plus supported tool calls/results,
commands, file changes, web searches, image generation, and image view events.
Metadata-only user rows and provider transport wrappers are excluded from the
visible transcript, while user-authored JSX/XML and ordinary text beginning
with `User request:` remain intact. Failed Claude tool results preserve their
failed status. If the caller did not provide a title, the chat title falls back
to the first imported user or assistant text.

Claude chat import reads JSONL from `CLAUDE_CONFIG_DIR` or
`~/.claude/projects`. If the user asks to fork, or if the source cwd differs
from the target lane cwd, ADE transplants the JSONL into the target lane's
Claude project folder under a fresh session id. The new ADE chat sets the
Claude runtime `sdkSessionId`, sets `claudeBackgroundResumeSessionId`, mirrors a
Claude pointer through `sessionService`, repairs known thinking-transcript id
collisions when needed, and then appends the imported ADE transcript events.

Codex chat import creates a Codex ADE session and asks the app-server for
provider state. Open imports call `thread/read` with `includeTurns: true`.
Fork imports first call `thread/fork` with `excludeTurns: true`, then read the
forked thread. If import fails after creating a provider fork, ADE best-effort
archives the forked thread before deleting the ADE session. Successful imports
set `managed.session.threadId` and persist a `chat:codex:<threadId>` resume
command.

The Claude transplant dependency in `agentChatService.ts` must remain a static
import. A dynamic `import()` built from a variable path is not bundled into the
`ade-cli` brain `cli.cjs`; packaged/headless runtimes then fail at runtime with
a missing `externalSessions/claudeSessionTransplant` module.

### Runtime routing

The desktop renderer calls `window.ade.externalSessions.list/import`. The
preload bridge first calls `callProjectRuntimeActionIfBound` for the
`external-sessions` ADE action domain. This is the normal path for local-bound
and remote-bound windows. The legacy `ade.externalSessions.*` IPC handlers are
only fallback handlers when no project runtime is bound.

The service is constructed in both runtime hosts:

- `apps/desktop/src/main/main.ts` constructs it for desktop-owned project
  runtimes.
- `apps/ade-cli/src/bootstrap.ts` constructs it for the headless ADE
  brain/runtime.

That dual construction is required. A remote-bound desktop window and the
mobile sync host talk to the brain/runtime, not to the renderer bundle.

The ADE action domain is `external-sessions` with actions `list` and `import`.
Non-CTO agents calling it through `run_ade_action` are lane-scoped: the caller
must be authorized for the requested lane, list args are forced to the lane cwd
and project scope, and import args receive `enforceLaneScopeCwd`. CTO callers
are unscoped.

### Mobile

Mobile uses sync remote commands:

- `work.listExternalSessions`
- `work.importExternalSession`

Both are `viewerAllowed`; import is also `queueable`. This is intentional. A
paired phone is a trusted controller for the runtime machine, so it can ask the
host to list or import sessions even though it never reads provider session
files or launches provider CLIs locally.

iOS mirrors the desktop model in `WorkImportSessionScreen`: provider chips,
project/all scope, provider logos, imported/possibly-active badges, the 2x2
Continue/Copy x ADE-chat/CLI-session actions, and "Open in ADE" for
`importedSessionRef`. `SyncService` sends the command envelopes and
`RemoteModels.swift` decodes the shared DTOs. Browsing and acting are separate
steps: selecting a compact row opens full details, the target lane picker, and
only the actions safe for that provider/cwd combination.

Rows show the same two anchors as desktop — what the thread started as and where
it left off — falling back to the single preview snippet when the host predates
`messages`. Chat imports also choose how the resulting ADE chat starts: model,
reasoning effort, fast mode (only where the model supports it), and permission
mode, seeded from and saved back to `WorkComposerPreferences` so the phone's
composer and its imports agree. Those fields are sent only for `target: "chat"`;
a CLI import keeps preserving provider state instead of injecting overrides.

## Provider gotchas

### Claude

Claude stores CLI sessions under
`~/.claude/projects/<cwd-slug>/<uuid>.jsonl`, or under
`CLAUDE_CONFIG_DIR/projects/...` when `CLAUDE_CONFIG_DIR` is set. Every Claude
path in discovery, CLI fork, and chat transplant must respect
`CLAUDE_CONFIG_DIR`.

Claude resume is strictly cwd-scoped. Same-cwd CLI fork can use
`--fork-session`; cross-cwd fork has to copy/rekey the JSONL into the target
cwd's Claude project folder. Claude `ai-title`, `customTitle`, and session-title
records are preferred when present; otherwise ADE leaves `title` null and lets
UI headings fall back to path/time. Transcripts with explicit `sdk-*`
entrypoints are excluded because the Claude CLI cannot reliably resume them.

### Codex

Codex stores rollout JSONL under `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`
and title/update metadata in `CODEX_HOME/session_index.jsonl`. ADE treats the
thread id as the rollout UUID. Chat import and continuation use the Codex
app-server `thread/read`, `thread/fork`, `thread/archive`, resume, and fork
surfaces.

Only interactive CLI rollouts are importable. ADE excludes exec, VS Code,
desktop/ADE-originated, and subagent rollouts. Structured/unknown `source`
metadata fails closed; current Codex subagents use an object-shaped source
record rather than the older string form. For preview/count ADE prefers the
canonical `event_msg.payload.type = user_message` row so duplicated
`response_item` rows and synthetic environment instructions are not shown.

Codex file-change history items use tagged enum shapes such as
`{ type: "add" }`, `{ type: "delete" }`, and `{ type: "update" }`; they are
not always bare strings. Keep `externalChatHistoryImport.ts` mapping aligned
with that shape.

Codex resume/fork flags must match the current provider schema and CLI and
app-server contracts. Do not revive stale `ThreadResumeParams` assumptions when
editing `buildTrackedCliResumeCommand` or Codex chat import; update the tests
that assert the actual request payloads and command argv.

### Cursor

Current Cursor versions index resumable sessions in
`~/.cursor/chats/<md5(exact-workspace-path)>/<agentId>/store.db`. ADE reads the
hex-encoded meta record for provider id, name, and creation time, includes
store-only sessions, and treats the SQLite WAL mtime as activity. Legacy
`~/.cursor/projects/<slug>/agent-transcripts/<agentId>/` JSONL remains useful
for prompt previews/counts. `.workspace-trusted` maps the lossy project slug to
the exact workspace path; transcript cwd wins when present.

SDK-origin `agent-<uuid>` transcripts are excluded because `cursor-agent` cannot
resume them as meaningful CLI sessions; it would start empty. Cursor has no fork
support and its resume is cwd-scoped. Cursor edit mode must not map to
`--mode ask`; `ask` is read-only. In `cliLaunch.ts`, only plan mode maps to
`--mode plan`, full-auto maps to `--force`, and edit/default omit a mode flag.

### Droid

Droid stores sessions under `~/.factory/sessions/<escaped-cwd>/*.jsonl`. The
first row must be `session_start`; ADE reads id, cwd, and title there. Current
Droid rows can omit a start timestamp, so creation time falls back to the first
timestamped message. `"New Session"` is a placeholder title and becomes null.

`droid --fork` is gated on an installed-CLI probe. Discovery can temporarily
show fork disabled while the probe is pending; import awaits the probe and
fails with a clear message if the installed binary lacks `--fork`. Resume is
cwd-locked.

### OpenCode

OpenCode discovery uses `opencode session list --pure --format json`; ADE does not
walk OpenCode's private storage. Resume and fork commands use OpenCode's
`--session`, `--continue`, and `--fork` flags. Sessions are per-project by cwd,
so ADE resumes or forks in the source project cwd rather than transplanting
them into another lane cwd.

## Testing constraints

This feature must exist on both sides of the connection: the client surface and
the host brain it talks to.

Desktop pre-merge testing can point the renderer at an isolated lane-built
brain by using an isolated `ADE_HOME` and runtime. That lets the desktop client
exercise the lane's `externalSessionsService`, ADE action domain, and PTY/chat
import paths before merge.

Mobile is harder. The iOS app pairs to a single sync host. Two sync-enabled
brains conflict on the shared port, mDNS publication, and tunnel routing, so
the phone cannot casually point at an isolated lane brain while the normal host
is still serving. Real mobile E2E requires the feature to be present on the
host the phone actually pairs to, usually because the branch is merged, or
because a deliberately isolated-port sync host is running and the phone is
paired to that host.

When mobile appears to "not have" the feature, check the host first. An updated
iOS client cannot import sessions if the paired brain does not expose
`work.listExternalSessions` and `work.importExternalSession`.

## Known follow-ups / open items

- No feature flag gates external-session import. If the service is constructed
  and the UI is present, the feature is live.
- There are no TODO/FIXME markers in the current external-session service,
  chat importer, desktop import UI, iOS import screen, sync command path, or
  lane-scoped ADE action path.
- The Droid fork probe has a first-list conservative state: until `droid
  --help` resolves, Droid summaries report `fork: false` and
  `forkIntoDifferentCwd: false`. Refreshing after the probe resolves shows the
  actual capability. Fork import itself awaits the probe.
- Keep the shared DTOs, shared affordance mapper, iOS models/action policy, and sync command
  payloads in lockstep. A server-only change will break mobile decoding or
  hide buttons; a UI-only change will show actions the runtime rejects.
- Keep `agentChatService.ts`'s Claude transplant dependency static. Dynamic
  imports can pass desktop dev runs and still fail in the packaged/headless
  brain bundle.
