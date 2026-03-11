# W7b: Orchestrator ↔ Memory Integration
> Source: Mission memory lifecycle from W6 design. Episodic memory from [LangMem](https://langchain-ai.github.io/langmem/concepts/) — structured summaries capturing what happened, approach taken, outcomes, and patterns discovered. Context snapshots from [Paperclip](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) — runtime context assembly injected into agent prompts. Continuation memory from [Symphony §8.4](https://github.com/openai/symphony/blob/main/SPEC.md) — retry semantics with context preservation.

##### Required Reading for Implementation

| Reference | What to Read | What ADE Adopts |
|-----------|-------------|-----------------|
| [LangMem Concepts — Episodic Memory](https://langchain-ai.github.io/langmem/concepts/) | Episodic memory section — structured event capture, extraction triggers, consolidation | Structured episodic summaries on mission/session completion, LLM-driven extraction from transcripts |
| [LangMem Source — `knowledge/episodic.py`](https://github.com/langchain-ai/langmem/tree/main/langmem/knowledge) | Extraction logic, summary structure, namespace scoping | Summary schema (task, approach, outcome, tools, patterns, gotchas, decisions), async generation |
| [Paperclip §7 Runtime Context](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) | Runtime context injection, goal hierarchy, SKILLS.md injection | Structured briefing assembly from memory (L0/L1/L2 levels), budget-tiered search |
| [Symphony §8.4 Retry](https://github.com/openai/symphony/blob/main/SPEC.md) | Retry semantics — clean exit vs crash, context preservation, exponential backoff | Continuation memory (preserve mission memory on clean exit), failure gotcha injection on crash retry |
| [OpenClaw — Human Work Ingestion](https://docs.openclaw.ai/concepts/memory) | Daily log diffing, change digest, freshness tracking | `lastSeenHeadSha` tracking, change digest generation, worker notification on divergence |

W7b wires the orchestrator into the unified memory system so that missions create, read, write, and promote memories throughout their lifecycle. A 2026-03-10 code audit shows that the core of this workstream is already in place: mission memory lifecycle services, worker memory briefing assembly, episodic summary generation, and human-work digesting are all implemented. The remaining work is now cleanup and follow-through: finish retiring the legacy `orchestrator_shared_facts` compatibility path and fully wire persistent employee L2 briefing injection through every orchestrator call site.

##### Audit Snapshot (2026-03-10)

- Implemented in code today: `missionMemoryLifecycleService.ts`, `memoryBriefingService.ts`, `episodicSummaryService.ts`, and `humanWorkDigestService.ts`, all wired from `main.ts`.
- Mission start/end hooks already write lifecycle state and episodic summaries from the orchestrator.
- Legacy compatibility still exists in `unifiedMemoryService.ts` via `orchestrator_shared_facts` dual-source reads.
- Persistent employee L2 memory is supported by the briefing layer but not fully passed through current orchestrator briefing calls.

##### Mission Memory Lifecycle

Every mission run follows a deterministic memory lifecycle: create scope → accumulate knowledge → promote or archive on completion.

- **On mission start**: The coordinator calls `unifiedMemoryService.ensureMissionScope(missionId)` — creates the mission memory scope (`scope: "mission"`, `scopeOwnerId: missionId`) if it does not already exist. This is automatic — no agent action needed. The coordinator also writes its initial plan rationale via `memoryAdd(scope: "mission", category: "decision")`.

- **During mission**:
  - Coordinator writes decisions, plan changes, and rationale via `memoryAdd(scope: "mission", category: "decision")`.
  - Workers write shared facts via `memoryAdd(scope: "mission", category: "fact")` — discoveries about the codebase, API behavior, dependency issues.
  - Workers write handoff context via `memoryAdd(scope: "mission", category: "handoff")` — structured output for downstream steps.
  - Workers read mission memory via `memorySearch(scope: "mission")` to find peer discoveries, coordinator decisions, and upstream handoffs.
  - All mission-scoped writes go through the W6 write gate (category filter + lexical dedupe/merge).

- **On mission success**:
  - System reviews all mission memory entries with `status: "promoted"` and `confidence >= 0.7`.
  - High-confidence entries auto-promoted to project memory: scope changes from `"mission"` to `"project"`, `sourceType` set to `"mission_promotion"`, `sourceId` set to `missionId`.
  - Lower-confidence entries (`confidence < 0.7`) stay in mission scope as promotion candidates. User can manually promote from the Mission Artifacts tab.
  - Mission scope is marked `archived` — entries remain queryable but excluded from default search results.

- **On mission failure**:
  - Failure context written to mission memory as `category: "gotcha"`, `importance: "high"`, with the error message, stack trace summary, and failing step context.
  - No auto-promotion to project memory — failures need human review before becoming project knowledge.
  - Mission scope is marked `archived` with `status: "failed"`.

- **`orchestrator_shared_facts` migration**:
  - New mission-scoped memory entries replace `shared_facts` for cross-worker coordination. The coordinator and workers write to `unified_memories` with `scope: "mission"` instead of inserting into `orchestrator_shared_facts`.
  - `orchestrator_shared_facts` table retained for backward compatibility during the transition. Existing reads from `orchestrator_shared_facts` are dual-sourced: check `unified_memories` first, fall back to `orchestrator_shared_facts`.
  - New writes go exclusively to `unified_memories`. After one release cycle with no `orchestrator_shared_facts` reads in telemetry, drop the fallback path.

##### Worker Memory Injection

Worker briefing assembly now pulls from unified memory instead of pack exports. The existing `L0/L1/L2` structure stays, but it should be understood as a mission-worker context assembly, not the same thing as CTO/employee identity memory. It is the cold-start briefing shape for disposable mission workers; persistent CTO employees continue to have their own identity memory in addition to any mission context injected for delegated work.

- **L0 (always injected, ~2-4K tokens)**: Tier 1 project memory — pinned conventions, user preferences, active project focus. Retrieved via `memorySearch(scope: "project", tier: 1, budget: "deep")`. These are the entries the user and CTO have pinned as always-relevant.

- **L1 (per-phase, searched on demand)**: Tier 2 project memory filtered by relevance to the current phase and task description. Retrieved via `memorySearch(scope: "project", tier: 2, query: taskDescription + phaseContext, budget: "standard")`. Returns patterns, gotchas, and decisions relevant to the work at hand.

- **L2 (identity-local, only when briefing a persistent employee rather than a disposable mission worker)**: If the worker is a persistent CTO employee, inject their agent memory. Retrieved via `memorySearch(scope: "agent", scopeOwnerId: agentId, tier: [1, 2], budget: "lite")`. This gives the employee its own identity, domain knowledge, and past run context without implying that all mission workers share one durable `L0/L1/L2` memory store.

- **Mission context (always, during active mission)**: Tier 2 mission memory — peer discoveries, coordinator decisions, upstream handoffs. Retrieved via `memorySearch(scope: "mission", scopeOwnerId: missionId, budget: "standard")`. Workers see what their peers have learned and what the coordinator has decided.

- **Budget tiers for search**:
  | Budget | Max Results | Use Case |
  |--------|-------------|----------|
  | Lite | 3 | Agent memory, quick context checks |
  | Standard | 8 | Phase-relevant project memory, mission context |
  | Deep | 20 | L0 pinned entries, mission planning, CTO activation |

  Configurable per context level in the briefing assembly. The budget controls how many entries `memorySearch` returns, bounding the token injection into worker prompts.

- **Worker memory tools**: Mission workers have access to `memoryAdd` (mission scope + project scope with strict write gate) and `memorySearch` (mission scope + project scope). Workers cannot write to agent scope for other agents. Workers cannot read agent scope for other agents.

##### Episodic Summary Generation

On mission or session completion, the system generates a structured episodic summary that captures what happened in a form suitable for later pattern extraction (W7c).

- **Mission episodic summary**: Generated on mission completion (success or failure). The summary is an LLM call with the mission transcript (compacted), shared facts, worker outputs, and final status as input. Output follows the `EpisodicMemory` interface defined in W6:
  ```typescript
  interface EpisodicMemory {
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
    duration: number;           // seconds
    createdAt: string;
  }
  ```
  Saved to project memory: `category: "episode"`, Tier 2, `sourceType: "mission_promotion"`, `sourceId: missionId`. The `content` field contains the JSON-serialized `EpisodicMemory` struct.

- **Session episodic summary**: Generated on CTO or worker chat session end (not regular user chat sessions — those are too noisy). Lighter than mission summaries: captures what was discussed, decisions made, and action items. Same `EpisodicMemory` interface with `sessionId` set instead of `missionId`.

- **Generation is async**: Episodic summary generation does not block mission completion or session teardown. The mission/session is marked complete immediately. The summary is generated in the background and written to memory when ready. If the LLM call fails, log a warning — the mission outcome is not affected.

- **LLM model selection**: Use the cheapest fast model configured in the user's provider list (e.g., `claude-3-5-haiku-20241022`). Episodic summaries do not require frontier-level reasoning. If no model is available, skip generation with a warning.

##### Human Work Ingestion

Track and ingest changes the user makes outside of agent runs so that agents start with fresh context.

- **`lastSeenHeadSha` tracking**: Store per project in `unified_memories` as a system entry (`category: "digest"`, `sourceType: "system"`). Updated after every digest generation and after every mission completion.

- **Divergence detection triggers**:
  | Trigger | When |
  |---------|------|
  | App startup | If `HEAD !== lastSeenHeadSha` |
  | Before mission dispatch | If `HEAD !== lastSeenHeadSha` (blocks dispatch until digest completes) |
  | PR merge / branch switch | Detected via `git` watcher or explicit poll |
  | Explicit user action | "Sync knowledge" button in memory inspector |

- **Change digest generation**: `humanWorkDigestService.ts` generates a structured digest:
  ```typescript
  interface ChangeDigest {
    fromSha: string;
    toSha: string;
    commitCount: number;
    commitSummaries: string[];     // one-line per commit
    diffstat: string;              // "+123 -45 in 12 files"
    changedFiles: string[];
    fileClusters: FileCluster[];   // semantic grouping of changed files
  }

  interface FileCluster {
    label: string;                 // "auth module", "API routes", "test infrastructure"
    files: string[];
    summary: string;               // LLM-generated one-liner about what changed in this cluster
  }
  ```
  File clustering uses directory structure + file naming heuristics (no embeddings needed — simple path-prefix grouping with an LLM pass to label each cluster).

- **Digest storage**: Saved as project memory entry with `category: "digest"`, Tier 2, `importance: "medium"`. Content is a human-readable summary (not raw JSON). Older digests decay naturally via the 30-day half-life.

- **Worker notification**: Workers whose `capabilities` or file routing patterns (from W2 `AgentIdentity.capabilities`) overlap with the change cluster get a notification flag. On their next activation (heartbeat or wake-on-demand), the digest is included in their L1 context.

##### Continuation vs Failure Retry Memory

Adapted from [Symphony §8.4](https://github.com/openai/symphony/blob/main/SPEC.md) retry semantics, integrated with mission memory.

- **Clean worker exit ("more work to do")**: Worker signals `CONTINUE` status. Mission memory is fully preserved. Coordinator spawns a new worker attempt with the same mission scope — the new worker sees everything the previous worker wrote. Retry delay: 1 second (consistent with Symphony's continuation model).

- **Worker crash / failure**: Worker exits with `FAILED` status or process crash. Failure context written to mission memory:
  ```typescript
  memoryAdd({
    scope: "mission",
    scopeOwnerId: missionId,
    category: "gotcha",
    content: `Worker ${workerId} failed on step ${stepId}: ${errorSummary}`,
    importance: "high",
    confidence: 0.9,
  });
  ```
  Exponential backoff retry: 2s → 4s → 8s → 16s → max 60s. Max 3 retry attempts before escalating to coordinator.

- **Retry with memory**: When a new worker attempt starts (whether continuation or failure retry), it receives the full mission memory in its briefing assembly. This means:
  - Continuation: new worker knows what the previous worker accomplished and can pick up where it left off.
  - Failure retry: new worker knows what went wrong and can try a different approach. The gotcha entry from the previous failure is injected as L1 context with `importance: "high"`.

##### Service Architecture

```
missionMemoryLifecycleService.ts  — Mission scope creation, completion promotion, archival
episodicSummaryService.ts         — LLM-driven summary generation for missions and sessions
humanWorkDigestService.ts         — Git divergence detection, change digest generation, worker notification
```

All three services instantiated in `main.ts`. `missionMemoryLifecycleService` is called by `orchestratorService` at mission start/end. `episodicSummaryService` is called async after mission/session completion. `humanWorkDigestService` runs on app startup and before mission dispatch.

**Implementation status (2026-03-10):** Mostly implemented. Remaining work: retire the `orchestrator_shared_facts` fallback path, finish persistent employee L2 memory wiring, and close any cleanup gaps around mission-context continuation behavior.

**Tests:**
- Mission memory lifecycle: scope creation on mission start, coordinator decision write, worker fact write, worker handoff write, cross-worker read via `memorySearch`.
- Mission success promotion: entries with confidence >= 0.7 promoted to project memory, entries with confidence < 0.7 remain as candidates, scope marked archived after promotion.
- Mission failure handling: failure gotcha written with high importance, no auto-promotion, scope marked archived with failed status.
- `orchestrator_shared_facts` migration: new writes go to `unified_memories`, dual-source read falls back to `orchestrator_shared_facts`, backward compatibility with existing shared facts data.
- Worker briefing assembly: L0 injects Tier 1 pinned project memory, L1 injects phase-relevant Tier 2 project memory, L2 injects agent memory for persistent employees, mission context injects mission-scoped entries.
- Budget tiers: Lite returns max 3, Standard returns max 8, Deep returns max 20.
- Episodic summary generation: mission completion triggers async LLM call, summary saved as project memory episode, failed LLM call does not block mission completion, correct `EpisodicMemory` structure.
- Session episodic summary: CTO session end triggers lighter summary, regular chat sessions do not trigger summary.
- Human work ingestion: `lastSeenHeadSha` divergence detected on app startup, change digest generated with commit summaries and file clusters, digest saved as project memory entry.
- Dispatch freshness gate: mission dispatch blocked when HEAD diverged, unblocked after digest generation completes.
- Worker notification: workers with matching capabilities flagged for digest injection on next activation.
- Continuation memory: clean exit preserves mission memory, new worker attempt reads previous worker's entries, 1s retry delay.
- Failure retry memory: crash writes gotcha to mission memory, retry worker receives gotcha in briefing, exponential backoff timing (2s/4s/8s/16s/60s cap), max 3 retries before escalation.
