import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { isImeComposing } from "../../lib/imeComposition";
import { Dialog } from "../ui/dialog";
import { androidLaneDeviceName } from "./androidDeviceState";

/**
 * "Shut down {device}?": the question closing the Android Development TAB
 * asks while the lane's emulator runs. The twin of `AppleShutdownConfirm`,
 * with the Mac Desktop's third answer:
 *
 * - **Close and shut down** closes the tab and powers the emulator off.
 * - **Keep running** closes the tab and leaves the emulator up. For an
 *   emulator ADE started on an AVD ADE made, the brain's idle power-off
 *   (`androidLaneMaintenance.ts`, 30 minutes with no use) stops it later.
 * - **Cancel** keeps the tab and the emulator.
 *
 * It asks only when the emulator is up: closing the tab on an emulator that
 * is off asks nothing. A status read that fails closes the tab and leaves the
 * emulator alone: a close that cannot be checked must still close, and the
 * safe reading of "could not ask" is "do not power it off".
 */

export type AndroidCloseAnswer = "stop" | "keep" | "cancel";

export type AndroidShutdownConfirmRequest = {
  deviceName: string;
  /** ADE made this AVD, so the idle power-off covers it. */
  idlePowerOff: boolean;
  resolve: (answer: AndroidCloseAnswer) => void;
};

let pending: AndroidShutdownConfirmRequest | null = null;
let listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function settle(answer: AndroidCloseAnswer): void {
  const request = pending;
  pending = null;
  emit();
  request?.resolve(answer);
}

export function getAndroidShutdownConfirmRequest(): AndroidShutdownConfirmRequest | null {
  return pending;
}

/** A second ask while one is on screen keeps the emulator running: two dialogs cannot both be answered. */
export function askAndroidShutdownConfirm(deviceName: string, idlePowerOff: boolean): Promise<AndroidCloseAnswer> {
  if (pending) return Promise.resolve("keep");
  return new Promise<AndroidCloseAnswer>((resolve) => {
    pending = { deviceName, idlePowerOff, resolve };
    emit();
  });
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
  if (!api?.getStatus) return "keep";
  const status = await api.getStatus({ laneId }, args.runtimePin ?? undefined).catch((cause: unknown) => {
    logRendererDebugEvent("android.tab_close_status_failed", { error: cause instanceof Error ? cause.message : String(cause) });
    return null;
  });
  const lane = status?.lane ?? null;
  if (!lane?.device || (lane.state !== "booted" && lane.state !== "starting")) return "keep";
  return askAndroidShutdownConfirm(androidLaneDeviceName(lane), lane.device.origin === "created");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: an unanswered question from one test must not reach the next. */
export function resetAndroidShutdownConfirmForTests(): void {
  pending = null;
  listeners = new Set();
}

/** Mounts the question. One per Work page, beside the Apple one. */
export function AndroidShutdownConfirmHost() {
  const request = useSyncExternalStore(subscribe, getAndroidShutdownConfirmRequest, getAndroidShutdownConfirmRequest);
  if (!request) return null;
  return <AndroidShutdownConfirmDialog request={request} />;
}

function AndroidShutdownConfirmDialog({ request }: { request: AndroidShutdownConfirmRequest }) {
  const cancel = useCallback(() => settle("cancel"), []);
  const keep = useCallback(() => settle("keep"), []);
  const stop = useCallback(() => settle("stop"), []);

  // Escape cancels, Enter shuts down (the focused answer), as Apple's does.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || isImeComposing(event)) return;
      if ((event.target as HTMLElement | null)?.tagName?.toLowerCase() === "button") return;
      event.preventDefault();
      stop();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, stop]);

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
      description={request.idlePowerOff
        ? "Closing this tab can power off the emulator. If you keep it running, ADE powers it off after 30 minutes with no use."
        : "Closing this tab can power off the emulator. If you keep it running, it stays on until you stop it."}
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
