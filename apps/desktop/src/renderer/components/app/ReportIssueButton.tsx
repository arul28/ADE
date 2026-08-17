import { useCallback, useState } from "react";
import type {
  DiagnosticReportPayload,
  DiagnosticReportRequestPayload,
} from "../../../shared/types/diagnostics";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ERROR_DISCLOSURE_CARET } from "./errorSurfaceKit";

export type ReportIssueVariant = "primary" | "secondary" | "ghost";

const VARIANT_CLASS: Record<ReportIssueVariant, string> = {
  primary:
    "inline-flex h-9 items-center justify-center rounded-lg bg-amber-400/90 px-4 text-[13px] font-semibold text-[#1a1206] transition-colors hover:bg-amber-300 disabled:opacity-60",
  secondary:
    "inline-flex h-9 items-center justify-center rounded-lg border border-border/80 bg-fg/[0.03] px-4 text-[13px] font-medium text-fg/75 transition-colors hover:bg-fg/[0.07] disabled:opacity-60",
  ghost:
    "inline-flex h-[22px] items-center justify-center rounded-md px-2 text-[11px] font-medium text-fg/60 transition-colors hover:bg-fg/[0.06] hover:text-fg/85 disabled:opacity-60",
};

/**
 * Every error screen's escape hatch: collect a redacted diagnostic report,
 * put it on the clipboard and on disk, and open a prefilled GitHub issue.
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
  const { copy, copied } = useCopyToClipboard();

  const bridge = typeof window !== "undefined" ? window.ade?.diagnostics : undefined;

  const run = useCallback(async () => {
    if (!bridge?.openIssue || pending) return;
    setPending(true);
    setError(null);
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
              className="font-medium text-fg/75 underline decoration-fg/25 underline-offset-2 transition-colors hover:text-fg"
            >
              {copied ? "Copied" : "Copy again"}
            </button>
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
            before the report is created. Nothing is sent until you post the issue.
          </p>
        </details>
      ) : null}
    </span>
  );
}
