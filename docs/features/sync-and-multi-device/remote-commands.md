# Remote Commands (`syncRemoteCommandService`)

Remote commands are the execution channel for controllers. A controller
(another desktop acting as a peer, or the iOS app) sends a `command`
envelope to the ADE brain; the brain's in-process services
resolves it through `syncRemoteCommandService`, runs the underlying
action against its in-process services, and replies with `command_ack`
and then `command_result`.

Source file: `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`
(~4,600 lines). The desktop tree's
`apps/desktop/src/main/services/sync/syncRemoteCommandService.ts` is a
one-line re-export of the canonical module.

Terminology note: **brain** is the always-on machine-owned ADE process.
Some wire and code identifiers also say `host` or `syncHost` because
those names predate the current glossary; they refer to the brain/sync
authority unless this document explicitly says otherwise.

## Shape

### Invocation

A controller sends:

```ts
{
  type: "command",
  version: 1,
  requestId: "uuid",
  payload: {
    commandId: "uuid",
    action: "lanes.create" | "chat.send" | ...,
    args: { ... }
  }
}
```

The brain responds in two envelopes:

```ts
// command_ack — receipt and preliminary disposition
{
  type: "command_ack",
  payload: {
    commandId: "uuid",
    accepted: boolean,
    status: "accepted" | "rejected",
    message: string | null
  }
}

// command_result — execution outcome
{
  type: "command_result",
  payload: {
    commandId: "uuid",
    ok: boolean,
    result?: unknown,
    error?: { code: string, message: string }
  }
}
```

### Per-action descriptor

Every action carries a `SyncRemoteCommandDescriptor` with both a
**scope** and a **policy**:

```ts
type SyncRemoteCommandDescriptor = {
  action: SyncRemoteCommandAction;
  scope: "runtime" | "project";
  policy: SyncRemoteCommandPolicy;
};

type SyncRemoteCommandPolicy = {
  viewerAllowed: boolean;       // can a read-only controller invoke?
  requiresApproval?: boolean;   // brain prompts operator before executing
  localOnly?: boolean;          // never sent over the wire; local-only
  queueable?: boolean;          // queue locally if offline, replay on reconnect
};
```

The scope label matters because the brain serves **multiple projects**
and one hidden personal-chat scope at once. `runtime`-scoped commands
(machine-wide diagnostics, personal chats, project catalog reads, settings,
and local connection metadata) run without a project binding. The retired iOS
**Pair a browser** sheet no longer calls `sync.getWebPairingInfo`; new hosted
web connections start from account sign-in and the account machine directory.
`project`-scoped
commands (everything that mutates lane / chat / PR state inside a
project) require the brain to have an active project AND the caller to
have bundled a matching `projectId` on the envelope. The brain enforces
this with explicit error codes:

- `code: missing_project` — the brain has a project open but the command did
  not include `projectId`. Re-select the project on the controller and
  retry.
- `code: project_not_open` — caller asked for a project the brain does
  not currently have open. Drive a `project_switch_request` first.

One more error code originates **outside** the registry:
`code: host_unavailable`. When a `command` envelope reaches the
brain-level ingress while **no project sync host owns the peer** (the
host is restarting, or was blocked by a conflicting sync listener),
`brainProjectActionsSyncHandler` answers immediately with a failed
`command_result` carrying that code instead of silently dropping the
command into a 30 s client timeout. The state is transient by
definition, so controllers treat it like a timeout: iOS marks it retryable
(`isSyncHostUnavailableError`), and queued operations are preserved — not
deleted — when a replay hits it during a host restart window. Queueable actions
normally enter the offline queue, but an already-attempted live `chat.send` is
the deliberate exception because its outcome is ambiguous; iOS restores the
draft for a manual transcript-aware retry instead of risking a duplicate turn.

Controllers read `SyncRemoteCommandDescriptor`s from the brain (via the
`getSupportedActions` / `getDescriptors` surface) and gate UI
accordingly — the brain's policy and scope are always authoritative.

Mobile compatibility is a separate product contract layered on top of those
descriptors. The required iOS action set lives in
`apps/desktop/src/shared/syncMobileCompatibility.ts`
(`MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS`); the brain evaluates the
actual registry against that list and advertises
`features.mobileCompatibility` in `hello_ok`. A missing action must produce
`mode: "limited"` and a `missingActions` list, not a rejected connection. iOS
then keeps the WebSocket alive, hides or blocks unsupported actions locally, and
surfaces update guidance. When adding, renaming, or removing a remote command
that ADE Mobile uses, update the shared compatibility list and iOS tests in the
same change.

The same file also holds `MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS`: additive
commands that newer phones may feature-detect from
`hello_ok.features.commandRouting.actions` but that must **not** join the
required set, because older mobile builds never call them. The four Linear
connection commands (`cto.startLinearMobileOAuth`,
`cto.completeLinearMobileOAuth`, `cto.setLinearToken`, `cto.clearLinearToken`)
live here: a brain that predates them omits them from its advertised actions, so
the phone leaves Linear connect/reconnect/disconnect hidden (falling back to the
API-key path or an "update ADE on your Mac" hint) rather than treating their
absence as a broken connection. Their omission never flips a host to `limited`.

The session-lifecycle commands sit in the same optional list:
`session.settleSessions`, `session.unsettleSessions`,
`session.setSettleOverride`, `session.snoozeSession`, `session.wakeSession`, and
`session.clearWokeMarker`. The phone gates its settle and snooze affordances on
these appearing in `hello_ok.features.commandRouting.actions`, so a current
brain **must** advertise them — but they must stay out of the required set,
because a shipped mobile build that predates the feature would otherwise be
flipped into `limited` mode against a newer host it works with perfectly well.

## Registry

