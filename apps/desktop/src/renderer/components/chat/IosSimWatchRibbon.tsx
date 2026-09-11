import { Eye, Lock } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

/**
 * Says who owns the session, over the live view rather than above it.
 *
 * The full ownership card sits between the chrome and the video and pushes the
 * video down, so a chat that is only watching loses screen to a sentence it has
 * already read. The ribbon says the same thing in the same place the eye is
 * already looking, and gives back the height.
 */
export type IosSimWatchRibbonProps = {
  ownerLabel: string;
  ageLabel: string | null;
  onAttach: (() => void) | null;
  onTakeOver: () => void;
  busy?: boolean;
  className?: string;
};

export function IosSimWatchRibbon({
  ownerLabel,
  ageLabel,
  onAttach,
  onTakeOver,
  busy = false,
  className,
}: IosSimWatchRibbonProps) {
  return (
    <div
      className={cn(
        "pointer-events-auto absolute inset-x-3 top-3 z-20 flex h-7 items-center gap-2 rounded-md border border-amber-300/24 bg-black/70 px-2 shadow-lg backdrop-blur",
        className,
      )}
      data-testid="ios-watch-ribbon"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <Eye size={12} weight="fill" className="shrink-0 text-amber-200/85" />
      <div className="min-w-0 flex-1 truncate font-sans text-[10px] text-amber-50/88">
        Watching &middot; owned by <span className="font-medium">{ownerLabel}</span>
        {ageLabel ? <span className="ml-1 text-amber-100/55">{ageLabel}</span> : null}
      </div>
      {onAttach ? (
        <button
          type="button"
          className="inline-flex h-5 shrink-0 items-center rounded border border-cyan-300/28 bg-cyan-400/12 px-1.5 font-sans text-[10px] font-medium text-cyan-50/90 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-45"
          onClick={onAttach}
          disabled={busy}
        >
          Attach
        </button>
      ) : null}
      <button
        type="button"
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-amber-300/30 bg-amber-400/14 px-1.5 font-sans text-[10px] font-medium text-amber-50/92 transition-colors hover:bg-amber-400/22 disabled:cursor-not-allowed disabled:opacity-45"
        onClick={onTakeOver}
        disabled={busy}
      >
        <Lock size={10} weight="fill" />
        Take over
      </button>
    </div>
  );
}
