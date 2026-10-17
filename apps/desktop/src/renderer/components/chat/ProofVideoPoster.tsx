import { Play } from "@phosphor-icons/react";
import type { ComputerUseArtifactView } from "../../../shared/types";
import { cn } from "../ui/cn";

/**
 * A still of a recording's first frame with a play badge.
 *
 * The small tile never shows native controls or crops the frame: a tall
 * simulator recording and a wide Mac recording both letterbox on black. It is
 * a button: a click opens the lightbox, which plays it at its own size.
 */
export function ProofVideoPoster({
  artifact,
  preview,
  className,
  badgeSize,
  onOpen,
  onError,
}: {
  artifact: ComputerUseArtifactView;
  preview: string;
  className: string;
  badgeSize: "sm" | "md";
  onOpen?: () => void;
  onError: () => void;
}) {
  const body = (
    <>
      <video
        src={preview}
        preload="metadata"
        muted
        playsInline
        tabIndex={-1}
        aria-hidden
        onError={onError}
        className={cn("pointer-events-none block w-full bg-black object-contain", className)}
      />
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full border border-fg/[0.16] bg-black/58 text-white/88 shadow-[0_6px_20px_rgba(0,0,0,0.55)] backdrop-blur-sm transition-transform duration-200 group-hover:scale-105 group-hover/tile:scale-105",
            badgeSize === "sm" ? "h-6 w-6" : "h-10 w-10",
          )}
        >
          <Play size={badgeSize === "sm" ? 10 : 15} weight="fill" className="translate-x-px" />
        </span>
      </span>
    </>
  );

  return (
    <button
      type="button"
      className="relative block w-full overflow-hidden bg-black focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-violet-300/45"
      aria-label={`Play ${artifact.title}`}
      onClick={onOpen}
    >
      {body}
    </button>
  );
}
