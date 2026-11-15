/**
 * One Sentry User Feedback entry per manual report, in the `ade-desktop`
 * project, beside the report's R2 upload (which is unchanged): the person's
 * own words from the report dialog or Settings' "Send a report", or
 * `NO_NOTE_FEEDBACK_MESSAGE` when they wrote none, so the team sees every
 * report that was sent.
 *
 * Sent from this app's main process only: a report describes this window and
 * this computer, whichever machine the screen was showing. It goes only where
 * main's Sentry client runs, so `DO_NOT_TRACK`, `ADE_SENTRY_DISABLED`, an
 * earlier opt-out and dev builds all keep it home (`initMain.ts`). Feedback
 * skips `beforeSend`, so the text is scrubbed here (secrets, emails, paths)
 * and the user set here, to the same pseudonymous id every other event carries.
 */
import { captureUserFeedback, isSentryActive, resolveSentryUserId, SENTRY_FEEDBACK_MAX_CHARS } from "../../shared/sentry/capture";
import { scrubFreeText, scrubString } from "../../shared/sentry/scrub";

/** Longest note sent. */
export const USER_FEEDBACK_MAX_CHARS = SENTRY_FEEDBACK_MAX_CHARS;

/** The note for a successful send with no words of the person's own. */
export const NO_NOTE_FEEDBACK_MESSAGE = "Report sent with no note.";

/** A "Try again" within this window resends the report, not the note. */
const RETRY_WINDOW_MS = 10 * 60_000;

let lastSent: { message: string; atMs: number; reference: string | null } | null = null;

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
  if (!message) return null;
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.tags ?? {})) {
    // Feedback skips `beforeSend`, so the renderer-supplied labels are scrubbed here too.
    if (typeof value === "string" && value.trim()) tags[key] = scrubString(value.trim().slice(0, 200));
  }
  // "Try again" sends the report again, not the note, unless the note went
  // out without a report reference and this attempt has one: then it goes
  // again, so the report that arrived has its note. A different reference is
  // a different report, never a retry, so it always gets its own entry.
  const reference = tags["report.reference"] ?? null;
  if (
    lastSent?.message === message
    && Date.now() - lastSent.atMs < RETRY_WINDOW_MS
    && (lastSent.reference === reference || (lastSent.reference !== null && reference === null))
  ) return null;
  const feedbackId = captureUserFeedback({
    message,
    source: "send_a_report",
    userId: resolveSentryUserId(),
    tags,
    onError: args.onError,
  });
  if (feedbackId) lastSent = { message, atMs: Date.now(), reference };
  return feedbackId;
}
