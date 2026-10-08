# Activity, notifications, and Live Activities

ADE uses one account-wide Activity stream for agent work and pull requests
across every signed-in machine and project. Desktop Activity, the
iOS Activity drawer, APNs notifications, Lock Screen widgets, and Live
Activities all render the same items and route to the same destination.

The product name for the shared system is **Activity**. Compatibility contracts
still use `attention` names, including `AttentionItem`, relay routes, IPC
channels, persistence fields, and analytics/log identifiers.

## Product rules

- **Activity is an agent feed.** The session list carries `kind: "agent"` items
  only. Pull requests, checks, and review outcomes keep pushing, badging, and
  toasting, but they render in a separate **Notifications** column rather than
  as rows beside the agent working on them — one lane with an open PR used to
  appear twice.
- Running work is ambient. It belongs in Activity, widgets, and
  Live Activities, not in a stream of toast or push interruptions.
- Only urgent events push by default: an agent that needs you, an agent that
  failed, and failing checks. Everything else updates Activity and the Live
  Activity without a push. Users can turn other events on per kind.
- A push is two short lines: the session or PR title, then the state and where
  it is. Agent text never goes in a push.
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
- Notification previews and Live Activity content honor the same
  `hideDetails` preference.

## The four states

Every surface that counts agents uses the Work board's four columns. The desktop
Activity panel, the Work board, the iOS Hub and Activity drawer, the widgets, and
the Live Activity all show the same numbers.

| Column | Tone | Means |
| --- | --- | --- |
| `needs_you` | amber | the user's move: a question, an approval, or a failure |
| `working` | blue | an agent is mid-turn |
| `waiting` | neutral | snoozed, a scheduled wake is pending, a subagent is busy, or the lane's PR has CI running or a review requested |
| `done` | emerald | finished, resting, or settled |

A failure files under Needs you, with its own red status mark. A failed turn is
the user's move until they settle the session or send a new turn. Pull requests
are notifications, not agents, so they are never counted in a column.

The publishing brain decides the column and writes it on each agent item as
`boardColumn`, with `waitingReason` (`snoozed`, `ci`, `review`, `scheduled`,
`subagent`) for Waiting:

- A roster row maps its status: awaiting and failed are Needs you, running is
  Working, idle and ended are Done.
- A running row waits instead when its lane's open PR has CI pending or a review
  requested. The roster builder reads that from the `pull_requests` table into
  `SyncRosterLane.prWaitingReason`, with the same `lanePrWaitingReason` rule the
  renderer's board uses.
- An idle row whose chat has a pending scheduled wake (`SyncRosterChat.nextWakeAt`,
  read from the booted chat service) is Waiting with reason `scheduled`.
- A snoozed row that is not failed or asking is Waiting with reason `snoozed`.
- The board also parks a finished parent while a nested subagent is busy
  (`subagent`). The roster has no spawn links, so the brain cannot see that
  yet; such a parent reads Done in Activity. Clients still accept the reason.
- A live run maps its phase (`runBoardColumn`). When it replaces a roster row
  that waits on CI or review, it keeps that wait, because a run knows its lane
  only by name.

Readers group with `activityBoardColumn` in
`apps/desktop/src/shared/attention/activityBoardColumn.ts`. It trusts a valid
published column and otherwise derives one from the phase for items an older
brain sent (it never derives Waiting). The function is implemented in
TypeScript, in Swift for iOS, and in the push relay, which imports nothing from
this repo. `activityBoardColumn.cases.json` beside it pins all three: change the
rule there first, update the cases, then let the mirrors follow.

The older six-group table (`activityStateGroup`, pinned by
`activityStateGroup.cases.json`) still feeds the relay's `groups` field for app
builds that predate the four-column Live Activity, and the surfaces that have
not moved to the four columns yet.

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
  key (and an optional `machine_name`, display text for the browser page only),
  and `POST /device/token` mints a grant — 32 random bytes, base64url —
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

Four entry points reach it:

- `ade machines reconnect` (alias `repair`), which takes no machine selector
  because a brain can only lift its own machine's revocation. With `--text` it
  prints one sentence from `shared/reconnectOutcome.ts`, the same words the
  desktop button shows. When the directory
  answers `pairing_authentication_required`, the CLI prints the recovery line,
  runs the device sign-in, and re-executes the plan — no second command.
