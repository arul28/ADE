import type { CSSProperties } from "react";
import { X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { formatRecordingBytes, formatRecordingElapsed } from "./recordingFormat";

/**
 * The two pieces of recording chrome a screen tool draws over its picture.
 *
 * Both are opaque on purpose: they sit over a moving picture, and anything
 * translucent there is text read through video. `marker` carries the caller's
 * own data attributes, so each tool keeps its selectors.
 */

type Marker = Record<`data-${string}`, string>;

/** "● Recording 00:12  Stop", bottom centre of the picture. */
export function RecordingPill({
  elapsedMs,
  onStop,
  stopDisabled,
  marker,
  className,
  style,
}: {
  elapsedMs: number;
  onStop: () => void;
  stopDisabled?: boolean;
  marker?: Marker;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      {...marker}
      style={style}
      className={cn(
        "absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-surface px-3 py-1 font-sans text-xs text-fg shadow-sm",
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-error)] motion-safe:animate-pulse" />
      <span className="tabular-nums">
        Recording {formatRecordingElapsed(elapsedMs)}
      </span>
      <Button variant="ghost" size="sm" className="h-5 px-1.5" disabled={stopDisabled} onClick={onStop}>
        Stop
      </Button>
    </div>
  );
}

/**
 * "Saved to proof · 0:23 · 8.5 MB · [Open]" — the receipt after a capture.
 *
 * It states what exists, where it went, and how to get at it, then the caller
 * clears it. A capture with no running time (a screenshot) passes a null
 * duration and the receipt leaves that part out.
 */
export function RecordingSavedRow({
  durationMs,
  bytes,
  onOpen,
  onDismiss,
  marker,
  className,
  style,
}: {
  durationMs: number | null;
  bytes: number | null | undefined;
  onOpen: () => void;
  onDismiss: () => void;
  marker?: Marker;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      {...marker}
      style={style}
      role="status"
      className={cn(
        "absolute inset-x-3 bottom-3 z-20 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 font-sans text-xs text-fg shadow-sm",
        className,
      )}
    >
      <span className="min-w-0 truncate">
        Saved to proof
        {durationMs != null ? (
          <>
            {" · "}
            <span className="tabular-nums">{formatRecordingElapsed(durationMs)}</span>
          </>
        ) : null}
        {" · "}
        <span className="tabular-nums">{formatRecordingBytes(bytes)}</span>
      </span>
      <button
        type="button"
        className="ml-auto shrink-0 rounded px-2 py-0.5 font-medium text-accent hover:bg-white/[0.07]"
        onClick={onOpen}
      >
        Open
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-muted-fg hover:bg-white/[0.07] hover:text-fg"
        onClick={onDismiss}
      >
        <X size={12} />
      </button>
    </div>
  );
}
