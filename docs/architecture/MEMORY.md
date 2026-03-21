# Memory Architecture

## Overview

ADE has two distinct memory systems:

1. **Unified memory database** -- A SQLite-backed store of categorized, tiered knowledge entries shared across all agents and missions. This is the primary memory system.
2. **CTO core memory** -- A small structured identity document that persists the CTO's (and each worker agent's) understanding of the project. Stored as both a JSON file and a SQLite row.

2026-03-15 portability clarification:

- live memory state still flows through ADE sync when devices are connected to the same cluster
- this Phase 6 W3 (portability) pass does **not** make unified memory or CTO/worker runtime memory Git-tracked
- Git-tracked ADE portability in the Phase 6 W3 pass is intentionally limited to the shared scaffold/config/identity layer

## Unified Memory Service

### SQLite Schema

The unified memory system uses these tables:

| Table | Purpose |
|---|---|
| `unified_memories` | Primary store for all memory entries. Columns include scope, tier, category, content, importance, confidence, access_score, composite_score, pinned, status, dedupe_key, and timestamps. |
| `unified_memories_fts` | FTS4 virtual table backed by `unified_memories.content`. Kept in sync via insert/update/delete triggers. Used for BM25 lexical search. |
| `unified_memory_embeddings` | Vector embeddings keyed by (memory_id, embedding_model). Stores raw embedding blobs and dimension count. |
| `memory_procedure_details` | Extended metadata for procedure-type memories: trigger, procedure_markdown, success/failure counts, export state. |
| `memory_procedure_sources` | Join table linking procedure memories to their source episode memories. |
| `memory_procedure_history` | Confidence history log for procedures: outcome, confidence value, reason, timestamp. |
| `memory_skill_index` | Index of exported skill files linked to their source memory entries. |
| `knowledge_capture_ledger` | Deduplication ledger for the knowledge capture service. Tracks which source events have already been processed. |
| `cto_core_memory_state` | Single-row-per-project store for CTO core memory, used alongside the JSON file for dual persistence. |

### Types

Core types are defined in two locations:

- `apps/desktop/src/main/services/memory/unifiedMemoryService.ts` -- `Memory`, `AddMemoryOpts`, `WriteMemoryOpts`, `WriteMemoryResult`, `SearchMemoryOpts`, `MemoryTier` (1 | 2 | 3), `MemoryCategory`, `MemoryImportance`, `MemoryStatus`, `MemorySourceType`, `MemorySearchMode`, `WriteGateMode`
- `apps/desktop/src/shared/types/memory.ts` -- DTOs and result types: `MemoryEntryDto`, `EpisodicMemory`, `ProceduralMemory`, `ProcedureListItem`, `ProcedureDetail`, `ChangeDigest`, `KnowledgeSyncStatus`, `MemoryHealthStats`, `MemoryEmbeddingHealthStats`, etc.

Memory scopes: `"project" | "agent" | "mission"`. Legacy aliases `"user"` and `"lane"` are normalized to `"agent"` and `"mission"` respectively.

Memory categories: `"fact" | "preference" | "pattern" | "decision" | "gotcha" | "convention" | "episode" | "procedure" | "digest" | "handoff"`.

### Write Paths

Memory enters the system through these services:

