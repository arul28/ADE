# Activity, notifications, and Live Activities

ADE uses one account-wide Activity stream for agent work and pull requests
across every signed-in machine and project. Desktop Activity, ADE Notch, the
iOS Activity drawer, APNs notifications, Lock Screen widgets, and Live
Activities all render the same items and route to the same destination.

The product name for the shared system is **Activity**. The compact native
macOS presentation is **ADE Notch**. Compatibility contracts still use
`attention` names, including `AttentionItem`, relay routes, IPC channels,
persistence fields, analytics/log identifiers, and the native helper product.

## Product rules

- Running work is ambient. It belongs in Activity, ADE Notch, widgets, and
  Live Activities, not in a stream of toast or push interruptions.
- `needs_you`, failures, failing checks, changes requested, and review requests
  can notify according to the user's policy.
- Completed and merged work remains visible until it is seen or dismissed.
- Every row owns an exact ADE destination. A PR can target Overview, Checks, or
  Review; an agent item can target a session, question, approval, or event.
- Account views group work by machine and project. They never assume the
  currently open project or the current machine is the whole account.
- Remote actions are conservative. Account items from another machine open the
  correct context; they do not execute a current-host App Intent by accident.
- Notification previews, Live Activity content, and ADE Notch honor the same
  `hideDetails` preference.

## Topology

```text
agentChatService ─┐
pty/session state ├─ pushPublisherService (brain; canonical item derivation)
prPollingService ─┘          │
                            │ HMAC machine auth + signed-in account token
                            ▼
                ade-push-relay (Cloudflare Worker + D1)
                    │                       │
                    │ account snapshots     │ APNs alert / Live Activity
                    ▼                       ▼
 Desktop + web + ADE Code + iOS        iPhone system surfaces
                    │
                    └─ desktop renderer snapshot
                              ▼
                     native ADE Notch helper
```

Each brain publishes a bounded full snapshot for its machine, covering every
project currently hosted by that brain rather than the project selected in any
one client. The relay merges machine snapshots into an account revision stream.
Signed-in desktop, hosted web, ADE Code, and iOS clients read that stream
incrementally through an account-scoped path independent of navigation
selection. They acknowledge items, report presence where supported, and update
account/device preferences. Exact destinations still identify the owning
machine, project, session, event, or PR tab.

The legacy paired-machine push routes remain available for older clients. Once
an account Activity publish succeeds, the brain suppresses duplicate legacy
alerts and the legacy per-machine Live Activity.

## Shared contract

The TypeScript source of truth is
`apps/desktop/src/shared/types/attention.ts`.

An `AttentionItem` includes:

- stable `id`, source `revision`, occurrence/update/expiry time;
- two fingerprints and an activity tier (see below);
- kind, event, and phase;
- machine and project identity;
- optional lane, provider, model, plan progress, and recent activity;
- public preview plus a separate privacy-safe preview;
- exact session or PR destination;
- bounded actions such as open, approve, deny, restart, rerun checks, mark
  seen, and dismiss;
- `seenAt` and `dismissedAt` acknowledgment state.

### Two fingerprints and the activity tier

An item carries a **content** fingerprint and an **alert** fingerprint, derived
in `apps/ade-cli/src/services/push/activityFingerprint.ts`. They answer two
different questions and are deliberately not the same value:

- The content fingerprint is *what the row looks like* — identity, phase, lane,
  provider, model, title, destination, action ids, plan progress, and the
  preview with elapsed durations and token/file counters normalized away. A
  running agent whose preview ticks from "12s" to "13s" therefore produces an
  unchanged snapshot, and the relay writes nothing.
- The alert fingerprint is *the stable identity of one phase entry* — for a PR,
  the item, event, phase, `statusSince`, and PR number. It survives the item
  being removed and republished, which is what stops a reconnecting machine
  from re-alerting a phone about work it already announced.

`activityTier` (`signal` / `ambient` / `idle`) is the item's own claim about
whether it is worth interrupting for. Only `signal` items are eligible to
notify. Legacy publishers omit both fingerprints and the tier; the relay falls
back to the single `fingerprint` for each and treats a missing tier as
alertable.

