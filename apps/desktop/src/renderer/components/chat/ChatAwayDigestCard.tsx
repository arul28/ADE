import { ClockCounterClockwise, X } from "@phosphor-icons/react";

export function ChatAwayDigestCard({
  count,
  firstReason,
  onReview,
  onDismiss,
}: {
  count: number;
  firstReason: string | null;
  onReview: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="chat-away-digest"
      className="pointer-events-auto flex w-fit max-w-[560px] items-center gap-2 rounded-2xl border border-amber-200/[0.14] bg-[#211b12]/94 px-2.5 py-2 font-sans shadow-[0_10px_28px_rgba(0,0,0,0.3)] backdrop-blur-xl"
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-200/[0.09] text-amber-200/75">
        <ClockCounterClockwise size={13} weight="bold" aria-hidden />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-[11px] font-medium text-amber-50/90">While you were away</span>
        <span className="mt-0.5 block text-[10px] text-amber-100/55">
          {count} scheduled wakeup{count === 1 ? "" : "s"} ran
        </span>
      </span>
      <button
        type="button"
        className="ml-1 shrink-0 rounded-full bg-amber-200/[0.09] px-2 py-1 text-[10px] font-medium text-amber-100/75 transition-colors hover:bg-amber-200/[0.15] hover:text-amber-50 focus-visible:bg-amber-200/[0.15] focus-visible:text-amber-50"
        title={firstReason ? `First wakeup: ${firstReason}` : "Jump to the first scheduled wakeup"}
        onClick={onReview}
      >
        Review
      </button>
      <button
        type="button"
        aria-label="Dismiss while-you-were-away summary"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-amber-100/40 transition-colors hover:bg-amber-200/10 hover:text-amber-100/80"
        onClick={onDismiss}
      >
        <X size={11} weight="bold" aria-hidden />
      </button>
    </div>
  );
}
