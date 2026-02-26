// ---------------------------------------------------------------------------
// Coordinator Agent — unified persistent multi-turn AI session that reacts
// to runtime events using tools, replacing the 8-specialist-call pattern.
// ---------------------------------------------------------------------------

import { streamText } from "ai";
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
  enableCompaction?: boolean;
};

type QueuedEvent = {
  message: string;
  receivedAt: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_DELAY_MS = 200;
const MAX_STEPS_PER_TURN = 10;
const COMPACTION_THRESHOLD_RATIO = 0.65;
const MAX_CONVERSATION_HISTORY = 100;

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
      onDagMutation: deps.onDagMutation,
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
    try {
      // Drain all queued events into one combined message
      const events = this.eventQueue.splice(0);
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

      // Replace conversation history with compacted summary
      this.conversationHistory = [
        {
          role: "user",
          content: `[CONTEXT COMPACTION]\nPrevious conversation summary:\n${result.summary}\n\nContinue monitoring mission events.`,
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
    return `You are the mission coordinator for ADE (Autonomous Development Environment).

## Your Role
You are a persistent, reactive coordinator managing a software engineering mission. You receive events about agent progress and use tools to manage the mission DAG.

## Mission
Goal: ${this.deps.missionGoal}
Run ID: ${this.deps.runId}
Mission ID: ${this.deps.missionId}

## Behavior
- You are REACTIVE: you receive events and decide what to do
- For each event, decide: do nothing, spawn agents, steer agents, modify the plan, or escalate to the user
- Be concise in your reasoning — focus on ACTION
- Use tools to act, don't just describe what you would do
- When a step completes successfully and the next step is ready, spawn its agent
- When a step fails, diagnose whether to retry (with adjusted instructions), skip, or escalate
- When you detect scope changes or new requirements from agent output, use add_step/skip_step/split_step to adapt the plan
- Prefer autonomous action when safe; escalate (ask_user) when risky

## Decision Framework
1. Step succeeded -> Check if dependent steps are ready -> spawn_agent for ready steps
2. Step failed (retriable) -> Analyze error -> steer_agent with fix guidance OR let retry happen
3. Step failed (terminal) -> Diagnose -> skip_step if non-critical, ask_user if critical
4. Agent stuck/slow -> steer_agent with guidance or stop_agent and retry
5. New information from agent output -> add_step/skip_step to adapt plan
6. All steps done -> Verify completeness via get_run_state

## Important
- NEVER explain what you're going to do without doing it — use tools directly
- Keep responses SHORT — the events will keep coming
- You have full authority over the mission DAG`;
  }

  // ─── Model Resolution ────────────────────────────────────────────

  private async resolveModel() {
    const auth = await detectAllAuth();
    return resolveModel(this.deps.modelId, auth);
  }
}
