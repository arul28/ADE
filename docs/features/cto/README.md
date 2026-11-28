# CTO

The CTO is DAEX's persistent project operator: one chat session per project that
never rotates, a short memory it keeps itself, and a face you can change. The
session is the conversation of record. The model runs on a provider thread that
DAEX throws away and rebuilds when it gets full, compacts, overflows or hits a
model limit, carrying the notes, open work, live project state, the story so far
and the newest messages. The page is built for one daily chat (a floating name
pill, a profile panel, quiet chips instead of tool rows) with a settings page of
five sections: Look, Brain, Memory, Routines, Instructions.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/cto/ctoStateService.ts` | Identity ([storage](#where-the-identity-is-stored)), the prompt layers (`IMMUTABLE_CTO_DOCTRINE`, `CTO_MEMORY_SYSTEM_GUIDANCE`, …), `previewSystemPrompt()`, the volatile block `buildReconstructionContext()`, and the live state block (`captureLiveState()`, `renderCtoLiveStateBlock()`). |
| `.../cto/ctoMemoryService.ts`, `ctoNoteText.ts`, `ctoOpenWork.ts` | Notes files, the discovery queue, the injected memory sections; note parsing and near-duplicate check; open work and its auto-closing links (`reconcileLinkedWork`). |
| `.../cto/ctoLearningService.ts`, `apps/desktop/src/main/services/chat/ctoLearningLoop.ts` | Rules, skills, per-turn baselines, the Learned journal, Undo; the post-correction review. |
| `.../cto/ctoMemoryArchive.ts`, `ctoMemoryArchiveOps.ts` | [The archive](#the-archive) (`.ade/cto/archive.db`, FTS5) and its import, search and recall. |
| `.../cto/ctoStory.ts`, `ctoStoryUpdater.ts` | [The story so far](#the-story-so-far): pure planning and the background updater. |
| `.../cto/ctoAccountCopyService.ts`, `ctoArchiveCopy.ts`, `ctoArchiveCopySync.ts` | The account copy (vault kind `cto_copy`), `homeGate`, and the archive inside the copy. |
| `.../cto/ctoStallJudge.ts`, `ctoStallJudgeHost.ts` | [Stuck children](#stuck-children-and-waiting-on-you) and "Waiting on you". |
| `.../cto/ctoPromptContent.ts`, `ctoLivePullRequests.ts` | The capability manifest and opening turn; open PRs for the live state. |
| `.../cto/linear*.ts`, `issueTracker.ts` | Linear plumbing the CTO tools call ([Linear integration](../linear-integration/README.md)). |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | The session (`ensureIdentitySession`), `refreshCtoProviderThread()`, `onCtoTurnSettled()`, quick replies, quiet ends, `getCtoAttention()`, `readCtoHistory()`. |
| `.../chat/ctoThreadFallback.ts` | Refresh triggers (`CTO_REFRESH_OCCUPANCY_PCT` = 55) and the backup-model switch. |
| `.../chat/ctoQuietTurn.ts`, `ctoTurnContext.ts`, `providerThreadContinuity.ts`, `sessionTurnHealth.ts` | Quiet-turn state, small pure helpers, which provider thread the next send lands on, turn health. |
| `.../chat/chatScheduledWorkScheduler.ts`, `scheduledWorkCheck.ts` | Routines (scheduled work), pause / run now, routine checks. |
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts`, `ctoToolPacks.ts`, `ctoExecutionLane.ts`, `ctoCrossMachine*.ts`, `universalTools.ts` | The CTO's tools, the pack list, where `spawnChat` runs, cross-machine tools, `recordDiscovery`. |
| `apps/desktop/src/renderer/components/cto/` | The `/cto` page (`CtoPage.tsx`), pill, side panel, library, routines, open work, Waiting on you, welcome, account-copy view, settings, memory panel, avatar (`avatar/`), hooks. |
| `apps/desktop/src/renderer/components/chat/cto/` | Calm chat: working line, chips, spawn rows, Learned row, step words. |
| `apps/desktop/src/shared/types/cto.ts`, `shared/types/chat.ts`, `shared/ctoHomeMachine.ts` | Types (a cross-platform contract for iOS), `CTO_LIVE_REDIRECT_PROVIDERS`, reactions, the home-machine setting. |
| `apps/ios/ADE/Views/Cto/` | The iOS CTO tab, settings and profile sheet. |

