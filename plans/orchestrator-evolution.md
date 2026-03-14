# ADE Orchestrator Evolution — Comprehensive Implementation Plan

> **Codename:** Project Hivemind
> **Scope:** Smart orchestration, real-time inter-agent communication, Slack-like chat UI, memory architecture, context compaction, dynamic fan-out, session persistence
> **Parallel Execution:** All workstreams designed for maximum parallelism via agent teams (TeamCreate)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        RENDERER (React)                             │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  ┌────────────┐ │
│  │  Chat Tab    │  │  Board Tab   │  │  DAG Tab  │  │ Details Tab│ │
│  │  (Slack-     │  │  (cleaned)   │  │ (fixed    │  │ (was Usage │ │
│  │   style)     │  │              │  │  anim)    │  │ +CtxBudget)│ │
│  │             │  │              │  │           │  │            │ │
│  │ GlobalChat  │  │ PhaseProgress│  │ DAG nodes │  │ UsageDash  │ │
│  │ @mentions   │  │ (single bar) │  │ (no spin  │  │ CtxBudget  │ │
│  │ AgentViews  │  │              │  │  rect)    │  │ MemoryView │ │
│  │ OrcView     │  │              │  │           │  │            │ │
│  └──────┬──────┘  └──────────────┘  └───────────┘  └────────────┘ │
│         │                                                           │
│         │  IPC (Electron)                                          │
└─────────┼──────────────────────────────────────────────────────────┘
          │
┌─────────┼──────────────────────────────────────────────────────────┐
│  MAIN   │  PROCESS                                                 │
│         ▼                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ AI Orchestr. │  │ Orchestrator │  │ Memory Service           │ │
│  │ Service      │  │ Service      │  │                          │ │
│  │              │  │              │  │ L0: Session (transcripts)│ │
│  │ Meta-reasoner│  │ Smart fanout │  │ L1: Run (shared facts)   │ │
│  │ Msg delivery │  │ DAG mutation │  │ L2: Curated (memories)   │ │
│  │ Compaction   │  │ Step dispatch│  │ L3: Identity (future)    │ │
│  │              │  │              │  │                          │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Agent Chat   │  │ Unified      │  │ Base Orchestrator        │ │
│  │ Service      │  │ Executor     │  │ Adapter                  │ │
│  │              │  │              │  │                          │ │
│  │ Session      │  │ Compaction   │  │ Context assembly         │ │
│  │ persistence  │  │ engine       │  │ + shared facts           │ │
│  │ Resume       │  │ Token monitor│  │ + run narrative          │ │
│  │              │  │ Writeback    │  │ + compaction hints       │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## WS1: UI Bug Fixes (Independent — Start Immediately)

**Goal:** Fix 4 specific UI bugs in the missions workspace.
**Files:** `MissionsPage.tsx`, `OrchestratorDAG.tsx`, `PhaseProgressBar.tsx`, `ExecutionPlanPreview.tsx`, `index.css`
**Estimated scope:** ~150 lines changed
**Can parallel with:** Everything

### WS1.1: Remove ExecutionPlanPreview pane from all tabs

The `ExecutionPlanPreview` component renders above the tab content area at `MissionsPage.tsx:2716-2718`, visible on ALL tabs (board, dag, channels, activity, usage). It shows planned steps with collapsible dropdown arrows.

**Changes:**
1. **`MissionsPage.tsx:2716-2718`** — Remove the `{isActiveMission && (<ExecutionPlanPreview preview={executionPlanPreview} />)}` block entirely
2. **`MissionsPage.tsx:71`** (approx) — Remove the import of `ExecutionPlanPreview`
3. **`MissionsPage.tsx`** — Remove the `executionPlanPreview` state variable and the IPC call to `orchestratorGetExecutionPlanPreview` that populates it
4. **`ExecutionPlanPreview.tsx`** — Delete the entire file (412 lines, purely presentational, no side effects)
5. **Verify** that no other component imports `ExecutionPlanPreview` (it should only be used in MissionsPage)

### WS1.2: Remove duplicate completion percentage bar

Two completion indicators stack above the tab area:
- `PhaseProgressBar` component at `MissionsPage.tsx:2702` — renders "OVERALL PROGRESS" bar + per-phase bars
- Inline text at `MissionsPage.tsx:2703-2715` — renders "N of M steps complete (X%)"

**Changes:**
1. **`MissionsPage.tsx:2703-2715`** — Remove the entire inline IIFE that renders the second "N of M steps complete" text
2. **`PhaseProgressBar.tsx`** — Keep as-is (the "OVERALL PROGRESS" bar at lines 76-106 IS the one we want to keep, along with the per-phase sub-bars)
3. If `originalStepCount` info (plan adjustment note) is valuable, move it into `PhaseProgressBar` as a sub-label under the overall bar

### WS1.3: Fix spinning white rectangle in DAG

The spinning animation on running nodes in `OrchestratorDAG.tsx:274-290` uses a CSS `ade-spin-4s` class on an SVG `<g>` element. The `transformOrigin` is set via inline style, but SVG transform-origin behaves differently across browsers — it can default to `0 0` instead of the specified center, causing the rect to sweep wildly and appear as a white spinning rectangle.

**Changes:**
1. **`OrchestratorDAG.tsx:274-290`** — Replace the spinning CSS animation with an SVG-native `<animateTransform>` element that rotates reliably:
   ```tsx
   {isRunning && (
     <rect x={-3} y={-3} width={nodeW + 6} height={NODE_H + 6} rx={0}
       fill="none" stroke="#3b82f6" strokeWidth={1.5}
       strokeDasharray="12 8" opacity={0.7}>
       <animateTransform attributeName="transform" type="rotate"
         from={`0 ${nodeW/2} ${NODE_H/2}`} to={`360 ${nodeW/2} ${NODE_H/2}`}
         dur="4s" repeatCount="indefinite" />
     </rect>
   )}
   ```
   This eliminates the need for CSS `transform-origin` on SVG elements entirely.
2. **`index.css:1774-1777`** — Remove the `.ade-spin-4s` class (no longer needed if no other elements use it)
3. **Keep** the glow pulse at lines 293-312 (SVG `<animate>` on opacity — this works correctly)

### WS1.4: Rename "Usage" tab to "Details"

