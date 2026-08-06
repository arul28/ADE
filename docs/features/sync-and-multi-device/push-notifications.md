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

- **Activity is an agent feed.** The session list carries `kind: "agent"` items
  only. Pull requests, checks, and review outcomes keep pushing, badging, and
  toasting, but they render in a separate **Notifications** column rather than
  as rows beside the agent working on them — one lane with an open PR used to
  appear twice.
- Running work is ambient. It belongs in Activity, ADE Notch, widgets, and
  Live Activities, not in a stream of toast or push interruptions.
- `needs_you`, failures, failing checks, changes requested, and review requests
  can notify according to the user's policy.
- Completed and merged work remains visible until it is seen or dismissed.
- Every row owns an exact ADE destination. A PR can target Overview, Checks, or
  Review; an agent item can target a session, question, approval, or event.
- Account views group work by machine and project. They never assume the
  currently open project or the current machine is the whole account.
- Opening an item from another machine is expected to just work: ADE pairs,
  connects, and opens, and reports which of those three steps failed in the
  user's own words when it cannot.
- Remote actions are conservative. Account items from another machine open the
  correct context; they do not execute a current-host App Intent by accident.
- Notification previews, Live Activity content, and ADE Notch honor the same
  `hideDetails` preference.

## The state glyph language

Every surface that summarizes Activity reads from one five-group table. The
canonical implementation is `activityStateGroup` plus `ACTIVITY_STATE_GLYPHS` in
`apps/desktop/src/renderer/components/activity/activityPresentation.ts`.

| Group | Tone | Glyph identity | Means |
| --- | --- | --- | --- |
| `needs-you` | amber | filled dot | the reader's move |
| `failed` | red | warning triangle | it stopped on an error, or checks/review failed |
| `planning` | violet | note-pencil | the agent is deliberating |
| `working` | blue | dashed circle | live work, plus someone else's move (review requested, merge ready, blocked) |
| `done` | emerald | check circle | settled history |

The array order above is also the priority order (`ACTIVITY_STATE_GROUPS`), so
"which state does this surface lead with" is a lookup rather than a ladder. Two
rules matter more than the table itself: an `idle`-tier item is `done` no matter
which phase it preserved, and `planning` is never derived from a phase — it
comes only from `chatActivityMode`.

Section headings, glyph counts, the notch strip, the iOS rows, and the Live
Activity all mirror this table, and the mirrors cannot share code — the renderer
is TypeScript, the notch and iOS are Swift, and the relay is a hermetic Worker
that imports nothing from this repo. `apps/desktop/src/shared/attention/
activityStateGroup.cases.json` is the pin: every implementation runs the same
cases through its own mapper, so a change made anywhere but the canonical table
fails the other suites. Change the rule there first, update the cases, then let
the mirrors follow.

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
- optional lane, provider, model, `chatActivityMode`, plan progress, and recent
  activity;
- public preview plus a separate privacy-safe preview;
- exact session or PR destination;
- bounded actions such as open, approve, deny, restart, rerun checks, mark
  seen, and dismiss;
- `seenAt` and `dismissedAt` acknowledgment state.

### Two project ids

`AttentionProjectRef` carries both. `projectId` is the publishing machine's own
`randomUUID()` from its `ade.db` and resolves nowhere else — the same machine's
`projects.list` answers with the registry id `project_<sha256(rootPath)>`, so the
two spaces never intersect and resolving a cross-machine item by `projectId`
alone failed every time. `canonicalId` is that machine-independent
`deriveProjectId(rootPath)` form, and it is what `attentionDestinationDeepLink`
prefers when stamping a link. It is optional: an older publisher omits it, and
the relay parses and re-emits only `projectId`, `name`, and `rootPath`, so an
account-scope reader generally does not see it. `rootPath` is therefore the
identity both sides always agree on, and the reason resolution falls back to it
before ever trusting `projectId` across a machine boundary.

### `chatActivityMode`

Optional, additive, and currently one literal: `"planning"`. It mirrors what the
sidebar derives from `interactionMode === "plan"`. It exists as its own field
because the state glyph language names planning while `AttentionPhase` cannot
carry it — the phase vocabulary is frozen push wire, and widening it would break
every older client. Readers validate it at the boundary and fall back to the
phase, so a future value degrades to `working` rather than painting an unstyled
tone.