Commands are registered by calling `register(action, policy, handler,
scope = "project")` inside `createSyncRemoteCommandService`. The
registry is a `Map<SyncRemoteCommandAction, RegisteredRemoteCommand>`
built at service construction. Handlers receive parsed-and-validated
args and either return a result or throw; thrown errors are wrapped
into the `command_result.error` envelope. The default scope is
`"project"` because most actions need an open project to make sense;
runtime-scoped registrations are explicit.

### Action categories

Listed in order of appearance in the registry. The hosted browser web
client (`../web-client/README.md`) is a controller of this same registry,
so read-heavy Work/chat/git/PR/history surfaces plus whole families
(`terminal.*`, `rebase.*`, `history.*`, `github.*`, `projectConfig.*`,
`ai.*`, `usage.*`, `orchestration.*`) exist to back the desktop renderer's namespaces
over the wire. A controller only invokes an action the host advertises in
`hello_ok.features.commandRouting.actions`.

**Usage** (`usage.*`)
- `getAdeStats` — viewer-allowed project read for today, 7d, 30d, year,
  or all time. Returns the same stale-while-revalidate aggregate used by
  desktop Stats: provider tokens, project-DB activity, daily points, and
  `desktop` / `mobile` / `tui` / `web` / `api` client attribution. It does
  not replicate or return raw `usage_events` rows.
- `getQuotaSnapshot` — viewer-allowed project read of the runtime's cached
  Claude/Codex quota snapshot. It returns provider windows plus source,
  freshness, retry, and stale/error state without starting provider or ledger
  work.
- `refreshQuota` — viewer-allowed project refresh of Claude/Codex quota only.
  The host disables interactive auth for this remote path, so it never opens a
  Keychain prompt or a bare CLI/TUI login flow on behalf of the controller.
  Local history scanners remain behind the separate desktop/CLI Activity path.

**Lanes** (`lanes.*`)
- `list`, `listDeleteProgress`, `refreshSnapshots`, `getDetail`,
  `listUnregisteredWorktrees`
- `create`, `createChild`, `createFromUnstaged`, `importBranch`,
  `attach`, `adoptAttached`
- `rename`, `reparent`, `updateAppearance`
- `archive`, `unarchive`, `delete`
- `getStackChain`, `getChildren`
- `rebaseStart`, `rebasePush`, `rebaseRollback`, `rebaseAbort`
- `listRebaseSuggestions`, `dismissRebaseSuggestion`,
  `deferRebaseSuggestion`
- `listAutoRebaseStatuses`
- `listTemplates`, `getDefaultTemplate`
- `initEnv`, `getEnvStatus`, `applyTemplate`
- `getBranchDrift`, `resolveBranchDrift` — detection and resolution for a
  lane worktree whose live HEAD has wandered off the lane's recorded
  `branch_ref`
- `presence.announce`, `presence.release` — controller marks a lane
  as currently open / no longer open; the brain decorates
  `LaneSummary.devicesOpen` with a 60 s TTL and fans out updates via
  the brain-status broadcast (`brain_status`).

`lanes.reparent` accepts `{ laneId, newParentLaneId,
stackBaseBranchRef? }`. The optional base ref is trimmed before
dispatch; when present, the brain resolves it in the project repo
preferring `origin/<branch>`, persists it as the lane's `base_ref`,
and rebases the lane onto that resolved branch. When omitted, the brain
uses the selected parent lane's current branch.

`lanes.refreshSnapshots` accepts lightweight-decoration flags:
`includeConflictStatus`, `includeRebaseSuggestions`, and
`includeAutoRebaseStatus`. Mobile list refreshes set these to `false`
when they only need runtime/session bucket updates, avoiding extra git
and rebase-status work on routine refreshes. `lanes.getDetail` reads the
requested lane through the scoped lane-summary path and then fetches the
detail overlays for that lane, instead of forcing a full lane list as a
side effect of opening a detail screen.

`lanes.getDetail` and `lanes.refreshSnapshots` are **conditional
responses**. Both compute their full payload, then hash it
(`sha256(JSON.stringify(response))`) into a `signature` field. A caller
that already holds a payload can send its cached `ifNoneMatch`
signature; when it equals the freshly computed one the runtime replies
with a lightweight `{ signature, notModified: true }` shell carrying no
payload body, so the phone skips both the transport of an unchanged
lane detail / snapshot set and the client-side re-decode. A mismatched
or absent `ifNoneMatch` returns the full payload with
`notModified: false` and the current `signature` to cache. The full
payload is still computed either way (the signature derives from it),
so the win is transport and decode, not host compute.

**Work** (`work.*`)
- `listSessions`, `getSession`, `getSessionDelta`, `deleteSession`,
  `updateSessionMeta`, `runQuickCommand`,
  `startCliSession`, `sendToSession`, `stopRuntime`

**Session lifecycle** (`session.*`)
- `settleSession`, `unsettleSession`, `settleSessions`, `unsettleSessions`
- `snoozeSession`, `snoozeSessions`, `wakeSession`, `wakeSessions`
- `setSettleOverride`, `clearWokeMarker`

All ten are `viewerAllowed` and `queueable`. This is deliberately its own
namespace — matching the ADE action registry's domain name — rather than a
corner of `work.*`, because mobile and the hosted web client feature-detect it
independently of the `work.*` read surface. It is also the **only** path to
session lifecycle for those two controllers: neither has a local database, so
unlike desktop and `ade code` they cannot write a settle or a snooze locally and
let replication carry it. Session lifecycle is therefore reachable on all six
surfaces (desktop, iOS, the `ade code` TUI, hosted web, the `ade` CLI, and CTO
tools) — it is not a desktop-only capability.

`session.settleSession` routes through the shared `settleTerminalSession`
transaction, so `dismissPendingInput` behaves identically to desktop.

