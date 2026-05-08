# Remote Commands (`syncRemoteCommandService`)

Remote commands are the execution channel for controllers. A controller
(another desktop acting as a peer, or the iOS app) sends a `command`
envelope to the host; the host resolves it through
`syncRemoteCommandService`, runs the underlying action against the
host-side services, and replies with `command_ack` and then
`command_result`.

Source file: `apps/desktop/src/main/services/sync/syncRemoteCommandService.ts`
(~2,030 lines).

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

The host responds in two envelopes:

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

### Per-action policy

Every action carries a `SyncRemoteCommandPolicy`:

```ts
type SyncRemoteCommandPolicy = {
  viewerAllowed: boolean;       // can a read-only controller invoke?
  requiresApproval?: boolean;   // host prompts operator before executing
  localOnly?: boolean;          // never sent over the wire; local-only
  queueable?: boolean;          // queue locally if offline, replay on reconnect
};
```

Controllers read `SyncRemoteCommandDescriptor` from the host (via a
metadata channel or cached descriptor bundle) and gate UI accordingly
— the host policy is always authoritative.

## Registry

Commands are registered by calling `register(action, policy, handler)`
inside `createSyncRemoteCommandService`. The registry is a `Map<string,
RegisteredRemoteCommand>` built at service construction. Handlers
receive parsed-and-validated args and either return a result or
throw; thrown errors are wrapped into the `command_result.error`
envelope.

### Action categories

Listed in order of appearance in the registry:

**Lanes** (`lanes.*`)
- `list`, `refreshSnapshots`, `getDetail`
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
- `presence.announce`, `presence.release` — controller marks a lane
  as currently open / no longer open; the host decorates
  `LaneSummary.devicesOpen` with a 60 s TTL and fans out updates via
  `brain_status`.

**Work** (`work.*`)
- `listSessions`, `updateSessionMeta`, `runQuickCommand`,
  `startCliSession`, `closeSession`

**Chat** (`chat.*`)
- `listSessions`, `getSummary`, `getTranscript`
- `create`, `send`, `interrupt`, `steer`, `cancelSteer`, `editSteer`,
  `dispatchSteer`, `cancelDispatchedSteer`, `approve`, `respondToInput`
- `resume`, `updateSession`, `dispose`, `models`

`chat.dispatchSteer` (Claude V2 only) takes
`{ sessionId, steerId, mode: "inline" | "interrupt" }` and either folds
a queued steer into the active turn or interrupts the active turn so
the queued message runs next; it returns `{ ok, dispatchedAt }`.
`chat.cancelDispatchedSteer` rescinds an inline dispatch before the
model reads it, returning `{ ok, cancelled }`. The iOS companion uses
both via `SyncService.dispatchChatSteer` /
`cancelDispatchedChatSteer`.

**Git** (`git.*`)
- `getChanges`, `getFile`
- `stageFile`, `stageAll`, `unstageFile`, `unstageAll`,
  `discardFile`, `restoreStagedFile`
- `commit`, `generateCommitMessage`, `listRecentCommits`,
  `listCommitFiles`, `getCommitMessage`, `getFileHistory`
- `revertCommit`, `cherryPickCommit`
- `stashPush`, `stashList`, `stashApply`, `stashPop`, `stashDrop`
- `fetch`, `pull`, `sync`, `push`, `getSyncStatus`
- `getConflictState`, `rebaseContinue`, `rebaseAbort`
- `listBranches`, `checkoutBranch`

**Files**
- `files.writeTextAtomic`

**Conflicts** (`conflicts.*`)
- `getLaneStatus`, `listOverlaps`, `getBatchAssessment`

**PRs** (`prs.*`)
- `list`, `refresh`, `getDetail`, `getStatus`
- `getChecks`, `getReviews`, `getComments`, `getFiles`
- `createFromLane`, `draftDescription`, `land`, `close`, `reopen`,
  `requestReviewers`, `rerunChecks`, `addComment`
