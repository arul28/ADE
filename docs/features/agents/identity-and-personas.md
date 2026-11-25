# Identity and Personas

The CTO carries a persistent identity that survives across provider threads, context compactions, and model switches. This doc explains how that identity is stored, how each turn is reconstructed from it, how the single immutable doctrine shapes behavior, and how the notes and open work keep the thread grounded.

There is one persistent identity: the CTO. `AgentChatIdentityKey` is `"cto"`.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/cto/ctoStateService.ts` | CTO identity CRUD, system-prompt composition, onboarding markers, the static and volatile context blocks, the live project-state block, and startup reconciliation. |
| `apps/desktop/src/main/services/cto/ctoMemoryService.ts` | The CTO's memory store: project notes (`MEMORY.md`), notes about the person (`USER.md`), the open-work list, the worker-discovery queue, and the injection sections. |
| `apps/desktop/src/main/services/cto/ctoPromptContent.ts` | `buildCtoCapabilityManifest()` — the operator-tool manifest and tool-pack list injected into the prompt — plus the opening-turn prompt and its marker. |
| `apps/desktop/src/main/services/ai/tools/ctoToolPacks.ts` | The closed list of CTO tool packs and their one-line scopes. Zero imports, so the prompt builder can read it without the tool runtime. |
| `apps/desktop/src/main/services/chat/ctoTurnContext.ts` | Pure pieces of a CTO turn: line-aligned tail truncation, child PR extraction, and the one-line child report format. |
| `apps/desktop/src/main/services/chat/codexCtoToolDeferral.ts` | Codex dynamic-tool specs and the CTO pack defer predicate. |
| `apps/desktop/src/main/services/ai/tools/universalTools.ts` | Hosts `recordDiscovery`, the append-only memory contribution every agent gets. |
| `apps/desktop/src/shared/types/cto.ts` | CTO identity, onboarding, prompt-preview, memory, avatar and capability types. |

## CTO identity

`CtoIdentity` is versioned and stored per project. It contains the name, persona, nullable model preferences, up to three fallback models, the avatar look, the personality, onboarding markers, and an optional prompt extension.

Personality is a voice, not a second prompt: `focused` (the default) adds nothing to the doctrine, `friendly` warms the tone, `playful` allows light humour. The doctrine's precision and verification rules apply in all three. The avatar look is stored beside it and drives the character everywhere the CTO appears.

Storage:

1. SQLite `cto_identity_state`.
2. Filesystem `.ade/cto/identity.yaml`, written atomically.

Startup reconciliation compares timestamps and writes the newer copy back to the stale side. Users should edit through ADE's UI so version ordering stays clear.

The record's shape has its own `schemaVersion`. CTO v2 starts every CTO over, so nothing converts v1 records. Keys `normalizeIdentity` does not know, the v1 ones included, ride along untouched.

## Immutable doctrine and prompt layers

`ctoStateService.ts` composes the CTO system prompt from layered sections, immutable first:

- `IMMUTABLE_CTO_DOCTRINE` — CTO role, responsibilities, precision rules, how the CTO speaks, and how it helps with ADE itself. This is the whole of the CTO's voice. It says to lead with the answer in one to three sentences, to stay level (no exclamation marks, no "great question"), to say plainly when it does not know and then go check, to disagree once with a reason and then drop it, and never to call something done before verifying it. It also tells the CTO that it knows the ADE application and not only the repository: when the user is lost in ADE it answers as a question about the product, consults ADE's own documentation before guessing, and hands back a deeplink rather than navigation directions.
- `CTO_CONTINUITY_OPERATING_MODEL` — one continuous CTO. ADE keeps the whole conversation and may give the CTO a fresh provider context at any time; the notes, open work and live state are injected every turn; `readHistory` reaches everything said before a fresh context.
- `CTO_MEMORY_SYSTEM_GUIDANCE` — teaches `remember`, `forget`, `trackWork`, `finishWork` and `scheduleWork`, and that the notes have a hard size cap.
- Environment knowledge — ADE surfaces, tools, task-routing rules, the live model registry, and instructions to discover installed-version capabilities through bundled `ade-*` skills plus `ade actions list --text` / `ade actions run`.
- `CTO_CAPABILITY_MANIFEST` — the available CTO operator tools, generated from `createCtoOperatorTools()` and injected verbatim.

A voice block for the chosen personality is inserted after the doctrine's "How you speak" rules; `focused` adds none. `previewSystemPrompt()` returns exactly these sections, which the settings UI renders. The section ids are `doctrine`, `continuity`, `memory`, `knowledge`, `capabilities`.

## Memory system

The CTO's memory is small and file-backed, owned by `ctoMemoryService`. Nothing in it runs a model. The caps are in UTF-8 bytes.

| File | Role | Cap |
|---|---|---|
| `.ade/cto/MEMORY.md` | Project notes: facts, decisions and conventions for this project, one `- ` line each. Written by `remember`/`forget` and the settings editor. | 4096 (`CTO_PROJECT_NOTES_MAX_BYTES`) |
| `<ADE home>/cto/USER.md` | Notes about the person, shared by the CTO of every project on this machine. | 2048 (`CTO_USER_NOTES_MAX_BYTES`) |
| `.ade/cto/open-work.json` | What the CTO started and has not finished. | 20 open, 30 finished |
| `.ade/cto/discoveries.md` (+ `discoveries-archive.md`, `discoveries.cursor`) | The unreviewed worker-discovery queue and its read cursor. Never injected. | 128 KiB, evicted oldest first |

The CTO reads and writes memory through operator tools: `remember({ note, scope?, replaces? })` adds a line or rewrites the one line containing `replaces`; `forget({ note, scope? })` removes a line; `trackWork({ text })` adds an open-work item and returns its id; `finishWork({ id, outcome? })` marks one done; `readHistory({ query?, before?, limit? })` pages or searches the whole CTO conversation; `readDiscoveries()` drains the worker queue; `searchMemory({ query?, kinds?, id? })` searches the archive and `recallNote({ id, scope? })` pins an archived entry again.

A note is one line, clipped at 400 characters. A new note that duplicates an existing one is not saved and the CTO is told which line already says it. `replaces` and `forget` must match exactly one line, or the call comes back with the candidate lines. A write past the cap moves the least recently used notes to the archive (`.ade/cto/archive.db`) and the result lists them; without an archive on the machine it is refused with the byte counts, as before. See [the CTO's archive](../cto/README.md#the-archive).

A one-time reset, guarded by `.ade/cto/.v2-migrated`, moves the v1 files and the v1 `MEMORY.md` into `.ade/cto/legacy-v1/`. Nothing is imported, so the notes start empty. Nothing is deleted.

### Discoveries, and who else can reach memory

Discovery lines carry a closed-vocabulary `[lane: pr: path: topic:]` suffix (`formatMemoryTagSuffix`), so a finding can name the lane, PR, path or topic it came from. The CTO's own notes do not carry tags; they are short prose lines.

Two rules reach ordinary agents:

- **Every agent can contribute.** `recordDiscovery` is a universal tool (also `ade actions run cto_memory.recordDiscovery`) that appends one timestamped, secret-redacted, tagged line to the discovery queue. There is deliberately no matching read tool on the worker side — a worker hands a finding up without gaining a view of what the CTO knows — and the action policy for the `cto_memory` domain is inverted (`allExcept`) so a method added there later is CTO-only by omission. The queue is byte-capped with archive eviction, and its read cursor is a byte offset that can re-deliver but never skip.
- **No project chat gets the CTO's notes.** Worker chats do not receive a lane-scoped memory section, and there is no per-lane reader. A worker hands findings up through `recordDiscovery`; the CTO decides what becomes a note.

Nothing distills the queue on a schedule. The CTO drains it with `readDiscoveries` and writes notes itself.

### How memory reaches the model

`buildMemoryContextSections()` returns three sections, rebuilt on every turn: `## Notes (project) — N of 4096 bytes`, `## Notes about the person — N of 2048 bytes`, and `## Open work` (open items with ids, then up to five recently finished ones). They carry their byte counts in the heading so the CTO can see how close to a cap it is.

