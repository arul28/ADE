// ---------------------------------------------------------------------------
// Provider Options — maps ThinkingLevel to provider-specific options
// ---------------------------------------------------------------------------

import type { ModelDescriptor } from "../../../shared/modelRegistry";
import type { ThinkingLevel } from "../../../shared/types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build provider-specific options for an AI SDK call (e.g. streamText, generateText).
 * These go into the `providerOptions` field of the AI SDK call.
 *
 * Rather than inventing token budgets, we pass the named tier string directly
 * to each provider's native API shape. Each provider maps these strings to
 * their own internal budgets/behaviors.
 */
export function buildProviderOptions(
  descriptor: ModelDescriptor,
  thinkingLevel?: ThinkingLevel | null,
): Record<string, unknown> {
  if (!thinkingLevel || thinkingLevel === "none" || !descriptor.capabilities.reasoning) {
    return {};
  }

  const tier = thinkingLevel;

  switch (descriptor.family) {
    case "anthropic":
      return {
        anthropic: {
          thinking: { type: "adaptive" },
          effort: tier,
          sendReasoning: true,
        },
      };

    case "openai":
      return {
        openai: { reasoningEffort: tier },
      };

    case "google":
      return {
        google: {
          thinkingConfig: { thinkingLevel: tier, includeThoughts: true },
        },
      };

    case "groq":
    case "together":
    case "xai":
      return {
        [descriptor.family]: { reasoningEffort: tier },
      };

    case "openrouter":
      return {
        openrouter: { reasoning: { effort: tier } },
      };

    case "deepseek":
      // DeepSeek R1 uses <think> tags — reasoning is handled by extractReasoningMiddleware.
      return {};

    case "ollama":
    case "mistral":
    case "meta":
      // No reasoning config needed.
      return {};

    default:
      return {};
  }
}
