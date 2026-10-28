import { useEffect, useState, type ReactNode } from "react";
import { CaretRight, Check, PaperPlaneTilt } from "@phosphor-icons/react";
import { forwardSignalToSentry } from "../../../../shared/sentry/logBridge";
import { ReportIssueResult, useIssueReport, type IssueReportState } from "../../app/ReportIssueButton";
import type { NoticeAction } from "./NoticeParts";

/**
 * What every error notice carries so a person can hand it to ADE: the raw
 * error on one quiet line that opens to the full text, a "Report" action that
 * sends a redacted diagnostic report, and one Sentry log the first time it is
 * shown.
 *
 * `Banner` and `ToastCard` add it on their own for every `error`-tone notice,
 * from the notice's own words; a warning that is really a failure passes one.
 * `false` turns it off (a form's "this field is required").
 */
export type NoticeReport = {
  /** Groups the Sentry log and names the screen in the report (`work_machine_read`). */
  surface: string;
  /** A stable code for this failure (`machine_session_read_failed`). */
  code?: string | null;
  /** The raw error. Shown under the notice's text and sent with the report. */
  technicalDetail?: string | null;
  /** Defaults to the notice's title. */
  headline?: string | null;
};

type ResolvedNoticeReport = NoticeReport & { headline: string };

const TEXT_LIMIT = 300;
/** One Sentry log per notice and error text per renderer, however often it re-mounts. */
const loggedNotices = new Set<string>();
const LOGGED_NOTICES_CAP = 500;

function plainNoticeText(node: ReactNode): string | null {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  return null;
}

/** The report a notice gets: the owner's, or one made from its words for an error. */
function resolveNoticeReport(args: {
  report: NoticeReport | false | undefined;
  tone: string;
  id: string;
  title: ReactNode;
  ariaLabel?: string;
  detail?: ReactNode;
  error?: string;
}): ResolvedNoticeReport | null {
  if (args.report === false) return null;
  const headline = args.report?.headline
    ?? args.ariaLabel
    ?? plainNoticeText(args.title)
    ?? args.id;
  if (args.report) return { ...args.report, headline };
  if (args.tone !== "error") return null;
  const technicalDetail = args.error ?? plainNoticeText(args.detail ?? null);
  return { surface: args.id, headline, technicalDetail };
}

/** Logs a shown error notice to Sentry once. */
function useNoticeSentryLog(report: ResolvedNoticeReport | null): void {
  const surface = report?.surface ?? null;
  const headline = report?.headline ?? null;
  const code = report?.code ?? null;
  const detail = report?.technicalDetail ?? null;
  useEffect(() => {
    if (!surface) return;
    // The same error shown in two places (a dialog and the page behind it)
    // is one failure: the raw error, when there is one, is the identity.
    const key = `${surface}\u0000${detail ?? headline}`;
    if (loggedNotices.has(key)) return;
    if (loggedNotices.size >= LOGGED_NOTICES_CAP) loggedNotices.clear();
    loggedNotices.add(key);
    forwardSignalToSentry("notice.shown", {
      surface,
      headline: headline?.slice(0, TEXT_LIMIT) ?? null,
      ...(code ? { code } : {}),
      ...(detail ? { detail: detail.slice(0, TEXT_LIMIT) } : {}),
    }, `notice:${surface}`);
  }, [code, detail, headline, surface]);
}

/**
 * Everything a notice needs for the failure behind it, from the notice's own
 * words: `action` is a "Report" pill that goes with the notice's actions, and
 * `body` sits under its text — the raw error as one quiet line that opens to
 * the full text, and after a send, the reference with copy and GitHub links.
 * Both are null for a notice with no report (a non-error tone, or `false`).
 * Logs the failure to Sentry once unless `logged` says the owner already did.
 */
export function useNoticeFailure(notice: {
  report: NoticeReport | false | undefined;
  tone: string;
  id: string;
  title: ReactNode;
  ariaLabel?: string;
  detail?: ReactNode;
  error?: string;
  /** The toast store logs its own error toasts when they are shown. */
  logged?: boolean;
}): { report: ResolvedNoticeReport | null; action: NoticeAction | null; body: ReactNode } {
  const report = resolveNoticeReport(notice);
  useNoticeSentryLog(notice.logged ? null : report);
  const state = useIssueReport({
    surface: report?.surface ?? "notice",
    headline: report?.headline ?? null,
    code: report?.code ?? null,
    technicalDetail: report?.technicalDetail?.trim() || null,
  });
  if (!report) return { report: null, action: null, body: null };
  const detail = report.technicalDetail?.trim() || null;
  // A raw error that repeats what the notice already says is not shown twice.
  const visible = [plainNoticeText(notice.title), plainNoticeText(notice.detail ?? null), notice.error];
  const shownDetail = detail && !visible.some((text) => text?.trim() === detail) ? detail : null;
  const sentOk = Boolean(state.sent?.ok);
  const action: NoticeAction | null = state.available
    ? {
        label: state.sending ? "Sending…" : sentOk ? "Sent" : "Report",
        variant: "secondary",
        icon: sentOk ? <Check size={11} weight="bold" /> : <PaperPlaneTilt size={11} />,
        busy: state.sending || (!state.canSend && state.opening),
        disabled: sentOk,
        title: sentOk
          ? "Sent to ADE"
          : `${state.canSend ? "Send" : "Copy"} this error to ADE, with your ADE version and the last part of its logs. Personal details are removed.`,
        onClick: () => void state.run(),
      }
    : null;
  const hasResult = Boolean(state.sent || state.issue || state.issueFailed);
  const body = shownDetail || hasResult ? <NoticeReportBody detail={shownDetail} state={state} /> : null;
  return { report, action, body };
}

function NoticeReportBody({ detail, state }: { detail: string | null; state: IssueReportState }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, marginTop: 2 }}>
      {detail ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          title={open ? "Hide the full error" : "Show the full error"}
          className="flex min-w-0 items-center gap-1 self-start text-left font-mono text-[10.5px] leading-[1.5] text-fg/45 transition-colors hover:text-fg/75"
          style={{ maxWidth: "100%" }}
        >
          <CaretRight
            size={8}
            weight="bold"
            className="shrink-0"
            style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
          />
          <span className="min-w-0 truncate">{open ? "Hide full error" : detail.split("\n", 1)[0]}</span>
        </button>
      ) : null}
      {open && detail ? (
        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-fg/[0.04] px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-fg/70 select-text">
          {detail}
        </pre>
      ) : null}
      <ReportIssueResult state={state} className="text-[11px] leading-[1.5] " sentLabel="Reference" />
    </div>
  );
}
