# Drafts and scheduled send

A **draft** is unsent composer text (and its images) that survives across
machines: whatever you typed in one ADE runtime is readable from every desktop
and phone signed into the same project. A **scheduled send** is a draft that
additionally carries a fire time and is delivered later as a real user turn by
the machine that owns the target chat. One store backs both — the same
`prompt_stashes` table — so there is no separate "sends" concept to keep in
step with the drafts list.

This is the canonical description of the model, the delivery machinery, and its
limits. The physical table name is still `prompt_stashes` and that is
deliberate (see [Storage](#storage-the-prompt_stashes-table)).

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/chat/draftService.ts` | The runtime-owned store: `listDrafts` / `getDraft` / `createDraft` / `updateDraft` / `deleteDraft` / `claimDraft`, retention, and the scheduled-send columns. Owns validation (text, images, schedule), the hybrid `createdAt` stamp that keeps a machine's own rows on top across replicas, the read-then-delete claim, and the `scheduled`→`sending` delivery claim (`claimScheduledDraft`). |
| `apps/desktop/src/main/services/chat/draftDelivery.ts` | Attempts one scheduled send (`deliverDraft`): the image-availability hold, the per-schedule lateness policy, the target lookup, and the send. Returns `sent` / `blocked` / `missed` / `retry` / `skipped`. |
| `apps/desktop/src/main/services/chat/draftScheduler.ts` | The scheduler loop (`createDraftScheduler`). The database is the only state — no schedule file — so every tick re-reads what is due, claims each row, delivers it, and arms the next wake. |
| `apps/desktop/src/shared/types/chat.ts` | `DraftEntry`, `DraftKind`, `DraftStatus`, `DraftDeliveryPolicy`, `DraftTargetKind`, `DraftScheduleInput`, `DraftCreateArgs` / `DraftUpdateArgs` / `DraftClaimArgs` / `DraftGetArgs` / `DraftDeleteArgs`, and the caps `MAX_DRAFTS` (20), `MAX_SCHEDULED_DRAFTS` (50), `MAX_DRAFT_ATTACHMENTS` (10), `MAX_DRAFT_SCHEDULE_LEAD_MS` (1 year), `MAX_DRAFT_GRACE_SECONDS` (24 h). |
| `apps/desktop/src/main/services/state/kvDb.ts` | The `prompt_stashes` CRR schema and its added scheduled-send columns. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Wiring: builds `draftDeliveryDeps` (the target check, the existing-chat send, the new-chat launch, and the image-availability check), creates and starts the scheduler, exports `sendDraftNow` and `refreshDraftScheduler`, and returns a claimed-but-unfinished row to the queue on start (`releaseStaleSendingDrafts`). |
| `apps/desktop/src/main/services/adeActions/registry.ts` | The `chat.listDrafts` / `getDraft` / `createDraft` / `updateDraft` / `deleteDraft` / `claimDraft` / `sendDraftNow` runtime actions. The write actions call `refreshDraftScheduler` so a newly armed send does not wait for the periodic sweep. |
| `apps/desktop/src/main/services/adeActions/actionPolicy.ts` | The agent-access boundary for drafts (see [Agent access boundary](#agent-access-boundary)). |
| `apps/desktop/src/renderer/components/chat/ComposerDrafts.tsx`, `DraftSchedulePopover.tsx` | The desktop Drafts control and the scheduled-send form. |
| `apps/desktop/src/preload/preload.ts` (`agentChat.drafts.*`), `apps/desktop/src/shared/ipc.ts` | The renderer IPC surface (`ade.agentChat.drafts.list` / `.create` / `.delete` / `.update` / `.claim`), pinned to the project runtime that owns the draft. |
| `apps/ios/ADE/Views/Work/WorkDrafts.swift`, `WorkDraftScheduleSheet.swift` | The iOS drafts surface and its schedule half-sheet. See [iOS companion](../sync-and-multi-device/ios-companion.md). |
| `apps/ade-cli/src/cli.ts` | The typed `ade drafts` command family over the same actions. |

## The draft model

A row is `kind: "draft"` (nothing armed) or `kind: "scheduled"` (a fire time
and a target). `status` tracks where an armed send is:

| Status | Meaning |
|---|---|
| `draft` | A plain draft; nothing is armed. |
| `scheduled` | Armed and waiting for its fire time (also the state a transport failure returns to). |
| `sending` | Claimed by the owning machine; the send is in flight. |
| `sent` | Delivered. |
| `missed` | The fire time passed and the policy refused to deliver late. |
| `blocked` | Delivery cannot proceed until the user acts (target chat gone, images not yet on this machine). |
| `cancelled` | Cancelled by the user or an agent. |

A schedule names its **target** explicitly — it never guesses. `targetKind:
"existing"` carries `targetSessionId` (deliver into that chat);
`targetKind: "new"` carries `targetLaneId` (create the chat in that lane at the
fire time, which is why a new-chat schedule also requires a model). Both may
carry a `targetMachineKey` naming the machine that fires it (see
[Machine targeting](#machine-targeting)).

The **if-late policy** is decided when the schedule is armed:

- `wait` (default) — deliver whenever the owning machine can, however late.
- `strict` — deliver on time or report the send `missed`.
- `grace` — deliver late but give up after `graceSeconds` (a whole number of
  seconds, at most 24 hours).

A schedule captures the **composer config** it will run under — `provider`,
`modelId`, and the runtime-facing `model` string, plus `permissionMode` and
`thinking` — rather than reading the composer at fire time, because at fire
time nobody is watching. `scheduledBy` records `user` or `agent` and
`scheduledBySessionId` the arming agent; these are for provenance, and an
agent-armed send is otherwise indistinguishable from one the user armed.

Attachments are images only (up to ten). A local image is stored as the path on
the machine that made it; an HTTP(S) image is stored as a portable
`image-url`. Reads report `attachmentCount` (everything the row claims) and
`attachmentsAvailable` (the ones this runtime can actually read), so a machine
that does not own the bytes can still show the count and say where the images
live.

## Retention

Retention is a count rule, not an age rule: plain drafts keep the newest 20
(`MAX_DRAFTS`) and finished sends keep the newest 50 (`MAX_SCHEDULED_DRAFTS`),
oldest pruned first. Rows whose status is `scheduled`, `sending`, or `blocked`
are **never** pruned — an armed send is exempt because losing one is the exact
failure this feature exists to prevent. The prune is written as a single
`DELETE ... WHERE id IN (SELECT ... LIMIT -1 OFFSET N)` so it stays safe on a
partially converged replica: adding rows can never promote an entry that was
already outside the top N.

Skew between machine clocks does not reorder the list: `createdAt` is a hybrid
stamp — this machine's wall clock, or one millisecond past the newest row it
has already seen, whichever is later — so a locally created draft stays on top
even when this machine's clock lags the machine that created a newer synced
row. Live drafts also protect their images from the stale temporary-attachment
sweep (`listDraftAttachmentPaths`), so a draft whose bytes were copied into a
runtime is not garbage-collected before it is used.

## Claim-first restore

Putting a draft back into a composer is a **claim**, and the claim is the
delete: `claimDraft` reads the row and deletes it in one synchronous SQLite
connection, and only the caller whose delete actually removed the row may fill
a composer. This removes the sequential two-machine case — restore on one
machine, then refresh on the other — from ever putting the same text in two
composers.

It does not remove the simultaneous case: two humans clicking the same row on
two machines in the same instant are both answered by their own local delete,
and which row survives is decided by CRR convergence **after** the fact, not
before. See [Honest limits](#honest-limits).

## Delivery and the lateness policy

`deliverDraft` runs its checks in a fixed order, because each choice was made
for a reason:

1. **Images first.** If any image the draft carries is not readable on this
   machine, the send **holds** (`retry`, "Waiting for this send's images to
   reach this machine") rather than deliver a prompt with a missing
   attachment. The user's choice was to hold, not to send incomplete.
2. **Lateness next**, before the target, so a `strict` schedule that blew its
   window is reported `missed` even if the chat is also gone.
3. **Target last**, immediately before the send: a new-chat schedule starts its
   chat in `background` mode (nobody is watching for a handoff); an
   existing-chat target is checked for existence and non-archival, and a
   deleted chat **blocks** ("The chat this send was aimed at is gone. Pick
   another target.") rather than throwing.

A throw from the send itself is treated as a transport or session problem, not
a decision: the row stays `scheduled` and the scheduler retries it. `skipped`
means another pass already owns the send and is never written back to the row,
so the owning pass's claim cannot be overwritten.

`chat.sendDraftNow` (the "Send now" action, and how a `blocked` or `missed` row
is resent) runs one draft through the same `deliverDraft` path with a fire time
of now. It does **not** unarm the row first: a manual send that fails leaves the
schedule it already had.

## The scheduler and the exactly-once claim

`createDraftScheduler` holds no state of its own. Every tick re-reads what is
due from the database and delivers it, so a restart, a sync from another
machine, or a composer edit all take effect on the next arm with no bookkeeping
to keep in step. It wakes at the soonest pending fire time (capped by a periodic
sweep, default 5 minutes, so a send synced in from another machine is still
picked up), retries on a fixed delay (default 60 seconds) when a due row could
not go out, and delivers anything that came due while the app was closed on
start.

Delivery is exactly-once **per runtime** because the claim happens before the
send: only the runtime whose `scheduled`→`sending` status flip matched a row
delivers it, so an overlapping sweep or a restart cannot send twice. The
scheduler re-arms after an edit made through this machine (`refreshDraftScheduler`,
called by the write actions) so a newly armed send is noticed immediately
rather than at the next sweep. A runtime that dies between claiming a row and
recording the outcome would otherwise leave it `sending` forever, which reads
as a send that silently never happened; `releaseStaleSendingDrafts` returns
such a row to the queue (stale after 10 minutes) on the next start.

## Machine targeting

Every paired machine holds the whole table over sync, so a row is visible
everywhere. A schedule **that names a machine fires only on that machine**; a
schedule **that names no machine fires on whichever runtime is up**. The
scheduler filters due rows by this runtime's own machine key (normalized to
lower case and trimmed, because keys arrive from the relay identity, the
desktop machine picker, and the phone's account directory and are equal as
identity but not always as text), and untargeted rows count toward this
machine's next wake even though they belong to "whoever is running". Without
this filter, two brains holding the same synced row would both fire it.

**Time is interpreted in the target machine's local time.** The desktop form
takes a local wall-clock value and the phone sends an offset-qualified
timestamp, so two machines in different zones schedule the same instant rather
than each guessing the other's zone.

## Storage: the `prompt_stashes` table

The physical table keeps the name `prompt_stashes` even though the feature is
Drafts. cr-sqlite will not rename a CRR wholesale — the migration path only
wraps *added* columns in `crsql_begin_alter` — and every paired machine holds
this table, so a rename would strand peers on the old schema. The scheduled-send
columns (`kind`, `status`, `scheduled_at`, `delivery_policy`, `grace_seconds`,
`target_*`, `origin_session_id`, `model`, `permission_mode`, `thinking`,
`scheduled_by`, `scheduled_by_session_id`, `fired_at`, `last_error`) are all
nullable and added in place, so an older peer's rows stay valid and a newer
peer's values still sync into this build.

## Agent access boundary

Drafts are open to session-bound agents; the `chat` CTO-only block in
`actionPolicy.ts` no longer lists `listDrafts` / `createDraft` / `deleteDraft`.
The reason is the feature itself: a draft is now the backing store for a
scheduled send, an agent that schedules a send produces a message the user
would otherwise have typed, and the product decision is that an agent may arm
and manage sends on the user's behalf. Two consequences come with that
decision:

- an agent can **read** the user's unsent drafts, so never paste secrets into a
  draft you have not sent;
- an agent-armed send is **indistinguishable** from one the user armed.

`armUpdateResume` stays CTO-only: it is machine-wide and spends a real turn on
every chat the desktop names.

## CLI surface

`ade drafts` is the human/agent CLI over the `chat.*Draft` actions; it owns no
state. There is deliberately one noun — there is no `ade sends`.

```
ade drafts list [--scheduled | --needs-you | --machine <key>] [--text]
ade drafts create --prompt "<text>" [--image <path> ...]
cat prompt.md | ade drafts create
ade drafts schedule <id> --in 90m --target <session>
ade drafts schedule <id> --at "2026-07-23T01:05:00-04:00" --target <session>
ade drafts schedule <id> --in 2h --new-chat --lane <lane> --provider codex --model openai/gpt-5.6-sol
ade drafts update <id> --prompt "<text>"        # edit the text
ade drafts update <id> --in 30m                 # retime (its target carries over)
ade drafts update <id> --unschedule             # return it to a plain draft
ade drafts show <id> [--text]
ade drafts now <id>                             # deliver immediately, whatever its fire time
ade drafts delete <id>
```

`--in 90m` is a relative fire time; `--at <iso>` requires an explicit offset or
`Z`. A `schedule` must name `--target <session>` or `--new-chat --lane <lane>`
(plus `--provider` and `--model` for a new chat). `--if-late wait|strict|grace`,
`--grace <duration>`, `--machine <key>`, `--permission <mode>`, and
`--thinking <effort>` cover the rest. Output is a readable table by default,
`--text` is one line per row, and `--json` is structured.

## iOS companion

The mobile drafts surface lives in the composer's ⋯ overflow menu: with content
the item **saves a draft**, without content it **opens the list**; directly
beneath it, **Schedule send…** opens the half-sheet. The list is one flat set
with **All** / **Scheduled** / **Needs you** filter tabs whose counts come from
the same entries. Attaching a plain draft **claims it before filling** the
composer (the claim is the delete), the same order the desktop uses; a scheduled
row is not claimed back into a composer — it shows its fire time and, when it
needs you, its reason plus **Resend** and **Unschedule**. The half-sheet
requires an explicit target, machine, and offset-qualified fire time, and shows
the captured config with an elevated-permission warning. A host that omits
`chat.listDrafts` hides the drafts surface; a host that omits `chat.createDraft`
keeps the list but hides "Schedule send…". See
[iOS companion](../sync-and-multi-device/ios-companion.md).

## Honest limits

- **Draft images are not replicated across machines.** The bytes stay on the
  machine that made them; another machine sees the image **count**, marks them
  unavailable, and **refuses to attach** them. This was a planned decision and
  it is **not delivered in this change** — the current behavior is the refusal,
  which is explicit, never a silent drop.
- **A send that could not go out stays in the list with its reason.** Just after
  a fire, a send that is `blocked` or `missed` remains in the drafts list with
  its `lastError`. A *transport* failure is different: it leaves the row
  `scheduled`, and the scheduler retries.
- **A simultaneous claim is decided after the fact.** Two humans clicking the
  same draft on two machines in the same instant is decided by CRR convergence
  **after** the fact, not before. The claim removes the sequential two-machine
  case, not a simultaneous one.
- **Machine targeting is literal.** A schedule naming a machine fires **only**
  on that machine; a schedule naming no machine fires on **whichever runtime is
  up**.
- **Time is the target machine's local time.** A fire time is interpreted in the
  local time of the machine that will deliver the send, not the machine that
  armed it.
