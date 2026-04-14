# Memory

ADE's memory system lets agents retain knowledge across sessions. It is
a unified store with three scopes (project, agent, mission), three tiers
(pinned, active, fading), and a lifecycle that decays, consolidates,
and promotes entries over time. Memory operates automatically in the
background; agents and the user rarely touch the raw store.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/memory/memoryService.ts` | Core CRUD, dedup, write gates, tier and status logic. Entry point for all other memory services. |
| `apps/desktop/src/main/services/memory/hybridSearchService.ts` | BM25 + cosine vector search + MMR re-ranking. Used by `memorySearch` when embeddings are available. |
| `apps/desktop/src/main/services/memory/embeddingService.ts` / `embeddingWorkerService.ts` | Local embedding model (`Xenova/all-MiniLM-L6-v2`, 384 dims). Generates vectors and queues pending writes. |
| `apps/desktop/src/main/services/memory/memoryLifecycleService.ts` | Daily sweep: decay, demotion, promotion, archival by scope limits. |
| `apps/desktop/src/main/services/memory/batchConsolidationService.ts` | Weekly consolidation: cluster similar entries and merge via AI. |
| `apps/desktop/src/main/services/memory/knowledgeCaptureService.ts` | Captures conventions/patterns/gotchas from interventions, error clusters, PR feedback, and failures. |
| `apps/desktop/src/main/services/memory/episodicSummaryService.ts` | Post-session episode extraction (what was attempted, what worked, what failed). |
| `apps/desktop/src/main/services/memory/proceduralLearningService.ts` | Distills repeatable workflows from episodes into Procedures; exports skill files. |
| `apps/desktop/src/main/services/memory/humanWorkDigestService.ts` | Generates change digests when the user commits outside ADE. |
| `apps/desktop/src/main/services/memory/compactionFlushService.ts` | Injects a hidden memoryAdd prompt before chat context compaction. |
| `apps/desktop/src/main/services/memory/memoryBriefingService.ts` | Assembles briefings that get injected into agent prompts. |
| `apps/desktop/src/main/services/memory/memoryFilesService.ts` | Generates `.ade/memory/MEMORY.md` and topic files from promoted memories. |
| `apps/desktop/src/main/services/memory/memoryRepairService.ts` | Schema migrations and integrity repairs. |
| `apps/desktop/src/main/services/memory/skillRegistryService.ts` | Tracks the skill files indexed into memory. |
| `apps/desktop/src/main/services/memory/missionMemoryLifecycleService.ts` | Mission-specific: promotes high-value mission memories to project scope on success. |
| `apps/desktop/src/main/services/ai/tools/memoryTools.ts` | Agent-facing `memorySearch` / `memoryAdd` / `memoryPin` tools. |
| `apps/desktop/src/shared/types/memory.ts` | Shared types (`MemoryScope`, `MemoryTier`, `MemoryCategory`, digest types). |

SQL schema lives in `apps/desktop/src/main/services/state/kvDb.ts`.

## Scopes

| Scope | Purpose | Limit |
|---|---|---|
| `project` | Visible to every agent and mission in the project. Conventions, patterns, gotchas, decisions that apply project-wide. | 2000 |
| `agent` | Private to one agent identity (CTO or worker). Individual learnings, preferences, habits. | 500 per agent |
| `mission` | Scoped to a single mission. Task-specific context. High-value entries are promoted to project scope on mission success. | 200 per mission |

The write API also accepts `"user"` and `"lane"` as input; these
normalize to `agent` and `mission` respectively in
`normalizeScope()`.

## Tiers

| Tier | Meaning |
|---|---|
| 1 (Pinned) | Always included in briefings. Reserved for the most critical knowledge. Can be pinned manually or by the system. |
| 2 (Active) | Included when budget allows. Recently accessed or high-confidence. |
| 3 (Fading) | Included only in deep searches. Entries decay to this tier when not accessed. |

## Categories

The `MemoryCategory` enum (in `memoryService.ts`):

- `fact` -- concrete facts or invariants.
- `preference` -- user or project preferences. Evergreen (exempt from
  decay).
- `pattern` -- implementation patterns (write-gated in strict mode).
- `decision` -- architectural or product decisions (write-gated).
- `gotcha` -- non-obvious pitfalls (write-gated).
- `convention` -- coding or workflow conventions (write-gated,
  evergreen).
- `episode` -- post-session episodic memories.
- `procedure` -- distilled workflows with confidence tracking.
- `digest` -- change digests (not stored as rows now; surfaced via the
  briefing service directly).
- `handoff` -- handoff summaries.

Four categories (`convention`, `pattern`, `gotcha`, `decision`) are the
"strict write" set. `writeMode: "strict"` forces stricter dedup and
confidence checks on them.

## Status

- `candidate` -- recently written, not yet promoted. Lower retrieval
  priority.
- `promoted` -- accepted for retrieval.
- `archived` -- removed from retrieval but kept for audit.

## Write flow

`memoryService.writeMemory(opts)`:

1. Validate `scope`, `category`, `importance`.
2. Compute a `dedupeKey` and run Jaccard similarity against existing
   entries (threshold 0.85); duplicates merge into the existing entry
   rather than creating a new row.
3. Honor scope+category allowlists.
4. Enforce write-gate rules (strict write mode stricter rejection of
   code-derivable content: raw diffs, stack traces, session summaries,
   git history output, file-path dumps).
5. Insert/update the `unified_memories` row, update FTS, enqueue an
   embedding job.
6. Emit `onMemoryUpserted` callback.
7. Return `WriteMemoryResult` with `accepted`, `memory`, `deduped`,
   `mergedIntoId`, `reason`.

## Read flow

`memoryService.search(opts)` returns a ranked list:

- When `hybridSearchService` is available and embeddings exist, uses
  BM25 + cosine + MMR (see [embeddings](embeddings.md)).
- Otherwise falls back to lexical FTS.

`memoryService.listMemories(opts)` performs filtered retrieval without
ranking; used by the UI's Memory tab and by lifecycle services.

## Bootstrap memory files

In addition to the SQLite store, ADE generates project memory bootstrap
files under `.ade/memory/`:

- `MEMORY.md` -- condensed overview for Claude-style auto-load.
- Topic files such as `conventions.md`, `gotchas.md`, `procedures.md`.

These are derived from promoted memory by `memoryFilesService.ts` and
auto-loaded into chats and worker briefings in bounded form.

## Turn-level memory guard

Chat classifies each user turn by intent (`none`, `soft`, `required`).
When a turn is `required` (fix, debug, implement, refactor), mutating
tools (`bash`, `writeFile`, `editFile`) are blocked until the agent has
called `memorySearch`. The guard state is `TurnMemoryPolicyState` in
`memoryTools.ts`; `explicitSearchPerformed` flips to true on any
`memorySearch` invocation.

`soft` turns auto-inject memory context but do not block mutations.
`meta` turns (greetings, thanks) skip memory altogether.

See the [Tool System doc](../chat/tool-system.md#turn-level-memory-guard)
for how the gate applies.

## Pipeline

```
Agent conversations
  -> compaction flush (pre-compaction memoryAdd)
  -> episodic summary (post-session extraction)
  -> procedural learning (multi-episode pattern distillation)
  -> skill export (.ade/skills/ materialization)

