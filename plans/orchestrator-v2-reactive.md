# ADE Orchestrator V2 — Reactive Intelligence Architecture

> **Codename:** Project Cortex
> **Vision:** Transform the orchestrator from a committee of specialist AI calls into a single always-on reactive intelligence — an AI "being" that thinks, decides, and acts like the best PM you've ever worked with.
> **Guiding Principle:** As simple as Claude Code agent teams for small tasks, as powerful as a 15-agent swarm for large ones.

---

## The Problem With V1

The current orchestrator has **8 separate AI decision points** that fire on every step completion:

```
step_completed →
  1. handleStepCompletionTransition()   — "continue/pause/replan?"
  2. evaluateQualityGateForStep()       — "was output good?"
  3. applyAiRetryDecisionForFailedAttempt() — "retry?"
  4. handleFailedAttemptRecovery()       — "what went wrong?"
  5. analyzeForFanOut()                  — "create subtasks?"
  6. adjustPlanWithAI()                  — "modify remaining plan?"
  7. triggerCoordinatorEvaluation()      — "coordinator, thoughts?"
  8. sendCoordinatorEvent()              — "here's an update"
```

Plus timer-based loops:
- Health sweep: every 5 seconds
- Coordinator thinking: every 30 seconds

**Problems:**
- Each AI call has its own limited context — they don't see each other's decisions
- The coordinator (the "PM brain") gets summaries AFTER specialist deciders have already acted
- 8 separate prompts × N step completions = lots of AI cost with fragmented reasoning
- Timer-based loops are deterministic band-aids for a system that should be reactive
- Can't scale down — even a simple 1-step mission runs the full machinery
- Can't adapt — the DAG is modified by the plan adjuster, not the coordinator

## The V2 Architecture

### Core Idea: One Brain, Full Authority

```
V1: step_completed → 8 specialist AI calls → coordinator gets summary
V2: step_completed → coordinator receives FULL output → coordinator decides everything → coordinator acts via tools
```

The coordinator is the ONLY AI decision-maker during execution. It's a persistent
multi-turn session with tools. No specialist deciders. No timers. Events come in,
the coordinator thinks, the coordinator acts.

### The Coordinator as Agent

```typescript
// The coordinator IS an agent with tools
const coordinator = new CoordinatorAgent({
  model: "claude-opus-4-7", // or configured per mission
  systemPrompt: buildCoordinatorPrompt(mission, runState),
  tools: {
    // === Execution Control ===
    spawn_agent:    { /* start a new agent for a step */ },
    stop_agent:     { /* gracefully stop a running agent */ },
    steer_agent:    { /* inject message into running agent */ },

    // === Plan Mutation ===
    add_step:       { /* add step to DAG, UI updates reactively */ },
    remove_step:    { /* remove step from DAG */ },
    merge_steps:    { /* combine two steps into one */ },
    split_step:     { /* split a step into parallel sub-steps (fan-out) */ },
    reorder_steps:  { /* change dependency edges */ },
    skip_step:      { /* mark step as skipped with reason */ },

    // === Communication ===
    send_message:   { /* message any agent, @mention routing */ },
    broadcast:      { /* message all active agents */ },
    ask_user:       { /* pause and ask the human */ },

    // === Quality & Memory ===
    evaluate_quality: { /* request quality check on agent output */ },
    add_shared_fact:  { /* add fact to shared memory */ },
    read_agent_output: { /* read full output of completed agent */ },

    // === Introspection ===
    get_run_state:    { /* current DAG state, agent statuses, progress */ },
    get_file_claims:  { /* who owns which files */ },
    get_shared_facts: { /* what has been discovered */ },
  },

  // Events are injected as user messages
  onEvent: (event) => coordinator.injectMessage(formatEvent(event)),
});
```

### Event Flow

```
Agent completes step
  ↓
Runtime emits event with FULL agent output (summary + artifacts + files changed)
  ↓
Coordinator receives event as a conversation turn
  ↓
Coordinator thinks (one unified decision):
  - Was the output good? (replaces quality gate)
  - Should we retry? (replaces retry decider)
  - What should happen next? (replaces transition decider)
  - Should we modify the plan? (replaces plan adjuster)
  - Should we fan out? (replaces meta-reasoner)
  - Should we tell other agents? (replaces message routing)
  ↓
Coordinator calls tools to act on decisions
  - spawn_agent() for next steps
  - split_step() for fan-out
  - steer_agent() for cross-agent intelligence
  - skip_step() for unnecessary steps
  ↓
Tool executions update the DAG → UI updates reactively
  ↓
Coordinator's turn ends, waits for next event
```

