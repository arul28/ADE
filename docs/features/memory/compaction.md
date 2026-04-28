# Compaction, Synthesis, and Invalidation

Memory is not write-only: ADE actively synthesises new entries, merges
similar ones, and invalidates stale state. This doc covers the services
that keep the memory store healthy.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/memory/compactionFlushPrompt.ts` | `DEFAULT_FLUSH_PROMPT` — the text fed into the Claude SDK `PreCompact` hook so durable findings can be saved before compaction runs. |
| `apps/desktop/src/main/services/memory/episodicSummaryService.ts` | Post-session episode extraction: task description, approach, outcome, patterns, gotchas, decisions, tools. |
| `apps/desktop/src/main/services/memory/proceduralLearningService.ts` | Clusters episodes into procedures; tracks confidence via `memory_procedure_history`; exports skill files. |
| `apps/desktop/src/main/services/memory/batchConsolidationService.ts` | Weekly batch AI-driven consolidation: merges clusters of similar entries into a single higher-quality entry. |
| `apps/desktop/src/main/services/memory/memoryLifecycleService.ts` | Daily sweep: decay, demotion, promotion, scope-limit archival. |
| `apps/desktop/src/main/services/memory/missionMemoryLifecycleService.ts` | Mission-specific: promotes high-value mission-scoped entries to project scope on mission success. |
| `apps/desktop/src/main/services/memory/knowledgeCaptureService.ts` | Captures conventions/patterns/gotchas from interventions, error clusters, PR feedback, and failure events. |
| `apps/desktop/src/main/services/memory/humanWorkDigestService.ts` | Watches the git HEAD for external commits; emits change digests used by briefings. |

## Compaction flush

When a Claude chat session approaches its context window limit, the
Claude Agent SDK auto-compacts (summarises + discards) earlier turns.
ADE nudges the agent to save durable findings before that happens by
registering a `PreCompact` SDK hook that returns `DEFAULT_FLUSH_PROMPT`
as a `systemMessage`. The hook runs inside the SDK's compaction flow,
so the prompt never becomes a visible chat turn and does not consume
conversation tokens.

### Flow

1. Claude SDK auto-compacts when approaching the context limit.
2. The SDK fires `PreCompact` on the hook registered by
   `buildClaudeSessionOpts` in `agentChatService.ts`.
3. The hook returns `{ continue: true, systemMessage:
   DEFAULT_FLUSH_PROMPT }`; the SDK folds the prompt into the
   compaction step (best-effort — see "Caveats").
4. The SDK then emits `system:compact_boundary`.
   `agentChatService.ts` translates that into a `context_compact` chat
   event rendered as the amber "Context compacted" badge.
5. For CTO sessions, post-compaction identity re-injection runs
   (`ctoStateService.appendContinuityCheckpoint` +
   `refreshReconstructionContext`) to restore persona/memory context.

### Where the prompt lives

`apps/desktop/src/main/services/memory/compactionFlushPrompt.ts`
exports `DEFAULT_FLUSH_PROMPT`. It encodes the quality bar (one
actionable insight per memory, SAVE vs DO-NOT-SAVE lists, the
`NO_DISCOVERIES` escape hatch) so Claude doesn't over-save.

### Scope

- **Claude** — `PreCompact` hook registered for non-lightweight
  sessions. Boundary event `system:compact_boundary` translates to the
  `context_compact` chat event.
- **OpenCode** — auto-compacts at ~96% of context. The SDK emits
  `session.compacted` (payload `{ sessionID }`) on the SSE stream; the
  OpenCode runtime maps it to `context_compact`. No client-side
  pre-compact hook; OpenCode's `experimental.session.compacting` is a
  server-side plugin hook, not exposed to hosts.
- **Codex** — auto-compacts around `model_auto_compact_token_limit`
  (default ~64k). The app-server emits `item/started` +
  `item/completed` where `item.type === "contextCompaction"`; the
  Codex runtime emits `context_compact` on completion. Codex has no
  pre-compact hook equivalent.
- **Cursor / ACP** — no compaction signal. Neither the base ACP spec
  nor Cursor's extensions define a compaction or summarization
  notification. Cursor summarizes internally but keeps it hidden from
  the protocol. No indicator possible today.

### Caveats

- `PreCompactHookInput.custom_instructions` is what the SDK feeds the
  hook (e.g. text from a `/compact <instructions>` invocation); the
  hook itself influences compaction via `SyncHookJSONOutput`. Routing
  of `systemMessage` into the compaction prompt is SDK-internal — the
  primary guarantee of this design is that the prompt never leaks as a
  visible turn. Memory saving still happens opportunistically through
  the ADE CLI `memory_add` guidance already in the system prompt.

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

- **Pre-compact hook nudge is Claude-only.** Only the Claude Agent
  SDK exposes a `PreCompact` hook that fires *before* compaction and
  can influence it. Compaction *boundary events* are wired for
  Claude, OpenCode, and Codex; Cursor/ACP has no signal to listen
  for.
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