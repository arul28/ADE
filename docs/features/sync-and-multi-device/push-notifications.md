# Activity, notifications, and Live Activities

DAEX has one account-wide **Activity** stream for agent work and pull requests
across every signed-in machine and project. Desktop Activity, the iOS drawer,
APNs pushes, widgets and the Live Activity render the same items and route to
the same destination. Wire and storage names still say `attention`
(`AttentionItem`, relay routes, IPC channels, log ids).

Activity is account data: the relay (`apps/push-relay/`) holds it and every
client reads the same answer; navigation still carries the owning machine,
project and session.

## Source file map

- `apps/ade-cli/src/services/push/pushPublisherService.ts` — the brain's
  publisher for every project it hosts; the durable machine-revoked gate;
  agent messages.
- `apps/ade-cli/src/services/push/attentionItemBuilder.ts` — the item
  projection `(runs, recentRuns, prActivities, roster) → AttentionItem[]`.
- `apps/ade-cli/src/services/push/activityFingerprint.ts` — content and alert
  fingerprints, `activityRosterFingerprint`.
- `apps/ade-cli/src/services/push/pushRegistrationStore.ts`,
  `pushRelayClient.ts` — durable delivery state; the relay client (one forced
  refresh after a 401, owner fences).
- `apps/ade-cli/src/services/account/machinePairingRepair.ts` — re-pairing after
  removal.
- `apps/desktop/src/shared/types/attention.ts` — the cross-client contract,
  acknowledgment chunking (`ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT`,
  `runAcknowledgmentChunks`).
- `apps/desktop/src/shared/attention/activityBoardColumn.ts` (+
  `activityBoardColumn.cases.json`), `activityStateGroup.cases.json`,
  `apps/desktop/src/shared/activityCatalog.ts` (events and default policy).
- `apps/desktop/src/main/services/attention/` — `attentionAccountCoordinator.ts`
  (desktop reads and writes), `remoteProjectIdentity.ts`,
  `attentionOpenErrors.ts`, `userActivityProbe.ts`.
- `apps/desktop/src/main/services/deeplinks/localProjectResolution.ts`,
  `projectNavigationWindowSelection.ts` — opening an item.
- `apps/desktop/src/renderer/components/activity/` — `ActivityPanel.tsx`,
  `HeaderActivityControl.tsx`, `ActivityPane.tsx`, `ActivityCard.tsx` (read its
  header comment before reusing `SessionCard`), `activityPriority.ts`,
  `activityPresentation.ts`, `useActivitySync.ts`; state in
  `renderer/state/activityStore.ts`.
- `apps/desktop/src/renderer/webclient/adapter/attention.ts` — the web reader.
- `apps/push-relay/src/attention.ts`, `attentionAuth.ts`, `liveActivity.ts`,
  `attentionShared.ts`, `relay.ts` — merge, auth, APNs, Live Activity, routes.
- iOS: `PushNotificationService.swift`, `LiveActivityService.swift`,
  `Views/Activity/`, `Shared/ActivityRowPresentation.swift`, `ADEWidgets/`; see
  [iOS companion](ios-companion.md).

## Product rules

- **Activity is an agent feed.** Sessions carry `kind: "agent"` items. PRs,
  checks and reviews go to a separate Inbox, so a lane with an open PR shows
  once.
- Only urgent events push by default (needs you, failed, checks failing);
  running work is ambient.
- A push is two short lines (title; state and where). Agent text never goes in
  a push, except an agent message the user asked for.
- Every row has an exact destination (a PR tab; a session, question, approval or
  event).
- Account views never assume the open project or machine is the whole account.
- Opening an item from another machine pairs, connects and opens, and names the
  step that failed.
- Remote items never run a current-host App Intent.
- Previews and Live Activity content honor `hideDetails`.

## The four states

Every surface counts agents in the Work board's columns:

| Column | Tone | Means |
| --- | --- | --- |
| `needs_you` | amber | a question, an approval or a failure |
| `working` | blue | mid-turn |
| `waiting` | neutral | snoozed, scheduled wake, busy subagent, or lane PR with CI running / review requested |
| `done` | emerald | finished, resting, settled |

