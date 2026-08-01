import { cn } from "../ui/cn";

/**
 * Same fixed heights as `ActivityCard`, so a popover that opens before the
 * first snapshot lands does not resize under the pointer when it arrives.
 */
export function ActivityCardSkeleton({ compact = false }: { compact?: boolean }) {
  const bar = "rounded-full bg-white/[0.07] motion-safe:animate-pulse";
  return (
    <div
      aria-hidden
      data-activity-skeleton=""
      className={cn(
        "w-full rounded-lg px-2 py-2",
        compact ? "h-[2.75rem]" : "h-[4.875rem]",
      )}
    >
      <div className="flex h-5 items-center gap-1.5">
        <span className={cn(bar, "h-2.5 w-24")} />
        <span className={cn(bar, "ml-auto h-2.5 w-14")} />
      </div>
      <div className="mt-1 flex h-4 items-center">
        <span className={cn(bar, "h-2.5 w-2/3")} />
      </div>
      {compact ? null : (
        <div className="mt-1.5 flex h-3.5 items-center gap-2">
          <span className={cn(bar, "h-2 w-1/2")} />
          <span className={cn(bar, "ml-auto h-2 w-10")} />
        </div>
      )}
    </div>
  );
}

export default ActivityCardSkeleton;