**No timers. No health sweeps. No specialist deciders.**

If the coordinator notices an agent has been running too long, it can proactively
steer it or stop it — because it's a persistent session that sees all events,
not a function that runs every 30 seconds.

---

## Scaling: One System, Any Scope

### Scope Inference (Current Runtime)

Scope is now inferred from the mission graph and active runtime profile, not from a
separate `missionTriage` classifier call.

```typescript
type MissionScope = "small" | "medium" | "large" | "very_large";

function deriveScopeFromStepCount(stepCount: number): MissionScope {
  if (stepCount <= 3) return "small";
  if (stepCount <= 8) return "medium";
  if (stepCount <= 20) return "large";
  return "very_large";
}

const runtimeProfile = resolveActiveRuntimeProfile(missionId);
const useAiPlanner = runtimeProfile.planning.useAiPlanner;
// If true, plan with AI; if false, execute existing mission steps.
```

### Scope → Behavior Mapping

| Scope | Planning | Coordinator | DAG | Agents |
|-------|----------|-------------|-----|--------|
| **small** | Usually policy-off (existing steps), or lightweight planner output. | Lightweight: spawn 1 worker, validate, finish. | Minimal DAG | 1 |
| **medium** | Planner optional based on runtime profile. | Active sequencing with selective parallelism. | 3-8 steps, mostly linear | 1-3 concurrent |
| **large** | AI planner typically enabled. | Full coordination with plan mutations. | Full DAG with dependencies | 3-8 concurrent |
| **very_large** | AI planner enabled + dynamic revisions. | Proactive rebalancing, fan-out, and steering. | Dynamic DAG, grows/shrinks | 5-15+ concurrent |

**Key insight:** The coordinator is the SAME agent in all cases. It just makes different
decisions based on inferred scope and runtime policy. On small missions it stays lightweight;
on very large missions it actively mutates the DAG, fans out, and coordinates.

### Single-Agent Fast Path

```
User: "Fix the typo in README.md"
  ↓
Runtime profile: planner disabled, use existing/simple step graph
  ↓
Coordinator spawns 1 agent with direct instructions
  ↓
Agent completes → Coordinator reads output → Done
  ↓
Total AI calls: 1 (coordinator execution path)
vs. V1: 1 (planner) + 1 (lane provisioner) + 1 (team synthesizer) + 8 (completion handlers) = 11
```

---

## Adaptive Planning: The Living DAG

### Plans Are Suggestions, Not Contracts

The initial plan (if any) is the coordinator's best guess. The coordinator can
rewrite it at any time based on what agents discover.

```
Initial plan: [auth-schema] → [auth-impl] → [auth-tests] → [auth-docs]

Agent completes auth-impl, reports: "I also wrote all the tests and they pass."

Coordinator thinks: "auth-tests is now unnecessary."
Coordinator calls: skip_step("auth-tests", "auth-impl already wrote and verified tests")

DAG updates: [auth-schema] → [auth-impl] → [auth-tests ✗ skipped] → [auth-docs]
UI reflects this immediately.
```

### Agents Can Influence the Plan

Agents have the `teamMessageTool` to communicate. The coordinator LISTENS to these
messages and acts on them:

```
Agent worker-db sends: "@orchestrator I discovered the schema needs a new migration
  table. This affects worker-api's task too."

Coordinator thinks:
  1. Add a shared fact about the new migration table
  2. Steer worker-api: "worker-db found a new migration table. Update your imports."
  3. Maybe add a new step for migration verification

Coordinator calls:
  add_shared_fact({ type: "schema_change", content: "New migration table added" })
  steer_agent("worker-api", "worker-db discovered a new migration table...")
  add_step({ after: "worker-db", title: "verify-migration", instructions: "..." })
```

### The DAG Tab Is Reactive

Every tool call the coordinator makes that modifies the plan should emit an event
that the DAG tab picks up:

```typescript
// When coordinator calls split_step(), add_step(), skip_step(), etc.
// The tool implementation:
1. Mutates the step graph in the DB
2. Emits 'orchestrator-dag-updated' event with the change delta
3. Frontend receives event via IPC
4. OrchestratorDAG.tsx re-renders with animation showing the change

// Visual indicators for plan changes:
- New steps: fade in with green glow
- Skipped steps: strikethrough + gray out with reason tooltip
- Merged steps: animate two nodes combining into one
- Split steps: animate one node splitting into children
- Reordered: dependency arrows animate to new positions
```