## Turn context and fresh contexts

On every send, `ctoStateService.buildReconstructionContext()` produces the volatile block:

1. `CTO Context` — name, persona, preferred model.
2. The project notes section and file.
3. The notes-about-the-person section and file.
4. The open-work section.
5. The live project-state block, appended last — see [CTO](../cto/README.md). It goes last because the prefix truncates by keeping its tail, so the most perishable section must sit where a budgeted send cannot cut it. That truncation is line-aligned (`truncateTailToLineBoundary`), so the model never receives half a doctrine line or half a lane row.

The static half (`buildStaticContextSection()`: the doctrine and voice, the continuity model, the memory guidance, the environment knowledge document and the capability manifest, about 21 KB) is staged once per provider thread. `agentChatService` re-stages it when the provider thread changes or when its content key changes.

A fresh provider context (`refreshCtoProviderThread()`) carries the static block, the volatile block and the last 40 messages of the conversation. It runs when a settled turn's thread is at or past 55% occupancy, after a compaction, after a context overflow (the person's message is then sent once more), on a model fallback, or when the person asks for one. It never runs mid-turn: a busy CTO gets it as soon as the turn ends. There is no daily log, no rolling thread-state file and no memory pass; the ADE transcript is the record and `readHistory` reads it.

## Onboarding state