**Changes:**
1. **`MissionsPage.tsx`** — Find the tab definition for "usage" (around line 2643) and change the label from "Usage" to "Details"
2. **`MissionsPage.tsx`** — Rename `WorkspaceTab` type: replace `"usage"` with `"details"` throughout
3. **`MissionsPage.tsx`** — Update `activeTab` state references from `"usage"` to `"details"`
4. Keep `UsageDashboard.tsx` filename as-is (internal name doesn't matter) — it will be enhanced in WS7

---

## WS2: Slack-Like Chat System (Depends on WS3 for real-time delivery)

**Goal:** Replace the split-pane channels tab with a unified Slack-like chat interface featuring global view, @mentions, and per-agent views.
**Files:** New `MissionChatV2.tsx`, new `MentionInput.tsx`, modify `AgentChannels.tsx`, modify `MissionsPage.tsx`
**Estimated scope:** ~1200 lines new, ~400 lines modified
**Can parallel with:** WS1, WS4, WS6, WS7
**Depends on:** WS3 (message delivery backend)

### WS2.1: Design the channel structure

The Chat tab has a **sidebar + main area** layout:

```
┌────────────────────────────────────────────────────┐
│ CHAT TAB                                           │
├──────────┬─────────────────────────────────────────┤
│ CHANNELS │ # Global Chat                           │
│          │                                         │
│ # Global │ [orchestrator]: Planning phase complete. │
│          │ Starting 3 implementation workers.       │
│ AGENTS   │                                         │
│ ○ orch.  │ [worker-auth] → [@orchestrator]:        │
│ ● step-1 │ Auth module done. Changed User.ts,      │
│ ● step-2 │ AuthService.ts. Tests passing.          │
│ ● step-3 │                                         │
│ ○ step-4 │ [orchestrator] → [@worker-db]:          │
│          │ worker-auth changed User.ts. Update      │
│ COMPLETED│ your imports.                            │
│ ✓ plan   │                                         │
│          │ [@you] → [@worker-auth]:                 │
│          │ Also add rate limiting to the endpoint.  │
│          │                                         │
│          ├─────────────────────────────────────────┤
│          │ @ │ Type a message...          │ Send │ │
│          │   │ ┌─────────────────┐        │      │ │
│          │   │ │ @orchestrator   │        │      │ │
│          │   │ │ @worker-auth ●  │        │      │ │
│          │   │ │ @worker-db ●    │        │      │ │
│          │   │ │ @all            │        │      │ │
│          │   │ └─────────────────┘        │      │ │
└──────────┴─────────────────────────────────────────┘
```

**Channel types:**
- **`# Global`** — Shows ALL messages across all threads for this mission. Inter-agent messages show as `[source] → [@target]: message`. Orchestrator broadcasts show without a target. User messages show as `[@you]`. Messages with `@` targeting show the mention inline.
- **`○ orchestrator`** — Orchestrator's own view. Shows only messages to/from the orchestrator. Typing here automatically targets the orchestrator (no `@` needed).
- **`● step-key`** (active agents) — Individual agent view. Shows the agent's logs, tool calls, progress, AND any messages sent to/from this agent. Typing here automatically targets that agent.
- **`✓ step-key`** (completed agents) — Read-only view of completed agent's history.

**Visibility rules for Global chat:**
- Messages with NO `@` target: visible to everyone (broadcasts)
- Messages with `@agent-name`: visible to everyone in global view, but only the targeted agent receives it in their conversation. Displayed with the `@` mention highlighted.
- Messages with `@all`: visible to everyone, delivered to all active agents
- When an agent responds to a `@` message, they must `@` back: `[worker-auth] → [@you]: Done, rate limiting added.`

### WS2.2: Build `MentionInput` component

A shared autocomplete input component for `@` mentions.

**File:** `apps/desktop/src/renderer/components/shared/MentionInput.tsx`

**Props:**
```typescript
type MentionInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: (message: string, mentions: string[]) => void;
  participants: Array<{
    id: string;           // attemptId or "orchestrator" or "all"
    label: string;        // display name (step-key or "orchestrator")
    status: "active" | "completed" | "failed";
    role?: string;        // "orchestrator" | "worker" | "user"
  }>;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
};
```

**Behavior:**
- Typing `@` opens a floating dropdown above the input (like AgentChatComposer's slash command picker pattern)
- Dropdown shows filtered list of participants, with status dots
- Arrow keys to navigate, Enter/Tab to select, Escape to dismiss
- Selected mention inserts `@step-key` with purple highlight styling (inline `<span>`)
- Multiple `@` mentions supported in a single message
- On send: parse all `@` mentions, pass as `mentions[]` array to callback
- If input is in a per-agent channel, mentions are optional (auto-targeted)
- Support `@all` for broadcast

**Styling:** Match existing ADE design language — `#13101A` bg, `#A78BFA` accent, `Space Grotesk` / `JetBrains Mono`, 10px uppercase labels.

### WS2.3: Build `MissionChatV2` component

Replace `MissionChat` entirely. This is the main chat component for the Chat tab.

**File:** `apps/desktop/src/renderer/components/missions/MissionChatV2.tsx` (~800 lines)

**Structure:**
1. **Sidebar (200px)** — Channel list
   - `# Global` — always first, always visible
   - `ORCHESTRATOR` section — orchestrator channel
   - `ACTIVE` section — active worker channels, sorted by step index
   - `COMPLETED` section — completed worker channels, collapsible
   - Each channel shows: status dot + name + unread count badge
   - Click to switch channel

2. **Main area** — Message view + input
   - **Header:** Channel name + status + agent info (model, step type)
   - **Message list:** Scrollable, auto-scroll on new messages, "Jump to latest" sticky button
   - **Message rendering** per channel type:
     - **Global:** Show all messages with `[sender] → [@target]:` format. Inter-agent messages get a subtle connecting line. Orchestrator broadcasts get a system-message pill style. Tool calls/file changes are collapsible.
     - **Per-agent:** Show the agent's streaming output (tool calls, text, file changes) interleaved with messages to/from the agent. The agent's output appears like a continuous log. Messages from users or other agents appear as distinct chat bubbles.
     - **Orchestrator:** Show orchestrator decisions, step dispatches, plan changes, and messages to/from the orchestrator.
   - **Input bar:** Uses `MentionInput` component
     - In Global: `@` required to target someone
     - In per-agent/orchestrator: auto-targeted, `@` optional
     - Send button + Enter to send

3. **Data sources:**
   - Threads: `window.ade.orchestrator.listChatThreads({ missionId })`
   - Messages: `window.ade.orchestrator.getThreadMessages({ threadId })`
   - Real-time: `window.ade.orchestrator.onThreadEvent(cb)` — listen for `message_appended` events
   - Worker states: `window.ade.orchestrator.getWorkerStates({ missionId })`
   - Send: `window.ade.orchestrator.sendThreadMessage(...)` or `sendAgentMessage(...)`

### WS2.4: Wire into MissionsPage

**Changes to `MissionsPage.tsx`:**
1. Rename `"channels"` tab to `"chat"` in `WorkspaceTab` type and tab definitions
2. Replace `<MissionChat>` render block (lines 2782-2789) with `<MissionChatV2>`
3. Remove old `MissionChat` component (lines 638-1229) — ~600 lines deleted
4. Remove `AgentChannels` import (line 71) — component was never used, can be deleted or kept as reference
5. Update `jumpTarget` handling to work with new component's channel switching

### WS2.5: Global chat message aggregation

The global chat view needs a **merged timeline** of all messages across all threads.

**Backend support needed (WS3):**
- New IPC endpoint: `orchestratorGetGlobalChatMessages({ missionId, since?, limit? })`
- Queries `orchestrator_chat_messages` for ALL messages in the mission, ordered by timestamp
- Each message includes its `thread_id` so the frontend can show sender/target context
- Real-time: existing `orchestratorThreadEvent` with `reason: "message_appended"` already fires for all threads — frontend just needs to handle it for the global view

---

## WS3: Real-Time Inter-Agent Messaging (Backend)

**Goal:** Enable real-time message delivery to running agents and build the @mention routing system.
**Files:** `aiOrchestratorService.ts`, `orchestratorService.ts`, `baseOrchestratorAdapter.ts`, `registerIpc.ts`, `ipc.ts`, `preload.ts`, `types.ts`
**Estimated scope:** ~600 lines new, ~200 lines modified
**Can parallel with:** WS1, WS4, WS6

### WS3.1: Message delivery to running agents

Currently `sendAgentMessage` writes to DB and fires UI events but does NOT deliver to the running agent process. We need two delivery mechanisms:

**A. Conversation injection (default for most messages):**

For CLI-wrapped agents (claude, codex):
```typescript
// In aiOrchestratorService.ts
function deliverMessageToAgent(attemptId: string, message: OrchestratorChatMessage): void {
  // 1. Find the PTY session for this attempt
  const attempt = getAttemptById(attemptId);
  const sessionId = attempt.metadata?.executorSessionId;
  if (!sessionId) return;  // agent not running or no session

  // 2. Format the message as a conversation turn
  const formatted = formatAgentMessage(message);
  // e.g., "\n[Message from @orchestrator]: Auth module is complete. Update your imports for User.ts.\n"

  // 3. Write to PTY stdin
  ptyService.write(sessionId, formatted + "\n");

  // 4. Update delivery state
  updateMessageDeliveryState(message.id, "delivered");
}
```

For SDK agents (Vercel AI SDK):
```typescript
// In unifiedExecutor.ts — add a message queue
class UnifiedSession {
  private pendingMessages: string[] = [];

  injectMessage(message: string): void {
    this.pendingMessages.push(message);
    // On next tool call completion or between steps,
    // prepend pending messages to the next user turn
  }
}
```

**B. Steering directive (for urgent/priority messages):**

Use the existing `steer` mechanism for messages marked as `priority: "urgent"`:
```typescript
if (message.metadata?.priority === "urgent") {
  agentChatService.steer(sessionId, message.content);
} else {
  deliverMessageToAgent(attemptId, message);
}
```

### WS3.2: @mention parsing and routing

Add mention parsing to the message send pipeline:

```typescript
// In aiOrchestratorService.ts
function parseMentions(content: string): { mentions: string[], cleanContent: string } {
  const mentionRegex = /@([\w-]+)/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push(match[1]);  // e.g., "orchestrator", "worker-auth", "all"
  }
  return { mentions, cleanContent: content };
}

function routeMessage(message: OrchestratorChatMessage, mentions: string[]): void {
  if (mentions.includes("all")) {
    // Broadcast to all active agents
    for (const attempt of getActiveAttempts(message.runId)) {
      deliverMessageToAgent(attempt.id, message);
    }
  } else {
    // Deliver to each mentioned agent
    for (const mention of mentions) {
      const attempt = resolveAttemptByStepKey(message.runId, mention);
      if (attempt) deliverMessageToAgent(attempt.id, message);
    }
  }
}
```

### WS3.3: New IPC endpoints

**`ipc.ts` additions:**
```typescript
orchestratorGetGlobalChat:     "ade.orchestrator.getGlobalChat"     // all messages for a mission
orchestratorDeliverMessage:    "ade.orchestrator.deliverMessage"    // push message to running agent
orchestratorGetActiveAgents:   "ade.orchestrator.getActiveAgents"   // list active agents for @mention autocomplete
```

**`registerIpc.ts` additions:**
- `getGlobalChat({ missionId, since?, limit? })` — queries `orchestrator_chat_messages` for all messages in the mission, ordered by timestamp, with sender/target metadata
- `getActiveAgents({ missionId })` — returns list of `{ attemptId, stepKey, status, model, role }` for autocomplete
- Wire `deliverMessage` to the new delivery mechanism

**`preload.ts` additions:**
- Expose `getGlobalChat`, `getActiveAgents` on `window.ade.orchestrator`

### WS3.4: Agent-initiated messaging

When agents want to message each other, they do so through the orchestrator's tools. Add a `sendTeamMessage` tool to the coding tool set:

```typescript
// In tools/teamMessageTool.ts
export const teamMessageTool = tool({
  description: "Send a message to another agent or the orchestrator. Use @step-key to target a specific agent, @orchestrator for the orchestrator, or @all for broadcast.",
  inputSchema: z.object({
    target: z.string().describe("Target: step-key, 'orchestrator', or 'all'"),
    message: z.string().describe("The message content"),
  }),
  execute: async ({ target, message }) => {
    // Calls back to the orchestrator service via a callback injected at tool creation
    await orchestratorCallback.sendAgentMessage({
      fromAttemptId: currentAttemptId,
      target,
      content: message,
    });
    return { delivered: true, target };
  },
});
```

This tool is injected into the agent's tool set during `baseOrchestratorAdapter.buildFullPrompt()` along with a system prompt section explaining team communication.

---

## WS4: Shared Facts & Run Narrative (Backend)

**Goal:** Wire existing but unused infrastructure into agent prompts, add rolling run narrative.
**Files:** `baseOrchestratorAdapter.ts`, `orchestratorService.ts`, `aiOrchestratorService.ts`, `memoryService.ts`
**Estimated scope:** ~300 lines new, ~100 lines modified
**Can parallel with:** WS1, WS2, WS3, WS6

### WS4.1: Wire shared facts into `buildFullPrompt()`

In `baseOrchestratorAdapter.ts`, after the handoff summaries section, add:

```typescript
// Query shared facts for this run
const sharedFacts = memoryService.getSharedFacts(run.id, 20);
if (sharedFacts.length > 0) {
  sections.push(`\n## Shared Team Knowledge\nFacts discovered by other agents in this run:\n`);
  for (const fact of sharedFacts) {
    sections.push(`- [${fact.factType}] ${fact.content}`);
  }
}
```

**Also wire project memories:**
```typescript
// Query promoted project memories (high importance only)
const projectMemories = memoryService.getMemoryBudget(projectId, "lite");
const promoted = projectMemories.filter(m => m.importance === "high");
if (promoted.length > 0) {
  sections.push(`\n## Project Knowledge\n`);
  for (const mem of promoted) {
    sections.push(`- [${mem.category}] ${mem.content}`);
  }
}
```

### WS4.2: Add run narrative generation

After each step completes, auto-generate a 2-3 sentence summary and append to a rolling narrative.

**In `orchestratorService.ts`, after `completeAttempt` succeeds:**

```typescript
function appendRunNarrative(runId: string, stepKey: string, summary: string): void {
  const run = getRunById(runId);
  const narrative = run.metadata?.runNarrative ?? [];
  narrative.push({
    stepKey,
    summary,  // from worker_digest.summary
    at: new Date().toISOString(),
  });
  // Keep only last 20 entries to prevent unbounded growth
  if (narrative.length > 20) narrative.splice(0, narrative.length - 20);
  updateRunMetadata(runId, { runNarrative: narrative });
}
```

**Inject into prompts in `buildFullPrompt()`:**
```typescript
const narrative = run.metadata?.runNarrative;
if (narrative?.length) {
  sections.push(`\n## Run Progress (what has happened so far)\n`);
  for (const entry of narrative) {
    sections.push(`- ${entry.stepKey}: ${entry.summary}`);
  }
}
```

### WS4.3: Add compaction hints

Inject a compaction-safe section into agent prompts that CLI-native compaction will preserve:

```typescript
// At the END of buildFullPrompt(), add:
sections.push(`
## COMPACTION CONTEXT (preserve across context summarization)
- Mission: "${run.metadata?.missionGoal?.slice(0, 200)}"
- Your step: "${step.metadata?.stepKey}" (${step.title})
- Files you own: ${step.metadata?.claimScopes?.map(c => c.scopeValue).join(", ") || "none"}
- Shared facts count: ${sharedFacts.length}
- Run progress: ${completedSteps}/${totalSteps} steps complete
When your context is summarized/compacted, preserve this section and any important discoveries.
Before compaction, write important discoveries as shared facts using the memoryAdd tool.
`);
```

### WS4.4: Wire memory tools into agent tool set

The `memoryTools.ts` file exists but is NOT included in `createCodingToolSet()` in `tools/index.ts`. Wire it in:

```typescript
// In tools/index.ts
import { createMemoryTools } from "./memoryTools";

export function createCodingToolSet(cwd: string, opts?: { memoryService?, projectId? }) {
  const tools = { /* existing tools */ };
  if (opts?.memoryService && opts?.projectId) {
    const memTools = createMemoryTools(opts.memoryService, opts.projectId);
    Object.assign(tools, memTools);
  }
  return tools;
}
```

---

## WS5: Smart Fan-Out with AI Reasoning (Backend)

**Goal:** Enable dynamic step creation from agent output, with AI-driven dispatch strategy decisions.
**Files:** `orchestratorService.ts`, `aiOrchestratorService.ts`, new `metaReasoner.ts`, `missionPlanningService.ts`
**Estimated scope:** ~800 lines new, ~200 lines modified
**Can parallel with:** WS2, WS7 (but depends on WS4 for narrative/facts wiring)

### WS5.1: Step type: `fan_out`

Add a new step metadata flag in the plan schema:

```typescript
// In types.ts
type OrchestratorStepMetadata = {
  // ... existing fields ...
  fanOut?: {
    enabled: boolean;
    maxChildren: number;          // safety cap, default 8
    dispatchStrategy?: "auto" | "external_only" | "internal_only";
    groupByFileOwnership?: boolean;  // cluster subtasks by file overlap
  };
};
```

When the planner marks a step with `fanOut.enabled: true`, the orchestrator knows to run the meta-reasoner on that step's output after completion.

### WS5.2: Meta-reasoner implementation

**File:** `apps/desktop/src/main/services/orchestrator/metaReasoner.ts`

The meta-reasoner is an AI call (fast model, ~2-3s) that analyzes an agent's output and decides the optimal dispatch strategy.

```typescript
export type FanOutDecision = {
  strategy: "inline" | "internal_parallel" | "external_parallel" | "hybrid";
  subtasks: Array<{
    title: string;
    instructions: string;
    files: string[];             // files this subtask will touch
    complexity: "trivial" | "simple" | "moderate" | "complex";
    estimatedTokens?: number;
  }>;
  reasoning: string;             // why this strategy was chosen
  clusters?: Array<{             // for "hybrid" strategy
    subtaskIndices: number[];
    reason: string;              // why these are grouped
  }>;
};

export async function analyzeForFanOut(opts: {
  stepOutput: string;            // the completed agent's output
  stepKey: string;
  runState: {
    activeAgentCount: number;
    parallelismCap: number;
    availableLanes: string[];
    fileOwnershipMap: Record<string, string>;  // file → owning stepKey
    modelCapabilities: {
      supportsTeamCreate: boolean;    // Claude
      supportsSubagents: boolean;     // AI SDK ToolLoopAgent
      supportsParallelTools: boolean; // Codex
    };
  };
  aiService: AiIntegrationService;
}): Promise<FanOutDecision> {
  const prompt = buildMetaReasonerPrompt(opts);

  const result = await opts.aiService.executeTask({
    taskType: "meta_reasoning",
    prompt,
    model: "anthropic/claude-haiku-4-5",  // fast, cheap model for meta-reasoning
    oneShot: true,
    timeoutMs: 15_000,
  });

  return parseMetaReasonerOutput(result);
}
```

**Meta-reasoner prompt includes:**
- The agent's output text (what it found/produced)
- Current run state (how many agents running, what files are claimed)
- Model capabilities (can this model use TeamCreate? subagents?)
- Cost considerations (new worktree = expensive, internal = cheap)

**Decision factors:**
| Factor | Favors Internal | Favors External |
|--------|----------------|-----------------|
| Subtask count ≤ 3 | ✓ | |
| Subtask count > 6 | | ✓ |
| File overlap between subtasks | ✓ (must be sequential) | |
| No file overlap | | ✓ (can parallel) |
| Simple/trivial complexity | ✓ | |
| Complex subtasks | | ✓ |
| Near parallelism cap | ✓ | |
| Model supports TeamCreate | ✓ (prefer team) | |
| Subtasks need different models | | ✓ |

### WS5.3: Dynamic step injection

When a fan-out step completes and the meta-reasoner returns a decision:

**For "external_parallel" strategy:**
```typescript
// In orchestratorService.ts
function executeFanOutExternal(runId: string, parentStepId: string, decision: FanOutDecision): void {
  const childSteps = decision.subtasks.map((task, i) => ({
    stepKey: `${parentStepKey}-fanout-${i}`,
    title: task.title,
    instructions: task.instructions,
    dependencyStepKeys: [parentStepKey],  // depend on parent
    claimScopes: task.files.map(f => ({ scopeKind: "file", scopeValue: `glob:${f}` })),
    executorKind: resolveExecutorForComplexity(task.complexity),
    fanOutParent: parentStepKey,
  }));

  // Use existing addSteps() which validates graph integrity
  this.addSteps({ runId, steps: childSteps });

  // Wire successor steps to depend on ALL fan-out children (fan-in)
  const successorSteps = getStepsDependingOn(parentStepId);
  for (const successor of successorSteps) {
    updateStepDependencies(successor.id, [
      ...successor.dependencyStepIds.filter(id => id !== parentStepId),
      ...childSteps.map(c => c.id),
    ]);
  }

  // Refresh readiness → children become ready → autopilot dispatches them
  refreshStepReadiness(runId);
}
```

**For "internal_parallel" strategy:**
```typescript
// Instead of creating new steps, inject instructions into the CURRENT agent's next turn
function executeFanOutInternal(attemptId: string, decision: FanOutDecision): void {
  const message = formatInternalParallelInstructions(decision);
  // e.g., "You have 3 subtasks to handle. Use parallel sub-agents or TeamCreate:
  //        1. Fix auth module (files: auth.ts)
  //        2. Fix db module (files: db.ts)
  //        3. Fix api module (files: api.ts)"
  deliverMessageToAgent(attemptId, {
    role: "orchestrator",
    content: message,
    metadata: { fanOutInternal: true },
  });
}
```

**For "hybrid" strategy:**
- Group subtasks into clusters
- Each cluster becomes one external agent
- Within each cluster, the agent uses internal parallelism
- Cluster instructions tell the agent to use TeamCreate/subagents internally

### WS5.4: Fan-out completion tracking

Add metadata to track fan-out relationships:

```typescript
// In step metadata
type FanOutTracking = {
  fanOutParent?: string;          // stepKey of the parent
  fanOutChildren?: string[];      // stepKeys of children
  fanOutStrategy?: FanOutDecision["strategy"];
  fanOutComplete?: boolean;       // all children done
};
```

When all fan-out children complete, fire a `fan_out_complete` event on the run timeline.

### WS5.5: Integration with orchestrator autopilot loop

In `startReadyAutopilotAttempts`, after `completeAttempt` succeeds for a step with `fanOut.enabled`:

```typescript
if (completedStep.metadata?.fanOut?.enabled) {
  const decision = await analyzeForFanOut({
    stepOutput: attempt.resultEnvelope?.summary ?? "",
    stepKey: completedStep.stepKey,
    runState: buildRunStateSnapshot(runId),
    aiService,
  });

  if (decision.subtasks.length > 0) {
    switch (decision.strategy) {
      case "external_parallel":
        executeFanOutExternal(runId, completedStep.id, decision);
        break;
      case "internal_parallel":
        // Re-open the current step for another attempt with subtask instructions
        executeFanOutInternal(attempt.id, decision);
        break;
      case "hybrid":
        executeFanOutHybrid(runId, completedStep.id, decision);
        break;
      case "inline":
        // No action needed — step already completed the work
        break;
    }

    // Log the decision
    appendRunNarrative(runId, completedStep.stepKey,
      `Fan-out: ${decision.subtasks.length} subtasks, strategy: ${decision.strategy}. ${decision.reasoning}`
    );
  }
}
```

---

## WS6: Context Compaction & Session Persistence (Backend)

**Goal:** Add live context compaction for SDK agents, compaction hints for CLI agents, and full conversation transcript persistence for session resume.
**Files:** `unifiedExecutor.ts`, `aiIntegrationService.ts`, `agentChatService.ts`, `orchestratorService.ts`, `kvDb.ts`
**Estimated scope:** ~700 lines new, ~200 lines modified
**Can parallel with:** WS1, WS2, WS4

### WS6.1: Attempt transcript persistence

**New DB table in `kvDb.ts`:**
```sql
CREATE TABLE IF NOT EXISTS attempt_transcripts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  messages_json TEXT NOT NULL,        -- JSON array of conversation messages
  token_count INTEGER DEFAULT 0,
  compacted_at TEXT,                  -- timestamp of last compaction
  compaction_summary TEXT,            -- summary generated during compaction
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(attempt_id) REFERENCES orchestrator_attempts(id)
);
CREATE INDEX IF NOT EXISTS idx_attempt_transcripts_attempt ON attempt_transcripts(attempt_id);
```

**Write transcript on every significant event:**
```typescript
// In aiOrchestratorService.ts or the adapter
function appendTranscriptEntry(attemptId: string, entry: TranscriptEntry): void {
  const existing = db.get<{ messages_json: string, token_count: number }>(
    `SELECT messages_json, token_count FROM attempt_transcripts WHERE attempt_id = ?`, [attemptId]
  );

  const messages = existing ? JSON.parse(existing.messages_json) : [];
  messages.push(entry);

  // Keep last 200 entries to prevent unbounded growth
  if (messages.length > 200) messages.splice(0, messages.length - 200);

  const tokenCount = (existing?.token_count ?? 0) + (entry.tokens ?? 0);

  db.run(`INSERT OR REPLACE INTO attempt_transcripts (id, ..., messages_json, token_count, updated_at)
    VALUES (?, ..., ?, ?, ?)`, [attemptId, JSON.stringify(messages), tokenCount, now]);
}
```

### WS6.2: SDK agent compaction engine

**In `unifiedExecutor.ts`, add compaction monitoring:**

```typescript
export class UnifiedSession {
  private messages: CoreMessage[] = [];
  private totalTokens = 0;
  private readonly contextWindow: number;  // from MODEL_REGISTRY
  private readonly compactionThreshold: number;  // 0.7 * contextWindow

