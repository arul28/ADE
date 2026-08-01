export type ClaudeInterruptReceipt = {
  stillQueuedUuids: string[];
  cancelledUuids: string[];
};

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

/** Normalize fields that have moved in and out of the published Claude SDK type. */
export function normalizeClaudeInterruptReceipt(value: unknown): ClaudeInterruptReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { stillQueuedUuids: [], cancelledUuids: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    stillQueuedUuids: normalizedStringList(record.still_queued),
    cancelledUuids: normalizedStringList(record.cancelled),
  };
}

/** Read the newer rewind result field without coupling callers to one SDK declaration. */
export function normalizeClaudeRewindSkippedLinks(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const skippedLinks = (value as Record<string, unknown>).skippedLinks;
  return typeof skippedLinks === "number" && Number.isFinite(skippedLinks)
    ? Math.max(0, skippedLinks)
    : null;
}
