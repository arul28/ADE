import { useEffect, useMemo, useRef, useState } from "react";
import type { AppleLaneDevice, OpenProjectBinding } from "../../../../shared/types";
import { describeAppleError } from "../appleErrors";
import { Group } from "../../ui/drawerPrimitives";
import { DeviceToolsDrawerShell } from "../../device/DeviceToolsDrawerShell";
import { resetDeviceDrawerGroupsForTests, useDeviceDrawerGroup } from "../../device/deviceDrawerState";
import { APPLE_DRAWER_GROUPS, type AppleDrawerGroupId } from "./appleDrawerGroups";
import { useAppleDrawerActions, type AppleDrawerScope } from "./useAppleDrawerActions";
import type { AppleDrawerContext } from "./drawerContext";
import { AppSection } from "./sections/AppSection";
import { DeviceSection } from "./sections/DeviceSection";
import { CaptureSection } from "./sections/CaptureSection";
import { PreviewLabSection, type AppleRenderedPreview } from "./sections/PreviewLabSection";

/**
 * The Tools drawer (round 4 §B1/§B2). The pane owns the device and mounts this
 * lazily; the drawer owns nothing but its four groups and the one serialized
 * `act()` they share.
 *
 * Round 3 stacked NINE flat sections in one scroll — App, Simulator, Inspect,
 * Recording, Location, Permissions, Push, Preview Lab, Event log — every row
 * outlined, on a transparent column. Four collapsible cards replace them, one
 * open at a time:
 *
 * | Device      | Appearance, Text size, accessibility, Location, Status bar |
 * | App         | Foreground, Relaunch/Terminate, Open URL, Launch, Permissions, Push, Event log |
 * | Capture     | The lane's recordings |
 * | Preview Lab | Target, Render, Watch file, workspace actions |
 *
 * Inspect and Record are gone from here entirely: both are rail toggles now,
 * because both act on the PICTURE, and a control for the picture belongs beside
 * it rather than two columns away.
 *
 * `pin` is the runtime binding every `window.ade.iosSimulator` call is made
 * with — the spec's "runtime pin". It has to be the binding, not its key,
 * because a bare key cannot reach a remote runtime.
 */
export interface AppleToolsDrawerProps {
  pin: OpenProjectBinding | null;
  laneId: string;
  device: AppleLaneDevice;
  visible: boolean;
  onClose: () => void;
  /** null = back to device. */
  onPreviewRendered: (preview: AppleRenderedPreview | null) => void;
  /**
   * The chat this pane acts for. The open group is remembered per chat, so the
   * conversation you come back to opens on the card you left it on.
   * Null on a chatless surface, where the choice is remembered for the session
   * only — there is nowhere to key a persisted value to.
   */
  chatSessionId?: string | null;
  /**
   * The recording the RAIL is making right now, or null.
   *
   * Record left the drawer in round 4, which also took away the Capture card's
   * only way of knowing that a recording had just finished. This is that
   * signal, and nothing more: its identity changes on start and goes null on
   * stop, so one effect keyed on it re-reads the library once per transition.
   */
  activeRecordingId?: string | null;
  /**
   * Opens a finished recording in the proof drawer (round 3 §A3). Optional
   * because a surface without a proof drawer still renders the row — it falls
   * back to opening the file itself.
   */
  onOpenProof?: ((artifactId: string) => void) | undefined;
  className?: string;
}

const GROUP_TITLES: Record<AppleDrawerGroupId, string> = {
  device: "Device",
  app: "App",
  capture: "Capture",
  "preview-lab": "Preview Lab",
};

const DEFAULT_GROUP: AppleDrawerGroupId = "device";

/** Which group is open: per chat, or for the session on a chatless surface. */
export function useAppleDrawerGroup(chatSessionId: string | null): {
  open: AppleDrawerGroupId | null;
  toggle: (id: AppleDrawerGroupId) => void;
} {
  return useDeviceDrawerGroup({ chatSessionId, groups: APPLE_DRAWER_GROUPS, defaultGroup: DEFAULT_GROUP, storageKey: "appleToolsGroup" });
}

