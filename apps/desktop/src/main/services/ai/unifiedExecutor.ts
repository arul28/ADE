// ---------------------------------------------------------------------------
// Unified Executor — single entry-point for all AI models via the AI SDK
// ---------------------------------------------------------------------------

import { streamText, stepCountIs, type Tool } from "ai";
import {
  getModelById,
} from "../../../shared/modelRegistry";
import { detectAllAuth } from "./authDetector";
import { resolveModel } from "./providerResolver";
import { createCodingToolSet, createUniversalToolSet } from "./tools";
import { createMemoryTools } from "./tools/memoryTools";
import { buildCodingAgentSystemPrompt, composeSystemPrompt } from "./tools/systemPrompt";
import type { AgentEvent } from "./agentExecutor";
import {
  createCompactionMonitor,
  compactConversation,
  preCompactionWriteback,
  appendTranscriptEntry,
  getTranscript,
  getTranscriptRecord,
  markTranscriptCompacted,
  type TranscriptEntry,
  type CompactionMonitor,
} from "./compactionEngine";
import type { AdeDb } from "../state/kvDb";
import type { CompactionFlushService } from "../memory/compactionFlushService";
import type { DetectedAuth } from "./authDetector";

export type UnifiedExecutorOpts = {
  modelId: string;
  prompt: string;
  system?: string;
  cwd?: string;
  tools?: "coding" | "planning" | "none" | Record<string, Tool>;
  timeout?: number;
  abortSignal?: AbortSignal;
  onStepFinish?: (step: unknown) => void;
  onFinish?: (result: unknown) => void;
  reasoningEffort?: string;
  jsonSchema?: unknown;
  // Compaction support — optional, only active when db + identifiers are provided
  db?: AdeDb;
  projectId?: string;
  attemptId?: string;
  runId?: string;
  stepId?: string;
  enableCompaction?: boolean;
  /** Optional memory service for wiring memory tools into the coding tool set. */
  memoryService?: unknown;
  compactionFlushService?: Pick<CompactionFlushService, "beforeCompaction">;
  auth?: DetectedAuth[];
};

export type UnifiedResumeOpts = UnifiedExecutorOpts & {
  previousAttemptId: string;
};

function buildConversationText(messages: TranscriptEntry[]): string {
  return messages
    .map((message) => `[${message.role}${message.toolName ? ` (${message.toolName})` : ""}]: ${message.content}`)
    .join("\n\n");
}

