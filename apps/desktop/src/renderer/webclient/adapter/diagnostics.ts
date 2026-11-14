import type {
  DiagnosticReportRequestPayload,
  DiagnosticsManualSendOptions,
  DiagnosticsManualSendResult,
  DiagnosticsPrepareResult,
} from "../../../shared/types/diagnostics";
import { MAX_DIAGNOSTIC_REPORTS_PER_DAY } from "../../../shared/diagnosticsUpload";
import { buildPublicIssueUrl, osFamilyOf } from "../../../shared/publicIssueLink";
import {
  captureUserFeedback,
  confirmSentryDelivery,
  isSentryActive,
  resolveSentryUserId,
  SENTRY_FEEDBACK_MAX_CHARS,
} from "../../../shared/sentry/capture";
import { scrubFreeText, scrubString } from "../../../shared/sentry/scrub";
import { webClientVersion } from "../../lib/webClientMode";
import type { WebAnalyticsNamespace } from "./analytics";
import type { AdeNamespace } from "./types";

/** A report sent with no screen behind it; the desktop's equivalent is `settings_manual`. */
const MANUAL_SURFACE = "web_manual";
const DETAIL_MAX_CHARS = 1_200;
const SENDS_KEY = "ade:web-report-sends";
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
/** As on desktop: a prepared report waits this long for Send. */
const PREPARED_TTL_MS = 10 * 60_000;
const MAX_PREPARED = 4;
/** Between the person's note and the report in the one Sentry note. */
const NOTE_SEPARATOR = "\n\n---\n\n";

type PreparedWebReport = {
  report: string;
  context: DiagnosticReportRequestPayload | undefined;
  expiresAtMs: number;
};

/**
 * "Report this error to ADE…" in the hosted web client.
 *
 * The desktop builds its report in the main process and uploads it to the
 * account directory. A browser has neither: no logs or local service to
 * collect, and the directory refuses uploads from another site's page. What
 * the web client does have is its own Sentry (`ade-web`), which already holds
 * the crash with its stack, screen and release. So the report goes there as
 * User Feedback beside the crash event, under a reference it is tagged with.
 *
 * The same two steps as on desktop: `prepareReport` builds the text the
 * person reads (no send, no budget), and `sendReport(id)` sends exactly that
 * text. The person's note, when there is one, goes in front of the report in
 * the same Sentry note, so the note's room is what the report leaves of
 * `SENTRY_FEEDBACK_MAX_CHARS` (`noteMaxChars`).
 *
 * `sendReport` is a getter because the web client's Sentry loads after the
 * first paint and only where the person allows it (production, no Do Not
 * Track, no analytics opt-out). Until then it is absent and the dialog offers
 * "Copy report" instead. There is no `autoReport`: the crash boundary's own
 * Sentry capture is the automatic report here, and the boundaries skip the
 * call when the member is missing.
 */
export function createDiagnosticsNamespace(
  analytics: Pick<WebAnalyticsNamespace, "capture">,
): AdeNamespace<"diagnostics"> {
  const prepared = new Map<string, PreparedWebReport>();
  const dropExpired = () => {
    const now = Date.now();
    for (const [id, entry] of prepared) {
      if (entry.expiresAtMs <= now) prepared.delete(id);
    }
  };

  // The desktop records this in main's IPC handler; here the outcome is known
  // in this file, so the same coarse fact is recorded here (docs/logging.md).
  const recordOutcome = (outcome: "success" | "failed") => {
    void analytics.capture({
      event: "ade_feature_used",
      properties: { feature: "issue_report", action: "issue_report", outcome },
      dedupeKey: `issue_report:${outcome}`,
      minimumIntervalMs: HOUR_MS,
    }).catch((error: unknown) => console.warn("[ade-web] report analytics not recorded", error));
  };

  const prepareReport = async (context?: DiagnosticReportRequestPayload): Promise<DiagnosticsPrepareResult> => {
    dropExpired();
    while (prepared.size >= MAX_PREPARED) {
      const oldest = prepared.keys().next().value;
      if (oldest === undefined) break;
      prepared.delete(oldest);
    }
    const report = buildWebReport(context);
    const id = crypto.randomUUID();
    const expiresAtMs = Date.now() + PREPARED_TTL_MS;
    prepared.set(id, { report, context, expiresAtMs });
    return {
      ok: true,
      id,
      report,
      bytes: new TextEncoder().encode(report).byteLength,
      expiresAtMs,
      noteMaxChars: Math.max(0, SENTRY_FEEDBACK_MAX_CHARS - report.length - NOTE_SEPARATOR.length),
    };
  };

  const sendReport = async (
    id: string,
    options?: DiagnosticsManualSendOptions,
  ): Promise<DiagnosticsManualSendResult> => {
    dropExpired();
    const entry = prepared.get(id);
    if (!entry) return { ok: false, reason: "expired" };
    const result = await sendPrepared(entry, options);
    if (result.ok) prepared.delete(id);
    // Settings' send (no screen) is not a report from an error screen, as on desktop.
    if (entry.context) recordOutcome(result.ok ? "success" : "failed");
    return result;
  };

  return {
    prepareReport,
    get sendReport() {
      return isSentryActive() ? sendReport : undefined;
    },
    discardReport: async (id: string) => {
      prepared.delete(id);
    },
    get userFeedbackAvailable() {
      return isSentryActive();
    },
  };
}

async function sendPrepared(
  entry: PreparedWebReport,
  options?: DiagnosticsManualSendOptions,
): Promise<DiagnosticsManualSendResult> {
  const { report, context } = entry;
  if (sendsToday().length >= MAX_DIAGNOSTIC_REPORTS_PER_DAY) {
    return { ok: false, reason: "local_limit", limit: MAX_DIAGNOSTIC_REPORTS_PER_DAY };
  }
  // The note is scrubbed like the desktop's (secrets, emails, paths) and cut
  // to the room the report leaves; the report itself goes as it was shown.
  const room = Math.max(0, SENTRY_FEEDBACK_MAX_CHARS - report.length - NOTE_SEPARATOR.length);
  const rawNote = typeof options?.userMessage === "string" ? options.userMessage.trim() : "";
  const note = rawNote && room > 0
    ? scrubFreeText(rawNote.slice(0, room), { maxLength: room }).slice(0, room)
    : "";
  // Ours, not Sentry's event id: support finds the note by this tag, and an
  // event id prefix is not searchable.
  const reference = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const feedbackId = captureUserFeedback({
    message: note ? `${note}${NOTE_SEPARATOR}${report}` : report,
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
  if (!(await confirmSentryDelivery(feedbackId))) return { ok: false, reason: "failed" };
  recordSend();
  const publicIssueUrl = buildPublicIssueUrl({
    reference,
    appVersion: webClientVersion(),
    channel: "web",
    osFamily: osFamilyOf(browserPlatform()),
  });
  return { ok: true, reference, reportPath: "", report, ...(publicIssueUrl ? { publicIssueUrl } : {}) };
}

/** The browser's OS, for the public issue's OS family only. */
function browserPlatform(): string {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform || navigator.platform || navigator.userAgent || "";
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
