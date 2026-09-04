import { useCallback, useState } from "react";
import type {
  DiagnosticReportRequestPayload,
  DiagnosticsManualSendResult,
} from "../../../shared/types/diagnostics";
import { describeManualDiagnosticsSendFailure } from "../../../shared/diagnosticsManualSend";
import {
  ERROR_DISCLOSURE_CARET,
  ERROR_PRIMARY_BUTTON,
  ERROR_SECONDARY_BUTTON,
} from "./errorSurfaceKit";

export type ReportIssueVariant = "primary" | "secondary" | "ghost";

/** The inline actions inside the result line: text links, not buttons in a row. */
const REPORT_LINK_BUTTON =
  "font-medium text-fg/75 underline decoration-fg/25 underline-offset-2 transition-colors hover:text-fg disabled:no-underline disabled:opacity-60";

const VARIANT_CLASS: Record<ReportIssueVariant, string> = {
  primary: ERROR_PRIMARY_BUTTON,
  secondary: ERROR_SECONDARY_BUTTON,
  // Not the kit's ghost: this one rides inside one-line banners, where the
  // full-height button shape would turn a strip into a bar.
  ghost:
    "inline-flex h-[22px] items-center justify-center rounded-md px-2 text-[11px] font-medium text-fg/60 transition-colors hover:bg-fg/[0.06] hover:text-fg/85 disabled:opacity-60",
};

/**
 * Every error screen's escape hatch: one press sends a redacted report to ADE.
 *
 * It is the SAME send the Settings pane offers — `sendManual` in the main
 * process — and that is the whole point of the button. Collecting the report,
 * redacting it, spending the per-device daily budget and uploading it all
 * happen in main, so a renderer that has just crashed is trusted with none of
 * it; this component presses the button, hands over what the screen knows about
 * its own failure, and reads the answer back honestly.
 *
 * The failure context matters because the report is filed under it. A screen
 * names its surface, its code and the text it already showed, and a report that
 * arrived stamped with the settings surface instead would file a renderer crash
 * under the pane nobody was looking at. `projectRoot` is the exception: main
 * ignores what the renderer names there and uses the project it has open, so
 * nothing here can decide whose logs are read.
 *
 * Deliberately self-contained — one import and one element per host screen —
 * so the error surfaces can be redesigned without untangling it.
 */
export function ReportIssueButton({
  context,
  variant = "secondary",
  className,
  showDisclosure,
}: {
  context: DiagnosticReportRequestPayload;
  variant?: ReportIssueVariant;
  className?: string;
  /**
   * Whether to render the "What's in the report?" fold. On a full surface it
   * belongs (people deserve to know before they send anything); inside a
   * one-line banner it turns a strip into a paragraph, so ghost hides it by
   * default. Pass explicitly to override either way.
   */
  showDisclosure?: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<DiagnosticsManualSendResult | null>(null);

  const bridge = typeof window !== "undefined" ? window.ade?.diagnostics : undefined;
  const sendManual = bridge?.sendManual;

  const send = useCallback(async () => {
    if (!sendManual || sending) return;
    setSending(true);
    setResult(null);
    try {
      setResult(await sendManual(context));
    } catch {
      // The bridge is documented to answer rather than throw, but a screen that
      // is already broken must not be able to break again on the way to asking
      // for help. An unnamed failure is still a named outcome here.
      setResult({ ok: false, reason: "failed" });
    } finally {
      setSending(false);
    }
  }, [context, sendManual, sending]);

  // An older preload has no manual send; offering a dead button is worse than
  // offering nothing on a screen that is already failing.
  if (!sendManual) return null;

  const isGhost = variant === "ghost";
  const disclosed = showDisclosure ?? !isGhost;
  // Present on a success and on the refusals that still wrote a local copy.
  const reportPath = (result?.ok ? result.reportPath : result?.reportPath) || "";

  return (
    <span className={className}>
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending}
          className={VARIANT_CLASS[variant]}
          title={
            disclosed
              ? undefined
              : "Sends your ADE version, what went wrong here, and the last part of ADE's logs. Personal details are removed."
          }
        >
          {sending ? "Sending…" : "Send a report to ADE"}
        </button>

        {result ? (
          <span
            className={
              (isGhost ? "text-[11px] " : "text-[12px] ")
              + (result.ok ? "text-fg/60" : "text-amber-300/90")
            }
            role="status"
          >
            {result.ok
              ? `Report sent. Reference ${result.reference} — quote it if you get in touch.`
              : describeManualDiagnosticsSendFailure(result)}
            {reportPath ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => void bridge?.revealReport(reportPath)}
                  className={REPORT_LINK_BUTTON}
                >
                  View report
                </button>
              </>
            ) : null}
          </span>
        ) : null}
      </span>

      {disclosed ? (
        <details className="group mt-2 block">
          <summary
            className={
              (isGhost ? "text-[11px] " : "text-[12px] ")
              + "inline-flex cursor-pointer select-none list-none items-center gap-1.5 text-fg/45"
              + " transition-colors marker:content-none hover:text-fg/70"
              + " [&::-webkit-details-marker]:hidden"
            }
          >
            {ERROR_DISCLOSURE_CARET}
            What's in the report?
          </summary>
          <ul
            className={
              (isGhost ? "text-[11px] " : "text-[12px] ")
              + "mt-1.5 flex list-disc flex-col gap-0.5 pl-4 leading-relaxed text-fg/50"
            }
          >
            <li>Your ADE version and what kind of computer this is</li>
            <li>What went wrong on this screen</li>
            <li>Whether ADE's background service is running, and free storage</li>
            <li>The last part of ADE's own logs</li>
            <li>An install code so we can match this to our error reports</li>
          </ul>
          <p
            className={
              (isGhost ? "text-[11px] " : "text-[12px] ")
              + "mt-1.5 leading-relaxed text-fg/45"
            }
          >
            File paths, your name, email addresses and any sign-in codes are removed
            before the report is created. Nothing is sent until you press the button.
          </p>
        </details>
      ) : null}
    </span>
  );
}