## Gotchas / fragile areas

- **A refresh never runs mid-turn.** `refreshCtoProviderThread` records
  `ctoRefreshPending` and the next settled turn runs it.
- **Forget every provider pointer.** Claude resumes its SDK id, Codex its
  `threadId`, Cursor its agent. The refresh clears every field
  `persistedPointerState` knows, writes both metadata copies, and sets
  `claudeFreshThreadPending`. Codex refuses a fresh thread while a `threadId`
  exists, so clear first.
- **No full replay** for the CTO; a refresh carries notes, open work, live state,
  the story and the newest messages.
- **The live state block stays last** in the volatile half, which is truncated by
  keeping its tail.
- **Stage the ~21 KB static block once per provider thread.** Re-sending it every
  turn once grew a CTO thread from 46k to 237k input tokens.
- **Occupancy 55% is deliberate**: small threads are fast and cheap. Change it
  with measurements.
- **Notes caps are the point.** Past the project cap the coldest notes move to the
  archive (never truncated, refused when there is no archive). Notes about the
  person are refused when full, never archived (they are machine-wide; one
  project's archive would hide them).
- **`replaces` and `forget` must match exactly one line**; otherwise refused with
  candidates.
- **`<ADE home>/cto/USER.md` is machine-wide.** A project fact there leaks.
- **`readHistory` reads ended sessions too.** Don't scope it to the current one.
- **Fallback is bounded per message**: each model once; only a completed turn
  clears the set. Overflow is not a fallback (it gets a fresh thread).
- **The mid-task wrapper is for the person only** (`sentByUser`), never inferred
  from metadata.
- **Avatar, personality and fallback models live in `.ade/cto/preferences.json`**
  because older builds rewrite `identity.yaml` from known keys and dropped them.
  Put any new field an older build would strip there too.
- **The avatar must stay compositor-cheap**: transform and opacity only, step
  timing for idle loops, paused off screen, still at ≤ 24 px, respects reduced
  motion.
- **Panel reads go to the home machine** with its `pin`; a null pin talks to the
  tab's machine.
- **The CTO does not write the repository.** Git mutations and file writes are
  refused in code; work goes through `spawnChat` on its own lane.
- **The CTO tool server needs its bearer as a plain record.** `leaseHeaderRecord`
  turns the lease's array header into `{ name: value }` for Copilot, Pi, Muse,
  OpenCode and Cursor; without it they reached none of the CTO's tools.
- **Every provider's turn must consume the staged context**
  (`consumePendingTurnContextPrefix`), or the CTO runs with no memory.

## Domain model

### One session forever, one provider thread at a time

One CTO session per project (identity key `cto`), pinned to the primary lane,
`full-auto`, hidden from every roster, never rotated. `ensureIdentitySession`
serializes per key, so concurrent callers never make two threads or two opening
turns; the reuse path resends the opening turn if its marker is missing and no
person message exists.

`refreshCtoProviderThread(managed, reason)`:

1. Refuses during a turn or an account move and records `ctoRefreshPending`
   (persisted).
2. Tears the runtime down and forgets every provider pointer (Claude, Codex,
   Cursor, Droid, Copilot, ACP, Pi, Muse ids), writing both metadata copies.
3. Re-stages the static prompt and conversation tail and rebuilds the volatile
   half.
4. Emits a quiet `system_notice` `cto_context_refreshed` (drawn as nothing on the
   CTO page and iOS, a hairline divider elsewhere).

Reasons: `occupancy` (completed turn at ≥ 55%), `compaction` (any completed
compaction), `overflow` (a `context_overflow` failure; the person's message is
resent once, marked `metadata.ctoResend`), `model_fallback`, `manual` (settings
button, `cto.refreshContext`, `cto_state.refreshContext`) and `cold_cache`
(decided on send: an expired prompt cache on a thread big enough that Compact
first would offer, via `refreshCtoForColdCache()`). A Cursor Cloud CTO refuses.
A person's Stop is not a failure. Settled-turn work waits 5 s for idle, then is
kept on `ctoPendingSettledAction` and retried.

### Memory

| File | What | Cap |
| --- | --- | --- |
| `.ade/cto/MEMORY.md` | Project facts, one line each | `CTO_PROJECT_NOTES_MAX_BYTES` (4096) |
| `<ADE home>/cto/USER.md` | Facts about the person, every project on the machine | `CTO_USER_NOTES_MAX_BYTES` (2048) |
| `.ade/cto/open-work.json` | Work the CTO started and has not finished | 20 open, 30 finished |
| `.ade/cto/RULES.md` | Standing rules, `- rule — why.`, injected in full | `CTO_RULES_MAX_BYTES` (4096) |
| `.ade/cto/skills/<name>/SKILL.md` | How-tos; only the index is injected, `readSkill` reads one | 40 skills, 8 KB each |

- Writes are atomic and secret-scrubbed. A note is one line (≤ 400 chars). A note
  that duplicates an existing one (Dice ≥ 0.8) is not saved. A rule close to an
  existing one (Dice 0.6) is refused, so the CTO sharpens it with `replaces`.
- Coldest = least recently written, repeated or recalled. The notes editor
  (`cto.updateNotes`) moves only pre-existing lines out, and is refused when its
  added lines alone exceed the cap. Editors send `baseHash`; a changed file is
  refused with `CTO_NOTES_CHANGED_ERROR` (match with `isCtoNotesChangedError()`).
- **Open work.** `trackWork({ title, text, owner, chatSessionId | prNumber,
  machine })` and `finishWork({ id, outcome })`. A linked item closes itself when
  its PR merges/closes or its chat comes to rest after a clean turn
  (`reconcileLinkedWork`, run per turn, on reads and on PR changes, single-flight).
  An unparseable file is moved aside to `open-work.json.corrupt-<ms>`.
- **Learning.** Each turn has a baseline (`beginLearningTurn`); at turn end
  `finishLearningTurn` diffs and emits one `cto_learned` event with its changes,
  saved under `.ade/cto/learning/turns/` (newest 60). The person's own writes move
  the baseline. Undo (`cto_memory.undoLearned`, person-only) restores one change,
  refuses if it would undo a later edit, and adds it to the undone list, which the
  CTO's tools then refuse to redo (newest eight injected) unless
  `personAskedAgain: true`.
- **Review after a correction.** If the person's message reads as a correction
  (`ctoCorrectionExcerpt`) and the turn saved no lesson, one hidden `cto_review`
  continuation asks the CTO to fix the cause and end with `noReply` (at most every
  5 minutes per thread; clients draw nothing for it).

### What the CTO is given each turn

**Static, once per provider thread** (~21 KB, the same as the Instructions
preview): doctrine with the chosen voice, continuity model, memory guidance, the
DAEX knowledge document and the capability manifest (generated from
`createCtoOperatorTools()`). Re-armed by `restageSectionsForNewProviderThread()`
or a content-key change.

**Volatile, every turn** (`buildReconstructionContext()`), in order: CTO context,
Rules, Skills index, Undone by the person, project notes, notes about the person,
Open work, unseen reactions, then the **live project state last**.

The live state waits at most 350 ms (`CTO_LIVE_STATE_SEND_WAIT_MS`); a slower
capture lands in the cache and the send carries the previous snapshot ("as of
40 s ago"). It covers who waits on the person, machines, lanes, active chats,
working chats on other online machines (`peekRemoteWork`, at most once a minute,
never waking a machine, off with the cross-machine switch), every open PR on the
repository (`ctoLivePullRequests.ts`, labelled by where it lives), scheduled work,
automation runs and failed sources. Cap `CTO_LIVE_STATE_MAX_CHARS` (7000).

The conversation tail rides only when the next send lands on a different provider
thread than the turns happened on.

### The story so far

A fresh thread gets one history block (`buildCtoHistoryBlock`): a "this is a
record" line, `<story_so_far>` (four sections, ≤ 12,000 chars, `.ade/cto/story.json`),
turns a home move carried, a count of uncovered older messages, and the tail in
`<conversation_history>` (≤ 36,000 chars, 4–40 messages, widened over messages
the story does not cover yet). Quoted tags are defused.

The story is written in the background by the chat-naming helper model (the
CTO's own model when none), in the person's time zone: every 6 turns when at
least 12,000 uncovered characters exist, and forced on every fresh thread. One
update per chat at a time; at most 4 helper calls of 40,000 chars per run; the
story only moves forward (`coveredThrough`). An answer must look like a story
(`acceptCtoStoryAnswer`) or it is dropped and that chat waits 10 minutes. An
unreadable `story.json` stops updates (`cto.story_unreadable`) rather than being
overwritten.

### The archive

`.ade/cto/archive.db` is project-scoped SQLite with FTS5, opened on first use and
moved aside (never deleted) if it will not open. It holds notes that left the
notes (`cold`, `replaced`, `forgotten`), `fact`/`decision` rows each story fold
extracts (up to 30, citing source lines, including tool results), drained
discoveries, and every story version. `searchMemory` is keyword search (or
newest-first paging); `recallNote` brings a note back through `remember`. Nothing
from the archive is injected into a turn.

In the account copy the archive travels as content-named gzip chunks plus an
index (`archive`, `archive:<sha>`, same `cto_copy` kind), with shelf ceilings
(older rows past a ceiling stay local, `copyFloor`). A save writes missing chunks,
then the index, then tombstones only for its own previous chunks. A new home
takes the archive after the notes; it dedupes, so taking it twice is harmless. A
home never overwrites another machine's index before taking it in.

Surfaces: `cto_memory.searchArchive` / `recallArchived`, IPC
`ade.cto.searchMemoryArchive` / `recallArchivedNote`, the same remote commands,
and Settings › Memory › Archive. Every UI call carries the home's pin.

### `readHistory`

`readHistory({ query?, before?, limit? })` reads every CTO session of the project:
paged newest first, or every-word search with neighbouring messages. Limit 20
(max 50).

### Where the identity is stored

`.ade/cto/identity.yaml` plus the synced `cto_identity_state` row (newer
`updatedAt` wins, ties to the file): name, persona, standing instructions,
`modelPreferences`, onboarding, cross-machine switch. `avatar`, `personality` and
`fallbackModels` live in the per-machine sidecar `.ade/cto/preferences.json`;
`getIdentity()` lays it over the record. `normalizeIdentity` keeps unknown keys;
`updateIdentity` accepts only known ones.

### Personality and voice

`identity.personality` is `focused` (default, adds nothing), `friendly` or
`playful`; precision rules always win. The doctrine asks for one to three short
sentences, answer first, no headings, no narration or closing offers.

### The avatar

`CtoAvatar` is an SVG character: seven shapes (`CTO_AVATAR_SHAPES`), four eyes
(`CTO_AVATAR_EYES`, default caret), calm or lively energy, states idle, working,
thinking, waiting, asleep, happy, error (`deriveCtoAvatarState()`; happy and error
are 1.4 s blips), and motion modes `static`, `lazy` (default), `live`.

### Fallback models

Up to three backups (`identity.fallbackModels`). When a turn fails for a reason
another model would not hit (limits, budget, permission, plan, unavailable,
overloaded, missing CLI), DAEX switches to the next untried backup, posts a quiet
notice, refreshes the thread and resends the message. When all fail, one notice
says so. `ctoFallbackRetryAt` (the main model's reset, else 30 minutes) brings the
next turn back to the main model. Smart Balance owns usage-limit failures first,
but never hands the CTO off as a new chat (`handOffUsageLimitChat` refuses `cto`).

### Providers that can be the CTO

`CTO_LIVE_REDIRECT_PROVIDERS`: claude, codex, cursor, opencode, copilot, each
verified live as the CTO (mid-turn messages join the turn, tools load, notes reach
the model, `replyNow` answers in seconds). Pi and Muse are left out until they
pass the same check; every other provider is ineligible. The list is its own
contract, not read off the composer. Pickers filter on the launch provider and the
runtime refuses an ineligible model. Copy: `CTO_ELIGIBLE_PROVIDERS_COPY`.

### Quick replies while working

A person's inline message to a running CTO turn is wrapped (the bubble keeps
`displayText`; `metadata.ctoMidTask`) asking the model to answer briefly with
`replyNow` and continue. Only for identity `cto`, inline delivery, a running turn,
and `sentByUser`; never for wakes, reports, relays or slash commands. Each wrapped
message grants one `replyNow` (max three per turn). `postCtoInterimReply()`
flushes the provider's buffer and commits its own `partial_answer` text event so
it never merges with streaming text.

### How a turn ends

A written reply, a reaction, or nothing:

- `noReply()` ends the turn silently: for a wake that gives the person nothing new.
- `react({ emoji })` puts one emoji (`CTO_REACTION_MEANINGS`: 👍 👀 ✅ 🎉 ❤️ 😂 😢)
  on the person's newest message the turn has read.

Both reach Claude in-process and other providers through the internal `daex-cto`
MCP server, landing in `endCtoTurnQuietly()` / `reactToCtoMessage()`. After either,
the turn's later text is dropped (👀 excepted: it promises an answer). Quiet ends at
`done`, the next turn, or when the turn reads a new message. A turn that read no
person message may only swap a standing 👀 (`ctoLookingReactTarget()`). Refusals
return `success: false` with a note.

The person can react to CTO replies with those seven plus 👎
(`chat.reactToMessage` with the chat's pin; key from
`assistantMessageReactionKey()`). Reactions start no turn; unseen ones go into the
next turn's context ("Reactions since your last turn", persisted as
`ctoReactionFeedback`).

The doctrine: reply when asked or when the person must act; react when no words
are needed; stay silent when a wake brings nothing new; never announce that it
started a helper.

### How the CTO delegates

Inline for a call or two; a background helper for multi-step work that changes no
repository; a lane via `spawnChat` for anything that changes a repository. Claude
uses `Agent` with `run_in_background`, OpenCode `subagent`; Codex, Cursor and
Copilot have no helper that wakes the CTO, so they use a `spawnChat` helper
(`permissionMode "plan"` on the CTO's lane). Proof goes in replies as
`![…](ade-proof://<id>)` lines; for remote children `getChatProof` copies files
home ([Proof in the CTO's answer](../proof.md#proof-in-the-ctos-answer)).

### Where CTO-launched work runs

`spawnChat` without a `laneId` creates a fresh lane (`createCtoExecutionLaneResolver`,
shared by the in-process CTO and the MCP bridge); an explicit `laneId` is honoured.
A local spawn onto the main checkout is refused unless `permissionMode` is `plan`.
`machine` names another machine, with a one-time check-in to wake the CTO. A
finished child reports as one line (title, provider, outcome, PR).

### Stuck children and "Waiting on you"

The stall judge (`ctoStallJudge.ts`) calls a child stuck after: 2 minutes on a
question or permission card; 3 minutes idle (with a PR needing work, ready, or no
PR); 20 minutes mid-turn with no output. Children quiet on purpose (settled,
snoozed, archived, at a usage limit, waiting on background work, a schedule or a
PR watch) and stalls older than a day are left alone. The CTO gets one
`Stall nudge:` wake (`hostContinuation.reason: "cto_stall_nudge"`) per stall, at
least 5 minutes apart, at most 5 stalls each; state in kv `cto:stall-nudges:v1`
and `cto:stall-last-nudge:v1`. The first run after an upgrade records a baseline
and tells no one.

The CTO fixes what it can, or calls `setNeed(sessionId, line)`, which puts a row on
the **Waiting on you** card above the composer (desktop, web, iOS; `cto.getNeeds`).
A need clears when the child moves or its card is answered. Scope: children on the
CTO's own machine.

### Tool packs

`ctoToolPacks.ts` is the closed pack list. `core` is always loaded; other packs
stay callable with a one-line scope until `loadCtoTools` loads their full
descriptions. Destructive calls ask the person first; configuration reads redact
secrets.

### Hidden from rosters, but never silent

The CTO is absent from every roster, so `getCtoAttention()` (read-only, never
creates a session) drives the sidebar dot, dock badge and the phone's
`cto.getAttention`. Clients keep their last badge on `unknown`.

### The home machine and the account copy

The CTO lives on one machine per project (`cto.homeMachine`). The page asks for
one (`CtoHomeChooser.tsx`); a DAEX Cloud home is offered on paid plans, on the
smallest computer (`ctoCloudHomeService.ts`). Turns and routines run only on the
home.

The home writes a copy to the account vault after every change (debounced, and at
shutdown), naming the revision it read. A new home adopts it once per move
(`account-copy-taken.json`): notes, open work, identity, rules, skills, routines,
the story, and the tail carried into the next turns. If the account cannot be read
at the move, the new home holds the CTO (turns refused) for up to 10 minutes,
retrying every 30 s.

While the home is asleep, deleted or away, the page shows the copy from the
account (`GET /cloud/cto?origin=`, `CtoAccountCopyView.tsx`) without waking the
home, including lanes the copy names (`lanesNamedInText`).

## The page

- **Header pill**: live avatar, name, one status phrase (`ctoStatusPhrase()`),
  panel toggle, settings.
- **Side panel** (~340 px; a sheet below 1100 px): avatar and **Activity |
  Library**. Activity: Now (the live step and open child chats), Upcoming
  (routines with switch, Run now, Cancel), Open work (Waiting on you / I'm
  tracking / Done today), Remembers. Library: PRs, proof and lanes the CTO's work
  produced (read only when opened). Updates come from chat events (800 ms
  debounce) plus one 60 s safety read.
- **Calm chat** (`presentation.profile === "persistent_identity"`): one
  `CtoWorkingLine` for the live turn, quiet chips for state changes, a
  `cto_learned` row with Undo, spawn rows ("Started a new task", "N background
  tasks"), reaction badges, and a "Fresh context" hairline.

### Welcome

With no model picked, `CtoWelcome` shows the sleeping avatar and a model picker
filtered to eligible providers. The pick is the whole first run. A new thread
then gets one visible opening turn (`CTO_INTRO_PROMPT`).

## Settings

Look (live preview, name, shape, colour, eyes, energy, personality; autosaved via
`cto.updateIdentity` with the pin), Brain (main model, effort, Fast, backups,
Refresh context, home machine, cross-machine switch), Memory (rules, skills,
notes with byte meters, about you, open work, archive), Routines, Instructions
(standing instructions and the folded assembled prompt).

### Routine checks

A recurring cron can take a `check` (only through the CTO's `scheduleWork` or a
home-move restore; the public `chat.createScheduledWork` drops it). DAEX runs the
shell line in the project folder before each fire (60 s, 1 MiB) and fires only
on news: a pass whose stdout hash differs from `checkHash`, or a first failure. A
quiet run spends the occurrence without a turn. The first run at creation is the
baseline.

## IPC, actions and sync

`window.ade.cto.*` (`registerIpc.ts`, `shared/ipc.ts`); every call that acts on
the CTO takes a `pin`. Groups: thread and identity, memory (`ctoGetMemory`,
`ctoUpdateNotes`, `ctoUpdateOpenWork`, skills, `ctoUndoLearned`), onboarding, and
Linear. Scheduled work uses `ade.agentChat.scheduledWork.pauseItem` / `runNow`.

Actions: `cto_state.refreshContext`; `cto_memory.*` is `allExcept` (CTO-only by
default) with `recordDiscovery` and `getSnapshot` as the exceptions, and
`undoLearned`, `updateNotes`, `writeSkill`, `deleteSkill` person-only.

Sync (`registerCtoRemoteCommands`): `cto.ensureSession`, `getState`,
`updateIdentity`, `getHomeMachine` / `setHomeMachine`, `getAttention`,
`getNeeds`, `getMemory`, `updateNotes` and `writeSkill` (not queueable),
`deleteSkill`, `undoLearned`, `updateOpenWork`, `refreshContext`,
`previewSystemPrompt`, and the Linear surface. The web client implements the
namespace in `webclient/adapter/misc.ts`.

## Cross-links

- [Agents](../agents/README.md), [Chat](../chat/README.md),
  [Tool system](../chat/tool-system.md), [Automations](../automations/README.md),
  [Linear integration](../linear-integration/README.md),
  [Remote commands](../sync-and-multi-device/remote-commands.md),
  [Capture gesture](../capture-gesture/README.md),
  [Notices](../../design/notices.md), [Visual language](../../design/visual-language.md).
