import { useCallback, useState } from "react";
import type { DiagnosticReportRequestPayload } from "../../../shared/types/diagnostics";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { openPublicIssue, openReportDialog, useReportDialogFor } from "./ReportIssueDialog";
import { reportBridge } from "./reportDraft";

/** The full name of the control, also its accessible name where a notice shows a short label. */
export const REPORT_ERROR_LABEL = "Report this error to ADE…";

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

/** The tooltip: what pressing the control does. */
export function reportControlTitle(): string {
  return reportBridge().send
    ? "Shows the report first. Nothing is sent until you press Send."
    : "Shows the report, which you can copy.";
}

/**
 * The control behind every "Report this error to ADE…", for a surface that
 * places the button and its result itself (a notice puts the button with its
 * actions and the result under its text). A press opens the report dialog;
 * it sends nothing. `available` is false on a preload with no report bridge:
 * render nothing then.
 */
export function useIssueReport(context: DiagnosticReportRequestPayload) {
  const { sent, open } = useReportDialogFor(context);
  const available = reportBridge().prepare !== null;
  const { copy, copied } = useCopyToClipboard();
  const [issueFailed, setIssueFailed] = useState(false);
  const openDialog = useCallback(() => openReportDialog(context), [context]);
  const openIssue = useCallback(async () => {
    if (!sent) return;
    setIssueFailed(!(await openPublicIssue(sent)));
  }, [sent]);
  return { available, sent, dialogOpen: open, openDialog, copy, copied, openIssue, issueFailed };
}

export type IssueReportState = ReturnType<typeof useIssueReport>;

/**
 * Every error screen's escape hatch: "Report this error to ADE…" opens a
 * dialog that shows the redacted report, takes an optional note, and sends
 * exactly that text to the ADE team when the person presses Send
 * (`ReportIssueDialog.tsx`). After a send it shows the reference here.
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
  /** One short line after the button that says what pressing it does, shown until there is a result. */
  hint?: string;
}) {
  const state = useIssueReport(context);
  // An older preload has no report bridge; offering a dead button is worse
  // than offering nothing on a screen that is already failing.
  if (!state.available) return null;

  return (
    <span className={className}>
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        {state.sent ? null : (
          <button
            type="button"
            onClick={state.openDialog}
            disabled={state.dialogOpen}
            className={REPORT_BUTTON}
            title={reportControlTitle()}
          >
            {REPORT_ERROR_LABEL}
          </button>
        )}
        {state.sent ? (
          <ReportIssueResult state={state} className="text-[11px] " />
        ) : hint ? (
          <span className="text-[12px] text-(color:--kit-text-3)">{hint}</span>
        ) : null}
      </span>
    </span>
  );
}

/** After a send: the reference with a copy control, what happens next, and the public issue. */
export function ReportIssueResult({
  state,
  className,
}: {
  state: IssueReportState;
  className?: string;
}): JSX.Element | null {
  const { sent, copied, copy, openIssue, issueFailed } = state;
  if (!sent) return null;
  const link = (label: string, onClick: () => void, ariaLabel?: string) => (
    <button type="button" onClick={onClick} className={REPORT_LINK_BUTTON} aria-label={ariaLabel}>
      {label}
    </button>
  );
  return (
    <span className={(className ?? "") + "flex flex-col gap-0.5 text-fg/60"} role="status">
      <span>
        <span className="font-medium text-fg/80">Sent. Reference {sent.reference}</span>
        {" "}
        {link(copied ? "Copied" : "Copy", () => void copy(sent.reference), copied ? "Reference copied" : "Copy the reference")}
      </span>
      <span>
        The ADE team reads it. Quote the reference if you contact support.
        {sent.publicIssueUrl ? <>{" "}{link("Open a public GitHub issue", () => void openIssue())}</> : null}
        {issueFailed ? <span className="text-(color:--kit-warn)">{" "}The GitHub page didn't open.</span> : null}
      </span>
    </span>
  );
}
