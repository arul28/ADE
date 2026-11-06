import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type {
  AndroidDeviceInventory,
  AndroidEmulatorStatus,
  AndroidHardwareKey,
  AndroidLaneDeviceStatus,
  AndroidOrientation,
  AndroidRenderRequestEvent,
} from "../../../shared/types/androidEmulator";
import { useAppStore } from "../../state/appStore";
import { effectiveRuntimeBinding } from "../../lib/chatMachineRouting";
import { isInParkedSurface } from "../../lib/parkedSurface";
import { cn } from "../ui/cn";
import { Banner, type NoticeAction } from "../ui/notice";
import { showToast } from "../app/toast/toastStore";
import { Button } from "../ui/Button";
import { RecordingPill, RecordingSavedRow } from "../shared/RecordingReceipt";
import { revealProofArtifactRow } from "../shared/recordingFormat";
import { useTicker } from "../../lib/ticker";
import { WorkToolPreviewControls } from "../terminals/workToolPreviewControls";
import {
  androidAvdSpecLine,
  androidDevicePixelSize,
  androidInputAllowed,
  ANDROID_LOW_MEMORY_RISK,
  androidLaneDeviceName,
  androidRailVisible,
  describeAndroidError,
  resolveAndroidPaneState,
  type AndroidErrorDescription,
} from "./androidDeviceState";
import { androidStreamLeaseKey, androidStreamLeases } from "./androidStreamLease";
import { AndroidDevicePicker } from "./AndroidDevicePicker";
import { AndroidSystemImagesSection } from "./AndroidSystemImagesSection";
import type { AndroidCatalogCreateOptions } from "./AndroidCatalogGrid";
import { AndroidDeviceRail } from "./AndroidDeviceRail";
import { DEVICE_RAIL_WIDTH } from "../device/DeviceRail";
import { DeviceErrorStrip } from "../device/DeviceStatusStrip";
import { AndroidDeviceStage } from "./AndroidDeviceStage";
import { AndroidSetupCard } from "./AndroidSetupCard";
import { DEVICE_DRAWER_DOCK_CLASS } from "../device/DeviceToolsDrawerShell";
import {
  AndroidDeviceLoadingCard,
  AndroidDeviceNoticeStrip,
  AndroidLiveLine,
  AndroidPaneMessage,
} from "./AndroidDeviceStatus";
import { useAndroidDeviceInput } from "./useAndroidDeviceInput";
import { useAndroidDeviceStream } from "./useAndroidDeviceStream";
import { androidCatalogColor, androidCatalogEntry, androidCatalogEntryForAvd, type AndroidCatalogEntry } from "../../../shared/androidDeviceCatalog";
import type { Device3DFailure } from "../device/Device3DView";
import { ANDROID_DEFAULT_BODY_COLOR, androidBodyColor, type AndroidBodySpec } from "./androidDeviceBody";
import {
  androidScreenAspect,
  readAndroidViewMode,
  writeAndroidViewMode,
  type AndroidViewMode,
} from "./androidDeviceState";
import { AndroidRenderSheet } from "./AndroidRenderSheet";
import { useAndroidBootScreen } from "./useAndroidBootScreen";
import { useAndroidRenderRequests } from "./useAndroidRenderRequests";
import { useAndroidInspect } from "./useAndroidInspect";
import { useAndroidRecording } from "./useAndroidRecording";
import { useAndroidPosture } from "./useAndroidPosture";
import { AndroidFoldDock } from "./AndroidFoldDock";
import { useAndroidPaneFloat } from "./useAndroidPaneFloat";
import { useAndroidStorageActions } from "./useAndroidStorageActions";
import { AndroidQuickChips } from "./AndroidQuickChips";
import { AndroidCrashPin } from "./AndroidCrashPin";
import type { AndroidDrawerGroupId } from "./drawer/androidDrawerState";
import { presetDeviceDrawerGroup } from "../device/deviceDrawerState";

/** Below this pane width the chips would crowd the picture; the drawer still has every control. */
const ANDROID_QUICK_CHIPS_MIN_WIDTH = 420;

/** The drawer loads on first open: most sessions never open it. */
const AndroidToolsDrawer = lazy(async () => {
  const mod = await import("./drawer/AndroidToolsDrawer");
  return { default: mod.AndroidToolsDrawer };
});

/**
 * The Android emulator, as the body of the Work tools pane's Android tab.
 *
 * The Apple pane's layout, so moving between the two is easy: an optional
 * one-line strip at the top, and a body that is the setup card, the picker,
 * the loading card or the device, with the rail floating on the right of the
 * picture, and the Tools drawer docked on the right when it is open.
 *
 * Every call goes to the lane's machine: `runtimePin` is passed on every
 * `androidEmulator.*` call and read through a ref, so a rebuilt pin object
 * never restarts anything. Nothing here polls; the brain's events say when to
 * read again.
 */

