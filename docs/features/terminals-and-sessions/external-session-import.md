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
| `apps/desktop/src/main/services/externalSessions/discoverClaude.ts` | Discovers resumable Claude CLI JSONL transcripts under `CLAUDE_CONFIG_DIR` or `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`; reads `ai-title`/custom titles, excludes SDK-origin transcripts, and collapses continuation chains to their leaf. |
| `apps/desktop/src/main/services/externalSessions/discoverCodex.ts` | Discovers interactive Codex threads from `CODEX_HOME/state_5.sqlite` (default `~/.codex`): top-level threads only, fork continuations collapsed, enriched from the rollout JSONL under `sessions/YYYY/MM/DD/` and `session_index.jsonl`. Falls back to scanning rollout files when the thread store is unusable. |
| `apps/desktop/src/main/services/externalSessions/discoverCursor.ts` | Groups every Cursor artifact — `~/.cursor/chats/<workspace-md5>/<id>/store.db`, its `meta.json`, and `~/.cursor/projects/<slug>/agent-transcripts/` (including `empty-window`) — by the bare conversation uuid, keeps the fullest copy of each, resolves cwd from `meta.json` before the md5/slug reverse-mappings, and excludes SDK `agent-<uuid>` sessions. |
| `apps/desktop/src/main/services/externalSessions/discoverDroid.ts` | Discovers Factory Droid JSONL sessions under `~/.factory/sessions/<escaped-cwd>/`, one record per session id, using the `session_start` row for id/cwd/title. |
| `apps/desktop/src/main/services/externalSessions/discoverOpenCode.ts` | Discovers OpenCode sessions by running `opencode session list --pure --format json --max-count <N>` in the requested/project cwd. |
| `apps/desktop/src/main/services/externalSessions/importedSessionStore.ts` | Machine-local durable log of every import (`<ADE_HOME>/external-sessions/imported.json`), the only imported-marking source that survives deleting the ADE session and the only one that knows a fork's new provider id. |
| `apps/desktop/src/main/services/externalSessions/claudeLiveSessions.ts` | Reads Claude's own live-session registry (`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`) and returns the session ids whose pid is still alive, for `possiblyActive`. |
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
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionBrowser.tsx` | Desktop two-stage browser/details flow: provider filters, search (which spans the sampled `messages` text, not just titles), project/all scope, progressive scans, full details with a bounded scrollable message sample, target lane selection, imported/active badges, Open-in-ADE, and safe action dispatch. Asks for 200 rows per provider to match the service's project-scope discovery window; the default 50 threw away most of what was already scanned. A provider that fails its scan leaves a muted per-provider notice ("OpenCode CLI not found…") instead of an unexplained empty list, and only a total scan failure still becomes the blocking error state. The dialog height is content-driven rather than pinned, because the details stage is far shorter than the list stage. |
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
limit. Codex is the exception: it reads Codex's own thread store rather than the
rollout inventory (see "Codex thread store" below). The cheap JSONL read is bounded by
`JSONL_SCAN_BYTE_LIMIT` and `JSONL_SCAN_LINE_LIMIT`; meaningful user prompt
counts are only computed for files under `MESSAGE_COUNT_MAX_BYTES`.
Provider metadata, assistant/tool rows, local-command wrappers, and duplicate
Codex storage representations do not inflate `messageCount`. OpenCode is the
exception because its supported interface is the CLI list command, so discovery
runs `opencode session list --pure --format json --max-count <limit>` in the
requested cwd, project root, or home directory. The list schema does not expose
a preview or prompt count, and discovery deliberately avoids an expensive
per-session `opencode export` fan-out.

### Codex thread store

Codex maintains `CODEX_HOME/state_5.sqlite`, and that database — not the
`sessions/YYYY/MM/DD` rollout tree — is what ADE lists. It is strictly more
complete than the files: on a real 7.2k-thread store, 4.1k rollouts are spawned
subagents, and more than a third of them carry no parent id in their own
`session_meta`. Listing from files alone therefore showed thousands of subagent
runs as if they were conversations.

Discovery opens the database read-only, never takes a write lock, and selects
non-archived threads that are not a `thread_spawn_edges` child, newest first.
`id`, `cwd`, timestamps, and title/preview text come straight from `threads`,
which removes the per-file `session_meta` fan-out, the null-cwd project-scope
loss, and the file-count ceiling that project-scoped discovery used to need. The
thread id is the record identity everywhere, so a compressed `.jsonl.zst`
rollout and a plain one can no longer produce two rows for one conversation.
`rollout_path` can dangle (upstream `openai/codex#21196`); those threads still
list from their database metadata.

