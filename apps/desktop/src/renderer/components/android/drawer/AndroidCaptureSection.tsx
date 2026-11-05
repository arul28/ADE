import { useCallback, useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { DotsThree } from "@phosphor-icons/react";
import type { AndroidRecording } from "../../../../shared/types/androidEmulator";
import { cn } from "../../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "../../ui/paneMenuTokens";
import { PaneTooltip } from "../../ui/PaneTooltip";
import { DRAWER_BUTTON, DRAWER_ICON_BUTTON } from "../../ui/drawerPrimitives";
import { formatRecordingBytes, formatRecordingElapsed, revealProofArtifactRow } from "../../shared/recordingFormat";
import { revealLabel } from "../../../lib/platform";
import type { AndroidDrawerContext } from "./androidDrawerState";

/*
 * The **Capture** group: the lane's finished recordings. Record itself is a
 * rail control, beside the picture it records (as on the Apple pane), so this
 * card only lists, opens and deletes. Every stopped recording is filed to
 * proof, so "Open in proof" is the main action.
 */

/** The label, else "Recording HH:MM:SS". */
export function androidRecordingName(recording: AndroidRecording): string {
  if (recording.label?.trim()) return recording.label.trim();
  const at = new Date(recording.startedAt);
  if (Number.isNaN(at.getTime())) return recording.id;
  return `Recording ${at.toLocaleTimeString([], { hour12: false })}`;
}

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
        const name = androidRecordingName(recording);
        const artifactId = recording.proofArtifactIds[0] ?? null;
        const parts = recording.segments.length > 1 ? ` · ${recording.segments.length} parts` : "";
        return (
          <li key={recording.id} className="flex min-h-7 min-w-0 flex-nowrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-fg/85" title={name}>{name}</div>
              <div className="truncate text-[11px] text-muted-fg">
                {recording.lastError
                  ? <span className="text-[var(--color-error)]">{recording.lastError}</span>
                  : <>{formatRecordingElapsed(recording.durationMs ?? 0)} · {formatRecordingBytes(recording.bytes)}{parts}</>}
              </div>
            </div>
            <PaneTooltip label={artifactId ? `Open ${name} in proof` : "This recording is not in proof"} side="left">
              <button
                type="button"
                className={cn(DRAWER_BUTTON, "shrink-0")}
                disabled={!visible || !artifactId}
                onClick={() => { if (artifactId) openProof(recording, artifactId); }}
              >
                Open in proof
              </button>
            </PaneTooltip>
            <DropdownMenu.Root>
              <PaneTooltip label={`More for ${name}`} side="left">
                <DropdownMenu.Trigger asChild>
                  <button type="button" className={DRAWER_ICON_BUTTON} aria-label={`More for ${name}`} disabled={!visible}>
                    <DotsThree size={14} weight="bold" />
                  </button>
                </DropdownMenu.Trigger>
              </PaneTooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
                  <DropdownMenu.Item
                    className={cn(MENU_ITEM_CLASS, "text-[12px]")}
                    disabled={Boolean(remoteMachineName)}
                    onSelect={() => { void window.ade.app.revealPath(recording.path).catch((cause: unknown) => reportError(cause)); }}
                  >
                    {remoteMachineName ? `On ${remoteMachineName}` : revealLabel}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className={cn(MENU_ITEM_CLASS, "text-[12px] text-[var(--color-error)]")}
                    onSelect={() => remove(recording)}
                  >
                    Delete
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </li>
        );
      })}
    </ul>
    </>
  );
}