Contract version 1 (`ATTENTION_CONTRACT_VERSION`) limits text, actions,
progress counts, snapshots, and tombstones before data is stored or delivered.
It versions the *item shape*; the publish protocol is versioned separately (see
"Publish protocol 2" below). Relay validation also enforces:

- agent ids/events cannot masquerade as PR ids/events, and vice versa;
- the item id and embedded machine identity must match the authenticated
  publishing machine;
- session and PR destinations use the expected shape and known PR tabs;
- action payloads contain only bounded scalar values;
- plan progress is finite, non-negative, and internally consistent.

Source revisions are independent from account cursor revisions. Tombstones
carry the source revision that deleted the item, so delayed snapshots cannot
resurrect old work and delayed tombstones cannot remove a newer item.

Snapshots also carry their explicit `scope` (`account` or `machine`), the
`accountOwnerId` that was current when they loaded, and a user-facing
`availability` state. Mutations are fenced to that loaded owner. Machine-scope
acknowledgments additionally include the exact source revision for every item,
so a stale click cannot mark a newer failure or a different account's item as
seen. The brain persists machine acknowledgments by account owner + item and
rechecks ownership around each asynchronous relay reconciliation.

## Relay and trust model

The Worker lives in `apps/push-relay/`.

Machine publishing requires both:

1. the existing HMAC-signed machine request; and
2. a verified Clerk bearer token for the account receiving the snapshot.

Account clients use the verified bearer token for snapshot, acknowledgment,
presence, preferences, device registration, and activity-token routes. Clerk
production and secondary/development issuers are configured as complete,
distinct issuer/JWKS/OAuth-client triples and selected by the token's exact
`iss`. Verification accepts RS256 only. Clerk native session tokens may omit
`aud`; OAuth access tokens that carry audience metadata must match the
configured OAuth client through `aud` or `azp`. The relay hashes verified
issuer plus subject into the D1 account key so equal opaque subjects from
different Clerk instances cannot share data.

JWKS transport/parse failures are a configuration/service outage (`503`), not
a false sign-out (`401`). Deployment runs schema/trigger validation separately
from authentication verification: it refuses to start without both Clerk
secret triples and short-lived primary/secondary smoke tokens, deploys, checks
the fixed `/health` authentication flags, then calls the real authenticated
account snapshot endpoint once per issuer. A green migration or Worker upload
therefore cannot mask an account endpoint that rejects every valid user.

Every iOS installation also persists a positive, JavaScript-safe monotonic
`ownershipEpoch`. Account device PUT and DELETE bodies both carry that epoch.
Sign-out commits an unowned epoch before revocation; a direct account switch
commits `account A → unowned → account B`, so the old-account DELETE and the
new-account PUT never tie. Relay retains the latest epoch even after deletion
and returns `409` for a stale or equal-epoch foreign-owner mutation. The phone
treats that response as safely superseded rather than retrying an obsolete
request. Registration PUTs are serialized and queued refreshes coalesce to the
latest request, so network reordering cannot restore an earlier account owner.

The account routes are:

```text
GET    /attention/account/snapshot?since=<revision>
POST   /attention/account/ack
POST   /attention/account/presence
GET    /attention/account/preferences
PUT    /attention/account/preferences
PATCH  /attention/account/preferences/devices/:deviceId
PATCH  /attention/account/preferences/machines/:machineKey
PUT    /attention/account/devices/:deviceId
DELETE /attention/account/devices/:deviceId
PUT    /attention/account/devices/:deviceId/activities/:activityId
DELETE /attention/account/devices/:deviceId/activities/:activityId
POST   /machines/:machineKey/attention
```

D1 stores account revisions, machine links, items, tombstones, device
registrations, Live Activity state/tokens, presence, preferences, and delivery
receipts. Snapshots and fan-out are capped. Expired items, old tombstones, and
stale presence are pruned.