The brain writes `boardColumn` and `waitingReason` (`snoozed`, `ci`, `review`,
`scheduled`, `subagent`) on each agent item. Readers group with
`activityBoardColumn`, which trusts a valid published column and otherwise
derives one from the phase (never Waiting). It exists in TypeScript, Swift and
the relay; `activityBoardColumn.cases.json` pins all three — change the cases
first. The older six-group table lives in the relay (for old Live Activity
builds) and is pinned by `activityStateGroup.cases.json`.

## Topology

Each brain publishes a bounded snapshot of every project it hosts, signed with
the machine HMAC **and** the account's Clerk token. The relay merges machine
snapshots into an account revision stream. Desktop, web and iOS read it
incrementally through an account-scoped path, acknowledge items, report presence
and edit preferences. Once an account publish succeeds the brain suppresses the
legacy per-machine alerts and Live Activity.

## Shared contract

`AttentionItem` (`shared/types/attention.ts`): id, source `revision`, times,
fingerprints and tier, kind/event/phase, machine and project, optional lane,
provider, model, `chatActivityMode`, plan progress, previews (public and
privacy-safe), exact destination, bounded actions, `seenAt` / `dismissedAt`.
`ATTENTION_CONTRACT_VERSION` versions the item shape; the publish protocol is
versioned separately.

- **Two project ids.** `projectId` is the publishing machine's local id and
  resolves nowhere else; `canonicalId` is `deriveProjectId(rootPath)` and is
  optional (the relay drops it). `rootPath` is the identity both sides agree on.
- **`chatActivityMode`** is one literal, `"planning"`, separate from the frozen
  phase vocabulary; unknown values degrade to the phase.
- **Background work.** A run whose turn ended while background tasks live stays
  `running`; the terminal phase is held in `deferredTerminalPhase` and published
  once.
- **Fingerprints.** The content fingerprint is what the row looks like (with
  durations and counters normalized), so ticking progress writes nothing. The
  alert fingerprint is one phase entry's identity and survives a republish, so a
  reconnecting machine cannot re-alert. `activityTier` (`signal` / `ambient` /
  `idle`): only `signal` notifies.
- **Tombstones** carry the deleting revision, so delayed snapshots cannot
  resurrect work. Snapshots carry `scope`, `accountOwnerId` and `availability`;
  mutations are fenced to the loaded owner.

### Acknowledgments

