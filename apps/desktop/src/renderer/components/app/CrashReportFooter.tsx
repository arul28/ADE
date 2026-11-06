import type { DiagnosticReportRequestPayload } from "../../../shared/types/diagnostics";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { isWebClientMode } from "../../lib/webClientMode";
import { ReportIssueButton } from "./ReportIssueButton";

/**
 * The foot of a crash card: whether ADE already has the error, then Report
 * issue. The same shape as the project recovery screen's last rung, so the
 * report sits inside the card it is about rather than floating under it.
 *
 * `autoReported` is the boundary's own word that its Sentry capture went out
 * (Sentry runs only where the person has not opted out), so the line never
 * claims a report that was not sent.
 */
export function CrashReportFooter({
  context,
  autoReported,
}: {
  context: DiagnosticReportRequestPayload;
  autoReported: boolean;
}) {
  const diagnostics = window.ade?.diagnostics;
  const canReport = isAdeAvailable(diagnostics?.openIssue);
  if (!autoReported && !canReport) return null;
  const hint = !isAdeAvailable(diagnostics?.sendManual)
    ? "Opens a GitHub issue with the report."
    : autoReported && !isWebClientMode()
      ? "Adds ADE's logs and gives you a reference."
      : "Sends ADE what went wrong and gives you a reference.";
  return (
    <>
      <hr className="kit-rule" style={{ marginTop: 18 }} />
      <div className="mt-3 flex flex-col gap-1 text-[12px] text-(color:--kit-text-3)">
        {autoReported ? <p>ADE got an error report automatically.</p> : null}
        {canReport ? (
          // The hint steps aside once the button reports its own result.
          <div className="group/report -ml-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <ReportIssueButton variant="ghost" showDisclosure={false} context={context} />
            <span className="group-has-[[role=status]]/report:hidden">{hint}</span>
          </div>
        ) : null}
      </div>
    </>
  );
}
