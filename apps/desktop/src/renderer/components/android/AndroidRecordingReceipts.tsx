import { useCallback, useState } from "react";
import { useTicker } from "../../lib/ticker";
import { RecordingPill, RecordingSavedRow } from "../shared/RecordingReceipt";
import { revealProofArtifactRow } from "../shared/recordingFormat";
import type { useAndroidRecording } from "./useAndroidRecording";

type AndroidRecordingState = ReturnType<typeof useAndroidRecording>;

/**
 * The pane's recording pill while the lane records: the time so far and Stop.
 * It owns the one-second ticker, so only the pill draws again each second.
 */
export function AndroidRecordingPill({ recording }: { recording: AndroidRecordingState }) {
  const active = recording.active;
  const tick = useTicker(1000, Boolean(active));
  if (!active) return null;
  return (
    <RecordingPill
      marker={{ "data-android-recording-pill": "" }}
      elapsedMs={Math.max(0, tick - Date.parse(active.startedAt)) || 0}
      stopDisabled={recording.busy}
      onStop={recording.toggleRecording}
    />
  );
}

/**
 * The "Saved to proof" receipt for the last recording this pane stopped.
 * Open shows its proof row, or else the file when it is on this computer.
 * Open or dismiss hides the receipt for that recording. Keep it mounted:
 * it holds which recording was dismissed.
 */
export function AndroidRecordingSavedReceipt({
  recording,
  remoteMachine,
  onError,
}: {
  recording: AndroidRecordingState;
  remoteMachine: boolean;
  onError: (cause: unknown) => void;
}) {
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const saved = recording.saved && recording.saved.id !== dismissedId ? recording.saved : null;
  const open = useCallback(() => {
    if (!saved) return;
    setDismissedId(saved.id);
    const artifactId = saved.proofArtifactIds[0] ?? null;
    if (artifactId && revealProofArtifactRow(artifactId)) return;
    // No proof row in this window: the file itself, when it is on this computer.
    if (!remoteMachine) void window.ade.app.openPath(saved.path).catch(onError);
  }, [onError, remoteMachine, saved]);
  if (!saved || recording.active) return null;
  return (
    <RecordingSavedRow
      marker={{ "data-android-recording-saved": saved.id }}
      durationMs={saved.durationMs ?? 0}
      bytes={saved.bytes}
      onOpen={open}
      onDismiss={() => setDismissedId(saved.id)}
    />
  );
}
