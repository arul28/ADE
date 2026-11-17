import { ImageSquare } from "@phosphor-icons/react";
import { formatBytes } from "../../../shared/formatting";
import { cn } from "../ui/cn";

/**
 * A picture that waits for a click on a slow connection to its machine. It
 * takes the slot and the look of the loading tile beside it, and says how
 * much the click loads. The composer's "Slow connection" chip says why.
 */
export function SlowLinkHeldPicture({
  title,
  bytes,
  onShow,
  className,
}: {
  title: string;
  bytes: number | null;
  onShow: () => void;
  className?: string;
}) {
  const size = typeof bytes === "number" ? formatBytes(bytes) : null;
  return (
    <button
      type="button"
      onClick={onShow}
      data-slow-link-held=""
      aria-label={`Show picture ${title}${size ? `, ${size}` : ""}`}
      className={cn(
        "flex min-h-36 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-fg/[0.06] bg-black/20 text-muted-fg/55 transition-colors hover:border-fg/[0.12] hover:text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45",
        className,
      )}
    >
      <ImageSquare size={18} aria-hidden />
      <span className="font-sans text-[length:calc(var(--chat-font-size)*11/14)]">Show picture</span>
      {size ? (
        <span className="font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/40">{size}</span>
      ) : null}
    </button>
  );
}
