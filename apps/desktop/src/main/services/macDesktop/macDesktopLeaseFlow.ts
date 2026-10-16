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
  MAC_DESKTOP_INPUT_LEASE_METADATA_KEY,
  MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
  WINDOWS_DESKTOP_CONSENT_REQUIRED_CODE,
  WINDOWS_DESKTOP_SHARED_CONSENT_MESSAGE,
  WINDOWS_DESKTOP_SHARED_CONSENT_METADATA_KEY,
  desktopProductName,
} from "../../../shared/types/macDesktop";
import type {
  DesktopSeatProvider,
  MacDesktopEventPayload,
  MacDesktopLeaseRequestArgs,
  MacDesktopLeaseRequestResult,
  MacDesktopLeaseState,
  MacDesktopStatus,
  WindowsDesktopSeatMode,
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
  /** Cancels the card when the asker stops waiting. */
  signal?: AbortSignal;
}) => Promise<{ decision: string; answers: Record<string, string[]>; responseText: string | null }>;

/** Asking for the main desktop never comes back as the lane's private screen. */
export const WINDOWS_DESKTOP_PRIVATE_ALREADY_RUNNING_MESSAGE =
  "This lane already has a private Windows screen; the main desktop was not started.";

/** The lease holder a call with no chat acts as. It is nobody's consent. */
export const MAC_DESKTOP_ANONYMOUS_HOLDER_ID = "anonymous-agent";

/**
 * How long the shared-seat card waits for the user. Shorter than the 180 s the
 * caller waits for `requestSharedDesktop`, so the card is withdrawn before the
 * caller gives up and a late Allow cannot start a seat nobody is waiting for.
 */
export const WINDOWS_DESKTOP_SHARED_CONSENT_WAIT_MS = 170_000;

/**
 * Asks one Allow / Don't allow question in a chat and reads the answer.
 *
 * `allow` only when the answer to the question is exactly the Allow option
 * (case and surrounding space ignored). Typed text, a decline, a cancel, or
 * anything else is `deny`: a consent card grants on the button, never on free
 * text. `unasked` when the card could not be shown at all, with the reason.
 */