export async function* executeUnified(
  opts: UnifiedExecutorOpts,
): AsyncGenerator<AgentEvent> {
  const model = getModelById(opts.modelId);
  if (!model) {
    yield { type: "error", message: `Unknown model: ${opts.modelId}` };
    return;
  }

  const auth = opts.auth ?? await detectAllAuth();
  let sdkModel;
  try {
    sdkModel = await resolveModel(opts.modelId, auth);
  } catch (err) {
    yield {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    return;
  }

  // For CLI-wrapped models, tools are managed by the CLI itself.
  // For API-key models, we provide tools when requested.
  // If tools is already a Record<string, CoreTool>, use it directly.
  const PLANNING_TOOL_ALLOWLIST = new Set([
    "readFile", "grep", "glob", "listDir", "gitStatus", "gitDiff", "gitLog",
  ]);

  let tools: Record<string, Tool> | undefined;
  if (typeof opts.tools === "object") {
    tools = opts.tools;
  } else if (!model.isCliWrapped && opts.tools === "planning" && opts.cwd) {
    // Read-only subset for the planner — no write, no bash, no web
    const full = createUniversalToolSet(opts.cwd, { permissionMode: "plan" });
    tools = Object.fromEntries(
      Object.entries(full).filter(([name]) => PLANNING_TOOL_ALLOWLIST.has(name))
    );
  } else if (!model.isCliWrapped && opts.tools === "coding" && opts.cwd) {
    tools = createCodingToolSet(opts.cwd, {
      memoryService: opts.memoryService as any,
      projectId: opts.projectId,
      runId: opts.runId,
      stepId: opts.stepId,
      agentScopeOwnerId: opts.attemptId,
    });
  }

  // Planning mode caps tool-use rounds so the planner doesn't explore forever
  const stopCondition = opts.tools === "planning" ? stepCountIs(10) : undefined;
  const harnessMode = opts.tools === "planning" ? "planning" : "coding";
  const system = composeSystemPrompt(
    opts.system,
    buildCodingAgentSystemPrompt({
      cwd: opts.cwd ?? process.cwd(),
      mode: harnessMode,
      permissionMode: opts.tools === "planning" ? "plan" : "edit",
      toolNames: Object.keys(tools ?? {}),
      interactive: false,
    }),
  );

  const abortController = new AbortController();
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => abortController.abort());
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeout) {
    timeoutHandle = setTimeout(() => abortController.abort(), opts.timeout);
  }

  // Set up compaction monitor if enabled
  const compactionEnabled = !!(opts.enableCompaction && opts.db && opts.attemptId && opts.runId && opts.stepId && opts.projectId);
  const monitor: CompactionMonitor | null = compactionEnabled
    ? createCompactionMonitor(model)
    : null;
  let compactionBoundaryIndex = 0;

  try {
    const result = streamText({
      model: sdkModel,
      system,
      prompt: opts.prompt,
      tools: tools as any,
      ...(stopCondition ? { stopWhen: stopCondition } : {}),
      abortSignal: abortController.signal,
    });

    let finalText = "";
    let streamedStepCount = 0;

    // Record the user prompt in the transcript
    if (compactionEnabled && opts.db) {
      appendTranscriptEntry(opts.db, {
        projectId: opts.projectId!,
        attemptId: opts.attemptId!,
        runId: opts.runId!,
        stepId: opts.stepId!,
        entry: {
          role: "user",
          content: opts.prompt,
          timestamp: new Date().toISOString(),
        },
      });
    }

    for await (const part of result.fullStream) {
      if (part.type === "start-step") {
        streamedStepCount += 1;
        yield {
          type: "step_boundary",
          stepNumber: streamedStepCount,
        };
      } else if (part.type === "source") {
        const sourceDetail =
          typeof part.title === "string" && part.title.trim().length
            ? part.title
            : part.sourceType === "url" && typeof part.url === "string" && part.url.trim().length
              ? part.url
              : "Gathering sources";
        yield {
          type: "activity",
          activity: "searching",
          detail: sourceDetail,
        };
      } else if (part.type === "reasoning-start" || part.type === "reasoning-delta") {
        yield {
          type: "activity",
          activity: "thinking",
          detail: "Reasoning through the next step",
        };
      } else if (part.type === "text-delta") {
        finalText += part.text;
        yield { type: "text", content: part.text };
      } else if (part.type === "tool-call") {
        yield {
          type: "activity",
          activity: "tool_calling",
          detail: part.toolName,
        };
        if (compactionEnabled && opts.db) {
          appendTranscriptEntry(opts.db, {
            projectId: opts.projectId!,
            attemptId: opts.attemptId!,
            runId: opts.runId!,
            stepId: opts.stepId!,
            entry: {
              role: "tool",
              content: `Tool call: ${part.toolName}`,
              timestamp: new Date().toISOString(),
              toolName: part.toolName,
              toolArgs: part.input,
            },
          });
        }
        yield {
          type: "tool_call",
          name: part.toolName,
          args: part.input,
        };
      } else if (part.type === "tool-result") {
        if (compactionEnabled && opts.db) {
          appendTranscriptEntry(opts.db, {
            projectId: opts.projectId!,
            attemptId: opts.attemptId!,
            runId: opts.runId!,
            stepId: opts.stepId!,
            entry: {
              role: "tool",
              content: `Tool result: ${part.toolName}`,
              timestamp: new Date().toISOString(),
              toolName: part.toolName,
              toolResult: part.output,
            },
          });
        }
        yield {
          type: "tool_result",
          name: part.toolName,
          result: part.output,
        };
      } else if (part.type === "error") {
        yield { type: "error", message: String(part.error) };
      } else if (part.type === "finish") {
        const inputTokens = part.totalUsage?.inputTokens ?? null;
        const outputTokens = part.totalUsage?.outputTokens ?? null;

        // Record assistant response in transcript
        if (compactionEnabled && opts.db && finalText.trim()) {
          appendTranscriptEntry(opts.db, {
            projectId: opts.projectId!,
            attemptId: opts.attemptId!,
            runId: opts.runId!,
            stepId: opts.stepId!,
            entry: {
              role: "assistant",
              content: finalText,
              timestamp: new Date().toISOString(),
              tokenEstimate: (inputTokens ?? 0) + (outputTokens ?? 0),
            },
          });
        }

        // Update compaction monitor and trigger compaction if needed
        if (monitor) {
          monitor.recordTokens(inputTokens ?? 0, outputTokens ?? 0);

          if (monitor.shouldCompact() && opts.db && opts.attemptId) {
            yield { type: "text", content: "\n[Compacting context...]\n" };

            try {
              const transcriptRecord = getTranscriptRecord(opts.db, opts.attemptId);
              if (transcriptRecord) {
                let messages: TranscriptEntry[] = JSON.parse(transcriptRecord.messagesJson);

                if (opts.compactionFlushService && opts.projectId && opts.memoryService) {
                  await opts.compactionFlushService.beforeCompaction({
                    sessionId: opts.attemptId,
                    boundaryId: `${opts.attemptId}:${compactionBoundaryIndex}`,
                    conversationTokenCount: transcriptRecord.tokenCount,
                    maxTokens: model.contextWindow,
                    appendHiddenMessage: async (message) => {
                      appendTranscriptEntry(opts.db!, {
                        projectId: opts.projectId!,
                        attemptId: opts.attemptId!,
                        runId: opts.runId!,
                        stepId: opts.stepId!,
                        entry: {
                          role: message.role,
                          content: message.content,
                          timestamp: new Date().toISOString(),
                          tokenEstimate: Math.ceil(message.content.length / 4),
                        },
                      });
                    },
                    flushTurn: async ({ prompt }) => {
                      const memoryTools = createMemoryTools(opts.memoryService as any, opts.projectId!, {
                        runId: opts.runId,
                        stepId: opts.stepId,
                        agentScopeOwnerId: opts.attemptId,
                      });
                      const flushSystem = composeSystemPrompt(
                        prompt,
                        buildCodingAgentSystemPrompt({
                          cwd: opts.cwd ?? process.cwd(),
                          mode: "coding",
                          permissionMode: "edit",
                          toolNames: Object.keys(memoryTools),
                          interactive: false,
                        }),
                      );

                      const flushStream = streamText({
                        model: sdkModel,
                        system: flushSystem,
                        prompt: `Review this conversation and persist any durable discoveries with memoryAdd before compaction.\n\n${buildConversationText(messages)}`,
                        tools: memoryTools as any,
                        stopWhen: stepCountIs(6),
                        abortSignal: abortController.signal,
                      });

                      let flushText = "";
                      for await (const flushPart of flushStream.fullStream) {
                        if (!flushPart || typeof flushPart !== "object") continue;
                        if (flushPart.type === "text-delta") {
                          flushText += String(flushPart.text ?? "");
                          continue;
                        }
                        if (flushPart.type === "error") {
                          throw new Error(String(flushPart.error));
                        }
                      }

                      const flushTokens = Math.ceil(flushText.length / 4);
                      return {
                        status: flushTokens > model.contextWindow ? "budget_exceeded" as const : "flushed" as const,
                      };
                    },
                  });

                  const refreshedTranscript = getTranscript(opts.db, opts.attemptId);
                  if (refreshedTranscript) {
                    messages = JSON.parse(refreshedTranscript.messagesJson);
                  }
                }

                const compactionResult = await compactConversation({
                  messages,
                  modelId: opts.modelId,
                });

                // Pre-compaction writeback: save extracted facts into mission memory.
                const missionId = opts.db && opts.runId
                  ? (opts.db.get<{ mission_id: string | null }>(
                      "select mission_id from orchestrator_runs where id = ? limit 1",
                      [opts.runId]
                    )?.mission_id ?? null)
                  : null;
                const memoryWriter = opts.memoryService as {
                  writeMemory?: (opts: {
                    projectId: string;
                    scope: "mission";
                    scopeOwnerId: string;
                    category: "fact" | "gotcha" | "preference";
                    content: string;
                    importance: "medium" | "high";
                    confidence: number;
                    status: "promoted";
                    sourceRunId: string;
                    sourceType: "system";
                    sourceId: string;
                    writeGateMode: "strict";
                  }) => unknown;
                } | null;
                if (
                  compactionResult.factsExtracted.length > 0
                  && opts.projectId
                  && opts.runId
                  && opts.stepId
                  && typeof memoryWriter?.writeMemory === "function"
                ) {
                  await preCompactionWriteback({
                    projectId: opts.projectId,
                    missionId,
                    runId: opts.runId,
                    stepId: opts.stepId,
                    facts: compactionResult.factsExtracted,
                    writeMemory: memoryWriter.writeMemory.bind(opts.memoryService),
                  });
                }

                // Replace messages with compacted summary
                const compactedMessages: TranscriptEntry[] = [{
                  role: "system",
                  content: `[Compacted context — previous ${compactionResult.previousTokenCount} tokens]\n\n${compactionResult.summary}`,
                  timestamp: new Date().toISOString(),
                  tokenEstimate: compactionResult.newTokenCount,
                }];

                markTranscriptCompacted(
                  opts.db,
                  opts.attemptId,
                  compactionResult.summary,
                  JSON.stringify(compactedMessages),
                  compactionResult.newTokenCount,
                );

                yield { type: "text", content: `[Context compacted: ${compactionResult.previousTokenCount} -> ${compactionResult.newTokenCount} tokens, ${compactionResult.factsExtracted.length} facts preserved]\n` };
              }
            } catch (compactionErr) {
              // Non-fatal — compaction failure should not abort execution
              yield { type: "text", content: `[Compaction skipped: ${compactionErr instanceof Error ? compactionErr.message : String(compactionErr)}]\n` };
            } finally {
              compactionBoundaryIndex += 1;
            }
          }
        }

        // Handle structured output if jsonSchema was provided
        if (opts.jsonSchema && finalText.trim()) {
          try {
            const parsed = JSON.parse(finalText);
            yield { type: "structured_output", data: parsed };
          } catch {
            /* not valid JSON, skip */
          }
        }

        yield {
          type: "done",
          sessionId: opts.modelId + "-" + Date.now(),
          provider: model.family as any,
          model: model.sdkModelId,
          modelId: model.id,
          usage: {
            inputTokens,
            outputTokens,
          },
        };
      }
    }
  } catch (err) {
    if (abortController.signal.aborted && opts.timeout) {
      yield {
        type: "error",
        message: `Execution timed out after ${opts.timeout}ms`,
      };
    } else {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Resume — reload previous transcript and continue execution
// ---------------------------------------------------------------------------

export async function* resumeUnified(
  opts: UnifiedResumeOpts,
): AsyncGenerator<AgentEvent> {
  if (!opts.db) {
    yield* executeUnified(opts);
    return;
  }

  const transcript = getTranscript(opts.db, opts.previousAttemptId);
  if (!transcript) {
    yield* executeUnified(opts);
    return;
  }

  // Reconstruct conversation history
  let contextPrefix: string;

  if (transcript.compactionSummary) {
    contextPrefix = `[Resuming from previous session — compacted summary]\n\n${transcript.compactionSummary}\n\n---\n\n`;
  } else {
    const previousMessages: TranscriptEntry[] = JSON.parse(transcript.messagesJson);
    const maxResumeTokens = 50_000;
    let estimatedTokens = 0;
    const relevantMessages: TranscriptEntry[] = [];

    for (let i = previousMessages.length - 1; i >= 0; i--) {
      const msg = previousMessages[i];
      const msgTokens = msg.tokenEstimate ?? Math.ceil(msg.content.length / 4);
      if (estimatedTokens + msgTokens > maxResumeTokens) break;
      relevantMessages.unshift(msg);
      estimatedTokens += msgTokens;
    }

    if (relevantMessages.length === 0) {
      yield* executeUnified(opts);
      return;
    }

    const historyText = relevantMessages
      .map((m) => `[${m.role}${m.toolName ? ` (${m.toolName})` : ""}]: ${m.content}`)
      .join("\n\n");

    contextPrefix = `[Resuming from previous session — ${relevantMessages.length} messages loaded]\n\n${historyText}\n\n---\n\n`;
  }

  yield* executeUnified({
    ...opts,
    prompt: `${contextPrefix}Continuing from previous session. New instruction:\n\n${opts.prompt}`,
    attemptId: opts.attemptId,
  });
}
