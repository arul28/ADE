import { useState, type ReactNode, type RefObject } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { readDemoChapters } from "../../../shared/demoVideo/demoProofText";
import { formatProofDuration } from "../../../shared/proofProvenance";
import { cn } from "../ui/cn";
import { seekVideoAndPlay } from "../ui/MediaLightbox";

/**
 * A demo video's caption line, with its step captions as chapters.
 *
 * The chapters sit behind a small "Chapters" toggle to the right of the
 * caption, closed by default: the chips show only when it is open. A click on
 * a chip seeks the video to the step and plays it. A video with fewer than two
 * steps shows the caption alone: one chapter has nowhere to jump to.
 */
export function DemoChapters({ metadata, videoRef, children }: {
  metadata: unknown;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The caption line. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const chapters = readDemoChapters(metadata);
  if (chapters.length < 2) return <span className="mt-1.5 block min-w-0">{children}</span>;
  return (
    <>
      <span className="mt-1.5 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1">{children}</span>
        <button
          type="button"
          aria-expanded={open}
          data-testid="demo-chapters-toggle"
          className="inline-flex shrink-0 items-center gap-0.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-muted-fg/70 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45"
          onClick={() => setOpen((value) => !value)}
        >
          {`Chapters · ${chapters.length}`}
          <CaretDown size={10} className={cn("transition-transform", open ? "rotate-180" : null)} aria-hidden />
        </button>
      </span>
      {open ? (
        <span className="mt-1 flex min-w-0 flex-wrap gap-1" data-testid="demo-chapters">
          {chapters.map((chapter, index) => (
            <button
              key={`${index}:${chapter.t}`}
              type="button"
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-fg/[0.07] bg-fg/[0.03] px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/70 hover:bg-fg/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45"
              onClick={() => seekVideoAndPlay(videoRef.current, chapter.t)}
            >
              <span className="tabular-nums text-muted-fg">{formatProofDuration(chapter.t * 1000)}</span>
              <span className="truncate">{chapter.text}</span>
            </button>
          ))}
        </span>
      ) : null}
    </>
  );
}