---

## Implementation Plan

### Phase 1: Extract & Simplify (Foundation)

**Goal:** Break the god-files apart without changing behavior. This makes Phase 2 possible.

#### 1A: Extract aiOrchestratorService into modules

Split the 15,283-line file into focused modules:

```
src/main/services/orchestrator/
  aiOrchestratorService.ts    → Thin facade (~800 lines) that wires modules together
  coordinatorSession.ts       → Coordinator lifecycle, session management (~1,500 lines)
  chatService.ts              → Thread CRUD, message delivery, retries (~2,000 lines)
  planningPipeline.ts         → Planner integration, plan review, lane provisioning (~2,000 lines)
  recoveryService.ts          → Failure diagnosis, retry logic, health checks (~1,500 lines)
  qualityGateService.ts       → Quality evaluation (~500 lines)
  runtimeEventRouter.ts       → Event dispatching, handler registration (~1,500 lines)
  missionLifecycle.ts         → Status transitions, metadata, config (~1,500 lines)
  workerTracking.ts           → Worker state tracking, session resolution (~1,200 lines)
  metricsService.ts           → Usage tracking, token propagation (~800 lines)
```

**No behavior changes.** Just moving functions into focused files.

#### 1B: Extract orchestratorService utilities

```
src/main/services/orchestrator/
  orchestratorService.ts      → Core run/step/attempt lifecycle (~3,000 lines)
  fileClaimService.ts         → All claim logic (~1,200 lines)
  contextSnapshotService.ts   → Snapshot capture, docs resolution (~1,500 lines)
  dagMutationService.ts       → Step graph mutations, dependency management (~800 lines)
  autopilotService.ts         → Ready step scanning, priority ordering (~800 lines)
```

#### 1C: Define the DAG mutation event protocol

```typescript
// New event type for reactive DAG updates
type DagMutationEvent = {
  runId: string;
  mutation:
    | { type: "step_added"; step: OrchestratorStep; position: { after?: string; parallel?: string[] } }
    | { type: "step_removed"; stepKey: string; reason: string }
    | { type: "step_skipped"; stepKey: string; reason: string }
    | { type: "steps_merged"; sourceKeys: string[]; targetStep: OrchestratorStep }
    | { type: "step_split"; sourceKey: string; children: OrchestratorStep[] }
    | { type: "dependency_changed"; stepKey: string; newDeps: string[]; reason: string }
    | { type: "status_changed"; stepKey: string; newStatus: string };
  timestamp: string;
  source: "coordinator" | "system" | "user";
};

// IPC channel
orchestratorDagMutation: "ade.orchestrator.dagMutation"

// Frontend subscription
window.ade.orchestrator.onDagMutation(callback)
```

### Phase 2: The Unified Coordinator (Core Rewrite)

**Goal:** Replace the 8 specialist AI calls with one coordinator agent that has tools.

#### 2A: Build coordinator tool set

```typescript
// src/main/services/orchestrator/coordinatorTools.ts

export function createCoordinatorTools(ctx: CoordinatorContext) {
  return {
    // Execution control
    spawn_agent: tool({
      description: "Start a new agent to work on a step. Returns agent ID.",
      parameters: z.object({
        stepKey: z.string(),
        instructions: z.string().optional(), // override step instructions
        model: z.string().optional(), // override model
      }),
      execute: async (args) => {
        // Delegates to autopilotService.startAttempt()
        // Returns { agentId, sessionId, status }
      },
    }),

    stop_agent: tool({ /* graceful stop */ }),
    steer_agent: tool({ /* inject message via PTY/SDK queue */ }),

    // Plan mutation (all emit DagMutationEvent)
    add_step: tool({
      description: "Add a new step to the plan. Specify where it goes in the DAG.",
      parameters: z.object({
        title: z.string(),
        instructions: z.string(),
        afterSteps: z.array(z.string()).optional(),
        beforeSteps: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        model: z.string().optional(),
      }),
      execute: async (args) => {
        // Creates step via dagMutationService
        // Emits DagMutationEvent
        // Refreshes readiness
      },
    }),

    skip_step: tool({ /* mark skipped, emit event, refresh readiness */ }),
    merge_steps: tool({ /* combine steps, emit event */ }),
    split_step: tool({ /* fan-out into children, emit event */ }),
    reorder_steps: tool({ /* modify dependency edges, emit event */ }),

    // Communication
    send_message: tool({ /* send to specific agent */ }),
    broadcast: tool({ /* send to all active agents */ }),
    ask_user: tool({ /* pause run, create intervention, wait for user */ }),

    // Memory
    add_shared_fact: tool({ /* add to shared facts store */ }),

    // Introspection (read-only)
    get_run_state: tool({ /* full DAG state, progress, agent statuses */ }),
    get_agent_output: tool({ /* read completed agent's full output */ }),
    get_file_claims: tool({ /* who owns which files */ }),
    get_shared_facts: tool({ /* accumulated knowledge */ }),
  };
}
```

