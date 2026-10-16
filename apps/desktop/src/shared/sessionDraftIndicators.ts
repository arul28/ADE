/**
 * The draft / outbox marks a session row may carry.
 *
 * Drafts persist per session (`COMPOSER_DRAFT_STORAGE_KEY_PREFIX`) and messages
 * typed before a new-lane chat exists sit in `chatLaunchStore`'s queue, but
 * nothing in the session list said which thread held either. This module is the
 * one derivation from those two facts, so the row, the hover card, and tests
 * cannot disagree about when a mark appears or what it says.
 *
 * It is pure and icon-free: the caller owns the glyph, this owns the words.
 */

export type SessionRowIndicatorKind = "draft" | "outbox";

export type SessionRowIndicator = {
  kind: SessionRowIndicatorKind;
  /** Short label for the row's accessible name. */
  label: string;
  /** Full sentence for the tooltip / hover card. */
  title: string;
};

export function deriveSessionRowIndicators(args: {
  /** The session has composer text, attachments, or context staged but unsent. */
  hasDraft: boolean;
  /** Messages queued for delivery by the launch store. */
  queuedCount: number;
  /** At least one queued message is being delivered right now. */
  queuedSending?: boolean;
  /** At least one queued message failed its last delivery attempt. */
  queuedFailed?: boolean;
}): SessionRowIndicator[] {
  const indicators: SessionRowIndicator[] = [];
  if (args.hasDraft) {
    indicators.push({
      kind: "draft",
      label: "Draft",
      title: "Unsent draft",
    });
  }
  if (args.queuedCount > 0) {
    const noun = args.queuedCount === 1 ? "message" : "messages";
    let title: string;
    if (args.queuedFailed) {
      title = `${args.queuedCount} queued ${noun} — delivery failed`;
    } else if (args.queuedSending) {
      title = `Sending ${args.queuedCount} queued ${noun}`;
    } else {
      title = `${args.queuedCount} ${noun} waiting to send`;
    }
    indicators.push({
      kind: "outbox",
      label: args.queuedCount > 1 ? `${args.queuedCount} queued` : "Queued",
      title,
    });
  }
  return indicators;
}
