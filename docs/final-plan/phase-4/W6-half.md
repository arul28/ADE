# W6½: Memory Engine Hardening
> Source: [OpenClaw Memory Masterclass](https://velvetshark.com/articles/openclaw-memory-masterclass) — pre-compaction flush, "file as truth" principle, bootstrap file reload. [Mem0 consolidation](https://docs.mem0.ai/open-source/features/custom-categories) — batch merge pattern for category-scoped entries. [Paperclip §7 Runtime Context](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) — context snapshots per run.

Dependencies: **W6** (shipped). No dependency on embeddings (W7a) — all operations here are lexical/composite.

W6 shipped the unified memory engine with write gate, tier lifecycle, and composite scoring. W6½ hardens the engine with operational gaps identified after initial deployment: context compaction causes silent memory loss (no flush), stale entries accumulate without lifecycle enforcement, and there is no batch consolidation to prevent entry bloat over time. These are prerequisites for W7a (embeddings operate on a clean, deduplicated memory store) and W7b (orchestrator memory integration assumes reliable persistence).

##### Pre-Compaction Flush

Adapted from [OpenClaw's memory preservation pattern](https://velvetshark.com/articles/openclaw-memory-masterclass): before the Vercel AI SDK's context compaction runs, the agent gets a silent agentic turn to persist important discoveries to memory. Without this, any facts discovered in the context window that haven't been explicitly saved are lost when compaction summarizes and truncates the conversation.

- **Detection hook**: Register a `beforeCompaction` callback on the agent chat service. The callback fires when the conversation token count exceeds `maxTokens - reserveTokensFloor` (configurable, default 40K tokens). This gives the agent a buffer zone to act before compaction is forced.

- **Silent flush turn**: The system injects a hidden system message:
  ```
  [SYSTEM] Context compaction is imminent. Review your working context for any discoveries,
  decisions, or facts that have not been persisted to memory. Call memoryAdd for each one now.
  This is your last chance before context is summarized.
  ```
  The agent responds with `memoryAdd` calls (or no-ops if everything is already saved). This turn is not displayed in the chat UI — it's a system-level memory preservation mechanism.

- **Flush counter**: Track `flushCount` per session to prevent double-flush. If `flushCount > 0` for the current compaction boundary, skip the flush turn. Reset on new session.

- **Token budget**: The flush turn consumes tokens from `reserveTokensFloor`. The agent's response (memory writes) must fit within this budget. If the agent exceeds the budget, compaction proceeds anyway — the flush is best-effort, not a hard gate.

- **Configuration**:
  ```typescript
  interface CompactionFlushConfig {
    enabled: boolean;                // default: true
    reserveTokensFloor: number;      // default: 40_000
    maxFlushTurnsPerSession: number; // default: 3 (prevent infinite flush loops)
    flushPrompt: string;             // customizable system message
  }
  ```

##### Lifecycle Sweeps

Enforce temporal decay and tier transitions that W6 defined but did not schedule. Without active enforcement, entries accumulate indefinitely and Tier 2/3 boundaries are never applied.

- **Sweep scheduler**: `memoryLifecycleSweep()` runs on a configurable interval (default: daily at 3am local, or on app startup if >24h since last sweep). Uses a lightweight SQLite query — no LLM calls in the default sweep.

- **Sweep operations** (in order):
  1. **Temporal decay**: Update `accessScore` for all entries based on time since `lastAccessedAt`. Formula: `score * Math.pow(0.5, daysSinceAccess / halfLifeDays)`. Default half-life: 30 days. Entries with `tier: 1` (pinned) are exempt from decay — their `accessScore` is held at the pinned value.
  2. **Tier demotion**: Entries in Tier 2 with `lastAccessedAt > 90 days` → demote to Tier 3. Entries in Tier 3 with `lastAccessedAt > 180 days` → set `status: "archived"`.
  3. **Candidate sweep**: Entries with `status: "candidate"` that have `confidence >= 0.7` and `observationCount >= 2` → auto-promote to `status: "promoted"`. Candidates with `confidence < 0.3` and `age > 30 days` → auto-archive.
  4. **Hard limit enforcement**: If project memory exceeds 2,000 entries, archive lowest-scoring Tier 3 entries until under limit. Same for agent (500) and mission (200) scopes.
  5. **Orphan cleanup**: Entries with `scope: "mission"` where the mission no longer exists in `orchestrator_runs` → archive.

- **Sweep log**: Each sweep writes a summary to `sweep_log` table: `{ sweepId, timestamp, decayed, demoted, promoted, archived, orphaned, duration_ms }`. Visible in Settings > Memory > Health.

- **Evergreen exemptions**: Entries with `category: "preference"` or `category: "convention"` and `importance: "high"` are exempt from temporal decay. User preferences and coding conventions should not decay with time — they are valid until explicitly changed.

##### Batch Consolidation

Weekly batch job that detects clusters of near-duplicate or thematically related entries and merges them via LLM. This prevents the memory store from growing unboundedly as agents write incremental discoveries across missions.

- **Trigger**: Weekly (default: Sunday 2am local), or manually from Settings > Memory > "Run Consolidation". Also triggered when any scope exceeds 80% of its hard limit.

- **Consolidation pipeline**:
  1. **Cluster detection**: Group entries by `(scope, category)`. Within each group, compute pairwise lexical similarity (Jaccard on trigrams — no embeddings needed). Entries with similarity > 0.7 form a cluster.
  2. **LLM merge**: For each cluster of 3+ entries, invoke LLM with the entries and ask for a consolidated version:
     ```
     You are consolidating related memory entries. Merge these into a single comprehensive entry,
     preserving all unique information. Output the merged content and a confidence score.

     Entries to consolidate:
     {{entries}}
     ```
  3. **Merge result**: Create one new entry with the merged content, highest `importance` from the cluster, average `confidence`, combined `observationCount`, and `sourceType: "consolidation"`. Archive the original entries (don't delete — they're still queryable if needed).
  4. **Safety**: Never consolidate Tier 1 (pinned) entries — those are user-curated. Never merge across scopes. Never merge entries with different `category` values.

- **Consolidation stats**: Track `{ clustersFound, entriesMerged, entriesCreated, tokensUsed }` per run. Visible in Settings > Memory > Health.

##### Context Snapshots per Run

Adapted from [Paperclip's runtime context pattern](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md): capture a lightweight snapshot of what context was assembled for each agent run. This enables debugging ("what did the worker know when it ran?") and retrospective analysis ("did the worker have the right context?").

- **Snapshot capture**: On worker activation (briefing assembly in W7b), serialize the assembled context into a `ContextSnapshot`:
  ```typescript
  interface ContextSnapshot {
    runId: string;
    agentId: string;
    missionId?: string;
    timestamp: string;
    l0Entries: string[];     // memory IDs injected at L0
    l1Entries: string[];     // memory IDs injected at L1
    l2Entries: string[];     // memory IDs injected at L2 (agent memory)
    missionEntries: string[];// memory IDs from mission scope
    totalTokens: number;     // estimated tokens in assembled context
    searchQueries: string[]; // what queries were used for L1 search
  }
  ```
- **Storage**: Snapshots stored in `context_snapshots` table (SQLite, gitignored). Retained for 30 days, then auto-deleted by lifecycle sweep.
- **UI**: Snapshot viewable from Mission Logs tab → click a worker run → "Context Snapshot" expandable section showing what memory entries the worker received.

##### Service Architecture

```
memoryLifecycleService.ts     — Sweep scheduler, temporal decay, tier transitions, hard limits
batchConsolidationService.ts  — Cluster detection, LLM merge, consolidation stats
compactionFlushService.ts     — Pre-compaction detection, flush turn injection, flush counter
contextSnapshotService.ts     — Snapshot capture on worker activation, storage, cleanup
```

All services instantiated in `main.ts`. `compactionFlushService` hooks into `agentChatService`. `memoryLifecycleService` runs on a timer. `batchConsolidationService` runs weekly. `contextSnapshotService` is called by the worker briefing assembly path.

##### IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `memory:run-sweep` | renderer → main | Manually trigger lifecycle sweep |
| `memory:sweep-status` | main → renderer | Sweep progress and results |
| `memory:run-consolidation` | renderer → main | Manually trigger batch consolidation |
| `memory:consolidation-status` | main → renderer | Consolidation progress and results |
| `memory:get-snapshot` | renderer → main | Retrieve context snapshot for a run |
| `memory:health-stats` | renderer → main | Sweep log, consolidation stats, entry counts |

##### DB Changes

```sql
-- Sweep log
create table if not exists memory_sweep_log (
  sweep_id text primary key,
  timestamp text not null,
  entries_decayed integer default 0,
  entries_demoted integer default 0,
  entries_promoted integer default 0,
  entries_archived integer default 0,
  entries_orphaned integer default 0,
  duration_ms integer default 0
);

-- Consolidation log
create table if not exists memory_consolidation_log (
  consolidation_id text primary key,
  timestamp text not null,
  clusters_found integer default 0,
  entries_merged integer default 0,
  entries_created integer default 0,
  tokens_used integer default 0,
  duration_ms integer default 0
);

-- Context snapshots
create table if not exists context_snapshots (
  run_id text primary key,
  agent_id text not null,
  mission_id text,
  timestamp text not null,
  snapshot_json text not null,  -- JSON-serialized ContextSnapshot
  total_tokens integer default 0
);
```

##### Renderer

- **Settings > Memory > Health tab**: Dashboard showing:
  - Entry counts by scope and tier (bar chart or table).
  - Last sweep: timestamp, entries processed, actions taken.
  - Last consolidation: timestamp, clusters merged, entries reduced.
  - Embedding status (placeholder — populated by W7a).
  - Hard limit usage: "Project: 847 / 2,000", "CTO: 123 / 500".
  - Manual action buttons: "Run Sweep Now", "Run Consolidation Now".
- **Context snapshot viewer**: In Mission Logs tab, each worker run shows an expandable "Context Snapshot" section listing the memory entries injected at each level (L0/L1/L2/mission) with entry IDs linked to the Memory inspector.

**Implementation status:** ✅ Complete (2026-03-09). Memory lifecycle sweeps (temporal decay, tier demotion, candidate promotion, hard limit enforcement, orphan cleanup), batch consolidation (Jaccard trigram clustering + LLM merge), pre-compaction flush, and Memory Health dashboard in Settings are all shipped.

**Tests:**
- Pre-compaction flush: flush turn injected when tokens exceed threshold, memoryAdd calls in flush turn persist entries, flush counter prevents double-flush, flush skipped when counter > maxFlushTurns.
- Temporal decay: entries decayed by correct half-life formula, Tier 1 entries exempt from decay, evergreen categories exempt from decay.
- Tier demotion: Tier 2 entries older than 90 days demoted to Tier 3, Tier 3 entries older than 180 days archived.
- Candidate sweep: candidates with confidence >= 0.7 and observationCount >= 2 promoted, low-confidence old candidates archived.
- Hard limit enforcement: project scope with > 2,000 entries archives lowest-scoring Tier 3 entries, agent scope with > 500 entries enforced similarly.
- Orphan cleanup: mission-scoped entries for deleted missions archived.
- Batch consolidation: cluster detection groups entries with similarity > 0.7, LLM merge produces valid consolidated entry, original entries archived (not deleted), Tier 1 entries never consolidated, cross-scope merge blocked.
- Consolidation safety: entries with different categories never merged, consolidation stats recorded accurately.
- Context snapshots: snapshot captured on worker activation, correct memory IDs recorded at each level, snapshots auto-deleted after 30 days.
- Sweep scheduling: sweep runs on startup if > 24h since last sweep, sweep log entry created with correct counts.
- Health dashboard: entry counts render correctly, sweep/consolidation logs display, hard limit bars show correct percentages.
- Consolidation trigger: auto-triggered when scope exceeds 80% of hard limit.
