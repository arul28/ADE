import { useCallback, useRef, useState } from "react";
import type {
  DiagnosticReportPayload,
  DiagnosticReportRequestPayload,
  DiagnosticsManualSendResult,
} from "../../../shared/types/diagnostics";
import { describeManualSendFailure } from "../../../shared/diagnosticsUpload";
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
 * Every error screen's escape hatch: build a redacted diagnostic report about
 * this screen and send it to ADE, with a GitHub issue as the fallback.
 *
 * The send happens in the main process (`diagnostics.sendManual` with this
 * screen's context): the renderer's CSP does not allow a request to the account
 * directory, and main already owns the report builder, the redaction and the
 * per-device daily budget. The GitHub issue opens only when the person asks
 * for it, through `openIssue`, which also puts the report on the clipboard.
 *
 * A preload without `sendManual` gets the older behaviour: open the GitHub
 * issue with the report copied.
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

  const bridge = typeof window !== "undefined" ? window.ade?.diagnostics : undefined;
  const canSend = Boolean(bridge?.sendManual);

  const openIssue = useCallback(async () => {
    if (!bridge?.openIssue || opening) return;
    const generation = generationRef.current;
    setOpening(true);
    setIssueFailed(false);
    try {
      const payload = await bridge.openIssue(context);
      if (generationRef.current === generation) setIssue(payload);
    } catch {
      if (generationRef.current === generation) {
        setIssue(null);
        setIssueFailed(true);
      }
    } finally {
      setOpening(false);
    }
  }, [bridge, context, opening]);

  const send = useCallback(async () => {
    if (!bridge?.sendManual || sending) return;
    generationRef.current += 1;
    setSending(true);
    setSent(null);
    setIssue(null);
    setIssueFailed(false);
    try {
      setSent(await bridge.sendManual(context));
    } catch {
      setSent({ ok: false, reason: "failed" });
    } finally {
      setSending(false);
    }
  }, [bridge, context, sending]);

  const run = useCallback(async () => {
    if (canSend) {
      await send();
      return;
    }
    generationRef.current += 1;
    setIssue(null);
    await openIssue();
  }, [canSend, openIssue, send]);

  // An older preload has no diagnostics bridge; offering a dead button is
  // worse than offering nothing on a screen that is already failing.
  if (!bridge?.openIssue) return null;

  const isGhost = variant === "ghost";
  const sentReport = sent?.ok ? sent.report : undefined;
  const disclosed = showDisclosure ?? !isGhost;

  return (
    <span className={className}>
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={sending || (!canSend && opening)}
          className={VARIANT_CLASS[variant]}
          title={
            disclosed
              ? undefined
              : `${canSend ? "Sends ADE" : "Collects"} your ADE version, what went wrong here, and the last part of ADE's logs. Personal details are removed.`
          }
        >
          {sending ? "Sending report…" : !canSend && opening ? "Preparing report…" : "Report issue"}
        </button>

        {sent || issue || issueFailed ? (
          <span
            className={
              (isGhost ? "text-[11px] " : "text-[12px] ")
              + (sent && !sent.ok ? "text-amber-300/90" : "text-fg/60")
            }
            role="status"
          >
            {sent
              ? sent.ok
                ? `Sent to ADE — reference ${sent.reference}`
                : describeManualSendFailure(sent)
              : null}
            {sentReport ? (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => void copy(sentReport)}
                  className={REPORT_LINK_BUTTON}
                >
                  {copied ? "Copied" : "Copy report"}
                </button>
              </>
            ) : null}
            {sent && !sent.ok && (sent.reason === "failed" || sent.reason === "unavailable") ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending}
                  className={REPORT_LINK_BUTTON}
                >
                  Try again
                </button>
              </>
            ) : null}
            {sent ? (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => void openIssue()}
                  disabled={opening}
                  className={REPORT_LINK_BUTTON}
                >
                  {opening ? "Opening…" : "Open GitHub issue"}
                </button>
              </>
            ) : null}
            {issue ? (
              <span className="text-fg/60">
                {sent ? " " : null}
                {issue.copied
                  ? "Report copied — paste it into the GitHub issue that just opened."
                  : "Report saved — copy it and paste it into the GitHub issue."}
                {/* After a send, "Copy report" already copies; this one is for
                    the GitHub path, or a send that returned no report. */}
                {sent && sentReport ? null : (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => void copy(issue.report)}
                      className={REPORT_LINK_BUTTON}
                    >
                      {copied ? "Copied" : "Copy again"}
                    </button>
                  </>
                )}
              </span>
            ) : null}
            {issueFailed ? (
              <span className="text-amber-300/90">
                {sent ? " " : null}
                ADE couldn't prepare the report. Try again in a moment.
              </span>
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
            before the report is created. {canSend
              ? "Pressing Report issue sends the report to ADE. Nothing else leaves this computer unless you open the GitHub issue."
              : "Nothing leaves this computer unless you post the GitHub issue."}
          </p>
        </details>
      ) : null}
    </span>
  );
}
