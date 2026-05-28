import { resolveClaudeCliModelAlias } from "../../../shared/claudeCliModels";
import { getDefaultModelDescriptor, getModelById, resolveModelAlias } from "../../../shared/modelRegistry";

/**
 * Normalize arbitrary Claude model strings into CLI-safe values accepted by
 * Claude Code (`claude-opus-4-8`, `opus`, `opus[1m]`, `sonnet`, `haiku`) where possible.
 */
export function resolveClaudeCliModel(model: string | null | undefined): string {
  return resolveClaudeCliModelAlias(model, "sonnet") ?? "sonnet";
}

/**
 * Normalize model identifiers for Codex CLI invocation. Supports registry IDs,
 * short aliases, and "openai/<model>" prefixed strings.
 */
export function resolveCodexCliModel(model: string | null | undefined): string {
  const raw = String(model ?? "").trim();
  if (!raw.length) return getDefaultModelDescriptor("codex")?.providerModelId ?? "gpt-5.5";

  const descriptor = getModelById(raw) ?? resolveModelAlias(raw);
  if (descriptor?.isCliWrapped && descriptor.family === "openai") {
    return descriptor.providerModelId;
  }

  const lower = raw.toLowerCase();
  if (lower.startsWith("openai/")) {
    const sdk = raw.slice("openai/".length).trim();
    if (sdk.length) return sdk;
  }

  return raw;
}
