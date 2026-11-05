import { useRef } from "react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { Group } from "../../ui/drawerPrimitives";
import { DeviceToolsDrawerShell } from "../../device/DeviceToolsDrawerShell";
import { describeAndroidError } from "../androidDeviceState";
import { useAndroidDrawerActions, useAndroidDrawerGroup, type AndroidDrawerContext, type AndroidDrawerGroupId } from "./androidDrawerState";
import { AndroidDeviceSection } from "./AndroidDeviceSection";
import { AndroidAppSection } from "./AndroidAppSection";
import { AndroidCaptureSection } from "./AndroidCaptureSection";
import { AndroidEmulatorSection } from "./AndroidEmulatorSection";
import { AndroidLogsSection } from "./AndroidLogsSection";
import { AndroidPreviewsSection } from "./AndroidPreviewsSection";

/**
 * The Android Tools drawer: the Apple drawer's layout with Android's groups
 * (plan §5). One group is open at a time; a closed group is unmounted, so
 * only the open one polls the device.
 *
 * | Device   | Text size, Display size, Animations off, Show taps, Layout bounds |
 * | App      | In front, Build & run, Relaunch/Stop/Uninstall, Start, Open link, Install APK, Permissions |
 * | Capture  | The lane's recordings |
 * | Emulator | Appearance, Location, Battery, Network |
 * | Logs     | Logcat for the lane's app, Send to chat |
 * | Previews | Compose @Preview functions of a module, rendered with no emulator (P3) |
 *
 * `pin` is the binding of the machine that runs the emulator; every call goes
 * there. It is held in a ref: the binding object is rebuilt on each
 * cross-machine merge, and an effect keyed on it would read again for nothing.
 */
export interface AndroidToolsDrawerProps {
  pin: OpenProjectBinding | null;
  laneId: string;
  visible: boolean;
  onClose: () => void;
  chatSessionId?: string | null;
  onOpenProof?: ((artifactId: string) => void) | undefined;
  /** The machine that runs the emulator, when it is not this one. */
  remoteMachineName?: string | null;
  /** The packages ADE installed for the lane (`adeInstalledPackages`). */
  lanePackages?: readonly string[];
  onInsertDraft?: ((text: string) => void) | undefined;
  className?: string;
}

const NO_PACKAGES: readonly string[] = [];

const GROUP_TITLES: Record<AndroidDrawerGroupId, string> = {
  device: "Device",
  app: "App",
  capture: "Capture",
  emulator: "Emulator",
  logs: "Logs",
  previews: "Previews",
};

export function AndroidToolsDrawer({
  pin,
  laneId,
  visible,
  onClose,
  chatSessionId = null,
  onOpenProof,
  remoteMachineName = null,
  lanePackages = NO_PACKAGES,
  onInsertDraft,
  className,
}: AndroidToolsDrawerProps) {
  const pinRef = useRef<OpenProjectBinding | null>(pin);
  pinRef.current = pin;
  const actions = useAndroidDrawerActions({ laneId, pinRef, visible });
  const group = useAndroidDrawerGroup(chatSessionId);
  const ctx: AndroidDrawerContext = { laneId, pinRef, visible, actions, remoteMachineName, lanePackages, onInsertDraft };
  const described = actions.error != null ? describeAndroidError(actions.error) : null;

  const card = (id: AndroidDrawerGroupId, body: React.ReactNode) => (
    <Group id={id} title={GROUP_TITLES[id]} open={group.open === id} onToggle={group.toggle} testId={`android-drawer-${id}`}>
      {body}
    </Group>
  );

  return (
    <DeviceToolsDrawerShell
      tool="android"
      pending={actions.pending}
      error={described}
      onDismissError={actions.clearError}
      reading={actions.settings === null && visible}
      onClose={onClose}
      className={className}
    >
      {card("device", <AndroidDeviceSection ctx={ctx} />)}
      {card("app", <AndroidAppSection ctx={ctx} />)}
      {card("capture", <AndroidCaptureSection ctx={ctx} onOpenProof={onOpenProof} />)}
      {card("emulator", <AndroidEmulatorSection ctx={ctx} />)}
      {card("logs", <AndroidLogsSection ctx={ctx} />)}
      {card("previews", <AndroidPreviewsSection ctx={ctx} chatSessionId={chatSessionId} onOpenProof={onOpenProof} />)}
    </DeviceToolsDrawerShell>
  );
}
