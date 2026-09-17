/**
 * Asking the user for real input, and telling the backend who holds it.
 *
 * The lease *state machine* is `macDesktopLease.ts` and is pure. This is the
 * part that talks to people and to the helper: the one pending-input card a
 * chat sees before it may post a `CGEvent`, the per-chat memory of that answer,
 * and the push that makes the helper's own refusal correct.
 *
 * Split out of `macDesktopService.ts` as pure code motion: the registry, the
 * gates and the prompt are passed in.
 */

import {
  AUTOMATION_CHAT_SESSION_PREFIX,
  MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
} from "../../../shared/types/macDesktop";
import type {
  DesktopSeatProvider,
  MacDesktopEventPayload,
  MacDesktopLeaseRequestArgs,
  MacDesktopLeaseRequestResult,
  MacDesktopLeaseState,
} from "../../../shared/types/macDesktop";
import type { Logger } from "../logging/logger";
import type { MacDesktopLeaseRegistry } from "./macDesktopLease";

export type MacDesktopRequestChatInput = (args: {
  chatSessionId: string;
  title: string;
  body: string;
  questions?: Array<{
    id?: string;
    header?: string;
    question: string;
    options?: Array<{ label: string; value?: string; description?: string; recommended?: boolean }>;
    allowsFreeform?: boolean;
  }>;
  providerMetadata?: Record<string, unknown>;
  eventDescription?: string;
  eventDetail?: Record<string, unknown>;
}) => Promise<{ decision: string; answers: Record<string, string[]>; responseText: string | null }>;

export type MacDesktopLeaseFlowDeps = {
  logger: Logger;
  isDarwin: boolean;
  leases: MacDesktopLeaseRegistry;
  emit: (payload: MacDesktopEventPayload) => void;
  requireDisplay: (laneId: string) => void;
  /** The backend only if it is already up. */
  activeProvider: () => DesktopSeatProvider | null;
  requestChatInput?: MacDesktopRequestChatInput | null;
};

export function createMacDesktopLeaseFlow(deps: MacDesktopLeaseFlowDeps) {
  /**
   * Tells the helper who holds the lease.
   *
   * The driver refuses a `CGEvent` post itself rather than trusting its caller,
   * so this is what makes that refusal correct — and why a failure to push is
   * logged rather than swallowed silently.
   */
  async function pushLease(laneId: string, lease: MacDesktopLeaseState | null): Promise<void> {
    if (!deps.isDarwin) return;
    const provider = deps.activeProvider();
    if (!provider) return;
    try {
      if (lease) {
        await provider.setLease({ laneId, holderId: lease.holderId, expiresAt: lease.expiresAt });
      } else {
        await provider.clearLease({ laneId });
      }
    } catch (error) {
      deps.logger.warn("mac_desktop.lease_push_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    pushLease,

    async requestInputLease(args: MacDesktopLeaseRequestArgs): Promise<MacDesktopLeaseRequestResult> {
      const laneId = args.laneId.trim();
      const chatSessionId = args.chatSessionId.trim();
      deps.requireDisplay(laneId);
      const refuse = (): MacDesktopLeaseRequestResult => ({
        granted: false,
        code: MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
        lease: null,
      });
      if (!chatSessionId) return refuse();
      const grantNow = (): MacDesktopLeaseRequestResult => {
        const decision = deps.leases.grantToAgent({
          laneId,
          holder: "agent",
          holderId: chatSessionId,
          holderLabel: null,
        });
        if (!decision.ok) return { granted: false, code: decision.code, lease: decision.lease };
        void pushLease(laneId, decision.lease);
        deps.emit({ type: "lease-changed", laneId, lease: decision.lease });
        return { granted: true, code: null, lease: decision.lease };
      };

      // Asked once per chat, for the chat's whole life. A second request is a
      // silent re-grant rather than a second card in the user's face.
      if (deps.leases.isChatApproved(laneId, chatSessionId)) return grantNow();

      // An automation's synthetic holder (`automation:<ruleId>`) is not a chat,
      // so there is nobody to show a card to: asking would throw "chat not
      // found" *after* a `lease-requested` event had already told the UI a card
      // was coming. A host with no `requestChatInput` wired has no card either,
      // so it refuses here too rather than after the event.
      if (chatSessionId.startsWith(AUTOMATION_CHAT_SESSION_PREFIX) || !deps.requestChatInput) {
        return refuse();
      }
      const reason = args.reason?.trim() || "drive this display with real pointer and keyboard input";
      deps.emit({ type: "lease-requested", laneId, chatSessionId, reason: args.reason?.trim() ?? null });
      let response: Awaited<ReturnType<MacDesktopRequestChatInput>>;
      try {
        response = await deps.requestChatInput({
          chatSessionId,
          title: "Real input on the lane's display",
          body: `ADE would like to ${reason}. Accessibility actions do not need this; real pointer and keyboard events do, and they are global to this Mac.`,
          questions: [{
            id: "mac_desktop_input_lease",
            header: "Real input",
            question: `Allow this chat to use real pointer and keyboard input on its Mac Desktop display? (${reason})`,
            options: [
              { label: "Allow", value: "allow", recommended: true },
              { label: "Don't allow", value: "deny" },
            ],
            allowsFreeform: true,
          }],
          providerMetadata: { macDesktopInputLease: true, laneId },
          eventDescription: `Allow real input on the Mac Desktop display for ${reason}?`,
          eventDetail: { macDesktopInputLease: true, laneId },
        });
      } catch (error) {
        // The chat could be gone by the time the lease is asked for. A missing
        // chat is not an approval, and it is not a crash either: it is the same
        // "nobody said yes" the decline path returns.
        deps.logger.warn("mac_desktop.lease_prompt_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
        return refuse();
      }
      const answer = [
        ...(response.answers?.mac_desktop_input_lease ?? []),
        response.responseText ?? "",
      ].join(" ").toLowerCase();
      const denied = response.decision === "decline"
        || response.decision === "cancel"
        || answer.includes("deny")
        || answer.includes("don't allow")
        || answer.includes("do not allow");
      if (denied || (!answer.includes("allow") && response.decision !== "accept")) {
        return refuse();
      }
      deps.leases.approveChat(laneId, chatSessionId);
      return grantNow();
    },
  };
}

export type MacDesktopLeaseFlow = ReturnType<typeof createMacDesktopLeaseFlow>;