Snooze deadlines arrive from clients with no local clock authority, so the
registry validates them rather than trusting them: `parseRemoteSnoozeDeadline`
accepts either `untilIso` or `snoozedUntil` and validates the instant,
`parseRemoteWakeReason` validates against `SESSION_WAKE_REASONS`, and
`parseRemoteSettleOverride` delegates to the shared
`parseSessionSettleOverride` in `apps/desktop/src/shared/types/sessions.ts` so
`"clear"` / `"none"` / `""` / null all clear the override and garbage throws
instead of silently clearing it. The string sentinels exist because a client
that cannot encode a JSON null (iOS) must still be able to express "clear".

**Chat** (`chat.*`)
- `listSessions`, `getSummary`, `getTranscript`
- `createScheduledWork`, `cancelScheduledWork`, `setScheduledWorkPaused`
- `launch`, `getSlashCommands`, `resolveSmartLinkPreview`, `getContextUsage`, `warmupModel`,
  `getParallelLaunchState`, `setParallelLaunchState`, `handoff`,
  `prepareCrossMachineHandoff`, `validateCrossMachineSource`,
  `preflightCrossMachineDestination`,
  `fastForwardCrossMachineHandoffLane`, `acceptCrossMachineHandoff`,
  `markCrossMachineHandoff`,
  `rewindFiles`, `getTurnFileDiff`, `saveTempAttachment`, `getImageDataUrl`

`chat.getTranscript` supports cursor pagination: responses carry an
opaque `nextCursor`, and requests can pass `cursor` to page strictly-older
history. Full agent runtimes advertise `cursorKind: "byte"` and use an
append-stable logical JSONL offset, so serving a page never requires parsing the
whole transcript. The minimal non-agent headless fallback advertises
`cursorKind: "index"` over its bounded in-memory transcript. Clients must keep
the cursor opaque and use `cursorKind` only to select their local merge
strategy.
- `create`, `send`, `interrupt`, `interruptWithQueueMode`,
  `restoreCancelledQueue`, `steer`, `cancelSteer`, `editSteer`,
  `dispatchSteer`, `cancelDispatchedSteer`, `approve`, `respondToInput`
- `recoverTurn`, legacy `recoverCodexTurn`, `resolveUnprocessedMessage`
- `restart`, `updateSession`, `archive`, `unarchive`, `delete`, `models`,
  `modelCatalog`

`chat.recoverTurn` is the provider-neutral stall-recovery action. It takes
`{ sessionId, turnId, action }`, where `action` is `wait`, `nudge`,
`retry_same_runtime`, or `restart_resume`. It is viewer-allowed and
non-queueable: recovery must be applied to the currently active turn, never
replayed after reconnect. Older hosts may advertise only
`chat.recoverCodexTurn`; clients map the same four controls to its legacy
action names without rendering duplicate recovery cards.

`chat.resolveUnprocessedMessage` takes
`{ sessionId, steerId, action: "run_next" | "dismiss" }`. It is also
viewer-allowed and non-queueable. The runtime persists a terminal
`user_message_resolution` receipt and makes both actions idempotent across
client retries and runtime restarts. `run_next` is accepted only while the
session is idle and commits only after the replacement turn is dispatched;
`dismiss` never sends a turn.

`chat.resolveSmartLinkPreview` is a viewer-allowed, non-mutating enrichment
read. Its `{ url }` payload returns the shared deterministic provider/kind/label
shape and may add a title or bounded favicon data URL. GitHub and Linear titles
use the runtime's configured integrations; generic HTTP(S) metadata is fetched
only by the runtime's SSRF-hardened preview service. Unsupported, unreachable,
local/private, oversized, or non-HTML URLs fall back to the deterministic
preview instead of failing the composer. The canonical URL is never replaced by
the title.

`chat.createScheduledWork` takes `{ sessionId, cron, prompt, recurring?,
reason? }` and creates an ADE-owned durable schedule for any provider-backed
chat. `recurring` defaults to true; false creates a one-shot at the next
five-field cron match. `chat.setScheduledWorkPaused` takes `{ sessionId,
paused }`, and `chat.cancelScheduledWork` takes `{ sessionId, scheduleId }`.
Create is owner-only (`viewerAllowed: false`), so paired controller devices can
discover the capability but cannot invoke it. Pause, resume, and cancel are
viewer-allowed recovery controls. All three are deliberately
non-queueable so an offline replay cannot create a duplicate schedule or apply
stale management state. Controllers expose each control only when the brain's
descriptor list advertises it.

`chat.modelCatalog` accepts `{ mode?, refreshProvider?, cursorSource? }`
where `mode` is `"cached" | "refresh-stale" | "force"` (default
`"cached"`) and `refreshProvider` is `"opencode" | "cursor" | "droid" |
"lmstudio" | "ollama"`. `cursorSource` (`"sdk" | "cli" | "all"`, default
`"all"`) scopes which Cursor discovery source the host probes
synchronously — chat-style surfaces pass `"sdk"` so the refresh stays off
the slower `cursor-agent` CLI spawn while the CLI flavor revalidates in
the background. The brain returns the full provider-grouped catalog used
by the desktop and TUI ModelPickers and the iOS Work model sheet; only
explicit `force` / `refresh-stale` calls trigger a runtime probe.

`chat.dispatchSteer` (Claude SDK only) takes
`{ sessionId, steerId, mode: "inline" | "interrupt" }` and pushes the staged
message through Claude's live input stream with `priority: "next" | "now"`
and `shouldQuery: true`; it returns `{ ok, dispatchedAt }`. Interrupt mode
redirects the current model request without closing the query or stopping its
background work. The queued row is removed only after the input pump accepts
the message.
`chat.cancelDispatchedSteer` returns `{ ok, cancelled }`; the current public
SDK cannot cancel an already pushed priority message, so `cancelled` is false.
The iOS companion uses
both via `SyncService.dispatchChatSteer` /
`cancelDispatchedChatSteer`.

