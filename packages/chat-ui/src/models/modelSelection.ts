import type { ThreadModelSelection } from "../sdkTypes";

/**
 * The one normalizer for a resolved model: the fields this package reads, or
 * null for anything without a `modelId`. Used for `AdaptedThread.model` and for
 * what `setModel` resolves to, whose shape differs by SDK generation.
 */
export function readThreadModelSelection(value: unknown): ThreadModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.modelId !== "string" || !record.modelId) return null;
  const info: ThreadModelSelection = { modelId: record.modelId };
  if (typeof record.displayName === "string" || record.displayName === null) {
    info.displayName = record.displayName as string | null;
  }
  if (typeof record.provider === "string" && record.provider) info.provider = record.provider;
  return info;
}