#### 2B: Build the coordinator agent loop

```typescript
// src/main/services/orchestrator/coordinatorAgent.ts

export class CoordinatorAgent {
  private session: UnifiedSession;
  private eventQueue: CoordinatorEvent[] = [];
  private processing = false;

  constructor(private ctx: CoordinatorContext) {}

  async start(mission: Mission, initialPlan?: OrchestratorStep[]) {
    const tools = createCoordinatorTools(this.ctx);

    const systemPrompt = buildCoordinatorSystemPrompt({
      mission,
      initialPlan,
      projectContext: this.ctx.projectContext,
      modelCapabilities: this.ctx.modelCapabilities,
    });

    this.session = new UnifiedSession({
      model: this.ctx.coordinatorModel,
      systemPrompt,
      tools,
      // Compaction enabled — coordinator can run for hours
      enableCompaction: true,
      compactionThreshold: 0.6, // compact earlier since coordinator is long-lived
    });

    // If there's an initial plan, start executing it
    if (initialPlan?.length) {
      await this.injectEvent({
        type: "plan_ready",
        plan: initialPlan,
        message: `Mission plan with ${initialPlan.length} steps is ready. Review and begin execution.`,
      });
    } else {
      // No plan — coordinator decides how to approach the mission
      await this.injectEvent({
        type: "mission_start",
        message: `New mission: "${mission.goal}". Decide how to approach this — you can spawn agents directly or create a multi-step plan.`,
      });
    }
  }

  // Events are queued and processed sequentially
  async injectEvent(event: CoordinatorEvent) {
    this.eventQueue.push(event);
    if (!this.processing) {
      await this.processQueue();
    }
  }

  private async processQueue() {
    this.processing = true;
    while (this.eventQueue.length > 0) {
      const batch = this.drainQueue(); // take all pending events
      const message = formatEventsForCoordinator(batch);

      // Single AI turn — coordinator thinks and calls tools
      const result = await this.session.runTurn(message);

      // Tool calls are executed automatically by the session
      // Each tool call may emit new events (which get queued)
    }
    this.processing = false;
  }

  private drainQueue(): CoordinatorEvent[] {
    // Wait 200ms for batching, then drain all queued events
    const events = [...this.eventQueue];
    this.eventQueue = [];
    return events;
  }
}
```

#### 2C: Replace specialist deciders

Remove these as separate AI calls — their logic moves into the coordinator's unified reasoning:

| Current Specialist | Replaced By |
|-------------------|-------------|
| `handleStepCompletionTransition()` | Coordinator decides on step completion event |
| `evaluateQualityGateForStep()` | Coordinator evaluates (or uses `evaluate_quality` tool for second opinion) |
| `applyAiRetryDecisionForFailedAttempt()` | Coordinator decides retry vs escalate |
| `handleFailedAttemptRecovery()` | Coordinator diagnoses and acts |
| `analyzeForFanOut()` | Coordinator uses `split_step` tool when it sees fan-out opportunity |
| `adjustPlanWithAI()` | Coordinator uses plan mutation tools continuously |
| `startCoordinatorThinkingLoop()` | DELETED — coordinator is always reactive |
| `runHealthSweep()` | Coordinator receives timeout/stall events and acts |

**The event router becomes simple:**

```typescript
// src/main/services/orchestrator/runtimeEventRouter.ts

function onRuntimeEvent(event: OrchestratorRuntimeEvent) {
  // Format the event with relevant context
  const formatted = formatEventForCoordinator(event);

  // Inject into coordinator — it decides everything
  coordinatorAgent.injectEvent(formatted);
}
```

#### 2D: Scope-aware mission launch

