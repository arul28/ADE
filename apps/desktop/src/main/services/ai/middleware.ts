// ---------------------------------------------------------------------------
// AI SDK Middleware — logging, retry, cost guard, reasoning extraction
// ---------------------------------------------------------------------------

import {
  wrapLanguageModel,
  extractReasoningMiddleware,
  type LanguageModelMiddleware,
} from "ai";
import type { LanguageModel } from "ai";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import { MODEL_PRICING } from "../../../shared/modelProfiles";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract total input tokens from V3 usage (handles both nested and flat formats). */
function getInputTokens(usage: any): number {
  if (!usage) return 0;
  if (typeof usage.inputTokens === "number") return usage.inputTokens;
  return usage.inputTokens?.total ?? 0;
}

/** Extract total output tokens from V3 usage (handles both nested and flat formats). */
function getOutputTokens(usage: any): number {
  if (!usage) return 0;
  if (typeof usage.outputTokens === "number") return usage.outputTokens;
  return usage.outputTokens?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Logging middleware
// ---------------------------------------------------------------------------

export const loggingMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate, params }) => {
    const start = Date.now();
    const result = await doGenerate();
    const elapsed = Date.now() - start;
    console.info(
      `[ai] generate model=${(params as any).modelId ?? "unknown"} ` +
        `input=${getInputTokens(result.usage)} output=${getOutputTokens(result.usage)} ` +
        `elapsed=${elapsed}ms`,
    );
    return result;
  },
  wrapStream: async ({ doStream, params }) => {
    const start = Date.now();
    const { stream, ...rest } = await doStream();
    let lastInputTokens = 0;
    let lastOutputTokens = 0;
    const transform = new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "usage") {
          lastInputTokens = getInputTokens(chunk);
          lastOutputTokens = getOutputTokens(chunk);
        }
        controller.enqueue(chunk);
      },
      flush() {
        const elapsed = Date.now() - start;
        console.info(
          `[ai] stream model=${(params as any).modelId ?? "unknown"} ` +
            `input=${lastInputTokens} output=${lastOutputTokens} ` +
            `elapsed=${elapsed}ms`,
        );
      },
    });
    return { stream: stream.pipeThrough(transform), ...rest };
  },
};

// ---------------------------------------------------------------------------
// Retry middleware — exponential backoff for transient errors
// ---------------------------------------------------------------------------

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit")) return true;
    if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
    if (msg.includes("internal server error") || msg.includes("service unavailable")) return true;
  }
  return false;
}

async function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRetryMiddleware(maxRetries: number): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await doGenerate();
        } catch (err) {
          lastError = err;
          if (attempt < maxRetries && isRetryableError(err)) {
            const delay = Math.min(1000 * 2 ** attempt, 8000);
            console.warn(`[ai] retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
            await sleepMs(delay);
            continue;
          }
          throw err;
        }
      }
      throw lastError;
    },
    wrapStream: async ({ doStream }) => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await doStream();
        } catch (err) {
          lastError = err;
          if (attempt < maxRetries && isRetryableError(err)) {
            const delay = Math.min(1000 * 2 ** attempt, 8000);
            console.warn(`[ai] retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
            await sleepMs(delay);
            continue;
          }
          throw err;
        }
      }
      throw lastError;
    },
  };
}

// ---------------------------------------------------------------------------
// Cost guard middleware — tracks cumulative token spend, emits events
// ---------------------------------------------------------------------------

export type CostGuardOpts = {
  /** Maximum spend in USD before blocking further calls. */
  budgetUsd: number;
  /** Callback when spend crosses a threshold (e.g. 80% of budget). */
  onThresholdReached?: (spentUsd: number, budgetUsd: number) => void;
  /** Callback when budget is exhausted. */
  onBudgetExhausted?: (spentUsd: number, budgetUsd: number) => void;
};