APNs registrations and invalid-token cleanup retain the existing push relay
behavior. See `apps/push-relay/README.md` for deployment variables, Clerk
issuer configuration, APNs configuration, abuse limits, and migrations.

## Brain publisher

`apps/ade-cli/src/services/push/pushPublisherService.ts` owns machine item
derivation. It publishes the same state that desktop and mobile display rather
than rebuilding notification meaning in each client.

The publisher:

- observes chat approvals/questions/failures/completions, tracked CLI session
  state, and PR notification transitions;
- republishes a full bounded machine snapshot on changes and a 30-second
  heartbeat so presence and long-running state recover after disconnects;
- uses unchanged heartbeats to retry a failed or missed account Live Activity
  start; successful starts remain deduplicated by durable state and content
  fingerprint;
- includes every active project known to that brain, not just the foreground
  desktop project;
- keeps recent terminal outcomes long enough for acknowledgment;
- emits exact PR tabs and exact session pending-item/event anchors;
- persists seen/dismissed mutations made while the account stream is degraded,
  partitioned by account owner and source revision, then reconciles them only
  after a successful account publish;
- skips duplicate legacy notifications and Live Activities after a successful
  account publish.

### Publish protocol 2

Every publish response carries a `protocol` number, and the publisher records
the highest one the relay has reported. Protocol 2 replaces "always send the
whole machine" with three modes on `POST /machines/:machineKey/attention`:

| Mode | When | What it sends |
| --- | --- | --- |
| `reconcile` | first publish after start, after an account change, and after any cap shrink | the full roster, paged, with `final: true` on the last page |
| `delta` | ordinary changes | only the items that changed, paged if they exceed one wire page |
| `presence` | the 30 s heartbeat with nothing to say | no items — it exists to hold presence and to let a due alert retry |

Each publish stamps a monotonic `rosterEpoch`. A `reconcile` run bumps the
epoch, and its `final` page seals it: anything still carrying an older epoch for
that machine is state the machine no longer claims, so it is removed in one
commit rather than by inference from an absent id. A `delta` reuses the current
epoch and therefore never implies a deletion, which is what makes it safe to
send a partial list at all.

The relay echoes current acknowledgment state (`acks`) on every publish,
including the no-op paths, so a brain that came back from a disconnect learns
what other devices already dismissed without waiting for its own read. If the
account item cap truncates the publish, the response says `itemsTruncated` and
the publisher schedules a fresh reconcile rather than leaving the relay holding
a silently trimmed roster.

A relay that reports `protocol` below 2 does not understand any of this. The
publisher notices, falls back to the legacy full-snapshot publish, and keeps a
reconcile pending so the first protocol-2 response resynchronizes cleanly.

The paired-machine compatibility publisher tracks Live Activity delivery per
phone. A failed start, update, or end retries only that phone while healthy
phones continue receiving new content, and relay suppression is keyed per
device so a sibling phone's success cannot falsely satisfy the retry.

## Delivery policy and preferences

Balanced defaults:

| Event | Default |
| --- | --- |
| Running / progress | Ambient |
| Needs you | Notify |
| Failed / checks failing / changes requested | Notify |
| Review requested / merge ready | Notify |
| Completed / merged / opened / closed | Ambient |

Preferences support account defaults plus device, project, and machine
overrides. The `machines` scope is keyed by machine key and is what "mute this
Mac" writes: it silences one machine's items everywhere rather than muting a
category on one phone. Its size is capped like the other scopes:

- event delivery policies;
- notifications;
- Live Activities;
- desktop-first delivery and its delay;
- sounds (off by default);
- celebrations;
- hidden preview details;
- quiet hours;
- muted sessions.

Device-registration preferences are a compatibility fallback. Account
preferences override those registration defaults, and only an explicit
`devices[deviceId]` entry in the account preference document overrides the
account defaults for one device. The iOS Push delivery controls write that
explicit per-device account override through an atomic scoped mutation,
including the phone's muted-session selection. Account/project writes preserve
device overrides, so the visible switch state and relay policy cannot drift
apart or overwrite a simultaneous edit from another client. A failed phone
preference mutation retries with capped exponential backoff until it succeeds,
the account changes, or a newer local preference replaces it.