export type AndroidDevicePaneProps = {
  laneId: string;
  laneName: string | null;
  runtimePin: OpenProjectBinding | null;
  /** The emulator's machine, named when it is not this one. */
  machineName: string | null;
  /**
   * Set for a lane this pane must not change, such as a chat's work copy on
   * another machine, where the agent picks the device. The picker is never
   * offered, and this line takes its place when the lane holds no device.
   */
  noPicker?: string | null;
  /**
   * Opens the guided SDK setup (the coordinator's flow): a brand tile asks for
   * it when no phone image is installed. Absent hides that offer.
   */
  onRequestSetup?: (() => void) | undefined;
  /** The chat this pane sits in: a recording is filed to proof under it. */
  sessionId?: string | null;
  /** Puts an inspected element into the chat's draft. Absent hides "Insert into chat". */
  onInsertDraft?: ((text: string) => void) | undefined;
  className?: string;
};

/** Events in a burst (a boot sends several) become one status read. */
const EVENT_READ_DELAY_MS = 150;
/**
 * Input failures this close together are one burst: a stalled link fails
 * every queued tap at once, and that is one failure, so one notice and one
 * Sentry log, not one per tap.
 */
const INPUT_FAILED_NOTICE_GAP_MS = 10_000;

type PendingStart =
  /** `look`: the catalog body a new device is made with, for boot on the model. */
  | { kind: "create"; look?: { entry: AndroidCatalogEntry; colorId: string } | null }
  | { kind: "attach"; avdName: string }
  | { kind: "start" };

/** What a picker tile or profile button asks to make. */
export type AndroidCreateChoice =
  | { profileId: string }
  | { catalogId: string; colorId: string | null; systemImage?: string | null; displayName?: string | null };

