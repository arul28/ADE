/**
 * What a chat wait waits for, read off a chat's session summary. Shared by the
 * `ade chat wait` CLI and the brain's event-driven waits, so both agree on
 * what "idle" or "terminal" means.
 */

export type ChatWaitTarget = "idle" | "active" | "awaiting-input" | "terminal";

export const CHAT_WAIT_TARGETS: readonly ChatWaitTarget[] = ["idle", "active", "awaiting-input", "terminal"];

export function parseChatWaitTarget(value: unknown): ChatWaitTarget | null {
  const normalized = String(value ?? "idle").trim().toLowerCase();
  if (normalized === "idle" || normalized === "done" || normalized === "complete") return "idle";
  if (normalized === "active" || normalized === "running") return "active";
  if (normalized === "awaiting-input" || normalized === "awaiting_input" || normalized === "input" || normalized === "blocked") {
    return "awaiting-input";
  }
  if (normalized === "terminal" || normalized === "ended" || normalized === "failed" || normalized === "interrupted") {
    return "terminal";
  }
  return null;
}

type SummaryLike = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function chatWaitTargetMatches(summary: SummaryLike, waitFor: ChatWaitTarget): boolean {
  const status = str(summary.status);
  const phase = str(summary.phase);
  const awaitingInput = summary.awaitingInput === true || phase === "blocked";
  const cliSession = summary.cliSession && typeof summary.cliSession === "object"
    ? summary.cliSession as SummaryLike
    : null;
  const cliStatus = str(cliSession?.status);
  // Another live brain runs this chat, and the answering brain cannot see its
  // turn: its "idle" is a guess, and acting on it is how a caller sent into a
  // running chat. Only the shared row's end is a fact here.
  if (summary.runtimeOwnedElsewhere != null || summary.ownedElsewhere != null) {
    return waitFor === "terminal" && summary.endedAt != null;
  }
  if (waitFor === "idle") return status === "idle" || phase === "idle";
  if (waitFor === "active") return (status === "active" || phase === "running") && !awaitingInput;
  if (waitFor === "awaiting-input") return awaitingInput;
  return status === "failed"
    || status === "interrupted"
    || status === "completed"
    || summary.endedAt != null
    || (cliStatus !== null && cliStatus !== "running");
}

/** A durable wait one chat armed on others. */
export type ChatWaiter = {
  id: string;
  /** The chat that armed it; woken when it fires (`action.kind === "wake"`). */
  callerSessionId: string | null;
  targetSessionIds: string[];
  mode: "all" | "any";
  waitFor: ChatWaitTarget;
  action:
    | { kind: "wake" }
    /**
     * "Start B after A": send this prompt to `sessionId` once the targets match.
     * `metadata` is the provenance the host derived when the wait was armed
     * (never a caller's own), so B sees who it is from.
     */
    | { kind: "send"; sessionId: string; text: string; metadata?: Record<string, unknown> };
  createdAt: string;
  expiresAt: string;
};

export type ArmChatWaitArgs = {
  /** Required for a wake; the chat to wake. */
  callerSessionId?: string | null;
  targetSessionIds: string[];
  mode?: "all" | "any";
  waitFor?: ChatWaitTarget;
  /** Send this prompt to `sendToSessionId` instead of waking the caller. */
  sendToSessionId?: string | null;
  text?: string | null;
  /** Host-derived provenance for the sent prompt; the RPC edge sets it, never a caller. */
  sendMetadata?: Record<string, unknown> | null;
  /** Give up after this long (default 24 h). */
  timeoutMinutes?: number | null;
};

export type ChatWaitForArgs = {
  sessionId: string;
  waitFor?: ChatWaitTarget;
  /** One long-poll's budget; the CLI loops. Capped at 25 s. */
  timeoutMs?: number;
};

export type ChatWaitForResult = {
  matched: boolean;
  missing?: boolean;
  summary: Record<string, unknown> | null;
};
