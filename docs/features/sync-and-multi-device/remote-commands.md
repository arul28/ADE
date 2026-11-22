# Remote Commands (`syncRemoteCommandService`)

Remote commands are how controllers act. A controller (a desktop peer, the
iPhone, the web client) sends a `command` envelope to the brain;
`syncRemoteCommandService` runs the action on the brain's in-process
services and replies with `command_ack`, then `command_result`.

Source: `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`. The
desktop file `apps/desktop/src/main/services/sync/syncRemoteCommandService.ts`
is a one-line re-export.

**Brain** is the always-on ADE process of a machine. Wire and code names
that say `host` or `syncHost` mean the brain, unless this doc says otherwise.

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

The brain serves several projects and one hidden personal-chat scope at
once. `runtime`-scoped commands (machine diagnostics, personal chats, catalog
reads, settings, local connection metadata) need no project. No client calls
`sync.getWebPairingInfo`. `project`-scoped commands need an open project and
a matching `projectId` on the envelope:

- `code: missing_project` — the envelope has no `projectId`. Select the
  project again and retry.
- `code: project_not_open` — the brain does not have that project open. Send
  a `project_switch_request` first.

**`host_unavailable`** comes from outside the registry. When no project host
owns the peer (restarting, or blocked by another sync listener),
`brainProjectActionsSyncHandler` answers at once with a failed
`command_result` and a typed snapshot (`reason`, `conflict`,
`recoveryEligible`).

- A verified conflict takes over the phone or web project surface at once; a
  starting failure retries silently (2 s, 4 s, 8 s) first.
- `sync.diagnoseHost` and `sync.recoverHost` are runtime-scoped. **Fix
  connection** stops the verified blocking runtime and restarts the brain.
  Owner details and recovery need a server-owned grant: desktop runtime-host
  grants, or the recovery grant that phones and browsers get only from
  same-account adoption. PIN-only phones get a redacted diagnosis.
- The repair is serialized (a second caller joins) and bounded by 90 s. The
  `hello_ok.projectHost` snapshot and `host_unavailable` replies skip the
  synchronous listener scan; only `sync.diagnoseHost` runs it.
- Clients keep **Retry** enabled during a repair, because a restart may never
  report back.
- iOS treats the code as retryable (`isSyncHostUnavailableError`) and keeps
  queued work. An already-attempted live `chat.send` is not queued (its
  outcome is unknown); iOS restores the draft instead.

Controllers read the descriptors (`getSupportedActions`, `getDescriptors`)
and gate UI on them; the brain is the authority.

**Mobile compatibility.** `apps/desktop/src/shared/syncMobileCompatibility.ts`
holds `MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS`. The brain checks its
registry against it and advertises `features.mobileCompatibility`. A missing
action gives `mode: "limited"` and `missingActions`, never a refused
connection. When you add, rename or remove a command that ADE Mobile uses,
update that list and the iOS tests in the same change.

`MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS` in the same file holds
additive commands that newer phones feature-detect from
`hello_ok.features.commandRouting.actions`. They must never join the
required set, because older phones never call them and a host without them
must stay `full`. Each entry's comment says what the phone does without it.
Examples:

- the Linear connection commands: the phone hides connect and disconnect;
- `cto.getAttention`: no CTO badge;
- the session lifecycle commands (`session.settleSessions`,
  `session.unsettleSessions`, `session.setSettleOverride`,
  `session.snoozeSession`, `session.wakeSession`,
  `session.clearWokeMarker`): no settle or snooze controls, so a current
  brain **must** advertise them;
- the new-lane launch commands (`chat.startLaunch` and the rest): the phone
  falls back to `lanes.create` → `chat.create`;
- `chat.resumeUsageLimitNow`, `chat.continueUsageLimitOnAlternate`,
  `chat.switchAccount`, `prs.setDraft`, `prs.setAutoMerge`: the phone hides
  that control;
- `machine.updateImpact` and `machine.updateAndRestart`: the phone and the web
  keep "Update ADE on that computer".

`machine.updateImpact` and `machine.updateAndRestart` are the sync-command twins
of the runtime RPC's `runtime.updateImpact` and `machine.updateAndRestart`.
They run the same transaction: `joinOrStartMachineUpdate` joins a desktop's
call and a phone's call into one run.

- Both are runtime-scoped and are answered on both of the phone's paths: the
  project host's registry and the brain ingress (a roster socket, or a socket
  parked there while the host is down).
- The policy is `controllerAllowed` only, never queueable. Any paired phone or
  browser may run them; a desktop viewer, an unpaired socket or a lane-share
  guest is refused.
- The requester's name comes from the pairing record when there is one, not
  from the client's claim (`SyncRemoteCommandExecutionContext.requester`).
- Only a brain started by `ade serve` that owns its machine installs them
  (`setMachineUpdateRemoteCommands`). An embedded runtime installs and
  advertises nothing.
- ADE Web sends the same two commands from its
  `remoteRuntime.updateAndRestart` / `getUpdateImpact`
  (`webclient/adapter/federated.ts`).
- The phone and the web read the newest build from the account directory's
  `GET /releases/latest`; the phone reads the manifests directly when signed
  out. No client moves a machine across tracks.

## Registry

`register(action, policy, handler, scope = "project")` in
`createSyncRemoteCommandService` fills a `Map` at construction. Handlers get
parsed args and return a result or throw; a throw becomes
`command_result.error`. Runtime scope is always explicit.

### Action categories

The list follows the registry order. The web client
(`../web-client/README.md`) uses this registry too, so whole families
(`terminal.*`, `rebase.*`, `history.*`, `github.*`, `projectConfig.*`,
`ai.*`, `usage.*`) back the desktop renderer namespaces over the wire. A
controller calls only actions in `hello_ok.features.commandRouting.actions`.

**Account** (`account.*`)
- `getMachineInventory` — viewer-allowed runtime read of the machine's
  token-free provider accounts, model counts and saved harness presets. It
  runs only for an online, connected machine.

**Provider accounts** (`providerAccounts.*`), all runtime-scoped:
- `list`, `getSettings`, `refresh` — viewer-allowed reads of the host's
  Claude and Codex logins.
