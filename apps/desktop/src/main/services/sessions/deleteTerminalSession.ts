import type { TerminalSessionSummary } from "../../../shared/types";
import { isTrackedAgentCliToolType } from "../../../shared/types/sessions";
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
    // Delete is idempotent: "the session is not here" IS the goal state, so it
    // is a no-op, not a failure. The renderer routinely asks a runtime to
    // delete a row it no longer has — an optimistic placeholder that never
    // persisted, a row already deleted from another window or machine, or a
    // stale row filed under the wrong roster. Throwing there put a red banner
    // over a list that was already correct.
    return false;
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

/**
 * Every "delete this terminal row" entry point (`sessions.delete`, the phone's
 * `work.deleteSession`, Settings › Archive). A tracked agent CLI (Claude Code,
 * Codex, …) deletes like a chat when the chat service is here: stopped and
 * kept in Recently deleted, so it can be reopened. Anything else is removed
 * outright, as before.
 */
export function deleteSessionRowWithRuntimeCleanup(args: {
  sessionId: string;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
  agentChatService?: { deleteSession: (args: { sessionId: string }) => Promise<unknown> } | null;
}): boolean | Promise<boolean> {
  const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
  if (args.agentChatService && sessionId) {
    const row = args.sessionService.get(sessionId);
    if (row?.tracked && isTrackedAgentCliToolType(row.toolType ?? null)) {
      return args.agentChatService.deleteSession({ sessionId }).then(() => true);
    }
  }
  // A shell keeps the synchronous delete (and its synchronous refusals).
  return deleteTerminalSessionWithRuntimeCleanup(args);
}