export function AndroidDevicePane({
  laneId,
  laneName,
  runtimePin,
  machineName,
  noPicker = null,
  onRequestSetup,
  sessionId = null,
  onInsertDraft,
  className,
}: AndroidDevicePaneProps) {
  const api = window.ade?.androidEmulator ?? null;
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
  const pinKey = runtimePin?.key ?? null;
  const bound = useAppStore((state) => state.projectBinding);
  // Where the lane's files live: a remote machine's log path cannot be opened here.
  const remoteMachine = effectiveRuntimeBinding(runtimePin, bound)?.kind === "remote";

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyWidth, setBodyWidth] = useState(720);
  const [hidden, setHidden] = useState(false);

  const [status, setStatus] = useState<AndroidEmulatorStatus | null>(null);
  const [statusError, setStatusError] = useState<AndroidErrorDescription | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inventory, setInventory] = useState<AndroidDeviceInventory | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [pickerRequested, setPickerRequested] = useState(false);
  const [pending, setPending] = useState<PendingStart | null>(null);
  const [error, setError] = useState<AndroidErrorDescription | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [noAccelDismissed, setNoAccelDismissed] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  /** The setup card, asked for from the picker when the host has no setup flow of its own. */
  const [setupRequested, setSetupRequested] = useState(false);

  /* ── P1 look: the view mode (3D / flat), as on the Apple pane ──────────── */

  const projectRoot = useAppStore((state) => state.project?.rootPath ?? null);
  const [viewMode, setViewModeState] = useState<AndroidViewMode>(() => readAndroidViewMode(projectRoot));
  const [threeFailure, setThreeFailure] = useState<Device3DFailure | null>(null);
  const [viewNonce, setViewNonce] = useState(0);
  useEffect(() => {
    setViewModeState(readAndroidViewMode(projectRoot));
    setThreeFailure(null);
  }, [projectRoot]);
  const setViewMode = useCallback((next: AndroidViewMode) => {
    setViewModeState(next);
    if (next === "3d") setThreeFailure(null);
    writeAndroidViewMode(projectRoot, next);
  }, [projectRoot]);
  /** The 3D view cannot draw here: fall back to flat and say so once (Apple §A1). */
  const handleThreeUnavailable = useCallback((reason: Device3DFailure) => {
    setThreeFailure(reason);
    setViewModeState("flat");
  }, []);
  const threeD = viewMode === "3d" && threeFailure === null;
  /** A colour picked here, shown at once while the brain records it. */
  const [colorOverride, setColorOverride] = useState<string | null>(null);

  /* ── size + visibility (the Apple pane's rules) ────────────────────────── */

  useEffect(() => {
    const node = bodyRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") setBodyWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = bodyRef.current;
    if (!node || typeof IntersectionObserver !== "function") return undefined;
    // A parked surface (another project or tab on screen) reads as not
    // intersecting, but keeps its stream so switching back shows it live.
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry) setHidden(!entry.isIntersecting && !isInParkedSurface(node));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /* ── reads ─────────────────────────────────────────────────────────────── */

  const laneIdRef = useRef(laneId);
  laneIdRef.current = laneId;

  const readStatus = useCallback(async (): Promise<void> => {
    if (!api) return;
    const forLane = laneIdRef.current;
    try {
      const next = await api.getStatus({ laneId: forLane }, runtimePinRef.current);
      if (laneIdRef.current !== forLane) return;
      setStatus(next);
      setStatusError(null);
    } catch (caught: unknown) {
      if (laneIdRef.current !== forLane) return;
      // A failed refresh keeps what is on screen; only a first read shows the failure.
      setStatusError(describeAndroidError(caught));
    }
  }, [api]);

  const readInventory = useCallback(async (): Promise<void> => {
    if (!api) return;
    const forLane = laneIdRef.current;
    setInventoryLoading(true);
    try {
      const next = await api.listDevices({ laneId: forLane }, runtimePinRef.current);
      if (laneIdRef.current === forLane) setInventory(next);
    } catch (caught: unknown) {
      if (laneIdRef.current === forLane) setError(describeAndroidError(caught));
    } finally {
      if (laneIdRef.current === forLane) setInventoryLoading(false);
    }
  }, [api]);

  const refreshAll = useCallback(() => {
    setRefreshing(true);
    void Promise.all([readStatus(), readInventory()]).finally(() => setRefreshing(false));
  }, [readInventory, readStatus]);

  // A new lane or machine starts from nothing: the last lane's device is not this one's.
  useEffect(() => {
    setStatus(null);
    setStatusError(null);
    setInventory(null);
    setPickerRequested(false);
    setPending(null);
    setError(null);
    void readStatus();
  }, [laneId, pinKey, readStatus]);

  const laneState = status?.lane?.state ?? "none";
  const pickerShownRef = useRef(false);
  /** `ade android render` events go to the render hook (set below, read through this ref). */
  const renderRequestRef = useRef<(event: AndroidRenderRequestEvent) => void>(() => undefined);
  useEffect(() => {
    if (!api?.onEvent) return undefined;
    let timer: number | null = null;
    let inventoryDirty = false;
    const unsubscribe = api.onEvent((event) => {
      if (event.type === "android.stream.state") return; // the stream hook's
      if (event.type === "android.render.request") {
        renderRequestRef.current(event);
        return;
      }
      if (event.type === "android.device.state" && event.laneId !== laneIdRef.current) {
        // Another lane's device: only the picker's badges care.
        inventoryDirty = true;
      } else if (event.type === "android.inventory.changed") {
        inventoryDirty = true;
      }
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void readStatus();
        if (inventoryDirty && pickerShownRef.current) void readInventory();
        inventoryDirty = false;
      }, EVENT_READ_DELAY_MS);
    }, runtimePinRef.current);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unsubscribe?.();
    };
    // Keyed on the machine, not the pin object (CLAUDE.md "key effects on pin?.key").
  }, [api, pinKey, readInventory, readStatus]);

  /* ── stream + input ────────────────────────────────────────────────────── */

  const lane = status?.lane ?? null;
  const avdName = lane?.device?.avdName ?? null;
  const streamWanted = laneState === "booted" && pending == null && !pickerRequested;
  const onStreamError = useCallback((message: string | null) => setStreamError(message), []);
  const stream = useAndroidDeviceStream({
    laneId,
    avdName: streamWanted ? avdName : null,
    enabled: streamWanted,
    hidden,
    runtimePinRef,
    onError: onStreamError,
  });

  const paneState = resolveAndroidPaneState({
    apiPresent: Boolean(api),
    status,
    statusFailed: statusError != null,
    pickerRequested,
    pendingStart: pending != null,
    stream: stream.state,
    streamGaveUp: stream.gaveUp,
  });

  // The inventory is read only while the picker is on screen.
  const pickerShown = paneState === "picker" && !noPicker;
  pickerShownRef.current = pickerShown;
  useEffect(() => {
    if (pickerShown) void readInventory();
  }, [pickerShown, readInventory, laneId, pinKey]);

  // A failed tap, key or swipe is a failure, so an error toast (Details,
  // Report, a Sentry log), and one per burst: a stalled link fails every
  // queued input, and one notice says it. The stable id replaces the card in
  // place; the gap keeps a long burst from raising and logging it again.
  const inputFailedAtRef = useRef(0);
  const onInputError = useCallback((caught: unknown) => {
    const now = Date.now();
    if (now - inputFailedAtRef.current < INPUT_FAILED_NOTICE_GAP_MS) return;
    inputFailedAtRef.current = now;
    const described = describeAndroidError(caught);
    showToast({
      id: "android-input-failed",
      tone: "error",
      title: "Input didn't reach the device",
      message: described.sentence,
      report: {
        surface: "android_device_input",
        code: described.code ?? "android_input_failed",
        technicalDetail: described.detail,
      },
    });
  }, []);

  /** An Inspect, Record or open-file failure: the pane's error line, not the input toast. */
  const onToolError = useCallback((caught: unknown) => setError(describeAndroidError(caught)), []);

  /* ── P1 agent tools on the rail: Inspect, Record and the Tools drawer ──── */

  const deviceLive = paneState === "live";
  const inspect = useAndroidInspect({ laneId, live: deviceLive, runtimePinRef, onInsertDraft, onError: onToolError });
  const recording = useAndroidRecording({ laneId, live: deviceLive, chatSessionId: sessionId, runtimePinRef, onError: onToolError });
  const recordingTick = useTicker(1000, Boolean(recording.active));
  const [savedDismissedId, setSavedDismissedId] = useState<string | null>(null);
  const savedRecording = recording.saved && recording.saved.id !== savedDismissedId ? recording.saved : null;
  const openSavedRecording = useCallback(() => {
    const saved = recording.saved;
    if (!saved) return;
    setSavedDismissedId(saved.id);
    const artifactId = saved.proofArtifactIds[0] ?? null;
    if (artifactId && revealProofArtifactRow(artifactId)) return;
    // No proof row in this window: the file itself, when it is on this computer.
    if (!remoteMachine) void window.ade.app.openPath(saved.path).catch(onToolError);
  }, [onToolError, recording.saved, remoteMachine]);
  // Inspect boxes and the drawer go with the device: a new lane or a lost device starts them closed.
  const { inspectOn, toggleInspect } = inspect;
  useEffect(() => {
    if (!androidRailVisible(paneState)) setToolsOpen(false);
    if (!deviceLive && inspectOn) toggleInspect();
  }, [deviceLive, inspectOn, paneState, toggleInspect]);
  useEffect(() => {
    setToolsOpen(false);
    setSetupRequested(false);
  }, [laneId, pinKey]);
  const input = useAndroidDeviceInput({
    laneId,
    enabled: androidInputAllowed(paneState),
    runtimePinRef,
    onError: onInputError,
  });

  const devicePixelSize = useMemo(
    () => androidDevicePixelSize(lane?.avd ?? null, { width: stream.width, height: stream.height }),
    [lane?.avd, stream.height, stream.width],
  );

  /* ── actions ───────────────────────────────────────────────────────────── */

  const applyLane = useCallback((next: AndroidLaneDeviceStatus) => {
    setStatus((current) => (current ? { ...current, lane: next } : current));
  }, []);

  const forgetStream = useCallback(() => {
    androidStreamLeases.forget(androidStreamLeaseKey({
      pin: runtimePinRef.current,
      bound: useAppStore.getState().projectBinding,
      laneId,
    }));
  }, [laneId]);

  /** Runs one lane-changing call: pending while it runs, a strip when it fails, a re-read after. */
  const runStart = useCallback(async (
    kind: PendingStart,
    call: () => Promise<AndroidLaneDeviceStatus>,
  ): Promise<void> => {
    setPending(kind);
    setError(null);
    setStreamError(null);
    try {
      const next = await call();
      if (laneIdRef.current !== laneId) return;
      applyLane(next);
      setPickerRequested(false);
    } catch (caught: unknown) {
      if (laneIdRef.current === laneId) setError(describeAndroidError(caught));
    } finally {
      if (laneIdRef.current === laneId) setPending(null);
      void readStatus();
    }
  }, [applyLane, laneId, readStatus]);

  /** A lane that already holds a device gives it back first; the AVD stays installed. */
  const releaseCurrent = useCallback(async (): Promise<void> => {
    if (!api || !status?.lane?.device) return;
    forgetStream();
    await api.releaseDevice({ laneId, deleteCreated: false }, runtimePinRef.current);
  }, [api, forgetStream, laneId, status?.lane?.device]);

  const attach = useCallback((name: string) => {
    if (!api) return;
    void runStart({ kind: "attach", avdName: name }, async () => {
      await releaseCurrent();
      return api.attachDevice({ laneId, avdName: name, start: true }, runtimePinRef.current);
    });
  }, [api, laneId, releaseCurrent, runStart]);

  const create = useCallback((choice: AndroidCreateChoice) => {
    if (!api) return;
    const catalog = "catalogId" in choice ? choice : null;
    const entry = catalog ? androidCatalogEntry(catalog.catalogId) : null;
    const look = entry && catalog ? { entry, colorId: androidCatalogColor(entry, catalog.colorId).id } : null;
    void runStart({ kind: "create", look }, async () => {
      await releaseCurrent();
      return api.createDevice(catalog
        ? {
          laneId,
          profileId: "",
          catalogId: catalog.catalogId,
          colorId: catalog.colorId,
          systemImage: catalog.systemImage ?? null,
          displayName: catalog.displayName ?? null,
          start: true,
        }
        : { laneId, profileId: "profileId" in choice ? choice.profileId : "", start: true }, runtimePinRef.current);
    });
  }, [api, laneId, releaseCurrent, runStart]);

  const start = useCallback(() => {
    if (!api) return;
    void runStart({ kind: "start" }, () => api.start({ laneId }, runtimePinRef.current));
  }, [api, laneId, runStart]);

  /** Past the RAM guard, after its warning: the person accepts the swap. */
  const startAnyway = useCallback(() => {
    if (!api) return;
    void runStart({ kind: "start" }, () => api.start({ laneId, force: true }, runtimePinRef.current));
  }, [api, laneId, runStart]);

  const powerOff = useCallback(() => {
    if (!api) return;
    forgetStream();
    void api.stop({ laneId }, runtimePinRef.current)
      .then(applyLane)
      .catch((caught: unknown) => setError(describeAndroidError(caught)))
      .finally(() => void readStatus());
  }, [api, applyLane, forgetStream, laneId, readStatus]);

  /**
   * "Keep running": pin the emulator against ADE's idle stop, on the
   * emulator's machine. Shown while the brain says ADE would stop it
   * (`keepRunning` not null); an older brain never sends it.
   */
  const keepRunning = lane?.keepRunning ?? null;
  const toggleKeepRunning = useCallback(() => {
    if (!api?.setKeepRunning || keepRunning === null) return;
    void api.setKeepRunning({ laneId, keepRunning: !keepRunning }, runtimePinRef.current)
      .then(applyLane)
      .catch((caught: unknown) => setError(describeAndroidError(caught)));
  }, [api, applyLane, keepRunning, laneId]);

  const release = useCallback(() => {
    if (!api) return;
    forgetStream();
    void api.releaseDevice({ laneId, deleteCreated: false }, runtimePinRef.current)
      .catch((caught: unknown) => setError(describeAndroidError(caught)))
      .finally(() => {
        void readStatus();
        void readInventory();
      });
  }, [api, forgetStream, laneId, readInventory, readStatus]);

  const { readSizes, cleanUp, deleteAvd } = useAndroidStorageActions({ api, laneId, runtimePinRef, readInventory, onError: setError });

  const openLaneDevice = useCallback(() => {
    setPickerRequested(false);
    if (laneState === "off" || laneState === "crashed") start();
  }, [laneState, start]);

  /**
   * The orientation this pane last asked for. The brain has no read of it,
   * and the stream's shape cannot stand in: the home screen stays portrait
   * whatever is sent, so a second click would ask for landscape again.
   */
  const orientationRef = useRef<AndroidOrientation | null>(null);
  useEffect(() => {
    orientationRef.current = null;
  }, [laneId, pinKey, avdName]);
  const streamLandscape = Boolean(stream.width && stream.height && stream.width > stream.height);
  const rotate = useCallback(() => {
    if (!api) return;
    const current = orientationRef.current ?? (streamLandscape ? "landscape" : "portrait");
    const next: AndroidOrientation = current === "landscape" ? "portrait" : "landscape";
    orientationRef.current = next;
    // The new size reaches the view with the stream's next config record (~1 s).
    void api.rotate({ laneId, orientation: next }, runtimePinRef.current).catch((caught: unknown) => {
      orientationRef.current = current;
      setError(describeAndroidError(caught));
    });
  }, [api, laneId, streamLandscape]);

  const screenshot = useCallback(() => {
    if (!api) return;
    setScreenshotPending(true);
    void api.screenshot({ laneId }, runtimePinRef.current)
      .then((shot) => showToast({
        id: "android-screenshot",
        tone: "success",
        title: "Screenshot saved",
        message: `${shot.width}×${shot.height} · ${shot.path}`,
      }))
      .catch((caught: unknown) => setError(describeAndroidError(caught)))
      .finally(() => setScreenshotPending(false));
  }, [api, laneId]);

  const openLog = useCallback((path: string) => {
    // The log is a file on the emulator's machine. On another machine it
    // cannot be opened from here, so its path goes to the clipboard instead.
    if (remoteMachine) {
      void window.ade?.app?.writeClipboardText?.(path);
      showToast({
        id: "android-log",
        tone: "info",
        title: machineName ? `The log is on ${machineName}` : "The log is on another machine",
        message: `Its path is copied: ${path}`,
      });
      return;
    }
    void window.ade?.app?.openPath?.(path).catch((caught: unknown) => setError(describeAndroidError(caught)));
  }, [machineName, remoteMachine]);

  const pressKey = useCallback((key: AndroidHardwareKey) => input.pressKey(key), [input]);

  /* ── render ────────────────────────────────────────────────────────────── */

  const deviceName = androidLaneDeviceName(lane);
  const deviceSpec = lane?.avd ? androidAvdSpecLine(lane.avd, inventory?.profiles ?? []) : null;
  const floatOverChat = useAndroidPaneFloat({ lane, laneId, sessionId, machineName, runtimePinRef });
  const accel = status?.sdk.acceleration ?? null;

  /* ── P1 look: the body, the colour, boot on the model, renders ─────────── */

  const laneAvd = lane?.avd ?? null;
  const pendingLook = pending?.kind === "create" ? pending.look ?? null : null;
  const laneEntry = useMemo(() => androidCatalogEntryForAvd(laneAvd), [laneAvd]);
  useEffect(() => setColorOverride(null), [laneAvd?.name, laneAvd?.colorId]);
  const laneProfile = useMemo(
    () => (laneAvd?.profileId ? inventory?.profiles.find((profile) => profile.id === laneAvd.profileId) ?? null : null),
    [inventory?.profiles, laneAvd?.profileId],
  );
  const bodySpec = useMemo<AndroidBodySpec | null>(() => {
    if (pendingLook) return { entry: pendingLook.entry, profile: null, colorId: pendingLook.colorId };
    if (pending?.kind === "create") return null;
    if (!laneAvd) return null;
    return {
      entry: laneEntry,
      profile: laneProfile ?? { screenInches: null, widthPx: laneAvd.lcdWidth, heightPx: laneAvd.lcdHeight, formFactor: null },
      colorId: colorOverride ?? laneAvd.colorId ?? null,
    };
  }, [colorOverride, laneAvd, laneEntry, laneProfile, pending?.kind, pendingLook]);
  const screenAspect = pendingLook
    ? Math.min(pendingLook.entry.screen.widthPx, pendingLook.entry.screen.heightPx) / Math.max(pendingLook.entry.screen.widthPx, pendingLook.entry.screen.heightPx)
    : androidScreenAspect(laneAvd);
  // P3 fold: a foldable's hinge, once it runs.
  const foldable = (bodySpec?.entry?.formFactor ?? bodySpec?.profile?.formFactor) === "foldable";
  const posture = useAndroidPosture({ laneId, enabled: deviceLive && foldable, runtimePinRef, onError: onToolError });
  const booting = pending != null || laneState !== "booted";
  const bootOnModel = threeD && bodySpec !== null && (paneState === "starting" || (booting && paneState !== "picker"));
  const boot = useAndroidBootScreen({
    active: bootOnModel,
    hidden,
    screenAspect: screenAspect || 9 / 20,
    tint: (bodySpec ? androidBodyColor(bodySpec) : ANDROID_DEFAULT_BODY_COLOR).body,
    label: pendingLook ? `Making ${pendingLook.entry.name}` : `Starting ${deviceName}`,
  });

  const renders = useAndroidRenderRequests({
    laneId,
    deviceName,
    runtimePinRef,
    live: paneState === "live",
    threeD,
    setThreeD: () => setViewMode("3d"),
    onError: (caught) => setError(describeAndroidError(caught)),
  });
  renderRequestRef.current = renders.handleRequest;

  const setColor = useCallback((colorId: string) => {
    if (!api) return;
    setColorOverride(colorId);
    void api.setDeviceColor({ laneId, colorId }, runtimePinRef.current)
      .then(applyLane)
      .catch((caught: unknown) => {
        setColorOverride(null);
        setError(describeAndroidError(caught));
      });
  }, [api, applyLane, laneId]);

  /** Opens the Tools drawer at one group: the chips' "More in Tools", the crash pin's "Open Logs". */
  const openToolsAt = (group: AndroidDrawerGroupId) => {
    presetDeviceDrawerGroup("androidToolsGroup", sessionId, group);
    setToolsOpen(true);
  };

  const strip = (() => {
    if (error?.code === "ANDROID_LOW_MEMORY") {
      // The RAM guard: a warning with the numbers, and the person's way past it.
      return (
        <AndroidDeviceNoticeStrip
          tone="warning"
          sentence={`${error.sentence} ${ANDROID_LOW_MEMORY_RISK}`}
          actions={[{ label: "Start anyway", onClick: startAnyway }]}
          onDismiss={() => setError(null)}
        />
      );
    }
    if (error) {
      return <DeviceErrorStrip tool="android" sentence={error.sentence} detail={error.detail} onDismiss={() => setError(null)} />;
    }
    if (paneState === "crashed") {
      const crash = lane?.error ?? null;
      const actions: NoticeAction[] = [{ label: "Restart", onClick: start }];
      if (crash?.logPath) {
        const logPath = crash.logPath;
        actions.push({ label: "Open log", variant: "secondary", onClick: () => openLog(logPath) });
      }
      if (!noPicker) actions.push({ label: "Choose another device", variant: "secondary", onClick: () => setPickerRequested(true) });
      return (
        <DeviceErrorStrip
          tool="android"
          sentence={crash ? describeAndroidError(crash).sentence : `${deviceName} stopped.`}
          actions={actions}
        />
      );
    }
    if (paneState === "stopped") {
      return (
        <AndroidDeviceNoticeStrip
          sentence={`${deviceName} is off.`}
          actions={[
            { label: "Start", onClick: start },
            ...(noPicker ? [] : [{ label: "Choose another device", variant: "secondary" as const, onClick: () => setPickerRequested(true) }]),
          ]}
        />
      );
    }
    if (paneState === "video-lost") {
      return (
        <AndroidDeviceNoticeStrip
          sentence={streamError ? `Video stopped. ${describeAndroidError(streamError).sentence}` : "Video stopped."}
          actions={[{ label: "Reconnect", onClick: () => stream.reconnect() }]}
        />
      );
    }
    if (threeFailure && androidRailVisible(paneState)) {
      // The one sentence a fallback to flat says (Apple §A1).
      return (
        <AndroidDeviceNoticeStrip
          sentence={`${threeFailure} Showing the flat view.`}
          actions={[{ label: "Try 3D again", onClick: () => { setThreeFailure(null); setViewMode("3d"); setViewNonce((nonce) => nonce + 1); } }]}
          onDismiss={() => setThreeFailure(null)}
        />
      );
    }
    if (accel && !accel.usable && !noAccelDismissed && paneState !== "setup" && paneState !== "unsupported") {
      return (
        <AndroidDeviceNoticeStrip
          tone="warning"
          sentence={accel.detail
            ? `No emulator acceleration: ${accel.detail}`
            : "This machine has no emulator acceleration, so devices run very slowly or not at all."}
          actions={[{ label: "How to fix", variant: "link", href: "https://developer.android.com/studio/run/emulator-acceleration" }]}
          onDismiss={() => setNoAccelDismissed(true)}
        />
      );
    }
    return null;
  })();

  const requestSetup = onRequestSetup ?? (() => setSetupRequested(true));

  function renderBody() {
    if (setupRequested && status && paneState === "picker") {
      return (
        <div data-android-setup-requested="" className="relative flex size-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center px-3 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setSetupRequested(false)}>
              Back to devices
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <AndroidSetupCard
              sdk={status.sdk}
              pin={runtimePin}
              machineName={machineName}
              remoteMachine={remoteMachine}
              refreshing={refreshing}
              onRefresh={refreshAll}
            />
          </div>
        </div>
      );
    }
    switch (paneState) {
      case "unavailable":
        return (
          <AndroidPaneMessage
            title="Android Development is not available here."
            description="Update ADE, or open this lane in the ADE desktop app."
          />
        );
      case "loading":
        return <AndroidPaneMessage title="Reading this machine's Android setup…" description={null} />;
      case "status-failed":
        return (
          <div data-android-status-failed="" className="flex size-full items-start justify-center px-4 py-6">
            <div className="w-full max-w-sm">
              <Banner
                layout="inline"
                model={{
                  id: "android-status",
                  tone: "error",
                  title: "Couldn't read this machine's Android setup.",
                  detail: statusError?.sentence ?? null,
                  busy: refreshing,
                  actions: [{ label: "Retry", onClick: refreshAll, disabled: refreshing }],
                }}
              />
            </div>
          </div>
        );
      case "unsupported":
        return (
          <AndroidPaneMessage
            title="This machine can't run the Android emulator."
            description={status?.unsupportedReason ?? null}
          />
        );
      case "setup":
        return status ? (
          <AndroidSetupCard
            sdk={status.sdk}
            pin={runtimePin}
            machineName={machineName}
            remoteMachine={remoteMachine}
            refreshing={refreshing}
            onRefresh={refreshAll}
          />
        ) : null;
      case "picker":
        if (noPicker) return <AndroidPaneMessage title={noPicker} description={null} />;
        return (
          <AndroidDevicePicker
            laneId={laneId}
            lane={lane}
            inventory={inventory}
            loadingInventory={inventoryLoading}
            pending={pending?.kind === "create" ? "create" : pending?.kind === "attach" ? pending.avdName : null}
            refreshing={refreshing}
            onOpenLaneDevice={openLaneDevice}
            onAttach={attach}
            onCreate={(profileId) => create({ profileId })}
            onCreateCatalog={(catalogId: string, options: AndroidCatalogCreateOptions) => create({ catalogId, ...options })}
            onReadSizes={readSizes}
            onCleanUp={cleanUp}
            onRequestSetup={requestSetup}
            onRelease={release}
            onDelete={deleteAvd}
            onRefresh={refreshAll}
            playing={!hidden}
            systemImages={<AndroidSystemImagesSection pin={runtimePin} machineName={machineName} />}
          />
        );
      case "stopped":
        return <AndroidPaneMessage title={deviceName} description={deviceSpec ? `${deviceSpec} · Off` : "Off"} />;
      case "crashed":
        return <AndroidPaneMessage title={`${deviceName} stopped.`} description={deviceSpec} />;
      case "starting":
      case "live":
      case "video-lost":
      default: {
        if (booting && !bootOnModel) {
          return (
            <AndroidDeviceLoadingCard
              name={pending?.kind === "create" ? "new device" : deviceName}
              spec={deviceSpec}
              stage="booting"
            />
          );
        }
        return (
          <AndroidDeviceStage
            streamUrl={stream.url}
            streamToken={stream.token}
            reconnectNonce={stream.reconnectNonce}
            devicePixelSize={devicePixelSize}
            interactive={androidInputAllowed(paneState) && !inspect.inspectOn}
            renderScreenOverlay={inspect.renderInspectOverlay}
            onDeviceInput={input.send}
            onDeviceScroll={input.scroll}
            onDeviceKey={input.key}
            onReaderStatus={stream.handleReaderStatus}
            onDimensions={stream.handleDimensions}
            onFrame={stream.noteFrame}
            // The screen moves left only when the rail would cover its right
            // edge and take its taps, as on the Apple stage.
            railInset={androidRailVisible(paneState) ? DEVICE_RAIL_WIDTH : 0}
            mode={threeD && bodySpec ? "3d" : "flat"}
            bodySpec={bodySpec}
            screenAspect={screenAspect}
            boot={bootOnModel ? boot : null}
            viewNonce={viewNonce}
            fold={posture.stageFold}
            rendererRef={renders.rendererRef}
            onThreeUnavailable={handleThreeUnavailable}
            className={cn("bg-transparent", paneState === "video-lost" && "opacity-40")}
          >
            {paneState === "starting" && !bootOnModel ? (
              <div className="absolute inset-0 z-[1]">
                <AndroidDeviceLoadingCard name={deviceName} spec={deviceSpec} stage="streaming" />
              </div>
            ) : null}
          </AndroidDeviceStage>
        );
      }
    }
  }

  return (
    <div
      data-android-pane=""
      data-android-device-state={paneState}
      className={cn("relative flex h-full min-h-0 min-w-0 flex-col bg-surface", className)}
    >
      {strip}
      <div ref={bodyRef} className="@container relative flex min-h-0 min-w-0 flex-1">
        <div className="ade-tool-picker-static relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The stage and what floats on it; a foldable's hinge dock sits below. */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {renderBody()}
          {androidRailVisible(paneState) ? (
            <>
              <AndroidDeviceRail
                containerWidth={bodyWidth}
                deviceName={deviceName}
                deviceSpec={deviceSpec}
                inputConnected={androidInputAllowed(paneState)}
                screenshotPending={screenshotPending}
                onKey={pressKey}
                onRotate={rotate}
                onScreenshot={screenshot}
                onSwitchDevice={noPicker ? undefined : () => setPickerRequested(true)}
                onPowerOff={powerOff}
                mode={threeD ? "3d" : "flat"}
                onMode={setViewMode}
                threeDisabledReason={threeFailure}
                onRender={renders.openRender}
                rendering={renders.rendering}
                onResetView={() => setViewNonce((nonce) => nonce + 1)}
                colors={laneEntry?.colors}
                colorId={bodySpec?.colorId ?? null}
                onColor={noPicker ? undefined : setColor}
                inspecting={inspect.inspectOn}
                onToggleInspect={inspect.toggleInspect}
                recording={Boolean(recording.active)}
                recordingBusy={recording.busy}
                onToggleRecording={recording.toggleRecording}
                toolsOpen={toolsOpen}
                onToggleTools={() => setToolsOpen((open) => !open)}
                onFloat={floatOverChat}
                keepRunning={keepRunning}
                idleStopMinutes={lane?.idleStopMinutes ?? null}
                onToggleKeepRunning={keepRunning === null ? undefined : toggleKeepRunning}
                // The per-chat "Show preview when minimized" toggle and
                // Maximize, shared with every screen tool.
                extraControls={<WorkToolPreviewControls tool="android" chatSessionId={sessionId} />}
              />
              <div className="pointer-events-none absolute left-3 top-3 z-[3] flex flex-col items-start gap-1.5">
                {/* Quick chips: shortcuts to the drawer's Emulator group, hidden while the drawer itself shows. */}
                {deviceLive && !toolsOpen && !inspect.inspectOn && bodyWidth >= ANDROID_QUICK_CHIPS_MIN_WIDTH ? (
                  <AndroidQuickChips
                    laneId={laneId}
                    pinRef={runtimePinRef}
                    visible={!hidden}
                    onOpenTools={() => openToolsAt("emulator")}
                  />
                ) : null}
                {deviceLive ? (
                  <AndroidCrashPin crash={lane?.appCrash ?? null} onSendToChat={onInsertDraft} onOpenLogs={() => openToolsAt("logs")} />
                ) : null}
              </div>
              {/* The recording pill takes the live line's place at the bottom while the picture is live. */}
              {recording.active && deviceLive ? null : (
                <AndroidLiveLine
                  state={paneState !== "live" ? "lost" : stream.reconnecting ? "reconnecting" : "live"}
                  fps={stream.fps}
                  laneName={laneName}
                  machineName={machineName}
                />
              )}
              {recording.active ? (
                <RecordingPill
                  marker={{ "data-android-recording-pill": "" }}
                  elapsedMs={Math.max(0, recordingTick - Date.parse(recording.active.startedAt)) || 0}
                  stopDisabled={recording.busy}
                  onStop={recording.toggleRecording}
                />
              ) : null}
            </>
          ) : null}
          {savedRecording && !recording.active ? (
            <RecordingSavedRow
              marker={{ "data-android-recording-saved": savedRecording.id }}
              durationMs={savedRecording.durationMs ?? 0}
              bytes={savedRecording.bytes}
              onOpen={openSavedRecording}
              onDismiss={() => setSavedDismissedId(savedRecording.id)}
            />
          ) : null}
          </div>
          {posture.posture ? (
            <AndroidFoldDock
              mode={threeD ? "3d" : "flat"}
              angle={posture.angle}
              posture={posture.posture}
              busy={posture.busy}
              onPreview={posture.preview}
              onCommit={posture.commit}
            />
          ) : null}
        </div>

        {toolsOpen && androidRailVisible(paneState) ? (
          <div
            data-android-drawer=""
            className={DEVICE_DRAWER_DOCK_CLASS}
          >
            <Suspense fallback={null}>
              <AndroidToolsDrawer
                pin={runtimePin}
                laneId={laneId}
                chatSessionId={sessionId}
                visible={toolsOpen && !hidden}
                onClose={() => setToolsOpen(false)}
                remoteMachineName={remoteMachine ? machineName : null}
                lanePackages={lane?.device?.adeInstalledPackages}
                onInsertDraft={onInsertDraft}
              />
            </Suspense>
          </div>
        ) : null}
      </div>
      {renders.renderOpen ? (
        <AndroidRenderSheet
          deviceName={deviceName}
          rendering={renders.rendering}
          onClose={() => renders.setRenderOpen(false)}
          onRender={(request) => void renders.runRender(request)}
        />
      ) : null}
    </div>
  );
}