- `loginStatus`, `create`, `remove`, `signOut`, `rename`, `setDefault`,
  `dismissReplaced`, `setSettings`, `loginStart`, `loginSubmitCode`,
  `loginCancel` — controller-only. A change to a login, or a read of a
  running sign-in (its link and device code), needs control.

`providerAccountRemoteCommands.ts` forwards each payload to the same method
on the `provider_instances` action domain, so remote callers and the desktop
share one implementation. A method the domain lacks throws at host start.
They are optional mobile actions, so an older host gives "update ADE". iOS
and the web client use them.

**Usage** (`usage.*`)
- `getAdeStats` — viewer-allowed read (today, 7d, 30d, year, all time) of the
  desktop Usage aggregate: provider tokens, project activity, daily points
  with the per-provider split, and client attribution (`desktop`, `mobile`,
  `tui`, `web`, `api`). No raw `usage_events` rows. `scope` is `account`,
  `machine` or `project`; `force` is only for a user Refresh.
- `getUsageRollup` — viewer-allowed runtime read of this machine's day ×
  provider × model aggregates and source identity. No transcript record,
  session id or absolute path leaves the machine (roots go as digests).
  `null` means the first ledger scan is not done; the caller retries.
- `getQuotaSnapshot` — viewer-allowed read of the cached Claude and Codex
  quota (windows, source, freshness, retry, stale or error). It starts no
  work.
- `refreshQuota` — viewer-allowed quota-only refresh with interactive auth
  off, so it never opens a Keychain prompt or a CLI login.

**Lanes** (`lanes.*`)
- `list`, `listDeleteProgress`, `refreshSnapshots`, `getDetail`
- `create`, `importBranch`, `getNewLaneDefaults`, `setNewLaneDefaults`
- `listUnregisteredWorktrees`, `attach`, `adoptAttached` — **compatibility
  stubs.** Every worktree is a lane. They stay registered because they are
  required mobile actions. `listUnregisteredWorktrees` returns `[]`; the
  other two fail with a "no longer supported" message.
- `rename`, `updateAppearance`
- `archive`, `unarchive`, `delete`
- `rebaseStart`, `rebasePush`, `rebaseRollback`, `rebaseAbort`
- `listTemplates`, `getDefaultTemplate`
- `initEnv`, `getEnvStatus`, `applyTemplate`
- `getBranchDrift`, `resolveBranchDrift` — detection and resolution for a
  lane worktree whose live HEAD has wandered off the lane's recorded
  `branch_ref`
- `presence.announce`, `presence.release` — controller marks a lane
  as currently open / no longer open; the brain decorates
  `LaneSummary.devicesOpen` with a 60 s TTL and fans out updates via
  the brain-status broadcast (`brain_status`).

`lanes.getDetail` and `lanes.refreshSnapshots` are **conditional**. The
payload hash (`sha256(JSON.stringify(response))`) is its `signature`. When
the caller's `ifNoneMatch` matches, the reply is
`{ signature, notModified: true }` with no body; else the full payload with
`notModified: false`. The host still computes the payload; the saving is
transport and decode.

**Work** (`work.*`)
- `listSessions`, `getSession`, `getSessionDelta`, `deleteSession`,
  `updateSessionMeta`, `runQuickCommand`,
  `startCliSession`, `sendToSession`, `stopRuntime`

**Session lifecycle** (`session.*`)
- `settleSession`, `unsettleSession`, `settleSessions`, `unsettleSessions`
- `snoozeSession`, `snoozeSessions`, `wakeSession`, `wakeSessions`
- `setSettleOverride`, `clearWokeMarker`

All ten are `viewerAllowed` and `queueable`. The namespace matches the
action domain, so phones and the web client detect it apart from `work.*`.
It is their only path to session lifecycle (they have no local database).

- `session.settleSession` uses the shared `settleTerminalSession`
  transaction, so `dismissPendingInput` acts as on desktop.
- `session.settleSessions` (the one mobile uses) accepts
  `dismissPendingInput` too. It first runs `dismissPendingInputBeforeSettle`
  (`apps/desktop/src/main/services/sessions/settleTerminalSession.ts`), then
  the normal settle, and returns the changed ids. The flag is **refused with
  more than one session id**: the dismissal throws on a row with nothing
  pending, so a batch would half-apply. An older host ignores the flag.
- Snooze inputs are validated, never trusted: `parseRemoteSnoozeDeadline`
  (`untilIso` or `snoozedUntil`), `parseRemoteWakeReason`
  (`SESSION_WAKE_REASONS`), and `parseRemoteSettleOverride` through
  `parseSessionSettleOverride` (`apps/desktop/src/shared/types/sessions.ts`).
  `"clear"`, `"none"`, `""` and null clear the override, because iOS cannot
  send a JSON null; other values throw.

**Chat** (`chat.*`)
- `listSessions`, `getSummary`, `getTranscript`
- `createScheduledWork`, `cancelScheduledWork`, `setScheduledWorkPaused`
- `launch`, `getSlashCommands`, `resolveSmartLinkPreview`, `resolveSourceFavicons`, `getContextUsage`, `warmupModel`,
  `getParallelLaunchState`, `setParallelLaunchState`, `handoff`,
  `prepareCrossMachineHandoff`, `validateCrossMachineSource`,
  `preflightCrossMachineDestination`,
  `fastForwardCrossMachineHandoffLane`, `acceptCrossMachineHandoff`,
  `markCrossMachineHandoff`,
  `rewindFiles`, `getTurnFileDiff`, `saveTempAttachment`, `createAttachmentUpload`,
  `beginTempFileAttachment`, `appendTempFileAttachmentChunk`,
  `finishTempFileAttachment`, `abortTempFileAttachment`, `getAttachmentChunk`,
  `listDrafts`, `getDraft`, `createDraft`, `updateDraft`, `deleteDraft`, `claimDraft`, `getImageDataUrl`
