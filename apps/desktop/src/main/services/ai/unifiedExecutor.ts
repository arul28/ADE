// ---------------------------------------------------------------------------
// Unified Executor — single entry-point for all AI models via the AI SDK
// ---------------------------------------------------------------------------

import { streamText, type Tool } from "ai";
import {
  getModelById,
} from "../../../shared/modelRegistry";
import { detectAllAuth } from "./authDetector";
import { resolveModel } from "./providerResolver";
import { createCodingToolSet } from "./tools";
import type { AgentEvent } from "./agentExecutor";
import {
  createCompactionMonitor,
  compactConversation,
  preCompactionWriteback,
  appendTranscriptEntry,
  getTranscript,
  markTranscriptCompacted,
  type TranscriptEntry,
  type CompactionMonitor,
} from "./compactionEngine";
import type { AdeDb } from "../state/kvDb";

export type PendingMessage = {
  id: string;
  content: string;
  fromAttemptId: string | null;
  priority: "normal" | "urgent";
  receivedAt: string;
};

/** Per-session queue of messages waiting to be injected into a running agent. */
const sessionPendingMessages = new Map<string, PendingMessage[]>();

export function enqueuePendingMessage(sessionId: string, msg: PendingMessage): void {
  const queue = sessionPendingMessages.get(sessionId) ?? [];
  // Urgent messages go to the front
  if (msg.priority === "urgent") {
    queue.unshift(msg);
  } else {
    queue.push(msg);
  }
  sessionPendingMessages.set(sessionId, queue);
}

export function drainPendingMessages(sessionId: string): PendingMessage[] {
  const queue = sessionPendingMessages.get(sessionId);
  if (!queue || queue.length === 0) return [];
  sessionPendingMessages.delete(sessionId);
  return queue;
}

export function getPendingMessageCount(sessionId: string): number {
  return sessionPendingMessages.get(sessionId)?.length ?? 0;
}

export type UnifiedExecutorOpts = {
  modelId: string;
  prompt: string;
  system?: string;
  cwd?: string;
  tools?: "coding" | "none" | Record<string, Tool>;
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
  addSharedFact?: (opts: {
    runId: string;
    stepId?: string;
    factType: "api_pattern" | "schema_change" | "config" | "architectural" | "gotcha";
    content: string;
  }) => unknown;
  /** Optional memory service for wiring memory tools into the coding tool set. */
  memoryService?: unknown;
};

export type UnifiedResumeOpts = UnifiedExecutorOpts & {
  previousAttemptId: string;
};

export async function* executeUnified(
  opts: UnifiedExecutorOpts,
): AsyncGenerator<AgentEvent> {
  const model = getModelById(opts.modelId);
  if (!model) {
    yield { type: "error", message: `Unknown model: ${opts.modelId}` };
    return;
  }

  const auth = await detectAllAuth();
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
  const tools =
    typeof opts.tools === "object"
      ? opts.tools
      : (!model.isCliWrapped && opts.tools === "coding" && opts.cwd
          ? createCodingToolSet(opts.cwd, {
              memoryService: opts.memoryService as any,
              projectId: opts.projectId,
            })
          : undefined);

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

  try {
    const result = streamText({
      model: sdkModel,
      system: opts.system,
      prompt: opts.prompt,
      tools: tools as any,
      abortSignal: abortController.signal,
    });

    let finalText = "";

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
      if (part.type === "text-delta") {
        finalText += part.text;
        yield { type: "text", content: part.text };
      } else if (part.type === "tool-call") {
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
              const transcript = getTranscript(opts.db, opts.attemptId);
              if (transcript) {
                const messages: TranscriptEntry[] = JSON.parse(transcript.messagesJson);
                const compactionResult = await compactConversation({
                  messages,
                  modelId: opts.modelId,
                });

                // Pre-compaction writeback: save extracted facts
                if (compactionResult.factsExtracted.length > 0 && opts.addSharedFact) {
                  await preCompactionWriteback({
                    db: opts.db,
                    runId: opts.runId!,
                    stepId: opts.stepId!,
                    facts: compactionResult.factsExtracted,
                    addSharedFact: opts.addSharedFact,
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