- `account.call { action: "repairMachinePairing" }` on the multi-project RPC
  server, CTO-gated alongside `renameMachine` so a subagent cannot re-pair on the
  owner's behalf, and also fired best-effort with `onlyIfRevoked: true` after any
  completed login.
- **Reconnect this computer** in the desktop, over
  `ade.account.repairMachinePairing`. The Account page shows it when this
  machine is missing from the account list; the shell bar, the Connections
  pane's This computer card and the Machines list show it when the directory
  refuses this machine. Every surface runs one flow per window
  (`renderer/lib/reconnectThisComputer.ts`, behind `useReconnectThisComputer`),
  so a second press joins the running attempt. The flow runs the same
  device-login recovery ("Confirm it's you") when the directory demands fresh
  proof and reports the honest outcome — including the case where the machine
  re-joined but push has not resumed.
- `machinePairingAutoRecovery`, the brain's own slow loop, which calls the same
  function unattended once a refusal has been latched for a while. A headless
  box has no Settings button to press, so without it a stale row or a key
  rotation left the machine off the account permanently. It runs on a persisted
  6-hour budget and stays idle for the first ten minutes after a revocation, so
  it can never undo a removal the user just performed — see *Getting back on
  after a refusal* in [README.md](./README.md#getting-back-on-after-a-refusal).

## Brain publisher

`apps/ade-cli/src/services/push/pushPublisherService.ts` owns the machine's
publish lifecycle. It publishes the same state that desktop and mobile display
rather than rebuilding notification meaning in each client.

The publisher:

- observes chat approvals/questions/failures/completions, tracked CLI session
  state, session removals, and PR notification transitions;
- republishes on changes, and on a 30-second heartbeat rebuilds the roster,
  hashes it with `activityRosterFingerprint`, and posts `presence` only when
  that hash matches the last accepted roster — so a machine that went quiet
  still corrects idle/working decay instead of waiting for the 30-minute
  reconcile. After four unchanged rebuilds the rebuild itself backs off to at
  most every two minutes; presence posts stay on the 30 s cadence;
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
phone and desktop row derives from can be exercised without booting a
publisher.

What it filters and how:

- **Identity chats are excluded.** A roster chat with an `identityKey` (CTO and
  the other identity threads) never becomes an item. The machine-wide sync
  roster now omits those rows and their attached descendants before publishing;
  this defensive filter remains for stale or legacy roster payloads, mirroring
  the desktop sidebar and keeping the separate CTO surface out of Activity.
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
- **Chat metadata is polled, not inferred.** Neither a chat's title nor its
  interaction mode is announced on the chat event stream — a chat is born with a
  placeholder title and renamed seconds later, once the runtime has read the
  prompt — so `refreshChatRunMeta` re-reads the session summary for every live
  non-terminal chat run on one bounded 10 s cadence (`CHAT_META_REFRESH_MS`,
  stamped as `chatMetaCheckedAt`). One read, one cadence, because both facts come
  from the same summary. `interactionMode === "plan"` becomes
  `chatActivityMode: "planning"`, emitted only while the published phase is
  `running`.

  The first resolution and every refresh go through **one** `applyChatSummary`.
  They used to be written out separately and the refresh only re-read the
  interaction mode, which is how a renamed chat kept its birth title for the life
  of the session — so an attention row named a chat nobody recognised. The
  attempt is stamped *before* the await, so a slow or failing read cannot make
  every flush retry the same session, and a thrown read keeps the last known
  metadata rather than blanking the title or flipping the glyph. A terminal run
  is skipped: it cannot be renamed into something the user is waiting on.
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
- **Snooze demotes a running row to idle.** A snoozed roster chat that is not
  `failed` or `needs_you` publishes as phase `stale` / tier `idle`, and a live
  run for that id is not allowed to revive it as working. Failed and needs-you
  stay visible. The same overlay is what Hub `runningCount` excludes.

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
| `presence` | heartbeat skip when `activityRosterFingerprint` matches the last accepted roster, or when rebuild backoff is in effect | no items — it holds `last_seen_at` and lets a due alert retry without rewriting the feed |

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

Defaults (`defaultPolicy` in `apps/desktop/src/shared/activityCatalog.ts`,
mirrored by `DEFAULT_NOTIFY_EVENTS` in the relay):

| Event | Default |
| --- | --- |
| Needs you | Notify |
| Failed | Notify |
| Checks failing | Notify |
| Running / progress | Ambient |
| Review requested / changes requested / merge ready | Ambient |
| Completed / merged / opened / closed | Ambient |

Review requests, requested changes and merge-ready PRs notified by default
before policy-defaults version 2. Every save writes the whole `eventPolicies`
map, so a saved "notify" for one of them cannot tell a choice from the old
default. `eventPolicyDefaultsVersion` on the account scope settles it: a scope
without version 2 reads those three "notify" values as the new default
("ambient"). The desktop settings model applies the same upgrade on load
(`upgradeAttentionEventPolicies`) and saves version 2, so a choice the user makes
after that stays.

### Push copy

`attentionAlertCopy` in the relay builds every account push:

| Kind | Title | Body |
| --- | --- | --- |
| Agent | the session title | state · project · machine, for example `Needs you · ADE · Arul's Mac Studio` |
| Pull request | `#1514` and the PR title | state · project, for example `Checks failing · ADE` |
| Hide details on | `Agent: Needs you` or `Pull request: Checks failing` | none |

Each line is cut at 64 characters with an ellipsis. The agent's preview text
never goes in a push: it is a paragraph nobody reads on a Lock Screen, and the
row the push opens shows it in full. An agent item that offers both Approve and
Deny carries the `ADE_APPROVAL` category, so the banner shows the two buttons.

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

### A question is not an approval

`approval_request` carries both flavours, and only its optional `requestKind`
tells them apart (see
[chat composer docs](../chat/composer-and-ui.md#approval-vs-question)). The
publisher classifies with the shared `isQuestionKind` from
`shared/pendingInputAnswers.ts`:

| | phase | notification category |
|---|---|---|
| question / structured question | `waiting_for_input` | none |
| everything else, and any event with no `requestKind` | `waiting_for_approval` | `APPROVAL_NOTIFICATION_CATEGORY` |

The category *is* the notification's inline Approve/Deny buttons. A question has
nothing for them to do, so it ships without them — the same shape
`structured_question` already published. Before this, every `AskUserQuestion`
went out as `waiting_for_approval`, so the phone offered
Approve/Deny for something that wants prose, and the answer branch in the
attention item builder was dead code. Both flavours share the
`alert:<sessionId>:approval` dedupe key: it is one prompt per session either way,
and sharing it keeps a question from re-alerting over an approval it replaced.
An event with no `requestKind` is an approval, which is what older hosts meant.

The `needs_you` privacy preview reads **"An ADE agent needs you."** — the same
two words the status label and the title suffix use. "needs your input" was a third phrasing for one state, on the
surface with the least room to explain itself. Where a specific line is
available instead, chat surfaces supply `waitingOnYouDescription()` from
`shared/types/chat.ts` (`Waiting on your answer.` / `…answers.`), which is also
the lock-screen preview.

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
stays truthful across project switches and while `/activity` is
closed. The header count is the `needs-you` group and nothing else; live work is
an ambient pulse rather than an inflated inbox count.

Both surfaces are built from `activityPriority.ts`, which projects the snapshot
into agent sections and a notification tail:

- `activityFeedItems` — live, non-dismissed `kind: "agent"` rows.
- `activitySections` — those rows grouped by state, always returning all six
  descriptors (including empty ones) so the popover and pane share
  headings without re-declaring order. A section **is** a state group;
  they were separate vocabularies once, and the drift showed up as a
  "Working 0" heading above rows that were plainly working.
- `activityNotificationItems` — everything that is not an agent and is
  inbox-eligible, sorted. Eligibility rather than "every PR", because an open
  pull request nobody is waiting on is not a notification.
- `activityFeedOrder` — the flattened agent sections followed by the
  notification tail.

The keyboard-accessible header popover shows every section except the two
resting bands (`idle` and `done`): those are the most common states, and a
dropdown that opens onto a wall of finished and gone-quiet work buries the two
rows that wanted a human. Both stay one click away in the pane, and the footer
keeps counting them.

The `/activity` pane's filter row includes a **state strip**: one glyph and
count per populated group, single-select, AND-ed with machine / project / chat
type / model. Counts come from the unfiltered item set so the strip cannot hide
its own escape routes. Pressing the lit glyph clears the filter.

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

Its headings are a projection of the shared six-group table rather than a
second phase ladder: `activityPane.ts` maps each state group onto a pane group
through `ACTIVITY_PANE_GROUP_BY_STATE_GROUP` (`failed` → failing, `planning` and
`working` → live, `idle` → recent), then splits the `done` band into
`DONE, UNREVIEWED` versus `RECENT` on seen state and idle tier. The TUI has no
separate planning or idle heading, so planning rows sit under `LIVE NOW` and
idle/stale rows sit under `RECENT` rather than claiming live agents hours after
they stopped. Because the table is now the single source, `review_requested`,
`merge_ready`, and `blocked` file under `LIVE NOW` as someone else's move rather
than borrowing an amber heading, and `open` is live rather than recent.
`activityPane.test.ts` runs the shared conformance fixture.

When signed out, ADE Code asks the connected host for its real machine snapshot
and labels the subset. Account failure may degrade to that same connected-host
view. A host without the Attention capability remains connected but shows its
name with update-and-restart guidance instead of a blank pane.

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
`ActivityRowPresentation.swift`, which owns iOS's copy of the six-group table
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

There is one account-wide `agent-runs` Live Activity per iPhone, and only the
relay starts it. A brain never starts a Live Activity of its own: the per-machine
activity it used to start when account delivery was unavailable is how a phone
came to show two. The relay's legacy `/machines/:key/publish` route still lets an
older brain end the activity it started, and reports its start and update frames
as suppressed so the brain stops retrying.

The content state leads with `columns`: `{ needsYou, working, waiting, done }`,
the account-wide agent counts in the four states. It is always present, zeros
included. The relay still sends the older `runs`, `prs`, `groups` and
`activeCount` fields for app builds that predate the four-tile design.

- The activity lives while any agent needs you, works, or waits. When only Done
  remains, the relay ends it.
- A push-to-start carries an alert, as ActivityKit requires. Its title is `ADE`
  and its body is the counts, for example `2 need you · 5 working`.
- A needs-you change pushes at once. A change to the working, waiting or done
  counts pushes at most once every 5 minutes
  (`LIVE_ACTIVITY_COUNT_REFRESH_MS`), so a busy account cannot use up the
  ActivityKit budget while every number still settles within minutes. Each
  machine's presence heartbeat re-runs the check, so a count the window held
  back goes out on the first heartbeat after the window, even when nothing else
  changes. With nothing pending, that check only reads.
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
working" at a glance. Each compact-strip glyph is a `Link` to
`ade://activity?state=<group>`, so tapping the amber "4" opens the Activity
drawer already filtered to that band. The expanded island adds a state strip,
up to two agent rows, and a footer for the remainder: three rows plus a footer
silently clip, because the expanded island clips overflow with no visible tell.
The expanded leading/trailing regions inset 10pt horizontally and 2pt vertically
so the corner glyphs keep their edges inside the island's rounder capsule. The
lock-screen banner still budgets three agent rows (two when a lead row carries
Approve/Deny capsules). A PR only earns its own card when there are no agent
rows at all. Each secondary row owns an element-level `Link`, so tapping a PR or
agent opens that row rather than one activity-wide fallback URL.

When the app is foreground, `LiveActivityService.refreshLocalContent` writes the
merged account+live feed into the running Activity with a local
`Activity.update` (hash-deduped, 1 s floor). The relay spends APNs pushes only
on transitions worth the ActivityKit budget — exact counts for `needs_you` and
`failed`, presence for the rest — so a working count going 3 → 7 never reached
the island from a push. The local write is the real-time path; the relay push
stays the backstop for a suspended app. `Run.statusSince` is additive so a
working row can render a system-ticking relative date instead of a string frozen
at push time.

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
