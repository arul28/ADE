import type { ReactNode } from "react";
import type { OpenProjectBinding } from "../../../shared/types/core";
import type { AndroidLaneDeviceStatus, AndroidSdkStatus } from "../../../shared/types/androidEmulator";
import type { NoticeAction } from "../ui/notice";
import { confirmDialog } from "../ui/dialog/confirm";
import { showToast } from "../app/toast/toastStore";
import type { Device3DFailure } from "../device/Device3DView";
import { DeviceErrorStrip } from "../device/DeviceStatusStrip";
import { androidLowDiskSentence } from "../../../shared/androidDisk";
import { AndroidDeviceNoticeStrip } from "./AndroidDeviceStatus";
import type { AndroidCloudNeed } from "./AndroidCloudComputerNotice";
import {
  ANDROID_LOW_MEMORY_RISK,
  androidRailVisible,
  describeAndroidError,
  type AndroidErrorDescription,
  type AndroidPaneState,
} from "./androidDeviceState";

/** The emulator's machine: its pin, and its name when it is not this one. */
type AndroidPaneMachine = { remote: boolean; name: string | null; pin: OpenProjectBinding };

/**
 * Opens an emulator's log. The log is a file on the emulator's machine: on
 * another machine it cannot be opened from here, so its path goes to the
 * clipboard instead.
 */
function openAndroidLog(path: string, machine: AndroidPaneMachine, onError: (error: AndroidErrorDescription) => void): void {
  if (machine.remote) {
    void window.ade?.app?.writeClipboardText?.(path);
    showToast({
      id: "android-log",
      tone: "info",
      title: machine.name ? `The log is on ${machine.name}` : "The log is on another machine",
      message: `Its path is copied: ${path}`,
    });
    return;
  }
  void window.ade?.app?.openPath?.(path, machine.pin).catch((caught: unknown) => onError(describeAndroidError(caught)));
}

/**
 * adb refused a device, and other devices use the adb server, so the brain
 * did not restart it alone. True when the person agrees to restart it.
 */
function confirmAdbRestart(machineName: string | null): Promise<boolean> {
  return confirmDialog({
    title: "Restart adb?",
    message: `ADE stops the adb server on ${machineName ?? "this machine"} and starts a new one with the current adb key. `
      + "Other Android devices, and Android Studio, lose their connection for a few seconds.",
    confirmLabel: "Restart adb",
  });
}

/**
 * The Android pane's one strip at the top, split out of `AndroidDevicePane`:
 * the first that applies of a failed call, a crash, an off device, a lost
 * video, a 3D fallback and a host with no emulator acceleration. Null when
 * none applies. The pane owns every action.
 */
