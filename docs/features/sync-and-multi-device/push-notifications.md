# Attention, notifications, and Live Activities

ADE uses one account-wide Attention contract for agent work and pull requests
across every signed-in machine and project. Desktop Attention, ADE Notch, the
iOS Attention Center, APNs notifications, Lock Screen widgets, and Live
Activities all render the same items and route to the same destination.

The product name for the shared system is **ADE Attention**. The compact native
macOS presentation is **ADE Notch**.

## Product rules

- Running work is ambient. It belongs in Attention, ADE Notch, widgets, and
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
an account Attention publish succeeds, the brain suppresses duplicate legacy
alerts and the legacy per-machine Live Activity.

## Shared contract

The TypeScript source of truth is
`apps/desktop/src/shared/types/attention.ts`.

An `AttentionItem` includes:

- stable `id`, source `revision`, `fingerprint`, occurrence/update/expiry time;
- kind, event, and phase;
- machine and project identity;
- optional lane, provider, model, plan progress, and recent activity;
- public preview plus a separate privacy-safe preview;
- exact session or PR destination;
- bounded actions such as open, approve, deny, restart, rerun checks, mark
  seen, and dismiss;
- `seenAt` and `dismissedAt` acknowledgment state.

Contract version 1 limits text, actions, progress counts, snapshots, and
tombstones before data is stored or delivered. Relay validation also enforces:

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

Preferences support account defaults plus device and project overrides:

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

Notification delivery is receipt-deduped per item/device/fingerprint. Quiet
hours, muted sessions, preview privacy, sound, and exact deep links are applied
before APNs fan-out. `needs_you` can use time-sensitive interruption; other
notifying events use active interruption.

## Desktop Attention

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

`useAttentionSync` remains mounted in `AppShell`, so the global-header control
and ADE Notch stay truthful across project switches and while `/attention` is
closed. The header count represents work waiting on the user (`needs_you`,
failed/blocked, and done-but-unreviewed); live work is an ambient pulse rather
than an inflated inbox count. Its keyboard-accessible popover groups Needs you,
Failing or blocked, Done unreviewed, and Live now across machines/projects. The
full Attention Center is the secondary Open all/history destination.

The full route provides:

- Needs-you/inbox, live, and recent views;
- all-machine, machine, and project scopes;
- a machine → project → item roster;
- an exact detail view with plan progress, recent activity, safe actions,
  seen/dismiss state, offline explanation, and retryable acknowledgment;
- account delivery/privacy controls.

Presence reports include foreground state, whether an ambient Attention surface
is visible, and the currently visible item ids. An item is marked seen only
after its exact destination opens successfully. Account changes and stale
machine revisions fail closed and require a refresh.

## Hosted web Attention

The hosted browser adapter reads account Attention directly from the relay with
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
snapshot is rejected until Attention refreshes under the new owner.

## ADE Code Attention

`/attention` opens an account-wide right pane grouped by needs-you, failures,
done-but-unreviewed, live, and recent work. The TUI calls machine-global
`attention.call`, not the selected project's action scope, so changing lanes or
projects does not change the account source. Enter opens the exact ADE
destination first and only then sends the revision/owner-fenced seen mutation.

When signed out, ADE Code asks the connected host for its real machine snapshot
and labels the subset. Account failure may degrade to that same connected-host
view. A host without the Attention capability remains connected but shows its
name with update-and-restart guidance instead of a blank pane.

## ADE Notch

ADE launches one native SwiftUI/AppKit helper from the desktop lifecycle. The
Electron renderer supplies the already-synced Attention snapshot and settings;
the helper does not create a second account poller.

While ADE is hidden or minimized, the running helper asks the existing
renderer/runtime Attention path to refresh on a narrow cadence. Visible windows
keep their normal renderer-owned poll, so the helper does not duplicate
foreground work or talk to the relay independently. If a connected host is too
old to expose `attention.call`, ADE surfaces update-and-restart guidance instead
of presenting an empty notch as if no work existed.

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
  same native menu: Open Attention Center, Refresh, presentation mode, expanded
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

## iOS Attention Center

The mobile app stores the account snapshot in the App Group container using the
same delta/tombstone/expiry rules as desktop.

The global Attention Center shows all signed-in machines and projects. Project
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
