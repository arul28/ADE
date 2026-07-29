import type { createAgentChatService } from "../chat/agentChatService";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "./sessionService";
import type { SessionSettleSource } from "../../../shared/types";
import { isChatToolType } from "./chatSessionProjection";

export type SettleTerminalSessionOptions = {
  outcome?: string;
  dismissPendingInput?: boolean;
  source?: SessionSettleSource;
};

export async function settleTerminalSession(args: {
  sessionId: string;
  opts?: SettleTerminalSessionOptions;
  sessionService: ReturnType<typeof createSessionService>;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  ptyService?: ReturnType<typeof createPtyService> | null;
}): Promise<boolean> {
  if (args.opts?.dismissPendingInput === true) {
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
  }

  return args.sessionService.settleSession(
    args.sessionId,
    {
      ...(args.opts?.outcome ? { outcome: args.opts.outcome } : {}),
      ...(args.opts?.source ? { source: args.opts.source } : {}),
    },
  );
}
