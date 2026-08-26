export type ClaudeInterruptReceipt = {
  stillQueuedUuids: string[];
  cancelledUuids: string[];
};

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