export function AndroidPaneStrip({
  error,
  paneState,
  lane,
  deviceName,
  streamError,
  threeFailure,
  acceleration,
  accelerationDismissed,
  canChoose,
  machine,
  adbRestartedAlready,
  onDismissError,
  onStart,
  onStartAnyway,
  onRestartAdb,
  onError,
  onChoose,
  onReconnect,
  onRetry3D,
  onDismiss3D,
  onDismissAcceleration,
  cloudNeedsFullComputer,
  renderCloudNotice,
}: {
  error: AndroidErrorDescription | null;
  paneState: AndroidPaneState;
  lane: AndroidLaneDeviceStatus | null;
  deviceName: string;
  streamError: string | null;
  threeFailure: Device3DFailure | null;
  acceleration: AndroidSdkStatus["acceleration"] | null;
  accelerationDismissed: boolean;
  /** The pane may offer "Choose another device". */
  canChoose: boolean;
  /** The emulator's machine: another machine's log path is copied, not opened. */
  machine: AndroidPaneMachine;
  /** adb refused the failed start after ADE had restarted the adb server: a new restart does not help. */
  adbRestartedAlready: boolean;
  onDismissError: () => void;
  onStart: () => void;
  onStartAnyway: () => void;
  /** adb refused a start and the person agreed to restart adb: the same start again, with the restart. */
  onRestartAdb: () => void;
  onError: (error: AndroidErrorDescription) => void;
  onChoose: () => void;
  onReconnect: () => void;
  onRetry3D: () => void;
  onDismiss3D: () => void;
  onDismissAcceleration: () => void;
  /** The machine is an ADE Cloud computer that can't run the emulator at all. */
  cloudNeedsFullComputer: boolean;
  /**
   * The machine is an ADE Cloud computer: the notice for what it lacks, in
   * place of "no emulator acceleration" (when `cloudNeedsFullComputer`) or a
   * start refused for disk, with its dismiss. Null on every other machine.
   */
  renderCloudNotice: ((need: AndroidCloudNeed, onDismiss: (() => void) | undefined) => ReactNode) | null;
}) {
  const restartAdb = () => {
    void confirmAdbRestart(machine.name).then((confirmed) => {
      if (confirmed) onRestartAdb();
    });
  };
  if (error?.code === "ANDROID_LOW_MEMORY") {
    // The memory guard: a warning with the numbers, and the person's way past it.
    return (
      <AndroidDeviceNoticeStrip
        tone="warning"
        sentence={`${error.sentence} ${ANDROID_LOW_MEMORY_RISK}`}
        actions={[{ label: "Start anyway", onClick: onStartAnyway }]}
        onDismiss={onDismissError}
      />
    );
  }
  if (error?.code === "ANDROID_NO_ACCELERATION" && renderCloudNotice && cloudNeedsFullComputer) {
    // A cloud computer has no KVM to turn on: what it is and the way to a
    // full computer, not a BIOS hint and not an error to report.
    return renderCloudNotice({ kind: "full-computer" }, onDismissError);
  }
  // A first start the disk can't hold: a refused start, or a boot that ended in it.
  const errorDisk = error?.disk ?? null;
  const lowDisk = errorDisk ?? (paneState === "crashed" && lane?.error ? describeAndroidError(lane.error).disk ?? null : null);
  if (lowDisk) {
    // A refusal can be dismissed; a crash stays until the next start.
    const dismiss = errorDisk ? onDismissError : undefined;
    if (renderCloudNotice) return renderCloudNotice({ kind: "disk", ...lowDisk }, dismiss);
    return (
      <AndroidDeviceNoticeStrip
        tone="warning"
        sentence={`${androidLowDiskSentence(lowDisk.neededMb, lowDisk.freeMb)} Free some space on this machine's disk, then start it again.`}
        actions={errorDisk ? [] : [{ label: "Start", onClick: onStart }]}
        onDismiss={dismiss}
      />
    );
  }
  if (error) {
    // adb refused a start: the same start again, with the adb restart the
    // person agrees to; none when ADE already restarted it and adb still refused.
    const restartHelps = error.code === "ANDROID_ADB_UNAUTHORIZED" && !adbRestartedAlready;
    return (
      <DeviceErrorStrip
        tool="android"
        sentence={error.sentence}
        detail={error.detail}
        actions={restartHelps ? [{ label: "Restart adb and start", onClick: restartAdb }] : undefined}
        onDismiss={onDismissError}
      />
    );
  }
  if (paneState === "crashed") {
    // One line, one action (the shared strip's rule); the log is a quiet
    // link, and "Choose another device" sits on the card below.
    const crash = lane?.error ?? null;
    const refused = crash?.code === "ANDROID_ADB_UNAUTHORIZED";
    // After a refusal that followed ADE's own adb restart, only the log helps.
    const actions: NoticeAction[] = !refused
      ? [{ label: "Restart", onClick: onStart }]
      : crash?.adbRestarted ? [] : [{ label: "Restart adb and start", onClick: restartAdb }];
    if (crash?.logPath) {
      const logPath = crash.logPath;
      actions.push({ label: "Open log", variant: "link", onClick: () => openAndroidLog(logPath, machine, onError) });
    }
    return (
      <DeviceErrorStrip
        tool="android"
        sentence={crash ? describeAndroidError(crash).sentence : `${deviceName} stopped.`}
        actions={actions}
        report={{
          surface: "android_device_boot",
          code: crash?.code ?? "android_device_stopped",
          // The title is already the brain's sentence; the code is what is new.
          technicalDetail: crash?.code ?? null,
        }}
      />
    );
  }
  if (paneState === "stopped") {
    return (
      <AndroidDeviceNoticeStrip
        sentence={`${deviceName} is off.`}
        actions={[
          { label: "Start", onClick: onStart },
          ...(canChoose ? [{ label: "Choose another device", variant: "secondary" as const, onClick: onChoose }] : []),
        ]}
      />
    );
  }
  if (paneState === "video-lost") {
    return (
      <AndroidDeviceNoticeStrip
        sentence={streamError ? `Video stopped. ${describeAndroidError(streamError).sentence}` : "Video stopped."}
        actions={[{ label: "Reconnect", onClick: onReconnect }]}
      />
    );
  }
  if (threeFailure && androidRailVisible(paneState)) {
    // The one sentence a fallback to flat says (Apple §A1).
    return (
      <AndroidDeviceNoticeStrip
        sentence={`${threeFailure} Showing the flat view.`}
        actions={[{ label: "Try 3D again", onClick: onRetry3D }]}
        onDismiss={onDismiss3D}
      />
    );
  }
  if (acceleration && !acceleration.usable && !accelerationDismissed && paneState !== "setup" && paneState !== "unsupported") {
    if (renderCloudNotice && cloudNeedsFullComputer) return renderCloudNotice({ kind: "full-computer" }, onDismissAcceleration);
    return (
      <AndroidDeviceNoticeStrip
        tone="warning"
        sentence={acceleration.detail
          ? `No emulator acceleration: ${acceleration.detail}`
          : "This machine has no emulator acceleration, so devices run very slowly or not at all."}
        actions={[{ label: "How to fix", variant: "link", href: "https://developer.android.com/studio/run/emulator-acceleration" }]}
        onDismiss={onDismissAcceleration}
      />
    );
  }
  return null;
}
