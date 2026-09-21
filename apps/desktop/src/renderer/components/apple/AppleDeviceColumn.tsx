import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretDown, DeviceMobile, DeviceTablet, X } from "@phosphor-icons/react";
import type {
  AppleDeviceOrientation,
  AppleInstalledSimulator,
  AppleLaneDevice,
  IosElementContextItem,
  IosScreenElement,
  IosScreenSnapshot,
  IosSimulatorLaunchProgress,
  IosSimulatorStatus,
  OpenProjectBinding,
} from "../../../shared/types";
import { APPLE_NO_INSTALLED_SIMULATORS_CODE } from "../../../shared/types/iosSimulator";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS } from "../ui/paneMenuTokens";
import {
  WORK_TOOL_CHROME_BUTTON,
  WORK_TOOL_CHROME_CHIP,
  WORK_TOOL_CHROME_ROW,
} from "../terminals/workToolChrome";
import { IosSimLaunchStepper, selectLaunchSteps } from "../chat/IosSimLaunchStepper";
import { IosSimOwnershipCard } from "../chat/IosSimOwnershipCard";
import { IosSimToolsColumn } from "../chat/IosSimToolsColumn";
import { IosSimVideoOverlay, resolveIosSimBlocker, type IosSimBlockerAction } from "../chat/IosSimVideoOverlay";
import { IosSimWatchRibbon } from "../chat/IosSimWatchRibbon";
import { useIosSimDeviceTools } from "../chat/useIosSimDeviceTools";
import { isWebCodecsAvailable } from "../chat/IosSimH264Video";
import { AppleDeviceCreateDialog } from "./AppleDeviceCreateDialog";
import { AppleDeviceStage } from "./AppleDeviceStage";
import {
  AppleDeviceToolbar,
  APPLE_TOOLBAR_ICONS,
  resolveAppleDeviceToolbarLayout,
  type AppleToolbarAction,
} from "./AppleDeviceToolbar";
import { AppleInspectOverlay } from "./AppleInspectOverlay";
import { AppleInspectPanel } from "./AppleInspectPanel";
import { inspectContextFor } from "./appleInspectGeometry";
import {
  appleCommandForElement,
  appleHeaderChips,
  appleInputAllowed,
  nextAppleDeviceOrientation,
  resolveAppleDeviceState,
  type AppleDeviceState,
} from "./appleDeviceState";
import {
  describeRecording,
  formatRecordingBytes,
  formatRecordingElapsed,
  recordingElapsedMs,
  useAppleRecordings,
} from "./appleRecording";
import { useAppleDeviceStream } from "./useAppleDeviceStream";
import { useAppleOwnerLabel } from "./useAppleOwnerLabel";
import type { AppleDeviceInput } from "./AppleDeviceFlatView";
import {
  isWorkLivePictureInPictureSupported,
  requestWorkLiveIosPictureInPicture,
  WORK_LIVE_PIP_UNSUPPORTED_LABEL,
} from "../work/workLiveIosPictureInPicture";

/**
 * The Apple device column: header, stage, floating toolbar, quick strip, and
 * the advanced drawer.
 *
 * This is what the 3,000-line simulator drawer became once the pixels stopped
 * coming from a screen capture of Simulator.app. There is one backend, so there
 * is no backend choice; the frames are the device screen, so there is no bezel
 * to calibrate and no window to park; and inspect is a toggle on the live
 * stream rather than a mode that freezes it.
 */

const STATUS_POLL_MS = 6_000;
const SNAPSHOT_POLL_MS = 2_000;

/** A stable empty list, so a snapshot-free render does not churn every memo. */
const EMPTY_ELEMENTS: IosScreenElement[] = [];

export type AppleDeviceColumnProps = {
  /** The chat this column acts for. Ownership and recordings key off it. */
  sessionId: string | null;
  laneId: string | null;
  laneName: string;
  projectRoot: string | null;
  runtimePin: OpenProjectBinding | null;
  /** Non-null makes every mutating control read-only, with this as the reason. */
  controlDisabledReason?: string | null;
  /** The lane-scoped surface drives a device it does not own on purpose. */
  ignoreChatOwnership?: boolean;
  /** The machine that owns the device, when it is not this one. */
  machineName?: string | null;
  onAddContext?: (item: IosElementContextItem) => void;
  onInsertDraft?: (text: string) => void;
  /** The host's Preview Lab toggle, rendered in this column's header. */
  headerExtra?: ReactNode;
  onClose?: () => void;
  className?: string;
};

type DeviceFamily = "iphone" | "ipad";