Two things the database does not answer are read from the rollout file, line 1
only, and only for threads that survive the cheap filters: the `originator`
(ADE's own Codex sessions are excluded from the import list) and
`forked_from_id`. Line 1 is the limit on purpose — a fork replays its parent's
transcript verbatim, so the parent's `session_meta` appears again further down.
When a fork exists and its parent recorded no activity after the fork point, the
parent is hidden: that pair is one conversation the user continued elsewhere. A
parent that kept going after being forked stays listed alongside its fork, and
only forks this surface would itself list can collapse a parent — ADE's own
chats fork Codex threads, and collapsing a real terminal session into a fork the
import list refuses to show would drop the conversation entirely.

Classification fails **open**. A structured (object-shaped) `source` is a
spawned subagent and is dropped, as are the known non-interactive `exec` and
`vscode` entrypoints; an unrecognized `source` string is listed and logged as
`external_sessions.codex_unknown_source`, because a new Codex entrypoint
silently vanishing from the import list is worse than one extra row.

When the database is missing, unreadable, or shaped differently than this build
expects, discovery logs `external_sessions.codex_state_db_unavailable` or
`external_sessions.codex_state_db_query_failed` and falls back to the older
rollout-file scan with its bounded candidate window. That fallback cannot see
spawn edges, so it lists subagent rollouts whose `session_meta` hides their
parentage — it is a compatibility path, not an equivalent one.

An **empty result is not by itself a reason to fall back.** Zero rows with
threads present is a real answer — everything was archived, spawned, or out of
scope — and falling back there would hand the list to a scan that cannot tell a
subagent rollout from a conversation. So an empty result triggers one extra
`SELECT 1 FROM threads LIMIT 1`, and only an actually empty table (a
freshly-migrated or truncated `state_5.sqlite`, which is no authority on what
exists) defers to the rollout tree.

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

- `alreadyImported` and `importedSessionRef` (see "Import marking" below).
- `possiblyActive`. For Claude this is the CLI's own live-session registry,
  `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`: an entry whose `pid` is still alive
  means the session is open right now, which is the question the badge is
  actually asking. Stale entries survive the process that wrote them, so
  liveness is checked, never assumed. Every other provider — and Claude when the
  registry directory does not exist — falls back to "backing file mtime within
  the last two minutes". The residual gap is pid reuse across a reboot; it costs
  one wrong badge, not a wrong import.
- `cwdMatchesRequestedLane`, comparing the provider cwd to the requested lane
  cwd when known.

### Import marking

Four sources feed one `provider:id` → ref map. Chat refs outrank CLI refs,
which outrank a bare "imported, nothing to open", so the UI can offer a single
"Open in ADE" action.

- **The durable import log**, `<ADE_HOME>/external-sessions/imported.json`
  (`importedSessionStore.ts`). Every import appends one record: provider,
  external id, the provider id ADE actually runs, chat/cli, continue/fork, ADE
  session id, timestamp. It is machine-scoped and a plain atomically-written
  JSON file with an `.lkg` fallback, deliberately **not** a cr-sqlite CRR table:
  it maps onto provider stores that are themselves machine-local, so a Claude
  transcript id means nothing on the paired machine.

  The desktop app and the headless brain can share one ADE home, and the atomic
  rename alone does not stop the later writer from clobbering a record the
  earlier one added between its own read and write. So each append takes a lock
  file for the span of one read-modify-write and re-reads inside it rather than
  trusting the cache. `record` is synchronous all the way up to the import call,
  so the wait has to block the main process — which is why `LOCK_WAIT_MS` is
  200 ms, and why failing to take the lock writes anyway instead of erroring: a
  lost race can drop one concurrent record, and that is a far better outcome
  than failing an import that already succeeded. A lock older than 5 s is
  treated as abandoned by a process that died holding it.
- ADE `terminal_sessions` resume metadata (`provider`/`targetId` and
  `importedFrom`).
- Claude session pointers from `sessionService.listClaudeSessionPointers`.
- The chat-imported refs provider (`session.importedFrom` over chat sessions).

The last three are all derived from live rows, which is why the durable log
exists. They lose the badge when the ADE session is deleted, and they never knew
the *new* provider id a fork import created — a Codex `thread/fork` thread or a
transplanted Claude transcript. Both ids are recorded, so the original keeps its
badge and the copy is recognizable. When the ADE session behind a record is
gone, the row still reports `alreadyImported: true` with a null
`importedSessionRef`: it was imported, there is just nothing left to open.

`listClaudeSessionPointers` used to clamp any request to 500 rows silently, so
imports past that point looked un-imported; the ceiling is now
`CLAUDE_SESSION_POINTER_MAX_LIMIT` (5000) and the default page stays 200.

**Lineage.** Discovery collapses Claude continuation chains to their leaf and
hides a Codex parent behind its fork, so the id a session was imported under is
often no longer the id it is listed under. Collapsing providers therefore set
`lineageIds` on the surviving record — the ids it supersedes — and marking
matches against `id ∪ lineageIds`. The field is optional; Cursor, Droid, and
OpenCode never collapse and never set it. It is discovery-internal and not part
of `ExternalSessionSummary`, so no DTO, sync payload, or iOS mirror changes.

**ADE-created artifacts are not new sessions.** A cross-cwd Claude fork writes a
transplanted copy into `~/.claude` under a fresh uuid, and a Codex chat fork
mints a new thread; both then re-list as fresh importable sessions. Rows whose
ids are all recorded fork *targets* are dropped from the list. "All", not "any":
when discovery collapses the user's original into the copy, that one row is also
the only place the original appears, so it stays listed and simply reads as
already imported. An exact `sessionId` lookup skips the filter entirely, the
same way Claude dedupe does, so a caller that names an ADE-created id still
resolves it.

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
continuation and `ade.pty.resumeSession` find the provider target again;
duplicate-import detection reads the durable log described under "Import
marking", because resume metadata dies with the session row.

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

`importExternalChatSession` returns `providerTargetId` alongside the chat
session: the Claude id actually adopted (transplanted or original) or the Codex
thread actually bound (fork or original). Without it the service could only
record the id the user picked, and a fork's own id would go unmarked. The field
is optional on the result type and never crosses the wire.

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
UI headings fall back to path/time.

Only `<projectSlug>/<uuid>.jsonl` is a session. Roughly nine in ten transcripts
on disk are sidecars nested under `<sessionId>/subagents/**`, including workflow
runs; discovery never descends into a project subdirectory, and non-uuid names
such as `agent-*.jsonl` are ignored.

SDK-origin transcripts — ADE's own Claude chats — are excluded because the CLI
cannot reliably resume them, but the test is the entrypoint the session *starts*
with, sampled over its head rows. Excluding on any single `sdk` row instead hid
whole CLI sessions the moment one SDK-driven turn landed in them.

A modern `claude --resume` appends in place, so one file normally spans every
resume. New files appear on `--fork-session`, on `/branch`, on a rewind, and on
`/cd`, which relocates the session into another project directory. Discovery
therefore dedupes continuation chains globally, across all project directories,
never per directory:

- The chain key is the uuid of the **first record that carries one**. The
  per-record camelCase `sessionId` is always rewritten to the filename, so it
  proves nothing about ancestry; snake-case `session_id` is a genuine ancestor
  pointer and is used as a second edge, but it is absent on SDK sessions.
  First-message **text** must never key a chain: ADE injects the same preamble
  into many chats, so identical openings are routine and unrelated. Finding that
  first uuid is a bounded walk, not a single small window — one transcript in
  seven opens with a pasted prompt big enough to push it past 64 KiB.
- Only pure continuations collapse — one file's records are a prefix of, or
  identical to, another's — and the leaf (longest, newest on a tie) is the row
  that survives. Members that diverge are real forks and both stay listed.
- The prefix test is bounded, never a full read of a multi-MB transcript: the
  longer file must still contain the shorter file's final record uuid near the
  shorter file's byte length, and record uuids sampled from windows at fractions
  of the shorter file must also appear in the longer file's windows at the same
  offsets. The tail check alone is not enough — a longer file can retain the
  final record while having dropped records in between. Copies rewrite
  `sessionId` with a same-length uuid, which is what keeps those byte offsets
  aligned closely enough to sample.
- An exact `sessionId` lookup skips dedupe entirely, so an ancestor the caller
  named by id still resolves.

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

**One conversation, up to four artifacts.** A single Cursor conversation can be
written to disk in several places at once, and the bare conversation uuid is the
only identity shared across all of them:

- `~/.cursor/chats/<md5(exact-process-cwd)>/<id>/store.db` — the bucket name is
  md5 of the *raw process cwd*, not the project root, so one project spawns a
  bucket per directory a session was ever launched from (repo root and
  `apps/desktop` are different buckets).
- A second bucket for the same id, when the conversation was resumed from another
  cwd. Resume does not mint a new id, so both buckets claim it — and the newer
  one is usually the near-empty stub. Size, not recency, says which holds the
  conversation.
- `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, sharing the id
  space with `chats/`.
- A duplicate of that transcript under `projects/empty-window/`. Either copy can
  be the partial one.

Discovery therefore groups by id first and picks the fullest artifact per group,
rather than treating each file as its own session; without that, duplicates
consume the caller's `limit` and the same conversation is listed more than once.

`meta.json` next to `store.db` records `cwd` directly for newer sessions and is
preferred over reverse-mapping the bucket md5 or the project slug — the hash is
only reversible for a cwd ADE can already name, so buckets for nested cwds were
previously invisible. `.workspace-trusted` and slug de-slugging remain the
fallback for older sessions. ADE reads the store's hex-encoded meta record for
name and creation time, includes store-only sessions, and treats the SQLite WAL
mtime as activity. Newer session headers can carry a `blobEncryptionKey`; an
unreadable body still leaves a resumable session, so `meta.json` supplies the
title in that case.

Scope is decided from directory names, `meta.json`, and `.workspace-trusted`
before the recent-session cut, so out-of-project usage cannot crowd in-project
conversations out of the list. Artifacts whose cwd nothing on disk can confirm
(`empty-window`, buckets for deleted directories) are read only after every
confirmed in-project match.

Two ids are never sessions: SDK-origin `agent-<uuid>` runs, because
`cursor-agent` cannot resume them as meaningful CLI sessions and would start
empty; and `00000000-0000-4000-8000-000000000000`, which Cursor hands to
unrelated runs, so grouping its artifacts would fuse strangers into one session.
The `subagents/` tree beside a transcript holds nested runs and is not walked, and
`~/.cursor/acp-sessions/` is not a CLI session store.

Cursor has no fork support and its resume is cwd-scoped. Cursor edit mode must
not map to `--mode ask`; `ask` is read-only. In `cliLaunch.ts`, only plan mode
maps to `--mode plan`, full-auto maps to `--force`, and edit/default omit a mode
flag.

### Droid

Droid stores sessions under `~/.factory/sessions/<escaped-cwd>/*.jsonl`. The
first row must be `session_start`; ADE reads id, cwd, and title there. Current
Droid rows can omit a start timestamp, so creation time falls back to the first
timestamped message. `"New Session"` is a placeholder title and becomes null.
The `<id>.settings.json` sidecar holds model/mode, and `sessions-index.json` is
rewritten whole on every change — treat it as a hint, never as truth; ADE does
not read either.

The same id can appear under more than one escaped cwd, so discovery keeps one
candidate per id and reads the fullest copy. Because the directory name *is* the
slash-escaped cwd, out-of-project directories are ruled out before the
recent-session cut; a directory name that is not an escaped absolute path can
only be placed by the session's own `session_start` cwd, so those are read after
every directory scope already confirmed.

`droid --fork` is gated on an installed-CLI probe. Discovery can temporarily
show fork disabled while the probe is pending; import awaits the probe and
fails with a clear message if the installed binary lacks `--fork`. Resume is
cwd-locked.

### OpenCode

OpenCode discovery uses `opencode session list --pure --format json`; ADE does not
walk OpenCode's private storage. Resume and fork commands use OpenCode's
`--session`, `--continue`, and `--fork` flags.

A missing `opencode` binary throws rather than returning `[]`. An empty array is
exactly what "no sessions yet" looks like, so the old behavior showed a machine
without OpenCode installed an empty list and no reason for it. The service
propagates that error to a caller that asked only for OpenCode — which is every
call the desktop browser makes, since it scans one provider per request — and
logs `external_sessions.discovery_failed` for a mixed-provider scan instead of
failing the whole list. Note that binary resolution also searches HOME-derived
CLI directories, so a test that wants "OpenCode is not installed" has to
redirect `HOME` as well as `PATH`. Sessions are per-project by cwd,
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
