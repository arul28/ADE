# CTO

The CTO is ADE's persistent project operator: one chat session per project that never rotates, a short memory it keeps itself, and a face you can change. The session is the conversation of record. Behind it, the model runs on a provider thread that ADE throws away and rebuilds whenever it gets full, compacts, overflows or hits a model limit, carrying the notes, the open work, the live project state, the story so far and the newest messages onto the new one. Around the thread sit a page built for one daily chat (a floating name pill, a profile panel, quiet chips instead of tool rows) and a settings page with five sections: Look, Brain, Memory, Routines, Instructions.

## Source file map

### Main services (`apps/desktop/src/main/services/cto/`)

- `ctoStateService.ts` — identity (name, persona, model preferences, standing instructions) in `.ade/cto/identity.yaml` mirrored to the `cto_identity_state` row, with the fallback models, avatar look and personality in the `.ade/cto/preferences.json` sidecar (see [Where the identity is stored](#where-the-identity-is-stored)); the prompt layers (`IMMUTABLE_CTO_DOCTRINE`, `CTO_CONTINUITY_OPERATING_MODEL`, `CTO_MEMORY_SYSTEM_GUIDANCE`, the ADE environment document, the capability manifest); `previewSystemPrompt()` and `buildStaticContextSection()`; the per-turn volatile block `buildReconstructionContext()`; and the live project state block (`captureLiveState()`, `getLiveStateSnapshot()`, the pure `renderCtoLiveStateBlock()`, `CTO_LIVE_STATE_MAX_CHARS`). Its `getLiveStateSources` argument is a thunk because the service is built at boot, before the chat, PR and automation services exist.
- `ctoMemoryService.ts` — the whole memory store. Project notes (`.ade/cto/MEMORY.md`), notes about the person (`<ADE home>/cto/USER.md`), open work (`.ade/cto/open-work.json`), the one-time v1 reset, the worker-discovery queue (`discoveries.md`, `discoveries-archive.md`, `discoveries.cursor`) and `buildMemoryContextSections()`, the three sections injected every turn.
- `ctoStory.ts` — the story so far and the history block a fresh thread gets (see [The story so far](#the-story-so-far)). Pure: choosing the tail, planning a fold, the helper's prompt, and cleaning and accepting its answer.
- `ctoStoryUpdater.ts` — runs the story updates: one at a time per chat, batches, the failure wait, the supersede check. `agentChatService` hands it the chat (transcript, helper model, prompt runner).
- `ctoAccountCopyService.ts` — the CTO's account copy (vault kind `cto_copy`): identity, both notes files, open work, routines, the conversation tail and the story so far, gzip-encoded, written by the home machine only and restored by the next home (see [The home machine and the account copy](#the-home-machine-and-the-account-copy)). Also `homeGate`, which refuses a CTO turn on a machine that is not the home.
- `ctoPromptContent.ts` — `buildCtoCapabilityManifest()`, the operator-tool operating rules and the tool-pack list injected into the prompt, plus the opening turn (`CTO_INTRO_PROMPT`, `CTO_INTRO_ONBOARDING_STEP`).
- `linearClient.ts`, `linearIssueTracker.ts`, `issueTracker.ts`, `linearGraphQLInput.ts`, `linearCredentialService.ts`, `linearOAuthService.ts`, `linearOAuthRefreshLock.ts`, `linearTokenRefresh.ts`, `linearLaneCardService.ts`, `linearLiveStatusService.ts` — Linear plumbing the CTO tools call. The canonical description is [Linear integration](../linear-integration/README.md); this doc covers only what the CTO itself uses.

### Chat runtime (`apps/desktop/src/main/services/chat/`)

- `agentChatService.ts` — the CTO session (`ensureIdentitySession`, `listIdentitySessions`), the disposable provider thread `refreshCtoProviderThread()` and the settled-turn decisions in `onCtoTurnSettled()`, the fallback model switch, the once-per-thread staging of the static context and conversation tail, `seedCtoIntroTurn()`, the attention probe `getCtoAttention()`, and `readCtoHistory()` behind the `readHistory` tool.
- `ctoQuietTurn.ts` — `stepCtoQuietTurn()`, the pure state behind `noReply` and `react`: which text a quiet turn drops, which message a reaction may land on, and what ends the quiet (see [How a turn ends](#how-a-turn-ends)).
- `chatScheduledWorkScheduler.ts` — the scheduled-work rows behind routines, including the per-row pause and run-now operations. Run now takes the same shared claim a timer fire takes (so two brains cannot both deliver), saves the `fired` row before delivering and rolls it back with the claim when that save fails, and gives a cron's claim back when its occurrence did not move.
- `ctoTurnContext.ts` — the pure pieces: `truncateTailToLineBoundary()`, `readChildPullRequestNumber()`, `formatCtoChildReportLine()`.
- `providerThreadContinuity.ts` — which provider-side thread the next send will land on (`persistedPointerState()`, `providerThreadRef()`, `armIfStale()`), the signal that decides whether the static block and conversation tail ride a turn.
- `sessionTurnHealth.ts` — durable turn health over plain records, including the `context_overflow` kind the refresh path reads.

### Operator tools (`apps/desktop/src/main/services/ai/tools/`)

- `ctoOperatorTools.ts` — the CTO's tool factory: the memory tools (`remember`, `forget`, `trackWork`, `finishWork`, `readHistory`, `readDiscoveries`), the pack loader `loadCtoTools`, scheduling, chat spawn and supervision, lanes/PRs/git/tests, Linear, proof and the cross-machine tools.
- `ctoExecutionLane.ts` — `createCtoExecutionLaneResolver()`: where `spawnChat` work runs, shared by the in-process CTO and the MCP bridge (see [Where CTO-launched work runs](#where-cto-launched-work-runs)).
- `ctoToolPacks.ts` — the closed list of packs and their one-line scopes. No imports, so the prompt builder can read it without the tool runtime.
- `ctoCrossMachine.ts`, `ctoCrossMachineTools.ts` — the cross-machine tool contract and implementation (`listMachines`, `listMachineActions`, `runMachineAction`, the `machine` argument).
- `universalTools.ts` — hosts `recordDiscovery`, the append-only tool every agent gets.

### Renderer (`apps/desktop/src/renderer/components/cto/`)

- `CtoPage.tsx` — the `/cto` page: the home-machine pin, the session wake, the header pill, the side panel, the welcome, and settings in place of the thread. It holds the CTO session warm across tab switches and resolves the home machine through `useCtoHome.tsx` / `CtoHomeChooser.tsx`.
- `CtoHeaderPill.tsx` — the floating pill: live avatar, name, one status phrase, panel toggle and settings.
- `CtoSidePanel.tsx` — the profile panel with the big avatar, name, status and the Activity | Library switch.
- `CtoLibrary.tsx` — what the CTO's work produced, filtered by All / PRs / Proof / Lanes.
- `CtoRoutineRows.tsx` — routine rows for the panel and settings: title, human schedule, per-row switch, Run now / Cancel menu.
- `CtoOpenWorkList.tsx` — the open-work checklist, shared by the panel and Settings › Memory.
- `CtoWelcome.tsx` — the asleep avatar and model picker shown before a model is picked.
- `CtoAccountCopyView.tsx` — the account copy, read-only, while the home is asleep, gone or away (`GET /cloud/cto?origin=`): where things stand, open work, the lanes it names, the last turns, notes and routines. `ctoCopyName` gives the saved name.
- `CtoSettingsPage.tsx` — the five-section settings page; `ctoSettingsUi.tsx` holds its shared pieces (`CTO_SETTINGS_GROUP`, `ByteMeter`, `AutosaveTextArea`).
- `CtoMemoryPanel.tsx` — Settings › Memory: project notes, notes about the person, open work. `CtoPromptPreview.tsx` renders the assembled prompt in Instructions.
- `apps/desktop/src/renderer/components/cto/avatar/CtoAvatar.tsx` — the character, with `apps/desktop/src/renderer/components/cto/avatar/ctoAvatarState.ts` (state derivation and the 1.4 s blips), `ctoAvatarLook.ts` (swatches, eye ink), `ctoAvatarShapes.ts` (the seven bodies) and `ctoAvatar.css` (all motion).
- Hooks and helpers: `useCtoMemory.ts` (notes and open work on the home machine), `useCtoActivityData.ts` (children, PRs, proof), `useCtoLiveState.ts` (turn status and the live step), `useCtoModelOptions.ts` (eligible models and `CTO_ELIGIBLE_PROVIDERS_COPY`), `ctoSessionViewState.ts` (status phrase, panel memory, dock width), `ctoNavigation.ts` (opening a chat, PR or proof), `ctoLook.tsx` (the look outside the page), `ctoPage.css`.

### Calm chat (`apps/desktop/src/renderer/components/chat/cto/`)

- `CtoWorkingLine.tsx` — the live turn as one line: 16 px working avatar, latest step, elapsed time, expandable steps and raw tool calls.
- `CtoToolChips.tsx` — the quiet state-change chips, and `CtoFreshContextDivider`, the hairline the `cto_context_refreshed` notice becomes.
- `ctoToolWords.ts` — the pure words: which tools draw chips, the chip verbs (including their failure forms), and the step phrases the working line and panel use (`ctoStepWords`, `ctoLatestStepWords`, `ctoStepList`).
- `ctoChat.css` — their styles.
- `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx` — chooses the calm rendering when the session's `presentation.profile` is `persistent_identity`.

### Shared

- `apps/desktop/src/shared/types/cto.ts` — the identity, notes caps, open-work, history, avatar and personality types. The field names are a cross-platform contract for iOS.
- `apps/desktop/src/shared/types/chat.ts` — `CTO_LIVE_REDIRECT_PROVIDERS`, `providerSupportsLiveRedirect()`, `CTO_CONTEXT_REFRESHED_STATUS`, the scheduled-work item shape (including `paused`), and the per-row pause/run-now argument and result types.
- `apps/desktop/src/shared/ipc.ts` — the `ade.cto.*` channels and the scheduled-work channels.

### iOS (`apps/ios/ADE/`)

- `apps/ios/ADE/Views/Cto/CtoRootScreen.swift` — the CTO tab: the thread inline, a gear for settings, and the model pick before the thread.
- `apps/ios/ADE/Views/Cto/CtoSessionDestinationView.swift` — resolves the CTO session and reuses the Work chat pipeline with a compact composer.
- `apps/ios/ADE/Views/Cto/CtoSettingsScreen.swift`, `apps/ios/ADE/Views/Cto/CtoReloadHelpers.swift` — settings (name, look, model, memory, routines, instructions) and reload plumbing.
- `apps/ios/ADE/Views/Cto/CtoProfileSheet.swift` — the profile sheet: avatar, status, Activity and Library.
- `apps/ios/ADE/Views/Work/WorkModels.swift` — `ctoLiveRedirectProviders`, the hand mirror of the desktop list.
- `apps/ios/ADE/Views/Work/WorkModelPickerSheet.swift` — the model picker with an optional eligibility filter.

## Domain model

### One session forever, one provider thread at a time

There is one CTO session per project, with identity key `cto`. It is pinned to the primary lane, runs `full-auto`, is hidden from every lane and session roster, and is never rotated: no "past threads", no start-fresh action. The ADE transcript is the record, and `readHistory` can read all of it.

`ensureIdentitySession` runs one call per identity key at a time. The page, a phone (`cto.ensureSession`), a second window and the CTO's own tool can ask at once; a call that arrives while another runs waits for it and then takes the reuse path, so the project never gets two CTO threads or two opening turns. The reuse path also sends the opening turn when its marker is missing and the transcript has no person message (the first try failed, say on a signed-out provider).

The model's own thread is disposable. `refreshCtoProviderThread(managed, reason)` in `agentChatService`:

1. Refuses while a turn is running or an account move holds the thread (Smart Balance, an account switch, a move to another machine), and records the reason on `managed.ctoRefreshPending`, persisted with the chat state, so the next settled turn runs it, after a restart too.
2. Tears the runtime down with a non-preserving reason, then forgets every provider pointer: the thread id, Claude's SDK session (and background-resume id and fork fields), the provider session id and its seeded copy, Cursor's SDK agent and run ids, Droid's, Copilot's and ACP session ids, Pi's session id and file, and Muse's session id. Claude also gets `claudeFreshThreadPending`, because that runtime resumes from a persisted SDK id. Both copies of the chat metadata file are written, so neither can hand the old thread back.
3. Re-stages the once-per-thread half of the turn context (the static prompt and the conversation tail) and rebuilds the volatile half, so the next send opens a new thread carrying the doctrine, the notes, the open work, the live state, the story so far and the newest messages. The CTO never gets a full transcript replay.
4. Emits one quiet `system_notice` with status `cto_context_refreshed`: "Fresh context — notes, open work, the story so far and the newest messages carried over." The CTO page and the iOS CTO thread draw nothing for it (the thread stays quiet); anywhere else, such as the Work tab, it is a hairline divider.

The reasons are `occupancy`, `compaction`, `overflow`, `model_fallback`, `manual` and `cold_cache`. A CTO running on a Cursor Cloud agent keeps its cloud agent and refuses the refresh.

Triggers, all decided on the `done` event in `onCtoTurnSettled()`:

- **Occupancy.** A completed turn whose provider thread is at or past `CTO_REFRESH_OCCUPANCY_PCT` (55%) gets a fresh thread.
- **Compaction.** A completed `context_compact` or `codex_context_compaction` refreshes as soon as the turn settles: a compacted thread lost detail anyway.
- **Overflow.** A turn that failed with `lastTurnFailure.kind === "context_overflow"` gets a fresh thread and the person's failed message is sent once more, as they typed it (never the mid-task wrapper), with its display text, attachments and metadata, marked `metadata.ctoResend`. A per-message key set stops any loop.
- **A model fallback** refreshes as part of the switch (below).
- **Cold cache.** Decided on the send, not on `done`: when the CTO's prompt cache has expired and the thread is big enough that Compact first would offer to compact (`compactFirstOffer` in "always" mode, so Claude, Codex, Pi, OpenCode and Cursor), `refreshCtoForColdCache()` moves it to a fresh thread before the message goes out. It checks the clock first (no read until the idle window has passed since the last activity) and skips a thread no turn has completed on yet, so a fresh thread whose first turn failed is not refreshed again on every send. The CTO has no Compact first pill on desktop or iOS; this replaces it.
- **Manual.** The settings "Refresh context" button, `cto.refreshContext` over IPC, or `cto_state.refreshContext` as an action. A busy CTO answers that it will refresh when the turn ends.

A person's Stop is not a failure and triggers nothing but a refresh that was already owed.

The settled-turn work waits up to 5 s for the thread to go idle. Past that, the whole action (the overflow resend or the backup switch, not only the refresh) is kept on `ctoPendingSettledAction`, retried every 5 s for two minutes, and run by the next settled turn otherwise. A newer user message means the conversation moved on: an overflow still gets its fresh thread, but the old message is not sent again.

### Memory: two notes files and an open-work list

The CTO's own memory is three files, and a fourth is the worker-discovery queue. Nothing here runs a model.

| File | What it is | Cap |
| --- | --- | --- |
| `.ade/cto/MEMORY.md` | Facts about this project, one `- ` line each. | `CTO_PROJECT_NOTES_MAX_BYTES` = 4096 |
| `<ADE home>/cto/USER.md` | Facts about the person, shared by the CTO of every project on this machine. | `CTO_USER_NOTES_MAX_BYTES` = 2048 |
| `.ade/cto/open-work.json` | What the CTO started and has not finished. | 20 open, 30 finished |

Writes are atomic and secret-scrubbed. A note is one line, clipped at 400 characters. A new note that says the same thing as an existing one (Dice overlap of content words at 0.8 or more, negations counted as opposites) is not saved; the CTO is told which note already says it. `remember({ note, replaces })` rewrites the one line containing the `replaces` text, and refuses with the candidate lines when the text matches none or several. `forget()` removes the one matching line the same way. Past a cap, the write is refused with "Notes are full (N of N bytes). Merge or forget notes first." The CTO merges or forgets; ADE never silently drops a note.

Open work is a small list of `CtoOpenWorkItem`s. `trackWork({ text })` adds one (`addedBy: "cto"`) and returns its id; `finishWork({ id, outcome })` marks it done and appends the outcome, clipped at 120 characters. Finished items past the cap are dropped oldest first; open items are never dropped. The person edits the same list from the panel and Settings › Memory (`cto.updateOpenWork`). An `open-work.json` that does not parse is moved aside to `open-work.json.corrupt-<ms>` (and logged) before the list reads as empty, so the next write cannot destroy the only copy.

A notes editor sends `baseHash`, the sha256 of the text it started from (`CtoMemorySnapshot.memoryHash` / `userNotesHash`). When the file changed since (the CTO wrote a note, another device saved), `writeNotes` refuses with `CTO_NOTES_CHANGED_ERROR` ("Notes changed since you opened them."); match it with `isCtoNotesChangedError()`, since the class does not survive IPC or sync. A write without `baseHash` still replaces the file. `cto.updateNotes` over sync is not queueable: a whole-file write replayed later would overwrite what changed meanwhile.

CTO v2 starts with empty notes. A one-time reset runs on first load, guarded by `.ade/cto/.v2-migrated`. When v1 files are present, it moves them (`context-store.json`, `thread-state.md`, `daily/`, `memory-archive.md`, `CURRENT.md`, `sessions.jsonl`) and the v1 `MEMORY.md` into `.ade/cto/legacy-v1/`. Nothing is imported and nothing is deleted.

### What the CTO is given each turn

The turn context has two halves with different lifetimes.

**Static, once per provider thread.** The doctrine with the chosen voice, the continuity model, the memory guidance, the ADE environment knowledge document and the capability manifest: the same `previewSystemPrompt().prompt` the Instructions section shows. About 21 KB, byte-identical on turn 2 and turn 200. `restageSectionsForNewProviderThread()` re-arms it when the provider thread changes, and the section's content key re-stages it if a rename or edited instruction changes the prompt under a live thread.

**Volatile, every turn.** `buildReconstructionContext()` builds, in this order:

1. `CTO Context` — name, persona, preferred model.
2. `## Notes (project) — N of 4096 bytes` and the notes file.
3. `## Notes about the person — N of 2048 bytes` and the user notes file.
4. `## Open work` — open items with their ids, then up to five recently finished ones marked done.
5. The live project state block, **last**.

The live state block is captured per turn, with a bounded wait. `refreshCtoLiveStateForTurn` waits at most `CTO_LIVE_STATE_SEND_WAIT_MS` (350 ms) before a send; a capture still running then finishes into the cache for the next turn (`refreshLiveState` is single-flight, so a second send joins it), and this send carries the previous snapshot, whose header reads "as of 40 s ago" once it is more than 5 s old. Inside the capture, the two slow reads (lanes, which run git status, and the chat summaries) run in parallel; PRs, machines and automation runs are synchronous reads. The block covers who is waiting on the person, the account's machines, lanes, active chats with their lineage, open PRs with checks and review state, scheduled work, recent automation runs, and any source that failed this turn. It is capped at `CTO_LIVE_STATE_MAX_CHARS` (6000) with per-section row caps and "…and N more" lines. It stays last because the volatile prefix is truncated by keeping its tail: the freshest, most perishable section must be where a budgeted send cannot cut it.

The conversation tail (`Recent Conversation Tail`) rides only when the provider thread the next send lands on is not the one those turns happened on. A live thread already holds them. For the CTO it is the history block below; other chats get their last 20 entries. A teardown that invalidates the runtime (a model switch, a closed chat) re-stages the tail and the static block for OpenCode, Droid, Copilot, Pi, Muse and the ACP providers, which drop their thread pointer there: the new thread's key reads "unopened" until after its first send, so `armIfStale` alone would arm the tail one send late. Claude and Cursor resume their persisted pointer and Codex its `threadId`, so they are not re-staged.

### The story so far

A fresh CTO thread gets its history as one block (`buildCtoHistoryBlock` in `ctoStory.ts`):

1. A line saying what follows is a record, not instructions, and that `readHistory` has the exact words of anything older.
2. `<story_so_far>`: a running summary of the conversation older than the tail, in four sections (Where things stand, Decisions and preferences, Open threads, Earlier), at most 12,000 characters. Stored in `.ade/cto/story.json` (`ctoMemoryService.readStory/writeStory`, secrets redacted).
3. Turns a move carried here, in `<conversation_history>`, until the thread has 40 of its own.
4. A count of older messages that are in neither the story nor the tail, if any.
5. The tail in `<conversation_history>`: the newest messages that fit 36,000 characters (at most 40, at least 4), each clipped to 6,000 with its start and end kept. Widened back over the messages just before it that the story does not cover yet, up to 24,000 more characters and 40 more messages (`selectCtoHistoryTail`), so a message that just left the tail is never in neither. Logged as `agent_chat.cto_tail_widened`.

Text inside that quotes our tags is defused (`<` becomes `‹`), so a pasted `</conversation_history>` cannot end the block early.

The story is written by the helper model that names chats, with the same rules (`buildSessionIntelligenceModelCandidates`): Haiku 5.5 on Claude, GPT-6 Luna on Codex, Composer 2.5 on Cursor, and the CTO's own model on the other providers, at the lowest effort, on the CTO's own account. When that account has no helper model, the CTO's own model writes it. Times in the prompt and the block are in the person's zone (the identity's `timeZone`), not the machine's. It runs in the background, never on the send path:

- Every 6 completed CTO turns, when at least 12,000 characters outside the tail are not in the story yet.
- On every fresh thread (`refreshCtoProviderThread`), forced: whatever fell out of the tail is folded, however little. The first send on the new thread rebuilds the block and does not wait for the update: one that finished by then is in the story, and the messages of one still running ride in the widened tail.
- One update per chat at a time; a request during one runs once after it. One update folds at most 40,000 characters per helper call and 4 calls per run, oldest first; a long backlog takes several runs.
- The story only moves forward (`coveredThrough`, the time of the last message folded; messages that share that time go in the same batch). A run re-reads the story before writing and drops its answer if a move replaced it meanwhile.
- An answer must look like a story to replace one (`acceptCtoStoryAnswer`): at least one of its section names, and at least 35% of the previous story's length. A refusal or a fragment would otherwise replace the only record of what the story covers. A failed or rejected answer leaves the story as it was and that chat waits 10 minutes before trying again (a fresh thread still forces one).
- A `story.json` that exists but can't be read (a lock, a truncated write, a newer format) is never taken for "no story": updates stop and log `cto.story_unreadable` instead of writing a new story over it.
- When the transcript read (its newest 4 MB) no longer reaches back to where the story ends, the helper is told and the story says that stretch is missing.

The account copy carries the story's summary. A new home writes it with `coveredThrough` set to the copy's last save (never later than the move), and the carried turns waiting in `carried`; the next update folds them in first, noting that the old home's turns between its story's end and the carried ones may be missing. Turns this machine ran after the move, while the account was out of reach, are newer than that and get folded.

### `readHistory`: the whole conversation

`readHistory({ query?, before?, limit? })` reads the CTO's entire conversation: the current session plus every older CTO session of this project. Without a query it pages newest first; `nextBefore` is the cursor for the next older page. With a query, every word must appear (case-insensitive) in a user or assistant message, newest first, and each hit comes with the message before and after it for context. Entries carry `role`, text (clipped to about 600 characters), `at` and `sessionId`; `match` marks the hits. The limit defaults to 20 and is at most 50. Parsed transcripts are cached per session by file mtime and size.

### Where the identity is stored

The identity record is `.ade/cto/identity.yaml` plus the `cto_identity_state` row (a synced table); every read reconciles the two, newer `updatedAt` wins, ties go to the file. It holds the name, persona, standing instructions (`systemPromptExtension`), `modelPreferences`, onboarding state and the cross-machine switch.

`avatar`, `personality` and `fallbackModels` live in a sidecar, `.ade/cto/preferences.json` (`{ version: 1, avatar?, personality?, fallbackModels?, updatedAt }`, written atomically). `getIdentity()` lays the sidecar over the record, so IPC, sync `cto.getState`, iOS and the renderer still read `identity.avatar`, `identity.personality` and `identity.fallbackModels`. `updateIdentity(patch)` writes those three to the sidecar and everything else to the record; no record write ever carries them.

`normalizeIdentity` keeps keys it does not know untouched, so a field a newer build adds survives this build rewriting the record. `updateIdentity` accepts only known keys from a patch, so a caller cannot plant a key this way. The sidecar is per machine: it does not ride the synced row.

### Personality

`identity.personality` is `focused` (the default), `friendly` or `playful`. The default adds nothing: the doctrine's "How you speak" rules are already the voice. Friendly adds warmth and a little personality in short replies; playful allows light humour, never at the cost of precision, never emoji spam, never a joke in a failure report. The personality block sits inside the doctrine, after its speaking rules, and the precision and verification rules always win.

The doctrine also asks for brevity: a default reply of one to three short sentences, answer first; no headings; bullets only for three or more parallel items; never restating the request or narrating what it is about to do; no closing offers, and one direct question when a decision is needed; ids and hashes only when the person needs them to act. The opening turn asks for at most three sentences and three bullets.

### The avatar

`CtoAvatar` is an SVG character: a body and a face, drawn in `viewBox 0 0 100 100`.

- **Shapes** (`CTO_AVATAR_SHAPES`): pebble, bean, spark, chip, drop, cloud, hex. Chip is the dev-tool nod: a rounded square with tiny pins.
- **Eyes** (`CTO_AVATAR_EYES`): caret, round, visor, pixel. The default caret is two text-cursor bars that blink like a terminal cursor. Eye ink is dark on light bodies and white on dark ones, chosen by luminance.
- **Energy** (`CTO_AVATAR_ENERGIES`): calm or lively. Calm halves the motion and drops the squash.
- **States** (`CtoAvatarState`): idle, working, thinking, waiting, asleep, happy, error. Working bobs and scans the eyes with an orbiting dot. Thinking turns the eyes into three typing dots. Waiting looks up, tilts and pulses a ring. Asleep closes the eyes, breathes slowly and drifts a `z`. Happy (`^ ^`) and error (`x x`) are 1.4 s blips.
- **Derivation.** `deriveCtoAvatarState()` maps a session status, `awaitingInput`, streaming text, the last failure, offline and no-model onto a state. `useCtoAvatarState()` adds the happy hop when a turn lands and the error shake when one fails, then returns to idle.
- **Motion modes.** `static` is a picture (the state still shows in the eyes). `lazy` (the default) is still at idle and moves otherwise. `live` also blinks and glances at idle.

### Fallback models

`identity.fallbackModels` holds up to three backups, each normalized through the same live-redirect check as the main model and deduplicated against it and against each other. When a CTO turn fails for a reason a different model would not hit (usage or rate limit, budget, permission, plan, model unavailable, server overloaded, missing CLI), ADE:

1. switches the session to the next untried backup through the normal model-switch path,
2. emits a quiet notice, "<main> hit its limit — switched to <fallback>.",
3. gives the thread a fresh provider context, and
4. resends the person's failed message.

Each message tries each model once. When every backup has been tried, one quiet notice says "<main> and backups are unavailable — <reason>" instead of nothing. Context overflow is not a fallback cause (it gets a fresh thread instead), and a person's interrupt is not a failure. The identity's `modelPreferences` stays on the main model while the thread runs on a backup, so settings still shows the person's pick; picking a model in settings moves the thread back.

The fallback state (`ctoFallbackIndex`, `ctoFallbackSince`, `ctoFallbackRetryAt`) is persisted with the chat state. `ctoFallbackRetryAt` is the main model's published limit reset, else 30 minutes after the move (`CTO_FALLBACK_RETRY_MAIN_MS`). The first CTO turn after it starts on the main model again ("Back on <main>.", a fresh provider thread); a main model that still fails falls back again.

An account move owns a usage-limit failure first (Smart Balance). For the CTO a failed move never becomes a plain new chat on the other account (`handOffUsageLimitChat` refuses identity `cto`): the backup models take over, and the usage-limit resume arms only when none is left.

A model pick that changes the provider or model without a `modelId` (the phone's picker sends only those) replaces the stored preference rather than merging into it, with the id resolved from the registry when the model names one; a merge kept the stale `modelId`, which is what the runtime launches from.

### Providers that can be the CTO

`CTO_LIVE_REDIRECT_PROVIDERS` in `shared/types/chat.ts` is claude, codex, cursor, opencode and copilot: the providers verified live *as the CTO* on 2026-11-14 (a message sent mid-turn joins the same turn, the CTO's tools load, its notes reach the model, and `replyNow` answers in 1–5 s). Claude and Codex steer inline, Cursor steers inline locally and interrupts-and-resends in the cloud, OpenCode delivers at the next step, Copilot interjects with an immediate send. Pi and Muse steer in a plain chat but are left out until they pass the same check; neither could be signed in to test. Add a provider only after that live check passes.

Every provider outside that list is not eligible for the CTO, even where the composer offers an interrupt-style send. The list is its own contract, deliberately not read off the composer's dispatch table. The pickers filter on the provider the model would actually launch on, not its registry family, and the runtime refuses an explicit model that resolves to an ineligible provider with an error that names the list. In user copy the list reads "Claude, Codex, Cursor, OpenCode or Copilot" (`CTO_ELIGIBLE_PROVIDERS_COPY`).

### Quick replies while working

Every steering provider folds a mid-task note into its final reply, so a person who asks something during a long task waited for the whole task. `steerWithOptionsWithoutReview` wraps a person's inline message to a running CTO turn: the model gets "The person sent this while you were working: … If it asks something or changes the plan, answer briefly with the replyNow tool, then continue the task. Otherwise take it into account and keep going.", while the bubble keeps what they typed (`displayText`) and the message carries `metadata.ctoMidTask`.

It applies only when the identity is `cto`, the delivery is inline (OpenCode's `steer` delivery counts), a turn is running by that provider's own reading, the sender is a person (`sentByUser`, set by the desktop composer and the sync `chat.steer` / `chat.send` transports, never inferred from metadata, so an agent's `ade chat send` is not the person), and the message is not a scheduled wake, child report, relay, host continuation or slash command. Interrupt sends (Claude's interrupt, Cursor's cancel-and-resend) are not wrapped. Every CTO provider's steer branch does it: Claude (`priority: "next"`), Codex (`turn/steer`, not during a compaction or review), Cursor local (`Run.steer()`; a refused steer is staged with the plain words), OpenCode (inbox `steer`), Muse (`turn/steer` with a turn id), Copilot (`immediate`) and Pi (SDK `steer`).

Each delivered wrapped message grants the turn one `replyNow({ message })` (core pack, 1–600 characters), at most three, cleared when the turn settles. Without one the tool answers `{ posted: false, note: "Not posted: nobody asked mid-task. Keep working and answer in your final reply." }`. `postCtoInterimReply()` flushes the provider's buffered text, then commits a `text` event of its own (`messageId` and `itemId` `cto-reply:<uuid>`, `CTO_INTERIM_REPLY_ID_PREFIX`, phase `partial_answer`, secret-scrubbed), so it never merges with the provider's streaming text; the turn fold keeps `partial_answer` prose visible, and it reaches the conversation tail and `readHistory` as an assistant entry of its own.

### How a turn ends

Every CTO turn ends one of three ways: a written reply, a reaction, or nothing. Two core-pack tools give the last two.

- `noReply()` ends the turn with no visible reply. It is for a wake (a child chat's report, a schedule, ADE itself) that gives the person nothing new: progress, a push, a PR opened, checks running, a review round, a conflict the child fixed.
- `react({ emoji })` puts one emoji on the person's newest message instead of words. The set is fixed (`CTO_REACTION_MEANINGS` in `shared/types/chat.ts`): 👍 got it, 👀 looking into it, ✅ done, 🎉 celebrate, ❤️ thanks, 😂 funny, 😢 sorry. The brain writes a `user_message_reaction` event (`targetKey`, `emoji`, `turnId`). Clients put the newest reaction per `targetKey` on that message's bubble, so a newer reaction replaces the old one.

Both reach Claude in-process and every other CTO provider through the ADE MCP bridge (`ade-cto_noReply`, `ade-cto_react`). Either way they land in `endCtoTurnQuietly()` and `reactToCtoMessage()` in `agentChatService`:

- After either call, the rest of the turn's text is dropped at `commitChatEvent`: same turn, or untagged. What the turn had already written before the call stays.
- Quiet ends at that turn's `done`, at the next turn's start, or when the person writes a message the turn reads.
- A reaction lands on the person's newest message that the running turn has read (`ctoTurnReadsPersonMessage`): not a queued, failed or unprocessed steer, and not a message ADE wrote. An `accepted` steer counts only on Codex; on other providers the later `delivered` row counts.
- The brain stamps a `messageId` on CTO user messages that carry no id (Codex sends none), so the message has a key to react to.
- The target lives in memory. After a brain restart `react` refuses, and the CTO replies instead.
- Both tools return `success: false` with a note when they refuse: no turn is running, the person wrote nothing, or the emoji is outside the set. The CTO then has to reply.

The child-report wake is written as a `user_message` with `metadata.hostContinuation.reason: "cto_child_report"`. The `spawn_completed` line already shows the report, so the wake draws no row on desktop, web or iOS. A quiet turn after it leaves only the turn's footer: no empty bubble and no error.

The doctrine in `IMMUTABLE_CTO_DOCTRINE` (`ctoStateService.ts`) tells the CTO which way to end:

- Reply when the person asked something or must know or act.
- React when they wrote and need no words back.
- Say nothing when a wake brings nothing new. Progress is not news.
- Speak up only when the work is done, something needs the person, or something failed that the CTO can't fix.
- Never announce that it started or messaged a helper or child.

### How the CTO delegates

The doctrine keeps the CTO chat free for the person:

- **Inline:** what it already knows, or a call or two.
- **Background helper:** research, log checks and other multi-step work that changes no repository. The CTO tells the helper not to edit files.
- **A lane:** anything that changes a repository or needs a branch or PR, through `spawnChat`.

When a helper or child reports back, the CTO passes on only what matters, in a line, or ends with `noReply`.

Which background helper depends on the harness:

| Harness | Background helper that wakes the CTO when done |
| --- | --- |
| Claude | `Agent` with `run_in_background` (`Explore` for read-only work) |
| OpenCode | the `subagent` tool |
| Codex | none: `spawn_agent` can't wake the CTO after its turn ends, so it uses a `spawnChat` helper |
| Cursor | none: a background `task` gives no completion signal, so it uses a `spawnChat` helper |
| Copilot | none: no native subagent, so it uses a `spawnChat` helper |

A `spawnChat` helper runs with `permissionMode "plan"` on the CTO's own lane. ADE does not block a provider's native subagents in the CTO chat.

### The opening turn

A brand-new CTO thread gets one visible opening message (`CTO_INTRO_PROMPT`): introduce yourself, say what you can do here, then scan the project and say what you see. It is a real user turn, not a canned assistant message, so nothing fabricated enters the transcript. `intro` in the onboarding marker list makes it once per project; there is no setup wizard.

### Tool packs

Every ADE domain is reachable from a CTO session. `ctoToolPacks.ts` is the closed list of packs; `core` is always loaded with full descriptions, and every other pack stays callable but carries a one-line scope until the CTO calls `loadCtoTools` with its name. Loading is a description-level economy: no tool becomes uncallable by being unloaded. The loaded set is recorded per live session, so the prompt-manifest preview (which runs no turns) lists packs but records nothing.

Destructive calls (replacing or deleting an automation rule, cancelling scheduled work) ask the person to confirm before they run, and configuration reads redact secret-shaped values.

### Hidden from rosters, but never silent

The CTO thread is deliberately absent from every lane and session roster, so it cannot borrow the Work tab's attention dot. `getCtoAttention()` is the one signal that keeps a hidden thread from going quiet when it asks a question: a strictly read-only probe that never creates a session. The desktop's CTO sidebar entry wears the CTO's remembered look (a static avatar in place of the robot glyph) with the same warning dot, the dock badge counts it, and the phone's CTO tab reads the same probe through `cto.getAttention`. Clients keep their last known badge on `unknown` rather than treating a failed scan as idle.

### The home machine and the account copy

The CTO lives on one machine per project, named by the account setting `cto.homeMachine` (`shared/ctoHomeMachine.ts`). There is no default: the page asks for one (`CtoHomeChooser.tsx`), and an ADE Cloud home is offered only on a paid plan, on the smallest computer (`ctoCloudHomeService.ts`). Turns, routines and Run now run only on the home; another machine refuses them with a sentence naming the home.

The home keeps a copy of the CTO in the account vault after every change: a turn's end, a notes, open-work or identity edit, and a routine change, debounced, and once more at shutdown. Each write names the revision it read (`absent` when there is no row), so it can never replace a copy it hasn't seen. A machine that isn't the home never writes, and with no home chosen no machine writes over another's copy.

A new home takes the copy when it moves in (`adopt`): the notes, open work and identity replace its own (the notes about the person are joined), the routines are re-created, the story so far comes along, and the conversation tail is carried into the next turns until the new thread has 40 of its own (and folded into the story by its next update). It takes a copy once per move (`account-copy-taken.json` records the move it was taken for). When the account can't be read at the move, the new home holds the CTO: its turns are refused with a sentence saying it is still on its way, and its routines wait. Each send and a retry every 30 seconds ask the account again, and the first answer takes the old home's latest copy, so nothing the old home wrote before it heard of the move is lost, and nothing done on the new home is replaced by it. After 10 minutes without an answer the hold lifts, so the CTO is never left unusable; a later save still takes the copy, but not while the CTO is mid-turn.

**Reading the copy with no computer awake.** While the home is an asleep or deleted ADE Cloud computer, or an own computer that is away, the page shows the state card (wake or move) and, below it, the copy read from the account (`GET /cloud/cto?origin=`, `CtoAccountCopyView.tsx`). Reading it never wakes the home. The copy shows when it was saved and from which machine, where things stand (the story), the open work, the last turns (the start is cut, `CLOUD_CTO_TAIL_MAX_CHARS`), the notes and the routines. "Lanes it names" lists each lane of the repository whose full name the story, open work or last turns contain, from one read of the account lane index (`lanesNamedInText`, `prs/state/accountLaneMentions.ts`). Each is a lane chip: it opens the lane, wakes a resting ADE Cloud lane first, or says an own computer is offline. The chooser stage (no home yet) shows no copy. A server without the route, or a repository with no copy yet, shows nothing; a failed read shows the account's sentence with Retry.

### Where CTO-launched work runs

The CTO session is pinned to the project's primary lane (the main checkout), and its own work never runs there. `spawnChat` without a `laneId` creates a fresh lane for the work, in-process and over the MCP bridge alike (`createCtoExecutionLaneResolver`); an explicit `laneId` is honoured when the person named an existing lane. A local spawn onto the main checkout is refused unless `permissionMode` is `plan`, so only a read-only helper runs there. On another machine, `machine` names where the lane and its chat live, and a one-time check-in wakes the CTO when that child should report. A finished child comes back as one line — its title, provider, outcome and PR if there is one — never a pasted transcript.

### Stuck children and "Waiting on you"

The CTO wakes on its own for a person's message, a child's finished turn and a schedule. A child that then sits still reaches nobody, so the brain runs a stall judge over the CTO's children (`services/cto/ctoStallJudge.ts`, wired in `agentChatService`). It reads each child's summary, its pending card and its lane's PR row (`prService.getForLane`, the cached row, never a GitHub call), and calls a child stuck when it has been:

| Stuck on | After |
| --- | --- |
| a question or a permission prompt | 2 min |
| idle after its turn, with a PR that has conflicts, failing checks, requested changes or is behind its base | 3 min |
| idle with a PR ready to merge or test | 3 min |
| idle with no PR | 3 min |
| mid-turn with no event (a hung turn) | 20 min |

A child that is quiet on purpose is left alone: settled, snoozed, archived, parked at a usage limit, waiting on its own background work, a schedule or a PR watch. So is a stall that began more than a day ago.

The CTO then gets one wake that opens with `Stall nudge:`, names each stuck chat, what it waits on and for how long, and quotes its last message. It carries `hostContinuation.reason: "cto_stall_nudge"`, so it does not clear the CTO's own "Needs you". Each stall is told once: its key is the child, what it waits on and when it last moved, kept in `cto:stall-nudges:v1` across restarts. A child that moves and stalls again is a new stall. Nudges to one CTO are at least 5 minutes apart, at most 5 stalls each; the rest ride the next one. A nudge waits while the CTO is mid-turn or waiting on the person. On the first run after an upgrade the judge records what is already stuck and tells no one. A CTO that another live brain runs is that brain's to judge.

The doctrine says what to do with a nudge: fix what is not the person's call by steering the chat, answer from what the person already said, or else `setNeed(sessionId, line)`. That line is a row on the **Waiting on you** card at the foot of the CTO chat, above the composer, on desktop, the hosted web client and iOS. A row opens its chat on the CTO's machine. A need holds while it is newer than the child's last move, so it clears itself when the child moves; `line: null` clears it at once. A child with a live need is not nudged again for that stall. Clients read the card with `cto.getNeeds`, which needs no slot of its own: desktop and web read it with the side panel's child roster (chat events for the CTO and its children, plus the 60 s safety read), and iOS on appear, foreground, CTO events and every 60 s while the CTO chat is on screen.

Scope: children on the CTO's own machine. A chat the CTO starts on another machine has no parent link there and keeps its one-time check-in.

## The page

`/cto` is one thread, not a tab bar.

### Header pill

A centred floating pill: a small live avatar, the CTO's name, and one status phrase. The phrase is `Free`, `Working…`, `Writing…`, `Waiting on you`, `Asleep`, or `Working on 2 things` when it has children running (`ctoStatusPhrase()`). On the right are the panel toggle and the settings gear. The avatar's colour is the page's accent, replacing the old fixed cyan.

### Side panel

About 340 px, collapsible, and it remembers open or closed per project (`ade.cto.panelOpen.v1:<scope>`). Below a 1100 px container (`CTO_PANEL_DOCK_MIN_WIDTH`) it stops docking and opens as a sheet. It leads with the big live avatar, the name and the status phrase, then a segmented **Activity | Library** switch.

**Activity**

- **Now** — the live turn's current step in plain words, and the chats the CTO started that are still open: provider logo, title, lane and status (Needs you / Working / Idle). A row opens that chat on the CTO's machine. Six rows show, the rest fold into "and N more".
- **Upcoming** — the CTO's scheduled work as rows: title, a human schedule ("Every day around 8:00 PM", "In 20 min", "Ran 5 min ago"), its own on/off switch, and a menu with Run now and Cancel (confirm first). Empty says "Nothing scheduled. Ask the CTO to check on something later."
- **Open work** — the checklist, with inline add, tick to complete, untick to reopen, and × to remove.
- **Remembers** — the note count, the first three notes, and "See all" into Settings › Memory.

**Library** — what the CTO's work produced: PRs in the lanes its child chats worked in, proof artifacts filed by it or its children, and those lanes themselves. Filter chips: All, PRs, Proof, Lanes. Rows open the thing on the right machine. These reads run only once Library is opened.

Live updates come from chat events for the CTO and its children, debounced at 800 ms; a single 60 s safety read runs while the panel is visible. There is no polling loop.

### Calm chat

The CTO thread is drawn differently from every other chat, keyed on `presentation.profile === "persistent_identity"`.

- **One working line.** During a live turn, the tool and work rows collapse into `CtoWorkingLine`: a 16 px working avatar, the latest step in plain words ("Checking PR #12", "Reading a chat", "Starting a chat on Codex"), and the elapsed time. Click it to see every step; a second click shows the raw tool calls. When the turn ends, the normal turn fold takes over.
- **Quiet chips.** A finished call to a state-changing tool draws a chip instead of a tool row: Scheduled · `<title>`, Cancelled · `<title>`, Paused / Resumed · `<title>`, Remembered · `<note>`, Forgot · `<note>`, Tracking · `<text>`, Done · `<text>`. A failed call says "Couldn't schedule" and so on. A call still running draws nothing here, because the working line names it.
- **Reactions and quiet turns.** A `react` draws a small emoji badge on the person's bubble (`UserMessageReaction` in `AgentChatMessageList.tsx`; iOS `WorkUserMessageReactionBadge`), folded in by `attachUserMessageReaction` in `chatTranscriptRows.ts` (iOS `WorkChatMessageFold`). A turn ended with `noReply` or `react` shows only its footer.
- **Fresh context.** The `cto_context_refreshed` notice is a hairline divider labelled "Fresh context", not a card.

Non-CTO chats are unchanged.

### Welcome

A project with no model picked shows `CtoWelcome` instead of the thread: the big avatar asleep, the reason (the CTO cannot run without a model), and a model picker filtered to the eligible providers. Picking one plays asleep → happy → idle, then the thread appears. The copy names the providers. The pick is the whole of first run.

## Settings

`CtoSettingsPage` is a rail of five topics, one pane at a time, built from the settings primitives.

- **Look** — a live preview with a state strip (Idle, Working, Thinking, Waiting, Asleep, Happy, Error) that plays each state; the name; shape (seven tiles drawing the real shapes); colour (ten swatches tuned for dark and light, plus a hex input); eyes (four tiles); energy (Calm / Lively); personality (Focused / Friendly / Playful, each with an example sentence). Every change saves as you make it through `cto.updateIdentity({ patch }, pin)`, and the page says "Saved" quietly.
- **Brain** — the main model (the standard picker, filtered to models the CTO can run on) with reasoning effort and Fast; up to three backup models as an ordered list with add, move up/down and remove, under one line explaining the switch; a **Refresh context** button with its one-sentence explanation; the **Home machine** row when the account has more than one machine; and the cross-machine switch.
- **Memory** — the project notes editor with a byte meter ("1,240 of 4,096"), the "About you" editor (2,048), and the open-work list. Saves through `cto.updateNotes` and `cto.updateOpenWork`. A text over the cap is not sent; the meter says how many bytes over.
- **Routines** — every row of the CTO chat's scheduled work, with the prompt, when it last ran, and what came of it, plus recently finished one-off wake-ups. The same rows as the panel.
- **Instructions** — standing instructions (`systemPromptExtension`), then "What the CTO is told": the assembled prompt, folded.

## IPC surface

Registered in `apps/desktop/src/main/services/ipc/registerIpc.ts`, named in `apps/desktop/src/shared/ipc.ts`, reached as `window.ade.cto.*`. Every call that acts on the CTO takes a `pin` and routes to the CTO's home machine.

- Thread and identity: `ctoGetState`, `ctoGetAttention`, `ctoGetNeeds`, `ctoEnsureSession`, `ctoUpdateIdentity`, `ctoPreviewSystemPrompt`, `ctoRefreshContext`, `ctoRunProjectScan`.
- Memory: `ctoGetMemory`, `ctoUpdateNotes`, `ctoUpdateOpenWork`.
- Onboarding markers: `ctoGetOnboardingState`, `ctoCompleteOnboardingStep`.
- Linear reads, credentials and OAuth: `ctoGetLinearConnectionStatus`, `ctoGetLinearProjects`, `ctoGetLinearQuickView`, `ctoGetLinearIssuePickerData`, `ctoSearchLinearIssues`, `ctoGetLinearIssueComments`, `ctoGetLinearIssue`, `ctoCreateLinearIssue`, `ctoCreateLinearIssueComment`, `ctoCountLinearIssues`, `ctoGetLinearCustomViews`, `ctoGetLinearIssueCreateOptions`, `ctoListLinearProjectMilestones`, `ctoUploadLinearFile`, `ctoSetLinearToken`, `ctoClearLinearToken`, `ctoStartLinearOAuth`, `ctoGetLinearOAuthSession`, `ctoSetLinearOAuthClient`, `ctoClearLinearOAuthClient`.

Scheduled work has its own generic channels: `ade.agentChat.scheduledWork.pauseItem` (`agentChat.setScheduledWorkItemPaused`) and `ade.agentChat.scheduledWork.runNow` (`agentChat.runScheduledWorkNow`).

The action surface follows the same contract. `cto_state` exposes `refreshContext` and `cto_memory` exposes `getSnapshot`, `updateNotes`, `updateOpenWork` and `recordDiscovery`; both carry input contracts and the `cto_memory` domain is `allExcept`, so a method added there later is CTO-only by default. `recordDiscovery` and `getSnapshot` are the two deliberate exceptions. The hosted web client implements the CTO namespace method by method in `apps/desktop/src/renderer/webclient/adapter/misc.ts` (`getMemory`, `updateNotes`, `updateOpenWork`, `updateIdentity`, `refreshContext`, `previewSystemPrompt`).

## Sync command surface

Registered by `registerCtoRemoteCommands` in `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` and consumed by the paired clients (iOS, hosted web):

- `cto.ensureSession`, `cto.getState`, `cto.updateIdentity`.
- `cto.getHomeMachine`, `cto.setHomeMachine` — which machine owns this project's CTO.
- `cto.getAttention` — the mobile attention probe. Read-only: it delegates to `getCtoAttention()` and never materializes a session.
- `cto.getNeeds` — the "Waiting on you" lines (`CtoNeedsSnapshot`). Read-only and optional: an older brain has none, and clients show no card.
- `cto.getMemory` — the `CtoMemorySnapshot`.
- `cto.updateNotes` — the notes write, with optional `baseHash`; not queueable. `cto.updateOpenWork` — the queueable open-work write. Both are used by the hosted web client.
- `cto.refreshContext` — the hosted web client's "Refresh context".
- `cto.previewSystemPrompt` — the prompt preview in the hosted web client's CTO settings.
- The Linear surface: `cto.getLinearConnectionStatus`, `cto.getLinearQuickView`, `cto.getLinearIssuePickerData`, `cto.searchLinearIssues`, `cto.getLinearIssueComments`, `cto.getLinearIssue`, `cto.createLinearIssueComment`, `cto.createLinearIssue`, `cto.updateLinearIssue`, `cto.countLinearIssues`, `cto.getLinearCustomViews`, `cto.getLinearIssueCreateOptions`, `cto.listLinearProjectMilestones`, `cto.uploadLinearFile`, `cto.startLinearMobileOAuth`, `cto.completeLinearMobileOAuth`, `cto.setLinearToken`, `cto.clearLinearToken`.

`cto.getMemory` is the one snapshot command the iOS Memory card reads. `recentSessions` is always `[]` now, kept on the wire only so older clients decode.

## Gotchas and fragile areas

- **A refresh never runs mid-turn.** `refreshCtoProviderThread` refuses while the session is active or the runtime holds work, and records `ctoRefreshPending`; the next settled turn runs it. Tearing a runtime down under a live turn loses the turn.
- **A forgotten pointer is the whole trick.** A teardown reason alone does not stop a provider resuming: Claude reads its persisted SDK id, Codex its `threadId`, Cursor its SDK agent. `refreshCtoProviderThread` clears every field `persistedPointerState` knows, writes both metadata copies, and uses `claudeFreshThreadPending` for Claude. Codex refuses to start a fresh thread while a `threadId` exists, so the clear must come first.
- **No full replay for the CTO.** A Cursor rotation normally stages the whole transcript; the CTO's refresh deliberately does not. It carries the notes, open work, live state, the story so far and the newest messages.
- **The live state block must stay last in the volatile half.** That prefix is truncated by keeping the tail. Anything appended after the live state pushes the freshest section into the part a budgeted send can cut.
- **The static block is staged once.** Re-sending ~21 KB every turn is what once grew a real CTO thread from 46k to 237k input tokens and tripped auto-compaction. Re-stage it only for a new provider thread or when its content key changes.
- **Occupancy 55 is a deliberate choice, not a ceiling.** The CTO's turns are short and its memory is injected, so a small provider thread is fast and cheap, and a fresh one loses little that the notes, the story and the tail do not carry. Raising the number trades that for thread age; change it with measurements, not by feel.
- **The notes caps are the point.** A `remember` past the cap is refused, not truncated, so the CTO has to merge or forget. Lowering a cap silently makes the CTO look forgetful; raising it grows every turn.
- **`replaces` and `forget` must match exactly one line.** Zero or several matches are refused with the candidate lines. A substring that is not unique is a question, not a write.
- **User notes are machine-wide.** `<ADE home>/cto/USER.md` is shared by every project on that machine. A project fact written there leaks into other projects' CTOs.
- **`readHistory` reads ended sessions too.** It is the way back across a fresh context or an old thread. Do not scope it to the current session; that would make a fresh context look like amnesia.
- **The fallback loop is bounded per message.** Each model is tried at most once for the same message, and only a completed turn clears the set. A new failure cause must go through the same gate.
- **The mid-task wrapper is for the person only.** `sentByUser` is the one signal; inferring "a person" from metadata would wrap every agent's `ade chat send`. A resend reads the display text, never the wrapper.
- **A quick reply is committed at once.** `postCtoInterimReply` flushes the provider's buffer before and after its event; left in the 100 ms buffer, the provider's next delta could join it.
- **Overflow is not a fallback.** A context overflow gets a fresh provider thread, not a smaller model; the two paths have different symptoms and different fixes.
- **v2 preferences live in `preferences.json` because older builds rewrite `identity.yaml` from known keys.** A build from before `avatar`, `personality` and `fallbackModels` existed rebuilds the record (file and synced row) from the keys it knows, with the same version and `updatedAt`, which silently deleted them. Do not move them back into the record, and put any new field an older build would strip in the sidecar too.
- **The avatar must stay compositor-cheap.** Animate transform and opacity only; use step timing for the infinite idle loops; pause when off screen or the window is hidden; draw still at 24 px and under; never listen for `animationiteration`; honour `prefers-reduced-motion` by dropping the motion but keeping the eye state.
- **Panel reads go to the home machine.** Every panel, memory and routine call carries `pin`; a null pin silently talks to the tab's machine, which is the wrong one whenever the CTO's home is elsewhere.
- **The CTO does not write the repository.** Git mutations and file writes are refused in code, and work goes through `spawnChat` on its own lane. A prompt line is not the gate.

- **The CTO's tool server needs its bearer header, as a plain record.** The HTTP MCP lease (`ensureHttpMcpLeases`) answers 401 without `Authorization: Bearer …`, and the lease hands the header out in Droid's array shape. `leaseHeaderRecord` turns it into the `{ name: value }` record that Copilot, Pi, Muse, OpenCode and Cursor take. Passed as an array, Copilot refused the whole config and dropped the turn silently; OpenCode and Cursor, given no header, reached none of the CTO's tools.
- **Every provider's turn must consume the staged context.** `consumePendingTurnContextPrefix` is what carries the doctrine, notes, open work, live state and tail. A provider path that skips it runs a CTO with no memory; Copilot's did until 2026-11-14.
- **Quick replies depend on the running tool letting go.** A steered message is read at the next tool boundary. Claude moves a running shell (`Bash`, or `PowerShell` on Windows) to the background when a person steers; Codex reads the steer while its command runs. Codex confirms a steer by matching its echo against the text ADE sent, so a wrapped CTO steer records that text as `providerText`.

## Cross-links

- [Identity and Personas](../agents/identity-and-personas.md) — the identity record, the prompt layers and the memory model.
- [Chat](../chat/README.md) — the agent-chat session the CTO thread is built on.
- [Tool system](../chat/tool-system.md) — tool packs, registration and the operator tools.
- [Automations](../automations/README.md) — event-driven rules, separate from the CTO's own scheduled work.
- [Linear integration](../linear-integration/README.md) — the connection model and the read/write surface the CTO tools use.
- [Remote commands](../sync-and-multi-device/remote-commands.md) — the paired-client command surface.
- [Capture gesture](../capture-gesture/README.md) — the global screenshot chord, whose target is the CTO composer.
- [Notices](../../design/notices.md) and [Visual language](../../design/visual-language.md) — the banner/toast/dialog primitives and the surface kit the page and settings use.