/** Test seam: the chatless surface's remembered group must not leak between tests. */
export function resetAppleDrawerGroupForTests(): void {
  resetDeviceDrawerGroupsForTests();
}

export function AppleToolsDrawer({
  pin,
  laneId,
  device,
  visible,
  onClose,
  onPreviewRendered,
  chatSessionId = null,
  activeRecordingId = null,
  onOpenProof,
  className,
}: AppleToolsDrawerProps) {
  // A ref, never a dep: the binding object is rebuilt on every cross-machine
  // merge, and depending on its identity would re-read settings on that timer.
  const pinRef = useRef<OpenProjectBinding | null>(pin);
  pinRef.current = pin;
  const scope = useMemo<AppleDrawerScope>(() => ({ laneId, deviceUdid: device.udid, chatSessionId: null }), [device.udid, laneId]);
  const actions = useAppleDrawerActions({ scope, pinRef, visible });
  const [foregroundApp, setForegroundApp] = useState<string | null>(null);
  const group = useAppleDrawerGroup(chatSessionId);
  const reportError = actions.reportError;

  /*
   * The foreground app, asked of the device itself every two seconds while the
   * App group is open, so an app opened from the home screen or from Xcode shows
   * up too. When the device reports only SpringBoard, fall back to the lane's
   * active app session, which is what ADE last launched here.
   *
   * Gated on the group rather than on the drawer: this is the App card's one
   * fact, and round 3 polled it from every drawer whatever was on screen.
   */
  const wantsForeground = visible && group.open === "app";
  useEffect(() => {
    if (!wantsForeground) return undefined;
    let cancelled = false;
    const api = window.ade.iosSimulator;
    const read = async () => {
      try {
        const front = await api.getForegroundApp({ laneId, deviceUdid: device.udid }, pinRef.current);
        if (cancelled) return;
        if (front?.bundleId) {
          setForegroundApp(front.bundleId);
          return;
        }
        const status = await api.getStatus(pinRef.current);
        if (cancelled) return;
        const session = status.activeSession;
        const sameLane = !session?.laneId || session.laneId === laneId;
        setForegroundApp(session && sameLane && session.deviceUdid === device.udid ? session.bundleId : null);
      } catch (cause: unknown) {
        if (!cancelled) reportError(cause);
      }
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [device.udid, laneId, reportError, wantsForeground]);

  const ctx: AppleDrawerContext = {
    scope,
    device,
    pinRef,
    visible,
    actions,
    foregroundApp,
    setForegroundApp,
  };
  const described = actions.error != null ? describeAppleError(actions.error) : null;

  return (
    <DeviceToolsDrawerShell
      tool="apple"
      pending={actions.pending}
      error={described}
      onDismissError={actions.clearError}
      reading={actions.settings === null && visible}
      onClose={onClose}
      className={className}
    >
      <Group
        id="device"
        title={GROUP_TITLES.device}
        open={group.open === "device"}
        onToggle={group.toggle}
        testId="apple-drawer-device"
      >
        <DeviceSection ctx={ctx} />
      </Group>
      <Group
        id="app"
        title={GROUP_TITLES.app}
        open={group.open === "app"}
        onToggle={group.toggle}
        testId="apple-drawer-app"
      >
        <AppSection ctx={ctx} />
      </Group>
      <Group
        id="capture"
        title={GROUP_TITLES.capture}
        open={group.open === "capture"}
        onToggle={group.toggle}
        testId="apple-drawer-capture"
      >
        <CaptureSection ctx={ctx} activeRecordingId={activeRecordingId} onOpenProof={onOpenProof} />
      </Group>
      <Group
        id="preview-lab"
        title={GROUP_TITLES["preview-lab"]}
        open={group.open === "preview-lab"}
        onToggle={group.toggle}
        testId="apple-drawer-preview-lab"
      >
        <PreviewLabSection ctx={ctx} onPreviewRendered={onPreviewRendered} />
      </Group>
    </DeviceToolsDrawerShell>
  );
}