`chat.cancelSteer` accepts optional `requireQueued: true`. That guarded form
rejects if delivery already claimed the message instead of merely clearing a
stale client row; desktop Edit uses it before restoring queued text and
attachments to the composer. The field is optional so older clients retain the
original idempotent cancel behavior.

`chat.interruptWithQueueMode` is an additive capability probe for queue-aware
Claude Stop. It takes
`{ sessionId, mode: "stop_and_clear" | "stop_only" }` and returns
`{ mode, cancelledQueuedCount, recoveryId?, recoveryExpiresAt? }`.
`stop_and_clear` is the backward-compatible default; it asks a capable Claude
runtime to interrupt with `cancel_queued: true`, then falls back to
per-message cancellation where needed. `stop_only` interrupts the model turn
and preserves queued messages. A controller that does not see this additive
descriptor must call legacy `chat.interrupt` without assuming the host honors
the mode. `chat.restoreCancelledQueue` takes `{ sessionId, recoveryId }`,
returns `{ restored, restoredCount }`, and is accepted only during the
eight-second recovery window for that same session. Both actions are
viewer-allowed and non-queueable: replaying either after reconnect could stop a
different turn or resurrect stale input.

**Personal chat** (`personalChats.*`)
- `list`, `create`, `getSummary`, `read`, `send`
- `steer`, `cancelSteer`, `editSteer`, `dispatchSteer`,
  `cancelDispatchedSteer`, `interrupt`, `interruptWithQueueMode`,
  `restoreCancelledQueue`, `respondToInput`, `approve`
- `createScheduledWork`, `cancelScheduledWork`, `setScheduledWorkPaused`
- `updateSession`, `archive`, `unarchive`, `delete`
- `models`, `modelCatalog`, `getEventHistory`, `getEventHistoryPage`
- `terminalCreate`, `terminalWrite`, `terminalResize`, `terminalDispose`
- `saveTempAttachment`, `getImageDataUrl`, `streamEvents`

All personal actions are `scope: "runtime"` and dispatch to the injected
`PersonalChatScope`, never to the active project's `agentChatService`. Only
`send` is queueable. `create` is live-only because replaying a queued create
cannot return a stable session id and may duplicate the conversation. Every
session-bound action revalidates `surface: "personal"`; terminal and attachment
actions additionally enforce scope ownership/path confinement.
Scheduled-work mutations are live-only too. They reuse the project chat
argument/result contracts after personal-scope validation, which lets iOS map
its shared Chat Info Cancel and Pause/Resume controls to `personalChats.*`
without an active project.

**Git** (`git.*`)
- `getChanges`, `getFile`, `getFilePatch`, `getUserIdentity`
- `stageFile`, `stageAll`, `unstageFile`, `unstageAll`,
  `discardFile`, `restoreStagedFile`
- `commit`, `generateCommitMessage`, `listRecentCommits`,
  `listCommitFiles`, `getCommitMessage`, `getFileHistory`
- `revertCommit`, `cherryPickCommit`, `createTag`, `resetToCommit`
- `isCommitInLaneHistory` — checks whether a given `commitSha` is
  reachable from the lane's current HEAD; used by controllers before
  surfacing destructive operations on commits that may belong to a
  different branch
- `stashPush`, `stashList`, `stashApply`, `stashPop`, `stashDrop`,
  `stashClear`
- `fetch`, `pull`, `sync`, `push`, `getSyncStatus`
- `undoLastHeadChange`, `redoLastHeadChange` — paired recovery
  actions that re-read HEAD before acting and refuse when the lane
  has moved since the operation they target
- `getConflictState`, `rebaseContinue`, `rebaseAbort`,
  `mergeContinue`, `mergeAbort` — the merge variants mirror the rebase
  pair so the iOS lane conflict banner can continue or abort an
  in-progress merge, not just a rebase
- `listBranches`, `checkoutBranch`

`git.pull` accepts an optional `mode` argument
(`"ff-only" | "rebase" | "merge"`, default `ff-only`) so controllers
can pick the strategy without having to send three separate actions.
Unknown mode values are rejected with a clear error.
`git.resetToCommit` takes `{ laneId, commitSha, mode }` where `mode`
is one of `soft | mixed | hard`; ADE records the operation as
`git_reset_<mode>` so undo/redo lookups can pair it up later.
`git.createTag` takes `{ laneId, commitSha, tagName, message? }`;
omitting `message` creates a lightweight tag.
`git.isCommitInLaneHistory` takes `{ laneId, commitSha }` and returns
a boolean.

**Files**
- `files.writeTextAtomic`

**Terminal** (`terminal.*`)
- `list`, `activeForChat` — session-list and per-chat active-terminal
  reads that back the web/mobile terminal surfaces (the live IO itself
  still rides the `terminal_*` sub-protocol, not command routing).

**Conflicts** (`conflicts.*`)
- `getLaneStatus`, `listOverlaps`, `getBatchAssessment`

**Rebase** (`rebase.*`)
- `scanNeeds`, `execute`

**History** (`history.*`)
- `listOperations` — the undo/redo operations log.

**GitHub** (`github.*`)
- `getStatus`, `getRemoteStatus`, `publishCurrentProject`

**Project config** (`projectConfig.*`)
- `get`, `save`

**AI** (`ai.*`)
- `getStatus` — provider/auth status for the settings surfaces.

**Orchestration** (`orchestration.*`)
- `runCreate`

**PRs** (`prs.*`)
- `list`, `listOpenForRepo`, `refresh`, `getDetail`, `getStatus`
- `getChecks`, `getReviews`, `getComments`, `getFiles`
- `postReviewComment`, `getAiSummary`, `regenerateAiSummary`, `delete`,
  `cleanupBranch`
