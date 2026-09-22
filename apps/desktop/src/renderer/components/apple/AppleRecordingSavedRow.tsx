import { X } from "@phosphor-icons/react";
import type { SimRecording } from "../../../main/services/ios/recording/simRecordingService";
import { formatRecordingBytes, formatRecordingElapsed } from "./appleRecording";

/**
 * "Saved to proof · 0:23 · 8.5 MB · [Open]" — the receipt after a recording.
 *
 * Round 2's recordings were invisible: three MP4s in
 * `.ade/artifacts/apple-recordings/` after one live test, with nothing on
 * screen at any point saying a recording had started, stopped, or been kept.
 * This is the smallest thing that fixes that — it states what exists, where it
 * went, and how to get at it, then disappears. Opaque, because it sits over
 * the device picture (round 3 rule zero: nothing translucent in this feature).
 */
export function AppleRecordingSavedRow({
  recording,
  onOpen,
  onDismiss,
}: {
  recording: SimRecording | null;
  onOpen: (recording: SimRecording) => void;
  onDismiss: () => void;
}) {
  if (!recording) return null;
  const duration = formatRecordingElapsed(recording.durationMs ?? 0);
  const size = formatRecordingBytes(recording.bytes);
  return (
    <div
      data-apple-recording-saved={recording.id}
      role="status"
      className="absolute inset-x-3 bottom-3 z-20 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 font-sans text-xs text-fg shadow-sm"
    >
      <span className="min-w-0 truncate">
        Saved to proof · <span className="tabular-nums">{duration}</span> ·{" "}
        <span className="tabular-nums">{size}</span>
      </span>
      <button
        type="button"
        className="ml-auto shrink-0 rounded px-2 py-0.5 font-medium text-accent hover:bg-white/[0.07]"
        onClick={() => onOpen(recording)}
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
