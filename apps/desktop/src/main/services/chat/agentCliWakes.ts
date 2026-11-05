import type { Logger } from "../logging/logger";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "../sessions/sessionService";
import {
  isPtySendPreDeliveryError,
  isTrackedAgentCliToolType,
  type AgentChatMessageSessionArgs,
} from "../../../shared/types";

/**
 * Wakes for tracked agent CLIs.
 *
 * A tracked agent CLI (Claude Code, Codex, ... in a terminal) starts child
 * chats and arms waits as a chat does, but it has no chat to message. Its
 * wakes are typed at its prompt instead, the way scheduled work reaches it,
 * and only at a turn boundary: never into a turn that is still running.
 */

const CLI_PARENT_WAKE_RETRY_MS = 5_000;
const CLI_PARENT_WAKE_GIVE_UP_MS = 24 * 60 * 60_000;

export type AgentCliWakeDeps = {
  logger: Logger;
  sessionService: Pick<ReturnType<typeof createSessionService>, "get">;
  ptyService:
    | (Pick<ReturnType<typeof createPtyService>, "canAcceptScheduledTurn" | "sendToSession">
      & Partial<Pick<ReturnType<typeof createPtyService>, "isSessionOwnedByLivePeerRuntime">>)
    | null;
  /** A tracked agent CLI terminal (Claude Code, Codex, ...): it can take wakes typed at its prompt. */
  isTrackedAgentCliSession: (sessionId: string) => boolean;
  /** Deliver a wake to an agent chat, as a message. */
  messageSession: (args: AgentChatMessageSessionArgs, options?: { trustedSpawnCompletion?: boolean }) => Promise<unknown>;
  /** Reopen a resumed CLI child's card on its parent. */
  notifyParentOfCliChildSpawn: (terminalSessionId: string, options: { resumed: true }) => void;
  isDisposed: () => boolean;
};

export function createAgentCliWakes(deps: AgentCliWakeDeps) {
  const { logger, sessionService } = deps;

  /** True while a tracked agent CLI cannot take a wake: mid-turn, or run by another live ADE runtime. */
  const agentCliWakeDeferred = (sessionId: string): boolean =>
    deps.isTrackedAgentCliSession(sessionId) && deps.ptyService?.canAcceptScheduledTurn(sessionId.trim()) !== true;

  /** Whether another live ADE runtime runs this tracked agent CLI's terminal. */
  const agentCliOwnedByAnotherRuntime = (sessionId: string): boolean => {
    const row = sessionService.get(sessionId.trim());
    return Boolean(
      row?.tracked
        && isTrackedAgentCliToolType(row.toolType)
        && deps.ptyService?.isSessionOwnedByLivePeerRuntime?.(row),
    );
  };

  const typeWakeIntoAgentCli = async (sessionId: string, text: string): Promise<"delivered" | "deferred"> => {
    if (sessionService.get(sessionId)?.archivedAt) {
      throw new Error(`Terminal session '${sessionId}' is archived, so it cannot be woken.`);
    }
    const { ptyService } = deps;
    // Checked again here, inside the per-CLI queue: an earlier wake may have
    // just started a turn.
    if (!ptyService || ptyService.canAcceptScheduledTurn(sessionId) !== true) return "deferred";
    try {
      const sent = await ptyService.sendToSession({ sessionId, text });
      // sendToSession relaunches an ended CLI, as for scheduled work; its own
      // parent's card closed when that process exited and reopens here.
      if (sent.resumed) {
        try {
          deps.notifyParentOfCliChildSpawn(sent.sessionId, { resumed: true });
        } catch (notifyError) {
          logger.warn("agent_chat.cli_wake_resume_parent_notify_failed", {
            sessionId: sent.sessionId,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        }
      }
      return "delivered";
    } catch (error) {
      // Nothing was typed. Keep the wake only while the CLI still cannot take
      // a turn (it started one, or another runtime took it). An ended CLI
      // that cannot be reopened (no resume target) fails now instead of
      // retrying a resume that cannot work.
      if (isPtySendPreDeliveryError(error) && ptyService.canAcceptScheduledTurn(sessionId) !== true) {
        logger.info("agent_chat.cli_wake_deferred", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return "deferred";
      }
      throw error;
    }
  };

  const cliWakeFlights = new Map<string, Promise<"delivered" | "deferred">>();

  /**
   * Deliver a wake ADE wrote (a finished wait, a subagent's report, a queued
   * prompt) to the session it is for. An agent chat takes it as a message. A
   * tracked agent CLI gets the text typed at its prompt once it can take a
   * turn; "deferred" means nothing was typed and the caller keeps the wake.
   * Wakes to one CLI run one at a time, so two never land in one turn.
   */
  const deliverWakeToSession = async (
    args: AgentChatMessageSessionArgs,
    options?: { trustedSpawnCompletion?: boolean },
  ): Promise<"delivered" | "deferred"> => {
    const sessionId = args.sessionId.trim();
    if (!deps.isTrackedAgentCliSession(sessionId)) {
      await deps.messageSession(args, options);
      return "delivered";
    }
    const previous = cliWakeFlights.get(sessionId) ?? Promise.resolve("delivered" as const);
    const flight = previous
      .catch(() => "deferred" as const)
      .then(() => typeWakeIntoAgentCli(sessionId, args.text));
    cliWakeFlights.set(sessionId, flight);
    try {
      return await flight;
    } finally {
      if (cliWakeFlights.get(sessionId) === flight) cliWakeFlights.delete(sessionId);
    }
  };

  /**
   * Wake a tracked agent CLI parent with a subagent's report, retrying until
   * the CLI reaches a turn boundary. Gives up after a day, when the CLI is
   * gone, or when the service shuts down. Nothing here is durable: like a
   * chat parent's held wake, a brain restart drops it, and never repeats it.
   */
  const wakeAgentCliParent = async (parentSessionId: string, text: string): Promise<void> => {
    const giveUpAt = Date.now() + CLI_PARENT_WAKE_GIVE_UP_MS;
    for (;;) {
      if (deps.isDisposed()) throw new Error("Chat service is shutting down.");
      if (!deps.isTrackedAgentCliSession(parentSessionId)) throw new Error("Parent session was deleted.");
      if (await deliverWakeToSession({ sessionId: parentSessionId, kind: "wake", text }) === "delivered") return;
      if (Date.now() >= giveUpAt) {
        throw new Error(`Agent CLI session '${parentSessionId}' did not reach a turn boundary within a day.`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLI_PARENT_WAKE_RETRY_MS);
        timer.unref?.();
      });
    }
  };

  return { agentCliWakeDeferred, agentCliOwnedByAnotherRuntime, deliverWakeToSession, wakeAgentCliParent };
}
