import { useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type { ChatErrorPresentation } from "../../../shared/chatErrorPresentation";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { noticeTone } from "../ui/notice";

const LINK_CLASS = "rounded px-1 text-fg/55 underline decoration-fg/20 underline-offset-2 transition-colors hover:text-fg/85 disabled:pointer-events-none disabled:opacity-40";

/**
 * A failed turn in the transcript: one line, no box. The tone glyph and title
 * make it hard to miss; Retry and Details are quiet links. What the provider
 * actually said, and anything technical, waits behind Details.
 *
 * Usage limits never reach this line: their turn-end line says "Usage limit"
 * and the pill above the composer owns what happens next.
 */
export function TurnFailureLine({
  presentation,
  title,
  repeatCount = 1,
  disabled,
  onRetry,
}: {
  presentation: ChatErrorPresentation;
  /** Overrides the presentation's title (a model at capacity). */
  title?: string;
  /** Identical failed retries folded into this line, itself included. */
  repeatCount?: number;
  disabled: boolean;
  /** Resolves to an error message when the retry could not start. */
  onRetry?: () => Promise<string | null>;
}) {
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { copy, copied } = useCopyToClipboard();
  const details = [presentation.body, presentation.technicalDetail]
    .map((part) => part?.trim() ?? "")
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join("\n\n");
  const tone = noticeTone("warning");

  const retry = async () => {
    if (!onRetry || retryPending) return;
    setRetryPending(true);
    setRetryError(null);
    try {
      setRetryError(await onRetry());
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 px-1 font-sans text-[length:calc(var(--chat-font-size)*11/14)]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <WarningCircle size={14} weight="fill" aria-hidden className="shrink-0" style={{ color: tone.color }} />
        <span className="font-medium" style={{ color: tone.text }}>{title ?? presentation.title}</span>
        {repeatCount > 1 ? (
          <span className="tabular-nums text-fg/40" title={`Failed the same way ${repeatCount} times`}>×{repeatCount}</span>
        ) : null}
        {onRetry ? (
          <button type="button" className={LINK_CLASS} disabled={disabled || retryPending} onClick={() => { void retry(); }}>
            {retryPending ? "Retrying…" : "Retry"}
          </button>
        ) : null}
        {details ? (
          <button type="button" className={LINK_CLASS} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
            Details
          </button>
        ) : null}
      </div>
      {retryError ? (
        <span role="alert" className="pl-5 text-[length:calc(var(--chat-font-size)*10.5/14)]" style={{ color: noticeTone("error").text }}>
          {retryError}
        </span>
      ) : null}
      {detailsOpen && details ? (
        <div className="ml-5 flex items-start gap-2 border-l border-(color:--kit-rule) pl-2.5">
          <pre className="max-h-40 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-(color:--kit-text-2)">
            {details}
          </pre>
          <button type="button" className={LINK_CLASS} onClick={() => void copy(details)}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