export async function askChatAllowDeny(
  requestChatInput: MacDesktopRequestChatInput,
  args: {
    chatSessionId: string;
    title: string;
    body: string;
    questionId: string;
    header: string;
    question: string;
    recommendAllow: boolean;
    providerMetadata: Record<string, unknown>;
    eventDescription: string;
    signal?: AbortSignal;
  },
): Promise<{ outcome: "allow" | "deny" } | { outcome: "unasked"; error: string }> {
  let response: Awaited<ReturnType<MacDesktopRequestChatInput>>;
  try {
    response = await requestChatInput({
      chatSessionId: args.chatSessionId,
      title: args.title,
      body: args.body,
      questions: [{
        id: args.questionId,
        header: args.header,
        question: args.question,
        options: [
          // The card draws the question and its options, not the body: what
          // Allow means for the user rides on the Allow option.
          { label: "Allow", value: "allow", description: args.body, recommended: args.recommendAllow },
          { label: "Don't allow", value: "deny" },
        ],
        allowsFreeform: false,
      }],
      providerMetadata: args.providerMetadata,
      eventDescription: args.eventDescription,
      eventDetail: args.providerMetadata,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (error) {
    return { outcome: "unasked", error: error instanceof Error ? error.message : String(error) };
  }
  if (response.decision === "decline" || response.decision === "cancel") return { outcome: "deny" };
  const picked = (response.answers?.[args.questionId] ?? []).map((value) => value.trim().toLowerCase());
  return { outcome: picked.includes("allow") && !picked.includes("deny") ? "allow" : "deny" };
}

export type MacDesktopLeaseFlowDeps = {
  logger: Logger;
  isDarwin: boolean;
  leases: MacDesktopLeaseRegistry;
  emit: (payload: MacDesktopEventPayload) => void;
  requireDisplay: (laneId: string) => void;
  /** The backend only if it is already up. */
  activeProvider: () => DesktopSeatProvider | null;
  requestChatInput?: MacDesktopRequestChatInput | null;
  /** The seat host. Defaults to a Mac. */
  platform?: NodeJS.Platform;
  /** Windows: which seat the lane's screen is, or null. */
  seatModeOf?: ((laneId: string) => WindowsDesktopSeatMode | null) | null;
  /** Mints the service's own error, so this module owns no error class. */
  serviceError?: ((code: string, message: string) => Error) | null;
};

export function createMacDesktopLeaseFlow(deps: MacDesktopLeaseFlowDeps) {
  const serviceError = (code: string, message: string): Error =>
    deps.serviceError ? deps.serviceError(code, message) : Object.assign(new Error(`${code}: ${message}`), { code });

  /**
   * Windows: chats whose user allowed the shared seat for a lane, through the
   * ask card. Not cleared when the screen stops, so the same chat is not asked
   * twice; cleared when the chat closes. In memory only.
   */
  const sharedConsentChats = new Map<string, Set<string>>();
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
    // The pointer in the picture follows the same transition, and follows it
    // here rather than at each of the six call sites that move a lease: take
    // control, give it back, let it lapse, drop it on a clock jump, hand it to
    // an agent, or lose it with the chat that held it all end in this function.
    // A failure is logged and not thrown — a stream that keeps drawing the old
    // cursor state is a cosmetic fault, and failing the takeover over it would
    // be a real one.
    try {
      await provider.setStreamCursorVisible({ laneId, visible: lease?.holder === "user" });
    } catch (error) {
      deps.logger.debug("mac_desktop.cursor_visibility_push_failed", {
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
      const windowsHost = deps.platform === "win32";
      const seatMode = windowsHost ? deps.seatModeOf?.(laneId) ?? null : null;
      // A Windows private seat is its own session with its own pointer and
      // keyboard: there is nothing of the user's to ask about.
      if (seatMode === "private") {
        return {
          granted: true,
          code: null,
          lease: deps.leases.get(laneId),
          notRequired: true,
          message: "This lane's private Windows screen has its own pointer and keyboard; real input needs no lease here.",
        };
      }
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
      // A shared seat exists only after the user consented to it for this lane,
      // and that consent is the permission this card would ask for again. It
      // covers the chats of that lane, never a caller with no chat.
      if (seatMode === "shared") {
        if (chatSessionId === MAC_DESKTOP_ANONYMOUS_HOLDER_ID) return refuse();
        deps.leases.approveChat(laneId, chatSessionId);
        return grantNow();
      }

      // An automation's synthetic holder (`automation:<ruleId>`) is not a chat,
      // so there is nobody to show a card to: asking would throw "chat not
      // found" *after* a `lease-requested` event had already told the UI a card
      // was coming. A host with no `requestChatInput` wired has no card either,
      // so it refuses here too rather than after the event.
      if (chatSessionId.startsWith(AUTOMATION_CHAT_SESSION_PREFIX) || !deps.requestChatInput) {
        return refuse();
      }
      const reason = args.reason?.trim() || "drive this display with real pointer and keyboard input";
      const product = desktopProductName(deps.platform);
      deps.emit({ type: "lease-requested", laneId, chatSessionId, reason: args.reason?.trim() ?? null });
      const answer = await askChatAllowDeny(deps.requestChatInput, {
        chatSessionId,
        title: "Real input on the lane's display",
        body: windowsHost
          ? `ADE would like to ${reason}. Accessibility actions do not need this; real pointer and keyboard events do, and they are global to this PC.`
          // A Mac has one pointer. The card is the user's only warning that
          // saying yes lets the agent move it, which is what took one user's
          // mouse three times in a row while they were working.
          : `ADE would like to ${reason}. While it acts, your mouse pointer jumps onto the lane's screen for each click. Clicks, scrolls and drags inside the lane's own apps do not need this; only a hover or a drop onto another app does.`,
        questionId: "mac_desktop_input_lease",
        header: "Real input",
        question: `Allow this chat to use real pointer and keyboard input on its ${product} display?`,
        recommendAllow: true,
        providerMetadata: { [MAC_DESKTOP_INPUT_LEASE_METADATA_KEY]: true, laneId },
        eventDescription: `Allow real input on the ${product} display for ${reason}?`,
      });
      if (answer.outcome === "unasked") {
        // The chat could be gone by the time the lease is asked for. A missing
        // chat is not an approval, and it is not a crash either: it is the same
        // "nobody said yes" the decline path returns.
        deps.logger.warn("mac_desktop.lease_prompt_failed", { laneId, error: answer.error });
        return refuse();
      }
      if (answer.outcome !== "allow") return refuse();
      deps.leases.approveChat(laneId, chatSessionId);
      return grantNow();
    },

    /**
     * Windows: the agent's way to the shared seat. The user's Allow on a card
     * in the calling chat is the consent; the agent cannot supply it.
     *
     * The card is withdrawn after {@link WINDOWS_DESKTOP_SHARED_CONSENT_WAIT_MS},
     * before the caller's own wait ends, so a late Allow cannot start a seat
     * nobody is waiting for.
     */
    async requestSharedSeat(args: {
      laneId: string;
      chatSessionId: string | null | undefined;
      reason: string | null | undefined;
      startShared: (chatSessionId: string) => Promise<MacDesktopStatus>;
    }): Promise<MacDesktopStatus> {
      const laneId = args.laneId;
      const chatSessionId = args.chatSessionId?.trim() || "";
      const existing = deps.seatModeOf?.(laneId) ?? null;
      if (existing === "shared") return await args.startShared(chatSessionId);
      if (existing === "private") throw privateSeatAlreadyRunning();
      if (chatSessionId && sharedConsentChats.get(laneId)?.has(chatSessionId)) return await args.startShared(chatSessionId);
      if (!chatSessionId || chatSessionId.startsWith(AUTOMATION_CHAT_SESSION_PREFIX) || !deps.requestChatInput) {
        throw serviceError(
          WINDOWS_DESKTOP_CONSENT_REQUIRED_CODE,
          "Using the main Windows desktop needs the user's consent, and there is no chat to ask in.",
        );
      }
      const reason = args.reason?.trim() || null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WINDOWS_DESKTOP_SHARED_CONSENT_WAIT_MS);
      timer.unref?.();
      let answer: Awaited<ReturnType<typeof askChatAllowDeny>>;
      try {
        answer = await askChatAllowDeny(deps.requestChatInput, {
          chatSessionId,
          title: "Use your main Windows desktop?",
          body: `${WINDOWS_DESKTOP_SHARED_CONSENT_MESSAGE}${reason ? ` The agent wants to: ${reason}.` : ""} You can stop it at any time from the Windows Desktop pane.`,
          questionId: "windows_desktop_shared_consent",
          header: "Main desktop",
          question: "Allow this chat's lane to use your main Windows desktop?",
          recommendAllow: false,
          providerMetadata: { [WINDOWS_DESKTOP_SHARED_CONSENT_METADATA_KEY]: true, laneId },
          eventDescription: "Allow this lane to use your main Windows desktop?",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (answer.outcome === "unasked") {
        deps.logger.warn("mac_desktop.shared_consent_prompt_failed", { laneId, error: answer.error });
        throw serviceError(WINDOWS_DESKTOP_CONSENT_REQUIRED_CODE, "The user was not asked: the chat could not show the card.");
      }
      if (answer.outcome !== "allow") {
        throw serviceError(
          WINDOWS_DESKTOP_CONSENT_REQUIRED_CODE,
          controller.signal.aborted
            ? "The user did not answer the main-desktop card in time, so it was withdrawn."
            : "The user did not allow the main Windows desktop. Do not ask again in this turn; tell the user what you could not do.",
        );
      }
      // A private screen may have started on this lane while the card waited.
      if (deps.seatModeOf?.(laneId) === "private") throw privateSeatAlreadyRunning();
      const chats = sharedConsentChats.get(laneId) ?? new Set<string>();
      chats.add(chatSessionId);
      sharedConsentChats.set(laneId, chats);
      const status = await args.startShared(chatSessionId);
      // A start already in flight for this lane is joined, and it may have
      // been a private one. Never report a private screen as the shared seat.
      if (status.display && status.display.seatMode !== "shared") throw privateSeatAlreadyRunning();
      return status;
    },

    /** A closed chat's shared-seat consent goes with it. */
    forgetChat(chatSessionId: string): void {
      for (const [laneId, chats] of [...sharedConsentChats]) {
        if (chats.delete(chatSessionId) && chats.size === 0) sharedConsentChats.delete(laneId);
      }
    },
  };

  function privateSeatAlreadyRunning(): Error {
    return serviceError(WINDOWS_DESKTOP_CONSENT_REQUIRED_CODE, WINDOWS_DESKTOP_PRIVATE_ALREADY_RUNNING_MESSAGE);
  }
}

export type MacDesktopLeaseFlow = ReturnType<typeof createMacDesktopLeaseFlow>;
