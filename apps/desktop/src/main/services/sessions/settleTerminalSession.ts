import type { createAgentChatService } from "../chat/agentChatService";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "./sessionService";
import type { SessionSettleSource } from "../../../shared/types";
import { isChatToolType } from "./chatSessionProjection";

/** A settle that reached the row but was refused by the settling window. */
export class SettleAbortedError extends Error {
  constructor(readonly sessionId: string, readonly abortedBy?: string) {
    super(settleAbortMessage(sessionId, abortedBy));
    this.name = "SettleAbortedError";
  }
}

/** One sentence a user can act on, per abort reason. */
export function settleAbortMessage(sessionId: string, abortedBy?: string): string {
  switch (abortedBy) {
    case "turn_start":
      return `Session '${sessionId}' started working again, so it was not settled.`;
    case "turn_failed":
      return `Session '${sessionId}' reported a failed turn, so it was not settled.`;
    case "attention_requested":
      return `Session '${sessionId}' asked for attention, so it was not settled.`;
    case "teardown_failed":
      return `Session '${sessionId}' could not be stopped cleanly, so it was not settled.`;
    case "joined_in_flight":
      return `Session '${sessionId}' is already being settled.`;
    default:
      return `Session '${sessionId}' changed while it was being settled, so it was not settled.`;
  }
}

export type SettleTerminalSessionOptions = {
  outcome?: string;
  dismissPendingInput?: boolean;
  source?: SessionSettleSource;
};

/**
 * Dismiss whatever the session is blocked on so a settle can follow.
 *
 * Split out of `settleTerminalSession` so the BULK settle paths (which write
 * through `sessionService.settleSessions` and must keep returning the changed
 * id list) can reuse the exact same dismissal semantics instead of inventing
 * a second mechanism. Returns false when the row is missing — callers decide
 * whether that is an error or just an id that settles nothing.
 */
export async function dismissPendingInputBeforeSettle(args: {
  sessionId: string;
  sessionService: ReturnType<typeof createSessionService>;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  ptyService?: ReturnType<typeof createPtyService> | null;
}): Promise<boolean> {
  const session = args.sessionService.get(args.sessionId);
  if (!session) return false;
  if (isChatToolType(session.toolType)) {
    if (!args.agentChatService) {
      throw new Error("Agent chat service is unavailable; pending input could not be dismissed.");
    }
    await args.agentChatService.dismissPendingInputForSettlement({
      sessionId: args.sessionId,
    });
  } else if (session.attentionRequestedAt) {
    if (!args.ptyService) {
      throw new Error("Terminal runtime is unavailable; the explicit attention request could not be dismissed.");
    }
    args.ptyService.setSessionRuntimeState(args.sessionId, "idle");
  } else {
    throw new Error("Resolve the terminal input before settling this session.");
  }
  return true;
}

export async function settleTerminalSession(args: {
  sessionId: string;
  opts?: SettleTerminalSessionOptions;
  sessionService: ReturnType<typeof createSessionService>;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  ptyService?: ReturnType<typeof createPtyService> | null;
}): Promise<boolean> {
  if (args.opts?.dismissPendingInput === true) {
    const dismissed = await dismissPendingInputBeforeSettle({
      sessionId: args.sessionId,
      sessionService: args.sessionService,
      agentChatService: args.agentChatService ?? null,
      ptyService: args.ptyService ?? null,
    });
    if (!dismissed) return false;
  }

  const result = await args.sessionService.settleSessionReportingAbort(
    args.sessionId,
    {
      ...(args.opts?.outcome ? { outcome: args.opts.outcome } : {}),
      ...(args.opts?.source ? { source: args.opts.source } : {}),
    },
  );
  if (result.settled) return true;
  // An abort is NOT "no such session". Callers turned a bare `false` into
  // "Session was not found", which sends the user looking for a row that is
  // sitting right there, working.
  if (result.found) throw new SettleAbortedError(args.sessionId, result.abortedBy);
  return false;
}
