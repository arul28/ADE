import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { DotsThree } from "@phosphor-icons/react";
import type { SimRecording } from "../../../../../main/services/ios/recording/simRecordingService";
import { cn } from "../../../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "../../../ui/paneMenuTokens";
import {
  canDeleteRecording,
  describeRecording,
  formatRecordingBytes,
  formatRecordingElapsed,
  isRecordingActive,
  recordingElapsedMs,
  useAppleRecordings,
} from "../../appleRecording";
import { PaneTooltip } from "../../../ui/PaneTooltip";
import { appleRecordingProofArtifactId } from "../../appleDeviceState";
import { DRAWER_BUTTON, DRAWER_ICON_BUTTON, Row, Section } from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";

/** "signup", else the start time as `HH:MM:SS`. */
export function recordingName(recording: SimRecording): string {
  if (recording.label?.trim()) return recording.label.trim();
  const at = new Date(recording.startedAt);
  if (Number.isNaN(at.getTime())) return recording.id;
  return `Recording ${at.toLocaleTimeString([], { hour12: false })}`;
}

/**
 * Status row (Idle / Recording 0:42 + Stop), then the lane's recordings:
 * name, duration · size, `Open in proof`, and a `⋯` with Reveal in Finder and
 * Delete. Start/stop go through the pane's `recording` prop so the viewport
 * pill and this row can never disagree; the list is read here.
 *
 * There is no `Pin to proof`. A recording becomes a proof artifact the moment
 * it stops (round 3 §A3), so a button asking you to file it by hand was
 * offering to do something that had already happened. `Open in proof` is
 * DISABLED, never hidden, while a recording has no artifact id yet: the row
 * keeps its shape, and the tooltip says why. The meta line's last field is
 * `describeRecording` — "manual · proof", which is a description of the file,
 * not the old "· pinned" that read as an action already taken.
 *
 * Delete is offered on a proof row too: every stopped recording is proof now,
 * so the round-2 rule would have left a drawer nothing could be cleared from.
 */
export function RecordingSection({
  ctx,
  active,
  start,
  stop,
  onOpenProof,
}: {
  ctx: AppleDrawerContext;
  active: SimRecording | null;
  start: () => void;
  stop: () => void;
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  // The pane's `active` may be newer than our own list read; refresh on change.
  useEffect(() => { recordings.refresh(); }, [active?.id, active?.endedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const finished = recordings.recordings.filter((recording) => !isRecordingActive(recording));

  return (
    <Section title="Recording" testId="apple-drawer-recording">
      <Row label="Status">
        {active ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs text-fg/85" data-testid="apple-drawer-recording-status">
              <span className="h-2 w-2 rounded-full bg-[var(--color-error)]" aria-hidden="true" />
              Recording {formatRecordingElapsed(recordingElapsedMs(active, now))}
            </span>
            <button type="button" className={DRAWER_BUTTON} onClick={stop} disabled={!visible}>Stop</button>
          </>
        ) : (
          <>
            <span className="text-xs text-muted-fg" data-testid="apple-drawer-recording-status">Idle</span>
            <button type="button" className={DRAWER_BUTTON} onClick={start} disabled={!visible}>Record</button>
          </>
        )}
      </Row>
      {finished.length === 0 ? (
        <p className="text-[11px] text-muted-fg/70">No recordings for this lane yet.</p>
      ) : (
        <ul className="flex flex-col" aria-label="Recordings">
          {finished.map((recording) => {
            const name = recordingName(recording);
            const artifactId = appleRecordingProofArtifactId(recording);
            const canOpenProof = Boolean(visible && artifactId && onOpenProof);
            return (
              <li key={recording.id} className="flex min-h-7 min-w-0 flex-nowrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-fg/85" title={name}>{name}</div>
                  <div className="truncate text-[11px] text-muted-fg">
                    {formatRecordingElapsed(recording.durationMs ?? 0)} · {formatRecordingBytes(recording.bytes)}
                    {" · "}{describeRecording(recording)}
                  </div>
                </div>
                <PaneTooltip
                  label={canOpenProof ? `Open ${name} in proof` : "This recording is not in proof yet"}
                  side="left"
                >
                  <button
                    type="button"
                    className={cn(DRAWER_BUTTON, "shrink-0")}
                    disabled={!canOpenProof}
                    onClick={() => { if (artifactId) onOpenProof?.(artifactId); }}
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
                        onSelect={() => recordings.reveal(recording)}
                      >
                        Reveal in Finder
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={cn(MENU_ITEM_CLASS, "text-[12px] text-[var(--color-error)]")}
                        disabled={!canDeleteRecording(recording)}
                        onSelect={() => recordings.remove(recording.id)}
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
      )}
    </Section>
  );
}
