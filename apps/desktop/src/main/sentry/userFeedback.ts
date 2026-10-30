/**
 * The person's own words from "Send a report", as Sentry User Feedback in the
 * `ade-desktop` project, beside the report's R2 upload (which is unchanged).
 *
 * Sent from this app's main process only: a report describes this window and
 * this computer, whichever machine the screen was showing. It goes only where
 * main's Sentry client runs, so `DO_NOT_TRACK`, `ADE_SENTRY_DISABLED`, an
 * earlier opt-out and dev builds all keep it home (`initMain.ts`). Feedback
 * skips `beforeSend`, so the text is scrubbed here (secrets, emails, paths)
 * and the user set here, to the same pseudonymous id every other event carries.
 */
import { captureUserFeedback, isSentryActive } from "../../shared/sentry/capture";
import { resolveSentryUserId } from "../../shared/sentry/eventFilter";
import { scrubFreeText } from "../../shared/sentry/scrub";

/** Longest note sent. */
export const USER_FEEDBACK_MAX_CHARS = 2_000;

let lastSentMessage: string | null = null;

/** Returns the feedback id, or null when nothing was sent. */
export function sendSentryUserFeedback(args: {
  message: unknown;
  /** The report's surface and code, and its R2 reference so the note matches its upload. */
  tags?: Record<string, string | null | undefined>;
  /** Told when the SDK throws; the report itself is unaffected. */
  onError?: (error: unknown) => void;
}): string | null {
  if (!isSentryActive() || typeof args.message !== "string") return null;
  const message = scrubFreeText(args.message.trim().slice(0, USER_FEEDBACK_MAX_CHARS), {
    maxLength: USER_FEEDBACK_MAX_CHARS,
  });
  // "Try again" after a failed upload sends the report again, not the note.
  if (!message || message === lastSentMessage) return null;
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.tags ?? {})) {
    if (typeof value === "string" && value.trim()) tags[key] = value.trim().slice(0, 200);
  }
  const feedbackId = captureUserFeedback({
    message,
    source: "send_a_report",
    userId: resolveSentryUserId(),
    tags,
    onError: args.onError,
  });
  if (feedbackId) lastSentMessage = message;
  return feedbackId;
}