  async* executeWithCompaction(opts: UnifiedExecutorOpts): AsyncGenerator<AgentEvent> {
    const model = getModelById(opts.modelId);
    this.contextWindow = model.contextWindow ?? 128_000;
    this.compactionThreshold = Math.floor(this.contextWindow * 0.7);

    while (true) {
      const result = streamText({
        model: sdkModel,
        messages: this.messages,
        tools,
        abortSignal,
      });

      for await (const part of result.fullStream) {
        yield mapToAgentEvent(part);
      }

      const usage = await result.usage;
      this.totalTokens = usage.totalTokens;

      // Check if compaction needed
      if (this.totalTokens >= this.compactionThreshold) {
        yield { type: "activity", message: "Compacting context..." };
        await this.compact(opts);
      }

      // If no more tool calls, we're done
      if (!result.toolCalls?.length) break;
    }
  }

  private async compact(opts: UnifiedExecutorOpts): Promise<void> {
    // 1. Pre-compaction writeback
    await this.preCompactionWriteback(opts);

    // 2. Build compaction prompt
    const compactionPrompt = buildCompactionPrompt(this.messages, opts);

    // 3. Generate summary using same or cheaper model
    const summary = await generateText({
      model: sdkModel,
      system: "Summarize this conversation. Preserve: current task, files modified, key decisions, errors encountered, and any COMPACTION CONTEXT sections.",
      prompt: compactionPrompt,
    });

    // 4. Replace messages with summary
    this.messages = [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: `[Context Summary]\n${summary.text}\n\n[Continue from where you left off]` },
    ];

