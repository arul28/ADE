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

- **Agent tools** -- Any AI agent can call the `memoryAdd` tool to save a durable insight during a conversation. The tool enforces quality guidance: good memories capture conventions, patterns, gotchas, and decisions. Bad memories (status updates, task-specific details, obvious facts) are rejected by prompt guidance.
- **Episodic summaries** -- After agent work sessions complete, the episodic summary service extracts a structured record of what was attempted, what worked, and what failed.
- **Knowledge capture** -- The knowledge capture service monitors interventions, error clusters, and PR feedback, then extracts conventions, patterns, and gotchas into memory entries.
- **Human work digest** -- When you make commits outside of ADE, the digest service detects the new HEAD, generates a change summary, and stores it as a digest memory so agents stay aware of manual changes.
- **Procedural learning** -- The procedural learning service identifies repeatable workflows from episodic memories and distills them into step-by-step procedures with confidence tracking.
- **Consolidation** -- The batch consolidation service merges clusters of similar entries into single, higher-quality memories using AI.

## How Memory Gets Maintained

Memory is not permanent. A lifecycle system keeps it healthy:

- **Decay** -- Every memory has an access score that decays with a 30-day half-life. Entries that are not read or searched gradually lose priority. Pinned entries and entries in the `preference` and `convention` categories are exempt from decay.
- **Sweep** -- A daily sweep runs at startup (or manually). It applies decay, demotes entries whose score drops below threshold, promotes candidates that have gained enough confidence, and archives entries that exceed scope limits.
- **Consolidation** -- A weekly consolidation pass (or manual trigger) clusters similar memories by scope and category, then uses AI to merge them into a single improved entry. The originals are archived.
- **Deduplication** -- On every write, the system checks for lexical similarity (Jaccard threshold of 0.85). Exact or near-duplicate content is merged into the existing entry rather than creating a new one.

## Smart Search

ADE includes an optional local embedding model (`Xenova/all-MiniLM-L6-v2`, 384-dimensional vectors) that enables meaning-based search. When enabled:

- Memory entries are embedded into vectors and stored in the `unified_memory_embeddings` table.
- Searches use a hybrid BM25 + cosine similarity approach with MMR (Maximal Marginal Relevance) re-ranking to balance relevance and diversity.
- The model runs locally -- no data is sent externally for embedding.
- Without the embedding model loaded, search falls back to lexical FTS (full-text search) only.

## Change Tracking

The human work digest service monitors the project's git HEAD. When it detects new commits made outside of ADE, it generates a structured digest containing commit summaries, diffstats, changed file lists, and file clusters. This digest is saved as a memory entry with the `digest` category, keeping agents informed of manual code changes.

## CTO Core Memory

The CTO agent has a separate, structured core memory document distinct from the unified memory database. This is a small identity-level document with five fields:

- `projectSummary` -- A concise description of the project.
- `criticalConventions` -- Key rules and patterns the team follows.
- `userPreferences` -- The user's stated preferences for how the CTO should behave.
- `activeFocus` -- Current priorities or areas of attention.
- `notes` -- Freeform observations.

Core memory is persisted in two places: the file `.ade/cto/core-memory.json` and the SQLite `cto_core_memory_state` table. On startup, the system reconciles the two by version number, preferring the newer copy. Core memory is injected as the first message in every CTO session via `buildReconstructionContext()`.

Worker agents follow the same pattern through `AgentCoreMemory` (same five fields), persisted in `.ade/agents/<slug>/core-memory.json`.

## Where to Manage Memory

Memory is managed in **Settings -> Memory** tab. This is the only surface for viewing, searching, pinning, and deleting memory entries. It also shows health stats (scope usage, last sweep, last consolidation, embedding status).

Skill files (reusable instructions and commands) are not memory. They are managed separately in **Settings -> Context & Docs**.

## Further Reading

For technical implementation details, see the [Memory Architecture doc](../architecture/MEMORY.md).