1. **Agent tool (`memoryAdd`)** -- Defined in `memoryTools.ts`. Any agent can call this during a conversation. Writes go through `unifiedMemoryService.addMemory()` or `addCandidateMemory()`.
2. **Episodic summary service** -- `episodicSummaryService.ts`. Runs after agent sessions. Uses AI to extract a structured `EpisodicMemory` (task, approach, outcome, gotchas, patterns, decisions, tools used, duration) and writes it as an `episode` category entry.
3. **Knowledge capture service** -- `knowledgeCaptureService.ts`. Processes interventions, error clusters, and PR feedback. Extracts `convention`, `preference`, `pattern`, and `gotcha` entries. Uses a ledger (`knowledge_capture_ledger`) to avoid reprocessing the same source event.
4. **Human work digest service** -- `humanWorkDigestService.ts`. Detects new git commits, builds a `ChangeDigest` (commit summaries, diffstat, file clusters), writes a `digest` category memory.
5. **Procedural learning service** -- `proceduralLearningService.ts`. Identifies repeatable workflows from episode memories. Creates `procedure` category entries with trigger descriptions, step-by-step markdown, and confidence tracking in `memory_procedure_details` / `memory_procedure_history`.
6. **Batch consolidation service** -- `batchConsolidationService.ts`. Clusters similar memories by scope, category, and lexical similarity (default threshold 0.7). Uses AI to merge clusters into single improved entries. Originals are archived.
7. **Compaction flush service** -- `compactionFlushService.ts`. When a conversation approaches its token limit, this service injects a hidden system message prompting the agent to flush important observations to memory before compaction occurs. The flush is wired into `agentChatService` via callbacks (`appendHiddenMessage` and `flushTurn`) that inject messages into the active chat session.

### Write Quality Controls

- **Deduplication** -- Every write normalizes content (whitespace collapse, lowercase, tokenize) and computes Jaccard similarity against existing entries in the same scope. At 0.85 similarity or above, the write is merged into the existing entry (observation count incremented, content updated if the new version is richer, importance takes the higher value). Exact dedupe_key matches are merged unconditionally.
- **Write gate** -- `WriteGateMode` (`"default" | "strict"`). In strict mode, only entries in `convention`, `pattern`, `gotcha`, and `decision` categories are accepted.
- **Category allowlist** -- Only the 10 defined categories are accepted. Invalid categories are rejected.
- **Prompt guidance** -- Agent system prompts contain explicit instructions about what constitutes a good vs. bad memory to reduce noise at the source.

### Read Paths

1. **Memory briefing injection** -- `memoryBriefingService.ts`. Used by mission workers. Builds a `MemoryBriefing` with sections: `l0` (pinned/tier-1), `l1` (active/tier-2), `l2` (fading/tier-3), `mission` (mission-scoped). Budget levels: `lite` (3 entries), `standard` (8), `deep` (20). The briefing also includes `sharedFacts`, `usedProcedureIds`, `usedDigestIds`, and `usedMissionMemoryIds` for tracking. Supports modes: `mission_worker`, `heartbeat`, `wake_on_demand`, `prompt_preview`.
2. **On-demand tool search** -- `memorySearch` tool in `memoryTools.ts`. Any agent can search memory by query string. Supports both `lexical` and `hybrid` (BM25 + cosine) search modes.
3. **IPC read endpoints** -- The renderer can list, search, and inspect memories via IPC for the Settings -> Memory UI panel.

### Lifecycle

- **Decay** -- Access score decays using the formula `nextScore = currentScore * 0.5^(daysSinceAccess / halfLifeDays)`. Default half-life: 30 days. Entries in the `preference` and `convention` categories are evergreen (exempt from decay). Pinned entries are also exempt.
- **Sweep** -- Runs at startup or manually. Applies decay to all non-exempt entries, demotes entries below threshold, promotes qualifying candidates, archives entries exceeding scope limits. Processes entries in chunks of 250.
- **Scope limits** -- Enforced during sweep. project: 2000, agent: 500, mission: 200. When a scope exceeds its limit, lowest-scoring entries are archived.
- **Consolidation** -- Runs on a configurable schedule or manually. Groups entries by (scope, scopeOwnerId, category), clusters by lexical similarity (threshold 0.7), merges clusters via AI, archives originals. Targets scopes at 80%+ capacity first.
- **Stale detection** -- Entries not accessed within 24 hours (default) are flagged for potential demotion during sweep.

### Embedding Service

Defined in `embeddingService.ts`.