```typescript
// src/main/services/orchestrator/aiOrchestratorService.ts

export async function launchMission(missionId: string, args: MissionRunStartArgs) {
  const runtimeProfile = resolveActiveRuntimeProfile(missionId);

  // Step 1: Optional planning (policy-driven)
  if (runtimeProfile.planning.useAiPlanner) {
    await planWithAI({ missionId, provider: args.defaultExecutorKind ?? "claude" });
  }
  // else: keep existing mission steps (planner policy-off)

  // Step 2: Start coordinator
  startCoordinatorAgentV2(missionId, runId, missionGoal, coordinatorModelConfig, {
    userRules,
    projectContext,
    availableProviders,
    phases,
    missionLaneId
  });

  // Coordinator takes over reactively from here.
}
```

### Phase 3: Reactive DAG UI

**Goal:** Make the DAG tab a live view of the coordinator's evolving plan.

#### 3A: DAG mutation subscription

```typescript
// In OrchestratorDAG.tsx
useEffect(() => {
  const unsub = window.ade.orchestrator.onDagMutation((event: DagMutationEvent) => {
    switch (event.mutation.type) {
      case "step_added":
        // Animate new node fading in
        addNodeWithAnimation(event.mutation.step, event.mutation.position);
        break;
      case "step_skipped":
        // Gray out node, show strikethrough
        markSkipped(event.mutation.stepKey, event.mutation.reason);
        break;
      case "steps_merged":
        // Animate two nodes combining
        animateMerge(event.mutation.sourceKeys, event.mutation.targetStep);
        break;
      case "step_split":
        // Animate one node splitting into children
        animateSplit(event.mutation.sourceKey, event.mutation.children);
        break;
      case "dependency_changed":
        // Animate edge reconnection
        animateEdgeChange(event.mutation);
        break;
    }
  });
  return unsub;
}, [runId]);
```

#### 3B: DAG change indicators

Visual language for plan evolution:
- **New steps**: Fade in from transparent, brief green border pulse
- **Skipped steps**: Strikethrough on title, grayed out, reason on hover
- **Merged steps**: Two nodes animate toward each other, combine into one
- **Split steps**: Node animates splitting, children fan out with dependency arrows
- **Status changes**: Smooth color transitions (gray → blue → green/red)
- **Plan revision badge**: Small counter showing "Plan revised 3x" on the DAG header

#### 3C: Plan history timeline

Show a mini-timeline of plan changes below the DAG:
```
[12:01] Plan created: 8 steps across 3 phases
[12:05] step-3 skipped: "auth-impl already handled tests"
[12:08] step-5 split into step-5a, step-5b (fan-out: 2 parallel workers)
[12:12] step-7 added: "migration verification needed"
```

### Phase 4: Model-Aware Planning

**Goal:** The coordinator and planner understand what modern models can do.

#### 4A: Model capability matrix in coordinator prompt

```
## Model Capabilities (use this when deciding agent count)

- Claude Opus/Sonnet: 200k context, parallel tool calls, can edit 30+ files in
  one session, supports multi-turn with full history. ONE agent can handle most
  medium-complexity tasks entirely.

- Codex: Sandboxed execution, parallel tool calls, good for implementation-heavy
  tasks. Can run tests in-sandbox.

## When to spawn multiple agents:
- Files that CANNOT be edited concurrently (hard conflicts)
- Total context would exceed model's window
- Genuinely independent workstreams with no shared files
- Different parts need different capabilities (e.g., Codex for testing, Claude for design)

## When ONE agent is enough:
- Task touches < 20 files
- All changes are logically connected
- Estimated context < 100k tokens
- No hard file conflicts

## When to use internal parallelism (one agent, parallel tools):
- 3-5 small independent edits
- Agent can use parallel tool calls to edit multiple files simultaneously
- Simpler than spawning multiple agents
```

#### 4B: Dynamic scope reassessment

The coordinator can reassess scope mid-run:

```
Coordinator sees: agent-1 completed phase 1, output shows remaining work is simpler
  than expected.

Coordinator thinks: "The remaining 4 steps can be handled by 1 agent instead of 4
  parallel agents. Let me merge them."

Coordinator calls: merge_steps(["step-4", "step-5", "step-6", "step-7"])
```

### Phase 5: Simplify the Interface

**Goal:** Mission launch is as simple as typing a message.

#### 5A: One-click launch

The MissionComposer defaults to:
- Text input: "What do you want to build?"
- Single "Go" button
- System auto-detects everything (scope, model, parallelism)

#### 5B: Progressive disclosure

