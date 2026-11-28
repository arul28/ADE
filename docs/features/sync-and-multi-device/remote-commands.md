# Remote Commands (`syncRemoteCommandService`)

Controllers (a desktop peer, the iPhone, the web client) act by sending a
`command` envelope to the brain; `syncRemoteCommandService` runs the action on
the brain's services and replies `command_ack`, then `command_result`.

Source: `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` (the
desktop file of the same name is a re-export). The action list is the
`SyncRemoteCommandAction` union in `apps/desktop/src/shared/types/sync.ts`.
"Host" and `syncHost` in code mean the brain.

## Shape

### Invocation

```ts
{ type: "command", requestId, payload: { commandId, action, args } }
// → command_ack    { commandId, accepted, status: "accepted" | "rejected", message }
// → command_result { commandId, ok, result?, error?: { code, message } }
```

### Per-action descriptor

Each action has a `SyncRemoteCommandDescriptor`: `scope` (`"runtime"` or
`"project"`) and a `SyncRemoteCommandPolicy`:

- `viewerAllowed` — any paired controller may call it.
- `controllerAllowed` — only an authenticated phone or browser controller (and
  a lane-share guest, which then hits its own rights gate), never a desktop
  viewer.
- `runtimeHostOnly` — narrows `viewerAllowed` to desktops paired as runtime
  hosts (`runtimeHostGranted`).