- Model: `Xenova/all-MiniLM-L6-v2` (via `@xenova/transformers` / `@huggingface/transformers`)
- Dimensions: 384
- Task: `feature-extraction` with mean pooling and normalization
- Cache: Content-hash-based in-memory LRU cache for embeddings. Tracks hit/miss rates.
- Storage: `unified_memory_embeddings` table, one row per (memory_id, model) pair
- Background worker: `embeddingWorkerService.ts` processes a queue of unembedded entries in batches
- States: `idle -> loading -> ready` (or `unavailable` on error)
- Health monitoring: structured logging for state transitions, queue depth, processing rates, error rates, and cache hit/miss ratios. Health data is surfaced in Settings > Memory health tab at 10-second polling intervals.

### Hybrid Search

Defined in `hybridSearchService.ts`.

- BM25 component: queries `unified_memories_fts` with standard BM25 parameters (k1=1.2, b=0.75)
- Vector component: cosine similarity against embedded query vector, minimum 40 vector candidates
- Fusion: Normalized BM25 + cosine scores combined with MMR (lambda=0.7) for diversity
- Falls back to lexical-only if the embedding model is not loaded

## CTO Core Memory

### Type Definition

From `apps/desktop/src/shared/types/cto.ts`:

```typescript
type CtoCoreMemory = {
  version: number;
  updatedAt: string;
  projectSummary: string;
  criticalConventions: string[];
  userPreferences: string[];
  activeFocus: string[];
  notes: string[];
};
```

### Dual Persistence

- **File**: `.ade/cto/core-memory.json`
- **SQLite**: `cto_core_memory_state` table (project_id PK, version, payload_json, updated_at)

On startup, `ctoStateService.ts` reads both sources and reconciles by version number. The higher version wins. On write, both are updated atomically.

This dual-persistence pattern is currently used for runtime robustness and connected-cluster behavior. In this narrowed Phase 6 W3 (portability) pass, it should not be interpreted as "file means Git-tracked". `cto/core-memory.json` remains local/generated even though it is file-backed.

### Daily Logs

The CTO state service supports append-only daily logs stored as markdown files under `.ade/cto/daily/<YYYY-MM-DD>.md`:

- `appendDailyLog(entry, date?)` -- appends a timestamped `- [HH:MM:SS] entry` line
- `readDailyLog(date?)` -- reads the full log for a given day
- `listDailyLogs(limit?)` -- lists available daily log dates, most recent first (default: 7)

Raw daily logs are still operational history rather than Git-tracked ADE state. If downstream work needs their substance on another desktop, it should use a future explicit summary/export design rather than tracking raw append-only logs.

### Injection

`buildReconstructionContext()` in `ctoStateService.ts` serializes the CTO snapshot (identity, core memory, recent session logs, recent subordinate activity, and continuity state) into a text block. This is injected into CTO identity chat sessions as the continuity layer, separate from the immutable ADE-owned doctrine in the system prompt.

When a CTO or worker identity session undergoes context compaction, `refreshReconstructionContext()` is called automatically to re-inject the full continuity layer. The immutable doctrine and selected personality overlay stay in the system prompt, while reconstruction restores project-specific continuity.

### Worker Agents

Worker agents follow the same pattern via `AgentCoreMemory` (defined in `apps/desktop/src/shared/types/agents.ts`), with identical fields to `CtoCoreMemory`. Persisted in `.ade/agents/<slug>/core-memory.json`. Injected via `buildReconstructionContext()` in `workerAgentService.ts`.

That worker core-memory file remains local/runtime state in this Phase 6 W3 (portability) pass. Another desktop learns live worker memory by connecting to the host, not by pulling it from Git.

## Portability contract

Memory-related ADE state now has three buckets:

- **Git-tracked shared ADE layer**: this pass does not include memory exports; it is limited to shared scaffold/config/identity files such as `.ade/cto/identity.yaml`
- **ADE-sync memory/runtime state**: connected-cluster DB state such as live mission-scoped memories, access scores, and other runtime records that benefit from real-time replication
- **Local-only operational logs**: raw session logs, append-only runtime traces, caches, embeddings artifacts, and other machine-bound byproducts