    // 5. Record compaction in transcript
    appendTranscriptEntry(opts.attemptId, {
      type: "compaction",
      summary: summary.text,
      tokensBeforeCompaction: this.totalTokens,
      at: new Date().toISOString(),
    });
  }

  private async preCompactionWriteback(opts: UnifiedExecutorOpts): Promise<void> {
    // Extract important facts from conversation and write to shared facts
    // This ensures critical discoveries survive compaction
    const extractionResult = await generateText({
      model: sdkModel,
      system: "Extract important facts, discoveries, and decisions from this conversation. Return as a JSON array of { factType, content } objects.",
      prompt: formatMessagesForExtraction(this.messages),
    });

    const facts = JSON.parse(extractionResult.text);
    for (const fact of facts) {
      memoryService.addSharedFact({
        runId: opts.runId,
        stepId: opts.stepId,
        factType: fact.factType,
        content: fact.content,
      });
    }
  }
}
```

### WS6.3: CLI agent compaction hints

For CLI-wrapped agents (claude, codex), we can't control compaction directly. Instead, we inject a compaction-friendly prompt section (already designed in WS4.3) that tells the CLI's built-in compactor what to preserve.

Additionally, inject a **pre-compaction instruction** in the system prompt:
```
IMPORTANT: When you notice your context is getting long, proactively:
1. Write important discoveries as shared facts using the memoryAdd tool
2. Update your checkpoint file (.ade-checkpoint-{stepKey}.md) with current progress
This ensures your work survives context compaction.
```

### WS6.4: Session resume for SDK agents

**In `unifiedExecutor.ts`, add resume support:**

```typescript
export async function* resumeUnified(opts: UnifiedResumeOpts): AsyncGenerator<AgentEvent> {
  // 1. Load previous transcript
  const transcript = db.get<{ messages_json: string, compaction_summary: string }>(
    `SELECT messages_json, compaction_summary FROM attempt_transcripts WHERE attempt_id = ?`,
    [opts.previousAttemptId]
  );

  if (!transcript) {
    // No transcript — fall back to fresh execution with recovery context
    yield* executeUnified(opts);
    return;
  }

  // 2. Reconstruct conversation history
  const previousMessages = JSON.parse(transcript.messages_json);

  // 3. If transcript is too large, use compaction summary instead
  const messages: CoreMessage[] = [];
  if (previousMessages.length > 50 || transcript.compaction_summary) {
    messages.push({
      role: "user",
      content: `[Previous session summary]\n${transcript.compaction_summary}\n\n[Continuing from where you left off. Your new instructions:]\n${opts.prompt}`,
    });
  } else {
    messages.push(...previousMessages);
    messages.push({ role: "user", content: opts.prompt });
  }

  // 4. Create new session with history
  const session = new UnifiedSession();
  session.messages = messages;
  yield* session.executeWithCompaction(opts);
}
```

**Wire into `aiIntegrationService.ts`:**
```typescript
// In executeViaUnifiedPath:
if (args.sessionId && args.resumeFrom) {
  return resumeUnified({ ...opts, previousAttemptId: args.resumeFrom });
}
```

### WS6.5: Chat session persistence enhancement

Enhance `agentChatService.ts` to persist full conversation history for all session types (not just Claude):

```typescript
// On session create, initialize a transcript
function initializeSessionTranscript(sessionId: string): void {
  // Create a file at {adeDir}/chat-transcripts/{sessionId}.jsonl
  // Each line is a JSON event (text, tool_call, tool_result, etc.)
}