- `requiresApproval`, `localOnly` — refused remotely ("requires approval on this
  machine").
- `queueable` — the controller may queue it offline and replay it.

With neither `viewerAllowed` nor a matching `controllerAllowed`, the brain
answers `forbidden_command` ("… is not available to paired controller
devices"). The policy is the runtime's; controllers read descriptors on
connect (`getSupportedActions`, `getDescriptors`) and gate UI on them.

**Scope errors.** A project command with no `projectId` is `missing_project`; a
project the brain has not open is `project_not_open` (send
`project_switch_request` first).

**`host_unavailable`** comes from outside the registry: when no project host
owns the peer, `brainProjectActionsSyncHandler` answers with a typed snapshot
(`reason`, `conflict`, `recoveryEligible`). Clients retry a starting failure
(2/4/8 s) and offer **Fix connection** (`sync.recoverHost`, serialized, 90 s
bound) for a verified conflict. Recovery and owner details need a server-owned
grant (desktop runtime-host, or the recovery grant phones and browsers get only
from same-account adoption); PIN-only phones get a redacted diagnosis. iOS
treats the code as retryable but never queues an already-attempted live
`chat.send`.

**Mobile compatibility** (`apps/desktop/src/shared/syncMobileCompatibility.ts`).
`MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS` is checked against the registry
and advertised as `features.mobileCompatibility` (`limited` + `missingActions`,
never a refusal). `MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS` holds additive
commands newer phones feature-detect; they must never join the required set.
Each entry's comment says what the phone does without it. Change a command DAEX
Mobile uses → update that file and the iOS tests together.

## Registry

`register(action, policy, handler, scope = "project")` fills a `Map` at
construction. Handlers return a result or throw; a throw becomes
`command_result.error`. A missing optional service throws `"<service> not
available."` at call time (`requireService`), so a narrow runtime still starts.
Lane presence (`lanes.presence.*`) uses synthetic descriptors in
`syncHostService`, outside this registry.

### Action categories

The web client uses this registry too, so whole families back renderer
namespaces over the wire. Notable rules per family:

- **`account.getMachineInventory`** — viewer-allowed, token-free, only for an
  online connected machine.
- **`providerAccounts.*`** (runtime) — `list`, `getSettings`, `refresh` are
  viewer-allowed; changes and sign-in reads (link, device code) are
  controller-only. `providerAccountRemoteCommands.ts` forwards each to the
  `provider_instances` action domain.
- **`usage.*`** — `getAdeStats` (`scope` `account`/`machine`/`project`; `force`
  only for a user Refresh), `getUsageRollup` (this machine only; `null` = not
  ready), `getQuotaSnapshot` (cached, starts nothing), `refreshQuota` (no
  interactive auth). All viewer-allowed.
- **`lanes.*`** — CRUD, templates, environment, rebase, branch drift.
  `listUnregisteredWorktrees`, `attach`, `adoptAttached` are compatibility stubs
  kept because they are required mobile actions. `lanes.getDetail` and
  `lanes.refreshSnapshots` are conditional: `ifNoneMatch` equal to the payload
  `signature` returns `{ signature, notModified: true }`.
- **`work.*`** — sessions, quick commands, CLI launch, send, stop.
- **`session.*`** — the ten settle/snooze/wake actions, viewer-allowed and
  queueable; the only lifecycle path for phones and web.
  `session.settleSessions` accepts `dismissPendingInput` only with one session
  id (`dismissPendingInputBeforeSettle`, then settle). Snooze, wake reason and
  settle override inputs are parsed strictly (`parseSessionSettleOverride`;
  `"clear"`, `"none"`, `""` and null clear it).
- **`chat.*`** — create/send/steer/interrupt/approve, scheduled work, drafts,
  attachments (including the chunked file staging,
  [sync README](README.md#chunked-staging-for-file-shaped-attachments)),
  handoff, models, launches. `chat.getTranscript` pages with an opaque cursor
  and `cursorKind` (`byte` for agent runtimes, `index` for the headless
  fallback).
- **`personalChats.*`** (runtime) — go to `PersonalChatScope`, never the project
  chat service. Only `send` is queueable.
- **`git.*`** — status, staging, commits, stash, sync, undo/redo, conflicts,
  branches. `git.pull` `mode` is `ff-only` (default), `rebase` or `merge`.
  `git.resetToCommit` records `git_reset_<mode>` for undo.
- **`files.writeTextAtomic`**, **`terminal.list` / `activeForChat`**,
  **`conflicts.*`**, **`rebase.*`**, **`history.listOperations`**.
- **`search.query` / `search.indexStatus`** — viewer-allowed; the brain strips
  `callerScope` and never logs the query; lane-share guests cannot call them.
- **`github.*`** — status, `publishCurrentProject`, `getRequestBudget` (no
  network).
- **`projectConfig.get` / `save`** — viewer-allowed but drop `ai.apiKeys` and
  `providers` on read and keep the on-disk values on write.
- **`prs.*`** — list, refresh, detail bundle, checks, create, land,
  `setDraft` / `setAutoMerge`, `getMobileSnapshot`.
- **`cto.*`** — session and identity, home machine, memory, archive, Linear
  reads and the phone's Linear OAuth pair (`startLinearMobileOAuth` /
  `completeLinearMobileOAuth`). `cto.setLinearToken` / `clearLinearToken` are
  not viewer-allowed. `cto.getAttention` is strictly read-only (never creates a
  CTO session). See
  [Linear integration](../linear-integration/README.md#connecting-and-managing-from-mobile).
- **`macDesktop.*`** — registered only with the Mac Desktop service
  (`hello_ok.features.macDesktopStream`). `getStatus` is viewer-allowed;
  `start`, `stop`, `takeControl` and input are controller-only. The holder id is
  derived per socket (`web:<connection id>:<token>`), so a socket can renew or
  return only its own lease; a socket close returns its leases. Over 2 MiB
  queued, frames drop to the next keyframe.
- **`machine.updateImpact` / `machine.updateAndRestart`** — the sync twins of
  the runtime RPC; `controllerAllowed`, never queueable; installed only by a
  `daex serve` brain that owns its machine (`setMachineUpdateRemoteCommands`);
  one run per process (`joinOrStartMachineUpdate`). The requester's name comes
  from the pairing record.
- Also `apple.*`, `android.*`, `workTools.*`, `deeplinks.open`, automation and
  webhook commands (their `*RemoteCommands.ts` files).

Selected chat contracts:

| Action | Rules |
|---|---|
| `chat.recoverTurn` | Viewer-allowed, live-only; `wait`, `nudge`, `retry_same_runtime`, `restart_resume`. Older hosts have only `chat.recoverCodexTurn`. |
| `chat.resolveUnprocessedMessage` | Viewer-allowed, live-only, idempotent via a `user_message_resolution` receipt. |
| `chat.regenerateSessionMetadata` | Viewer-allowed, live-only; `fields` subset of `title`, `laneName`, `statusLine`. |
| `chat.resolveSmartLinkPreview`, `chat.resolveSourceFavicons` | Viewer-allowed reads through SSRF-guarded fetchers. |
| `chat.getMcpApp` / `chat.mcpAppRequest` | Read is viewer-allowed; a request is not, and a data-changing tool needs `userActivated: true`. |
| `chat.createScheduledWork`, `chat.resumeUsageLimitNow`, `chat.continueUsageLimitOnAlternate`, `chat.switchAccount` | Owner-only, live-only (they spend the owner's quota or change who pays). Refusals are `ok: false` answers. |
| `chat.dispatchSteer` | `mode` from `ACTIVE_TURN_DISPATCH_MODES` (`apps/desktop/src/shared/types/chat.ts`); an unsupported mode is refused, never downgraded. `dispatchedAt: null` means still staged. |
| `chat.interruptWithQueueMode` | `stop_and_clear` (default), `stop_only`, `stop_and_background`, `stop_and_clear_and_background`. `chat.restoreCancelledQueue` works for 8 s. |
| `chat.typeIntoCli` | Types into an agent CLI only at a free prompt (`delivered`, `deferred`, `held` up to six hours, `ended`). `holdUntilFree` defaults true; a repeat `clientMessageId` gets the first answer. |

`chat.modelCatalog` takes `mode` (`cached`, `refresh-stale`, `force`),
`refreshProvider` and `cursorSource` (chat surfaces pass `sdk` to skip the slow
CLI spawn).

## Argument parsing

Each action has its own parser over `Record<string, unknown>` (`requireString`,
`asTrimmedString`, …); a bad payload throws a plain message that reaches the
controller. Chat field parsers live in
`apps/desktop/src/main/services/chat/chatLaunchArgs.ts`. The handoff parsers check
shape only; the service validates the capsule.

## Handler bodies

- **`lanes.create`** fills omitted start choices from account and repository
  defaults.
- **`lanes.initEnv`, `lanes.applyTemplate`** use the shared
  `runLaneEnvironmentSetup`.
- **`lanes.suggestName`** names an auto-created lane in the background (not
  queueable); any failure keeps the deterministic `ade/<8 hex>` branch.
- **`work.runShellBlock`** runs a chat reply's shell block (script ≤128,000
  bytes, `SHELL_BLOCK_RUN_ENV`); controller-only, live-only.
- **`work.startCliSession`**: `provider` is `claude`, `codex`, `cursor`,
  `droid`, `opencode` or `shell`; the command is built by
  `buildTrackedCliLaunchCommand` (`apps/desktop/src/shared/cliLaunch.ts`), so a
  phone cannot send a free-form command. It also takes `instanceId`,
  `presetId`, `credentialId`, `linearIssues` (attached before spawn), delays.
  The lane worktree resolves first so `ADE_AGENT_SKILLS_DIRS` is lane-aware.
  The result journal keeps the handle and summary, never `initialInput`.
- **`work.getExternalSessionDetail`** returns 120-event pages compacted for
  mobile; see
  [External Session Import](../terminals-and-sessions/external-session-import.md).
- **`chat.create` / `chat.launch`** resolve a missing model through
  `resolveChatCreateModel`.
- **`prs.refresh`** returns snapshots up to 6 MiB per reply (open first); the
  rest are `omittedSnapshotPrIds`.
- **Reply size.** Results over 12 MiB (`SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES`)
  fail with `result_too_large`; the socket stays.

Lane results get `LaneSummary.devicesOpen` (60 s TTL) from `syncHostService`.

## Logging

`sync.remote_command.execute` (debug) with action and policy. Args are never
logged.

## Integration with other sync surfaces

- State effects arrive as replicated rows.
- After a PTY command the controller sends `terminal_subscribe`. With
  `features.rosterTerminal`, a host streams another open project's terminal named
  by the envelope `projectId` (`syncTerminalStreams.ts`). One terminal input
  ledger is shared across ingresses.
- `chat.send` returns `ok` after the runtime acknowledges dispatch;
  `routeActiveToSteer: true` turns a send during a turn into a steer (`steerId`,
  `queued`). A send that timed out is unknown: never replayed.
- Personal chats use `chatScope: "personal"` and no `projectId`.

## New-lane launch commands

The brain-owned "chat in a lane that does not exist yet" contract
(`apps/desktop/src/shared/types/chatLaunch.ts`): `chat.startLaunch`, `getLaunch`,
`listLaunches`, `cancelLaunch`, `retryLaunch`, `startLaunchNow`,
`queueLaunchMessage`, `completeLaunchClient`. All viewer-allowed and **not
queueable** (a lane from an old offline outbox would surprise the person).
`launchId` is the chat's session id, picked by the client. Every entry point
parses with `chatLaunchArgs.ts`. Without a `chatLaunchService`, all but
`listLaunches` (returns `[]`) throw. Progress is pushed as `chat_launch_event`
to every authenticated peer of the project (no subscription; payload adds
`projectId` and `projectRootPath`); clients load `chat.listLaunches` on connect
and merge by `sequence`. Stages and controls:
[Chat › New-lane launches](../chat/README.md#new-lane-launches).

## Unregistered actions are a silent-write hazard

The web client's `CommandCaller`
(`apps/desktop/src/renderer/webclient/adapter/infra/commandCaller.ts`) only sends
actions in the descriptor list. A read without a descriptor returns its
fallback; a **write** throws `UnsupportedRemoteCommandError`. So a web-reachable
write needs a `register(...)` entry. Some actions are absent on purpose:
`ai.storeApiKey` (the web adapter redacts the key; DAEX Cloud keys go to the
vault via `PUT /cloud/sign-ins/:id`). DAEX Cloud pins never reach `CommandCaller`
([web client](../web-client/README.md#ade-cloud-reads)).

## Gotchas

- **`chat.models` is the brain's catalog.** Do not hardcode model ids.
- **`lanes.delete` and `lanes.archive` are queueable**: an offline delete
  replays on reconnect.
- **Do not make `personalChats.create` queueable.**
- **Do not queue cross-machine acceptance**; retries reconcile by handoff id and
  capsule fingerprint ([handoff](cross-machine-session-handoff.md)).
- **`prs.createFromLane` needs GitHub auth on the brain**: env token, DAEX GitHub
  App user token, stored PAT, `gh` from known absolute paths, then `gh`'s
  `hosts.yml`.
- **`work.runQuickCommand` always creates a PTY**; stop it with
  `work.stopRuntime`.
- **The brain owns the CLI provider list**: a new provider needs
  `cliLaunch.ts` and the `parseCliProvider` allowlist together.
- **`files.writeTextAtomic` runs no hooks.**
- **The phone can edit files** (`mobileReadOnly` gates nothing); external
  desktop file workspaces are never visible to mobile.
- **Registered does not mean callable**: `requireService` throws on first call.
