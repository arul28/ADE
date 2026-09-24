import type { SimRecording } from "../../../main/services/ios/recording/simRecordingService";
import { RecordingSavedRow } from "../shared/RecordingReceipt";

/**
 * "Saved to proof · 0:23 · 8.5 MB · [Open]" — the receipt after a recording.
 *
 * Round 2's recordings were invisible: three MP4s in
 * `.ade/artifacts/apple-recordings/` after one live test, with nothing on
 * screen at any point saying a recording had started, stopped, or been kept.
 * This is the smallest thing that fixes that — it states what exists, where it
 * went, and how to get at it, then disappears. Opaque, because it sits over
 * the device picture (round 3 rule zero: nothing translucent in this feature).
 * The row itself is shared with the Mac Desktop pane.
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
  return (
    <RecordingSavedRow
      marker={{ "data-apple-recording-saved": recording.id }}
      durationMs={recording.durationMs ?? 0}
      bytes={recording.bytes}
      onOpen={() => onOpen(recording)}
      onDismiss={onDismiss}
    />
  );
}
