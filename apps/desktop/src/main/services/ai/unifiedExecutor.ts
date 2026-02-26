// ---------------------------------------------------------------------------
// Unified Executor — single entry-point for all AI models via the AI SDK
// ---------------------------------------------------------------------------

import { streamText } from "ai";
import {
  getModelById,
} from "../../../shared/modelRegistry";
import { detectAllAuth } from "./authDetector";
import { resolveModel } from "./providerResolver";
import { createCodingToolSet } from "./tools";
import type { AgentEvent } from "./agentExecutor";

export type UnifiedExecutorOpts = {
  modelId: string;
  prompt: string;
  system?: string;
  cwd?: string;
  tools?: "coding" | "none";
  timeout?: number;
  abortSignal?: AbortSignal;
  onStepFinish?: (step: unknown) => void;
  onFinish?: (result: unknown) => void;
  reasoningEffort?: string;
  jsonSchema?: unknown;
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
  const tools =
    !model.isCliWrapped && opts.tools === "coding" && opts.cwd
      ? createCodingToolSet(opts.cwd)
      : undefined;

  const abortController = new AbortController();
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => abortController.abort());
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeout) {
    timeoutHandle = setTimeout(() => abortController.abort(), opts.timeout);
  }

  try {
    const result = streamText({
      model: sdkModel,
      system: opts.system,
      prompt: opts.prompt,
      tools: tools as any,
      abortSignal: abortController.signal,
    });

    let finalText = "";

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        finalText += part.text;
        yield { type: "text", content: part.text };
      } else if (part.type === "tool-call") {
        yield {
          type: "tool_call",
          name: part.toolName,
          args: part.input,
        };
      } else if (part.type === "tool-result") {
        yield {
          type: "tool_result",
          name: part.toolName,
          result: part.output,
        };
      } else if (part.type === "error") {
        yield { type: "error", message: String(part.error) };
      } else if (part.type === "finish") {
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
            inputTokens: part.totalUsage?.inputTokens ?? null,
            outputTokens: part.totalUsage?.outputTokens ?? null,
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