- New-lane launches: `startLaunch`, `getLaunch`, `listLaunches`,
  `cancelLaunch`, `retryLaunch`, `startLaunchNow`, `queueLaunchMessage`,
  `completeLaunchClient` — see [New-lane launch commands](#new-lane-launch-commands)

The five file-attachment actions are the chunked base64 staging for
documents and videos; see
[Chunked staging for file-shaped attachments](README.md#chunked-staging-for-file-shaped-attachments).

`chat.getTranscript` pages with an opaque `nextCursor` (pass `cursor` for
older history). Agent runtimes advertise `cursorKind: "byte"` (an
append-stable JSONL offset, no full parse); the headless fallback advertises
`cursorKind: "index"`. Clients keep the cursor opaque and use `cursorKind`
only to choose a merge strategy.
- `create`, `send`, `interrupt`, `interruptWithQueueMode`,
  `restoreCancelledQueue`, `steer`, `cancelSteer`, `editSteer`,
  `dispatchSteer`, `cancelDispatchedSteer`, `approve`, `respondToInput`
- `recoverTurn`, legacy `recoverCodexTurn`, `resolveUnprocessedMessage`
- `restart`, `updateSession`, `regenerateSessionMetadata`, `archive`,
  `unarchive`, `delete`, `models`, `modelCatalog`
- `resumeUsageLimitNow`

Live-only means not queueable: a reconnect never replays it.

| Action | Args → result | Policy and rules |
|---|---|---|
| `chat.recoverTurn` | `{ sessionId, turnId, action }`; `action` is `wait`, `nudge`, `retry_same_runtime` or `restart_resume` | Viewer-allowed, live-only; acts on the active turn. Older hosts have only `chat.recoverCodexTurn`; clients map the same four controls and show one card. |
| `chat.resolveUnprocessedMessage` | `{ sessionId, steerId, action: "run_next" \| "dismiss" }` | Viewer-allowed, live-only. A terminal `user_message_resolution` receipt makes both idempotent across retries and restarts. `run_next` needs an idle session and commits after the new turn dispatches; `dismiss` sends nothing. |
| `chat.regenerateSessionMetadata` | `{ sessionId, fields? }` (`title`, `laneName`, `statusLine`; omitted = all) → `applied`, `skipped`, `modelId` | Viewer-allowed, live-only. One request returns all three; only chosen fields apply. Per-field snapshots keep edits made during the request. It may replace a manual title; it skips the primary lane name. An array with no valid field is refused. |
| `chat.resolveSmartLinkPreview` | `{ url }` → provider, kind, label, maybe a title and favicon | Viewer-allowed read. GitHub and Linear titles use the runtime's integrations; other HTTP(S) goes through the SSRF-hardened preview service. Local, private, oversized or non-HTML URLs give the plain preview. The URL is never replaced. |
| `chat.resolveSourceFavicons` | `{ domains }` → `{ icons: { [domain]: dataUrl \| null } }` | Viewer-allowed, runtime-scoped. First-party fetch by the SSRF-guarded resolver, cached on disk. See [Favicons](../chat/transcript-and-turns.md#favicons). |
| `chat.getMcpApp` | `{ sessionId, itemId }` → the app with `contentSecurityPolicy` | Viewer-allowed. The controller serves the page with the brain's policy (`sandbox allow-scripts`) and builds none. Over 1 MB gives `{ status: "unavailable", reason }`. |
| `chat.mcpAppRequest` | `{ sessionId, itemId, method, params, userActivated }` | Not viewer-allowed, live-only. Runs a tool on the app's server through the live session. A tool that may change data needs `userActivated: true`. Optional on mobile. See [MCP Apps](../chat/README.md#mcp-apps). |
| `chat.createScheduledWork` | `{ sessionId, cron, prompt, recurring?, reason? }` | **Owner-only**, live-only. `recurring` defaults to true; false runs once at the next cron match. |
| `chat.setScheduledWorkPaused` / `chat.cancelScheduledWork` | `{ sessionId, paused }` / `{ sessionId, scheduleId }` | Viewer-allowed, live-only. |
| `chat.resumeUsageLimitNow` | `{ sessionId }` → `{ ok: true, turnId }` or `{ ok: false, reason: "no_live_usage_limit" \| "resume_in_flight", message }` | **Owner-only**, live-only: it spends a turn of the owner's quota. A refusal is an answer, not an error. |
| `chat.continueUsageLimitOnAlternate` | `{ sessionId }` → `{ ok: true, sessionId }` or `{ ok: false, reason: "no_live_usage_limit" \| "no_alternate_account" \| "handoff_failed", message }` | Owner-only, live-only. Uses the account on the live resume. |
| `chat.switchAccount` | `{ sessionId, instanceId }` → `{ ok: true, instanceId }` or `{ ok: false, reason: "busy" \| "signed_out" \| "failed", message }` | Owner-only, live-only: it changes who pays for the next turn. |

Controllers show each control only when the descriptor list has it.

`chat.modelCatalog` takes `{ mode?, refreshProvider?, cursorSource? }`.
`mode` is `"cached"` (default), `"refresh-stale"` or `"force"`; only the last
two probe. `refreshProvider` is `opencode`, `cursor`, `droid`, `lmstudio` or
`ollama`. `cursorSource` (`sdk`, `cli`, `all`; default `all`) picks the Cursor
source probed now; chat surfaces pass `sdk` to skip the slow CLI spawn. The
result is the provider-grouped catalog of the desktop ModelPicker.

**Steering.**
- `chat.dispatchSteer` takes `{ sessionId, steerId, mode: "inline" |
  "interrupt" }` → `{ ok, dispatchedAt }`. The modes come from
  `ACTIVE_TURN_DISPATCH_MODES` (`apps/desktop/src/shared/types/chat.ts`); an
  unsupported mode is refused with `unsupportedActiveTurnDispatchModeMessage`,
  never downgraded.
  - Claude: the message goes into the live input stream (`priority: "next" |
    "now"`, `shouldQuery: true`). Interrupt redirects the request without
    stopping background work. The row is removed after the input pump accepts.
  - Cursor: `"interrupt"` stops the run, waits, and resends on the same agent
    thread (the row returns to the queue on a throw); `"inline"` uses
    `Run.steer()`.
- Read `dispatchedAt`. A refused inline dispatch (Cursor Cloud, attachments or
  per-message overrides, a declined turn, no steer channel) answers
  `{ dispatchedAt: null }` without a throw and keeps the row staged. A queued
  command's ack has no `dispatchedAt` key. iOS keeps the row queued in both
  cases.
- `chat.cancelDispatchedSteer` → `{ ok, cancelled }`; `cancelled` is false,
  because the SDK cannot cancel a pushed message.
- `chat.cancelSteer` with `requireQueued: true` refuses when delivery already
  claimed the message. Desktop Edit uses it before it restores the text.

**Stop.** `chat.interruptWithQueueMode` takes `{ sessionId, mode }` →
`{ mode, cancelledQueuedCount, recoveryId?, recoveryExpiresAt? }`:
- `stop_and_clear` (default): interrupt with `cancel_queued: true`, then
  cancel per message if needed; background jobs keep running.
- `stop_only`: keep queued messages and background jobs.
- `stop_and_background`, `stop_and_clear_and_background`: also stop running
  Claude tasks.

A controller that does not see it calls `chat.interrupt`. `chat.stopTask`
(`{ sessionId, taskId }`) stops one Claude task and is a required mobile
action. `chat.restoreCancelledQueue` (`{ sessionId, recoveryId }` →
`{ restored, restoredCount }`) works only in the 8-second recovery window.
Interrupt, stopTask and restore are viewer-allowed and live-only.

**Personal chat** (`personalChats.*`)
- `list`, `create`, `getSummary`, `read`, `send`
- `steer`, `cancelSteer`, `editSteer`, `dispatchSteer`,
  `cancelDispatchedSteer`, `interrupt`, `interruptWithQueueMode`,
  `stopTask`,
  `restoreCancelledQueue`, `respondToInput`, `approve`
- `createScheduledWork`, `cancelScheduledWork`, `setScheduledWorkPaused`
- `updateSession`, `archive`, `unarchive`, `delete`
- `models`, `modelCatalog`, `getEventHistory`, `getEventHistoryPage`
- `terminalCreate`, `terminalWrite`, `terminalResize`, `terminalDispose`
- `saveTempAttachment`, `getImageDataUrl`, `streamEvents`

All personal actions are runtime-scoped and go to `PersonalChatScope`,
never to the project `agentChatService`. Only `send` is queueable; a queued
`create` could not return a stable id. Every session action checks
`surface: "personal"`; terminal and attachment actions also check scope
ownership and path confinement. Scheduled-work actions reuse the project
contracts after the personal-scope check.

**Git** (`git.*`)
- `getChanges`, `getFile`, `getFilePatch`, `getUserIdentity`
- `stageFile`, `stageAll`, `unstageFile`, `unstageAll`,
  `discardFile`, `restoreStagedFile`
- `commit`, `listRecentCommits`,
  `listCommitFiles`, `getCommitMessage`, `getFileHistory`
- `revertCommit`, `cherryPickCommit`, `createTag`, `resetToCommit`
- `isCommitInLaneHistory` (`{ laneId, commitSha }` → boolean) — is the
  commit reachable from the lane HEAD; checked before destructive commit
  actions
- `stashPush`, `stashList`, `stashApply`, `stashPop`, `stashDrop`,
  `stashClear`
- `fetch`, `pull`, `sync`, `push`, `getSyncStatus`, `getSyncStatuses` (many
  lanes in one call, keyed by lane id)
- `undoLastHeadChange`, `redoLastHeadChange` — re-read HEAD and refuse when
  the lane moved since the target operation
- `getConflictState`, `rebaseContinue`, `rebaseAbort`, `mergeContinue`,
  `mergeAbort`
- `listBranches`, `checkoutBranch`

`git.pull` takes `mode` (`ff-only` default, `rebase`, `merge`); another value
is refused. `git.resetToCommit` takes `{ laneId, commitSha, mode }` (`soft`,
`mixed`, `hard`) and records `git_reset_<mode>` for undo. `git.createTag`
takes `{ laneId, commitSha, tagName, message? }`; no message makes a
lightweight tag.

**Files**
- `files.writeTextAtomic`

**Terminal** (`terminal.*`)
- `list`, `activeForChat` — reads for the web and mobile terminal views.
  Live IO uses the `terminal_*` sub-protocol.

**Conflicts** (`conflicts.*`)
- `getLaneStatus`, `listOverlaps`, `getBatchAssessment`

**Rebase** (`rebase.*`)
- `scanNeeds`, `execute`

**History** (`history.*`)
- `listOperations` — the undo/redo operations log.

**Search** (`search.*`), both viewer-allowed:
- `query` — `SearchQueryArgs` → `SearchQueryResult`, the same
  `searchService.query` call as the `search` action domain. The brain removes
  `callerScope` from the payload. A payload with no string `query` fails
  ("search.query requires query."). Before bootstrap builds the search
  service, the call fails with "Search is not available in this runtime."
  The web palette uses it to search each connected computer.
- `indexStatus` — `SearchIndexStatus`, or null when the runtime has no
  search service.

A lane share guest cannot run either one. The brain does not log the query
text.

**GitHub** (`github.*`)
- `getStatus`, `getRemoteStatus`, `publishCurrentProject`
- `getRequestBudget` — viewer-allowed, no network: the host's GitHub budget
  (reserve pause, worst recent failure, retry time). The web client's PR
  timers spend this machine's quota, so they read it. See
  [pull requests](../pull-requests/README.md#keeping-automatic-github-reads-inside-the-quota).

**Project config** (`projectConfig.*`)
- `get`, `save`

**AI** (`ai.*`)
- `getStatus` — provider/auth status for the settings surfaces.

**PRs** (`prs.*`)
- `list`, `listOpenForRepo`, `refresh`, `getDetail`, `getDetailBundle`
  (status, checks, reviews and comments; keeps good parts on a partial
  failure), `getStatus`
- `getChecks`, `getReviews`, `getComments`, `getFiles`
- `postReviewComment`, `delete`, `cleanupBranch`
- `listWithConflicts`, `listSnapshots`
- `createFromLane`, `land`, `close`, `reopen`, `requestReviewers`,
  `rerunChecks`, `addComment`
- `setDraft` (`{ prId, draft }`), `setAutoMerge` (`{ prId, enabled,
  method? }`) — viewer-allowed, queueable, optional on mobile
- `getMobileSnapshot` — `PrMobileSnapshot` (summaries, stacks, capabilities,
  create eligibility) for the iOS PRs tab; see `ios-companion.md`

**CTO** (`cto.*`)
- `ensureSession`, `getState`, `updateIdentity` — the one CTO chat and its
  identity.
- `getHomeMachine`, `setHomeMachine` — the machine that owns the project's
  CTO.
- `getMemory` — project notes, notes about the person and the open-work list
  (v1-only fields sent empty for older phones).
- `updateNotes`, `updateOpenWork` — queueable writes (web CTO page and
  settings).
- `refreshContext` — a new provider thread; the session and memory stay.
- `previewSystemPrompt` — the assembled prompt.
- `getAttention` — `idle`, `awaiting-input` or `unknown` for the CTO badge,
  through `agentChatService.getCtoAttention()` (the same as
  `IPC.ctoGetAttention` and `cto_state.getAttention`). Viewer-allowed and
  strictly read-only: it never calls `ensureIdentitySession`, so a badge
  cannot create a primary lane or CTO chat. The CTO chat is in no roster, so
  phones must ask. Clients keep the last badge on `unknown`. Optional.
- `getLinearConnectionStatus`, `getLinearQuickView`,
  `getLinearIssuePickerData`, `searchLinearIssues`, `getLinearIssueComments`
  — Linear reads.
- `startLinearMobileOAuth` (desktop PKCE session; redirect through
  `ade-github-webhook-relay` to `ade://linear-oauth`),
  `completeLinearMobileOAuth` (desktop token exchange), `setLinearToken`
  (API key), `clearLinearToken` — Linear connection from the phone.
  Viewer-allowed, optional. See
  [Linear integration](../linear-integration/README.md#connecting-and-managing-from-mobile).

**Mac Desktop** (`macDesktop.*`)

The lane's private macOS screen, for the web client and the phone. It is
registered only when the runtime has the Mac Desktop service and its
fan-out, advertised as `hello_ok.features.macDesktopStream: true`; else
clients keep the still image. `hello_ok.features.macDesktopControl: true` is
set exactly when `takeControl` is registered.

- `getStatus` `{ laneId }` — viewer-allowed `MacDesktopStatus` with
  `recording: null`, so no host path leaves. No stream token or URL.
- `start` `{ laneId, laneName? }`, `stop` `{ laneId }` — controller-only.
  The phone calls `start` only from the Off card and never `stop`; the web
  client may stop. `start` is idempotent; a non-Mac runtime answers
  `MAC_DESKTOP_UNSUPPORTED_PLATFORM`.
- `streamSubscribe` `{ laneId, subscriptionId, viewerLabel? }` →
  `{ ok, width, height, codec }`. Same path as desktop `startStream`, but the
  owner is a **subscription** (never in `viewerChatSessionIds`). The first
  record is a `config`, then a keyframe.
- `streamUnsubscribe` `{ subscriptionId }`. A socket close releases its
  subscriptions.
- `takeControl` `{ laneId, controllerId, controllerLabel? }` →
  `MacDesktopLeaseState`, controller-only. `controllerId` is a per-tab
  token; the brain derives the holder id `web:<socket connection id>:<token>`,
  so a socket can only return or renew its own lease. Phones use the same
  four commands when `macDesktopControl` is set.
- `returnControl`, `renewLease` `{ laneId, controllerId }` →
  `MacDesktopLeaseState | null`. Another socket's call is a no-op.
  `renewLease` is the heartbeat; null means lapsed or held by another.
- `input` `{ laneId, call: { kind, args } }` (`click`, `move`, `scroll`,
  `type`, `press`, `drag`) → `MacDesktopInputResult`. The host strips
  `controllerId`, `holderId` and `chatSessionId`, forces `silent: true` and
  sets the derived id. `type` text is capped at 4 KiB; a point outside the
  display is refused.
- On `ws close` the host returns that socket's leases at once.
- Pushes: `macDesktop.streamRecord` `{ subscriptionId, seq, kind: "config" |
  "frame", keyframe, timestampUs, data }` (base64 Annex-B units or the JSON
  config) and `macDesktop.streamEnded` `{ subscriptionId, reason, message? }`
  (`unsubscribed`, `stopped`, `display_destroyed`, `connection_closed`,
  `error`).
- Backpressure: over 2 MiB queued, frames drop until the next keyframe.
  `seq` counts source records, so a gap means a drop.

The canonical list is typed as `SyncRemoteCommandAction` in
`apps/desktop/src/shared/types/sync.ts`.

## Argument parsing

Each action has its own parser (`parseCreateLaneArgs`,
`parseAgentChatSendArgs`, `parseCreatePrArgs`, …). It takes
`Record<string, unknown>`, checks required fields (`requireString`,
`requireStringArray`, `requireService`), coerces optional ones
(`asTrimmedString`, `asOptionalNumber`, `asOptionalBoolean`,
`asStringArray`) and returns the typed service args. A bad payload throws a
plain error (`"lanes.create requires name."`) that the controller gets as
`command_result.error.message`.

The five handoff parsers check shape only. The service checks the capsule
(version, bounds, secret redaction, Git identity, SHA-256 fingerprint)
before it creates anything; the parser is not the trust boundary.

## Handler bodies

Most handlers parse and call one service method. These have more logic:

- **`lanes.create`** — uses the saved account and repository defaults
  (`lanes.getNewLaneDefaults`, `lanes.setNewLaneDefaults`) for omitted start
  choices.
- **`lanes.list`** — `laneService.list`, then `buildLaneListSnapshots`
  (runtime buckets and conflict status for the iOS Lanes tab).
- **`lanes.initEnv`, `lanes.applyTemplate`** — the shared
  `runLaneEnvironmentSetup` (`lanes/laneEnvironmentSetup.ts`,
  `includeArchived: false`), which the action domain, IPC and launch service
  also use.
- **`lanes.suggestName`** — background naming for the mobile auto-create
  flow, like `agentChatService.generateAutoLaneIdentity`. Takes `{ prompt,
  modelId, laneId, fallbackName?, temporaryBranch?, attachments? }`, makes
  one structured request for a title and a Git-safe branch fragment, applies
  each on the host, and returns `{ name, hostApplied }`.
  - Not queueable, so an offline phone uses its own fallback at once.
  - Honors `titleGenerationEnabled`. Model order: the configured naming
    model, the launched model, then a signed-in model of the same provider.
    Low or minimal reasoning. Images are context; other files give metadata.
  - iOS waits 45 s and retries once for a transient failure only (not for
    disabled naming, no auth, no capability, bad output or an unsafe branch).
    Any failure keeps the deterministic lane and branch, so naming never
    blocks lane creation.
  - iOS (`WorkNewChatScreen`, the hub composer) creates the lane at once on
    an `ade/<8 lowercase hex>` branch, then calls
    `SyncService.suggestLaneName` after the launch. With `hostApplied` it
    refreshes; an older host returns a title that iOS applies with
    `lanes.rename`. A manual change during naming wins.
- **`lanes.presence.announce` / `.release`** — handled in `syncHostService`,
  not the registry. The brain keeps a per-lane `DeviceMarker` map and adds
  `devicesOpen` (60 s TTL) to `LaneSummary`.
- **`work.runQuickCommand`** — `ptyService.create` from a `PtyCreateArgs`;
  returns the PTY for `terminal_subscribe`.
- **`work.runShellBlock`** — runs a chat reply's shell block. The chat must
  be in the lane. `ptyService.create` gets `chatSessionId`, the client's
  interpreter `command` and `args` (the script is one argument, at most
  128,000 UTF-8 bytes), `toolType: "shell"` and the host's
  `SHELL_BLOCK_RUN_ENV` (pagers off); the client sends no environment.
  Controller-only and live-only, so a block runs only on confirmation.
  Optional on mobile.
- **`work.startCliSession`** — the CLI launcher for iOS Work and the web
  client (`pty.create` maps a desktop `runtimeCliLaunch` onto it).
  - `parseStartCliSessionArgs` allows `provider` `claude`, `codex`, `cursor`,
    `droid`, `opencode` or `shell` (else "work.startCliSession requires
    provider."), clamps `cols` to 20–240 and `rows` to 4–120, and cuts
    `initialInput` at 20 KB.
  - `model`/`modelId`, `reasoningEffort`, `fastMode` and Codex `fastTier`
    (alias `codexFastMode`) go to `buildTrackedCliLaunchCommand`
    (`apps/desktop/src/shared/cliLaunch.ts`), shared with desktop, so a
    phone cannot send a free-form command. `shell` takes no startup payload.
  - It also takes `instanceId`, `presetId`, `credentialId`,
    `droidPermissionMode`, `linearIssues` (parsed by
    `parseLaneLinearIssueValue`, attached before the spawn so the CLI gets
    `ADE_LINEAR_*`), `startupDelayMs` and `initialInputDelayMs` (a provider's
    own delay wins).
  - The lane worktree resolves first, so `ADE_AGENT_SKILLS_DIRS` prefers
    lane skill folders. Codex on macOS adds only
    `mcp_servers.computer_use` overrides, and only for an opted-in,
    signature-verified client.
  - Claude gets a pre-assigned `--session-id`. `initialInput` goes to
    `ptyService.create` with `initialInputDelayMs` (750 ms default) for a
    bracketed-paste submit.
  - The result is `SyncStartCliSessionResult` (`{ sessionId, ptyId, session
    }`), so the controller can subscribe at once. The result journal keeps
    the handle and summary, never `initialInput`.
  - A namespaced lane id and machine-marked project id route it to another
    machine. The iOS start offers an account menu (two or more accounts from
    `account.getMachineInventory`, connected machine only, hidden with a
    preset) and a Linear picker. Stored API keys are reachable only through a
    preset.
- **`chat.typeIntoCli`** — `{ sessionId, text, holdUntilFree?,
  clientMessageId? }` → `{ ok, outcome }`. Types into a running agent CLI
  only at a free prompt, through `agentChatService.typeIntoAgentCliWhenFree`
  (the same flight as wakes). `outcome`: `delivered`; `deferred` (busy,
  nothing typed); `held` (typed in order when free, up to six hours, lost on
  a brain restart); `ended` (process gone, nothing relaunched).
  - `holdUntilFree` defaults to true, because the phone has no queue; the
    desktop and web send false and queue in the Work input box.
  - A repeat `clientMessageId` gets the first answer (kept ten minutes).
  - Queueable. Not for share guests. Optional on mobile.
- **`work.listExternalSessions` / `work.importExternalSession`** — list and
  import Claude, Codex, Cursor, Droid and OpenCode CLI sessions. Import
  returns the new ids plus the persisted summary, for navigation at once. See
  [External Session Import](../terminals-and-sessions/external-session-import.md).
- **`work.getExternalSessionDetail`** — `{ provider, sessionId, before? }`
  for the phone's import preview; viewer-allowed, live-only. It calls
  `externalSessionsService.getDetail` with a 120-event page and returns
  `events` (compacted by `compactChatEventForMobileWire`, without
  `resultTruncatedForMobile`), `hasOlder` and `olderCursor`. With events,
  `messages` is empty. Without the service: "External sessions service not
  available." Optional.
- **`work.sendToSession`** — writes into a live PTY, or resumes an ended
  resumable session under the same id.
- **`work.stopRuntime`** — disposes the PTY; the session row and transcript
  stay.
- **`chat.create`, `chat.launch`** — a missing `model` resolves through
  `resolveChatCreateModel`
  (`apps/desktop/src/main/services/chat/chatCreateModelResolution.ts`).
- **`chat.recoverCodexTurn`** — legacy actions `wait`, `steer`,
  `interrupt_retry_same_thread`, `restart_resume_thread`; viewer-allowed,
  live-only.
- **`prs.refresh`** — refresh, then return `{ refreshedCount, prs,
  snapshots, snapshotScope, omittedSnapshotPrIds }`. `prId`/`prIds` pick
  snapshots; `includeSnapshots` is `active` (default: open or draft, lane
  not archived), `all` or `none`. Snapshots stop at 6 MiB per reply, open
  first; the rest are in `omittedSnapshotPrIds` and load one at a time.
- **`prs.getMobileSnapshot`** — `prService.getMobileSnapshot`: stacks,
  capabilities, create eligibility.
- **Reply size guard.** A result over 12 MiB
  (`SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES`) fails with `{ code:
  "result_too_large", message, bytes, limitBytes }`. `sendRequired` does the
  same for any reply over the 16 MiB send budget and keeps the socket. Only a
  peer with a full queue, or backpressured past the timeout, closes with
  4001.

### Lane response decoration

`syncHostService` adds `LaneSummary.devicesOpen` to lane list, detail,
snapshot, create and import results, so no separate presence query is
needed.

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
  usageTrackingService?,
  logger,
}
```

A missing optional service makes its actions throw `"<service> not
available."` at call time (`requireService`), not at registration. So a
narrow runtime (a headless one with no chat service) still starts.

## Supported-action discovery

The service exposes:

```ts
getSupportedActions(): SyncRemoteCommandAction[];
getDescriptors(): SyncRemoteCommandDescriptor[];
getPolicy(action: string): SyncRemoteCommandPolicy | null;
execute(payload: SyncCommandPayload): Promise<unknown>;
```

Controllers read descriptors on connect, cache them and refresh on
`brain_status`. The iOS tabs show only the actions the runtime supports
under the current policy.

## Logging

Each run logs `sync.remote_command.execute` (debug) with `action` and
`policy`. Failures log at warn or error in the service. Args are never
logged, because chat `text` and file `relPath` can be sensitive.

## Integration with other sync surfaces

- **Changeset sync** carries state. A controller sees a command's effect in
  the replicated rows (`lanes`, `sessions`, `linear_workflow_runs`, …).
- **Terminal sub-protocol.** After `work.runQuickCommand`,
  `work.startCliSession`, `work.sendToSession` or `work.stopRuntime`, the
  controller sends `terminal_subscribe` with the session id.
  - With `features.rosterTerminal`, a host also streams a terminal of
    another open project named by the envelope `projectId`
    (`apps/ade-cli/src/services/sync/syncTerminalStreams.ts`, shared by the
    project host and the brain ingress).
  - The brain and its project hosts share one terminal input ledger, so a
    resend after a reconnect to the other ingress is a duplicate.
- **Chat sub-protocol.** Create or send by command, then `chat_subscribe`.
  - `chat.send` returns `ok` only after the runtime acknowledges dispatch,
    so the phone keeps its local echo until then.
  - The handler passes `routeActiveToSteer: true`, so a send during an
    active turn becomes a steer. Then the ack adds `{ steerId, queued,
    reason?: "queue_full" }`; a full queue gives `queued: false`. Older
    clients ignore the extra fields.
  - On a timeout or a lost transport before the ack, the phone treats the
    send as unknown: no automatic replay, the draft comes back, and the
    transcript shows whether the turn started.
  - Personal chat sends `chatScope: "personal"`, with no `projectId`.
- **New-lane launches** use the pushed `chat_launch_event` envelope (see
  [New-lane launch commands](#new-lane-launch-commands)).
- **Smart-link preview** is a normal command, so the web client fetches
  pasted URLs at the runtime. Older hosts keep the local label.
- **File access** (`file_request` / `file_response`) is a separate envelope
  for large and streamed reads.

## New-lane launch commands

The brain-owned "start a chat in a lane that does not exist yet" contract
(`apps/desktop/src/shared/types/chatLaunch.ts`) is eight sync commands named
like the brain's `chat` action domain. All are viewer-allowed and **not
queueable**: the client shows the launch at once with Retry, and a lane from
an old offline outbox would surprise the person. With no
`chatLaunchService`, every command except `chat.listLaunches` (returns `[]`)
throws "New-lane launches are not available on this host."

| Command | Args | Result |
|---|---|---|
| `chat.startLaunch` | `ChatLaunchArgs`: `kind` (`chat` \| `cli`), `mode` (`foreground` \| `background`), `launchId` (the chat's session id, a UUID the client picks), optional `laneId` (reserved lane UUID), `laneName`, `prompt`, `displayPrompt`, `attachments`, `baseBranch`, `modelId`, `provider`, `title`, `originClientId`, and for `kind: "chat"` a required `chat: { create, message }` | `ChatLaunchSnapshot`, returned as soon as the launch is reserved |
| `chat.getLaunch` | `{ launchId }` | snapshot or null |
| `chat.listLaunches` | none | every launch the brain is running or recently finished |
| `chat.cancelLaunch` | `{ launchId }` | snapshot; throws once the agent has started |
| `chat.retryLaunch` | `{ launchId }` | snapshot; reruns from the first unfinished stage |
| `chat.startLaunchNow` | `{ launchId }` | snapshot; starts the agent while (or after) the environment stage runs |
| `chat.queueLaunchMessage` | `{ launchId, text, displayText?, attachments? }` | snapshot; throws `Launch not found: <id>` for an unknown launch |
| `chat.completeLaunchClient` | `{ launchId, sessionId?, error? }` | snapshot; a CLI launch's client reports the PTY session it started (or its error) |

All entry points (the desktop action domain in `adeActions/registry.ts`
too) parse with `apps/desktop/src/main/services/chat/chatLaunchArgs.ts`.
`chat.create` uses the `chat.create` field parser (its `laneId` and
`sessionId` dropped; the launch owns them) plus `presetId`, `credentialId`
and `instanceId`. `chat.message` uses the `chat.send` field parser (its
`sessionId` dropped), keeps `contextAttachments` and a `local` or `cloud`
`runtime`, and may have empty `text` with context only. An empty `model`
resolves through `resolveChatCreateModel`.

The launch's stages and controls are described in
[Chat › New-lane launches](../chat/README.md#new-lane-launches).

**Pushed progress.** The sync host sends each `ChatLaunchEvent`
(`launch-updated` with the snapshot, or `launch-removed`) as a
`chat_launch_event` envelope to every authenticated peer of the project
(not runtime-only hosts or backpressured peers). There is no subscription,
because a launch shows before its chat exists. The payload
(`SyncChatLaunchEventPayload`) adds `projectId` and `projectRootPath` for
routing. Clients load `chat.listLaunches` on connect and merge by
`sequence`.

## Chat command payload shape

The field parsers (`parseAgentChatCreateFields`, `parseAgentChatSendArgs`,
`parseAgentChatFileRefs`, `parseCursorConfigValues`) live in
`apps/desktop/src/main/services/chat/chatLaunchArgs.ts`. Sends accept the
full `AgentChatSendArgs`: `sessionId`, `text`, `attachments` (`{ path, type:
"file" | "image" }`), `displayText`, `reasoningEffort`, `executionMode`,
`interactionMode`. Steers accept `sessionId`, `text` and `attachments`.

## Lane, PR and model payload shapes

- `parseCreateLaneArgs` accepts `linearIssue: LaneLinearIssue | null`;
  `laneService.create` derives the branch (`linearIssueBranchName`) and
  stores the issue in `lane_linear_issues`.
- `parseCreatePrArgs` accepts `closeLinearIssueOnMerge`. With a connected
  issue, `ensureLinearPrReference` writes `Fixes IDENT` (closes on merge)
  or `Refs IDENT` into the PR body.
- `brain_status` carries `LinearConnectionStatus` with optional
  `organizationId`, `organizationName`, `organizationUrlKey` and
  `organizationLogoUrl` for the workspace brand.
- `parseChatModelsArgs` accepts `{ provider, activateRuntime?, cursorSource?
  }`. For a `chat.create` with no model, `resolveChatCreateModel` sets
  `activateRuntime: true` only for `opencode`, `pi`, the ACP providers
  (`qwen`, `kimi`, `grok`) and `copilot` (ACP rows need a CLI auth pass,
  Copilot rows an SDK read, OpenCode a probe server). Others use the passive
  cache; see the chat README. iOS `chat.models` sets `activateRuntime: true`
  for Cursor and Droid, and `cursorSource: "sdk"` for Cursor, so a new key
  shows models at once.

## Unregistered actions are a silent-write hazard

A client learns what the brain can do from the descriptor list it receives at
connection time. The hosted web client's `CommandCaller`
(`apps/desktop/src/renderer/webclient/adapter/infra/commandCaller.ts`) looks the
action up there before sending anything, and an action the brain never
registered never reaches the wire.

For a **read** that is correct: no descriptor means no data, and the caller's
fallback (an empty list, a null summary) is the right offline shape. For a
**write** it is not — resolving a fallback reports a mutation that was never
sent. `CommandCaller` therefore throws `UnsupportedRemoteCommandError` for any
`idempotent: false` call whose action has no descriptor, instead of returning
the fallback. Surfaces render that as "unavailable on the connected ADE host".

Two rules follow:

- A web-reachable write needs a `register(...)` entry here, not just an adapter
  method.
- Some actions are deliberately absent. `ai.storeApiKey` is the canonical
  example: the web adapter redacts the key before sending, so a handler here
  would persist the placeholder rather than the credential. On the web, an
  ADE Cloud provider key goes to the account vault through the account server
  (`PUT /cloud/sign-ins/:id`), never through a brain.

ADE Cloud pins (the ADE Cloud binding and `cloud-saved:` copies of resting
cloud computers) never reach `CommandCaller`. The account adapter answers their
reads from the account server and GitHub, and refuses other calls with one
sentence. A call that does something goes to the lane's own computer after
it wakes. See the [web client](../web-client/README.md#ade-cloud-reads).

Note that lane presence (`lanes.presence.announce` / `.release`) is served
through synthetic descriptors declared in `syncHostService`, outside this
registry — a reader auditing coverage has to count those too.

## Gotchas

- **`viewerAllowed: false` means no remote peer at all.** The brain refuses
  it for every paired device ("Remote command … is not available to paired
  controller devices"), iOS and web alike. Use it only for work that must
  happen at the machine. Policy is declared by the runtime; a controller
  cannot opt in, so a gated action needs a runtime policy change.
- **`chat.models` is the brain's catalog.** Do not hardcode model ids. The
  brain decides the models, the credentials, the default model and
  `defaultReasoningEffort`. Fallback rows for older hosts lose to
  host-advertised tiers.
- **`lanes.delete` and `lanes.archive` are queueable.** An offline delete
  replays on reconnect. When a lane disappears, check the command queue too.
- **Do not make `personalChats.create` queueable.** Only an existing
  session's `personalChats.send` may queue.
- **Do not queue cross-machine acceptance.** Preparation, validation,
  preflight, acceptance and marking all need current runtime and Git state.
  `chat.acceptCrossMachineHandoff` is live-only and route-pinned; safe
  retries come from the destination's durable handoff id and capsule
  fingerprint. See [the handoff contract](./cross-machine-session-handoff.md).
- **`prs.createFromLane` needs GitHub auth on the brain.** Order: an env
  token (`ADE_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`), the ADE GitHub App
  user token, a stored PAT, the `gh` CLI from known absolute paths (launchd's
  PATH has no Homebrew), then `gh`'s `hosts.yml` token (host-level and
  `users:<login>:` layouts). With none, it fails before it calls GitHub.
- **`work.runQuickCommand` always creates a PTY.** Subscribe for output and
  stop it with `work.stopRuntime`. Without a PTY service it fails with `pty
  service not available`.
- **The brain owns the `work.startCliSession` provider list.** No `command`,
  `args` or `startupCommand` overrides. A new provider needs
  `apps/desktop/src/shared/cliLaunch.ts` and the `parseCliProvider`
  allowlist together; a phone that sends a new id to an old brain gets
  "requires provider".
- **`files.writeTextAtomic` runs no Git hooks or editors.** Services that
  need lint or format watch the file system.
- **The phone can edit files.** No mobile read-only gate exists;
  `mobileReadOnly` is in the workspace payload but nothing reads it. Path
  safety and the external-workspace block still apply.
- **External desktop file opens are not visible on mobile.**
  `files.openExternalPath` workspaces (`kind: "external"`,
  `external-local:*`) are left out of mobile `listWorkspaces`, and every
  mobile file action on one is refused (reads and search too), because the
  root can be anywhere on the desktop.
- **Registered does not mean callable.** `requireService` throws on the
  first call, so tests exercise each command path.
