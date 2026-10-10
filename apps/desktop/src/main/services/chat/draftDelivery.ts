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

/**
 * Whether every image this draft carries is readable on this machine.
 *
 * A runtime that does not own a draft's image bytes is handed the row with the
 * references stripped, so a short list is not "nothing to attach" — it is "the
 * images are somewhere else". Comparing the stored count catches that; without
 * it the send would quietly deliver the text alone.
 */
export function draftAttachmentsReady(
  draft: Pick<DraftEntry, "attachments" | "attachmentCount">,
  exists: (path: string) => boolean,
): boolean {
  if ((draft.attachmentCount ?? 0) > (draft.attachments?.length ?? 0)) return false;
  return (draft.attachments ?? []).every((attachment) => (
    attachment.type !== "image" || exists(attachment.path)
  ));
}

/**
 * Raised by a host that permanently cannot deliver this shape of send — it has
 * no chat launcher, or the row names no model to start one with. Delivery
 * reports it as `blocked` (the user must act) instead of retrying, because no
 * amount of retrying gives that host the capability.
 */
export class DraftDeliveryUnsupportedError extends Error {}

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
 * Ordering matters. The lateness policy is checked first: a `strict` or expired
 * `grace` window has to resolve to `missed`, and an image that never arrives
 * must not hold such a send open forever. Images come next — the user's choice
 * is to hold rather than send a prompt missing an attachment — and only then
 * the target, so a strict schedule that blew its window is reported as missed
 * even if the chat is also gone, and a deleted chat blocks rather than throws.
 */
export async function deliverDraft(
  draft: DraftEntry,
  deps: DraftDeliveryDeps,
): Promise<DraftDeliveryOutcome> {
  const nowMs = deps.now();
  const fireAt = draft.scheduledAt ? Date.parse(draft.scheduledAt) : Number.NaN;
  const latenessMs = Number.isFinite(fireAt) ? nowMs - fireAt : 0;

  const late = isLate(latenessMs, draft);
  if (late) return late;

  if (!deps.attachmentsReady(draft)) {
    return {
      status: "retry",
      error: "Waiting for this send's images to reach this machine.",
    };
  }

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
    if (error instanceof DraftDeliveryUnsupportedError) {
      // Retrying cannot help; surface it so the row says why.
      return { status: "blocked", error: message };
    }
    // A throw is a transport/session problem, not a decision — keep the send
    // armed and try again rather than losing the message.
    return { status: "retry", error: message };
  }
}