export function createCostGuardMiddleware(opts: CostGuardOpts): LanguageModelMiddleware & { getSpent(): number } {
  let cumulativeSpentUsd = 0;
  let thresholdNotified = false;

  function trackUsage(usage: unknown, modelId: string) {
    if (!usage) return;
    const pricing = MODEL_PRICING[modelId];
    if (!pricing) {
      if (modelId) {
        console.warn(`[ai] cost guard: no pricing data for model "${modelId}", cost not tracked`);
      }
      return;
    }

    const inputCost = (getInputTokens(usage) / 1_000_000) * pricing.input;
    const outputCost = (getOutputTokens(usage) / 1_000_000) * pricing.output;
    cumulativeSpentUsd += inputCost + outputCost;

    // Notify at 80% threshold
    if (!thresholdNotified && cumulativeSpentUsd >= opts.budgetUsd * 0.8) {
      thresholdNotified = true;
      opts.onThresholdReached?.(cumulativeSpentUsd, opts.budgetUsd);
    }

    // Block at 100%
    if (cumulativeSpentUsd >= opts.budgetUsd) {
      opts.onBudgetExhausted?.(cumulativeSpentUsd, opts.budgetUsd);
    }
  }

  function checkBudget() {
    if (cumulativeSpentUsd >= opts.budgetUsd) {
      throw new Error(
        `Cost guard: budget exhausted ($${cumulativeSpentUsd.toFixed(4)} / $${opts.budgetUsd.toFixed(2)})`,
      );
    }
  }

  return {
    specificationVersion: "v3",
    getSpent: () => cumulativeSpentUsd,
    wrapGenerate: async ({ doGenerate, params }) => {
      checkBudget();
      const result = await doGenerate();
      trackUsage(result.usage, (params as any).modelId ?? "");
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      checkBudget();
      const { stream, ...rest } = await doStream();
      const modelId = (params as any).modelId ?? "";
      const transform = new TransformStream({
        transform(chunk, controller) {
          if (chunk.type === "usage") {
            trackUsage(chunk, modelId);
          }
          controller.enqueue(chunk);
        },
      });
      return { stream: stream.pipeThrough(transform), ...rest };
    },
  };
}

// ---------------------------------------------------------------------------
// wrapWithMiddleware — applies the appropriate middleware stack to a model
// ---------------------------------------------------------------------------

export type WrapMiddlewareOpts = {
  /** USD budget for cost guard. If omitted, no cost guard is applied. */
  budgetUsd?: number;
  /** Whether to enable logging middleware. Defaults to true. */
  enableLogging?: boolean;
  /** Cost guard callbacks */
  onThresholdReached?: (spentUsd: number, budgetUsd: number) => void;
  onBudgetExhausted?: (spentUsd: number, budgetUsd: number) => void;
};

export function wrapWithMiddleware(
  model: LanguageModel,
  descriptor: ModelDescriptor,
  opts?: WrapMiddlewareOpts,
): LanguageModel {
  const middlewareStack: LanguageModelMiddleware[] = [];

  // 1. Logging (unless disabled)
  if (opts?.enableLogging !== false) {
    middlewareStack.push(loggingMiddleware);
  }

  // 2. Retry — more retries for cloud, fewer for local
  const isLocal = descriptor.authTypes.includes("local");
  middlewareStack.push(createRetryMiddleware(isLocal ? 1 : 2));

  // 3. Cost guard (only if budget specified)
  if (opts?.budgetUsd != null && opts.budgetUsd > 0) {
    middlewareStack.push(
      createCostGuardMiddleware({
        budgetUsd: opts.budgetUsd,
        onThresholdReached: opts.onThresholdReached,
        onBudgetExhausted: opts.onBudgetExhausted,
      }),
    );
  }

  // 4. Reasoning extraction for DeepSeek models that use <think> tags
  if (descriptor.family === "deepseek" && descriptor.capabilities.reasoning) {
    middlewareStack.push(
      extractReasoningMiddleware({ tagName: "think" }),
    );
  }

  if (middlewareStack.length === 0) return model;

  return wrapLanguageModel({
    model: model as any,
    middleware: middlewareStack,
  }) as unknown as LanguageModel;
}
