import { useCallback, useEffect, useState } from "react";
import type { AndroidRecording } from "../../../../shared/types/androidEmulator";
import { formatRecordingBytes, formatRecordingElapsed, revealProofArtifactRow } from "../../shared/recordingFormat";
import { RecordingRow, recordingDisplayName } from "../../shared/RecordingRow";
import type { AndroidDrawerContext } from "./androidDrawerState";

/*
 * The **Capture** group: the lane's finished recordings. Record itself is a
 * rail control, beside the picture it records (as on the Apple pane), so this
 * card only lists, opens and deletes. Every stopped recording is filed to
 * proof, so "Open in proof" is the main action.
 */

export function AndroidCaptureSection({
  ctx,
  onOpenProof,
}: {
  ctx: AndroidDrawerContext;
  onOpenProof?: ((artifactId: string) => void) | undefined;
}) {
  const { laneId, pinRef, visible, actions, remoteMachineName } = ctx;
  const reportError = actions.reportError;
  const [recordings, setRecordings] = useState<AndroidRecording[] | null>(null);

  const refresh = useCallback(() => {
    window.ade.androidEmulator.recordList({ laneId }, pinRef.current)
      .then((list) => setRecordings(list.recordings))
      .catch((cause: unknown) => reportError(cause));
  }, [laneId, pinRef, reportError]);

  // One read when the card opens, then again on each `android.recording.state`
  // event: the rail, an agent or the CLI can start or stop one.
  useEffect(() => {
    if (!visible) return undefined;
    refresh();
    const unsubscribe = window.ade.androidEmulator.onEvent((event) => {
      if (event.type === "android.recording.state" && event.laneId === laneId) refresh();
    }, pinRef.current);
    return unsubscribe;
  }, [laneId, pinRef, refresh, visible]);

  const remove = (recording: AndroidRecording) => {
    void window.ade.androidEmulator.recordDelete({ laneId, id: recording.id }, pinRef.current)
      .then(refresh)
      .catch((cause: unknown) => reportError(cause));
  };
  const openProof = (recording: AndroidRecording, artifactId: string) => {
    if (onOpenProof) {
      onOpenProof(artifactId);
      return;
    }
    if (revealProofArtifactRow(artifactId)) return;
    // No proof drawer on screen: open the file, when it is on this machine.
    if (!remoteMachineName) void window.ade.app.openPath(recording.path).catch((cause: unknown) => reportError(cause));
  };

  const finished = (recordings ?? []).filter((recording) => !recording.active)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const running = (recordings ?? []).find((recording) => recording.active) ?? null;
  // A narrow pane puts this drawer over the recording pill, so the card says it too.
  const runningLine = running ? (
    <p className="flex items-center gap-1.5 text-[11px] text-fg/85" data-testid="android-drawer-recording-now">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-error)] motion-safe:animate-pulse" aria-hidden="true" />
      Recording now. Stop it on the rail.
    </p>
  ) : null;

  if (recordings === null) return <p className="text-[11px] text-muted-fg/70">Reading recordings…</p>;
  if (finished.length === 0) {
    return runningLine ?? <p className="text-[11px] text-muted-fg/70">No recordings for this lane yet. Press Record on the rail to make one.</p>;
  }
  return (
    <>
    {runningLine}
    <ul className="flex min-w-0 flex-col gap-1.5" aria-label="Recordings">
      {finished.map((recording) => {
        const parts = recording.segments.length > 1 ? ` · ${recording.segments.length} parts` : "";
        return (
          <RecordingRow
            key={recording.id}
            name={recordingDisplayName(recording)}
            detail={recording.lastError
              ? <span className="text-[var(--color-error)]">{recording.lastError}</span>
              : <>{formatRecordingElapsed(recording.durationMs ?? 0)} · {formatRecordingBytes(recording.bytes)}{parts}</>}
            artifactId={recording.proofArtifactIds[0] ?? null}
            enabled={visible}
            onOpenProof={(artifactId) => openProof(recording, artifactId)}
            onReveal={() => { void window.ade.app.revealPath(recording.path).catch((cause: unknown) => reportError(cause)); }}
            revealUnavailable={remoteMachineName ? `On ${remoteMachineName}` : null}
            onDelete={() => remove(recording)}
          />
        );
      })}
    </ul>
    </>
  );
}