- `getIntegrationResolutionState`, `aiResolutionGetSession`,
  `aiResolutionStart`
- `listProposals`, `getMergeContext`, `getMergeContexts`,
  `listWithConflicts`, `listSnapshots`
- `createFromLane`, `draftDescription`, `land`,
  `close`, `reopen`, `requestReviewers`, `rerunChecks`, `addComment`
- `simulateIntegration`, `commitIntegration`,
  `listIntegrationWorkflows`, `updateIntegrationProposal`,
  `deleteIntegrationProposal`, `startIntegrationResolution`,
  `recheckIntegrationStep`
- `getMobileSnapshot` — aggregate read that returns
  `PrMobileSnapshot` (summaries, stacks, per-PR capabilities,
  create-PR eligibility, workflow cards). Consumed by the iOS PRs
  tab; see `ios-companion.md` for the shape.

**CTO** (`cto.*`)
- `ensureSession`, `getState`, `updateIdentity` — resolve the single CTO
  chat session and read/patch its identity.
- `getMemory` — return the CTO's memory snapshot (durable `MEMORY.md`,
  rolling thread state, and today's daily log) for the phone's Memory card.
- `getLinearConnectionStatus`, `getLinearQuickView`,
  `getLinearIssuePickerData`, `searchLinearIssues`, `getLinearIssueComments`
  — the Linear read surface. The former worker-management commands
  (`removeAgent`, `setAgentStatus`, `triggerAgentWakeup`,
  `rollbackAgentRevision`) were removed with the worker subsystem.
