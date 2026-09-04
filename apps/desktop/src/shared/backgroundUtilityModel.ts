/**
 * Cheap background helpers (lane/chat names, idle status lines, commit
 * suggestions) pick a model from the ADE provider that owns the session, not
 * from Settings and not from the model's registry family.
 *
 * OpenCode-wrapped Anthropic must not spawn `claude -p` Haiku. Droid, Pi, ACP,
 * and local sessions reuse the session's own model.
 */
export const BACKGROUND_UTILITY_CLAUDE_MODEL_ID = "anthropic/claude-haiku-4-5";
export const BACKGROUND_UTILITY_CODEX_MODEL_ID = "openai/gpt-5.6-luna";
export const BACKGROUND_UTILITY_CODEX_REASONING_EFFORT = "low";
export const BACKGROUND_UTILITY_CURSOR_MODEL_ID = "cursor/composer-2.5";

export type AdeBackgroundUtilityProvider = "claude" | "codex" | "cursor";

export function adeBackgroundUtilityProvider(
  provider: string | null | undefined,
): AdeBackgroundUtilityProvider | null {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (normalized === "claude") return "claude";
  if (normalized === "codex") return "codex";
  if (normalized === "cursor") return "cursor";
  return null;
}

export function adeBackgroundUtilityProviderFromToolType(
  toolType: string | null | undefined,
): AdeBackgroundUtilityProvider | null {
  const normalized = String(toolType ?? "").trim().toLowerCase();
  if (
    normalized === "claude"
    || normalized === "claude-chat"
    || normalized === "claude-orchestrated"
  ) {
    return "claude";
  }
  if (
    normalized === "codex"
    || normalized === "codex-chat"
    || normalized === "codex-orchestrated"
  ) {
    return "codex";
  }
  if (normalized === "cursor" || normalized === "cursor-cli") return "cursor";
  return null;
}

export function backgroundUtilityModelId(
  provider: AdeBackgroundUtilityProvider,
): string {
  switch (provider) {
    case "claude":
      return BACKGROUND_UTILITY_CLAUDE_MODEL_ID;
    case "codex":
      return BACKGROUND_UTILITY_CODEX_MODEL_ID;
    case "cursor":
      return BACKGROUND_UTILITY_CURSOR_MODEL_ID;
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

export function backgroundUtilityReasoningEffort(modelId: string | null | undefined): string | null {
  const id = String(modelId ?? "").trim();
  if (id === BACKGROUND_UTILITY_CODEX_MODEL_ID || id === "gpt-5.6-luna" || id === "luna") {
    return BACKGROUND_UTILITY_CODEX_REASONING_EFFORT;
  }
  return null;
}

/** How long ADE waits for a native provider title before naming the chat itself. */
export const NATIVE_TITLE_WAIT_MS = 8_000;
export const NATIVE_TITLE_POLL_MS = 250;