The relay fences an acknowledgment on `alertFingerprints` (the alert the caller
had on screen), not on the revision, so "Clear all" cannot clear a newer
`needs_you`. A request carries at most 64 ids
(`ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT`, the relay's hard bound); callers
**chunk, never truncate**, and abort on the first throwing chunk. The outcome
has `acknowledged`, `stale` (refused: roll back, refresh) and `unreached` (no
answer: roll back, report the transport failure).

## Relay and trust model

- Machine publishing needs the HMAC-signed request and a verified Clerk bearer.
  Issuers are distinct issuer/JWKS/OAuth-client triples selected by `iss`; RS256
  only. Account keys hash issuer plus subject. A JWKS failure is `503`, not a
  sign-out.
- **Device ownership.** Each iOS install keeps a monotonic `ownershipEpoch`;
  device PUT and DELETE carry it, sign-out commits an unowned epoch, and the
  relay answers `409` to a stale epoch.
- **Routes** are under `/attention/account/*` (snapshot, ack, presence, notify,
  preferences and their scope patches, devices, activities, machines, pairing)
  plus `POST /machines/:machineKey/attention`; anything else is 404.
- **Browsers** may call only `BROWSER_ACCOUNT_ROUTES` (`apps/push-relay/src/relay.ts`:
  snapshot, ack, presence, preferences, account settings). Any other account
  route with an `Origin` header is 403, so the vault and device changes stay
  native-only.
- D1 holds revisions, items, tombstones, revocations, devices, Live Activity
  state, presence, preferences and receipts. Heavy sweeps
  (`sweepExpiredAttentionItems`, `sweepOrphanedMachineActivity` for machines
  silent 14 days) are cron-only. Every deletion emits a tombstone through
  `commitAttentionRevision`.
- Deployment and APNs config: `apps/push-relay/README.md`.

## Machine removal and re-pairing

Removal is terminal. `DELETE /account/machines/:machineKey` (account directory)
writes the revocation first, deletes the row, then asks the relay to purge; a
failed purge is `502 activity_purge_failed` with `machineRemoved: true`
(`AccountMachineActivityPurgeError`). The relay's purge tombstones the machine's
items, records the revocation and drops its delivery targets, after checking the
account knows the key. Revoked machines get `403 machine_revoked` on publish (by
account) and on legacy routes (any account); the brain latches it durably
(`machineRevokedAt`).

### Proving a fresh sign-in

Getting back needs a `pairing: true` registration plus either an `auth_time` /
Clerk `fva` under 10 minutes (never `iat`), or a single-use pairing grant minted
at the end of a device-flow sign-in (`POST /device/token`; only its SHA-256 is
stored, 10-minute TTL, spent by one conditional `DELETE`). That is why repair
uses the device flow, not loopback PKCE. On success the directory restores the
relay pairing (`DIRECTORY_AUTH_SECRET` on `x-ade-directory-auth`) before
deleting the revocation.

### The repair itself

`repairMachinePairing` publishes to the directory first and clears the push gate
**only after the directory accepts** (a machine back on the roster but not
delivering is worse than one plainly gone). `reasonCode` is a plain string:
unknown means unknown. Entry points: `daex machines reconnect` (alias `repair`),
`account.call { action: "repairMachinePairing" }` (CTO-gated; also run with
`onlyIfRevoked` after a login), **Reconnect this computer** on the desktop
(`renderer/lib/reconnectThisComputer.ts`), and `machinePairingAutoRecovery`
([sync README](README.md#getting-back-on-after-a-refusal)).

## Brain publisher

`pushPublisherService.ts` publishes what desktop and mobile show; clients do not
rebuild notification meaning. It republishes on change; on a 30 s heartbeat it
rebuilds the roster and posts `presence` when `activityRosterFingerprint` is
unchanged (after four unchanged rebuilds, rebuilds back off to every two
minutes). Seen/dismissed made while degraded persist per account owner and
reconcile after a good publish.

### Item derivation

`attentionItemBuilder.ts`:

- Identity chats (CTO) are excluded; child shells fold into their parent.
- `runHasBackgroundWork` keeps a completed run `running` (never overrides
  `failed`); `resumeRunOnActivity` waits 10 s so a flap cannot mint three alert
  entries.
- Chat title and plan mode are polled: `refreshChatRunMeta` re-reads the summary
  every 10 s (`CHAT_META_REFRESH_MS`) through one `applyChatSummary`.
- Lifetimes: running 2 h, outcomes 24 h, idle roster rows 7 days (only the
  owner can tombstone, so every row expires). A session delete tombstones at
  once.
- The roster beats a frozen run; a snoozed chat (not failed or asking) publishes
  as `stale` / `idle`.
- `prActivityId` needs owner and repo; otherwise it drops the event rather than
  minting duplicates.

### Publish protocol 2

`POST /machines/:machineKey/attention` has three modes: `reconcile` (full roster,
paged, `final: true` seals a new `rosterEpoch` and removes anything older),
`delta` (changed items; never implies a deletion) and `presence` (no items). The
relay echoes `acks` on every publish and reports `itemsTruncated`, which
schedules a reconcile. A relay below protocol 2 gets the legacy full snapshot.

## Delivery policy and preferences

Defaults (`defaultPolicy` in `activityCatalog.ts`, mirrored by
`DEFAULT_NOTIFY_EVENTS` in the relay): Needs you, Failed and Checks failing
notify; everything else is ambient. `eventPolicyDefaultsVersion` upgrades old
saved maps (version 2 moved review/merge-ready to ambient; version 3 raised the
desktop-first delay).

- **Scopes.** Account defaults with device, project (keyed by the normalized Git
  identity), and machine overrides, merged per event
  (`resolveScopedDeliveryPreferences` on the relay, `resolveAttentionScope` on
  the desktop). Scope patches (`AttentionScopePatch`) take `null` to drop an
  override. Settings › Notifications › Events edits them.
- **Quiet hours** per scope, each with its saved time zone.
- **Desktop-first** (default on, `desktopFirstDelaySeconds` 120): while a
  non-phone client reported foreground presence in the last 45 s, the phone waits
  the delay. The desktop also reports `userActive` from the OS input clock
  (`userActivityProbe.ts`); while any computer is in use the phone stays quiet.
  The main process stamps the field; the relay caps `observedAt` at its own
  clock.
- **Gates before preferences:** only `signal` tier alerts, and nothing older than
  15 minutes (so a reconnect's backlog never pushes).
- **Dedupe:** a short per item/device/state receipt, then a 30-day alert log
  keyed by alert fingerprint.

### Push copy

`attentionAlertCopy` (relay): agent = session title / `state · project ·
machine`; PR = `#number title` / `state · project`; with Hide details, only
`Agent: Needs you` or `Pull request: Checks failing`. Lines cut at 64
characters. Approve/Deny items carry the `ADE_APPROVAL` category.

### A question is not an approval

`approval_request` with a question `requestKind` (`isQuestionKind`,
`shared/pendingInputAnswers.ts`) publishes as `waiting_for_input` with no
category; everything else (including no `requestKind`) is `waiting_for_approval`
with Approve/Deny. Dedupe is per card (`alert:<sessionId>:approval:<itemId>`).
The run keeps every open card (`AgentRunState.openCards`); a subagent's card
holds the run waiting past the parent's turn end. The privacy preview is "A DAEX
agent needs you."

### Muting one chat

`mutedSessionIds` is account-wide, edited only by
`PATCH /attention/account/preferences/sessions/:sessionId` (bounded 500); a
whole-document PUT keeps the stored list. A mute silences pushes, desktop
notifications and toasts; the row stays in Activity.

## Agent messages

`daex notify` inside a chat sends that chat's message (the chat comes from the
caller's identity).

- The brain limits 6 per chat and 30 per machine per hour, drops repeats within
  ten minutes, stores messages durably and keeps the newest 50. The chat gets a
  `user_notified` notice.
- Item: `kind: "message"`, `eventKind: "agent_message"`, Inbox only, 24 h, never
  counted. Only readers that send `include=message`
  (`ATTENTION_SNAPSHOT_INCLUDE_MESSAGES`) get message items (older clients reject
  unknown kinds); everyone gets the push.
- Alerts about one chat share the APNs `thread-id` `session:<sessionId>`.

## Desktop notifications

A fresh, unseen event set to Notify can raise a desktop notification while DAEX
is in the background, from the local brain (immediate) or the account snapshot
(other machines); one event alerts once. They follow project and computer
settings, mutes, quiet hours and Hide previews.

## Custom notifications

Outside a chat, `daex notify --title "<t>" [--body "<b>"] [--open <link>]` (or
the automation step for `attention.sendNotification`) sends to every phone on
the account: CLI → the machine-wide `notify.send` RPC → the relay's
`POST /attention/account/notify`. Title up to 64 characters, body 160; links must
be openable (`normalizeCustomNotificationLink` in
`shared/customNotificationLink.ts`) and are stamped with the owner machine
(`stampCustomNotificationLinkOwner`). The relay sends the text as written,
honoring notifications off, quiet hours, a muted machine and Hide previews.
**60 per account per hour** (`rate_counters`, bucket `notify:<account>`); past
it, `429` with `retryAfterSeconds`.

## Desktop Activity

`AttentionAccountCoordinator` (Electron main) talks to the relay directly, never
through the window's selected brain. With the account service down it may ask
this computer's brain for a machine snapshot, labeled degraded; signed out, the
same, with a sign-in offer. `useActivitySync` stays mounted in `AppShell`; the
header count is the Needs you column only.

`ActivityPanel.tsx`, fed by `activityPriority.ts` (`activityFeedItems`,
`activitySections`, `activityNotificationItems`, `summarizeActivity`), is one
panel in two sizes: a **Sessions / Inbox** switch, chips (All · Needs you ·
Working · Waiting · Done), rows by column with Done folded. The compact size is
the header popover (mounted only while open). The expanded size (`ActivityPane`)
adds filters, multi-select (Mark seen, Dismiss, Open — not Snooze or Settle,
which are session mutations on the owning machine) and a detail sheet.

### Opening an item from another machine

`resolveLocalProjectRoot` tries exact id, then the carried root path, then a
recomputed `deriveProjectId`; the remote twin (`resolveRemoteProjectBinding` in
`runtimeBridge.ts`) matches by root path with platform rules read from the path's
shape. A cross-machine item never rebinds the working window
(`selectWindowForProjectNavigation`). `describeAttentionOpenFailure` names the
failed step (`pair`, `connect`, `open`); `RemoteProjectNotFoundError` is a class
because recovery branches on it.

- **Presence** (`lib/presenceReporter.ts`): foreground, ambient surface visible,
  visible item ids, `userActive`; every 30 s visible, 120 s hidden, plus on focus
  changes (coalesced 250 ms). When the relay is unreachable the coordinator drops
  presence and answers preference reads with `null`, backing off 5 s → 5 min.
  Settings lock their controls until preferences load.
- An item is marked seen only after its destination opens.
- **Deadlines.** One relay request shares 20 s
  (`PUSH_RELAY_FOREGROUND_DEADLINE_MS`) on routes a person waits on, 60 s for
  background loops. A snapshot gives the relay 18 s, then falls back to this
  computer's brain within 25 s.

## Hosted web Activity

The web client shows the same panel while a page is open (no pushes). It reads
the relay directly with its in-memory Clerk token, validates the whole payload,
and refreshes the token once after a 401. Signed-out compatibility environments
read their paired host through `attention.getMachineSnapshot` /
`attention.acknowledgeMachine`; an older host produces an Update host state,
never an empty list.

## iOS Activity drawer

The app polls the account snapshot every 20 s in the foreground (a generation
counter stops duplicate pollers) and stores it in the App Group with the same
delta, tombstone and expiry rules. Acknowledgments made while offline go to a
pending queue per owner (200 entries, 24 h, 5 attempts). Project drawers are
lenses over the account model. Rows share `ActivityRowPresentation.swift` with
the widgets and the Live Activity. Account-only users can register APNs and Live
Activity tokens without pairing a machine.

## Live Activity and widgets

There is one account-wide `agent-runs` Live Activity per iPhone, and only the
relay starts it.

- The content leads with `columns: { needsYou, working, waiting, done }`; older
  builds also get `runs`, `prs`, `activeCount`, `groups`, `moreCount`.
- It lives while anything needs you, works or waits; the relay ends it when only
  Done remains.
- A needs-you change pushes at once; other count changes at most every 5 minutes
  (`LIVE_ACTIVITY_COUNT_REFRESH_MS`), re-checked on each machine heartbeat.
- `hideDetails` redacts per device before APNs. Starts and content carry the
  `ownershipEpoch`; the app and extension ignore a mismatched one.
- In the foreground, `LiveActivityService.refreshLocalContent` writes the merged
  feed locally (hash-deduped, at most once a second); the relay push is the
  backstop.
- `chatActivityMode` never spends a push on its own.
- Rows carry `accountMachineKey`; approval App Intents run only for the current
  host's items.
- Lock Screen: four tiles linking to `daex://activity?state=<column>`; the
  Dynamic Island shows Needs you, else Working.

### Widgets and freshness

`ADELockScreenWidget` serves the accessory families and, via
`ADEActivityHomeWidget.swift`, the Home Screen families from one App Group
snapshot. The snapshot carries its fetch time; surfaces derive `Freshness`
(fresh, aging after 10 minutes, untrusted after 2 hours, tagged), and the
timeline pre-dates an entry at the aging threshold. `BGAppRefreshTask`
(`com.ade.ios.activity.refresh`) and silent pushes refresh it and always reload
timelines. With no account feed the Home Screen falls back to
`LockScreenPriorityStatus`.

## Validation boundaries

Simulator and unit tests can prove merging, expiry, preferences, links, intent
safety and rendering. Real APNs delivery, push-to-start tokens, background Live
Activity updates and system presentation need a physical iPhone.
