import { useRef } from "react";
import { SpinnerGap, X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { PaneTooltip } from "../../ui/PaneTooltip";
import { Banner } from "../../ui/notice";
import { DRAWER_ICON_BUTTON, Group } from "../../ui/drawerPrimitives";
import { describeAndroidError } from "../androidDeviceState";
import { useAndroidDrawerActions, useAndroidDrawerGroup, type AndroidDrawerContext, type AndroidDrawerGroupId } from "./androidDrawerState";
import { AndroidDeviceSection } from "./AndroidDeviceSection";
import { AndroidAppSection } from "./AndroidAppSection";
import { AndroidCaptureSection } from "./AndroidCaptureSection";
import { AndroidEmulatorSection } from "./AndroidEmulatorSection";

/**
 * The Android Tools drawer: the Apple drawer's layout with Android's groups
 * (plan §5). One group is open at a time; a closed group is unmounted, so
 * only the open one polls the device.
 *
 * | Device   | Text size, Display size, Animations off, Show taps, Layout bounds |
 * | App      | In front, Build & run, Relaunch/Stop/Uninstall, Start, Open link, Install APK, Permissions |
 * | Capture  | The lane's recordings |
 * | Emulator | Appearance, Location, Battery, Network |
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
  className?: string;
}

const GROUP_TITLES: Record<AndroidDrawerGroupId, string> = {
  device: "Device",
  app: "App",
  capture: "Capture",
  emulator: "Emulator",
};

export function AndroidToolsDrawer({
  pin,
  laneId,
  visible,
  onClose,
  chatSessionId = null,
  onOpenProof,
  remoteMachineName = null,
  className,
}: AndroidToolsDrawerProps) {
  const pinRef = useRef<OpenProjectBinding | null>(pin);
  pinRef.current = pin;
  const actions = useAndroidDrawerActions({ laneId, pinRef, visible });
  const group = useAndroidDrawerGroup(chatSessionId);
  const ctx: AndroidDrawerContext = { laneId, pinRef, visible, actions, remoteMachineName };
  const described = actions.error != null ? describeAndroidError(actions.error) : null;

  const card = (id: AndroidDrawerGroupId, body: React.ReactNode) => (
    <Group id={id} title={GROUP_TITLES[id]} open={group.open === id} onToggle={group.toggle} testId={`android-drawer-${id}`}>
      {body}
    </Group>
  );

  return (
    <div
      className={cn("flex h-full min-h-0 w-full min-w-0 flex-col border-l border-border bg-surface text-sm", className)}
      data-testid="android-tools-drawer"
    >
      <div className="flex h-9 min-w-0 shrink-0 flex-nowrap items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">Tools</span>
        {actions.pending ? <SpinnerGap size={14} className="shrink-0 animate-spin text-muted-fg" aria-label="Working" /> : null}
        <PaneTooltip label="Close tools" side="bottom">
          <button type="button" className={cn(DRAWER_ICON_BUTTON, "shrink-0")} aria-label="Close tools" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </PaneTooltip>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {described ? (
          <Banner
            layout="inline"
            testId="android-drawer-error"
            style={{ margin: 8 }}
            model={{
              id: "android-drawer-error",
              tone: "error",
              title: described.sentence,
              report: { surface: "android_tools_drawer", technicalDetail: described.detail ?? null },
              dismiss: { label: "Dismiss", onDismiss: actions.clearError },
            }}
          />
        ) : null}
        {actions.settings === null && !described && visible ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-fg">
            <SpinnerGap size={14} className="animate-spin" aria-hidden="true" /> Reading device settings…
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-2 p-2.5">
          {card("device", <AndroidDeviceSection ctx={ctx} />)}
          {card("app", <AndroidAppSection ctx={ctx} />)}
          {card("capture", <AndroidCaptureSection ctx={ctx} onOpenProof={onOpenProof} />)}
          {card("emulator", <AndroidEmulatorSection ctx={ctx} />)}
        </div>
      </div>
    </div>
  );
}
