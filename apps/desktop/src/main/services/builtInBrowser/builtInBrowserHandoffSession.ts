import type { AdeCardPayload } from "../../../shared/adeCard";
import type { BuiltInBrowserHandoffLifecycleEvent } from "./builtInBrowserService";
import type { Logger } from "../logging/logger";

/**
 * The chat-side half of a login handoff.
 *
 * `builtInBrowserService` owns the tab: who holds the lease, when it comes back,
 * the trace. It owns none of this — raising the requesting chat's hand so the
 * Work row shows the same "needs you" state `ade chat ask` produces, clearing it
 * on hand-back, and leaving a line in the transcript explaining the gap.
 *
 * Why this is wired in Electron rather than left to the `ade browser handoff`
 * command that started it: the hand must come down on EVERY ending, including
 * the ones no CLI process is waiting on — `--no-wait`, a timed-out handoff, a
 * closed tab, or an agent whose process died mid-sign-in. The CLI still issues
 * its own `session.requestSessionAttention` on the way in, because that is the
 * call the phone push is attached to; both writes name the same row and the same
 * message, so raising twice is a no-op.
 */

type HandoffSessionServices = {
  sessionService: {
    requestAttention: (sessionId: string, message: string | null) => boolean;
    clearAttentionRequest: (sessionId: string) => boolean;
  } | null;
  agentChatService: {
    emitAdeCard: (args: { sessionId: string; card: AdeCardPayload }) => Promise<void>;
  } | null;
};

export function handoffAttentionMessage(reason: string): string {
  return `Sign in for me: ${reason}`;
}

/** Stable per handoff, so a repeat emit merges instead of stacking rows. */
export function handoffCardId(tabId: string, startedAt: string): string {
  return `browser-login-handoff:${tabId}:${startedAt}`;
}

export function buildHandoffHandBackCard(input: {
  tabId: string;
  startedAt: string;
  reason: string;
  endedBy: string;
  durationMs: number;
}): AdeCardPayload {
  const fallbackText = input.endedBy === "timeout"
    ? `Login handoff timed out — nobody signed in for "${input.reason}".`
    : input.endedBy === "tab-closed"
      ? `Login handoff ended: the tab closed before "${input.reason}" was done.`
      : "Handed back to the agent";
  return {
    cardId: handoffCardId(input.tabId, input.startedAt),
    variant: "browser_login_handoff",
    state: "terminal",
    title: fallbackText,
    subtitle: input.reason,
    durationMs: input.durationMs,
    fallbackText,
  };
}

/**
 * Build the listener the browser service calls on every handoff transition.
 *
 * `resolveServices` is asked per event rather than captured once: a handoff can
 * outlive the project context it started in (the user switches project tabs
 * mid-sign-in), and holding a stale `sessionService` would silently write the
 * hand-raise into a closed database.
 */
export function createBuiltInBrowserHandoffSessionListener(args: {
  resolveServices: (chatSessionId: string) => HandoffSessionServices;
  getLogger: () => Logger | null;
}): (event: BuiltInBrowserHandoffLifecycleEvent) => void {
  return (event) => {
    const chatSessionId = event.handoff.requestedByChatSessionId?.trim() || null;
    if (!chatSessionId) return;
    const logger = (() => {
      try {
        return args.getLogger();
      } catch {
        return null;
      }
    })();
    const services = args.resolveServices(chatSessionId);
    if (event.kind === "started") {
      try {
        services.sessionService?.requestAttention(
          chatSessionId,
          handoffAttentionMessage(event.handoff.reason),
        );
      } catch (error) {
        logger?.warn("built_in_browser.handoff_attention_failed", {
          sessionId: chatSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    try {
      services.sessionService?.clearAttentionRequest(chatSessionId);
    } catch (error) {
      logger?.warn("built_in_browser.handoff_attention_clear_failed", {
        sessionId: chatSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    void services.agentChatService
      ?.emitAdeCard({
        sessionId: chatSessionId,
        card: buildHandoffHandBackCard({
          tabId: event.tabId,
          startedAt: event.handoff.startedAt,
          reason: event.handoff.reason,
          endedBy: event.endedBy,
          durationMs: event.durationMs,
        }),
      })
      .catch((error: unknown) => {
        logger?.warn("built_in_browser.handoff_card_failed", {
          sessionId: chatSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
}
