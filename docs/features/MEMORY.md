# Memory

## What It Is

ADE's memory system gives AI agents the ability to retain and recall knowledge across sessions. Without memory, every agent conversation starts from scratch. With memory, agents accumulate project-specific insights, recall past mistakes and patterns, and avoid repeating work. Memory is the mechanism that turns individual agent sessions into a compounding knowledge base.

Memory operates automatically in the background. Agents save learnings as they work, system services capture knowledge from commits, interventions, and PR feedback, and lifecycle processes keep the memory store clean and relevant. You do not need to seed or manage memory for it to be useful.

## Knowledge Pools

Memory entries belong to one of three scopes:

- **Shared (project)** -- Visible to all agents and missions in the project. Contains conventions, patterns, gotchas, and decisions that apply project-wide. Limit: 2000 entries.
- **Agent-specific** -- Private to one agent. Stores that agent's individual learnings, preferences, and habits. Limit: 500 entries per agent.
- **Mission-specific** -- Scoped to one mission. Holds context relevant to a particular task or objective. Limit: 200 entries per mission.

## Priority Levels

Each memory entry has a tier that determines how aggressively it is surfaced:

- **Tier 1 (Pinned)** -- Always included in agent briefings. Reserved for the most critical knowledge. Entries can be pinned manually or by the system.
- **Tier 2 (Active)** -- Included when budget allows. These are recently accessed or high-confidence entries.
- **Tier 3 (Fading)** -- Included only in deep searches. Entries decay to this tier when they have not been accessed recently.

## How Memory Gets Created

Memory enters the system through multiple paths:

- **Agent tools** -- Any AI agent can call the `memoryAdd` tool to save a durable insight during a conversation. The tool enforces quality guidance: good memories capture conventions, patterns, gotchas, and decisions. Bad memories (status updates, task-specific details, obvious facts) are rejected by prompt guidance. Additionally, the write path rejects code-derivable content such as raw diffs, stack traces, session summaries, git history output, and file-path dumps -- these belong in source control, not memory. Writes return a `durability` field (`"candidate"`, `"promoted"`, or `"rejected"`) so agents know whether the memory was accepted and at what tier.
- **Compaction flush** -- When a chat session approaches its context window limit, the compaction flush service injects a hidden prompt asking the agent to persist important observations via `memoryAdd` before context is compacted. This is fully wired into `agentChatService` so no durable discoveries are lost to compaction.
- **Episodic summaries** -- After agent work sessions complete, the episodic summary service extracts a structured record of what was attempted, what worked, and what failed.
- **Knowledge capture** -- The knowledge capture service monitors interventions, error clusters, and PR feedback, then extracts conventions, patterns, and gotchas into memory entries. It also fires on mission failures and agent session errors to capture failure-related gotchas.
- **Human work digest** -- When you make commits outside of ADE, the digest service detects the new HEAD via the git head watcher, generates a change summary, and stores it as a digest memory so agents stay aware of manual changes. The digest service is connected to the head watcher's `handleHeadChanged` callback.
- **Procedural learning** -- The procedural learning service identifies repeatable workflows from episodic memories and distills them into step-by-step procedures with confidence tracking. High-confidence procedures are exported as `.ade/skills/` files for reuse.
- **Consolidation** -- The batch consolidation service merges clusters of similar entries into single, higher-quality memories using AI.

## How Memory Gets Maintained

Memory is not permanent. A lifecycle system keeps it healthy:

- **Decay** -- Every memory has an access score that decays with a 30-day half-life. Entries that are not read or searched gradually lose priority. Pinned entries and entries in the `preference` and `convention` categories are exempt from decay.
- **Sweep** -- A daily sweep runs at startup (or manually). It applies decay, demotes entries whose score drops below threshold, promotes candidates that have gained enough confidence, and archives entries that exceed scope limits.
- **Consolidation** -- A weekly consolidation pass (or manual trigger) clusters similar memories by scope and category, then uses AI to merge them into a single improved entry. The originals are archived.
- **Deduplication** -- On every write, the system checks for lexical similarity (Jaccard threshold of 0.85). Exact or near-duplicate content is merged into the existing entry rather than creating a new one.

## Automatic Memory Orientation

ADE classifies each user turn by intent and enforces a memory orientation policy:

- **Required turns** (fix, debug, implement, refactor, etc.) -- ADE auto-injects relevant memory context into the agent's system prompt and blocks mutating tools (bash, file writes, edits) until the agent has called `memorySearch` at least once. This prevents agents from making changes without consulting project memory.
- **Soft turns** (explain, review, design, etc.) -- Memory context is auto-injected but mutations are not blocked.
- **Meta turns** (greetings, thanks, etc.) -- No memory injection or gating.

