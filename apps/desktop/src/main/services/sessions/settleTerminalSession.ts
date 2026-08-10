import type { createAgentChatService } from "../chat/agentChatService";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "./sessionService";
import type { SessionSettleSource } from "../../../shared/types";
import { isChatToolType } from "./chatSessionProjection";
import { stopSettledSessionMachinery } from "./sessionMachineryTeardown";

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

/**
 * Settle a session AND stop the machinery it owns.
 *
 * The teardown runs before the column write so a settle can never report
 * success while its monitors are still armed. It is best-effort — see
 * `stopSettledSessionMachinery` — so a provider that cannot be reached delays
 * nothing and blocks nothing.
 */
export async function settleTerminalSession(args: {
  sessionId: string;
  opts?: SettleTerminalSessionOptions;
  sessionService: ReturnType<typeof createSessionService>;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  ptyService?: ReturnType<typeof createPtyService> | null;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void } | null;
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

  // Teardown awaits provider stop calls that can take seconds, and a user can
  // start a new turn inside that window. `clearTurnStartMarkers` would clear a
  // settle marker that does not exist yet, and this write would then file the
  // freshly-active session as settled. Snapshot the activity stamp first and
  // refuse to settle over work that arrived while we were stopping things —
  // real activity outranks a settle request that predates it.
  const activityBeforeTeardown = args.sessionService.get(args.sessionId)?.lastActivityAt ?? null;

  await stopSettledSessionMachinery(
    {
      sessionService: args.sessionService,
      agentChatService: args.agentChatService ?? null,
      logger: args.logger ?? null,
    },
    [args.sessionId],
  );

  const after = args.sessionService.get(args.sessionId);
  if (!after) return false;
  if ((after.lastActivityAt ?? null) !== activityBeforeTeardown) {
    args.logger?.warn("session_teardown.settle_skipped_new_activity", {
      sessionId: args.sessionId,
    });
    // The row exists and the request was honoured; it simply woke, so it is not
    // settled. Reporting false here would surface a spurious "not found".
    return true;
  }

  return args.sessionService.settleSession(
    args.sessionId,
    {
      ...(args.opts?.outcome ? { outcome: args.opts.outcome } : {}),
      ...(args.opts?.source ? { source: args.opts.source } : {}),
    },
  );
}
