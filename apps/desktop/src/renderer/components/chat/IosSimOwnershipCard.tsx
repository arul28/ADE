import { Lock } from "@phosphor-icons/react";

type IosSimOwnershipCardProps = {
  /** Lane name when known, otherwise a short chat id. */
  ownerLabel: string;
  /** Relative age of the owning session, e.g. "12m ago". */
  ageLabel: string | null;
  onAttach: (() => void) | null;
  onTakeOver: () => void;
  busy?: boolean;
};

/** Who has it, since when, and the two things you can do about it. */
export function IosSimOwnershipCard({
  ownerLabel,
  ageLabel,
  onAttach,
  onTakeOver,
  busy = false,
}: IosSimOwnershipCardProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-md border border-amber-300/22 bg-amber-400/[0.08] px-2.5 py-2">
      <Lock size={14} weight="fill" className="shrink-0 text-amber-200/85" />
      <div className="min-w-0 flex-1 truncate font-sans text-[11px] text-amber-50/88">
        In use by <span className="font-medium">{ownerLabel}</span>
        {ageLabel ? <span className="ml-1 text-amber-100/55">{ageLabel}</span> : null}
      </div>
      {onAttach ? (
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center rounded-md border border-cyan-300/28 bg-cyan-400/12 px-2 font-sans text-[10px] font-medium text-cyan-50/90 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-45"
          onClick={onAttach}
          disabled={busy}
        >
          Attach
        </button>
      ) : null}
      <button
        type="button"
        className="inline-flex h-7 shrink-0 items-center rounded-md border border-amber-300/30 bg-amber-400/14 px-2 font-sans text-[10px] font-medium text-amber-50/92 transition-colors hover:bg-amber-400/22 disabled:cursor-not-allowed disabled:opacity-45"
        onClick={onTakeOver}
        disabled={busy}
      >
        Take over
      </button>
    </div>
  );
}
