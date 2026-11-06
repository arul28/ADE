import type {
  DiagnosticReportPayload,
  DiagnosticReportRequestPayload,
  DiagnosticsManualSendResult,
} from "../../../shared/types/diagnostics";
import { MAX_DIAGNOSTIC_REPORTS_PER_DAY } from "../../../shared/diagnosticsUpload";
import { ADE_GITHUB_URL } from "../../../shared/productLinks";
import {
  captureUserFeedback,
  confirmSentryDelivery,
  isSentryActive,
  resolveSentryUserId,
  SENTRY_FEEDBACK_MAX_CHARS,
} from "../../../shared/sentry/capture";
import { scrubFreeText, scrubString } from "../../../shared/sentry/scrub";
import { webClientVersion } from "../../lib/webClientMode";
import type { AdeNamespace } from "./types";

/** A report sent with no screen behind it; the desktop's equivalent is `settings_manual`. */
const MANUAL_SURFACE = "web_manual";
const DETAIL_MAX_CHARS = 1_200;
const SENDS_KEY = "ade:web-report-sends";
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * "Report issue" in the hosted web client.
 *
 * The desktop builds its report in the main process and uploads it to the
 * account directory. A browser has neither: no logs or local service to
 * collect, and the directory refuses uploads from another site's page. What
 * the web client does have is its own Sentry (`ade-web`), which already holds
 * the crash with its stack, screen and release. So the report goes there as
 * User Feedback beside the crash event, under a reference it is tagged with.
 *
 * `sendManual` is a getter because the web client's Sentry loads after the
 * first paint and only where the person allows it (production, no Do Not
 * Track, no analytics opt-out). Until then it is absent and the button opens
 * the GitHub issue instead. There is no `autoReport`: the crash boundary's own
 * Sentry capture is the automatic report here, and the boundaries skip the
 * call when the member is missing.
 */
export function createDiagnosticsNamespace(): AdeNamespace<"diagnostics"> {
  return {
    get sendManual() {
      return isSentryActive() ? sendManual : undefined;
    },
    openIssue,
  };
}

async function sendManual(context?: DiagnosticReportRequestPayload): Promise<DiagnosticsManualSendResult> {
  const report = buildWebReport(context);
  if (sendsToday().length >= MAX_DIAGNOSTIC_REPORTS_PER_DAY) {
    return { ok: false, reason: "local_limit", limit: MAX_DIAGNOSTIC_REPORTS_PER_DAY, report };
  }
  // Ours, not Sentry's event id: support finds the note by this tag, and an
  // event id prefix is not searchable.
  const reference = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const feedbackId = captureUserFeedback({
    message: report,
    source: "report_issue",
    userId: resolveSentryUserId(),
    associatedEventId: context?.sentryEventId,
    tags: {
      "report.surface": scrubString(context?.surface ?? MANUAL_SURFACE),
      "report.reference": reference,
      ...(context?.code ? { "report.code": scrubString(context.code) } : {}),
    },
    onError: (error) => console.warn("[ade-web] report feedback failed", error),
  });
  // The reference is only worth showing once Sentry has the note: an ad
  // blocker or a dropped connection must read as a failed send.
  if (!(await confirmSentryDelivery(feedbackId))) return { ok: false, reason: "failed", report };
  recordSend();
  return { ok: true, reference, reportPath: "", report };
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
  // No `noopener` in the features: with it the call returns null either way,
  // and a blocked tab must not read as an open one. The opener is cut by hand.
  const tab = window.open(issueUrl, "_blank");
  if (tab) tab.opener = null;
  return { report, filePath: "", issueUrl, installId: "", copied: await copying, opened: Boolean(tab) };
}

/** Delivered sends in the last day, from this browser. */
function sendsToday(): number[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(SENDS_KEY) ?? "[]");
    const now = Date.now();
    return Array.isArray(stored)
      ? stored.filter((at): at is number => typeof at === "number" && now - at < DAY_MS)
      : [];
  } catch {
    return [];
  }
}

function recordSend(): void {
  try {
    window.localStorage.setItem(SENDS_KEY, JSON.stringify([...sendsToday(), Date.now()]));
  } catch (error) {
    // Storage off: the cap is only as good as this browser allows.
    console.warn("[ade-web] report send count not saved", error);
  }
}

/**
 * The browser's view of the failure: what a person could paste themselves.
 * The screen's own words go through the free-text scrub (paths, emails,
 * secrets); the rest only through the secret scrub, so a route such as
 * `/lanes/<id>` stays readable.
 */
function buildWebReport(context?: DiagnosticReportRequestPayload): string {
  const detail = context?.technicalDetail?.trim();
  const lines = [
    "ADE web report",
    "",
    `- Surface: ${scrubString(context?.surface ?? MANUAL_SURFACE)}`,
    ...(context?.headline ? [`- What went wrong: ${scrubFreeText(context.headline, { maxLength: 300 })}`] : []),
    ...(context?.code ? [`- Code: ${scrubString(context.code)}`] : []),
    `- ADE web version: ${webClientVersion() ?? "unknown"}`,
    `- Browser: ${navigator.userAgent}`,
    `- Screen: ${scrubString(window.location.pathname)}`,
    `- Time: ${new Date().toISOString()}`,
    ...(detail ? ["", "Technical detail:", scrubFreeText(detail, { maxLength: DETAIL_MAX_CHARS })] : []),
  ];
  return lines.join("\n").slice(0, SENTRY_FEEDBACK_MAX_CHARS);
}

/**
 * The web cut of the desktop's issue link (`buildDiagnosticIssueUrl` in the
 * CLI's report builder): no platform or install id, which a browser does not
 * have. The title is a public GitHub field, so it gets the free-text scrub.
 */
function buildIssueUrl(context: DiagnosticReportRequestPayload): string {
  const url = new URL(`${ADE_GITHUB_URL}/issues/new`);
  url.searchParams.set("title", `Web: ${scrubFreeText(context.headline || context.surface).slice(0, 120)}`);
  url.searchParams.set("labels", "bug");
  url.searchParams.set("body", [
    "<!-- Paste the report from your clipboard below. -->",
    "",
    "**What I was doing:**",
    "",
    "",
    "---",
    "",
    `- Surface: ${scrubString(context.surface)}`,
    `- ADE web version: ${webClientVersion() ?? "unknown"}`,
    "",
    "Paste the report from your clipboard here:",
    "",
  ].join("\n"));
  return url.toString();
}
