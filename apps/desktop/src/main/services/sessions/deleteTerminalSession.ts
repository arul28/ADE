import type { TerminalSessionSummary } from "../../../shared/types";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "./sessionService";

function isTerminalChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const t = toolType.trim().toLowerCase();
  return t === "cursor" || t.endsWith("-chat");
}

function normalizedPtyId(session: Pick<TerminalSessionSummary, "ptyId">): string {
  return typeof session.ptyId === "string" ? session.ptyId.trim() : "";
}

function peerOwnedSessionMessage(sessionId: string): string {
  return `Session '${sessionId}' is still owned by another ADE runtime. Stop it from that runtime before deleting it.`;
}

export function deleteTerminalSessionWithRuntimeCleanup({
  sessionId,
  sessionService,
  ptyService,
}: {
  sessionId: string;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
}): boolean {
  const trimmedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!trimmedSessionId) {
    throw new Error("Session id is required.");
  }

  const session = sessionService.get(trimmedSessionId);
  if (!session) {
    throw new Error(`Session '${trimmedSessionId}' was not found.`);
  }
  if (isTerminalChatToolType(session.toolType)) {
    throw new Error(`Session '${trimmedSessionId}' is an agent chat session. Use the chat delete flow instead.`);
  }

  const enriched = ptyService.enrichSessions([session])[0] ?? session;
  const ptyId = normalizedPtyId(enriched);
  if (session.status === "running" && ptyService.isSessionOwnedByLivePeerRuntime(session)) {
    throw new Error(peerOwnedSessionMessage(trimmedSessionId));
  }

  if (enriched.status === "running" || ptyId) {
    if (!ptyId) {
      throw new Error("Running terminal sessions must be closed before they can be deleted.");
    }
    ptyService.dispose({ ptyId, sessionId: trimmedSessionId });

    const afterDispose = sessionService.get(trimmedSessionId);
    if (afterDispose) {
      const afterEnriched = ptyService.enrichSessions([afterDispose])[0] ?? afterDispose;
      const afterPtyId = normalizedPtyId(afterEnriched);
      if (afterDispose.status === "running" && ptyService.isSessionOwnedByLivePeerRuntime(afterDispose)) {
        throw new Error(peerOwnedSessionMessage(trimmedSessionId));
      }
      if (afterEnriched.status === "running" || afterPtyId) {
        throw new Error("Running terminal sessions must be closed before they can be deleted.");
      }
    }
  }

  return sessionService.deleteSession(trimmedSessionId);
}
