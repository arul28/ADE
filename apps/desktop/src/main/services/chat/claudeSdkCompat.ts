import type { ClaudeCodeExecutableResolution } from "../ai/claudeCodeExecutable";

export type ClaudeInterruptReceipt = {
  stillQueuedUuids: string[];
  cancelledUuids: string[];
};

/**
 * How the plugin list should reach the Claude Code process.
 *
 * `pluginDelivery: "initialize"` sends the plugin list over stdin and launches
 * the CLI with `--await-initialize`, so the command line no longer grows one
 * `--plugin-dir` flag per plugin — Windows refuses to start a process whose
 * command line passes 32,767 characters, and ADE ships a plugin directory per
 * agent-skill root. The SDK reports this option requires Claude Code 2.1.261 or
 * newer; the binary bundled with the pinned SDK qualifies.
 *
 * Only ADE-managed binaries are known new enough: `bundled` and `tools-cache`
 * copies are installed from the pinned SDK platform packages. A binary the user
 * supplied through `env`, `auth`, `path`, `common-dir`, or `fallback-command`
 * can be any version, and an older CLI exits at startup on the unknown option,
 * so those keep argv delivery.
 */
export function claudePluginDeliveryForSource(
  source: ClaudeCodeExecutableResolution["source"],
): "initialize" | null {
  return source === "bundled" || source === "tools-cache" ? "initialize" : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

/** Normalize fields that have moved in and out of the published Claude SDK type. */
export function normalizeClaudeInterruptReceipt(value: unknown): ClaudeInterruptReceipt {
  const record = asRecord(value);
  if (!record) {
    return { stillQueuedUuids: [], cancelledUuids: [] };
  }
  return {
    stillQueuedUuids: normalizedStringList(record.still_queued),
    cancelledUuids: normalizedStringList(record.cancelled),
  };
}

/** Read the newer rewind result field without coupling callers to one SDK declaration. */
export function normalizeClaudeRewindSkippedLinks(value: unknown): number | null {
  const record = asRecord(value);
  if (!record) return null;
  const skippedLinks = record.skippedLinks;
  return typeof skippedLinks === "number" && Number.isFinite(skippedLinks)
    ? Math.max(0, skippedLinks)
    : null;
}

/** Read the model from the SDK's historical and current session-message shapes. */
export function normalizeClaudeSdkSessionMessageModel(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const nestedMessage = asRecord(record.message);
  const nestedApiMessage = asRecord(nestedMessage?.message);
  return stringOrNull(record.model)
    ?? stringOrNull(nestedMessage?.model)
    ?? stringOrNull(nestedApiMessage?.model);
}
