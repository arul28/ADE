import type { BannerModel } from "./Banner";
import type { NoticeReport } from "./NoticeReport";

/**
 * What a message a surface shows is, which decides how it looks, so a typo or
 * an offline machine does not read like ADE crashed:
 *
 * - `failure`  ADE tried and something broke. Red, "Report", a Sentry log.
 * - `status`   Nothing broke, but something is in the way or still going (a
 *              machine is offline, a send is slow, a delete left files behind).
 *              Amber; no "Report" unless the owner passes one.
 * - `hint`     The person has something to fix (no model picked, a missing
 *              title). Neutral, no "Report".
 */
export type NoticeKind = "failure" | "status" | "hint";

/** The tone and report a Banner gets for a message of this kind. */
export function noticeKindModel(
  kind: NoticeKind,
  /** A failure's report, or a status that is still worth reporting. */
  report?: NoticeReport,
): Pick<BannerModel, "tone" | "report"> {
  if (kind === "failure") return { tone: "error", report };
  if (kind === "status") return { tone: "warning", report: report ?? false };
  return { tone: "info", report: false };
}