When desktop-first delivery is enabled and a foreground Mac recently reported
presence, the relay waits for the configured bounded delay before notifying the
phone. The next machine heartbeat escalates an item that remains unseen.

Two gates run before any preference is consulted, because they are about
whether the item deserves an interruption at all:

- **Tier.** An item whose `activityTier` is not `signal` never alerts.
- **Staleness.** An item whose `updatedAt` is more than 15 minutes old never
  alerts. This is what makes a reconnect safe: a machine that was offline
  republishes its roster, and none of that recovered backlog fires a push.

Notification delivery is then deduped twice. A short-lived per
item/device/state delivery receipt claims the send, so two concurrent publishes
cannot both notify. Behind it, a durable **alert log** keyed by account + alert
fingerprint + device records what each phone was actually told, and is retained
for 30 days — well past the item's own lifetime. Deleting and republishing an
item therefore cannot re-alert, which the receipt alone could not prevent
because receipts are keyed by item id and pruned at 7 days.

Quiet hours, muted sessions, preview privacy, sound, and exact deep links are
applied before APNs fan-out. `needs_you` can use time-sensitive interruption;
other notifying events use active interruption. Alert pushes also carry
`content-available`, so the visible alert doubles as a background wake for a
snapshot refresh — foreground polling remains the guaranteed path, not this.

## Desktop Activity

`AttentionAccountCoordinator` in Electron main owns desktop reads and
mutations. For a signed-in user it talks directly to the account relay; it does
not ask the window's selected local or remote brain to proxy the account
snapshot. An old, disconnected, or unauthenticated selected machine therefore
cannot poison the global account view. One rejected relay request may force a
safe account-token refresh; a final auth/configuration failure becomes
actionable availability copy instead of exposing a raw RPC stack.

If account service is unavailable, the coordinator may ask **this Mac's local
brain** for a machine snapshot and labels it degraded. A signed-out desktop uses
the same local-only path and offers sign-in. If neither source is safe, the
surface reports which component failed and how to recover rather than inventing
an empty account.

`useActivitySync` remains mounted in `AppShell`, so the global-header control
and ADE Notch stay truthful across project switches and while `/activity` is
closed. The header count represents work waiting on the user (`needs_you`,
failed/blocked, and done-but-unreviewed); live work is an ambient pulse rather
than an inflated inbox count. Its keyboard-accessible popover previews the two
Activity buckets: Sessions, prioritized as Needs you → Working → Done, and
Inbox for PR/CI and other outcomes. Open all leads to the larger two-column
Activity pane with filters, settings, and an exact item-detail sheet.

The full route provides:

- Sessions and Inbox columns, with Needs you, Working, and Done session groups;
- all-machine, machine, and project scopes;
- a machine → project → item roster;
- an exact detail view with plan progress, recent activity, safe actions,
  seen/dismiss state, offline explanation, and retryable acknowledgment;
- account delivery/privacy controls.

Presence reports include foreground state, whether an ambient Activity surface
is visible, and the currently visible item ids. They are posted every 30 s while
the ADE window is visible and every 120 s while it is hidden, plus immediately
on focus, on blur, and on becoming visible again: a hidden window still has to
hold its claim, but it does not need to hold it at foreground rates, and a
120 s-stale "hidden" claim right as the user returns is the one case that
misleads other devices. Going hidden does not force an extra report, because
`blur` has already reported the foreground change.

An item is marked seen only after its exact destination opens successfully.
Account changes and stale machine revisions fail closed and require a refresh.

Every snapshot read is bounded twice. The local-brain fallback is issued as a
sync call carrying the 30 s sync-domain timeout rather than the connection
pool's ten-minute action budget, so an Attention poll cannot outlive the account
stream it is standing in for. Above it, the renderer races a 75 s backstop,
sized to clear a 15 s relay request, one forced 401 retry, and that 30 s
fallback in sequence — a shorter race would discard a slow-but-successful
snapshot and replace a real host error with a generic timeout. When the backstop
wins, Activity reports that it took too long and offers a retry instead of
leaving the header pinned on syncing.

