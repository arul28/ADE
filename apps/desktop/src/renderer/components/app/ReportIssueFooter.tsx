import type { DiagnosticReportRequestPayload } from "../../../shared/types/diagnostics";
import { isWebClientMode } from "../../lib/webClientMode";
import { ReportIssueButton } from "./ReportIssueButton";
import { reportBridge } from "./reportDraft";

const SEND_HINT = "You see the report before it goes.";

/**
 * The last row of a failure card (the project recovery screen, the crash
 * boundaries): a rule, then "Report this error to ADE…" with its hint. The report sits inside
 * the card it is about rather than under it.
 *
 * `errorReportReceived` is a crash boundary's word that Sentry confirmed its
 * capture (`confirmSentryDelivery`). The card then says so, and on desktop the
 * hint says what a manual report adds: ADE's logs.
 */
export function ReportIssueFooter({
  context,
  errorReportReceived = false,
}: {
  context: DiagnosticReportRequestPayload;
  errorReportReceived?: boolean;
}) {
  const canReport = reportBridge().prepare !== null;
  if (!canReport && !errorReportReceived) return null;
  const hint = errorReportReceived && !isWebClientMode()
    ? "Adds ADE's logs. You see the report before it goes."
    : SEND_HINT;
  return (
    <>
      {/* Inline: `.kit-rule` sets `margin: 0`, which wins over a utility class. */}
      <hr className="kit-rule" style={{ marginTop: 18 }} />
      <div className="mt-3 flex flex-col gap-1 text-[12px] text-(color:--kit-text-3)">
        {errorReportReceived ? <p>ADE got an error report automatically.</p> : null}
        {/* The button's own padding is pulled back so its label lines up with the text above. */}
        {canReport ? <ReportIssueButton context={context} hint={hint} className="-ml-2" /> : null}
      </div>
    </>
  );
}
