import type { AgentChatFileRef, DraftEntry } from "../../../shared/types/chat";
import type { Logger } from "../logging/logger";

/**
 * What happened when a scheduled send was attempted.
 *
 * `sent`, `missed` and `blocked` are terminal for the scheduler: it stops
 * retrying and the row states its own reason. `retry` is transient — the row
 * stays armed and the scheduler comes back to it, which is how "wait for me"
 * behaves when a chat is mid-turn or an image has not replicated yet.
 */
export type DraftDeliveryOutcome =
  | { status: "sent"; firedAt: string }
  | { status: "blocked"; error: string }
  | { status: "missed"; error: string }
  | { status: "retry"; error: string }
  /**
   * Another pass already owns this send. Never written back to the row — the
   * runtime that owns it must not have its claim recorded over.
   */
  | { status: "skipped"; error: string };

export type DraftDeliveryDeps = {
  now: () => number;
  /** Whether the chat a schedule points at still exists and can receive a turn. */
  targetChatExists: (sessionId: string) => boolean;
  /** Deliver the draft into an existing chat as a real user turn. */
  sendToChat: (args: {
    sessionId: string;
    text: string;
    attachments: AgentChatFileRef[];
  }) => Promise<void>;
  /** Create the chat the schedule asked for, then deliver into it. */
  createChatAndSend: (args: {
    laneId: string;
    text: string;
    attachments: AgentChatFileRef[];
    provider: string | null;
    /** Runtime-facing model string; a new chat cannot be created without one. */
    model: string | null;
    modelId: string | null;
    permissionMode: string | null;
    thinking: string | null;
  }) => Promise<void>;
  /**
   * False when an image this draft carries is not readable on this machine
   * yet. The send holds rather than delivering an incomplete prompt.
   */
  attachmentsReady: (draft: DraftEntry) => boolean;
  logger: Pick<Logger, "warn" | "info">;
};

function isLate(latenessMs: number, draft: DraftEntry): DraftDeliveryOutcome | null {
  if (latenessMs <= 0) return null;
  const policy = draft.deliveryPolicy ?? "wait";
  if (policy === "strict") {
    return { status: "missed", error: "Its send time passed before this machine could deliver it." };
  }
  if (policy === "grace") {
    const graceMs = Math.max(0, draft.graceSeconds ?? 0) * 1000;
    if (latenessMs > graceMs) {
      return { status: "missed", error: "Its send time passed before this machine could deliver it." };
    }
  }
  // "wait", or a grace window that has not run out yet: deliver late.
  return null;
}

/**
 * Attempt one scheduled send.
 *
 * Ordering matters. Images are checked first because the user's choice is to
 * hold rather than send a prompt with a missing attachment. The lateness policy
 * is checked before the target so a strict schedule that blew its window is
 * reported as missed even if the chat is also gone. The target check runs last,
 * immediately before the send, so a deleted chat blocks rather than throwing.
 */
export async function deliverDraft(
  draft: DraftEntry,
  deps: DraftDeliveryDeps,
): Promise<DraftDeliveryOutcome> {
  const nowMs = deps.now();
  const fireAt = draft.scheduledAt ? Date.parse(draft.scheduledAt) : Number.NaN;
  const latenessMs = Number.isFinite(fireAt) ? nowMs - fireAt : 0;

  if (!deps.attachmentsReady(draft)) {
    return {
      status: "retry",
      error: "Waiting for this send's images to reach this machine.",
    };
  }

  const late = isLate(latenessMs, draft);
  if (late) return late;

  const attachments = draft.attachments ?? [];
  try {
    if (draft.targetKind === "new") {
      if (!draft.targetLaneId) {
        return { status: "blocked", error: "This send has no lane to start a new chat in." };
      }
      await deps.createChatAndSend({
        laneId: draft.targetLaneId,
        text: draft.text,
        attachments,
        provider: draft.provider,
        model: draft.model ?? null,
        modelId: draft.modelId,
        permissionMode: draft.permissionMode ?? null,
        thinking: draft.thinking ?? null,
      });
    } else {
      const sessionId = draft.targetSessionId?.trim();
      if (!sessionId) {
        return { status: "blocked", error: "This send has no chat to go to. Pick one." };
      }
      if (!deps.targetChatExists(sessionId)) {
        return { status: "blocked", error: "The chat this send was aimed at is gone. Pick another target." };
      }
      await deps.sendToChat({ sessionId, text: draft.text, attachments });
    }
    return { status: "sent", firedAt: new Date(nowMs).toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn("draft.deliver_failed", { draftId: draft.id, message });
    // A throw is a transport/session problem, not a decision — keep the send
    // armed and try again rather than losing the message.
    return { status: "retry", error: message };
  }
}
