import { Warning } from "@phosphor-icons/react";
import type { ChatErrorPresentation } from "../../../shared/chatErrorPresentation";
import { ERROR_BODY, ERROR_HEADLINE, TechnicalDetailsFold } from "../app/errorSurfaceKit";

/**
 * Compact instruction card for failed turns and in-tab domain errors.
 * Same tokens as ErrorSurfaceCard: one title, one sentence, at most two
 * what-to-do lines, Retry, and the shared `TechnicalDetailsFold`. Never titles
 * Error / Unknown.
 */
export function InstructionErrorCard({
  presentation,
  onRetry,
  retryLabel = "Retry",
  disabled,
}: {
  presentation: ChatErrorPresentation;
  onRetry?: () => void;
  retryLabel?: string;
  disabled?: boolean;
}) {
  const technical = presentation.technicalDetail?.trim() ?? "";
  const nextActions = presentation.nextAction
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2) ?? [];

  return (
    <div className="rounded-xl border border-border/70 bg-fg/[0.02] px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-400/10 text-amber-300">
          <Warning size={13} weight="bold" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className={ERROR_HEADLINE}>{presentation.title}</h2>
          <p className={ERROR_BODY}>{presentation.body}</p>
          {nextActions.length > 0 ? (
            <ul className="mt-2 flex list-disc flex-col gap-0.5 pl-4 text-[12.5px] leading-relaxed text-fg/60 marker:text-fg/25">
              {nextActions.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onRetry}
              className="mt-3 inline-flex h-8 items-center justify-center rounded-lg bg-amber-400/90 px-3 text-[12.5px] font-semibold text-[#1a1206] transition-colors hover:bg-amber-300 disabled:opacity-60"
            >
              {retryLabel}
            </button>
          ) : null}
          <TechnicalDetailsFold text={technical} className="mt-3" />
        </div>
      </div>
    </div>
  );
}
