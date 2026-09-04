import type { DiagnosticsManualSendResult } from "./types/diagnostics";

/**
 * One short sentence per outcome of a report a person asked ADE to send.
 *
 * Shared rather than written per screen: the same five answers come back
 * whether the button was pressed in Settings or on a screen that had just
 * crashed, and a user who sees two different sentences for one server reply
 * learns nothing from either.
 *
 * The two refusals a person can act on differently are deliberately worded
 * differently: `rate_limited` is the account directory saying THIS computer has
 * spent its allowance today, `unavailable` is it saying it is not taking
 * reports from anyone right now. The route answers those as two distinct 429
 * bodies precisely so a client can tell them apart, and telling someone to come
 * back tomorrow when the truth is "ADE is full" would waste their time.
 */
export function describeManualDiagnosticsSendFailure(
  result: Extract<DiagnosticsManualSendResult, { ok: false }>,
): string {
  switch (result.reason) {
    case "local_limit":
      return `You've already sent ${result.limit ?? 5} reports from this computer today. Try again tomorrow.`;
    case "rate_limited":
      return "You've already sent several reports today. Try again tomorrow.";
    case "unavailable":
      return "ADE isn't accepting reports right now. Try again later.";
    case "too_large":
      // Two situations, and only one of them leaves the user something to do.
      // The local copy is written before the upload is attempted, so it usually
      // exists — but when it could not be written the main process answers
      // without a path, and telling someone to open a file that is not there
      // sends them looking for it. The offer is made only when it is real.
      return result.reportPath
        ? "This report is too big to send. It's saved on this computer — open it and attach it to a GitHub issue."
        : "This report is too big to send, and ADE couldn't save a copy on this computer.";
    default:
      return "ADE couldn't send the report. Check your connection and try again.";
  }
}