// On every emitChatEvent, also append to transcript file
function appendToTranscript(sessionId: string, event: AgentChatEvent): void {
  const line = JSON.stringify({ ...event, timestamp: Date.now() });
  fs.appendFileSync(transcriptPath, line + "\n");
}
```

---

## WS7: Memory Architecture Evolution (Backend + Frontend)

**Goal:** Evolve the memory system to support candidate promotion, context budget visibility, and future agent identity.
**Files:** `memoryService.ts`, `kvDb.ts`, `types.ts`, `UsageDashboard.tsx`, `registerIpc.ts`, `ipc.ts`, `preload.ts`
**Estimated scope:** ~600 lines new, ~200 lines modified
**Can parallel with:** WS1, WS2, WS5

### WS7.1: Evolve memories table schema

**In `kvDb.ts`, add migration:**
```sql
-- Add new columns to memories table
ALTER TABLE memories ADD COLUMN status TEXT DEFAULT 'promoted';
  -- 'candidate' | 'promoted' | 'archived'
ALTER TABLE memories ADD COLUMN agent_id TEXT;
  -- nullable, for future agent-scoped memories
ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 1.0;
  -- 0.0-1.0, for promotion scoring
ALTER TABLE memories ADD COLUMN promoted_at TEXT;
ALTER TABLE memories ADD COLUMN source_run_id TEXT;
  -- which run created this memory

CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(project_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
```

### WS7.2: Create agent_identities table (schema only, for future use)

```sql
CREATE TABLE IF NOT EXISTS agent_identities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,                    -- "Developer Agent", "Testing Agent"
  profile_json TEXT NOT NULL DEFAULT '{}',  -- AGENT_PROFILE: role, rules, capabilities
  persona_json TEXT NOT NULL DEFAULT '{}',  -- AGENT_PERSONA: communication style, preferences
  tool_policy_json TEXT NOT NULL DEFAULT '{}',  -- TOOL_POLICY: allowed/denied tools, permission level
  user_preferences_json TEXT NOT NULL DEFAULT '{}',  -- USER_PREFERENCES per agent
  heartbeat_json TEXT,                   -- HEARTBEAT: last activity, health, resource usage
  model_preference TEXT,                 -- preferred model ID
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_identities_project ON agent_identities(project_id);
```

This table is created but NOT used in any business logic yet. It's a schema placeholder for the future agent-as-employee feature.

### WS7.3: Memory promotion flow

**In `memoryService.ts`, add promotion methods:**

```typescript
function addCandidateMemory(opts: AddMemoryOpts & { confidence?: number; sourceRunId?: string }): Memory {
  // Same as addMemory but with status = "candidate"
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO memories (..., status, confidence, source_run_id) VALUES (..., 'candidate', ?, ?)`,
    [opts.confidence ?? 0.5, opts.sourceRunId ?? null]
  );
  return { ... };
}

function promoteMemory(id: string): void {
  db.run(`UPDATE memories SET status = 'promoted', promoted_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]);
}

