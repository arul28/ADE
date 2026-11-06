import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  DiagnosticReportPayload,
  DiagnosticReportRequestPayload,
  DiagnosticsManualSendResult,
} from "../../../shared/types/diagnostics";
import { describeManualSendFailure } from "../../../shared/diagnosticsUpload";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { isWebClientMode } from "../../lib/webClientMode";

/** The inline actions inside the result line: text links, not buttons in a row. */
const REPORT_LINK_BUTTON =
  "font-medium text-fg/75 underline decoration-fg/25 underline-offset-2 transition-colors hover:text-fg disabled:no-underline disabled:opacity-60";

/**
 * Not the kit's ghost: this button rides in one-line banners and in the last
 * row of a failure card, where the full-height button shape would turn a strip
 * into a bar.
 */
const REPORT_BUTTON =
  "inline-flex h-[22px] items-center justify-center rounded-md px-2 text-[11px] font-medium text-fg/60 transition-colors hover:bg-fg/[0.06] hover:text-fg/85 disabled:opacity-60";

/** A failure in the result line: the kit's warning colour, which also reads on light themes. */
const REPORT_WARN_TEXT = "text-(color:--kit-warn)";

/** What the button does when it cannot send: any hint about sending would be false. */
const GITHUB_PATH_HINT = "Opens a GitHub issue with the report.";

/**
 * What the report carries, for a tooltip. The web client's report has no logs:
 * a browser has none to collect.
 */
export function reportContentsTitle(canSend: boolean): string {
  const verb = canSend ? "Sends ADE" : "Collects";
  return isWebClientMode()
    ? `${verb} your ADE version, your browser and what went wrong here. Personal details are removed.`
    : `${verb} your ADE version, what went wrong here, and the last part of ADE's logs. Personal details are removed.`;
}

/**
 * The send behind "Report issue", for a surface that places the button and its
 * result itself (a notice puts the button with its actions and the result
 * under its text). `available` is false on a preload with no diagnostics
 * bridge: render nothing then.
 */
export function useIssueReport(context: DiagnosticReportRequestPayload) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<DiagnosticsManualSendResult | null>(null);
  const [opening, setOpening] = useState(false);
  const [issue, setIssue] = useState<DiagnosticReportPayload | null>(null);
  const [issueFailed, setIssueFailed] = useState(false);
  const { copy, copied } = useCopyToClipboard();
  /**
   * Which press a reply belongs to. "Open GitHub issue" can still be in flight
   * when the person reports again, and its answer must not land under the
   * newer report's result line.
   */
  const generationRef = useRef(0);

  // One notice can swap its failure for another without unmounting (the chat
  // pane's line). The result belongs to the failure it was sent for: a new
  // failure starts clean, and a reply still in flight for the old one is dropped.
  const identity = [context.surface, context.headline, context.code, context.technicalDetail].join("\u0000");
  const [shownFor, setShownFor] = useState(identity);
  if (shownFor !== identity) {
    setShownFor(identity);
    setSending(false);
    setSent(null);
    setOpening(false);
    setIssue(null);
    setIssueFailed(false);
  }
  useEffect(() => {
    generationRef.current += 1;
  }, [identity]);

  const bridge = typeof window !== "undefined" ? window.ade?.diagnostics : undefined;
  // `isAdeAvailable`, not truthiness: a member the web client lacks is a
  // stand-in whose every call rejects, and a button that can only fail is
  // worse than none. On web `sendManual` appears once Sentry has loaded.
  const bridgeOpenIssue = isAdeAvailable(bridge?.openIssue) ? bridge.openIssue : null;
  const bridgeSend = isAdeAvailable(bridge?.sendManual) ? bridge.sendManual : null;
  const canSend = bridgeSend !== null;

  const openIssue = useCallback(async () => {
    if (!bridgeOpenIssue || opening) return;
    const generation = generationRef.current;
    setOpening(true);
    setIssueFailed(false);
    try {
      const payload = await bridgeOpenIssue(context);
      if (generationRef.current === generation) setIssue(payload);
    } catch {
      if (generationRef.current === generation) {
        setIssue(null);
        setIssueFailed(true);
      }
    } finally {
      // A newer press already freed the button; a stale reply leaves it be.
      if (generationRef.current === generation) setOpening(false);
    }
  }, [bridgeOpenIssue, context, opening]);

  const send = useCallback(async () => {
    if (!bridgeSend || sending) return;
    const generation = ++generationRef.current;
    setSending(true);
    // An issue still opening for the earlier press no longer owns the button.
    setOpening(false);
    setSent(null);
    setIssue(null);
    setIssueFailed(false);
    let result: DiagnosticsManualSendResult;
    try {
      result = await bridgeSend(context);
    } catch {
      result = { ok: false, reason: "failed" };
    }
    if (generationRef.current !== generation) return;
    setSent(result);
    setSending(false);
  }, [bridgeSend, context, sending]);

  const run = useCallback(async () => {
    if (canSend) {
      await send();
      return;
    }
    generationRef.current += 1;
    setOpening(false);
    setIssue(null);
    await openIssue();
  }, [canSend, openIssue, send]);

  return {
    available: bridgeOpenIssue !== null,
    canSend,
    sending,
    opening,
    sent,
    issue,
    issueFailed,
    copied,
    copy,
    send,
    openIssue,
    run,
  };
}