External changes
  -> git head watcher detects new commits
  -> human work digest (change summary -> briefing context + sync status)

Failures and feedback
  -> mission/agent failures trigger captureFailureGotcha
  -> knowledge capture extracts gotchas, conventions, patterns
     from interventions, error clusters, and PR feedback
```

Lifecycle jobs:

- **Decay** -- every memory has an access score; decay is geometric
  with a 30-day half-life. Evergreen categories (`preference`,
  `convention`) and pinned entries are exempt.
- **Sweep** -- daily. Applies decay, demotes entries below threshold,
  promotes confident candidates, archives entries exceeding scope
  limits.
- **Consolidation** -- weekly (`batchConsolidationService.ts`).
  Clusters similar entries by scope and category, merges via an AI
  call, archives the originals.

## CTO core memory

Distinct from the unified store: a small structured document that
carries the CTO's standing identity state. See
[agents/identity-and-personas](../agents/identity-and-personas.md) for
the full flow. The CTO also has a `memoryUpdateCore` tool to overwrite
the core memory block (workers get the same tool for their own core
memory).

## IPC surface

All channels are invoke-style and prefixed `ade.memory.*`. Defined in
`apps/desktop/src/shared/ipc.ts`, handled in
`apps/desktop/src/main/services/ipc/registerIpc.ts`.

| Channel | Purpose |
|---|---|
| `ade.memory.add` | Write a memory (delegates to `memoryService.writeMemory`). |
| `ade.memory.pin` | Pin an entry to Tier 1. |
| `ade.memory.updateCore` | Overwrite CTO/agent core memory. |
| `ade.memory.getBudget` | Report scope usage vs. limit. |
| `ade.memory.getCandidates` | List candidate-status memories (for manual promotion). |
| `ade.memory.promote` | Promote a candidate to `promoted`. |
| `ade.memory.promoteMissionEntry` | Promote a mission-scoped entry to project scope. |
| `ade.memory.archive` | Archive an entry. |
| `ade.memory.search` | Search (hybrid when embeddings available, else lexical). |
| `ade.memory.list` | Filtered list (no ranking). |
| `ade.memory.listMissionEntries` | Mission-specific listing. |
| `ade.memory.listProcedures` | List procedure memories with details. |
| `ade.memory.getProcedureDetail` | Fetch one procedure with full markdown + history. |
| `ade.memory.exportProcedureSkill` | Materialise a procedure as a skill file. |
| `ade.memory.listIndexedSkills` | List skill files indexed into memory. |
| `ade.memory.reindexSkills` | Re-scan `.ade/skills/` and the legacy commands dir. |
| `ade.memory.syncKnowledge` | Run human-work-digest sync now. |
| `ade.memory.getKnowledgeSyncStatus` | Current `KnowledgeSyncStatus`. |
| `ade.memory.healthStats` | Scope usage, last sweep, last consolidation, embedding status. |
| `ade.memory.downloadEmbeddingModel` | Trigger embedding model download. |
| `ade.memory.runSweep` / `ade.memory.sweepStatus` | Manual sweep + status. |
| `ade.memory.runConsolidation` / `ade.memory.consolidationStatus` | Manual consolidation + status. |

## Where memory shows up in the UI

- **Settings -> Memory** -- browse, search, pin, delete. Shows scope
  usage, last sweep, last consolidation, embedding status.
- **Settings -> Context & Docs -> Skill Files** -- manages file-backed
  skill entries separately from generic memories.
- **Chat system notices** -- memory loads (bootstrap, topic files) and
  guard fires surface as `system_notice` events with `noticeKind:
  "memory"`.
- **Work-log summaries** -- `memoryAdd` and `memorySearch` tool calls
  render in the work log like any other tool.

## Fragile and tricky wiring

- **Dedup by Jaccard.** Threshold 0.85 is empirical; lowering it causes
  aggressive merging, raising it causes growth toward limits.
- **Embedding queue during model load.** When the embedding model is
  still loading, new memories queue rather than drop. The queue is
  drained in `embeddingWorkerService.ts` when the model reports ready.
  Missing the drain causes silent loss of embeddings.
- **Evergreen exemption order.** Decay skips evergreen categories
  before checking the importance threshold, so raising an evergreen
  entry's importance does not affect its decay (it is already exempt).
- **Sweep promotion criteria.** Candidates promote when confidence
  exceeds a threshold and they have been accessed at least once.
  Changing thresholds mid-session can abruptly promote or demote large
  batches.
- **FTS triggers.** Inserts, deletes, and updates on
  `unified_memories` fire triggers that keep `unified_memories_fts` in
  sync. Schema migrations that skip the triggers leave FTS stale and
  searches return stale rows.
- **Write gate rejection is silent by design.** Agents get `durability:
  "rejected"` when a write is gated; there is no error event so the
  agent must check the return value. If the agent assumes success, it
  will report to the user as if the write succeeded.
- **Briefing injection bounded.** The briefing service caps each
  section to a budget; long memory lists silently truncate. See
  `memoryBriefingService.ts` `BUDGET_LIMITS`.
- **Knowledge capture dedup via ledger.** The `memory_capture_ledger`
  keeps one row per (source_type, source_key) to prevent duplicate
  captures. Dropping that dedup doubles gotchas on replayed
  interventions.

## Detail docs

- [Storage](storage.md) -- SQLite schema, indexes, triggers, write
  gates.
- [Compaction](compaction.md) -- compaction flush, episodic summary,
  procedural learning, consolidation.
- [Embeddings](embeddings.md) -- local embedding model, hybrid search,
  health monitoring.

## Related docs

- [Chat Tool System](../chat/tool-system.md) -- `memorySearch` /
  `memoryAdd` / `memoryPin` / `memoryUpdateCore` tool definitions.
- [Agents Identity and Personas](../agents/identity-and-personas.md) --
  CTO core memory document, agent core memory.
</content>
</invoke>