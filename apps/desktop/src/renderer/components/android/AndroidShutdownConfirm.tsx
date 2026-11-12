import { useCallback, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { createAskOnceStore, type AskOnceRequest } from "../../lib/askOnceStore";
import { useConfirmKeys } from "../../lib/useConfirmKeys";
import { Dialog } from "../ui/dialog";
import { androidLaneDeviceName } from "./androidDeviceState";
import { useAppStore } from "../../state/appStore";

/**
 * "Shut down {device}?": the question closing the Android Development TAB
 * asks while the lane's emulator runs. The twin of `AppleShutdownConfirm`,
 * with the Mac Desktop's third answer:
 *
 * - **Close and shut down** closes the tab and powers the emulator off.
 * - **Keep running** closes the tab and leaves the emulator up. For an
 *   emulator ADE started on an AVD ADE made, the brain's idle power-off
 *   (`androidLaneMaintenance.ts`) stops it later. The idle time is a brain
 *   setting that the renderer does not read, so the copy names no number.
 * - **Cancel** keeps the tab and the emulator.
 *
 * It asks only when the emulator is up: closing the tab on an emulator that
 * is off asks nothing. A status read that fails closes the tab and leaves the
 * emulator alone: a close that cannot be checked must still close, and the
 * safe reading of "could not ask" is "do not power it off".
 */

export type AndroidCloseAnswer = "stop" | "keep" | "cancel";

export type AndroidShutdownConfirmQuestion = {
  deviceName: string;
  /** ADE made this AVD, so the idle power-off covers it. */
  idlePowerOff: boolean;
  /** The lane records now. Shutting down stops the recording and files it. */
  recording: boolean;
};

export type AndroidShutdownConfirmRequest = AskOnceRequest<AndroidShutdownConfirmQuestion, AndroidCloseAnswer>;

/** A second ask while one is on screen keeps the emulator running: two dialogs cannot both be answered. */
const confirmStore = createAskOnceStore<AndroidShutdownConfirmQuestion, AndroidCloseAnswer>("keep");

export function getAndroidShutdownConfirmRequest(): AndroidShutdownConfirmRequest | null {
  return confirmStore.get();
}

export function askAndroidShutdownConfirm(question: AndroidShutdownConfirmQuestion): Promise<AndroidCloseAnswer> {
  return confirmStore.ask(question);
}

/**
 * Whether and how the Android tool's tab closes. `keep` with no dialog when
 * there is no lane, no API, no device, the emulator is not up, or the read
 * failed.
 */
export async function confirmAndroidToolClose(args: {
  laneId: string | null;
  runtimePin?: OpenProjectBinding | null;
}): Promise<AndroidCloseAnswer> {
  const { laneId } = args;
  if (!laneId) return "keep";
  const api = window.ade?.androidEmulator;
  // The emulator's machine: the caller's pin, else the tab's copy. None: nothing to ask.
  const pin = args.runtimePin ?? useAppStore.getState().projectBinding;
  if (!api?.getStatus || !pin) return "keep";
  const status = await api.getStatus({ laneId }, pin).catch((cause: unknown) => {
    logRendererDebugEvent("android.tab_close_status_failed", { error: cause instanceof Error ? cause.message : String(cause) });
    return null;
  });
  const lane = status?.lane ?? null;
  if (!lane?.device || (lane.state !== "booted" && lane.state !== "starting")) return "keep";
  // One read, only when the question shows. A failed read leaves the recording sentence out.
  const recordings = await api.recordList?.({ laneId }, pin).catch((cause: unknown) => {
    logRendererDebugEvent("android.tab_close_recordings_failed", { error: cause instanceof Error ? cause.message : String(cause) });
    return null;
  });
  return askAndroidShutdownConfirm({
    deviceName: androidLaneDeviceName(lane),
    idlePowerOff: lane.device.origin === "created",
    recording: Boolean(recordings?.recordings.some((recording) => recording.active)),
  });
}

/** Test seam: an unanswered question from one test must not reach the next. */
export function resetAndroidShutdownConfirmForTests(): void {
  confirmStore.reset();
}

/** Mounts the question. One per Work page, beside the Apple one. */
export function AndroidShutdownConfirmHost() {
  const request = useSyncExternalStore(confirmStore.subscribe, confirmStore.get, confirmStore.get);
  if (!request) return null;
  return <AndroidShutdownConfirmDialog request={request} />;
}

function AndroidShutdownConfirmDialog({ request }: { request: AndroidShutdownConfirmRequest }) {
  const cancel = useCallback(() => confirmStore.settle("cancel"), []);
  const keep = useCallback(() => confirmStore.settle("keep"), []);
  const stop = useCallback(() => confirmStore.settle("stop"), []);
  // Escape cancels, Enter shuts down (the focused answer), as Apple's does.
  useConfirmKeys(cancel, stop);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      role="alertdialog"
      layer="nestedDialog"
      testId="android-shutdown-confirm"
      title={`Shut down ${request.deviceName}?`}
      description={androidShutdownDescription(request)}
      tone="error"
      hideClose
      width={440}
      actions={[
        { label: "Cancel", onClick: cancel, variant: "secondary" },
        { label: "Keep running", onClick: keep, variant: "secondary" },
        { label: "Close and shut down", onClick: stop, variant: "solid", autoFocus: true },
      ]}
    />
  );
}

/** The dialog's sentences. A recording that runs gets one more sentence. */
function androidShutdownDescription(question: AndroidShutdownConfirmQuestion): string {
  const keep = question.idlePowerOff
    ? "If you keep it running, ADE powers it off after it sits idle."
    : "If you keep it running, it stays on until you stop it.";
  const recording = question.recording ? " Shutting it down also stops the recording and saves it to proof." : "";
  return `Closing this tab can power off the emulator. ${keep}${recording}`;
}