### Turn completion versus background work

A run that finishes its foreground turn while background subagents are still
alive stays published as `running`. The publisher tracks live background-task
ids per run and holds the terminal phase in `deferredTerminalPhase` until the
last one drains, so the terminal phase is published exactly once — when the work
is actually over — instead of announcing "done" over a session that is
demonstrably still working. Desktop's sidebar already treated an active
background-task count that way; this is the publisher's copy of the same fact.

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
`availability` state. Mutations are fenced to that loaded owner. The brain
persists machine acknowledgments by account owner + item and rechecks ownership
around each asynchronous relay reconciliation.

### Acknowledgments

Acknowledgments are no longer fenced on "did this client personally see the item
at this exact source revision". Revision is a raw epoch-ms that advances on every
publish, so a live agent outruns any poll and that fence rejected the normal
case. What remains is narrow: `alertFingerprints` maps `itemId -> the alert
identity the caller had on screen`, and the relay refuses only when the stored
alert has since changed. That is exactly the case worth refusing — an in-flight
"Clear all" swallowing a `needs_you` published after the poll — and items with no
quoted fingerprint stay unfenced, so one bulk call still clears an inbox.

One acknowledgment request may carry at most
`ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT` (64) item ids. That is the relay's own
hard bound: `handleAcknowledgment` rejects a larger request with 400 before
parsing anything else, because every id becomes one statement in a single D1
batch. Callers with more than 64 ids therefore **chunk, never truncate** —
`chunkAttentionAcknowledgmentItemIds` and `runAcknowledgmentChunks` in
`shared/types/attention.ts` are shared by the Electron coordinator and the
browser adapter so the two shells cannot drift. Three hosts still truncate at
the same 64 internally (`multiProjectRpcServer.ts`, `syncRemoteCommandService.ts`,
and the desktop action registry); client-side chunking is the only reason those
truncations are unreachable, which is why raising the limit alone is a
regression rather than a fix.

Chunking **aborts on the first throwing chunk**. A chunk that throws is systemic
(expired auth, network down, relay 5xx) — item-specific refusals come back as
returned ids without throwing — so pushing the remainder at a host that just
failed only multiplies the damage. The result is `AttentionAcknowledgmentOutcome`,
three disjoint lists that together cover every id the caller sent:

| List | Meaning | Caller's move |
| --- | --- | --- |
| `acknowledged` | the host applied it | optimistic state stands |
| `stale` | the host answered and refused: it changed underneath | roll back, tell the user to refresh |
| `unreached` | no answer ever came — the chunk failed, or an earlier one aborted the loop | roll back, report the transport failure (`unreachedReason`) |

