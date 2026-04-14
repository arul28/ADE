# Compaction, Synthesis, and Invalidation

Memory is not write-only: ADE actively synthesises new entries, merges
similar ones, and invalidates stale state. This doc covers the services
that keep the memory store healthy.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/memory/compactionFlushService.ts` | Hidden pre-compaction prompt injector. Runs before provider context compaction so durable findings are saved. |
| `apps/desktop/src/main/services/memory/episodicSummaryService.ts` | Post-session episode extraction: task description, approach, outcome, patterns, gotchas, decisions, tools. |
| `apps/desktop/src/main/services/memory/proceduralLearningService.ts` | Clusters episodes into procedures; tracks confidence via `memory_procedure_history`; exports skill files. |
| `apps/desktop/src/main/services/memory/batchConsolidationService.ts` | Weekly batch AI-driven consolidation: merges clusters of similar entries into a single higher-quality entry. |
| `apps/desktop/src/main/services/memory/memoryLifecycleService.ts` | Daily sweep: decay, demotion, promotion, scope-limit archival. |
| `apps/desktop/src/main/services/memory/missionMemoryLifecycleService.ts` | Mission-specific: promotes high-value mission-scoped entries to project scope on mission success. |
| `apps/desktop/src/main/services/memory/knowledgeCaptureService.ts` | Captures conventions/patterns/gotchas from interventions, error clusters, PR feedback, and failure events. |
| `apps/desktop/src/main/services/memory/humanWorkDigestService.ts` | Watches the git HEAD for external commits; emits change digests used by briefings. |

## Compaction flush

When a chat session approaches its context window limit, the provider
may compact (summarise + discard) earlier turns. Before that happens,
ADE injects a hidden system prompt asking the agent to save durable
findings via `memoryAdd`.

### Flow

1. `agentChatService` monitors conversation token count and compares
   against `maxTokens - reserveTokensFloor`.
2. When the threshold is crossed, `compactionFlushService.maybeFlush()`
   runs.
3. It appends a hidden `{ role: "system", content: <flush prompt>,
   hidden: true }` message and invokes `flushTurn()` to run a
   provider turn dedicated to saving memories.
4. The prompt includes explicit SAVE / DO-NOT-SAVE guidance to keep
   memory quality high (see `CompactionFlushConfig.flushPrompt`).
5. After the flush completes (or fails), normal compaction proceeds.

### Config

```ts
type CompactionFlushConfig = {
  enabled?: boolean;                      // default true
  reserveTokensFloor?: number;            // token safety margin
  maxFlushTurnsPerSession?: number;       // cap; prevents runaway flushes
  flushPrompt?: string;                   // override default prompt
};
```

### State tracking

`SessionFlushState` (per session):

```ts
type SessionFlushState = {
  flushCount: number;
  flushedBoundaries: Set<string>;
};
```

Each compaction boundary gets a unique `boundaryId` (derived from the
message count + timestamp). The service refuses to flush the same
boundary twice; if the boundary budget is exceeded, the service logs
`budget-exceeded` and skips.

### Result

`CompactionFlushResult.reason` can be:

- `disabled` -- config disabled.
- `below-threshold` -- token count below the flush threshold.
- `flush-handler-unavailable` -- no `flushTurn` provided.
- `already-flushed-boundary` -- same boundary seen before.
- `max-flush-turns-reached` -- session budget exhausted.
- `flushed` -- success.
- `flush-failed` -- handler threw.
- `flush-budget-exceeded` -- flush handler reported `budget_exceeded`.

`proceedWithCompaction` is always `true` -- the caller should compact
regardless of flush outcome.

## Episodic summary

After a mission attempt or a coding session completes, the episodic
summary service extracts a structured record of what happened.

### EpisodicMemory

```ts
type EpisodicMemory = {
  id: string;
  sessionId?: string;
  missionId?: string;
  taskDescription: string;
  approachTaken: string;
  outcome: "success" | "partial" | "failure";
  toolsUsed: string[];
  patternsDiscovered: string[];
  gotchas: string[];
  decisionsMade: string[];
  duration: number;   // seconds
  createdAt: string;
};
```

### Flow

1. Session completion event fires.
2. `episodicSummaryService.summarize(sessionContext)` runs an AI call
   (`aiIntegrationService.executeTask`) with the session transcript and
   a structured prompt asking for the `EpisodicMemory` schema.
3. On success, the episode is persisted as a `unified_memories` row
   with `category: "episode"`, scope set from the mission/session
   context, and `source_type: "system"`.
4. On AI failure, `fallbackEpisode()` produces a minimal record so the
   episode is never silently lost.
5. Downstream: procedural learning monitors new episodes and batches
   them for pattern distillation.

## Procedural learning

Episodes are raw; procedures are structured step-by-step workflows that
can be re-executed. `proceduralLearningService.ts` distills procedures
from episode clusters.

### Flow

1. Monitor new `episode` memories. Cluster by normalised task text.
2. When a cluster reaches a minimum size, run an AI call to produce a
   procedure candidate.
3. Write the candidate as a `unified_memories` row with `category:
   "procedure"` (starts in `candidate` status).
4. Persist structured fields in `memory_procedure_details`: trigger,
   procedure markdown, success/failure counters.
5. Record each contributing episode in `memory_procedure_sources`.
6. As the procedure is reused, `recordOutcome(procedureId, outcome,
   confidence, reason)` appends a `memory_procedure_history` row and
   updates the counters.
7. When confidence is sustained, the procedure promotes to `promoted`
   status.

### Skill export

High-confidence procedures export to `.ade/skills/<slug>.md` via
`exportProcedureSkill`. The export path is recorded in
`memory_procedure_details.exported_skill_path`. Re-exports compare
content hashes to avoid rewriting unchanged files.

### Supersession

Procedures can be superseded by an improved version; the
`superseded_by_memory_id` field links the old procedure to its
replacement so history stays queryable while retrieval only returns
the current one.

### PR-feedback episodes

Episodes with `sourceId` starting `pr_feedback:` are flagged via
`isPrFeedbackEpisode` and get different clustering treatment (higher
confidence weight, distinct procedure trigger text).

## Batch consolidation

`batchConsolidationService.ts` runs weekly (or on manual trigger) to
merge clusters of similar entries into single higher-quality entries.

### Flow

1. Iterate consolidation targets: `{ scope, scopeOwnerId }` pairs with
   enough entries to consolidate.
2. For each target:
   - Pull all promoted entries for the target.
   - Embed and cluster by cosine similarity (threshold configurable).
   - For clusters larger than a minimum size, call the AI
     (`aiIntegrationService.executeTask`) with the cluster content
     and a merge prompt.
   - Insert the merged result as a new memory (`source_type:
     "consolidation"`, `category` inherited from the majority in the
     cluster).
   - Archive the originals; the new memory's `source_id` references
     the cluster.
3. `memory_consolidation_log` records the run with started_at /
   ended_at / trigger / outcome.

### Output

- `MemoryConsolidationResult` -- summary of what was consolidated per
  target.
- `onStatus` callback -- live status events for the Settings UI.

### Embedding dependency

Consolidation requires embeddings (it clusters by cosine similarity).
If the embedding service is unavailable, consolidation skips and
reports `reason: "embeddings-unavailable"`.

## Mission memory lifecycle

`missionMemoryLifecycleService.ts` runs on mission completion:

- Mission success: promote mission-scoped entries that match
  promotion criteria (confidence threshold, category allowlist) to
  project scope. Entries are copied (not moved) with `source_type:
  "mission_promotion"` so the mission history retains the originals.
- Mission failure: extract failure gotchas via
  `captureFailureGotcha`, which feeds into the knowledge capture
  service.
- Mission cancellation: no promotion; the mission entries remain
  scoped.

## Knowledge capture

`knowledgeCaptureService.ts` captures conventions, patterns, gotchas,
and preferences from non-conversational signals.

### Sources

| Source type | Trigger |
|---|---|
| `intervention` | User interrupted or corrected an agent mid-task. |
| `error_capture` | Single error event with extracted context. |
| `error_cluster` | Multiple errors clustered by similarity. |
| `pr_feedback` | Review comments, failed checks, coderabbit/dependabot/codecov filtered out. |

### Filters

Before persisting, content passes through:

- `isPrBotContent` -- rejects PR-bot output (codecov, coderabbit,
  renovate, dependabot, generated-by comments, HTML-only blocks).
- `isPredominantlyHtml` -- rejects structural HTML.
- Plain-text extraction via `stripHtmlTags` normalises the content.

### Ledger

Each capture records a row in `memory_capture_ledger` keyed by
`(project_id, source_type, source_key)`. Re-running against an
already-captured source is a no-op.

## Daily sweep

`memoryLifecycleService.ts` runs the daily sweep (at startup or manual
trigger):

1. **Decay pass.** Update `access_score` for non-evergreen, non-pinned
   entries.
2. **Demotion.** Entries whose score drops below their tier's threshold
   move down a tier (or archive from Tier 3).
3. **Promotion.** Candidates that exceed a confidence threshold and
   have been accessed at least once become `promoted`.
4. **Scope-limit archival.** When `project`/`agent`/`mission` scope
   exceeds its limit, archive the lowest-scored non-pinned entries.
5. **Stale archive.** Entries not accessed in `staleAfterHours`
   (default 24 h) and below a minimum score may archive depending on
   category.
6. Record the run in `memory_sweep_log`.

`MemoryLifecycleSweepResult` is returned; the Settings UI renders the
counts.

## Invalidation rules

| Event | Effect |
|---|---|
| Manual delete | Row transitions to `archived`. FTS and embeddings follow via triggers. |
| Consolidation merge | Originals archive; merged entry inherits highest confidence. |
| Jaccard dedup on write | Incoming content merges into the existing entry (`observation_count++`, `confidence` blended). |
| Procedure supersession | `superseded_by_memory_id` set; retrieval skips superseded procedures. |
| Mission promotion | Mission entry is copied to project scope; original remains. |
| Human-work digest | Digest is emitted into the briefing but not persisted as a memory row; cursor advances to the new HEAD. |
| Compaction flush | Emits `memoryAdd` calls which follow the normal write gate. |

## Fragile and tricky wiring

- **Compaction flush relies on the provider emitting a compaction
  event.** Claude, Codex, and OpenCode all emit `context_compact`
  events, but the thresholds differ. The service listens for the
  common event; new providers must integrate the watcher.
- **Procedural learning clustering is text-similarity based.** If
  `normalizeText` drops too much signal (e.g., stripping numbers in a
  way that merges distinct procedures), procedures can get confused.
- **Consolidation clustering requires embeddings.** Missing embeddings
  silently disables consolidation. Check health stats if weekly
  consolidation never runs.
- **Mission promotion idempotency.** `memory_capture_ledger` is the
  only dedup mechanism; missing entries here cause duplicates on
  mission re-execution.
- **Knowledge-capture regex filters age.** PR-bot patterns
  (`PR_BOT_PATTERNS`) hard-code bot names. New bots leak into the
  capture stream until the list is updated.
- **Episode fallback creates records with confidence 0.5.** If AI
  summarisation fails repeatedly, the store fills with low-confidence
  fallback episodes. Monitor `source_type: "system"` entries with
  minimal content for this signature.
- **Sweep runs on startup.** Long sweeps block app startup in the
  foreground briefly. The service chunks updates into 250-row batches
  to yield to the event loop, but the startup cost scales with row
  count.

## Related docs

- [Memory README](README.md) -- overview and pipeline diagram.
- [Storage](storage.md) -- tables and indexes.
- [Embeddings](embeddings.md) -- vector search that powers
  consolidation clustering and hybrid retrieval.
</content>
</invoke>