`CtoOnboardingState` tracks internal markers. There is no setup wizard — a new CTO opens on the model picker, and the pick is the whole of first run. The only marker is `intro`, which records that the opening turn was sent. `getOnboardingState` and `completeOnboardingStep` exist only to carry it.

## IPC surface

| Channel | Purpose |
|---|---|
| `ade.cto.getState` | Fetch the CTO identity. |
| `ade.cto.previewSystemPrompt` | Render the current layered system prompt for settings. |
| `ade.cto.updateIdentity` | Patch identity fields (name, persona, model preferences, fallback models, avatar, personality, prompt extension). |
| `ade.cto.ensureSession` | Get or create the single CTO chat session. |
| `ade.cto.getAttention` | Read-only: is the CTO blocked on the person? |
| `ade.cto.refreshContext` | Give the CTO a fresh provider thread. |
| `ade.cto.getMemory` / `ade.cto.updateNotes` / `ade.cto.updateOpenWork` | Read the memory snapshot, rewrite one notes file, change the open-work list. |
| `ade.cto.getOnboardingState` / `completeOnboardingStep` | Internal step marker (`intro`). No user-facing wizard. |

## Fragile and tricky wiring

- **A fresh context never runs mid-turn.** `refreshCtoProviderThread` refuses while the thread is busy and records the reason for the next settled turn.
- **A forgotten provider pointer is what makes the thread fresh.** Clearing the pointer fields is the only thing that stops Claude, Codex or Cursor resuming the old thread; a teardown reason alone does not.
- **Injected memory is authoritative.** The prompt tells the CTO not to claim memory it does not have injected; injection caps and order in `ctoMemoryService`/`ctoStateService` directly change what the CTO "knows."
- **Capability knowledge is generated and runtime-aware.** `buildCtoCapabilityManifest()` derives its curated operator-tool inventory from `createCtoOperatorTools()`. Service actions outside that set must be discovered from the installed runtime's `ade actions list --text` catalog and bundled `ade-*` skills rather than copied into a second static list.
- **`readHistory` must keep reading ended sessions.** Old CTO sessions are how the conversation survives a fresh context; scoping it to the current session would make a fresh context look like amnesia.
- **The notes caps are load-bearing.** A write past a cap is refused so the per-turn prefix stays small. Raising a cap grows every turn; lowering one makes the CTO look forgetful.
- **Legacy files move, never disappear.** The v1 reset writes `.ade/cto/legacy-v1/`; do not turn that into a delete.
- **`cto_session_logs` is dormant.** The table stays in the schema (tables are never dropped), but nothing reads or writes it.

## Related docs

- [Agents README](README.md) — overview of the CTO and chat agents.
- [CTO](../cto/README.md) — the full CTO thread, memory system, and settings surface.
- [Tool Registration](tool-registration.md) — how identity flows into ADE CLI-exposed tools.
- [Chat Agent Routing](../chat/agent-routing.md) — provider selection and model preferences.