`unreached` exists because filing a transport abort under `stale` told the user
something had changed when nothing had, and sent them to refresh a list that was
already correct. Both optional fields are omitted entirely when no chunk failed,
so a successful batch serializes exactly as it did before they existed.

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
DELETE /attention/account/machines/:machineKey
POST   /attention/account/machines/:machineKey/pairing
POST   /machines/:machineKey/attention
```

Any other `/attention/account/*` path is a 404 rather than a silent fallthrough.

D1 stores account revisions, machine links, items, tombstones, revoked machines,
device registrations, Live Activity state/tokens, presence, preferences, and
delivery receipts. Snapshots and fan-out are capped. Expired items, old
tombstones, and stale presence are pruned. The heavier sweeps —
`sweepExpiredAttentionItems` and `sweepOrphanedMachineActivity` (machines silent
for 14 days) — are cron-only rather than hung off device registration and
publish, because a Worker request path has CPU and subrequest ceilings the
sweeps could exhaust. `pruneAttentionState` stays cheap enough to run
opportunistically.

Every deletion path emits tombstones through `commitAttentionRevision`, which is
what lets protocol-2 deltas never imply a deletion: clients converge on removals
because a tombstone said so, not because an id went missing from a partial list.

The Live Activity projection lives in `apps/push-relay/src/liveActivity.ts`, with
the environment/bounds/helper vocabulary both it and `attention.ts` need split
into `attentionShared.ts` to break the import cycle. `attentionShared.ts` is also
where the relay declares `chatActivityMode` on its parsed item — parsed
leniently, so an unknown value degrades to absent rather than rejecting the item.

APNs registrations and invalid-token cleanup retain the existing push relay
behavior. See `apps/push-relay/README.md` for deployment variables, Clerk
issuer configuration, APNs configuration, abuse limits, and migrations.

## Machine removal and re-pairing

Removing a machine from the account is real and terminal. It is not a roster
edit; heartbeats never re-register a removed machine.

`DELETE /account/machines/:machineKey` on the account directory does its work in
a deliberate order: write the revocation into `revoked_machines` (carrying the
device id, upserted with `coalesce` so a retry after a failure cannot erase it),
delete the `machines` row, then call the relay's purge. The revocation is written
first because a half-completed removal must fail closed. If the relay hand-off
fails the directory answers `502 activity_purge_failed` with `machineRemoved:
true`, and `accountMachineDirectoryService` raises a typed
`AccountMachineActivityPurgeError` rather than reporting a clean removal.

The relay's `DELETE /attention/account/machines/:machineKey` commits one
revision that tombstones every item that machine published, deletes those items
and its machine link, records it in `attention_revoked_machines`, and drops its
legacy delivery targets — `device_registrations`, `live_activity_tokens`, and
`publish_suppression`. Attention device ownership rows for that machine are
deactivated rather than dropped, so a delayed request cannot reclaim the
installation, and the account Live Activity is re-delivered so the phone's
aggregate stops counting the machine. Before any of that it checks that the
account actually knows the machine key: keys are not secret (they ride items and
deep links), so an arbitrary signed-in account must not be able to terminally
403 a stranger's machine.

Revocation is then enforced on two different lookups, on purpose. The
account-scoped one gates the protocol-2 publish route. An any-account lookup
gates the legacy machine-signed publish, Live-Activity-token, and
device-registration routes — a removed machine must stop delivering even if it
tries a different account. Both answer `403 machine_revoked` with `revokedAt` and
recovery copy. Brain-side, `pushPublisherService` latches that into durable state
(`machineRevokedAt`), so the gate survives a restart; the publisher stays
readable and revivable rather than disposing itself.

### Proving a fresh sign-in

Getting back on requires a `pairing: true` registration plus proof that a human
just signed in interactively on that machine. Two proofs are accepted:

- **A token claim.** `auth_time` (OIDC) or Clerk's `fva` first-factor age, within
  10 minutes. Never derived from `iat`, and it fails closed: a token carrying
  neither claim proves nothing.
- **A single-use pairing grant.** `POST /device/code` now accepts the machine
  key, and `POST /device/token` mints a grant — 32 random bytes, base64url —
  only after it wins the one-time consume, so a racing second redemption cannot
  mint a second grant. Only the SHA-256 digest is stored, in
  `machine_pairing_grants`, bound to both the signing-in user and that machine
  key, with a 10-minute TTL swept by cron. Redemption is a single conditional
  `DELETE` that both consumes and validates, so two concurrent registrations
  cannot both spend it. The grant is spent before the relay hand-off and is
  deliberately not restored if that hand-off fails.

This is why the repair path runs the **device** login flow rather than the
loopback PKCE flow the ordinary sign-in card uses: only the device flow passes
through ADE's own account directory, so only it can end with a grant.

On success the directory calls the relay's pairing restore first — which requires
directory provenance, a constant-time comparison against the shared
`DIRECTORY_AUTH_SECRET` on `x-ade-directory-auth`, before it reads anything — and
only then deletes the revocation row.

### The repair itself

`repairMachinePairing` in
`apps/ade-cli/src/services/account/machinePairingRepair.ts` owns the two halves
and the order they lift in. It reads whether either half was gated, publishes the
pairing registration to the directory, and clears the push half **only after the
directory accepts**. A machine back on the roster but silently undelivering is
worse than one that is plainly gone, so a failed publish deliberately leaves the
push gate latched and forwards the refusal code verbatim.

The result reports `repaired`, `wasRevoked`, `published`, `pushRestored`, a
`state`, a human `reason`, and an optional machine-readable `reasonCode`. The
code is typed as a plain string across the version boundary — a newer brain may
name a refusal an older desktop has never heard of, and anything unrecognized
(including absence) must read as "unknown", never as "not that code".

Three entry points reach it:

- `ade machines reconnect` (alias `repair`), which takes no machine selector
  because a brain can only lift its own machine's revocation. When the directory
  answers `pairing_authentication_required`, the CLI prints the recovery line,
  runs the device sign-in, and re-executes the plan — no second command.
- `account.call { action: "repairMachinePairing" }` on the multi-project RPC
  server, CTO-gated alongside `renameMachine` so a subagent cannot re-pair on the
  owner's behalf, and also fired best-effort with `onlyIfRevoked: true` after any
  completed login.
- **Reconnect this computer** in desktop Settings, over
  `ade.account.repairMachinePairing`. It appears only when this machine is
  missing from the account list and the bridge exposes the call, runs the same
  device-login recovery when the directory demands fresh proof, and reports the
  honest outcome — including the case where the machine re-joined but push has
  not resumed.

## Brain publisher

`apps/ade-cli/src/services/push/pushPublisherService.ts` owns the machine's
publish lifecycle. It publishes the same state that desktop and mobile display
rather than rebuilding notification meaning in each client.

The publisher:

- observes chat approvals/questions/failures/completions, tracked CLI session
  state, session removals, and PR notification transitions;
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
  partitioned by account owner, then reconciles them only after a successful
  account publish;
- skips duplicate legacy notifications and Live Activities after a successful
  account publish.

### Item derivation

The projection itself lives in
`apps/ade-cli/src/services/push/attentionItemBuilder.ts`:
`(runs, recentRuns, prActivities, roster) → AttentionItem[]`, holding no state
and doing no I/O beyond the roster loader it is handed, so the one function every
phone, notch, and desktop row derives from can be exercised without booting a
publisher.

What it filters and how:

- **Identity chats are excluded.** A roster chat with an `identityKey` (CTO and
  the other identity threads) never becomes an item. `rosterBuilder.ts` stamps
  that label and the sync roster keeps carrying those rows for the mobile hub;
  only this feed drops them, mirroring the desktop sidebar.
- **Child shells fold into their parent.** A roster chat whose parent chat is
  itself in the roster is dropped — a shell attached to a visible chat is one
  piece of work, and publishing 1 + N items per chat inflated every count.
- **Background work keeps a run alive.** `runHasBackgroundWork` is the single
  predicate; a `completed` or `stale` run with live background tasks publishes as
  `running`, and `failed` is deliberately never overridden. `settleRun` parks the
  real outcome in `deferredTerminalPhase` and publishes it once the last task
  drains, and `resumeRunOnActivity` waits out a 10 s grace before resuming a
  terminal run so a done→working→done flap cannot mint three alert-fingerprint
  phase entries.
- **Planning is polled, not inferred.** There is no chat event for an
  interaction-mode change, so live non-terminal chat runs re-read their session
  summary on a bounded 10 s cadence; `interactionMode === "plan"` becomes
  `chatActivityMode: "planning"`, emitted only while the published phase is
  `running`.
- **Lifetimes.** Running/starting rows expire after 2 h, recent outcomes after
  24 h, and idle roster rows after 7 days. Idle rows used to carry
  `expiresAt: null`, which meant a chat deleted while its machine was offline sat
  in the account feed forever, because only the owning machine can tombstone it
  and it never came back to do so.
- **Deletion tombstones immediately.** The publisher subscribes to session
  removals; a delete drops the run, its pending alerts, and the 10 s roster disk
  cache, then flushes, so the protocol-2 delta tombstones the id on the spot
  rather than waiting for an expiry.
- **Roster wins over a frozen run.** When the roster says `running` and the live
  run says `completed`/`stale`, the run item is skipped: a stale publisher view
  must not bury a session the booted runtime says is working.

`canonicalProjectId` memoizes `deriveProjectId(rootPath)` per root and stamps
`project.canonicalId`, returning `null` rather than a fabricated id when no root
is known.

`prActivityId` requires owner + repo to mint a stable id. Without them it adopts
an existing row only when the match is unambiguous and otherwise drops the event
with a log line, instead of degrading to a shared scope literal that minted
duplicate PR rows.

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
closed. The header count is the `needs-you` group and nothing else; live work is
an ambient pulse rather than an inflated inbox count.

Both surfaces are built from `activityPriority.ts`, which projects the snapshot
into agent sections and a notification tail:

- `activityFeedItems` — live, non-dismissed `kind: "agent"` rows.
- `activitySections` — those rows grouped by state, always returning all five
  descriptors (including empty ones) so the popover, pane, and notch share
  headings without re-declaring order. A section **is** a state group;
  they were separate vocabularies once, and the drift showed up as a
  "Working 0" heading above rows that were plainly working.
- `activityNotificationItems` — everything that is not an agent and is
  inbox-eligible, sorted. Eligibility rather than "every PR", because an open
  pull request nobody is waiting on is not a notification.
- `activityFeedOrder` — the flattened agent sections followed by the
  notification tail. The notch projects from this so its Agents and Events views
  read one ordering instead of re-deriving priority in Swift.

The keyboard-accessible header popover shows every section except `done`: it is
the most final and by far the most common state, and a dropdown that opens onto
a wall of finished work buries the two rows that wanted a human. It stays one
click away in the pane, and the footer keeps counting it.

The full `/activity` route provides:

- an **Agents** column of state-group sections and a **Notifications** column of
  PR/CI and review outcomes grouped by project, each with per-row dismiss and a
  single-call Clear all;
- collapsible section headers — the whole strip is the button, and the collapsed
  set is remembered per surface (`ade:activity:collapsed-sections-popover` and
  `-pane`), because folding Done in a glance is not the same choice as folding it
  in the list you opened to read it;
- an all-clear beat when the last raised hand goes down: a quiet `role="status"`
  strip, fired on the transition only and never on arrival, held for 1.8 s;
- all-machine, machine, and project scopes, and a machine → project → item
  roster;
- an exact detail view with the plain-language state sentence
  (`activityStateSentence` — "Claude is asking a question"), time in the current
  state derived from the immutable `statusSince`, plan progress, recent activity,
  safe actions, seen/dismiss state, offline explanation, and retryable
  acknowledgment;
- account delivery/privacy controls.

### Opening an item from another machine

Seeing an item means its machine is already on the account, so a click is
expected to pair, connect, and open without ceremony.

Resolution has to cross the two project-id spaces described above.
`resolveLocalProjectRoot` (`main/services/deeplinks/localProjectResolution.ts`)
tries this machine's own projects by exact id, then by the root path the link
carried, then by recomputing `deriveProjectId` from each known root. The remote
twin is `resolveRemoteProjectBinding` in `services/ipc/runtimeBridge.ts`, which
falls back to `matchRemoteProjectByRootPath` — an exact normalized match wins
outright, and a case-folded match is accepted only when unambiguous, with
Windows-versus-POSIX spelling read from the path's own shape rather than the
host platform, because the path belongs to a machine that may not run this OS.

A cross-machine item never rebinds the window the user is working in. Binding a
remote project replaces that window's global project context, so
`selectWindowForProjectNavigation` prefers a window already showing the project,
then one that has it open as a tab, and otherwise opens a new window. When the
chain genuinely fails, `describeAttentionOpenFailure` turns the stage that broke
— `pair`, `connect`, or `open` — into one actionable sentence and keeps the raw
error as `cause` for the logs. `RemoteProjectNotFoundError` is a class rather
than a message match, because the user-visible recovery instruction branches on
it and a copy edit should not silently reroute the user.

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
`attention.acknowledgeMachine`, fenced on the loaded account owner. Source
revisions still ride along, but the brain records them rather than refusing on
them: it now reports ids it does not recognize as `skipped` instead of rejecting
the whole batch, so one unknown row cannot fail a Clear all. An older host that
lacks those actions produces an Update host state;
the adapter never converts an unsupported call into an empty list. If the
browser account changes after a snapshot loads, opening or acknowledging that
snapshot is rejected until Activity refreshes under the new owner.

## ADE Code Activity

`/activity` opens an account-wide right pane with five headings — `NEEDS YOU`,
`FAILING OR BLOCKED`, `DONE, UNREVIEWED`, `LIVE NOW`, `RECENT`. The TUI calls
machine-global `attention.call`, not the selected project's action scope, so
changing lanes or projects does not change the account source. Enter opens the
exact ADE destination first and only then sends the owner-fenced seen mutation.
`/attention` remains an unadvertised compatibility alias.

Its headings are a projection of the shared five-group table rather than a
second phase ladder: `activityPane.ts` maps each state group onto a pane group
through `ACTIVITY_PANE_GROUP_BY_STATE_GROUP` (`failed` → failing, `planning` and
`working` → live), then splits the `done` band into `DONE, UNREVIEWED` versus
`RECENT` on seen state and idle tier. The TUI has no separate planning heading,
so planning rows sit under `LIVE NOW`. Because the table is now the single
source, `review_requested`, `merge_ready`, and `blocked` file under `LIVE NOW`
as someone else's move rather than borrowing an amber heading, and `stale` and
`open` are live rather than recent. `activityPane.test.ts` runs the shared
conformance fixture.

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
The status item uses the shipped ADE app icon plus a small state badge whose
tint follows the same five-group table. Hover or click opens a transient,
screen-edge-safe panel anchored under that icon; the resting top-center
imitation notch is absent. Right-click uses the same icon as the anchor for
controls.

### Two reveal modes

There are exactly two, and they are deliberately indistinguishable once the strip
is on screen:

| Mode | At rest | Pointer | Click |
| --- | --- | --- | --- |
| `always` | strip pinned to the menu bar | draws feedback only | opens the panel |
| `hover` | dormant | a bounded top-edge hot zone reveals the identical strip | opens the panel |

`hover` is the default. Dormancy is keyed on the pointer rather than on a second
presentation state, and the hot zone sits strictly inside the strip rect. In both
modes a click — and only a click — opens the full panel; with the expanded panel
disabled, that click opens Activity in ADE instead of growing, so no surface is
ever inert. The retired `minimal` and `click` values described a third "peek"
layout that no longer exists; both normalize to `always`, so an upgrade keeps a
visible strip rather than silently hiding it.

`automaticRevealEnabled` and `tickerEnabled` are gone rather than deprecated. The
helper stopped reading them, so carrying them through the wire, the validators,
and the settings UI moved no pixel. An older peer may still send them; they are
ignored.

### The compact strip

`NotchStripModel.swift` models two wings around the cutout. The leading wing is
`notchStripGroups` — every non-zero state group as a glyph plus a count, in
priority order. The tally is agent-only and skips dismissed rows, then floors
itself against the host's `AttentionCounts` (using `failed` and `planning` only
when the host actually sent them; a missing count is not zero). The trailing wing
is `notchTopSignal`: a stream problem outranks rows, then the top notable row —
needs-you, failed, planning, or an unseen merged/completed PR — then a
machines-online line, then "All clear".

The strip replaced a row of repeated provider logos, which said "three Claudes"
when the useful sentence was "one is asking you something and two are working".
Width is computed from the groups and the signal and clamped, rather than fixed,
so the ears stay inside the visible area on either side of the camera housing.

`AttentionCounts` gained optional `failed` and `planning` for the same reason.
They are optional rather than defaulted because an older publisher cannot send
them, and a reader that has them floors its own groups from them instead of
inventing a residual — which is what the deleted unattributed-count fudge was
doing to paper over the gap.

### Panel, tabs, and cards

The panel has two tabs, **Agents** and **Events**; an item files under Events
exactly when it is a pull request. Events cluster by repo and PR number, so six
rows from one PR read as one fact. The panel's rows are one flattened draw order
that doubles as the keyboard model — arrows move focus and collapse/expand, Tab
cycles tabs, Return acts, Escape closes — so what is drawn and what is navigable
cannot disagree. `Done` starts collapsed. The whole projection comes from the
renderer's `activityFeedOrder`, so priority is not re-derived in Swift.

A needs-you **flash card** appears for about ten seconds and ends on any of four
things: the timeout, an explicit close, a click through (which opens the Events
tab with that cluster expanded and focused), or the item being acknowledged on
another device. A remote acknowledgment skips the out-animation — the card should
not linger politely over work that is already handled. Takeovers are never gated
on the reveal mode, and never replace a card currently under the pointer.

Interaction rules that survive unchanged: right-click anywhere on the surface or
the menu-bar item opens the same native menu (Open Activity, Refresh,
presentation mode, expanded-panel policy, hide details, celebrations, and a
confirmed Hide with restore guidance); ordinary running work and needs-you
changes update status without overriding the reveal policy; completion remains
until seen or dismissed; and hit testing covers only the drawn shape, leaving the
menu bar usable.

Confetti is one `Canvas` layer with 44 ballistic particles emitted from the two
cutout corners, generated once from a deterministic seed rather than a view and
timer per particle. Reduced Motion replaces it with a static gradient wash, and
the same preference removes the flash card's collapse animation.

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

Rows are unified across the drawer, the widgets, and the Live Activity through
`ActivityRowPresentation.swift`, which owns iOS's copy of the five-group table
(`ActivityStateGroup`, with its wire spelling kept separate from the Swift case
name and lenient aliases on decode) and is pinned by the shared conformance
fixture. A row leads with a state mark — the group's glyph on a tone-tinted disc,
with a pulse while the work is live — rather than a provider logo plus a separate
status dot, and the model is a compact brand chip. `chatActivityMode` decodes
losslessly into `planning` or an unrecognized value, and no `planning` member was
added to the phase enum: the phase vocabulary stays frozen.

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

The content state carries two additive optional fields alongside the rows:
`groups`, the per-state-group tally, and `moreCount`, the roster overflow. Both
are omitted rather than zero-filled when there is nothing to say, and a client
that does not receive them derives the tally locally. The relay's tally counts
agent rows only and is account-wide rather than derived from the capped roster —
counting PR rows there inflated every group they touched, because a pull request
is not planning.

The Lock Screen and Dynamic Island lead with one focused item and show a small
overflow count instead of presenting a miniature monitoring dashboard. The
Dynamic Island's compact leading is the leading group's glyph and count and its
compact trailing is the top event signal, so the island says "one needs you, two
working" at a glance; the expanded view adds a state strip, up to three rows, and
a link for the remainder. A PR only earns its own card when there are no agent
rows at all. Each secondary row owns an element-level `Link`, so tapping a PR or
agent opens that row rather than one activity-wide fallback URL.

`chatActivityMode` never spends a push on its own. It is excluded from the alert
fingerprint and from the relay's APNs transition gate, because planning and
working flip back and forth several times within one turn; the distinction rides
along on the next transition that was already earned.

Account Live Activity `Run` and `PullRequest` rows carry the source
`accountMachineKey` as an additive optional wire field. Their exact ADE links
preserve that key together with the session item/event or PR tab anchor. Older
payloads without the field remain decodable, but account-wide payloads include
it so the app can adopt/select the owning machine before opening the row.
Account APNs alert payloads carry the same routing key.

Interactive approval App Intents remain available only where the activity is
known to belong to the current host. Account-wide remote items use exact Open
or Reply navigation instead of executing an action against the wrong machine.

### Widgets and freshness

`ADELockScreenWidget` now serves both accessory and Home Screen families
(rectangular, circular, inline, small, medium, large) from one definition, and
reads the same App Group snapshot under the same priority, state vocabulary,
privacy, and routing rules. The accessory families stay single-focus with one tap
target; the Home Screen families render the state-group header, up to two, three,
or six rows depending on size, and a footer carrying the event signal and an
overflow link. Rows carry per-row `Link`s, so a tap lands on the item rather than
on the app.

A widget cannot say "I am current" by rendering, so the snapshot is written with
an explicit fetch timestamp and every surface derives a `Freshness` from it:
fresh, aging past 10 minutes, and untrusted past 2 hours, with a visible
staleness tag on the last two. The timeline emits a second, pre-dated entry at
the aging threshold, so a widget that stops being refreshed degrades honestly
instead of showing hours-old work as current.

Two paths keep it fed. The app registers a `BGAppRefreshTask`
(`com.ade.ios.activity.refresh`, permitted in `Info.plist` alongside the `fetch`
background mode) which re-arms itself first, then bootstraps the account and
refreshes the snapshot, and always reloads widget timelines even when the refresh
fails. Silent pushes refresh the snapshot before reloading, and now reload on the
no-change path too — a push that found nothing new still proves the data is
current, which is exactly what the staleness tag is asking about.

When there is no account feed at all, the Home Screen families fall back to the
machine-local `LockScreenPriorityStatus` derivation rather than an empty card.

## Validation boundaries

Simulator and unit validation can prove snapshot merging, expiry/tombstones,
preference mapping, exact links, intent safety, widget decoding, and rendering.

A physical iPhone is still required to prove real APNs delivery,
push-to-start-token minting, background Live Activity updates, and system
notification presentation.