Future workstreams must choose one bucket explicitly. This narrowed Phase 6 W3 (portability) pass intentionally leaves memory portability out of the Git-tracked layer.

## Memory Briefing Service

`memoryBriefingService.ts` builds memory context for injection into mission worker prompts.

Input: `BuildMemoryBriefingArgs` -- projectId, optional missionId, runId, agentId, taskDescription, phaseContext, handoffSummaries, filePatterns, mode.

Output: `MemoryBriefing` -- sections for l0 (pinned), l1 (active), l2 (search-matched), mission (mission-scoped), plus shared facts and tracking arrays for procedures, digests, and mission memories used.

Budget limits control how many entries are included per section: `lite` = 3, `standard` = 8, `deep` = 20.

The briefing query is constructed from the task description, phase context, handoff summaries, and file patterns.

### Direct-Source Context Injection

The briefing service now supplements memory database entries with direct-source context:

- **Git log**: Recent commit summaries are read directly from `git log` (via `humanWorkDigestService.getRecentCommitSummaries()` or a fallback `git log --oneline`), injected as synthetic `digest` memories. This replaces reliance on stale digest entries in the database.
- **Instruction files**: `CLAUDE.md`, `agents.md`, and `AGENTS.md` are read from the project root and injected as synthetic `procedure` memories. This ensures agent briefings always include current instruction files regardless of memory database state.

These synthetic memories are constructed with full `Memory` shape (tier 1, promoted, confidence 1.0) so they integrate seamlessly with the existing briefing budget and deduplication logic.

## Agent Prompt Guidance

Memory-related instructions are embedded in agent prompts in these files:

| File | What It Contains |
|---|---|
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | Base system prompt with memory usage instructions |
| `apps/desktop/src/main/services/ai/tools/memoryTools.ts` | `memoryAdd` and `memorySearch` tool definitions with quality guidance |
| `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts` | Coordinator-level memory tools |
| `apps/desktop/src/main/services/orchestrator/coordinatorAgent.ts` | Coordinator agent memory integration |
| `apps/desktop/src/main/services/memory/compactionFlushService.ts` | Pre-compaction flush prompt that instructs agents to save observations |

## Key Service Files

| Service | Path |
|---|---|
| Unified memory service | `apps/desktop/src/main/services/memory/unifiedMemoryService.ts` |
| Memory briefing service | `apps/desktop/src/main/services/memory/memoryBriefingService.ts` |
| Memory lifecycle (sweep) | `apps/desktop/src/main/services/memory/memoryLifecycleService.ts` |
| Batch consolidation | `apps/desktop/src/main/services/memory/batchConsolidationService.ts` |
| Embedding service | `apps/desktop/src/main/services/memory/embeddingService.ts` |
| Embedding worker | `apps/desktop/src/main/services/memory/embeddingWorkerService.ts` |
| Hybrid search | `apps/desktop/src/main/services/memory/hybridSearchService.ts` |
| Episodic summary | `apps/desktop/src/main/services/memory/episodicSummaryService.ts` |
| Knowledge capture | `apps/desktop/src/main/services/memory/knowledgeCaptureService.ts` |
| Human work digest | `apps/desktop/src/main/services/memory/humanWorkDigestService.ts` |
| Procedural learning | `apps/desktop/src/main/services/memory/proceduralLearningService.ts` |
| Compaction flush | `apps/desktop/src/main/services/memory/compactionFlushService.ts` |
| Skill registry | `apps/desktop/src/main/services/memory/skillRegistryService.ts` |
| CTO state (core memory) | `apps/desktop/src/main/services/cto/ctoStateService.ts` |
| Worker agent (core memory) | `apps/desktop/src/main/services/cto/workerAgentService.ts` |
| Memory types (shared) | `apps/desktop/src/shared/types/memory.ts` |
| Memory tools (agent) | `apps/desktop/src/main/services/ai/tools/memoryTools.ts` |
| DB schema | `apps/desktop/src/main/services/state/kvDb.ts` |