```
[Simple mode - default]
┌────────────────────────────────────────────┐
│ What do you want to build?                 │
│ ┌────────────────────────────────────────┐ │
│ │ Add rate limiting to all API endpoints │ │
│ └────────────────────────────────────────┘ │
│                                    [ Go ] │
└────────────────────────────────────────────┘

[Click "Advanced" to expand]
┌────────────────────────────────────────────┐
│ ▼ Advanced Configuration                   │
│                                            │
│ Scope:  ○ Auto  ○ Light  ○ Standard  ○ Deep│
│ Model:  [Auto-detect          ▼]           │
│ Max agents: [Auto ▼]                       │
│ Plan review: [ ] Require approval          │
│ PR strategy: ○ Auto  ○ Single  ○ Per-agent │
│                                            │
│ [Even more options...]                     │
└────────────────────────────────────────────┘
```

#### 5C: Scope preview

After typing the goal, show a quick preview before launching:

```
┌────────────────────────────────────────────┐
│ "Add rate limiting to all API endpoints"   │
│                                            │
│ Estimated scope: PARALLEL (3-4 agents)     │
│ Approach: Audit endpoints → implement      │
│           rate limiting → add tests        │
│ Model: Claude Sonnet 4.6                   │
│ Est. cost: ~$2.50                          │
│                                   [ Go ] │
└────────────────────────────────────────────┘
```

---

## Migration Strategy

### What Gets Deleted
- `startCoordinatorThinkingLoop()` — replaced by reactive coordinator
- `evaluateQualityGateForStep()` as a standalone — moved into coordinator reasoning
- `handleStepCompletionTransition()` — coordinator handles
- `applyAiRetryDecisionForFailedAttempt()` — coordinator handles
- `handleFailedAttemptRecovery()` — coordinator handles
- `adjustPlanWithAI()` as a separate call — coordinator has plan mutation tools
- `analyzeForFanOut()` — coordinator uses split_step tool
- `runHealthSweep()` timer — replaced by event-driven coordinator
- `aiDecisionService.ts` (1,498 lines) — specialist decisions absorbed by coordinator
- `executionPolicy.ts` (761 lines) — simplified, scope-aware

### What Gets Kept
- `orchestratorService.ts` — core run/step/attempt CRUD (it's well-factored)
- File claim system — still needed for conflict prevention
- Shared facts / memory service — still needed
- Compaction engine — coordinator itself needs compaction for long runs
- Message delivery infrastructure — coordinator uses it via tools
- Team message tool — agents still communicate through it

### What Gets Simplified
- Event routing: instead of dispatching to 8 handlers, routes to coordinator
- Mission launch: runtime profile → optional planner → coordinator start
- DAG management: coordinator mutates via tools, events drive UI
- Parallelism decisions: coordinator decides, not a separate AI service

### Estimated Impact
- **Lines deleted:** ~8,000 (specialist deciders, timers, redundant routing)
- **Lines added:** ~3,000 (coordinator agent, tools, event formatting)
- **Lines refactored:** ~4,000 (extraction from god-files into modules)
- **Net reduction:** ~5,000 lines with MORE capability

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Single coordinator vs specialist deciders | Single coordinator | Unified context = better decisions. How a real PM works. |
| Timers vs event-driven | Event-driven only | Reactive systems are simpler and more responsive |
| Fixed DAG vs living DAG | Living DAG | Plans should adapt to reality, not the other way around |
| Always plan vs scope-based | Scope-based | Simple tasks don't need DAGs |
| Coordinator has tools | Yes, full authority | If you trust it to make decisions, trust it to act |
| Separate quality gates | Absorbed into coordinator | One brain should evaluate quality in context |
| Model capability awareness | In coordinator prompt | Prevents over-spawning agents |

---

## Success Criteria

1. **Simple task (fix a typo):** Mission launches in <3s, 1 agent, no DAG, no planning
2. **Medium task (add a feature):** Coordinator creates 2-3 step plan, executes sequentially, adapts if needed
3. **Large task (system redesign):** Full DAG with parallel agents, coordinator manages cross-agent comms, plan evolves mid-run
4. **Plan adaptation:** When an agent discovers something unexpected, the coordinator modifies the plan within 5s
5. **DAG reactivity:** UI reflects plan changes within 1s of coordinator decision
6. **AI cost reduction:** Single coordinator call replaces 8 specialist calls → 60-70% fewer AI calls per step completion
7. **Agent count optimization:** Coordinator correctly decides "1 agent is enough" for tasks that V1 would spawn 4+ agents for
