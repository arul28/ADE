// ---------------------------------------------------------------------------
// Coordinator Agent — the AI brain of the orchestrator.
// A long-running AI agent with full authority to plan, spawn workers,
// monitor progress, steer execution, and complete missions autonomously.
// ---------------------------------------------------------------------------

import { streamText, stepCountIs } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { createCoordinatorToolSet } from "./coordinatorTools";
import {
  formatRuntimeEvent,
} from "./coordinatorEventFormatter";
import {
  createCompactionMonitor,
  compactConversation,
  type CompactionMonitor,
  type TranscriptEntry,
} from "../ai/compactionEngine";
import { resolveModel } from "../ai/providerResolver";
import { detectAllAuth } from "../ai/authDetector";
import { getModelById } from "../../../shared/modelRegistry";
import type { createOrchestratorService } from "./orchestratorService";
import type {
  DagMutationEvent,
  OrchestratorRuntimeEvent,
  OrchestratorRunGraph,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { Tool } from "ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User-configured rules that constrain the coordinator's behavior. */
export type CoordinatorUserRules = {
  providerPreference?: string;
  costMode?: string;
  maxParallelWorkers?: number;
  laneStrategy?: string;
  permissionMode?: string;
  customInstructions?: string;
  defaultModel?: string;
};

/** Project context provided to the coordinator at startup. */
export type CoordinatorProjectContext = {
  projectRoot: string;
  projectDocs?: Record<string, string>;
  fileTree?: string;
};

/** Available provider info passed to the coordinator. */
export type CoordinatorAvailableProvider = {
  name: string;
  available: boolean;
  models?: string[];
};

export type CoordinatorAgentDeps = {
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  runId: string;
  missionId: string;
  missionGoal: string;
  modelId: string;
  logger: Logger;
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  onDagMutation: (event: DagMutationEvent) => void;
  onCoordinatorMessage?: (message: string) => void;
  onRunFinalize?: (args: { runId: string; succeeded: boolean; summary?: string; reason?: string }) => void;
  enableCompaction?: boolean;
  userRules?: CoordinatorUserRules;
  projectContext?: CoordinatorProjectContext;
  availableProviders?: CoordinatorAvailableProvider[];
};

type QueuedEvent = {
  message: string;
  receivedAt: number;
  retryCount?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_DELAY_MS = 200;
const MAX_TOOL_STEPS_PER_TURN = 25;
const COMPACTION_THRESHOLD_RATIO = 0.50;
const MAX_CONVERSATION_HISTORY = 200;
const MAX_EVENT_RETRY_COUNT = 2;

// ---------------------------------------------------------------------------
// Worker Identity Prompt Builder
// ---------------------------------------------------------------------------

export type WorkerIdentity = {
  name: string;
  role: string;
  provider: "claude" | "codex";
  parentName: string;
  missionSummary: string;
  taskPrompt: string;
  isSubOrchestrator?: boolean;
  inheritedRules?: string;
};

export function buildWorkerIdentityPrompt(identity: WorkerIdentity): string {
  const capabilities = identity.isSubOrchestrator
    ? `- You are a ${identity.provider} agent with full coding capabilities
- You can read, write, and edit files
- You can run terminal commands
- You can search the codebase
- You can spawn your own workers using the same tools as your parent orchestrator`
    : `- You are a ${identity.provider} agent with full coding capabilities
- You can read, write, and edit files
- You can run terminal commands
- You can search the codebase`;

  return `You are a worker agent spawned by the ADE orchestrator.

## Your Identity
- Name: ${identity.name}
- Role: ${identity.role}
- Spawned by: ${identity.parentName}
- Mission: ${identity.missionSummary}

## Your Task
${identity.taskPrompt}

Think independently about how best to accomplish this. Make autonomous decisions about implementation approach. You own the outcome — don't wait for permission or guidance.

## What You Can Do
${capabilities}
- You have full authority to make implementation decisions. Act decisively — don't hesitate or ask for approval on implementation details.

## Communication
- Your orchestrator can send you messages during execution — read and follow them
- Complete the FULL scope of your task before finishing. Don't stop partway through.
- If you encounter problems, solve them yourself — only report truly blocking issues that require human input or architectural decisions.
- When you complete your task, provide a clear summary of what you did, what files changed, and any issues encountered.
${identity.inheritedRules ? `\n## Rules\n${identity.inheritedRules}` : ""}`;
}

// ---------------------------------------------------------------------------
// Coordinator Agent
// ---------------------------------------------------------------------------

export class CoordinatorAgent {
  private deps: CoordinatorAgentDeps;
  private eventQueue: QueuedEvent[] = [];
  private processing = false;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private dead = false;
  private turnCount = 0;
  private tools: Record<string, Tool>;
  private conversationHistory: ModelMessage[] = [];
  private systemPrompt: string;
  private compactionMonitor: CompactionMonitor | null = null;

  constructor(deps: CoordinatorAgentDeps) {
    this.deps = deps;
    this.tools = createCoordinatorToolSet({
      orchestratorService: deps.orchestratorService,
      runId: deps.runId,
      missionId: deps.missionId,
      logger: deps.logger,
      db: deps.db,
      projectRoot: deps.projectRoot,
      onDagMutation: deps.onDagMutation,
      onRunFinalize: deps.onRunFinalize,
    });
    this.systemPrompt = this.buildSystemPrompt();

    // Initialize compaction monitor if enabled
    if (deps.enableCompaction) {
      const model = getModelById(deps.modelId);
      if (model) {
        this.compactionMonitor = createCompactionMonitor(
          model,
          COMPACTION_THRESHOLD_RATIO,
        );
      }
    }
  }

  // ─── Public API ──────────────────────────────────────────────────

  /**
   * Inject a runtime event into the coordinator. Events are batched
   * within BATCH_DELAY_MS and processed sequentially.
   */
  injectEvent(
    event: OrchestratorRuntimeEvent,
    formattedMessage?: string,
  ): void {
    if (this.dead) return;
    const message =
      formattedMessage ?? formatRuntimeEvent(event).summary;
    this.eventQueue.push({ message, receivedAt: Date.now() });
    this.scheduleBatch();
  }

  /**
   * Inject a raw text message (e.g. user steering, chat message).
   */
  injectMessage(message: string): void {
    if (this.dead) return;
    this.eventQueue.push({ message, receivedAt: Date.now() });
    this.scheduleBatch();
  }

  /** Stop the coordinator. No further events will be processed. */
  shutdown(): void {
    this.dead = true;
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  get isAlive(): boolean {
    return !this.dead;
  }

  get turns(): number {
    return this.turnCount;
  }

  get historyLength(): number {
    return this.conversationHistory.length;
  }

  // ─── Batch Scheduling ────────────────────────────────────────────

  private scheduleBatch(): void {
    if (this.batchTimer) return; // already scheduled
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.processBatch();
    }, BATCH_DELAY_MS);
  }

  private async processBatch(): Promise<void> {
    if (this.processing || this.dead || this.eventQueue.length === 0)
      return;
    this.processing = true;

    // Take a snapshot of events before removing from queue
    const events = this.eventQueue.splice(0);

    try {
      const combinedMessage = events
        .map((e) => e.message)
        .join("\n---\n");

      // Add to conversation history as a user message
      this.conversationHistory.push({
        role: "user",
        content: combinedMessage,
      });

      // Trim conversation history to prevent unbounded growth
      // (compaction is the proper solution, but this is a safety net)
      if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY) {
        const trimCount =
          this.conversationHistory.length - MAX_CONVERSATION_HISTORY;
        this.conversationHistory.splice(0, trimCount);
      }

      // Call the AI with tools
      await this.runTurn();
      this.turnCount++;

      // Check if compaction is needed
      if (this.compactionMonitor?.shouldCompact()) {
        await this.compactHistory();
      }
    } catch (err) {
      this.deps.logger.debug("coordinator_agent.batch_failed", {
        runId: this.deps.runId,
        error: err instanceof Error ? err.message : String(err),
      });

      // Re-enqueue events that failed processing (with retry limit)
      for (const event of events) {
        const retryCount = (event.retryCount ?? 0) + 1;
        if (retryCount <= MAX_EVENT_RETRY_COUNT) {
          this.eventQueue.push({ ...event, retryCount });
        }
        // Events exceeding MAX_EVENT_RETRY_COUNT are dropped to prevent infinite loops
      }
    } finally {
      this.processing = false;
      // If more events arrived during processing, schedule another batch
      if (this.eventQueue.length > 0 && !this.dead) {
        this.scheduleBatch();
      }
    }
  }

  // ─── AI Turn Execution ───────────────────────────────────────────

  private async runTurn(): Promise<void> {
    const sdkModel = await this.resolveModel();

    const result = streamText({
      model: sdkModel,
      system: this.systemPrompt,
      messages: this.conversationHistory,
      tools: this.tools as any,
      stopWhen: stepCountIs(MAX_TOOL_STEPS_PER_TURN),
    });

    let assistantText = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        assistantText += part.text;
      }
    }

    // Record token usage for compaction monitoring
    if (this.compactionMonitor) {
      try {
        const usage = await result.usage;
        if (usage) {
          this.compactionMonitor.recordTokens(
            usage.inputTokens ?? 0,
            usage.outputTokens ?? 0,
          );
        }
      } catch {
        // Usage retrieval can fail; non-critical
      }
    }

    if (assistantText.trim()) {
      this.conversationHistory.push({
        role: "assistant",
        content: assistantText,
      });

      // Notify the facade about coordinator messages (for chat display)
      if (this.deps.onCoordinatorMessage) {
        this.deps.onCoordinatorMessage(assistantText.trim());
      }
    }
  }

  // ─── Compaction ──────────────────────────────────────────────────

  private async compactHistory(): Promise<void> {
    try {
      const entries: TranscriptEntry[] = this.conversationHistory.map(
        (m) => ({
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          timestamp: new Date().toISOString(),
        }),
      );

      const result = await compactConversation({
        messages: entries,
        modelId: this.deps.modelId,
      });

      // Replace conversation history with compacted summary — preserve original mission goal
      this.conversationHistory = [
        {
          role: "user",
          content: `[CONTEXT COMPACTION]\nOriginal mission: ${this.deps.missionGoal}\n\nPrevious conversation summary:\n${result.summary}\n\nContinue managing the mission. Ensure all remaining work aligns with the original mission goal above.`,
        },
      ];

      this.deps.logger.info("coordinator_agent.compaction_complete", {
        runId: this.deps.runId,
        previousTokens: result.previousTokenCount,
        newTokens: result.newTokenCount,
        factsExtracted: result.factsExtracted.length,
      });
    } catch (err) {
      this.deps.logger.debug("coordinator_agent.compaction_failed", {
        runId: this.deps.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── System Prompt ───────────────────────────────────────────────

  private buildSystemPrompt(): string {
    const rules = this.deps.userRules;
    const ctx = this.deps.projectContext;
    const providers = this.deps.availableProviders;

    // Build user rules section
    let rulesSection = "";
    if (rules) {
      const ruleLines: string[] = [];
      if (rules.providerPreference) ruleLines.push(`- Provider preference: ${rules.providerPreference}`);
      if (rules.costMode) ruleLines.push(`- Cost mode: ${rules.costMode}`);
      if (rules.maxParallelWorkers != null) ruleLines.push(`- Maximum parallel workers: ${rules.maxParallelWorkers}`);
      if (rules.laneStrategy) ruleLines.push(`- Lane strategy: ${rules.laneStrategy}`);
      if (rules.permissionMode) ruleLines.push(`- Worker permission mode: ${rules.permissionMode}`);
      if (rules.defaultModel) ruleLines.push(`- Default model: ${rules.defaultModel}`);
      if (rules.customInstructions) ruleLines.push(`- Custom instructions: ${rules.customInstructions}`);
      if (ruleLines.length > 0) {
        rulesSection = `\n## Rules (from user configuration)\n${ruleLines.join("\n")}`;
      }
    }

    // Build available workers section
    let workersSection = `\n## Available Workers
You can spawn these types of workers:
- Claude Code agent (provider: "claude") — full coding agent with file editing, terminal, web access
- Codex agent (provider: "codex") — fast implementation agent, great for focused coding tasks`;
    if (providers?.length) {
      const available = providers.filter((p) => p.available).map((p) => p.name);
      if (available.length > 0) {
        workersSection += `\n\nCurrently available providers: ${available.join(", ")}`;
      }
    }

    // Build project context section
    let projectSection = "";
    if (ctx) {
      projectSection = `\n## Project Context\nProject root: ${ctx.projectRoot}`;
      if (ctx.projectDocs && Object.keys(ctx.projectDocs).length > 0) {
        projectSection += "\n\nProject documentation:";
        for (const [docPath, content] of Object.entries(ctx.projectDocs)) {
          projectSection += `\n\n### ${docPath}\n${content}`;
        }
      }
      if (ctx.fileTree) {
        projectSection += `\n\nFile structure:\n${ctx.fileTree}`;
      }
    }

    return `You are the mission orchestrator for ADE (Autonomous Development Environment). You are the lead of a team of AI agents.

## Your Mission
${this.deps.missionGoal}

Run ID: ${this.deps.runId}
Mission ID: ${this.deps.missionId}

## Your Authority
You have full authority to complete this mission. You can:
- Spawn as many workers as you need (within limits below)
- Create, modify, and reorder tasks as you see fit
- Communicate with workers and steer them in real time
- Adapt the plan when things change
- Decide when the mission is complete
- Spawn sub-orchestrators for complex phases
- Run validation loops (spawn a validator, check results, retry if needed)

No automated code gates, quality checks, or phase requirements will override your decisions. You are the sole authority on what gets done, how it gets done, and when the mission is complete.
${rulesSection}
${workersSection}
${projectSection}

## How to Work
1. Start by understanding the codebase — use get_project_context and read_file before planning.
2. Read the mission. Think about the approach.
3. Create tasks that represent the work to be done.
4. Spawn workers and assign them tasks. Prefer spawning workers in parallel when tasks are independent.
5. Monitor worker progress via events. Read their output when they complete.
6. Steer workers if they're going off track. Adapt the plan if needed.
7. When all work is done and you're satisfied, call complete_mission.

Think like a senior tech lead. Be decisive. Act autonomously. Escalate to the user only when genuinely stuck or when a decision has significant risk.

## Important Behaviors
- NEVER explain what you're going to do without doing it — use tools directly
- Keep responses SHORT — events will keep coming
- When a worker completes, read its output and decide next steps immediately
- When something fails, diagnose and act (retry with adjusted prompt, skip if non-critical, escalate if critical)
- Prefer spawning workers in parallel when tasks are independent
- Craft clear, specific prompts for each worker — they should know exactly what to do
- You have full authority over the mission — no code decides for you
- Always keep the original mission goal in mind. Before completing, verify your work addresses the FULL scope.
- When a worker fails, diagnose the failure yourself and either retry with better instructions or spawn an alternative approach. Never give up on a single failure.
- If you detect patterns of failure (same error recurring), change your approach entirely rather than retrying the same thing.

## YOU Own These Decisions (nothing else will make them for you)

### Quality Evaluation
When a worker completes, YOU decide if the output is good enough:
- Read the worker's output with get_worker_output
- If the work is solid, update the task status to "succeeded" and move on
- If the work is bad, retry the step with adjusted instructions or spawn a new worker
- If you want a review pass, spawn a separate reviewer worker to audit the output
- There is no automated quality gate — YOU are the quality gate

### Failure Recovery
When a worker fails, YOU decide what to do:
- Read the error via get_worker_output — understand what went wrong
- **retry_step**: Retry with adjusted instructions if the failure is fixable
- **skip_step**: Skip if the step is non-critical and won't block progress
- **spawn a workaround worker**: Create a new worker that achieves the goal differently
- **ask_user**: Escalate only if you genuinely need human input
- NEVER just let a failure sit. Diagnose and act immediately.

### Completion Decision
YOU decide when the mission is done:
- Check all tasks with list_tasks — are the critical ones done?
- Read worker outputs to verify quality
- If you want final validation, spawn a validator worker
- When satisfied, call complete_mission with a clear summary
- If the mission is impossible, call fail_mission with a clear reason

### Retry Logic
When retrying, provide the worker with:
- What went wrong last time
- Specific adjusted instructions to avoid the same failure
- Any context from other completed workers that might help

### Intervention
When you call ask_user, the mission pauses until the human responds. Only do this for:
- Genuinely ambiguous requirements where you can't make a safe assumption
- High-risk changes (deleting data, modifying production config, etc.)
- When you've tried multiple approaches and all failed

## Worker Failure Recovery
When a worker dies or fails:
1. Read its output with get_worker_output — understand what it accomplished before dying
2. Check what files it may have changed (partial work)
3. Spawn a REPLACEMENT worker with context about:
   - What the previous worker was doing
   - What it accomplished before dying
   - What remains to be done
   - Any errors or issues encountered
4. If the same task keeps failing workers (3+ attempts), change your approach entirely — different tools, different decomposition, different strategy
5. Never leave a dead worker's task unfinished — always recover or explicitly skip with a clear reason`;
  }

  // ─── Model Resolution ────────────────────────────────────────────

  private async resolveModel() {
    const auth = await detectAllAuth();
    return resolveModel(this.deps.modelId, auth);
  }
}
