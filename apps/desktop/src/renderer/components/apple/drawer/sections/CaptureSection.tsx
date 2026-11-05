import { useEffect, useRef } from "react";
import {
  canDeleteRecording,
  describeRecording,
  formatRecordingBytes,
  formatRecordingElapsed,
  isRecordingActive,
  useAppleRecordings,
} from "../../appleRecording";
import { appleRecordingProofArtifactId } from "../../appleDeviceState";
import { RecordingRow, recordingDisplayName } from "../../../shared/RecordingRow";
import type { AppleDrawerContext } from "../drawerContext";

/** How often the open Capture card re-reads the lane's recordings. */
export const CAPTURE_POLL_MS = 5_000;

/**
 * §B1's **Capture** group: what this lane has recorded, and nothing else.
 *
 * Round 4 moved Record itself into the RAIL, where the thing you are recording
 * is. What is left here is the library — a row per finished recording with
 * **Open in proof** and a `⋯` for Reveal in Finder and Delete — and this group
 * deliberately cannot START one. A drawer with its own Record button next to a
 * rail with another was two controls for one state, and the pair could
 * disagree about what "recording" meant.
 *
 * There is no `Pin to proof`. A recording becomes a proof artifact the moment
 * it stops (round 3 §A3), so a button asking you to file it by hand was
 * offering to do something that had already happened. `Open in proof` is
 * DISABLED, never hidden, while a recording has no artifact id yet: the row
 * keeps its shape, and the tooltip says why.
 *
 * Delete is offered on a proof row too: every stopped recording is proof now,
 * so the round-2 rule would have left a drawer nothing could be cleared from.
 */
export function CaptureSection({
  ctx,
  activeRecordingId = null,
  onOpenProof,
}: {
  ctx: AppleDrawerContext;
  /**
   * The recording the RAIL is making, or null. Its identity changes on start
   * and goes null on stop, so an effect keyed on it re-reads the library once
   * per transition.
   */
  activeRecordingId?: string | null;
  /** Navigates to the proof drawer. Absent on a surface that has no drawer. */
  onOpenProof?: ((artifactId: string) => void) | undefined;
}) {
  const { scope, pinRef, visible, actions } = ctx;
  const recordings = useAppleRecordings({
    laneId: scope.laneId,
    chatSessionId: null,
    enabled: visible,
    runtimePinRef: pinRef,
    onError: (message) => { if (message) actions.reportError(new Error(message)); },
  });
  /*
   * Recording is a RAIL control now, so this card is told about one rather than
   * owning it — and a library that only updates when you close and reopen the
   * card is a library that looks broken the first time you use Record.
   *
   * Two reads, for two different writers:
   *
   * - `activeRecordingId` covers the rail. It changes identity on start and
   *   goes null on stop, so this fires exactly once per transition and the row
   *   is there the moment the recording is.
   * - The slow poll covers everything NEITHER surface started: an agent's
   *   auto-record, a `ade apple record` on the CLI, another chat on the same
   *   lane. Scoped to the open card — one group is open at a time, and the
   *   timer dies with it, because a closed group is UNMOUNTED.
   */
  const refresh = recordings.refresh;
  // The first render is not a transition: the hook has already read the list
  // once, and re-reading here would double every open of the card.
  const lastActiveId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = lastActiveId.current;
    lastActiveId.current = activeRecordingId;
    if (previous !== undefined && previous !== activeRecordingId) refresh();
  }, [activeRecordingId, refresh]);
  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setInterval(() => refresh(), CAPTURE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, visible]);

  const finished = recordings.recordings.filter((recording) => !isRecordingActive(recording));
  // The drawer's own `openProofArtifact` already falls back to opening the file
  // when the proof panel is not on screen, so the host's navigator is an
  // override rather than a requirement.
  const open = onOpenProof ?? recordings.openProofArtifact;

  if (finished.length === 0) {
    return <p className="text-[11px] text-muted-fg/70">No recordings for this lane yet.</p>;
  }
  return (
    <ul className="flex min-w-0 flex-col" aria-label="Recordings">
      {finished.map((recording) => (
        <RecordingRow
          key={recording.id}
          name={recordingDisplayName(recording)}
          detail={<>{formatRecordingElapsed(recording.durationMs ?? 0)} · {formatRecordingBytes(recording.bytes)}{" · "}{describeRecording(recording)}</>}
          artifactId={appleRecordingProofArtifactId(recording)}
          enabled={visible}
          onOpenProof={open}
          onReveal={() => recordings.reveal(recording)}
          onDelete={() => recordings.remove(recording.id)}
          deleteDisabled={!canDeleteRecording(recording)}
        />
      ))}
    </ul>
  );
}