This policy is transparent to the user. When the guard fires, the chat surface shows a system notice indicating that memory search is required before mutations can proceed.

## Smart Search

ADE includes an optional local embedding model (`Xenova/all-MiniLM-L6-v2`, 384-dimensional vectors) that enables meaning-based search. When enabled:

- Memory entries are embedded into vectors and stored in the `unified_memory_embeddings` table.
- Searches use a hybrid BM25 + cosine similarity approach with MMR (Maximal Marginal Relevance) re-ranking to balance relevance and diversity.
- The model runs locally -- no data is sent externally for embedding.
- Without the embedding model loaded, search falls back to lexical FTS (full-text search) only.
- Items that arrive while the model is unavailable are queued rather than dropped. The queue is drained automatically when the model finishes loading, so no embeddings are lost to startup timing or transient model unavailability.

### Embedding Health Monitoring

The embedding service emits structured health logs covering:

- Service state transitions (`idle -> loading -> ready` or `unavailable`)
- Queue depth and processing rates
- Error rates and failure categories
- Cache hit/miss ratios

These are visible in the Settings > Memory health tab, which shows embedding progress and status at 10-second polling intervals.

## Change Tracking

The human work digest service monitors the project's git HEAD. When it detects new commits made outside of ADE, it generates a structured digest containing commit summaries, diffstats, changed file lists, and file clusters. This digest is saved as a memory entry with the `digest` category, keeping agents informed of manual code changes.

The memory briefing service also reads recent git log entries and project instruction files (`CLAUDE.md`, `agents.md`, `AGENTS.md`) directly from disk and injects them as synthetic memory entries into agent briefings. This ensures agents always have current commit context and instruction files regardless of memory database state.

## CTO Core Memory

The CTO agent has a separate, structured core memory document distinct from the unified memory database. This is a small identity-level document with five fields:

- `projectSummary` -- A concise description of the project.
- `criticalConventions` -- Key rules and patterns the team follows.
- `userPreferences` -- The user's stated preferences for how the CTO should behave.
- `activeFocus` -- Current priorities or areas of attention.
- `notes` -- Freeform observations.

Core memory is persisted in two places: the file `.ade/cto/core-memory.json` and the SQLite `cto_core_memory_state` table. On startup, the system reconciles the two by version number, preferring the newer copy. Core memory is injected as the first message in every CTO session via `buildReconstructionContext()`.

The CTO system prompt also includes three baked-in protocol sections as part of the identity:

- **Memory Protocol** -- proactive memory search before work, save corrections and decisions, flush findings when context is large
- **Daily Context** -- a startup self-orientation protocol (search focus areas, check subordinate activity, review conventions)
- **Decision Framework** -- autonomous decisions when safe, escalate when risky, search before asking

These protocols ensure consistent behavior across sessions and are re-injected after context compaction.

### Daily Logs

The CTO state service maintains append-only daily logs under `.ade/cto/daily/<YYYY-MM-DD>.md`. These are automatically included in the CTO continuity context for the current day, providing within-day session-to-session continuity.

### Post-Compaction Identity Re-injection

When a CTO or worker identity session undergoes context compaction, the agent chat service automatically calls `refreshReconstructionContext()` to re-inject the full identity context (persona, core memory, protocols). This ensures the CTO does not lose its persona or behavioral instructions after compaction.

Worker agents follow the same pattern through `AgentCoreMemory` (same five fields), persisted in `.ade/agents/<slug>/core-memory.json`.

## Memory Pipeline

The full memory pipeline is now wired end-to-end:

```
Agent conversations
  → compaction flush (pre-compaction memoryAdd)
  → episodic summary (post-session extraction)
  → procedural learning (multi-episode pattern distillation)
  → skill export (.ade/skills/ materialization)

External changes
  → git head watcher detects new commits
  → human work digest (change summary → digest memory)

Failures & feedback
  → mission/agent failures trigger captureFailureGotcha
  → knowledge capture extracts gotchas, conventions, patterns
```

## Where to Manage Memory

Learned memory entries are managed in **Settings -> Memory** tab. This is the only surface for viewing, searching, pinning, and deleting learned knowledge. It also shows health stats (scope usage, last sweep, last consolidation, embedding status). Memories that back indexed skill files are intentionally hidden from the generic memory browser to avoid duplication; the Memory tab shows a summary card linking to the Workspace skill-file surface instead.

Skill files (reusable instructions and legacy command files) are managed separately in **Settings -> Context & Docs -> Skill Files**. ADE indexes them internally as procedure knowledge for retrieval, ranking, and dedupe, but the file-backed entries are managed in the workspace skill-file surface rather than the generic Memory browser.

## Further Reading

For technical implementation details, see the [Memory Architecture doc](../architecture/MEMORY.md).