- `getMobileSnapshot` — aggregate read that returns
  `PrMobileSnapshot` (summaries, stacks, per-PR capabilities,
  create-PR eligibility, workflow cards). Consumed by the iOS PRs
  tab; see `ios-companion.md` for the shape.

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
4. Returns the typed args object expected by the host service.

Helpers (`asTrimmedString`, `asStringArray`, `requireString`, etc.) live
at the top of the file. A non-conforming args object causes the parser
to throw an explicit error like `"lanes.create requires name."`; that
error reaches the controller as `command_result.error.message`.

## Handler bodies

Handlers are thin glue onto host services. Most look like:

```ts
register("lanes.create",
  { viewerAllowed: true, queueable: true },
  async (payload) => args.laneService.create(parseCreateLaneArgs(payload)));
```

A handful have more logic:

- **`work.runQuickCommand`** — constructs a `PtyCreateArgs`, calls
  `ptyService.create`, and returns the PTY handle for the controller
  to subscribe to via `terminal_subscribe`.
- **`work.startCliSession`** — host-side mobile CLI launcher used by
  the iOS Work "new session" surface and by tap-to-resume on existing
  PTY rows. Args are validated through `parseStartCliSessionArgs`,
  which restricts `provider` to the allowlist
  `claude | codex | cursor | droid | opencode | shell` (any other
  value throws `"work.startCliSession requires provider."`), clamps
  `cols` to `[20, 240]` and `rows` to `[4, 120]`, and truncates
  `initialInput` at 20 KB. Provider-specific argv, env, and shell
  preambles come from `buildTrackedCliLaunchCommand` /
  `buildTrackedCliResumeCommand` in `apps/desktop/src/shared/cliLaunch.ts`
  — the same module the desktop Work tab uses — so the host owns the
  startup-command shape and a phone cannot smuggle in a free-form
  shell command (the `shell` provider takes no startup payload at all).
  Claude launches mint a pre-assigned `--session-id` upfront via
  `randomUUID()` so resume works as soon as the row exists. When
  `resumeSessionId` is set, the handler reuses the saved
  `resumeMetadata` (or the persisted `resumeCommand`) to rebuild the
  startup line. After `ptyService.create` returns, any `initialInput`
  is forwarded as keystrokes via `ptyService.writeBySessionId`. The
  result is `SyncStartCliSessionResult` (`{ sessionId, ptyId,
  session: TerminalSessionSummary | null }`) — the controller can
  immediately render the session card and call `terminal_subscribe`
  without an extra round-trip. The command-result journal persists
  only the returned session handle and summary, not the `initialInput`
  text, so reconnect replay does not leak the user's prompt into the
  host-side ledger.
- **`work.closeSession`** — looks up the session's PTY id and
  disposes the PTY.
- **`chat.create`** — resolves a missing `model` to the first
  available provider model via `agentChatService.getAvailableModels`
  before forwarding.
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
  in `syncHostService` directly (not in the remote command
  registry); the host upserts a per-lane `DeviceMarker` map and
  decorates outgoing `LaneSummary` payloads with `devicesOpen`.

### Lane response decoration

`syncHostService` wraps command results for `lanes.list`,
`lanes.getDetail`, `lanes.refreshSnapshots`, `lanes.getChildren`,
`lanes.create`, `lanes.createChild`, `lanes.createFromUnstaged`,
`lanes.importBranch`, `lanes.attach`, and `lanes.adoptAttached` to
inject `LaneSummary.devicesOpen` from the presence map. Controllers
therefore see up-to-date presence without a separate query.

## Service dependencies