function familyOf(device: AppleLaneDevice | null): DeviceFamily {
  return device?.family === "ipad" ? "ipad" : "iphone";
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(APPLE_NO_INSTALLED_SIMULATORS_CODE)
    ? APPLE_NO_INSTALLED_SIMULATORS_CODE
    : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AppleDeviceColumn({
  sessionId,
  laneId,
  laneName,
  projectRoot,
  runtimePin,
  controlDisabledReason = null,
  ignoreChatOwnership = false,
  machineName = null,
  onAddContext,
  onInsertDraft,
  headerExtra,
  onClose,
  className,
}: AppleDeviceColumnProps) {
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;

  const appleDevice = useAppStore((state) => state.appleDevice);

  const [status, setStatus] = useState<IosSimulatorStatus | null>(null);
  const [installed, setInstalled] = useState<AppleInstalledSimulator[]>([]);
  const [laneDevice, setLaneDevice] = useState<AppleLaneDevice | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [booting, setBooting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [noSimulatorsInstalled, setNoSimulatorsInstalled] = useState(false);
  const [launchProgress, setLaunchProgress] = useState<IosSimulatorLaunchProgress[]>([]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [statusNonce, setStatusNonce] = useState(0);

  const [mode, setMode] = useState<"flat" | "3d">("flat");
  const [viewNonce, setViewNonce] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [inspectOn, setInspectOn] = useState(false);
  const [snapshot, setSnapshot] = useState<IosScreenSnapshot | null>(null);
  const [snapshotFrozen, setSnapshotFrozen] = useState(false);
  const [snapshotRefreshing, setSnapshotRefreshing] = useState(false);
  const [hoveredRef, setHoveredRef] = useState<string | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);

  const [columnWidth, setColumnWidth] = useState(720);
  const [hidden, setHidden] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const orientationRef = useRef<AppleDeviceOrientation>("portrait");

  const onError = useCallback((next: string | null) => setMessage(next), []);

  const refreshStatus = useCallback(() => setStatusNonce((nonce) => nonce + 1), []);

  /* ── column width + visibility ─────────────────────────────────────────── */

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") setColumnWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // "Not visible" is two different facts: the window is in the background, and
  // the column is scrolled or tabbed out of view. Both stop the stream, because
  // a viewer nobody is looking at is pure bitrate.
  useEffect(() => {
    const node = rootRef.current;
    const readDocument = () => document.visibilityState === "hidden";
    let offScreen = false;
    let documentHidden = readDocument();
    const apply = () => setHidden(offScreen || documentHidden);
    const onVisibility = () => {
      documentHidden = readDocument();
      apply();
    };
    document.addEventListener("visibilitychange", onVisibility);
    let observer: IntersectionObserver | null = null;
    if (node && typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        offScreen = !entry.isIntersecting;
        apply();
      });
      observer.observe(node);
    }
    apply();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, []);

  /* ── status + device list ──────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const next = await window.ade.iosSimulator.getStatus(runtimePinRef.current);
        if (cancelled) return;
        setStatus(next);
        if (next.laneDevice !== undefined) setLaneDevice(next.laneDevice ?? null);
      } catch (error) {
        if (!cancelled) setMessage(messageOf(error));
      }
    };
    void read();
    const timer = window.setInterval(() => {
      if (!hidden) void read();
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hidden, statusNonce]);

  const loadDeviceList = useCallback(async () => {
    try {
      const next = await window.ade.iosSimulator.deviceList(
        { laneId, chatSessionId: sessionId, installed: true },
        runtimePinRef.current,
      );
      setInstalled(next.installed);
      setLaneDevice(next.lane);
      setNoSimulatorsInstalled(next.installed.length === 0);
    } catch (error) {
      setMessage(messageOf(error));
    }
  }, [laneId, sessionId]);

  useEffect(() => {
    void loadDeviceList();
  }, [loadDeviceList, statusNonce]);

  /* ── ownership ─────────────────────────────────────────────────────────── */

  const activeSession = status?.activeSession ?? null;
  const deviceSession = status?.deviceSession ?? null;
  const ownerChatSessionId = activeSession?.chatSessionId ?? deviceSession?.chatSessionId ?? null;
  /**
   * "Watching · owned by <chat>" — the chat's TITLE, not eight characters of
   * its id. The phone already reads `owner.chatTitle` off `apple.status`, so
   * this is the desktop and web saying the same thing about the same chat.
   */
  const ownerLabel = useAppleOwnerLabel(ownerChatSessionId, runtimePin);
  const ownedByOtherChat = Boolean(
    !ignoreChatOwnership
    && ownerChatSessionId
    && sessionId
    && ownerChatSessionId !== sessionId,
  );

  const deviceUdid = laneDevice?.udid ?? status?.activeDevice?.udid ?? null;
  const poweredOff = Boolean(
    laneDevice
    && !deviceSession
    && !activeSession
    && status?.activeDevice?.udid === laneDevice.udid
    && status.activeDevice.state !== "Booted",
  );

  const visibleLaunchProgress = useMemo(() => selectLaunchSteps(launchProgress), [launchProgress]);
  const launchFailed = visibleLaunchProgress.some((step) => step.status === "failed");
  const launchRunning = visibleLaunchProgress.length > 0
    && !launchFailed
    && !visibleLaunchProgress.some((step) => step.step === "ready" && step.status === "complete");

  /* ── stream ────────────────────────────────────────────────────────────── */

  const stream = useAppleDeviceStream({
    deviceUdid: poweredOff ? null : deviceUdid,
    laneId,
    chatSessionId: sessionId,
    enabled: Boolean(deviceUdid) && !poweredOff && Boolean(status?.supported),
    hidden,
    machineName,
    bitrateKbpsCap: appleDevice.remoteBitrateKbpsCap,
    runtimePinRef,
    onError,
  });

  const deviceState: AppleDeviceState = resolveAppleDeviceState({
    supported: status ? status.supported : true,
    hasLaneDevice: Boolean(laneDevice ?? deviceUdid),
    poweredOff,
    creating,
    booting,
    building: launchRunning,
    ownedByOtherChat,
    hasAppSession: Boolean(activeSession),
    streamState: stream.state,
    failed: launchFailed,
  });

  const headerChips = useMemo(
    () => appleHeaderChips(deviceState, stream.chip),
    [deviceState, stream.chip],
  );

  /* ── service events ────────────────────────────────────────────────────── */

  /**
   * The subscription must not churn.
   *
   * `stream` is a fresh object every render, so listing it here tore the
   * subscription down and rebuilt it on every frame — dropping every event that
   * landed in the gap. The handler reads through a ref instead, and the effect
   * depends only on the lane it filters by.
   */
  const applyStreamEventRef = useRef(stream.applyStreamEvent);
  applyStreamEventRef.current = stream.applyStreamEvent;

  useEffect(() => {
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
      switch (event.type) {
        case "launch-progress": {
          const progress = event.progress;
          if (progress.laneId && laneId && progress.laneId !== laneId) return;
          setLaunchProgress((current) => [...current, progress]);
          return;
        }
        case "stream-started":
        case "stream-status":
        case "stream-stopped":
        case "stream-error":
          applyStreamEventRef.current(event.status);
          return;
        case "session-started":
        case "session-updated":
        case "session-released":
        case "device-session-started":
        case "device-session-released":
          refreshStatus();
          return;
        default:
          return;
      }
    }, runtimePinRef.current);
    return unsubscribe;
  }, [laneId, refreshStatus]);

  /* ── recordings ────────────────────────────────────────────────────────── */

  const recordings = useAppleRecordings({
    laneId,
    chatSessionId: sessionId,
    enabled: Boolean(laneId) && !hidden,
    runtimePinRef,
    onError,
  });

  useEffect(() => {
    if (!recordings.active && !launchRunning) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [launchRunning, recordings.active]);

  /* ── device tools (the advanced drawer's controls) ─────────────────────── */

  const deviceTools = useIosSimDeviceTools({
    activeDeviceUdid: deviceUdid,
    bundleId: activeSession?.bundleId ?? null,
    chatSessionId: sessionId,
    ignoreOwnership: ignoreChatOwnership,
    visible: drawerOpen && !hidden,
    requested: drawerOpen,
    runtimePinRef,
    onError,
  });

  /* ── inspect ───────────────────────────────────────────────────────────── */

  const refreshSnapshot = useCallback(async () => {
    if (!deviceUdid) return;
    setSnapshotRefreshing(true);
    try {
      const next = await window.ade.iosSimulator.getScreenSnapshot(
        { deviceUdid, ...(laneId ? { laneId } : { projectRoot }) },
        runtimePinRef.current,
      );
      setSnapshot(next);
      setSnapshotFrozen(false);
    } catch {
      // The live accessibility read failed. The overlay degrades to the last
      // captured snapshot rather than emptying itself, and says so.
      setSnapshotFrozen(true);
    } finally {
      setSnapshotRefreshing(false);
    }
  }, [deviceUdid, laneId, projectRoot]);

  useEffect(() => {
    if (!inspectOn || hidden || !deviceUdid) return;
    void refreshSnapshot();
    const timer = window.setInterval(() => {
      void refreshSnapshot();
    }, SNAPSHOT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [deviceUdid, hidden, inspectOn, refreshSnapshot]);

  // Inspect is flat-only: the 3D presenter cannot map a device point to the
  // overlay mid-orbit, and half-drawn rectangles are worse than none.
  useEffect(() => {
    if (inspectOn && mode !== "flat") setMode("flat");
  }, [inspectOn, mode]);

  const inspectElements = useMemo(() => snapshot?.elements ?? EMPTY_ELEMENTS, [snapshot]);

  const selectedElement = useMemo(
    () => inspectElements.find((element) => element.id === selectedRef) ?? null,
    [inspectElements, selectedRef],
  );

  /**
   * The panel builds its own command from the raw identifier, which is right
   * for reading and wrong for pasting: `--ref` resolves against the service's
   * HASHED refs. When the selected element carries one, that wins over what the
   * panel handed us.
   */
  const handleCopyCommand = useCallback((command: string) => {
    const preferred = selectedElement ? appleCommandForElement(selectedElement) : command;
    void navigator.clipboard?.writeText(preferred).catch(() => {});
    setMessage("Copied.");
  }, [selectedElement]);

  /**
   * Insert goes down BOTH paths the composer understands: the structured
   * `IosElementContextItem` chip the frozen-snapshot inspect always pushed, and
   * the prose packet for hosts that only take draft text.
   */
  const handleInsertIntoChat = useCallback((context: string) => {
    if (selectedElement && onAddContext) {
      onAddContext({
        kind: "ios_element",
        id: selectedElement.id,
        componentId: selectedElement.componentId ?? selectedElement.id,
        sourceFile: selectedElement.sourceFile,
        sourceLine: selectedElement.sourceLine,
        frame: selectedElement.frame,
        metadata: selectedElement.metadata,
        accessibilityIdentifier: selectedElement.identifier,
        selectedAt: new Date().toISOString(),
      });
      return;
    }
    onInsertDraft?.(context || (selectedElement ? inspectContextFor(selectedElement, inspectElements) : ""));
  }, [inspectElements, onAddContext, onInsertDraft, selectedElement]);

  /* ── actions ───────────────────────────────────────────────────────────── */

  const controlsDisabled = Boolean(controlDisabledReason) || ownedByOtherChat;
  const controlsDisabledMessage = controlDisabledReason
    ?? (ownedByOtherChat ? "Another chat owns this device." : null);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      setMessage(null);
    } catch (error) {
      if (errorCode(error) === APPLE_NO_INSTALLED_SIMULATORS_CODE) {
        setNoSimulatorsInstalled(true);
      }
      setMessage(messageOf(error));
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }, [refreshStatus]);

  const createDevice = useCallback((from: string | null) => {
    setCreating(true);
    void run(() => window.ade.iosSimulator.deviceCreate(
      { laneId, chatSessionId: sessionId, from },
      runtimePinRef.current,
    )).finally(() => setCreating(false));
  }, [laneId, run, sessionId]);

  const attachDevice = useCallback((simulator: string) => {
    setCreating(true);
    void run(() => window.ade.iosSimulator.deviceAttach(
      { laneId, chatSessionId: sessionId, simulator },
      runtimePinRef.current,
    )).finally(() => setCreating(false));
  }, [laneId, run, sessionId]);

  const deleteDevice = useCallback((force: boolean) => {
    void run(() => window.ade.iosSimulator.deviceDelete(
      { laneId, chatSessionId: sessionId, force },
      runtimePinRef.current,
    ));
  }, [laneId, run, sessionId]);

  const bootDevice = useCallback(() => {
    if (!deviceUdid) return;
    setBooting(true);
    void run(() => window.ade.iosSimulator.openDevice(
      { deviceUdid, chatSessionId: sessionId, laneId, openWindow: false },
      runtimePinRef.current,
    )).finally(() => setBooting(false));
  }, [deviceUdid, laneId, run, sessionId]);

  const powerOff = useCallback(() => {
    if (!deviceUdid) return;
    void run(() => window.ade.iosSimulator.closeDevice(
      {
        deviceUdid,
        chatSessionId: sessionId,
        ignoreOwnership: ignoreChatOwnership,
        shutdownDevice: true,
      },
      runtimePinRef.current,
    ));
  }, [deviceUdid, ignoreChatOwnership, run, sessionId]);

  const relaunch = useCallback(() => {
    void run(() => window.ade.iosSimulator.launch(
      { chatSessionId: sessionId, ...(laneId ? { laneId } : { projectRoot }) },
      runtimePinRef.current,
    ));
  }, [laneId, projectRoot, run, sessionId]);

  const takeOver = useCallback(() => {
    void run(() => window.ade.iosSimulator.attachToChatSession(
      { chatSessionId: sessionId, callerChatSessionId: sessionId, takeOver: true },
      runtimePinRef.current,
    ));
  }, [run, sessionId]);

  const screenshot = useCallback(() => {
    void run(async () => {
      const shot = await window.ade.iosSimulator.screenshot(
        { deviceUdid, ...(laneId ? { laneId } : { projectRoot }) },
        runtimePinRef.current,
      );
      setMessage(`Screenshot written to ${shot.filePath}`);
    });
  }, [deviceUdid, laneId, projectRoot, run]);

  const sendInput = useCallback((input: AppleDeviceInput) => {
    if (!deviceUdid || controlsDisabled || !appleInputAllowed(deviceState)) return;
    // Only the end of a gesture is sent. The helper injects a tap from one
    // point, and streaming every move would be a drag the user did not make.
    if (input.phase !== "end") return;
    void window.ade.iosSimulator
      .tap({ deviceUdid, x: Math.round(input.x), y: Math.round(input.y) }, runtimePinRef.current)
      .catch((error: unknown) => setMessage(messageOf(error)));
  }, [controlsDisabled, deviceState, deviceUdid]);

  const handleBlockerAction = useCallback((action: IosSimBlockerAction) => {
    switch (action) {
      case "create-device":
        setCreateOpen(true);
        return;
      case "attach-device":
        setCreateOpen(true);
        return;
      case "boot":
        bootDevice();
        return;
      case "resume":
        stream.reconnect();
        return;
      case "reconnect":
        stream.reconnect();
        return;
      case "relaunch":
        relaunch();
        return;
      case "open-xcode":
        /*
          Deliberately opens nothing. This used to call
          `openSystemSettings({ pane: "screen-recording" })` — a survivor of
          the window-capture era, when ADE mirrored the Simulator.app window
          and needed that grant. The helper reads the framebuffer, so the
          permission is not involved; the action's own message is about
          installing a runtime in Xcode, and sending the user to a macOS
          privacy pane instead was a wrong turn dressed as help.
        */
        setMessage("Install a simulator in Xcode ▸ Settings ▸ Components, then try again.");
        return;
      case "bind-mac":
      default:
        setMessage("Bind this lane to a Mac from the runtime picker.");
    }
  }, [bootDevice, relaunch, stream]);

  /* ── layout ────────────────────────────────────────────────────────────── */

  const hasDevice = Boolean(laneDevice ?? deviceUdid);
  const layout = resolveAppleDeviceToolbarLayout(columnWidth, { hasDevice });
  const webgl = typeof document !== "undefined";
  const canUse3d = layout.allows3d && isWebCodecsAvailable() && webgl && !inspectOn;
  const threeDisabledReason = inspectOn
    ? "Inspect is flat-view only"
    : !layout.allows3d
      ? "3D view needs a wider column"
      : null;

  const recordingActive = recordings.active;
  const inputBlocked = controlsDisabled || !appleInputAllowed(deviceState);
  const hardwareDisabledReason = inputBlocked
    ? (controlsDisabledMessage ?? "Device is not ready for input")
    : null;

  const pressHome = useCallback(() => {
    if (inputBlocked) return;
    void window.ade.iosSimulator
      .pressButton({ name: "home", laneId, deviceUdid }, runtimePinRef.current)
      .catch((error: unknown) => setMessage(messageOf(error)));
  }, [deviceUdid, inputBlocked, laneId]);

  const rotateDevice = useCallback(() => {
    if (inputBlocked) return;
    const next = nextAppleDeviceOrientation(orientationRef.current);
    orientationRef.current = next;
    void window.ade.iosSimulator
      .rotate({ orientation: next, laneId, deviceUdid }, runtimePinRef.current)
      .then((result) => {
        if (result.applied) return;
        setMessage("Rotation was not applied. Simulator.app must be running.");
      })
      .catch((error: unknown) => setMessage(messageOf(error)));
  }, [deviceUdid, inputBlocked, laneId]);

  const pressShake = useCallback(() => {
    if (inputBlocked) return;
    void window.ade.iosSimulator
      .pressButton({ name: "shake", laneId, deviceUdid }, runtimePinRef.current)
      .catch((error: unknown) => setMessage(messageOf(error)));
  }, [deviceUdid, inputBlocked, laneId]);

  const toolbarGroups = useMemo<AppleToolbarAction[][]>(() => {
    const deviceInput: AppleToolbarAction[] = [
      {
        id: "home",
        label: "Home",
        icon: APPLE_TOOLBAR_ICONS.home,
        disabledReason: hardwareDisabledReason,
        onSelect: pressHome,
      },
      {
        id: "rotate",
        label: "Rotate",
        icon: APPLE_TOOLBAR_ICONS.rotate,
        disabledReason: hardwareDisabledReason,
        onSelect: rotateDevice,
      },
    ];
    if (!layout.collapseViewToggle) {
      deviceInput.push({
        id: "shake",
        label: "Shake",
        icon: APPLE_TOOLBAR_ICONS.shake,
        disabledReason: hardwareDisabledReason,
        onSelect: pressShake,
      });
    }
    const recording: AppleToolbarAction[] = [{
      id: "record",
      label: recordingActive ? "Stop recording" : "Record",
      icon: recordingActive ? APPLE_TOOLBAR_ICONS.stop : APPLE_TOOLBAR_ICONS.record,
      active: Boolean(recordingActive),
      tone: "danger",
      disabledReason: controlsDisabled ? controlsDisabledMessage : null,
      onSelect: () => (recordingActive ? recordings.stop() : recordings.start()),
    }];
    const deviceStateGroup: AppleToolbarAction[] = [
      {
        id: "appearance",
        label: deviceTools.settings?.appearance === "dark" ? "Light appearance" : "Dark appearance",
        icon: deviceTools.settings?.appearance === "dark"
          ? APPLE_TOOLBAR_ICONS.appearanceLight
          : APPLE_TOOLBAR_ICONS.appearanceDark,
        disabledReason: controlsDisabled ? controlsDisabledMessage : null,
        onSelect: () => deviceTools.onSetAppearance(
          deviceTools.settings?.appearance === "dark" ? "light" : "dark",
        ),
      },
      {
        id: "drawer",
        label: drawerOpen ? "Close advanced" : "Advanced",
        icon: APPLE_TOOLBAR_ICONS.drawer,
        active: drawerOpen,
        onSelect: () => setDrawerOpen((open) => !open),
      },
    ];
    const capture: AppleToolbarAction[] = [
      {
        id: "screenshot",
        label: "Screenshot",
        icon: APPLE_TOOLBAR_ICONS.screenshot,
        onSelect: screenshot,
      },
      {
        id: "inspect",
        label: inspectOn ? "Stop inspecting" : "Inspect",
        icon: APPLE_TOOLBAR_ICONS.inspect,
        active: inspectOn,
        onSelect: () => setInspectOn((on) => !on),
      },
      {
        id: "float",
        label: "Float over chat",
        icon: APPLE_TOOLBAR_ICONS.float,
        // The corner card owns the float; this only asks for it, so the device
        // survives switching away from the Apple column — and from ADE.
        disabledReason: isWorkLivePictureInPictureSupported()
          ? null
          : WORK_LIVE_PIP_UNSUPPORTED_LABEL,
        onSelect: () => requestWorkLiveIosPictureInPicture(deviceUdid),
      },
    ];
    const view: AppleToolbarAction[] = layout.collapseViewToggle
      ? [{
        id: mode === "flat" ? "view-3d" : "view-flat",
        label: mode === "flat" ? "3D view" : "Flat view",
        icon: mode === "flat" ? APPLE_TOOLBAR_ICONS.view3d : APPLE_TOOLBAR_ICONS.viewFlat,
        disabledReason: mode === "flat" ? threeDisabledReason : null,
        onSelect: () => setMode(mode === "flat" ? "3d" : "flat"),
      }]
      : [
        {
          id: "view-3d",
          label: "3D view",
          icon: APPLE_TOOLBAR_ICONS.view3d,
          active: mode === "3d",
          disabledReason: canUse3d ? null : threeDisabledReason ?? "3D view needs WebGL",
          onSelect: () => setMode("3d"),
        },
        {
          id: "view-flat",
          label: "Flat view",
          icon: APPLE_TOOLBAR_ICONS.viewFlat,
          active: mode === "flat",
          onSelect: () => setMode("flat"),
        },
        {
          id: "reset-view",
          label: "Reset view",
          icon: APPLE_TOOLBAR_ICONS.resetView,
          disabledReason: mode === "3d" ? null : "Reset view is 3D-only",
          onSelect: () => setViewNonce((nonce) => nonce + 1),
        },
      ];
    return [deviceInput, recording, deviceStateGroup, capture, view];
  }, [
    canUse3d,
    controlsDisabled,
    controlsDisabledMessage,
    deviceTools,
    deviceUdid,
    drawerOpen,
    hardwareDisabledReason,
    inspectOn,
    layout.collapseViewToggle,
    mode,
    pressHome,
    pressShake,
    recordingActive,
    recordings,
    rotateDevice,
    screenshot,
    threeDisabledReason,
  ]);

  const blocker = resolveIosSimBlocker({
    supported: status ? status.supported : true,
    machineName,
    noSimulatorsInstalled,
    hasDevice,
    poweredOff,
    notVisible: hidden && hasDevice,
    liveStatus: stream.state === "live"
      ? "active"
      : stream.state === "idle"
        ? null
        : stream.state,
    liveError: stream.error,
  });

  const familyIcon = familyOf(laneDevice) === "ipad" ? DeviceTablet : DeviceMobile;
  const FamilyIcon = familyIcon;

  const drawerNode = drawerOpen || inspectOn ? (
    <div
      data-apple-drawer={inspectOn ? "inspect" : "advanced"}
      className={cn(
        "flex min-h-0 flex-col border-l border-white/[0.06] bg-card/95",
        layout.drawer === "docked"
          ? "w-72 shrink-0"
          : "absolute inset-y-0 right-0 z-30 w-full max-w-72 shadow-xl",
      )}
    >
      <div className={cn(WORK_TOOL_CHROME_ROW, "justify-between px-2")}>
        <span className="font-sans text-[11px] font-medium text-fg/80">
          {inspectOn ? "Inspect" : "Advanced"}
        </span>
        <button
          type="button"
          className={WORK_TOOL_CHROME_BUTTON}
          aria-label={inspectOn ? "Close inspect" : "Close advanced"}
          onClick={() => (inspectOn ? setInspectOn(false) : setDrawerOpen(false))}
        >
          <X size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {inspectOn ? (
          <AppleInspectPanel
            elements={inspectElements}
            selectedRef={selectedRef}
            onSelect={setSelectedRef}
            onCopyCommand={handleCopyCommand}
            onInsertIntoChat={handleInsertIntoChat}
            refreshing={snapshotRefreshing}
            onRefresh={() => void refreshSnapshot()}
          />
        ) : (
          <>
            <IosSimToolsColumn
              {...deviceTools}
              busy={busy}
              disabled={controlsDisabled}
            />
            <RecordingSection
              now={nowTick}
              recordings={recordings}
              disabled={controlsDisabled}
              // The player, not ADE's Files tab: an .mp4 opened in the editor
              // is a binary blob, and what the user wants is to watch it.
              onOpenFile={(path) => {
                void window.ade.app?.openPath?.(path).catch(() => {});
              }}
            />
          </>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      data-apple-column=""
      data-apple-device-state={deviceState}
      className={cn("relative flex h-full min-h-0 min-w-[200px] flex-col bg-bg", className)}
    >
      {/* header */}
      <div className={cn(WORK_TOOL_CHROME_ROW, "justify-between gap-2 px-2")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <FamilyIcon size={13} className="shrink-0 text-[#60a5fa]" />
          <DeviceMenu
            laneDevice={laneDevice}
            laneName={laneName}
            onCreate={() => setCreateOpen(true)}
            onAttach={() => setCreateOpen(true)}
            onDelete={() => deleteDevice(false)}
            onPowerOff={powerOff}
            onCopyUdid={() => {
              if (!deviceUdid) return;
              void navigator.clipboard?.writeText(deviceUdid).catch(() => {});
              setMessage("Copied device UDID.");
            }}
            ownedByOtherChat={ownedByOtherChat}
            ownerLabel={ownerLabel}
          />
          {headerChips.map((chip) => (
            <PaneTooltip key={chip.label} label={chip.detail ?? chip.label}>
              <span
                data-apple-chip={chip.label}
                className={cn(
                  WORK_TOOL_CHROME_CHIP,
                  chip.tone === "error" ? "text-rose-100/85" : null,
                  chip.tone === "starting" ? "text-amber-100/85" : null,
                )}
              >
                {chip.label}
              </span>
            </PaneTooltip>
          ))}
          {snapshotFrozen && inspectOn ? (
            <span className={cn(WORK_TOOL_CHROME_CHIP, "text-amber-100/85")}>Snapshot · frozen</span>
          ) : null}
          {recordingActive ? (
            <span className={cn(WORK_TOOL_CHROME_CHIP, "text-rose-100/90")} data-apple-recording="">
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-rose-400 motion-safe:animate-pulse" />
              REC {formatRecordingElapsed(recordingElapsedMs(recordingActive, nowTick))}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerExtra}
          {onClose ? (
            <button
              type="button"
              className={WORK_TOOL_CHROME_BUTTON}
              aria-label="Close the Apple column"
              onClick={onClose}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      </div>

      {layout.toolbar === "header" ? (
        <AppleDeviceToolbar placement="header" groups={toolbarGroups} />
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {launchRunning || launchFailed ? (
            <div className="min-h-0 flex-1 overflow-y-auto bg-black">
              <IosSimLaunchStepper
                steps={visibleLaunchProgress}
                buildRoot={null}
                usedInstalledBinary={false}
                now={nowTick}
                onDismiss={() => setLaunchProgress([])}
              />
            </div>
          ) : (
            <AppleDeviceStage
              streamUrl={stream.url}
              streamToken={stream.token}
              reconnectNonce={stream.reconnectNonce}
              mode={mode}
              viewNonce={viewNonce}
              family={familyOf(laneDevice)}
              deviceTypeName={laneDevice?.name ?? status?.activeDevice?.name ?? null}
              realistic={appleDevice.realisticBody}
              orientation="portrait"
              devicePointSize={snapshot ? { width: snapshot.screen.width, height: snapshot.screen.height } : null}
              interactive={!inputBlocked && !inspectOn}
              onDeviceInput={sendInput}
              onReaderStatus={stream.handleReaderStatus}
              onDimensions={stream.handleDimensions}
              onFrame={stream.noteFrame}
              frameVersion={stream.frameVersion}
              renderScreenOverlay={inspectOn ? (deviceToView) => (
                <>
                  {snapshotFrozen && snapshot?.screenshot.dataUrl ? (
                    <img
                      src={snapshot.screenshot.dataUrl}
                      alt="Frozen simulator snapshot"
                      className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                    />
                  ) : null}
                  <AppleInspectOverlay
                    elements={inspectElements}
                    deviceToView={deviceToView}
                    hoveredRef={hoveredRef}
                    selectedRef={selectedRef}
                    onHover={setHoveredRef}
                    onSelect={setSelectedRef}
                  />
                </>
              ) : undefined}
            >
              {layout.toolbar === "rail" ? (
                <AppleDeviceToolbar placement="rail" groups={toolbarGroups} />
              ) : null}
              {ownedByOtherChat ? (
                <IosSimWatchRibbon
                  ownerLabel={ownerLabel}
                  ageLabel={null}
                  onAttach={null}
                  onTakeOver={takeOver}
                  busy={busy}
                />
              ) : null}
              {blocker ? (
                <IosSimVideoOverlay blocker={blocker} busy={busy} onAction={handleBlockerAction} />
              ) : null}
            </AppleDeviceStage>
          )}

          {layout.quickStrip ? (
            <div className={cn(WORK_TOOL_CHROME_ROW, "h-9 shrink-0 gap-1 px-2")}>
              <button
                type="button"
                className={cn(WORK_TOOL_CHROME_BUTTON, "px-2")}
                disabled={controlsDisabled}
                onClick={relaunch}
              >
                Relaunch
              </button>
              <button type="button" className={cn(WORK_TOOL_CHROME_BUTTON, "px-2")} disabled>
                Home
              </button>
              <button type="button" className={cn(WORK_TOOL_CHROME_BUTTON, "px-2")} disabled>
                Rotate
              </button>
              <button
                type="button"
                className={cn(WORK_TOOL_CHROME_BUTTON, "px-2")}
                aria-label="Advanced"
                onClick={() => setDrawerOpen((open) => !open)}
              >
                Advanced
              </button>
              {message ? (
                <span className="ml-auto min-w-0 truncate font-sans text-[10px] text-muted-fg/62">{message}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        {drawerNode}
        {drawerNode && layout.drawer === "overlay" ? (
          <button
            type="button"
            aria-label="Close panel"
            className="absolute inset-0 z-20 cursor-default bg-black/35"
            onClick={() => (inspectOn ? setInspectOn(false) : setDrawerOpen(false))}
          />
        ) : null}
      </div>

      {createOpen ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-3">
          <AppleDeviceCreateDialog
            laneName={laneName}
            installed={installed}
            lastUsedUdid={laneDevice?.templateUdid ?? null}
            busy={busy || creating}
            error={message}
            onCancel={() => setCreateOpen(false)}
            onSubmit={({ mode: submitMode, simulator }) => {
              setCreateOpen(false);
              if (submitMode === "clone") createDevice(simulator);
              else attachDevice(simulator);
            }}
            onCopyInstallCommand={handleCopyCommand}
          />
        </div>
      ) : null}

      {ownedByOtherChat && !hasDevice ? (
        <IosSimOwnershipCard
          ownerLabel={ownerLabel}
          ageLabel={null}
          onAttach={null}
          onTakeOver={takeOver}
          busy={busy}
        />
      ) : null}
    </div>
  );
}

function DeviceMenu({
  laneDevice,
  laneName,
  onCreate,
  onAttach,
  onDelete,
  onPowerOff,
  onCopyUdid,
  ownedByOtherChat,
  ownerLabel,
}: {
  laneDevice: AppleLaneDevice | null;
  laneName: string;
  onCreate: () => void;
  onAttach: () => void;
  onDelete: () => void;
  onPowerOff: () => void;
  onCopyUdid: () => void;
  ownedByOtherChat: boolean;
  ownerLabel: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 rounded px-1 font-sans text-[11px] font-medium text-fg/85 hover:bg-white/[0.05]"
          data-apple-device-menu=""
        >
          <span className="min-w-0 truncate">{laneDevice?.name ?? "No device"}</span>
          <span className="shrink-0 text-muted-fg/60">· {laneName}</span>
          <CaretDown size={10} className="shrink-0 opacity-60" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} align="start" sideOffset={4}>
          {ownedByOtherChat ? (
            <>
              <div className={MENU_LABEL_CLASS}>Owned by</div>
              <div className="px-2 pb-1 font-sans text-[10px] text-muted-fg/70">
                {ownerLabel}
              </div>
            </>
          ) : null}
          {laneDevice ? (
            <>
              <div className={MENU_LABEL_CLASS}>
                {laneDevice.origin === "clone" ? "Clone" : "Attached"} · {laneDevice.runtime}
              </div>
              <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onCopyUdid}>
                Copy device UDID
              </DropdownMenu.Item>
              <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onPowerOff}>
                Power off
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={MENU_ITEM_CLASS}
                disabled={laneDevice.origin === "attached"}
                onSelect={onDelete}
              >
                {laneDevice.origin === "attached" ? "Delete clone (attached)" : "Delete clone"}
              </DropdownMenu.Item>
            </>
          ) : null}
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onCreate}>
            Create a device…
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onAttach}>
            Attach an existing simulator…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function RecordingSection({
  recordings,
  now,
  disabled,
  onOpenFile,
}: {
  recordings: ReturnType<typeof useAppleRecordings>;
  now: number;
  disabled: boolean;
  onOpenFile: (path: string) => void;
}) {
  const { active, summary } = recordings;
  return (
    <div className="border-t border-white/[0.06] px-2 py-2" data-apple-recordings="">
      <div className="pb-1 font-sans text-[11px] font-medium text-muted-fg">Recording</div>
      {active ? (
        <div className="flex items-center gap-1.5 pb-1 font-sans text-[10px] text-rose-100/85">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400 motion-safe:animate-pulse" />
          {formatRecordingElapsed(recordingElapsedMs(active, now))}
          <span className="text-muted-fg/60">{describeRecording(active)}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1 pb-1.5">
        {active ? (
          <>
            <button
              type="button"
              className="ade-shell-control h-6 px-2 font-sans text-[10px]"
              disabled={disabled}
              onClick={() => recordings.stop()}
            >
              Stop and keep
            </button>
            <button
              type="button"
              className="ade-shell-control h-6 px-2 font-sans text-[10px]"
              disabled={disabled}
              onClick={() => recordings.stop({ discard: true })}
            >
              Stop and discard
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ade-shell-control h-6 px-2 font-sans text-[10px]"
            disabled={disabled}
            onClick={() => recordings.start()}
          >
            Start recording
          </button>
        )}
        <button
          type="button"
          className="ade-shell-control h-6 px-2 font-sans text-[10px]"
          disabled={disabled}
          onClick={() => recordings.pinProof()}
        >
          Pin as proof
        </button>
      </div>
      {recordings.recordings.length === 0 ? (
        <div className="font-sans text-[10px] text-muted-fg/55">No recordings yet.</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {recordings.recordings.map((recording) => (
            <li key={recording.id} className="flex items-center gap-1.5">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left font-sans text-[10px] text-fg/78 hover:text-fg"
                onClick={() => onOpenFile(recording.path)}
              >
                {recording.label ?? recording.path.split("/").pop()}
              </button>
              <span className="shrink-0 font-sans text-[10px] tabular-nums text-muted-fg/55">
                {formatRecordingElapsed(recordingElapsedMs(recording, now))}
              </span>
              {recording.proof ? (
                <span className="shrink-0 font-sans text-[10px] text-amber-100/80" title="Pinned as proof">
                  pinned
                </span>
              ) : (
                <button
                  type="button"
                  className="shrink-0 font-sans text-[10px] text-muted-fg/55 hover:text-rose-100/85"
                  disabled={disabled}
                  onClick={() => recordings.remove(recording.id)}
                >
                  delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {summary.count > 0 ? (
        <div className="pt-1 font-sans text-[10px] text-muted-fg/55">
          {summary.count} recordings · {formatRecordingBytes(summary.totalBytes)}
          {summary.pinnedCount > 0 ? ` · ${summary.pinnedCount} pinned` : ""}
        </div>
      ) : null}
    </div>
  );
}