export type IssueReportState = ReturnType<typeof useIssueReport>;

/**
 * Every error screen's escape hatch: build a redacted diagnostic report about
 * this screen and send it to ADE, with a GitHub issue as the fallback.
 *
 * On desktop the send happens in the main process (`diagnostics.sendManual`
 * with this screen's context): the renderer's CSP does not allow a request to
 * the account directory, and main already owns the report builder, the
 * redaction and the per-device daily budget. The web client sends its own,
 * smaller report as Sentry User Feedback (`webclient/adapter/diagnostics.ts`).
 * The GitHub issue opens only when the person asks for it, through
 * `openIssue`, which also puts the report on the clipboard.
 *
 * Without `sendManual` (an older preload, or the web client with Sentry off)
 * the button opens the GitHub issue with the report copied.
 *
 * Deliberately self-contained — one import and one element per host screen —
 * so the error surfaces can be redesigned without untangling it.
 */
export function ReportIssueButton({
  context,
  className,
  hint,
}: {
  context: DiagnosticReportRequestPayload;
  className?: string;
  /**
   * One short line after the button that says what pressing it does, shown
   * until the button has a result to show. On the GitHub path the button
   * says so instead.
   */
  hint?: string;
}) {
  const state = useIssueReport(context);
  const { canSend, sending, opening, sent, issue, issueFailed, run } = state;

  // An older preload has no diagnostics bridge; offering a dead button is
  // worse than offering nothing on a screen that is already failing.
  if (!state.available) return null;

  return (
    <span className={className}>
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => void run()}
          disabled={sending || (!canSend && opening)}
          className={REPORT_BUTTON}
          title={reportContentsTitle(canSend)}
        >
          {sending ? "Sending report…" : !canSend && opening ? "Preparing report…" : "Report issue"}
        </button>

        {sent || issue || issueFailed ? (
          <ReportIssueResult state={state} className="text-[11px] " />
        ) : hint ? (
          <span className="text-[12px] text-(color:--kit-text-3)">{canSend ? hint : GITHUB_PATH_HINT}</span>
        ) : null}
      </span>
    </span>
  );
}

/** What to do with the report once the GitHub path ran. */
function issueInstruction(issue: DiagnosticReportPayload): string {
  if (issue.opened === false) {
    return issue.copied ? "Report copied, but the GitHub issue didn't open." : "The GitHub issue didn't open.";
  }
  if (issue.copied) return "Report copied — paste it into the GitHub issue that just opened.";
  return issue.filePath
    ? "Report saved — copy it and paste it into the GitHub issue."
    : "Copy the report and paste it into the GitHub issue.";
}

/** What happened after "Report issue": the reference, copy, retry, the GitHub fallback. */
export function ReportIssueResult({
  state,
  className,
  sentLabel = "Sent to ADE — reference",
}: {
  state: IssueReportState;
  className?: string;
  /** Words before the reference; a surface whose button already says "Sent" passes "Reference". */
  sentLabel?: string;
}): JSX.Element | null {
  const { sent, issue, issueFailed, sending, opening, copied, copy, send, openIssue } = state;
  if (!sent && !issue && !issueFailed) return null;
  const sentReport = sent?.ok ? sent.report : undefined;
  // One failure at a time: once the person turns to GitHub, a failed send
  // leaves the line, so two failures never run together.
  const sendLine = sent && (sent.ok || (!issue && !issueFailed)) ? sent : null;
  const link = (label: string, onClick: () => void, disabled = false) => (
    <button type="button" onClick={onClick} disabled={disabled} className={REPORT_LINK_BUTTON}>
      {label}
    </button>
  );

  // Each part is one status with its own action; parts are joined with " · ".
  const parts: ReactNode[] = [];
  if (sendLine) {
    parts.push(sendLine.ok ? `${sentLabel} ${sendLine.reference}` : (
      <>
        <span className={REPORT_WARN_TEXT}>{describeManualSendFailure(sendLine)}</span>
        {sendLine.reason === "failed" || sendLine.reason === "unavailable"
          ? <>{" "}{link("Try again", () => void send(), sending)}</>
          : null}
      </>
    ));
  }
  if (sentReport) parts.push(link(copied ? "Copied" : "Copy report", () => void copy(sentReport)));
  // The GitHub link stays until an issue has actually opened.
  if (sendLine && !issueFailed && issue?.opened !== true) {
    parts.push(link(opening ? "Opening…" : "Open GitHub issue", () => void openIssue(), opening));
  }
  if (issue) {
    parts.push(
      <>
        {issueInstruction(issue)}
        {/* After a send, "Copy report" already copies. */}
        {sentReport ? null : <>{" "}{link(copied ? "Copied" : issue.copied ? "Copy again" : "Copy report", () => void copy(issue.report))}</>}
      </>,
    );
  }
  if (issueFailed) {
    parts.push(
      <>
        <span className={REPORT_WARN_TEXT}>ADE couldn't prepare the report.</span>
        {" "}
        {link(opening ? "Opening…" : "Try again", () => void openIssue(), opening)}
      </>,
    );
  }

  return (
    <span className={(className ?? "") + "text-fg/60"} role="status">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? " · " : null}
          {part}
        </Fragment>
      ))}
    </span>
  );
}
