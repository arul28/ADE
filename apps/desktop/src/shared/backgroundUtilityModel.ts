/**
 * Cheap background helpers (lane/chat names, idle status lines, commit
 * suggestions) pick a model from the ADE provider that owns the session, not
 * from Settings and not from the model's registry family.
 *
 * OpenCode-wrapped Anthropic must not spawn `claude -p` Haiku. Droid, Pi, ACP,
 * and local sessions reuse the session's own model.
 *
 * Every one runs at the lowest effort the model offers and never on Fast: the
 * provider runner pins standard speed for these calls (`backgroundUtility`), so a user
 * who turned Fast on globally does not pay Fast rates for a chat name.
 * Composer 2.5 has no effort control, only fast/standard.
 */
import type { ModelDescriptor } from "./modelRegistry";

/** The model ids the provider CLIs take (`claude --model`, `codex -m`). */
export const BACKGROUND_UTILITY_CLAUDE_CLI_MODEL = "claude-haiku-5-5";
export const BACKGROUND_UTILITY_CODEX_CLI_MODEL = "gpt-6-luna";
export const BACKGROUND_UTILITY_CLAUDE_MODEL_ID = `anthropic/${BACKGROUND_UTILITY_CLAUDE_CLI_MODEL}`;
export const BACKGROUND_UTILITY_CODEX_MODEL_ID = `openai/${BACKGROUND_UTILITY_CODEX_CLI_MODEL}`;
export const BACKGROUND_UTILITY_CODEX_REASONING_EFFORT = "low";
/** Haiku 5.5 thinks at `medium` by default; names and status lines need none of it. */
export const BACKGROUND_UTILITY_CLAUDE_REASONING_EFFORT = "low";
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

/** Effort names from least to most thinking. Anything else (OpenCode's `free`, `budget`) is not an effort. */
const REASONING_TIERS_LOW_TO_HIGH = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];

/**
 * The effort a background utility call runs at: the lowest tier the model
 * itself lists, whichever model it is — the cheap helper, or the chat's own
 * model when the provider has no cheap helper. Null when the model lists no
 * known tier (Composer has none), so nothing is sent and the model keeps its
 * own default rather than getting a tier it would reject.
 */
export function backgroundUtilityReasoningEffort(
  descriptor: Pick<ModelDescriptor, "reasoningTiers"> | null | undefined,
): string | null {
  const tiers = new Set(descriptor?.reasoningTiers ?? []);
  return REASONING_TIERS_LOW_TO_HIGH.find((tier) => tiers.has(tier)) ?? null;
}

/**
 * Claude flags for a background utility call: no tools, no MCP servers.
 * `--tools=` is one argument because an empty `--tools ""` does not survive
 * every Windows spawn path.
 */
export function claudeBackgroundUtilityFlags(): string[] {
  return ["--tools=", "--strict-mcp-config"];
}

/**
 * Codex flags that pin standard speed. Omitted, config.toml's service_tier
 * applies (main/services/shared/providerConfigHomes.ts). Unquoted: Codex reads a non-TOML value as
 * a string, and no quotes means nothing for a Windows cmd wrapper to mangle.
 */
export function codexStandardSpeedFlags(): string[] {
  return ["-c", "service_tier=default"];
}

/** How long ADE waits for a native provider title before naming the chat itself. */
export const NATIVE_TITLE_WAIT_MS = 8_000;
export const NATIVE_TITLE_POLL_MS = 250;