- `startLinearMobileOAuth`, `completeLinearMobileOAuth`, `setLinearToken`,
  `clearLinearToken` — the Linear **connection-management** surface the iOS
  Linear pane uses to connect, reconnect, and disconnect a workspace from the
  phone. `startLinearMobileOAuth` mints a desktop PKCE session for the
  worker-bounce OAuth flow (redirect through the `ade-github-webhook-relay`
  worker back to `ade://linear-oauth`); `completeLinearMobileOAuth` hands the
  captured `code`/`state` back for the desktop-side token exchange;
  `setLinearToken` stores a pasted API key; `clearLinearToken` disconnects. All
  four are `viewerAllowed` and are **optional** mobile capabilities (see the
  compatibility note above) — older brains omit them, and iOS gates the connect
  UI on the advertised action set. See
  [Linear integration](../linear-integration/README.md#connecting-and-managing-from-mobile).

The canonical list is typed as `SyncRemoteCommandAction` in
`apps/desktop/src/shared/types/sync.ts`.

## Argument parsing

Each action has a dedicated parse function (e.g. `parseCreateLaneArgs`,
`parseAgentChatSendArgs`, `parseCreatePrArgs`) that:

1. Accepts `Record<string, unknown>`.
2. Validates required fields with `requireString` / `requireStringArray` /
   `requireService`.
3. Coerces optional fields through `asTrimmedString`, `asOptionalNumber`,
   `asOptionalBoolean`, `asStringArray`.
4. Returns the typed args object expected by the brain's in-process service.

Helpers (`asTrimmedString`, `asStringArray`, `requireString`, etc.) live
at the top of the file. A non-conforming args object causes the parser
to throw an explicit error like `"lanes.create requires name."`; that
error reaches the controller as `command_result.error.message`.

Cross-machine handoff has dedicated parsers for all five actions. The service
then performs the deeper version, bounds, secret-redaction, Git identity, and
SHA-256 fingerprint validation on the capsule before any destination resource
is created; the parser is not the capsule trust boundary.

## Handler bodies

Handlers are thin glue onto the brain's in-process services. Most look like:

```ts
register("lanes.archive",
  { viewerAllowed: true, queueable: true },
  async (payload) => {
    await args.laneService.archive(parseArchiveLaneArgs(payload, "lanes.archive"));
    return { ok: true };
  });
```

A handful have more logic:

- **`lanes.create`** — when the caller omits `baseBranch`, `startPoint`,
  **and** `parentLaneId` (the mobile hub composer's auto-create and the
  iOS create sheet's default), the handler resolves a **remote-first
  default base** before delegating to `laneService.create`. It reads the
  project's `git.newLaneBaseSource` config (effective default
  `"remote"`; `"local"` short-circuits), then calls
  `resolveDefaultRemoteLaneBase` from
  `apps/desktop/src/shared/defaultRemoteLaneBase.ts` — a bounded remote
  fetch (4 s timeout so a slow remote never stalls creation) followed by
  mapping the primary lane's base branch to its remote-tracking ref
  (upstream first, then `origin/<base>`). Any failure or missing remote
  ref resolves to null and creation proceeds with the legacy local
  default. This matches the desktop create-lane dialog, which resolves
  the same remote-first default renderer-side, so a lane created from a
  phone no longer silently branches from a stale local primary tip.

- **`work.runQuickCommand`** — constructs a `PtyCreateArgs`, calls
  `ptyService.create`, and returns the PTY handle for the controller
  to subscribe to via `terminal_subscribe`.
- **`work.startCliSession`** — runtime-side mobile CLI launcher used by
  the iOS Work "new session" surface. Args are validated through
  `parseStartCliSessionArgs`,
  which restricts `provider` to the allowlist
  `claude | codex | cursor | droid | opencode | shell` (any other
  value throws `"work.startCliSession requires provider."`), clamps
  `cols` to `[20, 240]` and `rows` to `[4, 120]`, and truncates
  `initialInput` at 20 KB. `model` / `modelId`, `reasoningEffort`,
  and `fastMode` flow into the same launch builder as desktop; the
  older `codexFastMode` wire name is accepted only as a compatibility
  alias. Provider-specific argv, env, and shell
  preambles come from `buildTrackedCliLaunchCommand` in
  `apps/desktop/src/shared/cliLaunch.ts`
  — the same module the desktop Work tab uses — so the runtime owns the
  startup-command shape and a phone cannot smuggle in a free-form
  shell command (the `shell` provider takes no startup payload at all).
  For Codex on macOS, the runtime resolves the explicitly opted-in and
  OpenAI-signature-verified standalone Computer Use client at launch time and
  adds only the canonical `mcp_servers.computer_use` config overrides; a
  missing/disabled/unverified client adds nothing.
  The runtime resolves the requested lane worktree before building that
  launch payload, so ADE guidance and `ADE_AGENT_SKILLS_DIRS` prefer
  lane-local `.claude` / `.agents` / `.ade` / `.codex` skill dirs and
  bundled ADE resources instead of whichever project root the daemon
  process happened to start from.
  Claude launches mint a pre-assigned `--session-id` upfront via
  `randomUUID()` so continuation works as soon as the row exists.
  When `initialInput` is present, it is passed to `ptyService.create`
  as `args.initialInput` with an `initialInputDelayMs` (default
  750 ms for CLI launches) so the agent CLI input protocol handles
  bracketed-paste submission after the TUI has had time to initialize.
  This replaces the older pattern of post-create `writeBySessionId`
  keystrokes.
  The result is `SyncStartCliSessionResult` (`{ sessionId, ptyId,
  session: TerminalSessionSummary | null }`) — the controller can
  immediately render the session card and call `terminal_subscribe`
  without an extra round-trip. The command-result journal persists
  only the returned session handle and summary, not the `initialInput`
  text, so reconnect replay does not leak the user's prompt into the
  runtime-side ledger.
- **`work.listExternalSessions` / `work.importExternalSession`** — list and
  import provider-native Claude, Codex, Cursor, Droid, and OpenCode CLI
  sessions through the runtime's external-session service. Import forwards the
  full service result: CLI results carry the new `sessionId` / `ptyId` plus a
  persisted `TerminalSessionSummary` when available; chat results carry the
  new `chatSessionId` plus the required persisted `AgentChatSessionSummary`.
  Controllers use those summaries for immediate navigation rather than waiting
  for the next sync/session-list refresh. Provider storage, cwd validation, and
  process launch remain host-side; see
  [External Session Import](../terminals-and-sessions/external-session-import.md).
- **`work.sendToSession`** — sends text to an existing durable Work
  CLI session. If the PTY is live, the runtime writes into it; if the
  process ended and the session is resumable, the runtime starts the
  provider continuation internally and attaches the runtime to the
  same session id.
- **`work.stopRuntime`** — looks up the session's PTY id and disposes
  the PTY without deleting the durable session row or transcript.
- **`chat.create`** — resolves a missing `model` to the first
  available provider model via `agentChatService.getAvailableModels`
  before forwarding.
- **`chat.recoverCodexTurn`** — validates one of `wait`, `steer`,
  `interrupt_retry_same_thread`, or `restart_resume_thread` and forwards to
  the chat service. It is viewer-allowed but deliberately non-queueable: the
  session/turn pair must still be the active stalled turn when handled.
- **`lanes.suggestName`** — background lane naming for the mobile
  auto-create flow (desktop parity with
  `agentChatService.generateAutoLaneIdentity`). Takes `{ prompt,
  modelId, laneId, fallbackName?, temporaryBranch?, attachments? }`, makes one
  structured naming request for a readable lane title and a Git-safe branch
  fragment, applies each identity independently on the host, and returns
  `{ name, hostApplied }`. Image attachments reuse the existing bounded chat
  attachment references as naming context; non-image attachments contribute
  metadata only. The handler is deliberately **not queueable**
  so an offline phone fails fast and the client uses its own
  deterministic fallback instead of receiving a stale queued suggestion.
  Naming honors the host `titleGenerationEnabled` setting. A configured naming
  model wins; otherwise the launched model is tried first, then an authenticated
  same-provider model where possible. Naming uses low/minimal reasoning rather
  than inheriting the coding turn's reasoning level. iOS allows 45 seconds per
  non-disconnecting request and at most one retry for plausibly transient
  failures. Disabled naming, missing authentication, unsupported capability,
  invalid structured output, and branch-safety rejection are not retried.
  Missing services, invalid output, timeout, or provider failure retain
  independently derived deterministic lane and branch values, so naming can
  never block or fail lane creation. Structured logs carry the lane, temporary
  branch, selected model, source, attempt count, mutation outcomes, and
  skip/failure reason. The iOS callers
  (`WorkNewChatScreen` and the hub composer) create the lane instantly
  with the deterministic title on an exact `ade/<8 lowercase hex>` temporary
  branch, then call `SyncService.suggestLaneName` fire-and-forget after the
  session launch. When `hostApplied` is true they refresh lane state instead of
  issuing a second rename; legacy hosts still return a title that mobile applies
  through `lanes.rename`. A manual lane or branch change made while naming is in
  flight wins, and any throw keeps the deterministic identity.
- **`lanes.initEnv` / `lanes.applyTemplate`** — resolves the lane's
  overlay context (`resolveLaneOverlayContext`), merges overrides with
  the template's env init config, and invokes
  `laneEnvironmentService.initLaneEnvironment`.
- **`lanes.list`** — delegates to `laneService.list` then runs
  `buildLaneListSnapshots` to produce the richer payload the iOS
  Lanes tab consumes (runtime bucket summaries, rebase suggestions,
  auto-rebase statuses, batch assessment).
- **`prs.refresh`** — delegates to `prService.refresh`, then
  re-lists PRs and returns both the PR list and the snapshots in a
  single response.
- **`prs.getMobileSnapshot`** — calls `prService.getMobileSnapshot`,
  which builds stack chains from `laneService.list`, classifies each
  PR's action capabilities, resolves per-lane create-PR eligibility
  (using `resolveStableLaneBaseBranch`), and collects queue /
  integration / rebase workflow cards from the DB and
  `conflictService.scanRebaseNeeds()` (the same source the desktop
  Rebase tab consumes).
- **`lanes.dismissRebaseSuggestion` / `lanes.deferRebaseSuggestion`** —
  dual-write the lane state. The handler calls
  `conflictService.dismissRebase(laneId)` /
  `conflictService.deferRebase(laneId, until)` first so the next
  `prs.getMobileSnapshot` rebuild reflects the action immediately,
  then forwards to `rebaseSuggestionService.dismiss/defer` for the
  legacy desktop banner. `defer` clamps the requested minutes to
  `[5, 7 days]` before computing the absolute `until` ISO string.
- **`lanes.presence.announce` / `lanes.presence.release`** — handled
  in `syncHostService` directly (not in the remote command registry);
  the brain upserts a per-lane `DeviceMarker` map and
  decorates outgoing `LaneSummary` payloads with `devicesOpen`.

### Lane response decoration

`syncHostService` wraps command results for `lanes.list`,
`lanes.getDetail`, `lanes.refreshSnapshots`, `lanes.getChildren`,
`lanes.create`, `lanes.createChild`, `lanes.createFromUnstaged`,
`lanes.importBranch`, `lanes.attach`, and `lanes.adoptAttached` to
inject `LaneSummary.devicesOpen` from the presence map. Controllers
therefore see up-to-date presence without a separate query.

## Service dependencies

`createSyncRemoteCommandService` takes a long list of optional runtime
services:

```ts
{
  laneService,         // always required
  prService,           // always required
  ptyService,          // always required
  sessionService,      // always required
  fileService,         // always required
  gitService?,
  diffService?,
  conflictService?,
  agentChatService?,
  githubService?,
  projectConfigService?,
  portAllocationService?,
  laneEnvironmentService?,
  laneTemplateService?,
  rebaseSuggestionService?,
  autoRebaseService?,
  usageTrackingService?,
  logger,
}
```

Optional services that are missing cause their dependent actions to
throw `"<service> not available."` at call time. The `requireService`
helper centralises that check. This pattern lets a narrower runtime
construct only the services it can actually back without crashing at
command registration — useful for headless/manual runtime setups that, for
example, intentionally skip the chat service.

## Supported-action discovery

The service exposes:

```ts
getSupportedActions(): SyncRemoteCommandAction[];
getDescriptors(): SyncRemoteCommandDescriptor[];
getPolicy(action: string): SyncRemoteCommandPolicy | null;
execute(payload: SyncCommandPayload): Promise<unknown>;
```

Controllers typically read descriptors at connection time, cache
them, and refresh on brain-status broadcasts (`brain_status`). The iOS Lanes /
Files / Work / PRs tabs use this to render action buttons only for
commands the current runtime supports under the current policy.

## Logging

Every execution logs `sync.remote_command.execute` at `debug` level
with the `action` and `policy`. Failed executions log at `warn` / `error`
from the underlying service. No args are logged by default — most
payloads are mundane, but chat `text` fields and file `relPath` values
can be sensitive.

## Integration with other sync surfaces

- **Changeset sync** remains the channel for state reads. A
  controller observes the effect of a command through replicated
  `lanes`, `sessions`, `linear_workflow_runs`, etc. rows arriving
  after the runtime finishes the command.
- **Terminal sub-protocol** pairs with `work.runQuickCommand`,
  `work.startCliSession`, `work.sendToSession`, and `work.stopRuntime`. The controller
  invokes the command, then sends `terminal_subscribe` with the
  returned session id to stream output and enable input/resize control.
- **Chat sub-protocol** pairs with `chat.create` / `chat.send` +
  `chat_subscribe`. Same pattern: create / send the message through
  a command, subscribe to the transcript stream for incremental
  events. `chat.send` waits for the runtime-side dispatch acknowledgement
  before returning `ok`, so the phone does not clear its local echo
  while the desktop is still preparing the turn. The handler passes
  `routeActiveToSteer: true` into `agentChatService.sendMessage`, so a send
  that lands while a turn is already active is converted into a steer
  instead of racing the live turn; when that happens the ack carries the
  steer's `{ steerId, queued, reason?: "queue_full" }` alongside `ok: true`
  (a plain new-turn send still returns just `{ ok: true }`; a steer queue
  already at its cap comes back `queued: false, reason: "queue_full"`). The extra fields are additive — older
  clients ignore them, and the phone uses them to reconcile the message it
  echoed optimistically. If a live send times out or loses transport before the
  acknowledgement arrives, the phone treats delivery as ambiguous: it does not
  enqueue an automatic replay, restores the draft, and leaves transcript
  reconciliation to show whether the host started the turn. Personal chat uses the same
  envelopes but sends `chatScope: "personal"`; that explicit discriminator
  resolves the hidden durable transcript and active-turn state without a
  `projectId`.
- **Smart-link preview** is a normal viewer-allowed command rather than a chat
  stream message. Hosted web uses it so arbitrary pasted URLs are fetched at
  the trusted runtime boundary; older hosts simply leave the local fallback
  label in place.
- **File access sub-protocol** (`file_request` / `file_response`) is
  a separate envelope from remote commands; it handles large binary
  payloads and streaming reads outside the command surface to avoid
  bloating the command envelope.

## Chat command payload shape

`parseAgentChatSendArgs` and `parseAgentChatSteerArgs` accept the full
`AgentChatSendArgs` surface: `sessionId`, `text`, `attachments` (via
`parseAgentChatFileRefs`, array of `{ path, type: "file" | "image" }`),
`displayText`, `reasoningEffort`, `executionMode`, `interactionMode`.
Steers accept `sessionId`, `text`, and `attachments`. Controllers
(phones and desktop peers) can therefore attach files/images and
specify reasoning / execution / interaction modes remotely; the
runtime-side `agentChatService` consumes the same shape end-to-end.

## Lane and PR Linear-issue payload shape

`parseCreateLaneArgs` / `parseCreateChildLaneArgs` accept an optional
`linearIssue: LaneLinearIssue | null` so a controller can create a
lane already attached to a Linear ticket; `laneService.create`
derives the branch name (`linearIssueBranchName`) and persists the
issue into `lane_linear_issues`.

`parseCreatePrArgs` and `parseDraftPrDescriptionArgs` accept
`closeLinearIssueOnMerge: boolean`. When the lane has a connected
issue, this flag drives whether `prService` injects `Fixes IDENT`
(closes the issue when the PR merges) or `Refs IDENT` (links
without closing) into the PR body via `ensureLinearPrReference`.

Brain-status (`brain_status`) envelopes carry the brain's `LinearConnectionStatus`,
which now includes optional `organizationId`, `organizationName`,
`organizationUrlKey`, and `organizationLogoUrl` fields populated by
the brain when the Linear workspace is connected. Controllers use
these to render the workspace brand on Linear-related surfaces
without fetching them separately.

`parseChatModelsArgs` accepts `{ provider, activateRuntime?, cursorSource? }`
(`cursorSource` is `"sdk" | "cli" | "all"`, mirroring `chat.modelCatalog`).
When `chat.create` is missing an explicit model, `resolveChatCreateArgs`
forwards `activateRuntime: true` only for the `opencode` provider so
the brain actually launches the OpenCode probe server before resolving
a default model. All other providers use passive (cache-only) resolution;
see the chat README for the passive/active contract. The iOS companion's
`chat.models` request sets `activateRuntime: true` for cursor/droid and
`cursorSource: "sdk"` for cursor so a fresh key surfaces SDK models on the
first fetch instead of returning an empty passive cache.

## Gotchas

- **`chat.models` returns the brain's model catalog.** A controller
  must not hardcode model IDs. The brain is authoritative about
  which models are wired up, which providers have credentials, and
  what the default model and `defaultReasoningEffort` are. Compatibility
  catalogs may keep fallback rows for older hosts, but host-advertised tiers
  and defaults win.
- **`lanes.delete` and `lanes.archive` are queueable.** A
  disconnected controller can enqueue deletes that replay on
  reconnect. Be aware when reasoning about "why did this lane
  disappear" — check the command queue, not just the local DB.
- **Do not make `personalChats.create` queueable.** Clients can cache personal
  summaries per host for offline reading, but creation must wait for a live
  brain. Only an existing session's `personalChats.send` may queue.
- **Do not queue final cross-machine acceptance.** Source preparation,
  source validation, destination preflight, acceptance, and source marking all
  require current runtime/Git state. `chat.acceptCrossMachineHandoff` is
  deliberately non-queueable and route-pinned; safe retries come from the
  destination's durable handoff-id + capsule-fingerprint record, not an offline
  command queue. See [the handoff contract](./cross-machine-session-handoff.md).
- **`prs.createFromLane` requires GitHub auth on the brain.** Headless
  brains resolve async GitHub operations the same way the desktop does:
  an explicit env token (`ADE_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`),
  then the authorized ADE GitHub App user token, then a stored PAT, then the
  `gh` CLI resolved from known absolute install locations
  (launchd's minimal PATH does not include Homebrew), then reading
  `gh`'s `hosts.yml` oauth token directly (both host-level and nested
  `users:<login>:` token layouts). Only when none of those yield a
  token does the command fail with a clear error before reaching
  GitHub.
- **`work.runQuickCommand` always creates a PTY.** There is no
  "run a command, give me just the output" variant; the controller
  must subscribe to the terminal stream and stop the process with
  `work.stopRuntime`. A daemon configured without a real PTY service
  (rare; only used in some headless test harnesses) will surface
  `pty service not available` for this command.
- **`work.startCliSession` provider list is brain-controlled.** The
  controller cannot pass `command` / `args` / `startupCommand`
  overrides — the brain derives those from the provider name through
  `buildTrackedCliLaunchCommand`. To add a new provider you extend
  `apps/desktop/src/shared/cliLaunch.ts` and the
  `parseCliProvider` allowlist together; a phone client that hardcodes
  the new id without a brain update will get a "requires provider"
  error.
- **`files.writeTextAtomic` does not invoke git hooks or editors.**
  It writes atomically to the lane worktree and that is all.
  Services that care about post-write side effects (lint,
  formatters) watch the filesystem independently.
- **Mobile file mutations are no longer read-only-gated.** Files are
  freely editable from the phone: the old `mobileReadOnly` /
  edit-protection write gate was removed on both sides (the iOS
  `ensureMobileFileMutationsAllowed` check and the brain's
  `assertWriteAllowed` / `MOBILE_MUTATING_FILE_ACTIONS` enforcement),
  matching the desktop edit-protection removal. The `mobileReadOnly`
  field still rides the workspace payload but no longer blocks writes.
  Path-safety and the external-workspace block below are unchanged.
- **External desktop file opens are not mobile-visible.** Desktop
  `files.openExternalPath` workspaces use `kind: "external"` and
  `external-local:*` ids. The sync host filters them from mobile
  `listWorkspaces` and rejects every mobile file action that targets one,
  including reads and search, because those roots can point anywhere on the
  desktop user's local filesystem.
- **`requireService` throws lazily.** A runtime missing a service does
  not cause registration to fail; it causes the first invocation of
  a command that needs that service to fail with a specific message.
  Tests should exercise each command path rather than assume
  "registered means callable."
- **Policy is runtime-declared, not controller-configurable.** The
  controller cannot opt itself into commands the runtime marked
  non-viewer-allowed. If a phone needs an action that is policy-gated,
  the fix is a runtime-side policy change, not a client workaround.