function archiveMemory(id: string): void {
  db.run(`UPDATE memories SET status = 'archived' WHERE id = ?`, [id]);
}

function getCandidateMemories(projectId: string, limit = 20): Memory[] {
  return db.all(
    `SELECT * FROM memories WHERE project_id = ? AND status = 'candidate'
     ORDER BY confidence DESC, created_at DESC LIMIT ?`,
    [projectId, limit]
  ).map(mapMemoryRow);
}
```

**Auto-promotion on run completion:**
In `orchestratorService.ts`, when a run succeeds:
```typescript
function promoteRunFactsToMemory(runId: string, projectId: string): void {
  const facts = memoryService.getSharedFacts(runId);
  for (const fact of facts) {
    // High-importance facts auto-promote; others become candidates
    const confidence = fact.factType === "architectural" || fact.factType === "gotcha" ? 0.9 : 0.5;
    memoryService.addCandidateMemory({
      projectId,
      scope: "project",
      category: factTypeToCategory(fact.factType),
      content: fact.content,
      importance: confidence >= 0.8 ? "high" : "medium",
      confidence,
      sourceRunId: runId,
    });
  }

  // Auto-promote high-confidence candidates
  const candidates = memoryService.getCandidateMemories(projectId);
  for (const candidate of candidates) {
    if ((candidate as any).confidence >= 0.8) {
      memoryService.promoteMemory(candidate.id);
    }
  }
}
```

### WS7.4: Context Budget Panel (Frontend)

Add a new section to `UsageDashboard.tsx` (now "Details" tab):

**New type in `types.ts`:**
```typescript
export type ContextBudget = {
  systemPromptTokens: number;
  toolSchemaTokens: number;
  historyTokens: number;
  memoryTokens: number;           // shared facts + project memories
  docsTokens: number;
  totalTokens: number;
  modelContextWindow: number;
  utilizationPct: number;
  truncationEvents: number;       // how many times docs/context was truncated
  compactionEvents: number;       // how many times context was compacted
  lastCompactedAt?: string;
};
```

**New IPC endpoint:** `orchestratorGetContextBudget({ missionId, attemptId? })`
- Queries `orchestrator_context_snapshots` for the latest attempt
- Computes token estimates from `cursor_json.memoryHierarchy`
- Returns `ContextBudget`

**UI rendering in UsageDashboard.tsx:**
```
┌─────────────────────────────────────────────┐
│ CONTEXT BUDGET                              │
├─────────────────────────────────────────────┤
│                                             │
│ System Prompt    ████░░░░░░  2,400 tokens   │
│ Tool Schemas     ██░░░░░░░░  1,100 tokens   │
│ History          ████████░░  8,200 tokens   │
│ Memory/Facts     █░░░░░░░░░    450 tokens   │
│ Docs             ███░░░░░░░  3,800 tokens   │
│ ─────────────────────────────────────────── │
│ Total: 15,950 / 128,000 (12.5%)            │
│                                             │
│ Truncation events: 2                        │
│ Compaction events: 0                        │
│ Last compacted: never                       │
│                                             │
│ CANDIDATE MEMORIES (3 pending review)       │
│ ┌───────────────────────────────────────┐   │
│ │ [architectural] The API uses...  [✓][✗]│  │
│ │ [gotcha] Rate limiting needs...  [✓][✗]│  │
│ │ [pattern] Always use snake_c...  [✓][✗]│  │
│ └───────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### WS7.5: Memory IPC endpoints

**New IPC channels in `ipc.ts`:**
```typescript
memoryGetBudget:         "ade.memory.getBudget"
memoryGetCandidates:     "ade.memory.getCandidates"
memoryPromote:           "ade.memory.promote"
memoryArchive:           "ade.memory.archive"
memorySearch:            "ade.memory.search"
```

**Wire in `registerIpc.ts`** and expose via `preload.ts`.

---

## WS8: Run Narrative in Activity Tab (Frontend)

**Goal:** Show the rolling run narrative in the Activity tab.
**Files:** `MissionsPage.tsx` (activity tab section)
**Estimated scope:** ~100 lines new
**Can parallel with:** Everything

### WS8.1: Add narrative display

In the Activity tab section of `MissionsPage.tsx`, add a "Run Progress" section that renders the run narrative:

