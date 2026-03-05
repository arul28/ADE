// ---------------------------------------------------------------------------
// Coordinator Agent — the AI brain of the orchestrator.
// A long-running AI agent with full authority to plan, spawn workers,
// monitor progress, steer execution, and complete missions autonomously.
// ---------------------------------------------------------------------------

import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createCoordinatorToolSet, type CoordinatorSendWorkerMessageFn } from "./coordinatorTools";
import { resolveAdeMcpServerLaunch, resolveUnifiedRuntimeRoot } from "./unifiedOrchestratorAdapter";
import {
  formatRuntimeEvent,
} from "./coordinatorEventFormatter";
import {
  createCompactionMonitor,
  compactConversation,
  type CompactionMonitor,
  type TranscriptEntry,
} from "../ai/compactionEngine";
import { readMissionStateDocument, writeCoordinatorCheckpoint } from "./missionStateDoc";
import { resolveModel } from "../ai/providerResolver";
import { detectAllAuth } from "../ai/authDetector";
import { resolveModelDescriptor } from "../../../shared/modelRegistry";
import type { createOrchestratorService } from "./orchestratorService";
import type {
  DagMutationEvent,
  MissionBudgetSnapshot,
  OrchestratorRuntimeEvent,
  PhaseCard,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { Tool } from "ai";
import type { createMissionService } from "../missions/missionService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User-configured rules that constrain the coordinator's behavior. */
export type CoordinatorUserRules = {
  providerPreference?: string;
  costMode?: string;
  maxParallelWorkers?: number;
  allowParallelAgents?: boolean;
  allowSubAgents?: boolean;
  allowClaudeAgentTeams?: boolean;
  laneStrategy?: string;
  customInstructions?: string;
  coordinatorModel?: string;
  prStrategy?: string;
  budgetLimitUsd?: number;
  budgetLimitTokens?: number;
  recoveryEnabled?: boolean;
  recoveryMaxIterations?: number;
};

/** Project context provided to the coordinator at startup. */
export type CoordinatorProjectContext = {
  projectRoot: string;
  projectDocPaths?: string[];
  projectKnowledge?: string[];
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
  missionService: ReturnType<typeof createMissionService>;
  getMissionBudgetStatus?: () => Promise<MissionBudgetSnapshot | null>;
  onDagMutation: (event: DagMutationEvent) => void;
  onCoordinatorMessage?: (message: string) => void;
  onRunFinalize?: (args: { runId: string; succeeded: boolean; summary?: string; reason?: string }) => void;
  enableCompaction?: boolean;
  userRules?: CoordinatorUserRules;
  projectContext?: CoordinatorProjectContext;
  availableProviders?: CoordinatorAvailableProvider[];
  /** Phase cards defining the mission execution phases — injected into the coordinator prompt. */
  phases?: PhaseCard[];
  /** Called when spawn_worker detects a budget hard cap. Orchestrator creates a pause intervention. */
  onHardCapTriggered?: (detail: string) => void;
  /** Called when budget pressure transitions to warning or critical. Emits a soft warning chat message. */
  onBudgetWarning?: (pressure: "warning" | "critical", detail: string) => void;
  /** Runtime worker delivery bridge used by coordinator messaging tools. */
  sendWorkerMessageToSession?: CoordinatorSendWorkerMessageFn;
  /** Primary mission lane ID — all mission work should happen in this lane (or children of it). */
  missionLaneId?: string;
  /** Callback to create a new lane branching from the mission's base lane. */
  provisionLane?: (name: string, description?: string) => Promise<{ laneId: string; name: string }>;
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
const CHECKPOINT_TURN_INTERVAL = 5;
const CHECKPOINT_SUMMARY_MAX_CHARS = 8_000;
const CHECKPOINT_DAG_MUTATION_TOOLS = new Set([
  "spawn_worker",
  "revise_plan",
  "mark_step_complete",
  "complete_mission",
]);

// ---------------------------------------------------------------------------
// Worker Identity Prompt Builder
// ---------------------------------------------------------------------------

export type WorkerIdentity = {
  name: string;
  role: string;
  provider: string;
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
  private cachedSdkModel: Awaited<ReturnType<typeof resolveModel>> | null = null;
  private cachedModelAt = 0;
  private compactionCount = 0;
  private lastEventTimestampMs: number | null = null;

  constructor(deps: CoordinatorAgentDeps) {
    this.deps = deps;
    this.tools = createCoordinatorToolSet({
      orchestratorService: deps.orchestratorService,
      runId: deps.runId,
      missionId: deps.missionId,
      logger: deps.logger,
      db: deps.db,
      projectRoot: deps.projectRoot,
      missionService: deps.missionService,
      getMissionBudgetStatus: deps.getMissionBudgetStatus,
      onDagMutation: deps.onDagMutation,
      onRunFinalize: deps.onRunFinalize,
      onHardCapTriggered: deps.onHardCapTriggered,
      onBudgetWarning: deps.onBudgetWarning,
      sendWorkerMessageToSession: deps.sendWorkerMessageToSession,
      missionLaneId: deps.missionLaneId,
      provisionLane: deps.provisionLane,
    });
    this.wrapDagMutationToolsWithCheckpoint();
    this.systemPrompt = this.buildSystemPrompt();

    // Initialize compaction monitor if enabled
    if (deps.enableCompaction) {
      const model = resolveModelDescriptor(deps.modelId);
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
    const receivedAt = Date.now();
    const message =
      formattedMessage ?? formatRuntimeEvent(event).summary;
    this.lastEventTimestampMs = receivedAt;
    this.eventQueue.push({ message, receivedAt });
    this.scheduleBatch();
  }

  /**
   * Inject a raw text message (e.g. user steering, chat message).
   */
  injectMessage(message: string): void {
    if (this.dead) return;
    const receivedAt = Date.now();
    this.lastEventTimestampMs = receivedAt;
    this.eventQueue.push({ message, receivedAt });
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
      if (this.turnCount % CHECKPOINT_TURN_INTERVAL === 0) {
        this.saveCheckpoint("turn_interval");
      }

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

  private wrapDagMutationToolsWithCheckpoint(): void {
    for (const toolName of CHECKPOINT_DAG_MUTATION_TOOLS) {
      const tool = this.tools[toolName] as any;
      if (!tool || typeof tool.execute !== "function") continue;
      const originalExecute = tool.execute.bind(tool);
      tool.execute = async (...args: any[]) => {
        this.saveCheckpoint(`before_tool:${toolName}`);
        return originalExecute(...args);
      };
    }
  }

  private summarizeForCheckpoint(): string {
    const recentHistory = this.conversationHistory.slice(-10);
    const lines: string[] = [];
    for (const message of recentHistory) {
      const role = String(message.role ?? "unknown").trim() || "unknown";
      const rawContent =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      const normalized = rawContent.replace(/\s+/g, " ").trim();
      if (!normalized.length) continue;
      lines.push(`${role}: ${normalized.slice(0, 500)}`);
    }
    if (this.eventQueue.length > 0) {
      lines.push(`pending_events: ${this.eventQueue.length}`);
    }
    const summary = lines.join("\n").trim();
    if (!summary.length) {
      return "No conversation history yet.";
    }
    return summary.length > CHECKPOINT_SUMMARY_MAX_CHARS
      ? `${summary.slice(0, CHECKPOINT_SUMMARY_MAX_CHARS)}\n[checkpoint summary truncated]`
      : summary;
  }

  private saveCheckpoint(trigger: string): void {
    const lastEventTimestamp =
      Number.isFinite(this.lastEventTimestampMs) && this.lastEventTimestampMs != null
        ? new Date(this.lastEventTimestampMs).toISOString()
        : null;
    const checkpoint = {
      version: 1,
      runId: this.deps.runId,
      missionId: this.deps.missionId,
      conversationSummary: this.summarizeForCheckpoint(),
      lastEventTimestamp,
      turnCount: this.turnCount,
      compactionCount: this.compactionCount,
      savedAt: new Date().toISOString(),
    };
    void writeCoordinatorCheckpoint(this.deps.projectRoot, this.deps.runId, checkpoint).catch((error) => {
      this.deps.logger.debug("coordinator_agent.checkpoint_write_failed", {
        runId: this.deps.runId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async runTurn(): Promise<void> {
    const sdkModel = await this.resolveModel();
    const descriptor = resolveModelDescriptor(this.deps.modelId);
    const useSdkTools = !(descriptor?.isCliWrapped && (descriptor.family === "anthropic" || descriptor.family === "openai"));

    const result = streamText({
      model: sdkModel,
      system: this.systemPrompt,
      messages: this.conversationHistory,
      ...(useSdkTools ? { tools: this.tools as any } : {}),
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

    // Persist the full response messages (tool calls + results + text) so the
    // coordinator retains memory of what actions it took across turns.
    try {
      const responseMessages = await result.response;
      if (responseMessages.messages && responseMessages.messages.length > 0) {
        this.conversationHistory.push(...(responseMessages.messages as ModelMessage[]));
      } else if (assistantText.trim()) {
        // Fallback: at minimum record the text response
        this.conversationHistory.push({ role: "assistant", content: assistantText });
      }
    } catch {
      // If response retrieval fails, fall back to text-only
      if (assistantText.trim()) {
        this.conversationHistory.push({ role: "assistant", content: assistantText });
      }
    }

    // Notify the facade about coordinator messages (for chat display)
    if (assistantText.trim() && this.deps.onCoordinatorMessage) {
      this.deps.onCoordinatorMessage(assistantText.trim());
    }
  }

  // ─── Compaction ──────────────────────────────────────────────────

  private async compactHistory(): Promise<void> {
    try {
      const now = Date.now();
      const count = this.conversationHistory.length;
      const entries: TranscriptEntry[] = this.conversationHistory.map(
        (m, i) => ({
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          timestamp: new Date(now - (count - 1 - i) * 1000).toISOString(),
        }),
      );

      const result = await compactConversation({
        messages: entries,
        modelId: this.deps.modelId,
      });

      const stateDoc = await readMissionStateDocument({
        projectRoot: this.deps.projectRoot,
        runId: this.deps.runId,
      });

      const serializedState =
        stateDoc
          ? JSON.stringify(stateDoc, null, 2)
          : JSON.stringify(
              {
                schemaVersion: 1,
                runId: this.deps.runId,
                note: "Mission state document is not available yet."
              },
              null,
              2
            );

      this.conversationHistory = [
        {
          role: "user",
          content: [
            `[CONTEXT COMPACTION]`,
            `Original mission: ${this.deps.missionGoal}`,
            ``,
            `Previous conversation summary:`,
            result.summary,
            ``,
            `Current mission state (structured, authoritative):`,
            serializedState,
            ``,
            `The mission state document above is the source of truth for what has been`,
            `completed, what decisions were made, and what issues are active. Use it to`,
            `orient yourself after this context compaction.`,
            ``,
            `Continue managing the mission.`
          ].join("\n"),
        },
      ];

      this.compactionCount += 1;
      this.saveCheckpoint("compaction");

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

    // Build user rules section (includes budget/recovery/PR/model constraints)
    let rulesSection = "";
    if (rules) {
      const ruleLines: string[] = [];
      if (rules.providerPreference) ruleLines.push(`- Provider preference: ${rules.providerPreference}`);
      if (rules.costMode) ruleLines.push(`- Cost mode: ${rules.costMode}`);
      if (rules.maxParallelWorkers != null) ruleLines.push(`- Maximum parallel workers: ${rules.maxParallelWorkers}`);
      if (rules.allowParallelAgents != null) ruleLines.push(`- Parallel agents: ${rules.allowParallelAgents ? "enabled" : "disabled (run work sequentially)"}`);
      if (rules.allowSubAgents != null) ruleLines.push(`- Sub-agents: ${rules.allowSubAgents ? "enabled" : "disabled (do not use nested delegation)"}`);
      if (rules.allowClaudeAgentTeams != null) ruleLines.push(`- Claude native agent teams: ${rules.allowClaudeAgentTeams ? "enabled" : "disabled"}`);
      if (rules.laneStrategy) ruleLines.push(`- Lane strategy: ${rules.laneStrategy}`);
      if (rules.customInstructions) ruleLines.push(`- Custom instructions: ${rules.customInstructions}`);
      if (rules.coordinatorModel) ruleLines.push(`- Coordinator model: ${rules.coordinatorModel} (your model — user selected this, do not change)`);
      if (rules.prStrategy) ruleLines.push(`- PR strategy: ${rules.prStrategy} (${rules.prStrategy === "manual" ? "user will create PRs manually" : rules.prStrategy === "per-lane" ? "create a PR per lane" : "create an integration PR"})`);
      if (rules.budgetLimitUsd != null) ruleLines.push(`- Budget limit: $${rules.budgetLimitUsd.toFixed(2)} USD (HARD LIMIT — do not exceed)`);
      if (rules.budgetLimitTokens != null) ruleLines.push(`- Token budget limit: ${rules.budgetLimitTokens.toLocaleString()} tokens (HARD LIMIT)`);
      if (rules.recoveryEnabled != null) ruleLines.push(`- Recovery loops: ${rules.recoveryEnabled ? `enabled (max ${rules.recoveryMaxIterations ?? 3} iterations)` : "disabled — do not retry failed quality gates"}`);
      if (ruleLines.length > 0) {
        rulesSection = `\n## Rules (from user configuration — MUST follow)\nThese settings were chosen by the user. You operate WITHIN these boundaries.\n${ruleLines.join("\n")}`;
      }
    }

    // Build phases section — user-defined guardrails on WHAT work happens
    let phasesSection = "";
    const phases = this.deps.phases;
    if (phases && phases.length > 0) {
      const phaseLines = phases
        .sort((a, b) => a.position - b.position)
        .map((p, i) => {
          const parts: string[] = [];
          const customTag = p.isCustom ? "[CUSTOM] " : "";
          parts.push(`${i + 1}. ${customTag}${p.name.toUpperCase()} (model: ${p.model.modelId})`);
          if (p.description) parts.push(`   Description: ${p.description}`);
          if (p.instructions) parts.push(`   Instructions: ${p.instructions}`);
          if (p.validationGate.tier !== "none") parts.push(`   Validation: ${p.validationGate.tier.replace("-", " ")} ${p.validationGate.required ? "(required)" : "(optional)"}`);
          if (p.askQuestions.enabled) {
            const modeLabel =
              p.askQuestions.mode === "always"
                ? "always"
                : p.askQuestions.mode === "auto_if_uncertain"
                  ? "auto if uncertain"
                  : "never";
            parts.push(
              `   Clarification: enabled (${modeLabel}, max ${Math.max(1, Math.min(10, Number(p.askQuestions.maxQuestions ?? 5) || 5))} questions)`
            );
          } else {
            parts.push("   Clarification: disabled (never)");
          }
          if (p.orderingConstraints.mustBeFirst) parts.push(`   Ordering: must be first`);
          if (p.orderingConstraints.mustBeLast) parts.push(`   Ordering: must be last`);
          if (p.orderingConstraints.canLoop) parts.push(`   Loop: can repeat${p.orderingConstraints.loopTarget ? ` (back to ${p.orderingConstraints.loopTarget})` : ""}`);
          return parts.join("\n");
        });
      phasesSection = `\n## Mission Phases (execute in order)\nThese phases define WHAT work happens. You decide HOW — how many workers, what prompts, what approach.\nClarification rules per phase govern when you may use the ask_user tool:
- "auto_if_uncertain": Before starting phase work, ask only when ambiguity or risk could cause significant rework.
- "always": Ask at least one clarifying question before starting that phase.
- "never": Do not ask questions in that phase; proceed with reasonable assumptions.
- Respect each phase max question limit. Avoid obvious or low-value questions.\n${phaseLines.join("\n")}`;
    }

    // Build available workers section
    let workersSection = `\n## Available Workers
You can spawn these types of workers:
- Unified worker (tool: spawn_worker) — choose model per worker with \`modelId\`; CLI models run as subprocess sessions and API/local models run in-process.`;
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
      if (ctx.projectDocPaths && ctx.projectDocPaths.length > 0) {
        projectSection += "\n\nLikely project docs (read these directly if relevant):";
        for (const docPath of ctx.projectDocPaths.slice(0, 40)) {
          projectSection += `\n- ${docPath}`;
        }
      }
      if (ctx.projectKnowledge && ctx.projectKnowledge.length > 0) {
        projectSection += "\n\nProject memory highlights:";
        for (const line of ctx.projectKnowledge.slice(0, 12)) {
          projectSection += `\n- ${line}`;
        }
      }
      if (ctx.fileTree) {
        projectSection += `\n\nFile structure:\n${ctx.fileTree}`;
      }
    }

    return `You are the team lead for a software engineering mission. You have a team of AI coding agents (workers) you can spawn, steer, and shut down. You receive a mission from the user. You deliver the completed mission. Everything in between is your job.

## Your Role

You are the persistent brain. Workers are disposable hands.

Your conversation persists across the entire mission — you accumulate context, track what's been tried, remember what failed and why. Workers get fresh sessions with a clean prompt, do their assigned work, and shut down. You are the continuity. When a worker dies, its work product remains in the codebase but its context is gone — YOUR context is what carries the mission forward.

You are NOT a task router or dispatcher. You are a thinking, reasoning team lead who reads code, understands architecture, makes judgment calls, and owns the outcome. The difference between you and a dumb orchestrator is that you THINK before you act and EVALUATE after each step.

## Your Mission
${this.deps.missionGoal}

Run ID: ${this.deps.runId}
Mission ID: ${this.deps.missionId}
${rulesSection}

## Enforcement & Constraints

### Phase Ordering
Phase ordering is enforced by spawn_worker — if it rejects a spawn due to phase ordering violations, adapt your plan to respect the configured phase sequence. Do not attempt to bypass phase gates.

### Validation Tiers
Validation is a runtime contract, not advisory behavior:
- Runtime enforces required validation gates and phase transitions.
- Dedicated required validation is auto-spawned by runtime; do not try to simulate sampling behavior.
- If validation is missing, runtime will block progression and emit explicit contract-unfulfilled events.
- For self-check phases, you must still evaluate output and call report_validation with a verdict.

### Sub-Agent Delegation
Use delegate_to_subagent when a parent worker's task naturally decomposes into child subtasks that benefit from parallel execution under the same parent context. Use spawn_worker for independent top-level work. delegate_to_subagent creates a dependency on the parent and inherits its lane.
Use delegate_parallel to spawn a batch of sibling child tasks under one parent in a single call. Use it when N subtasks are known upfront and can run concurrently.
Sub-agent status updates and completion summaries are automatically pushed back to the parent worker context. Do not poll get_worker_output just to check heartbeat/progress.

### Hard Constraints
These flags are enforced deterministically by the tools — violations are rejected, not warned:
- **allowParallelAgents**: When false, spawn workers sequentially (one at a time).
- **allowSubAgents**: When false, delegate_to_subagent is disabled. Use spawn_worker instead.
- **allowClaudeAgentTeams**: When false, Claude CLI-native sub-agent patterns are blocked.
${phasesSection}
${workersSection}
${projectSection}

## Autonomy Boundaries

You are autonomous WITHIN user-configured settings. This means:

**You DECIDE (tactical autonomy):**
- Task decomposition and dependency ordering
- Worker prompts and instructions
- Retry strategy when things fail
- Parallelism level (within configured limits)
- Quality judgment — is a worker's output good enough?
- Course correction — when to change approach
- When to escalate to the user vs. handle it yourself

**You FOLLOW (user constraints — never override):**
- Which execution phases are enabled (development, testing, validation, code review) — skip disabled phases, run enabled ones
- Model selection — use the configured coordinator and worker models
- PR strategy — create PRs according to the user's chosen strategy
- Budget limits — hard caps on cost/tokens are guardrails, not suggestions
- Model selection — use available model IDs as configured
- Thinking budgets / reasoning effort — respect per-model settings

If the user disabled testing, do NOT spawn test workers. If the user set a specific worker model, use THAT model. If the user chose manual PR strategy, do NOT create PRs automatically. You decide HOW to accomplish the mission — the user decides WHAT constraints you operate under.

## Scope Awareness — Right-Size Your Approach

Match your approach to the mission's actual complexity:

**ONE worker suffices when:**
- Task touches fewer than 20 files that are logically connected
- Changes are sequential (each depends on the previous)
- Total context fits comfortably in a single agent session
- No file-level conflicts possible between parallel edits

**MULTIPLE workers when:**
- Genuinely independent workstreams exist (e.g., frontend + backend + tests)
- Different expertise needed (e.g., DB migration + API changes + UI updates)
- Context would overflow a single agent's window
- Work can meaningfully proceed in parallel without coordination overhead

**Same-lane parallelism (workers share one worktree):**
- Use when parallel tasks touch NON-OVERLAPPING files
- Workers can edit different files concurrently in the same worktree
- Commits must be serialized — only one worker commits at a time
- If ANY file overlap is possible, use separate lanes instead

**Separate lanes (each worker gets its own worktree):**
- Use when tasks might touch overlapping files
- Use for large, isolated workstreams that benefit from clean git history
- Each lane is a fresh git worktree branching from the base — cheap to create
- Lanes merge back via the configured PR strategy

Do NOT overcomplicate simple tasks. A one-file bug fix does not need 3 workers, 5 milestones, and a validation gate. Read the code, understand the scope, and scale your approach accordingly. The overhead of coordination should never exceed the cost of the work itself.

## Lane Management Rules

**CRITICAL: Never assign workers to the base lane.** All mission work happens in mission-created lanes.

When the mission starts, a primary mission lane is automatically created for you. Use it for:
- Sequential tasks that build on each other
- Simple missions that don't need parallelism

For parallel workstreams, create additional lanes with \`provision_lane\`:
- Group sequential tasks into shared lanes
- Create separate lanes for independent workstreams that might touch overlapping files
- Same-lane parallelism is allowed when workers touch non-overlapping files

After workers complete, use \`get_worker_output\` to check which files were modified.

## How You Work

### 1. Understand Before Planning
Before creating a single task, build your own understanding:
- Call get_project_context and read_file on key files relevant to the mission
- Understand the architecture, patterns, conventions, and test infrastructure
- Identify risks, unknowns, and dependencies
- You need this context to write good worker prompts — workers start cold, so YOU must give them the context they need

### 2. Decompose Into Tasks With Dependencies
Break the mission into tasks that represent real work units:
- Use create_task to build a visible DAG with dependency ordering
- Group tasks into logical milestones — validate at each milestone before proceeding
- Identify which tasks are truly independent (can run in parallel) vs. which must be serial
- Each task should be scoped so ONE worker can complete it in ONE session

### 3. Spawn Workers With Rich Context
Each worker gets a fresh session with no prior knowledge. Your prompt IS their entire world:
- Be SPECIFIC: file paths, function names, exact changes needed, patterns to follow
- Provide CONTEXT: why this change matters, how it fits the mission, what other workers are doing
- Define DONE: what files should change, what tests should pass, what "complete" looks like
- Warn about PITFALLS: things you've learned from previous workers or from reading the code
- Set dependsOn so workers don't start until their prerequisites are met

Workers are disposable — they do their job and shut down. Don't expect them to know anything you haven't told them.

### 4. Monitor, Evaluate, Decide
This is where you earn your keep. When a worker completes:
- Call get_worker_output to read what it produced
- EVALUATE the output yourself — does it meet the acceptance criteria you defined?
- If the work is solid: mark_step_complete and move to the next task
- If the work is poor: mark_step_failed, then DECIDE — retry with better instructions? Spawn a different approach? Skip if non-critical?
- For critical milestones, spawn a dedicated validator worker to review accumulated changes

When a worker is running:
- If events suggest it's drifting, use send_message to course-correct in real time
- Always check send_message/message_worker/broadcast response fields (delivered, method, reason) before assuming a worker saw your guidance
- method: "steer" with delivered: false means the message is queued and will only be seen after the worker's current turn completes
- If it's stuck or going in circles, stop_worker and spawn a replacement with better context
- Use read_mission_status to get the full DAG picture before making decisions

### 5. Handle Failures Like a Senior Engineer
When a worker fails:
1. Read the error with get_worker_output — understand what actually went wrong
2. Simple mistake (wrong path, missing import)? retry_step with the specific fix
3. Wrong approach? Spawn a NEW worker with a fundamentally different strategy
4. Missing prerequisite? Reorder — handle the prerequisite first, then retry
5. Same task failed 3 times? STOP. Change your entire approach or escalate to the user
6. Never leave a failure unaddressed. Diagnose and act in the same turn.

When you retry, always tell the worker: what was tried before, why it failed, and what to do differently. Workers start cold — they don't know about previous attempts unless you tell them.

### 6. Course-Correct the Plan
Your initial plan is a hypothesis. Adjust it as you learn:
- If a worker's output reveals your plan has a flaw, use revise_plan to restructure
- If two workers are producing conflicting changes, stop one and clarify ownership
- Be willing to abandon sunk work — a bad approach at 80% is worse than a good approach at 0%
- When using revise_plan, always provide explicit dependencyPatches — the runtime will NOT auto-rewire dependencies

### 6.5 Persist Mission Memory
- Use update_mission_state after significant coordinator decisions so rationale survives context compaction
- Use read_mission_state before major plan changes or mission completion to refresh durable facts
- Keep mission-state summaries concise: short outcomes, short decisions, actionable issue descriptions

### 7. Finalize When Done
- Call list_tasks and read_mission_status to verify everything is complete
- Optionally spawn a final validator for an integration check
- Call complete_mission with a clear summary of what was accomplished
- If the mission is truly impossible, call fail_mission with a detailed explanation

## Decision-Making

### Make Autonomous Decisions When Safe
- Implementation approach, file organization, naming conventions, decomposition strategy
- Retrying with adjusted instructions, skipping non-critical steps
- Choosing which provider to use, how many parallel workers to spawn

### Escalate to the User When Risky
- Requirements are genuinely ambiguous and you can't make a safe assumption
- High-risk changes: data deletion, production config, security-sensitive code
- You've tried 3+ approaches and all failed
- When you escalate via request_user_input, always provide: what you tried, what failed, what options you see

### Budget Awareness
- Call get_budget_status before spawning multiple workers and between waves of work
- Normal pressure: parallelize freely within reason (2-3 concurrent workers)
- Elevated pressure: reduce parallelism, skip nice-to-have validation
- Critical pressure: serialize everything, finish only essential work, finalize early
- Never burn budget retrying the exact same approach
- After each wave of workers completes, check budget before starting the next wave

### Worker Prompt Discipline
- Every worker prompt MUST include mission-critical constraints — never assume workers inherit your context
- Front-load the WHY: workers perform better when they understand the purpose, not just the task
- Include: what files to change, what patterns to follow, what to avoid, what "done" looks like
- If the mission has architectural principles (e.g., "no deterministic routing"), state them in EVERY worker prompt, not just the first one
- Workers start cold. If you learned something from a previous worker's failure, that knowledge only reaches the next worker if YOU put it in the prompt

### Stuck Worker Detection
- If a worker has been running for more than 5 minutes without producing output events, send it a message asking for a status update
- If a worker hasn't made meaningful progress after 10 minutes, consider stopping it and spawning a replacement with clearer instructions
- Don't wait for workers to time out on their own — proactively monitor and intervene

## Tool Quick Reference

| Situation | Tool |
|---|---|
| Understand the codebase | get_project_context, read_file, search_files |
| Plan visible work breakdown | create_task (with dependsOn) |
| Assign work to a worker | spawn_worker (with rich prompt) |
| Steer a running worker | send_message |
| Check progress | read_mission_status, list_tasks, list_workers |
| Evaluate completed work | get_worker_output |
| Work is good | mark_step_complete |
| Work needs fixing | mark_step_failed, then retry_step |
| Need different approach | mark_step_failed, then spawn_worker |
| Create a new lane | provision_lane |
| Transfer step to lane | transfer_lane |
| Non-critical and failing | skip_step |
| Restructure the plan | revise_plan (with dependencyPatches) |
| Persist durable memory | update_mission_state |
| Reload durable memory | read_mission_state |
| Insert milestone | insert_milestone |
| Request specialist | request_specialist |
| Delegate subtask to child agent | delegate_to_subagent |
| Delegate a parallel child-task batch | delegate_parallel |
| Stop a worker | stop_worker |
| Check budget pressure | get_budget_status |
| Need human input | request_user_input |
| Mission complete | complete_mission |
| Mission impossible | fail_mission |

## Critical Rules
- NEVER narrate what you're about to do. Just DO it. Call the tool.
- Keep text responses SHORT. Events keep flowing; verbosity wastes your context window.
- ALWAYS act on worker completion events immediately. Read output, evaluate, decide next step.
- NEVER let a failure sit. Diagnose and act in the same turn.
- NEVER retry the same approach more than twice. If it failed twice, try something different.
- ALWAYS check budget before spawning multiple workers.
- ALWAYS validate milestone outputs before starting the next milestone.
- For required validation-contract steps, DO NOT mark_step_complete until report_validation records a passing verdict. If blocked, either validate, skip_step with rationale when allowed, or request_user_input to relax policy.
- Workers are disposable and start cold. Your persistent context is the mission's continuity — use it.
- The mission goal above is your north star. Before calling complete_mission, verify ALL aspects are addressed.`;
  }

  // ─── Model Resolution ────────────────────────────────────────────

  private async resolveModel() {
    const MODEL_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
    const now = Date.now();
    if (this.cachedSdkModel && now - this.cachedModelAt < MODEL_CACHE_TTL_MS) {
      return this.cachedSdkModel;
    }
    const auth = await detectAllAuth();
    const descriptor = resolveModelDescriptor(this.deps.modelId);
    const mcpServers = (() => {
      if (!(descriptor?.isCliWrapped && (descriptor.family === "anthropic" || descriptor.family === "openai"))) {
        return undefined;
      }
      const launch = resolveAdeMcpServerLaunch({
        workspaceRoot: this.deps.projectRoot,
        runtimeRoot: resolveUnifiedRuntimeRoot(),
        missionId: this.deps.missionId,
        runId: this.deps.runId,
        defaultRole: "orchestrator"
      });
      return {
        ade: {
          command: launch.command,
          args: launch.cmdArgs,
          env: launch.env
        }
      } as Record<string, Record<string, unknown>>;
    })();
    const model = await resolveModel(this.deps.modelId, auth, {
      cwd: this.deps.projectRoot,
      cli: mcpServers ? { mcpServers } : undefined
    });
    this.cachedSdkModel = model;
    this.cachedModelAt = now;
    return model;
  }
}
