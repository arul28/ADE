import { useCallback, useRef, useState } from "react";
import type {
  DiagnosticReportPayload,
  DiagnosticReportRequestPayload,
} from "../../../shared/types/diagnostics";
import {
  describeDiagnosticUploadFailure,
  resolveDiagnosticsUploadBaseUrl,
  uploadDiagnosticReport,
  type DiagnosticUploadResult,
} from "../../../shared/diagnosticsUpload";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
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
 * Every error screen's escape hatch: collect a redacted diagnostic report,
 * put it on the clipboard and on disk, and open a prefilled GitHub issue —
 * then optionally hand that exact report straight to ADE.
 *
 * The send runs here rather than in the main process because the diagnostics
 * preload bridge exposes only `openIssue`; the renderer already holds the
 * finished, redacted report that call returns, so it posts those same bytes.
 * One consequence, deliberate: the renderer has no access to the account token
 * (it lives in the brain's credential store), so a desktop upload is anonymous
 * and identified only by the install id the report already carries.
 * `ade report-issue --send` reads the store directly and does send a token.
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
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DiagnosticReportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<DiagnosticUploadResult | null>(null);
  const { copy, copied } = useCopyToClipboard();
  /**
   * Which report the upload result belongs to. "Report issue" stays live while
   * a send is in flight, so a user who reports twice can have the first
   * upload's reply land after the second report exists — and a reference that
   * points at the older report is worse than none.
   */
  const reportGenerationRef = useRef(0);

  const bridge = typeof window !== "undefined" ? window.ade?.diagnostics : undefined;

  const run = useCallback(async () => {
    if (!bridge?.openIssue || pending) return;
    reportGenerationRef.current += 1;
    setPending(true);
    setError(null);
    setSent(null);
    try {
      const payload = await bridge.openIssue(context);
      setResult(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setResult(null);
    } finally {
      setPending(false);
    }
  }, [bridge, context, pending]);

  const send = useCallback(async () => {
    if (!result || sending) return;
    const generation = reportGenerationRef.current;
    setSending(true);
    try {
      const outcome = await uploadDiagnosticReport({
        // The very bytes the clipboard holds. Redaction already happened in
        // the main process; nothing here reshapes the report.
        report: result.report,
        // "unknown" is the report's stand-in for "analytics is switched off";
        // sending it as an install id would attach a value that matches nothing.
        installId: result.installId === "unknown" ? null : result.installId,
        // Resolved here rather than inside the upload: the CLI resolves its own
        // origin the way the brain does, so the client itself takes a base URL
        // its caller already decided on.
        baseUrl: resolveDiagnosticsUploadBaseUrl(
          typeof import.meta.env.VITE_ADE_ACCOUNT_DIRECTORY_URL === "string"
            ? import.meta.env.VITE_ADE_ACCOUNT_DIRECTORY_URL
            : null,
        ),
      });
      if (reportGenerationRef.current !== generation) return;
      setSent(outcome);
    } finally {
      // Cleared unconditionally: `sending` is the only thing keeping a second
      // upload out, so a stale reply that left it set would strand the newer
      // report with a permanently disabled Send.
      setSending(false);
    }
  }, [result, sending]);

  // An older preload has no diagnostics bridge; offering a dead button is
  // worse than offering nothing on a screen that is already failing.
  if (!bridge?.openIssue) return null;

  const isGhost = variant === "ghost";
  const disclosed = showDisclosure ?? !isGhost;

  return (
    <span className={className}>
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={pending}
          className={VARIANT_CLASS[variant]}
          title={
            disclosed
              ? undefined
              : "Collects your ADE version, what went wrong here, and the last part of ADE's logs. Personal details are removed."
          }
        >
          {pending ? "Preparing report…" : "Report issue"}
        </button>

        {result ? (
          <span
            className={
              (isGhost ? "text-[11px] " : "text-[12px] ") + "text-fg/60"
            }
            role="status"
          >
            {result.copied
              ? "Report copied — paste it into the GitHub issue that just opened."
              : "Report saved — copy it below and paste it into the GitHub issue."}{" "}
            <button
              type="button"
              onClick={() => void copy(result.report)}
              className={REPORT_LINK_BUTTON}
            >
              {copied ? "Copied" : "Copy again"}
            </button>
            {sent?.ok ? null : (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending}
                  className={REPORT_LINK_BUTTON}
                >
                  {sending ? "Sending…" : sent ? "Try sending again" : "Send to ADE"}
                </button>
              </>
            )}
            {sent
              ? (
                <span className={sent.ok ? "text-fg/60" : "text-amber-300/90"}>
                  {" "}
                  {sent.ok
                    ? `Sent — reference ${sent.reference}`
                    : describeDiagnosticUploadFailure(sent.reason)}
                </span>
              )
              : null}
          </span>
        ) : null}

        {error ? (
          <span
            className={(isGhost ? "text-[11px] " : "text-[12px] ") + "text-amber-300/90"}
            role="status"
          >
            ADE couldn't prepare the report. Try again in a moment.
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
            before the report is created. Nothing leaves this computer unless you post
            the issue or choose "Send to ADE".
          </p>
        </details>
      ) : null}
    </span>
  );
}
