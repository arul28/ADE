import React from "react";
import { X, Check, CircleNotch } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";
import type { DictationPhase } from "../../state/appStore";

/**
 * Shared presentational voice-capture pill, used identically by the chat
 * composer and the always-mounted header indicator. It is purely visual — all
 * capture state comes from the root store's dictation slice and the cancel/done
 * handlers are wired to the app-global recorder by the caller.
 */

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Real-amplitude waveform. `barHeightPx` controls the per-bar max height. */
export function Waveform({
  levels,
  barHeightPx = 16,
  className,
}: {
  levels: number[];
  barHeightPx?: number;
  className?: string;
}) {
  const reducedMotion = prefersReducedMotion();
  return (
    <div className={cn("flex items-end gap-[2px]", className)} aria-hidden style={{ height: barHeightPx }}>
      {levels.map((level, index) => (
        <span
          key={index}
          className="w-[2px] rounded-full bg-red-300/70"
          style={{
            height: `${Math.round(Math.max(0.05, level) * barHeightPx)}px`,
            transition: reducedMotion ? undefined : "height 90ms linear",
          }}
        />
      ))}
    </div>
  );
}

/**
 * The recording / transcribing pill. While `phase === "recording"` it shows a
 * live timer + waveform + cancel/done. While `phase === "transcribing"` it shows
 * a spinner ("transcribing…") and no controls. Renders nothing when idle.
 */
export function RecordingPill({
  phase,
  elapsedSeconds,
  levels,
  onCancel,
  onDone,
  className,
  fontSizeStyle,
  compact = false,
}: {
  phase: DictationPhase;
  elapsedSeconds: number;
  levels: number[];
  onCancel: () => void;
  onDone: () => void;
  className?: string;
  /** Optional CSS length for the timer/label text (defaults to a fixed 10px). */
  fontSizeStyle?: string;
  /** Tighter sizing for the title-bar header indicator so it isn't flush to the window edge. */
  compact?: boolean;
}) {
  if (phase === "idle") return null;
  const textSize = fontSizeStyle ?? "10px";
  const containerSize = compact ? "gap-1.5 px-2 py-0.5" : "gap-2 px-2.5 py-1";
  const iconButtonSize = compact ? "h-5 w-5" : "h-6 w-6";
  const doneButtonSize = compact ? "h-5 px-1.5" : "h-6 px-2";
  const waveHeightPx = compact ? 12 : 16;
  const waveClass = compact ? "h-3" : "h-4";

  if (phase === "transcribing") {
    return (
      <div
        className={cn(
          "inline-flex items-center rounded-full border border-red-500/30 bg-red-500/[0.10]",
          containerSize,
          className,
        )}
        role="status"
        aria-label="Transcribing voice input"
      >
        <CircleNotch size={12} weight="bold" className="animate-spin text-red-200/90" aria-hidden />
        <span
          className="font-sans tabular-nums text-red-200/90"
          style={{ fontSize: textSize }}
        >
          transcribing…
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border border-red-500/30 bg-red-500/[0.10]",
        containerSize,
        className,
      )}
      role="group"
      aria-label="Recording voice input"
    >
      <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
      <span
        className="font-mono tabular-nums text-red-200/90"
        style={{ fontSize: textSize }}
      >
        {formatTimer(elapsedSeconds)}
      </span>
      <Waveform levels={levels} barHeightPx={waveHeightPx} className={waveClass} />
      <SmartTooltip content={{ label: "Cancel", description: "Discard this recording." }}>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "inline-flex items-center justify-center rounded-full text-red-200/70 transition-colors hover:bg-red-500/[0.18] hover:text-red-100",
            iconButtonSize,
          )}
          aria-label="Cancel recording"
        >
          <X size={12} weight="bold" />
        </button>
      </SmartTooltip>
      <SmartTooltip content={{ label: "Done", description: "Stop recording and insert the transcript." }}>
        <button
          type="button"
          onClick={onDone}
          className={cn(
            "inline-flex items-center justify-center gap-1 rounded-full bg-red-500 text-white transition-colors hover:bg-red-400",
            doneButtonSize,
          )}
          aria-label="Finish recording and insert transcript"
        >
          <Check size={12} weight="bold" />
          <span className="font-sans font-medium" style={{ fontSize: textSize }}>done</span>
        </button>
      </SmartTooltip>
    </div>
  );
}