`createSyncRemoteCommandService` takes a long list of optional host
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
  projectConfigService?,
  portAllocationService?,
  laneEnvironmentService?,
  laneTemplateService?,
  rebaseSuggestionService?,
  autoRebaseService?,
  logger,
}
```

Optional services that are missing cause their dependent actions to
throw `"<service> not available."` at call time. The `requireService`
helper centralises that check. This pattern lets the headless ADE CLI
server construct a narrower service set without crashing at command
registration.

## Supported-action discovery

The service exposes:

```ts
getSupportedActions(): SyncRemoteCommandAction[];
getDescriptors(): SyncRemoteCommandDescriptor[];
getPolicy(action: string): SyncRemoteCommandPolicy | null;
execute(payload: SyncCommandPayload): Promise<unknown>;
```

Controllers typically read descriptors at connection time, cache
them, and refresh on `brain_status` changes. The iOS Lanes /
Files / Work / PRs tabs use this to render action buttons only for
commands the current host supports under the current policy.

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
  after the host finishes the command.
- **Terminal sub-protocol** pairs with `work.runQuickCommand`,
  `work.startCliSession`, and `work.closeSession`. The controller
  invokes the command, then sends `terminal_subscribe` with the
  returned session id to stream output and enable input/resize control.
- **Chat sub-protocol** pairs with `chat.create` / `chat.send` +
  `chat_subscribe`. Same pattern: create / send the message through
  a command, subscribe to the transcript stream for incremental
  events. `chat.send` waits for the host-side dispatch acknowledgement
  before returning `ok`, so the phone does not clear its local echo
  while the desktop is still preparing the turn.
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
host-side `agentChatService` consumes the same shape end-to-end.

`parseChatModelsArgs` accepts `{ provider, activateRuntime? }`. When
`chat.create` is missing an explicit model, `resolveChatCreateArgs`
forwards `activateRuntime: true` only for the `opencode` provider so
the host actually launches the OpenCode probe server before resolving
a default model. All other providers use passive (cache-only) resolution;
see the chat README for the passive/active contract.

## Gotchas

- **`chat.models` returns the host's model catalog.** A controller
  must not hardcode model IDs. The host is authoritative about
  which models are wired up, which providers have credentials, and
  what the default model is.
- **`lanes.delete` and `lanes.archive` are queueable.** A
  disconnected controller can enqueue deletes that replay on
  reconnect. Be aware when reasoning about "why did this lane
  disappear" — check the command queue, not just the local DB.
- **`prs.createFromLane` requires the host's GitHub token.** On a
  headless ADE CLI host with no `ADE_GITHUB_TOKEN` /
  `GITHUB_TOKEN` / `GH_TOKEN`, the command fails with a clear
  error before reaching GitHub. This is deliberate fail-fast behavior.
- **`work.runQuickCommand` always creates a PTY.** There is no
  "run a command, give me just the output" variant; the controller
  must subscribe to the terminal stream and tear down with
  `work.closeSession`. This is why headless ADE CLI mode provides a
  stub PTY service that throws on `.create` — the action is not
  supported there.
- **`work.startCliSession` provider list is host-controlled.** The
  controller cannot pass `command` / `args` / `startupCommand`
  overrides — the host derives those from the provider name through
  `buildTrackedCliLaunchCommand`. To add a new provider you extend
  `apps/desktop/src/shared/cliLaunch.ts` and the
  `parseCliProvider` allowlist together; a phone client that hardcodes
  the new id without a host update will get a "requires provider"
  error.
- **`files.writeTextAtomic` does not invoke git hooks or editors.**
  It writes atomically to the lane worktree and that is all.
  Services that care about post-write side effects (lint,
  formatters) watch the filesystem independently.
- **Mobile file mutations respect `mobileReadOnly`.** The iOS app
  gates mutating file envelopes locally via
  `ensureMobileFileMutationsAllowed`, checking
  `FilesWorkspace.mobileReadOnly` before sending a `writeText`,
  `createFile`, `createDirectory`, `rename`, or `deletePath` request.
  The host's `MOBILE_MUTATING_FILE_ACTIONS` set mirrors this list so
  a hostile controller cannot bypass it.
- **`requireService` throws lazily.** A host missing a service does
  not cause registration to fail; it causes the first invocation of
  a command that needs that service to fail with a specific message.
  Tests should exercise each command path rather than assume
  "registered means callable."
- **Policy is host-declared, not controller-configurable.** The
  controller cannot opt itself into commands the host marked
  non-viewer-allowed. If a phone needs an action that is policy-gated,
  the fix is a host-side policy change, not a client workaround.
