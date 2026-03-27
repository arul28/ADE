/**
 * Chat filtering utilities — extracted from MissionChatV2.
 *
 * Pure functions used by the chat message area to classify,
 * filter and format orchestrator chat messages.
 */
import type { OrchestratorChatMessage, OrchestratorChatTarget } from "../../../shared/types";
import type { MentionParticipant } from "../shared/MentionInput";
import { COLORS } from "../lanes/laneDesignTokens";
import { looksLikeLowSignalNoise } from "./missionHelpers";

// ── Design token shortcuts ──
const STATUS_GREEN = COLORS.success;
const STATUS_WARNING = COLORS.warning;
const STATUS_GRAY = "#6b7280";
const STATUS_RED = COLORS.danger;

// ── Helpers ──

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ── Signal detection ──

function isUsefulStructuredSignal(
  msg: OrchestratorChatMessage,
  kind: string,
  structured: Record<string, unknown>,
): boolean {
  if (kind === "plan" || kind === "approval_request" || kind === "user_message") return true;
  if (kind === "text" || kind === "reasoning") return !looksLikeLowSignalNoise(msg.content);
  if (kind === "status") {
    const status = readString(structured.status)?.toLowerCase() ?? "";
    const message = readString(structured.message) ?? msg.content;
    if (status === "failed" || status === "interrupted") return true;
    return message.length > 0 && !looksLikeLowSignalNoise(message);
  }
  if (kind === "error") {
    const errorMessage = readString(structured.message) ?? msg.content;
    return errorMessage.length > 0 && !looksLikeLowSignalNoise(errorMessage);
  }
  return false;
}

/**
 * Determine whether a chat message carries meaningful signal
 * (versus low-value noise like "streaming…" or metadata-only
 * records).
 */
export function isSignalMessage(msg: OrchestratorChatMessage): boolean {
  if (msg.visibility === "metadata_only") return false;
  if (msg.role === "user") return true;
  const metadata = readRecord(msg.metadata);
  const structured = readRecord(metadata?.structuredStream);
  const kind = readString(structured?.kind);
  if (kind) {
    return isUsefulStructuredSignal(msg, kind, structured ?? {});
  }
  const content = typeof msg.content === "string" ? msg.content : "";
  return !looksLikeLowSignalNoise(content);
}

/**
 * Collapse consecutive planner-stream fragments that share the
 * same threadId + sourceSessionId into a single message so the
 * UI doesn't show dozens of tiny chunks.
 *
 * Re-exported from missionHelpers for convenience.
 */
export { collapsePlannerStreamMessages } from "./missionHelpers";

// ── Worker status helpers ──

export function statusDotForWorker(state?: string): string {
  if (!state) return STATUS_GRAY;
  switch (state) {
    case "spawned":
    case "initializing":
    case "working":
      return STATUS_GREEN;
    case "waiting_input":
      return STATUS_WARNING;
    case "completed":
    case "idle":
    case "disposed":
      return STATUS_GRAY;
    case "failed":
      return STATUS_RED;
    default:
      return STATUS_GRAY;
  }
}

export function workerStatusToParticipantStatus(
  state?: string,
): "active" | "completed" | "failed" {
  if (!state) return "completed";
  switch (state) {
    case "spawned":
    case "initializing":
    case "working":
    case "waiting_input":
      return "active";
    case "failed":
      return "failed";
    default:
      return "completed";
  }
}

// ── Mention helpers ──

export type MentionTargetOption = MentionParticipant & {
  threadId: string | null;
  target: OrchestratorChatTarget | null;
  helper: string;
};

export function normalizeMentionKey(
  value: string,
  fallback: string,
  used: Set<string>,
): string {
  const base =
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}