```tsx
{activeTab === "activity" && runGraph && (
  <div className="space-y-3">
    {/* Existing timeline events */}
    <TimelineView ... />

    {/* Run Narrative */}
    {runGraph.run.metadata?.runNarrative?.length > 0 && (
      <div className="space-y-1.5">
        <div className="text-[10px] font-bold tracking-wider" style={{ color: COLORS.textMuted }}>
          RUN NARRATIVE
        </div>
        {runGraph.run.metadata.runNarrative.map((entry, i) => (
          <div key={i} className="text-[11px] flex gap-2" style={{ fontFamily: MONO_FONT }}>
            <span style={{ color: COLORS.accent }}>{entry.stepKey}</span>
            <span style={{ color: COLORS.textSecondary }}>{entry.summary}</span>
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

---

## WS9: Documentation Updates (Final Step — Parallel Agents)

**Goal:** Update all relevant documentation to reflect the orchestrator evolution changes.
**Files:** Multiple docs in `/Users/arul/ADE/docs/`
**Execution:** Run in PARALLEL — one agent per doc file or doc group
**IMPORTANT:** This workstream runs AFTER all other workstreams are complete.

### Docs requiring updates:

| File | What to update |
|------|---------------|
| **`docs/final-plan.md`** | MAJOR UPDATE — Add all new workstreams, mark completed items, update architecture diagrams, add new feature descriptions for: smart fan-out, inter-agent messaging, Slack-like chat, context compaction, memory architecture, session persistence |
| **`docs/architecture/AI_INTEGRATION.md`** | Update with: unified executor compaction engine, session persistence, meta-reasoner, fan-out dispatch strategies, memory tool wiring |
| **`docs/architecture/SYSTEM_OVERVIEW.md`** | Update system architecture diagram with new services (metaReasoner, compaction engine, message delivery), updated data flow |
| **`docs/architecture/DATA_MODEL.md`** | Add new tables: `attempt_transcripts`, `agent_identities`. Document schema changes to `memories` table (status, agent_id, confidence). Document new fields on `orchestrator_runs` (runNarrative) |
| **`docs/architecture/UI_FRAMEWORK.md`** | Document new components: `MissionChatV2`, `MentionInput`. Document tab renames (channels→chat, usage→details). Document removed components (ExecutionPlanPreview) |
| **`docs/features/MISSIONS.md`** | Update mission workspace documentation: new chat tab, @mentions, global view, per-agent views. Update DAG section (fixed animation). Update progress bar section (single bar) |
| **`docs/features/AGENTS.md`** | MAJOR UPDATE — Document inter-agent messaging, team communication tools, @mention system, agent-initiated messaging. Add future section on agent identity |
| **`docs/architecture/CONTEXT_CONTRACT.md`** | Update context assembly pipeline with: shared facts injection, run narrative injection, project memory injection, compaction hints. Document the 4-layer memory model (L0-L3) |
| **`docs/architecture/CONFIGURATION.md`** | Document new configuration for: fan-out settings, compaction thresholds, memory promotion policies, meta-reasoner model selection |
| **`docs/architecture/SECURITY_AND_PRIVACY.md`** | Document memory scoping rules, candidate memory promotion policy, API key file permissions (0o600) |
| **`docs/ui-remaining-gaps.md`** | Update with resolved gaps (chat redesign, progress bar fix, DAG fix). Add new gaps if any remain |
| **`docs/features/ONBOARDING_AND_SETTINGS.md`** | Document any new settings for memory, compaction, context budget visibility |
| **`docs/PRD.md`** | Update product requirements to include inter-agent communication, smart orchestration, memory architecture |

### Execution strategy for doc updates:

Launch 4 parallel agents via TeamCreate:
1. **Agent "docs-architecture"** — Updates all `docs/architecture/*.md` files
2. **Agent "docs-features"** — Updates all `docs/features/*.md` files
3. **Agent "docs-final-plan"** — Updates `docs/final-plan.md` (most extensive)
4. **Agent "docs-top-level"** — Updates `docs/PRD.md`, `docs/ui-remaining-gaps.md`

Each agent reads the current doc content, reads the relevant source code for accuracy, and writes comprehensive updates. They should cross-reference each other's docs to ensure consistency.

---

## Execution Order & Parallelism Map

```
TIME ──────────────────────────────────────────────────────►

WS1: UI Bug Fixes          ████░░░░░░░░░░░░░░░░░░░░░░░░░░░
     (independent)          ▲ start immediately

WS4: Shared Facts/Narrative ██████████░░░░░░░░░░░░░░░░░░░░░
     (backend, enables WS5)  ▲ start immediately

WS3: Inter-Agent Messaging  ████████████████░░░░░░░░░░░░░░░
     (backend, enables WS2)  ▲ start immediately

WS6: Compaction/Sessions    ██████████████████░░░░░░░░░░░░░
     (backend, independent)  ▲ start immediately

WS8: Activity Tab Narrative  ████░░░░░░░░░░░░░░░░░░░░░░░░░░
     (frontend, small)        ▲ after WS4 narrative design

WS7: Memory Architecture    ████████████████████░░░░░░░░░░░
     (backend+frontend)       ▲ start immediately

WS2: Slack-Like Chat UI     ░░░░░░░████████████████████░░░░
     (frontend, needs WS3)            ▲ after WS3 backend ready

WS5: Smart Fan-Out          ░░░░░░░░░░██████████████████░░░
     (backend, needs WS4)              ▲ after WS4 facts wired

WS9: Documentation          ░░░░░░░░░░░░░░░░░░░░░░░░████████
     (4 parallel agents)                             ▲ LAST
```

### Recommended TeamCreate groups for development:

**Phase 1 — Parallel backend + frontend fixes (4 agents):**
- Agent "ws1-ui-fixes" → WS1 (all 4 bug fixes)
- Agent "ws4-shared-facts" → WS4 (wire facts, narrative, compaction hints, memory tools)
- Agent "ws3-messaging" → WS3 (message delivery, @mention routing, new IPC)
- Agent "ws6-compaction" → WS6 (compaction engine, transcript persistence, session resume)

**Phase 2 — Features that depend on Phase 1 (3 agents):**
- Agent "ws2-chat-ui" → WS2 (MissionChatV2, MentionInput, global chat)
- Agent "ws5-fanout" → WS5 (meta-reasoner, dynamic step injection, dispatch strategies)
- Agent "ws7-memory" → WS7 (schema evolution, promotion flow, context budget panel)
- Agent "ws8-narrative-ui" → WS8 (activity tab narrative display — small, can merge with ws2)

**Phase 3 — Documentation (4 parallel agents):**
- Agent "docs-architecture" → Architecture docs
- Agent "docs-features" → Feature docs
- Agent "docs-final-plan" → Final plan
- Agent "docs-top-level" → PRD, remaining gaps

**Total: 11 agents across 3 phases, with maximum parallelism within each phase.**

---

## Key Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Message delivery | Conversation injection (default) + steering (urgent) | Collaborative by default, authoritative when needed |
| Fan-out analysis | AI meta-reasoner (not structured JSON) | Flexible, adapts to any output format, can reason about dispatch strategy |
| Fan-out dispatch | 4 strategies (inline, internal_parallel, external_parallel, hybrid) | Covers all complexity levels and model capabilities |
| Compaction (SDK) | Self-summarize at 70% context usage | Matches Claude Code's approach, model-aware |
| Compaction (CLI) | Injection of compaction hints + pre-compaction writeback instruction | Can't control CLI compaction, but can influence what survives |
| Memory model | 4 layers (session → run → curated → identity) | Forward-compatible with agent-as-employee, each layer has clear lifecycle |
| Memory promotion | Candidate → auto-promote (high confidence) or user review | Prevents noise in long-term memory while capturing valuable discoveries |
| Chat UI | Slack-like with sidebar channels + global view + @mentions | Matches user's mental model of team communication |
| Agent identity table | Schema now, logic later | Prevents schema migration headaches when agent system is built |
| Tab renames | channels → chat, usage → details | More descriptive, accommodates new content |

---

## Success Criteria

1. **Inter-agent messages are visible in real-time** in the global chat view
2. **@mention autocomplete** works with all active agents + orchestrator
3. **Shared facts appear in agent prompts** — verify by reading a step's full prompt
4. **Fan-out creates dynamic steps** — run an audit step, see fix steps auto-created
5. **SDK agents compact their context** — verify token count drops after compaction
6. **Session resume works** — interrupt an SDK agent, resume, verify it continues from checkpoint
7. **Context Budget panel** shows accurate token counts for each context layer
8. **Candidate memories** appear in Details tab with promote/dismiss buttons
9. **No spinning white rectangle** in DAG — running steps show clean dashed border animation
10. **Single progress bar** — no duplicate completion percentage
11. **No ExecutionPlanPreview pane** — clean tab switching
12. **All docs updated** — final-plan.md, architecture docs, feature docs all reflect new reality

---

Use agent teams in depth to do all of this work. At any point you can use more parallel agents as well. No limit to how many agents you can use in your agent team. Start the team with TeamCreate.