## Hosted web Activity

The hosted browser adapter reads account Activity directly from the relay with
its in-memory Clerk access token, independently of the paired machine and
selected project used for Work, Files, and PR commands. It validates the entire
snapshot/preferences contract at the network boundary and performs at most one
forced token refresh after a 401.

Signed-out compatibility environments may read a real machine snapshot only
from their explicitly paired host through the viewer-allowed
`attention.getMachineSnapshot` command. Their acknowledgments return through
`attention.acknowledgeMachine` with the loaded account owner and source
revision. An older host that lacks those actions produces an Update host state;
the adapter never converts an unsupported call into an empty list. If the
browser account changes after a snapshot loads, opening or acknowledging that
snapshot is rejected until Activity refreshes under the new owner.

## ADE Code Activity

`/activity` opens an account-wide right pane grouped by needs-you, failures,
done-but-unreviewed, live, and recent work. The TUI calls machine-global
`attention.call`, not the selected project's action scope, so changing lanes or
projects does not change the account source. Enter opens the exact ADE
destination first and only then sends the revision/owner-fenced seen mutation.
`/attention` remains an unadvertised compatibility alias.

When signed out, ADE Code asks the connected host for its real machine snapshot
and labels the subset. Account failure may degrade to that same connected-host
view. A host without the Attention capability remains connected but shows its
name with update-and-restart guidance instead of a blank pane.

## ADE Notch

ADE launches one native SwiftUI/AppKit helper from the desktop lifecycle. The
Electron renderer supplies the already-synced Attention snapshot and settings;
the helper does not create a second account poller.

While ADE is hidden or minimized, the running helper asks the existing
renderer/runtime Attention path to refresh. A visible window ignores that
request and keeps its own 15 s renderer-owned poll, so the helper never
duplicates foreground work or talks to the relay independently.

The helper's cadence follows what is actually on screen: 15 s while it has a
live surface and the display is awake, 60 s otherwise — before the child has
reported a surface at all, and whenever the screen is locked or the system is
suspended, because nobody is reading a notch on a sleeping display. Lock and
suspend are tracked as two independent facts, since sleeping does not always
lock the machine and a resume must not declare the screen awake while it is
still locked. Changing the interval rebuilds the timer rather than leaving the
old one running, and a respawned helper starts with no surface again instead of
inheriting the dead child's.

If a connected host is too old to expose `attention.call`, ADE surfaces
update-and-restart guidance instead of presenting an empty notch as if no work
existed.

The helper uses a borderless non-activating `NSPanel` above the status bar,
joins Spaces/full-screen, and keeps the outer window fixed while the inner
silhouette animates.

On a MacBook with a physical notch:

- geometry comes from `safeAreaInsets`, `auxiliaryTopLeftArea`, and
  `auxiliaryTopRightArea`;
- compact content lives in the visible side ears, never under the camera
  housing;
- the black silhouette remains visually connected to the hardware notch.

On a display without a physical notch, ADE uses a menu-bar status item as the
persistent entry rather than pretending the display has hardware it does not.
The status item uses the shipped ADE app icon plus a small
idle/live/needs-you/error state badge. Hover or click opens a transient,
screen-edge-safe panel anchored under that icon; the resting top-center
imitation notch is absent. Right-click uses the same icon as the anchor for
controls.

Interaction rules:

- compact state identifies focused work and phase with a real provider mark;
- the user can choose Compact + peek, Reveal on hover, or Click only, disable
  the tall expanded panel, or hide ADE Notch entirely;
- Reveal on hover is dormant until the pointer enters a bounded top-edge or
  status-item hot zone; Click only never grows on hover;
- right-click anywhere on the physical surface or the menu-bar item opens the
  same native menu: Open Activity, Refresh, presentation mode, expanded
  panel policy, and a confirmed Hide action with restore guidance;
