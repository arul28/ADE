import type {
  DiagnosticReportPayload,
  DiagnosticReportRequestPayload,
  DiagnosticsManualSendResult,
} from "../../../shared/types/diagnostics";
import { diagnosticReference } from "../../../shared/diagnosticsUpload";
import { captureUserFeedback, isSentryActive } from "../../../shared/sentry/capture";
import { resolveSentryUserId } from "../../../shared/sentry/eventFilter";
import { scrubFreeText, scrubString } from "../../../shared/sentry/scrub";

declare const __ADE_WEB_VERSION__: string | undefined;

/** Where the desktop files its issues too (`DIAGNOSTIC_ISSUE_REPO` in the CLI's report builder). */
const ISSUE_REPO = "arul28/ADE";
/** Sentry stores a feedback message of a few thousand characters; the desktop caps a note at 2,000. */
const REPORT_MAX_CHARS = 2_000;
const DETAIL_MAX_CHARS = 1_200;

/**
 * "Report issue" in the hosted web client.
 *
 * The desktop builds its report in the main process and uploads it to the
 * account directory. A browser has neither: no logs or local service to
 * collect, and the directory refuses uploads from another site's page. What
 * the web client does have is its own Sentry (`ade-web`), which already holds
 * the crash with its stack, screen and release. So the report goes there as
 * User Feedback, beside the crash event, and its id is the reference.
 *
 * `sendManual` exists only while Sentry runs (production, no Do Not Track, no
 * analytics opt-out); otherwise the button opens the GitHub issue instead.
 * The automatic report is the crash boundary's own Sentry capture, so
 * `autoReport` has nothing more to do here.
 */
export function createDiagnosticsNamespace() {
  return {
    get sendManual() {
      return isSentryActive() ? sendManual : undefined;
    },
    openIssue,
    autoReport: async (_context: DiagnosticReportRequestPayload): Promise<void> => undefined,
  };
}

async function sendManual(context?: DiagnosticReportRequestPayload): Promise<DiagnosticsManualSendResult> {
  const report = buildWebReport(context);
  const feedbackId = captureUserFeedback({
    message: report,
    source: "report_issue",
    userId: resolveSentryUserId(),
    tags: {
      "report.surface": scrubString(context?.surface ?? "web_manual"),
      ...(context?.code ? { "report.code": scrubString(context.code) } : {}),
    },
  });
  if (!feedbackId) return { ok: false, reason: "failed", report };
  return { ok: true, reference: diagnosticReference(feedbackId), reportPath: "", report };
}

async function openIssue(context: DiagnosticReportRequestPayload): Promise<DiagnosticReportPayload> {
  const report = buildWebReport(context);
  const issueUrl = buildIssueUrl(context);
  // Both before the first await: a browser lets a page open a tab or write the
  // clipboard only inside the click that asked for it. The copy starts first,
  // while this tab still has focus.
  const copying: Promise<boolean> = navigator.clipboard
    ? navigator.clipboard.writeText(report).then(() => true, () => false)
    : Promise.resolve(false);
  let opened = false;
  try {
    // `noopener` makes window.open return null, so a blocked tab looks the same as an open one.
    window.open(issueUrl, "_blank", "noopener,noreferrer");
    opened = true;
  } catch {
    opened = false;
  }
  const copied = await copying;
  return { report, filePath: "", issueUrl, installId: "", copied, opened };
}

function webVersion(): string {
  return typeof __ADE_WEB_VERSION__ === "string" && __ADE_WEB_VERSION__ ? __ADE_WEB_VERSION__ : "unknown";
}

/**
 * The browser's view of the failure: what a person could paste themselves.
 * The screen's own words go through the free-text scrub (paths, emails,
 * secrets); the rest only through the secret scrub, so a route such as
 * `/lanes/<id>` stays readable.
 */
function buildWebReport(context?: DiagnosticReportRequestPayload): string {
  const detail = context?.technicalDetail?.trim();
  const freeText = (text: string, maxLength: number) => scrubFreeText(text, { maxLength });
  const lines = [
    "ADE web report",
    "",
    `- Surface: ${scrubString(context?.surface ?? "web_manual")}`,
    ...(context?.headline ? [`- What went wrong: ${freeText(context.headline, 300)}`] : []),
    ...(context?.code ? [`- Code: ${scrubString(context.code)}`] : []),
    `- ADE web version: ${webVersion()}`,
    `- Browser: ${typeof navigator === "undefined" ? "unknown" : navigator.userAgent}`,
    `- Screen: ${scrubString(window.location.pathname)}`,
    `- Time: ${new Date().toISOString()}`,
    ...(detail ? ["", "Technical detail:", freeText(detail, DETAIL_MAX_CHARS)] : []),
  ];
  return lines.join("\n").slice(0, REPORT_MAX_CHARS);
}

function buildIssueUrl(context: DiagnosticReportRequestPayload): string {
  const url = new URL(`https://github.com/${ISSUE_REPO}/issues/new`);
  url.searchParams.set("title", `Web: ${scrubString(context.headline ?? context.surface).slice(0, 120)}`);
  url.searchParams.set("labels", "bug");
  url.searchParams.set("body", [
    "<!-- Paste the report from your clipboard below. -->",
    "",
    "**What I was doing:**",
    "",
    "",
    "---",
    "",
    `- Surface: ${context.surface}`,
    `- ADE web version: ${webVersion()}`,
    "",
    "Paste the report from your clipboard here:",
    "",
  ].join("\n"));
  return url.toString();
}
