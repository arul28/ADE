# Drafts and scheduled send

A **draft** is unsent composer text (and images) that every desktop and phone
on the project can read. A **scheduled send** is a draft with a fire time and a
target, delivered later as a real user turn by the machine that owns the target.
Both live in one synced table, `prompt_stashes`.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/chat/draftService.ts` | The store: list/get/create/update/delete, `claimDraft` (read-then-delete), `claimScheduledDraft` (`scheduled` → `sending`), retention, validation, hybrid `createdAt`, `releaseStaleSendingDrafts`. |
| `apps/desktop/src/main/services/chat/draftDelivery.ts` | `deliverDraft`: one attempt; returns `sent` / `blocked` / `missed` / `retry` / `skipped`. |
| `apps/desktop/src/main/services/chat/draftScheduler.ts` | `createDraftScheduler`: stateless loop over due rows. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Builds `draftDeliveryDeps` (target check, `sendToChat`, `createChatAndSend`, image check), starts the scheduler, exports `sendDraftNow` / `refreshDraftScheduler`. |
| `apps/desktop/src/shared/types/chat.ts` | `DraftEntry`, `DraftStatus`, `DraftDeliveryPolicy`, args types, caps (`MAX_DRAFTS`, `MAX_SCHEDULED_DRAFTS`, `MAX_DRAFT_ATTACHMENTS`, `MAX_DRAFT_SCHEDULE_LEAD_MS`, `MAX_DRAFT_GRACE_SECONDS`). |
| `apps/desktop/src/main/services/state/kvDb.ts` | `prompt_stashes` CRR schema and the added scheduled-send columns. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | `chat.listDrafts` / `getDraft` / `createDraft` / `updateDraft` / `deleteDraft` / `claimDraft` / `sendDraftNow`. Writes call `refreshDraftScheduler`. |
| `apps/desktop/src/main/services/adeActions/actionPolicy.ts` | Agent access (below). |
| `apps/desktop/src/renderer/components/chat/ComposerDrafts.tsx`, `DraftSchedulePopover.tsx` | Desktop Drafts control and schedule form. |
| `apps/desktop/src/preload/preload.ts` (`agentChat.drafts.*`) | Renderer IPC, pinned to the runtime that owns the draft. |
| `apps/ios/ADE/Views/Work/WorkDrafts.swift`, `WorkDraftScheduleSheet.swift` | iOS list and schedule sheet. |
| `apps/ade-cli/src/cli.ts` | `daex drafts` (also `ade drafts`). |

## Model

- `kind`: `draft` (nothing armed) or `scheduled`.
- `status`: `draft`, `scheduled` (armed; also where a transport failure
  returns), `sending` (claimed, in flight), `sent`, `missed` (late and the
  policy refused), `blocked` (needs the user: target gone, plain shell, images
  on a CLI target), `cancelled`.
- **Target is explicit.** `targetKind: "existing"` + `targetSessionId`, or
  `targetKind: "new"` + `targetLaneId` (a new-chat schedule also needs a
  provider and model). Optional `targetMachineKey`.
- **If-late policy**, chosen when armed: `wait` (default), `strict` (on time or
  `missed`), `grace` (`graceSeconds`, max 24 h).
- The composer config (`provider`, `modelId`, `model`, `permissionMode`,
  `thinking`) is captured at arm time. `scheduledBy` / `scheduledBySessionId`
  are provenance only.
- Attachments are images only (max 10): a local path on the machine that made
  it, or a portable `image-url`. Reads report `attachmentCount` and
  `attachmentsAvailable`.
- `author_json` (`AdeMessageAuthor`) is set only for a lane-share guest's draft:
  plain text for an existing chat, no schedule, no images; the owner sends it.
  See [lane sharing](../lanes/lane-sharing.md#message-author).

## Retention

Count-based: newest 20 plain drafts (`MAX_DRAFTS`) and newest 50 finished sends
(`MAX_SCHEDULED_DRAFTS`). `scheduled`, `sending` and `blocked` rows are never
pruned. The prune is a `DELETE … WHERE id IN (SELECT … LIMIT -1 OFFSET N)`, safe
on a partly converged replica. `createdAt` is a hybrid stamp (wall clock, or
1 ms past the newest row seen), so a local draft stays on top despite clock
skew. Live drafts protect their images from the temp-attachment sweep
(`listDraftAttachmentPaths`).

## Claim-first restore

Restoring a draft into a composer is `claimDraft`: read and delete in one
SQLite connection; only the caller whose delete removed the row fills a
composer. This stops the sequential two-machine case. Two simultaneous clicks
on two machines are settled by CRR convergence afterwards.

## Delivery

`deliverDraft` checks in this order:

1. **Moved away:** an existing-chat target that continues on another machine
   holds (`retry`, `moveAwayHeldAt`). The strict/grace deadline shifts once by
   the time held.
2. **Lateness** (`strict` / expired `grace` → `missed`), before images, so a
   missing image cannot hold a strict send open forever.
3. **Images:** any image unreadable here holds the send (`retry`, "Waiting for
   this send's images to reach this machine"). Images are not replicated; a
   machine without the bytes refuses to send rather than drop them.
4. **Target:**
   - New chat: started through the launch service in `background` mode.
   - Existing chat: missing → `blocked` ("The chat this send was aimed at is
     gone…"); otherwise `messageSession` with `kind: "auto"`.
   - Tracked agent CLI row: the text is typed at its prompt
     (`deliverWakeToSession`); mid-turn → retry; images or a plain shell →
     `blocked`.

`DraftDeliveryUnsupportedError` → `blocked`. Any other throw is transport →
the row stays `scheduled` and retries. `skipped` means another pass owns it and
is never written back. `chat.sendDraftNow` runs the same path with fire time
now and does not unarm the row first.

## Scheduler

`createDraftScheduler` keeps no state; each tick re-reads due rows. It wakes at
the soonest fire time, sweeps every 5 min (rows synced from another machine),
retries after 60 s, and delivers overdue rows on start. Exactly-once per
runtime: only the runtime whose `scheduled` → `sending` flip matched delivers.
`releaseStaleSendingDrafts` returns rows stuck `sending` for 10 min to the
queue on start.

**Machine targeting is literal.** A row naming a machine fires only there
(keys compared trimmed and lower-cased); a row naming none fires on whichever
runtime is up. Fire times are in the target machine's local time: desktop sends
a local wall-clock value, the phone an offset-qualified timestamp.

## Storage

The table keeps the name `prompt_stashes`: cr-sqlite cannot rename a CRR, and
every peer holds it. Scheduled-send columns are nullable and added in place
(`crsql_begin_alter`), so older peers' rows stay valid.

## Agent access

Session-bound agents may list, create, update and delete drafts (an agent may
arm sends for the user). Consequences: agents can read unsent drafts, and an
agent-armed send looks like a user-armed one. `armUpdateResume` stays CTO-only.

## CLI

`daex drafts list|create|schedule|update|show|now|delete` over the `chat.*Draft`
actions; there is no `daex sends`. A schedule needs `--target <session>` or
`--new-chat --lane <lane> --provider … --model …`; `--in 90m` or `--at <iso>`
(offset or `Z` required); `--if-late`, `--grace`, `--machine`, `--permission`,
`--thinking`. See `daex drafts --help`.

## iOS

The composer's ⋯ menu saves a draft (with content) or opens the list (empty);
**Schedule send…** opens the sheet. Filters: All / Scheduled / Needs you.
Restoring a plain draft claims it first; a scheduled row offers **Resend** and
**Unschedule** when it needs you. A host without `chat.listDrafts` hides drafts;
without `chat.createDraft`, it hides "Schedule send…". See
[iOS companion](../sync-and-multi-device/ios-companion.md).