- ordinary running work and needs-you changes update status without overriding
  the user's reveal policy;
- incoming updates do not replace a card currently under the pointer;
- completion remains until seen/dismissed;
- celebrations are bounded one-shot effects and respect Reduce Motion;
- hit testing covers only the drawn/interactive shape, leaving the menu bar
  usable.

The helper sends open and acknowledgment requests back through typed IPC. Exact
ADE destinations are validated before the desktop navigates.

## iOS Activity drawer

The mobile app stores the account snapshot in the App Group container using the
same delta/tombstone/expiry rules as desktop.

A signed-in app polls the account snapshot every 20 s while it is foreground,
and stops on background or sign-out. Each start bumps a generation counter that
the loop rechecks after every sleep, so repeated starts cannot leave two pollers
running and a stopped poller cannot resume after its account changed. This poll
is the guaranteed freshness path; the `content-available` flag on alert pushes
is an opportunistic wake on top of it, not a substitute.

Acknowledgments made while the relay is unreachable go to an App Group-backed
**pending-ack queue** partitioned by account owner, and drain on the next
successful refresh. Reads normalize duplicate item ids, so a crash between
enqueue and cleanup cannot multiply relay writes. The queue is bounded three
ways — 200 entries per owner, 24 hours of age, and 5 failed attempts per entry —
so an acknowledgment the relay will never accept expires instead of retrying
forever.

The global Activity drawer shows all signed-in machines and projects. Project
drawers are lenses over that same account model, not separate notification
inboxes. Tapping an item follows its exact destination. Remote items expose only
actions that are safe without assuming the currently paired host owns them.

Account-only signed-in users can register APNs and Live Activity tokens without
pairing a machine. Sign-out best-effort deletes the account device registration
and ends account-wide local Live Activities.
ActivityKit authorization is independent of alert permission. Disabling Live
Activities sends an explicit push-to-start-token clear to every active account
and paired-machine route; omitted tokens preserve the existing registration.

## Live Activity and widgets

There is one account-wide `agent-runs` Live Activity per iPhone. The relay
prioritizes and caps up to three agent rows and two PR rows.

- Ordinary open PRs do not keep the activity alive.
- Running, starting, needs-you, and blocked agent work contributes to the active
  count.
- Completed/merged outcomes remain until seen, then disappear.
- Disabling Live Activities actively ends an existing account activity.
- When `hideDetails` is enabled, per-device content is redacted before APNs
  delivery while preserving internal ids needed for exact routing.
- Account-wide starts and content carry the installation's non-PII monotonic
  `ownershipEpoch`. The app ends activities whose attribute/content epochs do
  not match the current account owner. The widget extension applies the same
  check before rendering and shows only a neutral Updating ADE state during the
  brief interval before the app can end a delayed old-account activity.

The Lock Screen and Dynamic Island lead with one focused item and show a small
overflow count instead of presenting a miniature monitoring dashboard. Each
secondary row owns an element-level `Link`, so tapping a PR or agent opens that
row rather than one activity-wide fallback URL.

Account Live Activity `Run` and `PullRequest` rows carry the source
`accountMachineKey` as an additive optional wire field. Their exact ADE links
preserve that key together with the session item/event or PR tab anchor. Older
payloads without the field remain decodable, but account-wide payloads include
it so the app can adopt/select the owning machine before opening the row.
Account APNs alert payloads carry the same routing key.

Interactive approval App Intents remain available only where the activity is
known to belong to the current host. Account-wide remote items use exact Open
or Reply navigation instead of executing an action against the wrong machine.

The Lock Screen widget reads the same App Group snapshot and applies the same
priority, phase vocabulary, privacy, and routing rules.

## Validation boundaries

Simulator and unit validation can prove snapshot merging, expiry/tombstones,
preference mapping, exact links, intent safety, widget decoding, and rendering.

A physical iPhone is still required to prove real APNs delivery,
push-to-start-token minting, background Live Activity updates, and system
notification presentation.
