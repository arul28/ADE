import { confirmDialog } from "../ui/dialog";
import { remoteAgentHolderLabel } from "../../../shared/runtimeClientNames";
import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppleLogo } from "../ui/appleIcons";
import type {
  AppleDeviceCleanupResult,
  AppleNewDeviceSpec,
  AppleDeviceOrientation,
  AppleDeviceStartArgs,
  AppleHardwareButtonName,
  AppleLaneDevice,
  AppleDevicePose,
  AppleDevicePosture,
  AppleRuntimeDeleteResult,
  AppleRuntimeSimulatorDisposition,
  IosElementContextItem,
  IosSimulatorStatus,
  OpenProjectBinding,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { Banner } from "../ui/notice";
import { AppleDeviceStage, isWebCodecsAvailable } from "./AppleDeviceStage";
import type { AppleDevice3DFailure, AppleDeviceDuoProps, AppleDeviceRenderer } from "./AppleDevice3DView";
import {
  appleDeviceSupportsDuo,
  clampAppleDuoAngle,
  createAppleDuoState,
  nearestAppleDuoStance,
  reduceAppleDuoState,
} from "./appleDuo";
import { AppleDeviceLoadingCard, type AppleLoadingStage } from "./AppleDeviceLoadingCard";
import { AppleDevicePicker } from "./AppleDevicePicker";
import { showToast } from "../app/toast/toastStore";
import { AppleDeviceRail } from "./AppleDeviceRail";
import { WorkToolPreviewControls } from "../terminals/workToolPreviewControls";
import {
  AppleDeviceNoticeStrip,
  AppleDeviceStatusStrip,
  describeAppleError,
  type AppleErrorAction,
} from "./AppleDeviceStatusStrip";
import { appleDeviceIdentity, type AppleDeviceFamilyId } from "./appleDeviceFamily";
import {
  appleInputAllowed,
  appleLaneDeviceBooted,
  applePowerFromPhase,
  appleStatusSaysBooted,
  appleObservedOrientationFamily,
  appleOrientationFamily,
  appleRailVisible,
  readAppleViewMode,
  resolveAppleDeviceState,
  writeAppleViewMode,
  type AppleDeviceState,
  type AppleViewMode,
} from "./appleDeviceState";
import type { IosSimulatorSnapshotElement } from "./appleInspectGeometry";
import { recordingElapsedMs, useAppleRecordings } from "./appleRecording";
import { RecordingPill } from "../shared/RecordingReceipt";
import { useAppleDeviceInput } from "./useAppleDeviceInput";
import { AppleRecordingSavedRow } from "./AppleRecordingSavedRow";
import { isAppleDeviceOffError } from "./appleErrors";
import { useAppleDeviceStream } from "./useAppleDeviceStream";
import { useAppleDeviceStartTracker, useAppleLoadingWatchdog } from "./useAppleDeviceStartTracker";
import { useAppleLaneDeviceList } from "./useAppleLaneDeviceList";
import { useAppleRuntimes } from "./useAppleRuntimes";
import { useAppleDuoModel } from "./useAppleDuoModel";
import { APPLE_RENDER_ANGLES, AppleRenderSheet, appleRenderContactSheet, type AppleRenderRequest } from "./AppleRenderSheet";
import { APPLE_DUO_COVER_SCREEN_ID, APPLE_DUO_INNER_SCREEN_ID } from "../../../shared/types/iosSimulator";
import { useAppleInspect } from "./useAppleInspect";
import { openAppleMiniPlayer } from "./appleMiniPlayerStore";
import type { AppleRenderedPreview } from "./drawer/sections/PreviewLabSection";
import { isInParkedSurface } from "../../lib/parkedSurface";

/**
 * The Apple device, as the body of the Work tools pane's Apple tab.
 *
 * There is no header bar, no Device/Preview Lab toggle, no sibling column and
 * no modal. Top to bottom the pane is: an optional one-line strip, and a body
 * that is either the picker, the loading card, the device, or a rendered
 * preview — with the rail floating on the right of the picture and the tools
 * drawer overlaying it (or docked beside it at ≥700px).
 */

/**
 * The drawer is lazy on purpose: it pulls nine sections, the event log and
 * Preview Lab, none of which a pane showing the picker has any use for.
 */
const AppleToolsDrawer = React.lazy(async () => {
  const mod = await import("./drawer/AppleToolsDrawer");
  return { default: mod.AppleToolsDrawer };
});

export type AppleDevicePaneProps = {
  /** The chat this pane acts for. Recordings and ownership key off it. */
  sessionId: string | null;
  laneId: string | null;
  projectRoot: string | null;
  runtimePin: OpenProjectBinding | null;
  /** The lane-scoped surface drives a device it does not own on purpose. */
  ignoreChatOwnership?: boolean;
  onAddContext?: ((item: IosElementContextItem) => void) | undefined;
  onInsertDraft?: ((text: string) => void) | undefined;
  className?: string;
};


function familyOf(device: AppleLaneDevice | null): "iphone" | "ipad" {
  return device?.family === "ipad" ? "ipad" : "iphone";
}

function helperAvailable(status: IosSimulatorStatus | null): boolean {
  if (!status) return true;
  const helper = status.tools.find((tool) => tool.name === "helper");
  return helper ? helper.available : true;
}

/** The Clean up toast's tone and words: what happened, per docs/design/notices.md. */
function cleanupNotice(input: { listUnreadable: boolean; deviceErrors: number; summary: string | null }): {
  tone: "success" | "warning" | "error";
  title: string;
  message?: string;
} {
  if (input.listUnreadable) {
    return { tone: "error", title: "Could not read the simulator list", message: "Nothing was cleaned up. The ADE log has the details." };
  }
  if (input.deviceErrors) {
    return {
      tone: input.summary ? "warning" : "error",
      title: input.summary ?? "Simulators were not cleaned up",
      message: `${input.deviceErrors} could not be cleaned up yet. The ADE log has the details.`,
    };
  }
  return { tone: "success", title: input.summary ?? "No simulators to clean up" };
}

/** Why Clean up powered nothing off, in the words the toast uses. */
const CLEANUP_SKIP_REASON: Record<NonNullable<AppleDeviceCleanupResult["powerOffSkipped"]>, string> = {
  "simulator-app-open": "Simulator.app is open, so nothing was powered off.",
  "process-list-unavailable": "ADE could not check what uses the devices, so nothing was powered off.",
};

/**
 * The inner panel's picture, a quarter turn on from the device's orientation
 * (the panel is mounted that way; see `displayOrientation`).
 */
const APPLE_DUO_INNER_ORIENTATION: Record<AppleDeviceOrientation, AppleDeviceOrientation> = {
  portrait: "landscape-left",
  "landscape-left": "portrait-upside-down",
  "portrait-upside-down": "landscape-right",
  "landscape-right": "portrait",
};

/** What a runtime remove did, as one toast. Counts only; the details are in the log. */
function showRuntimeRemoval(result: AppleRuntimeDeleteResult) {
  const freed = result.deleted.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const parts = [
    result.deleted.length ? `removed ${result.deleted.map((entry) => entry.name).join(", ")}` : null,
    result.moved.length ? `moved ${result.moved.length} simulator${result.moved.length === 1 ? "" : "s"}` : null,
    result.erased.length ? `erased ${result.erased.length}` : null,
  ].filter(Boolean);
  const failed = result.errors.length > 0;
  showToast({
    id: "apple-runtime-remove",
    tone: failed ? "warning" : "success",
    title: failed
      ? (result.deleted.length ? "Some runtimes were not removed" : "The runtime was not removed")
      : `Freed ${(freed / 1e9).toFixed(1)} GB`,
    message: [parts.length ? `${parts.join(", ")}.` : null, failed ? result.errors[0]!.message : null].filter(Boolean).join(" "),
    ...(failed ? { durationMs: 18_000 } : {}),
  });
}

export function AppleDevicePane({
  sessionId,
  laneId,
  projectRoot,
  runtimePin,
  ignoreChatOwnership = false,
  onAddContext,
  onInsertDraft,
  className,
}: AppleDevicePaneProps) {
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;

  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [loadingStage, setLoadingStage] = useState<AppleLoadingStage>("starting");
  const [startError, setStartError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [endingRemoteSession, setEndingRemoteSession] = useState(false);

  /**
   * §A2: ONE toggle, 3D by default, remembered per project. A forced fallback
   * to flat (§A1) deliberately does NOT overwrite the preference — a body that
   * failed to fetch once must not permanently demote the pane.
   */
  const [mode, setModeState] = useState<AppleViewMode>(() => readAppleViewMode(projectRoot));
  const [threeFailure, setThreeFailure] = useState<AppleDevice3DFailure | null>(null);
  const [viewNonce, setViewNonce] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  /**
   * Which way up the device is (§V1/§V2).
   *
   * STATE, not the ref round 4 kept: both presenters have to draw it and the
   * rail has to show it, and none of that can be driven by a ref. It is what
   * we last successfully asked for — the helper has no "read the orientation"
   * call — so it is committed only when `rotate` reports `applied`, and a
   * device that was already sideways before the pane opened starts out
   * described as portrait until something rotates it.
   */
  const [orientation, setOrientation] = useState<AppleDeviceOrientation>("portrait");
  /**
   * The foldable body's posture. It only ever reaches the 3D view for a device
   * the simulator record reports as foldable; the state exists for every device
   * but does nothing when `duoCapable` is false.
   */
  const [duoState, setDuoState] = useState(() => createAppleDuoState());
  /** What the simulator itself reports: its hinge and the panel that is on. */
  const [duoPosture, setDuoPosture] = useState<AppleDevicePosture | null>(null);
  const duoPostureRef = useRef<AppleDevicePosture | null>(null);
  duoPostureRef.current = duoPosture;
  const [rotating, setRotating] = useState(false);
  const [preview, setPreview] = useState<AppleRenderedPreview | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [bodyWidth, setBodyWidth] = useState(720);
  const [hidden, setHidden] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const {
    status,
    installed,
    laneDevice,
    owners,
    disk,
    ownership,
    measuringDisk,
    runtimes,
    defaultNewDevice,
    refreshing,
    listLoaded,
    listFailed,
    listError,
    bootedRead,
    refreshList,
    dropLaneDevice,
    markInstalledState,
  } = useAppleLaneDeviceList({
    laneId,
    sessionId,
    hidden,
    runtimePinRef,
    onError: setError,
  });

  const deviceUdid = laneDevice?.udid ?? null;
  const statusSaysBooted = appleStatusSaysBooted(status, deviceUdid);
  const startTracker = useAppleDeviceStartTracker({ deviceUdid, statusSaysBooted, bootedRead });
  const {
    pending: pendingStart,
    offUdid,
    markOff,
    clearOff,
    begin: beginStart,
    settle: settleStart,
  } = startTracker;

  /* ── size + visibility ─────────────────────────────────────────────────── */

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

  /**
   * The pane stops the stream when the PANE is not on screen. Not when the
   * window is behind another one.
   *
   * Round 2 also paused on `document.visibilityState`, which on macOS goes
   * "hidden" the moment any other app's window covers this one — and the
   * matching `visibilitychange` does not reliably fire on the way back. The
   * result, reproduced on the dev app in the round-3 test: a pane opened while
   * another window was in front sat on the loading card forever, over a
   * simulator that was booted and streaming the whole time. Minimising or
   * closing the pane unmounts this component, which stops the stream through
   * the lease; that is the case the visibility check was really for.
   */
  useEffect(() => {
    const node = bodyRef.current;
    let offScreen = false;
    const apply = () => setHidden(offScreen);
    let observer: IntersectionObserver | null = null;
    if (node && typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        // A parked surface (another project or tab on screen) reports as not
        // intersecting, but keeps its stream so switching back shows it live.
        offScreen = !entry.isIntersecting && !isInParkedSurface(node);
        apply();
      });
      observer.observe(node);
    }
    apply();
    return () => {
      observer?.disconnect();
    };
  }, []);

  const deviceUdidRef = useRef(deviceUdid);
  deviceUdidRef.current = deviceUdid;
  const installedForLane = useMemo(
    () => installed.find((entry) => entry.udid === deviceUdid) ?? null,
    [deviceUdid, installed],
  );

  /* ── stream ────────────────────────────────────────────────────────────── */

  const onStreamError = useCallback((message: string | null) => {
    if (!message) return;
    // Not an error to show: the device is off, and watching never boots it.
    // The pane says "{name} is off." with Start, and re-reads the list.
    if (isAppleDeviceOffError(message)) {
      const udid = deviceUdidRef.current;
      if (udid) markOff(udid);
      refreshList();
      return;
    }
    setError(new Error(message));
  }, [markOff, refreshList]);

  const booted = appleLaneDeviceBooted({
    deviceUdid,
    offUdid,
    installedForLane,
    statusSaysBooted,
    sessionUdid: status?.deviceSession?.deviceUdid ?? null,
  });

  const stream = useAppleDeviceStream({
    deviceUdid: booted ? deviceUdid : null,
    laneId,
    chatSessionId: sessionId,
    enabled: Boolean(deviceUdid) && booted && Boolean(status?.supported ?? true),
    hidden,
    machineName: null,
    bitrateKbpsCap: null,
    runtimePinRef,
    onError: onStreamError,
  });

  const state: AppleDeviceState = resolveAppleDeviceState({
    supported: status ? status.supported : true,
    helperAvailable: helperAvailable(status),
    hasDevice: Boolean(deviceUdid),
    booted,
    starting: pendingStart !== null,
    previewing: preview !== null,
    streamReady: stream.url != null,
    streamState: stream.state,
  });

  useAppleLoadingWatchdog(startTracker, {
    loading: state === "starting",
    hidden,
    laneId,
    chatSessionId: sessionId,
    runtimePinRef,
    refreshList,
    reconnectStream: stream.reconnect,
    onGiveUp: setError,
  });

  /* ── service events ────────────────────────────────────────────────────── */

  const applyStreamEventRef = useRef(stream.applyStreamEvent);
  applyStreamEventRef.current = stream.applyStreamEvent;

  useEffect(() => {
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
      switch (event.type) {
        case "apple.device.posture": {
          if (event.udid !== deviceUdidRef.current) return;
          setDuoPosture(event.posture);
          const angle = event.posture.angle;
          if (angle !== null) {
            setDuoState((current) => (Math.abs(current.pose.angle - angle) < 1
              ? current
              : reduceAppleDuoState(current, { type: "angle", angle })));
          }
          return;
        }
        case "apple.device.state": {
          if (event.laneId && laneId && event.laneId !== laneId) return;
          if (event.phase === "failed") {
            setStartError(new Error(event.detail ?? "The device did not start."));
            return;
          }
          if (event.phase === "released") {
            // Another lane took this device over. The binding is gone, so the
            // only honest thing this pane can do is re-read it — which lands
            // on the picker rather than on "Video stopped" over a device that
            // is still running for somebody else.
            refreshList();
            return;
          }
          const power = applePowerFromPhase(event.phase);
          if (power === "off") {
            // Powered off (the tab close, the CLI, another window): show the
            // Off card now rather than after the next read.
            markInstalledState(event.udid, "Shutdown");
            refreshList();
            return;
          }
          if (power === "on") {
            markInstalledState(event.udid, "Booted");
            clearOff(event.udid);
          }
          setLoadingStage(event.phase === "streaming" ? "streaming" : "starting");
          if (event.phase === "streaming") {
            /*
             * The start is done: the service emits this once the capture is
             * open. The card used to wait for the `deviceStart` promise alone,
             * so a reply that came late or never (a runtime reconnect, a start
             * queued behind another lifecycle step) left it on "Booting
             * device" over a device that was already streaming, until the
             * pane was remounted. The event settles it too.
             */
            settleStart();
            refreshList();
          }
          return;
        }
        case "stream-started":
          if (event.status.deviceUdid) clearOff(event.status.deviceUdid);
          applyStreamEventRef.current(event.status);
          return;
        case "stream-status":
        case "stream-stopped":
        case "stream-error":
          applyStreamEventRef.current(event.status);
          return;
        case "device-session-started":
        case "device-session-released":
        case "session-started":
        case "session-released":
          refreshList();
          return;
        default:
          return;
      }
    }, runtimePinRef.current);
    return unsubscribe;
  }, [clearOff, laneId, markInstalledState, refreshList, settleStart]);

  /* ── recordings ────────────────────────────────────────────────────────── */

  const onRecordingError = useCallback((message: string | null) => {
    if (message) setError(new Error(message));
  }, []);

  const recordings = useAppleRecordings({
    laneId,
    chatSessionId: sessionId,
    enabled: Boolean(laneId) && !hidden,
    runtimePinRef,
    onError: onRecordingError,
  });
  const recordingActive = recordings.active;

  useEffect(() => {
    if (!recordingActive) return undefined;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [recordingActive]);

  /* ── the view toggle (§A2) and the 3D fallback (§A1) ───────────────────── */

  useEffect(() => {
    setModeState(readAppleViewMode(projectRoot));
    setThreeFailure(null);
  }, [projectRoot]);

  const setMode = useCallback((next: AppleViewMode) => {
    setModeState(next);
    if (next === "3d") setThreeFailure(null);
    writeAppleViewMode(projectRoot, next);
  }, [projectRoot]);

  /**
   * The 3D presenter cannot draw this device. Round 3 answered that with a
   * procedural slab, which is why nobody ever saw an Apple logo; round 4 falls
   * back to the FLAT view and says so once, with a way to try again.
   */
  const handleThreeUnavailable = useCallback((reason: AppleDevice3DFailure) => {
    setThreeFailure(reason);
    setModeState("flat");
  }, []);

  const retryThreeD = useCallback(() => {
    setThreeFailure(null);
    setModeState("3d");
    setViewNonce((nonce) => nonce + 1);
  }, []);

  /* ── inspect (§A4) ─────────────────────────────────────────────────────── */

  /*
   * Free truth. The snapshot describes the interface as it really is, so an
   * orientation the pane has wrong — a device someone rotated before this pane
   * opened, or a rotate the device quietly ignored — is corrected here at no
   * extra cost. Only the SHAPE is corrected: the tree cannot tell
   * landscape-left from landscape-right.
   */
  const correctOrientation = useCallback((elements: IosSimulatorSnapshotElement[]) => {
    const observed = appleObservedOrientationFamily(elements);
    if (!observed) return;
    setOrientation((current) => (
      appleOrientationFamily(current) === observed
        ? current
        : observed === "landscape" ? "landscape-left" : "portrait"
    ));
  }, []);

  const { inspectOn, toggleInspect, renderInspectOverlay } = useAppleInspect({
    deviceUdid,
    live: state === "live",
    laneId,
    projectRoot,
    runtimePinRef,
    onAddContext,
    onInsertDraft,
    onElements: correctOrientation,
    onError: setError,
  });

  /* ── actions ───────────────────────────────────────────────────────────── */

  const start = useCallback((args: AppleDeviceStartArgs, key: string) => {
    // Only the current start may settle the card. One that the `streaming`
    // event, the give-up timer or a newer start already replaced changes
    // nothing when its promise finally lands.
    const ticket = beginStart(key);
    setStartError(null);
    setError(null);
    setLoadingStage("starting");
    void window.ade.iosSimulator.deviceStart(args, runtimePinRef.current)
      .then(() => {
        refreshList();
      })
      .catch((cause: unknown) => {
        if (ticket()) setStartError(cause);
      })
      .finally(() => settleStart(ticket));
  }, [beginStart, refreshList, settleStart]);

  const startInstalled = useCallback((udid: string) => {
    start({ laneId, chatSessionId: sessionId, udid }, udid);
  }, [laneId, sessionId, start]);

  // What Create asked for, so the loading card can name it before it exists.
  const creatingSpecRef = useRef<AppleNewDeviceSpec | null>(null);
  const createDevice = useCallback((spec: AppleNewDeviceSpec) => {
    creatingSpecRef.current = spec;
    start({ laneId, chatSessionId: sessionId, create: { runtime: spec.runtime, deviceType: spec.deviceType } }, "create");
  }, [laneId, sessionId, start]);

  /**
   * The storage section's Clean up: the cleanup pass, plus powering off every
   * idle ADE device. The toast says what it did; the list is re-read after.
   */
  const [cleaning, setCleaning] = useState(false);
  const cleanupDevices = useCallback(() => {
    setCleaning(true);
    void window.ade.iosSimulator
      .deviceCleanup({ ...(laneId ? { laneId } : {}), powerOffIdle: true }, runtimePinRef.current)
      .then((result) => {
        const parts = [
          result.deleted.length ? `deleted ${result.deleted.length}` : null,
          result.poweredOff.length ? `powered off ${result.poweredOff.length}` : null,
          result.released.length ? `released ${result.released.length}` : null,
        ].filter(Boolean);
        const listUnreadable = result.errors.some((entry) => entry.udid === null);
        const deviceErrors = result.errors.filter((entry) => entry.udid !== null).length;
        const skippedWhy = result.powerOffSkipped ? CLEANUP_SKIP_REASON[result.powerOffSkipped] : null;
        // Counts only. The raw simctl errors are in the log, not in the toast.
        const summary = parts.length ? `Cleaned up simulators: ${parts.join(", ")}` : null;
        const notice = cleanupNotice({ listUnreadable, deviceErrors, summary });
        const message = [notice.message, skippedWhy].filter(Boolean).join(" ");
        showToast({
          id: "apple-device-cleanup",
          tone: notice.tone,
          title: notice.title,
          ...(message ? { message } : {}),
          ...(notice.tone === "success" ? {} : { durationMs: 18_000 }),
        });
      })
      .catch((cause: unknown) => setError(cause))
      .finally(() => {
        setCleaning(false);
        refreshList();
      });
  }, [laneId, refreshList]);

  /* ── simulator runtimes ──────────────────────────────────────────────── */

  /**
   * "Install & create": the model the person picked while its runtime was
   * missing. When the download settles as done, it is created on the newest
   * runtime that now runs it.
   */
  const installThenCreateRef = useRef<string | null>(null);
  const [runtimesNonce, setRuntimesNonce] = useState(0);
  const runtimes$ = useAppleRuntimes({
    runtimePinRef,
    pinKey: runtimePin?.key ?? null,
    enabled: !hidden,
    refreshNonce: runtimesNonce,
    onError: (cause) => setError(cause),
    onInstallSettled: (install) => {
      const wanted = installThenCreateRef.current;
      installThenCreateRef.current = null;
      refreshList();
      if (install.phase === "failed") {
        showToast({ id: "apple-runtime-install", tone: "error", title: `iOS ${install.version} didn't install`, message: install.message ?? undefined, durationMs: 18_000 });
        return;
      }
      if (install.phase !== "done") return;
      void window.ade.iosSimulator.runtimeList(runtimePinRef.current).then((inventory) => {
        const target = wanted
          ? inventory.runtimes
            .filter((entry) => entry.deviceTypes.some((type) => type.identifier === wanted))
            .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0] ?? null
          : null;
        const model = target?.deviceTypes.find((type) => type.identifier === wanted) ?? null;
        if (target && model) {
          showToast({ id: "apple-runtime-install", tone: "success", title: `iOS ${install.version} is installed`, message: `Creating ${model.name}…` });
          createDevice({ runtime: target.runtimeIdentifier, deviceType: model.identifier });
          return;
        }
        const duo = inventory.runtimes.flatMap((entry) => entry.deviceTypes.map((type) => ({ entry, type })))
          .find(({ type }) => /duo/i.test(type.name)) ?? null;
        showToast({
          id: "apple-runtime-install",
          tone: "success",
          title: `iOS ${install.version} is installed`,
          ...(duo ? { actions: [{ label: `Create ${duo.type.name}`, onClick: () => createDevice({ runtime: duo.entry.runtimeIdentifier, deviceType: duo.type.identifier }) }] } : {}),
        });
      }).catch(() => undefined);
    },
  });
  const installAndCreate = useCallback((deviceType: string) => {
    installThenCreateRef.current = deviceType;
    void runtimes$.install();
  }, [runtimes$]);
  const removeRuntime = useCallback((id: string, simulators: AppleRuntimeSimulatorDisposition) => {
    void runtimes$.remove(id, simulators).then((result) => {
      if (result) showRuntimeRemoval(result);
      refreshList();
    });
  }, [refreshList, runtimes$]);
  const pruneRuntimes = useCallback((simulators: AppleRuntimeSimulatorDisposition) => {
    void runtimes$.prune(simulators).then((result) => {
      if (result) showRuntimeRemoval(result);
      refreshList();
    });
  }, [refreshList, runtimes$]);
  const refreshAll = useCallback(() => {
    refreshList();
    setRuntimesNonce((value) => value + 1);
  }, [refreshList]);

  /**
   * Delete a simulator from the picker's per-device menu.
   *
   * `confirmedByUser` is not a formality here: the picker asked, by name and
   * with the measured size, and the service refuses the call without it. The
   * list is re-read rather than patched, because `simctl delete` can fail for
   * a device Xcode already removed and the truth is whatever `simctl list`
   * says afterwards.
   */
  const deleteInstalled = useCallback((udid: string) => {
    void window.ade.iosSimulator
      .deviceDeleteInstalled(
        { udid, confirmedByUser: true, ...(laneId ? { laneId } : { projectRoot }) },
        runtimePinRef.current,
      )
      .catch((cause: unknown) => setError(cause))
      .finally(() => refreshList());
  }, [laneId, projectRoot, refreshList]);

  const restart = useCallback(() => {
    if (deviceUdid) start({ laneId, chatSessionId: sessionId, udid: deviceUdid }, deviceUdid);
  }, [deviceUdid, laneId, sessionId, start]);

  /*
   * `deviceStop` runs `simctl shutdown` on any device, including one the pane
   * started, and announces `stopped`, which moves this pane and the tools card
   * to "Off" at once.
   */
  const powerOff = useCallback(() => {
    if (!deviceUdid) return;
    void window.ade.iosSimulator
      .deviceStop(
        {
          laneId,
          udid: deviceUdid,
          chatSessionId: sessionId,
          ignoreOwnership: ignoreChatOwnership,
        },
        runtimePinRef.current,
      )
      .then(() => refreshList())
      .catch((cause: unknown) => setError(cause));
  }, [deviceUdid, ignoreChatOwnership, laneId, refreshList, sessionId]);

  /**
   * "Switch device…" deletes or detaches this lane's device and returns to the
   * picker. With "Choose another device" below, it is the only way back, which
   * is why `APPLE_DEVICE_EXISTS` can never reach a person: nothing else ever
   * asks for a second one.
   */
  const switchDevice = useCallback(() => {
    setConfirmSwitch(false);
    void window.ade.iosSimulator
      .deviceDelete(
        { laneId, chatSessionId: sessionId, force: true, ignoreOwnership: ignoreChatOwnership },
        runtimePinRef.current,
      )
      .then(dropLaneDevice)
      .catch((cause: unknown) => setError(cause));
  }, [dropLaneDevice, ignoreChatOwnership, laneId, sessionId]);

  /**
   * "Choose another device" on the Off card: one click, and it never deletes.
   * The device can be off for reasons the person did not choose here (an
   * agent, the CLI, a restart), so this only releases the lane's binding; the
   * simulator stays installed and shows in the picker as free.
   */
  const chooseAnotherDevice = useCallback(() => {
    void window.ade.iosSimulator
      .deviceDetach({ laneId, chatSessionId: sessionId, ignoreOwnership: ignoreChatOwnership }, runtimePinRef.current)
      .then(dropLaneDevice)
      .catch((cause: unknown) => setError(cause));
  }, [dropLaneDevice, ignoreChatOwnership, laneId, sessionId]);

  const screenshot = useCallback(() => {
    setScreenshotPending(true);
    void window.ade.iosSimulator
      .screenshot(
        { deviceUdid, ...(laneId ? { laneId } : { projectRoot }) },
        runtimePinRef.current,
      )
      .catch((cause: unknown) => setError(cause))
      .finally(() => setScreenshotPending(false));
  }, [deviceUdid, laneId, projectRoot]);

  const pressHome = useCallback(() => {
    if (!appleInputAllowed(state)) return;
    void window.ade.iosSimulator
      .pressButton({ name: "home", laneId, deviceUdid }, runtimePinRef.current)
      .catch((cause: unknown) => setError(cause));
  }, [deviceUdid, laneId, state]);

  /**
   * The device's other physical buttons. Same guard and same service call as
   * Home — `pressButton` dispatches by name, so this is one callback rather
   * than one per key.
   */
  const pressHardwareButton = useCallback((name: AppleHardwareButtonName) => {
    if (!appleInputAllowed(state)) return;
    void window.ade.iosSimulator
      .pressButton({ name, laneId, deviceUdid }, runtimePinRef.current)
      .catch((cause: unknown) => setError(cause));
  }, [deviceUdid, laneId, state]);

  /**
   * §V2: rotate TO an orientation, and believe the DEVICE rather than the call.
   *
   * The verification now lives in the service, which reads the real
   * framebuffer before and after the send and only answers `applied: true`
   * when the screen was observed on the requested axis — so the CLI, agents
   * and this pane all get the same truth instead of each guessing. `detail`
   * is written to be shown as-is: when iOS takes the device orientation and
   * the foreground app keeps its own (the Home Screen and Settings are
   * portrait-only on an iPhone, and no iPhone does portrait upside down) that
   * sentence is the one thing the rail can usefully say.
   *
   * The picture is only turned on a confirmed rotation. Turning it on the
   * request would draw an upright screen on its side, which is the defect §V1
   * exists to remove.
   */
  const rotateTo = useCallback((next: AppleDeviceOrientation) => {
    if (!appleInputAllowed(state) || !deviceUdid) return;
    setRotating(true);
    void window.ade.iosSimulator
      .rotate({ orientation: next, laneId, deviceUdid }, runtimePinRef.current)
      .then((result) => {
        if (result?.applied !== true) {
          // The reason CODE leads, because `describeAppleError` matches on it
          // and would otherwise fall back to "Something went wrong" — which is
          // the silence §3 is here to remove. `detail` stays in the message so
          // the strip's `Details` still carries the whole explanation.
          const reason = result?.reason ?? "";
          const detail = result?.detail ?? "The simulator did not rotate, and it did not say why.";
          throw new Error(reason ? `${reason}: ${detail}` : detail);
        }
        setOrientation(next);
      })
      .catch((cause: unknown) => setError(cause))
      .finally(() => setRotating(false));
  }, [deviceUdid, laneId, state]);

  const float = useCallback(() => {
    if (!deviceUdid || !laneDevice) return;
    openAppleMiniPlayer({
      laneId,
      chatSessionId: sessionId,
      deviceUdid,
      deviceName: laneDevice.name,
      deviceRuntime: laneDevice.runtime,
      family: familyOf(laneDevice),
      runtimePin: runtimePinRef.current,
    });
  }, [deviceUdid, laneDevice, laneId, sessionId]);

  /**
   * Pointer, wheel and keys → the device.
   *
   * Unit F owns this: the hook recognises the gesture and sends ONE action for
   * it (`tap` or `drag`), which is what makes a swipe scroll and what stopped a
   * burst of taps from becoming a burst of 25-second runtime calls.
   */
  const input = useAppleDeviceInput({
    deviceUdid,
    laneId,
    chatSessionId: sessionId,
    enabled: appleInputAllowed(state) && !inspectOn,
    runtimePinRef,
    onError: setError,
  });

  const handleStripAction = useCallback((action: AppleErrorAction) => {
    setError(null);
    if (action === "start") restart();
    else if (action === "reconnect") stream.reconnect();
    // `reinstall` has nothing to press: the sentence IS the instruction.
  }, [restart, stream]);

  /* ── viewport ──────────────────────────────────────────────────────────── */

  /*
   * §A1/§A2: the only things that can stop 3D now are a window without
   * WebCodecs — where there is no decoded canvas to put on the body at all —
   * and a body the presenter has already reported it cannot draw. The round-3
   * 420px floor and the "Inspect is flat-view only" rule are both gone: the
   * inspect overlay projects through the live camera, so it works in 3D.
   */
  const webCodecs = isWebCodecsAvailable();
  const canUse3d = webCodecs && threeFailure === null;
  const threeDisabledReason = threeFailure
    ?? (webCodecs ? null : "3D view needs WebCodecs, which this window does not have.");
  const effectiveMode: AppleViewMode = canUse3d ? mode : "flat";

  const deviceName = laneDevice?.name ?? "Simulator";
  /*
   * The lane device row carries no CoreSimulator type, so read it off the
   * installed entry with the same udid. That entry is Apple's own record; the
   * lane device's NAME is whatever ADE or a person called the device.
   */
  const deviceTypeIdentifier = laneDevice
    ? installed.find((entry) => entry.udid === laneDevice.udid)?.deviceTypeIdentifier ?? null
    : null;
  /*
   * The Duo mode is capability-gated on the CoreSimulator type identifier only.
   * Only a device whose simulator record reports foldable gets the procedural
   * two-panel body and the fold controls; every other device — and every host
   * with no Duo runtime — keeps the unchanged single-display path and does no
   * Duo work.
   *
   * `deviceName` is deliberately NOT passed to the matcher: it is the lane
   * device's display name ("ADE · <lane>" for an ADE device), not Apple's device-type
   * name, so a lane called "duo-hinge" would otherwise mark an iPhone 17 as
   * foldable and render the Duo body on a rigid device.
   */
  const duoCapable = appleDeviceSupportsDuo({ deviceTypeIdentifier });
  const duoModel = useAppleDuoModel({ enabled: duoCapable && canUse3d, pinKey: runtimePin?.key ?? null, runtimePinRef });
  // The rail's fold controls drive the real simulator, so they show in flat
  // mode too; only the articulated body needs the 3D view.
  const duoControlsEnabled = duoCapable;
  const duoProps: AppleDeviceDuoProps | undefined = duoCapable && canUse3d
    ? {
        enabled: true,
        angle: duoState.pose.angle,
        lowerFlat: duoState.pose.lowerFlat,
        model: duoModel,
        activeScreenId: duoPosture?.activeScreenId ?? null,
        physicalOrientation: duoPosture?.orientation ?? null,
        onHingeChange: (angle) => {
          setDuoState((current) => reduceAppleDuoState(current, { type: "angle", angle }));
          sendDuoAngleSoon(angle);
        },
      }
    : undefined;
  /*
   * The inner panel is mounted a quarter turn from the cover: its raw
   * framebuffer is portrait while its picture is landscape. The stage already
   * turns a raw frame for a sideways device, so the inner panel is drawn as one
   * quarter turn further on (and taps are inverted by the same turn).
   */
  const displayOrientation: AppleDeviceOrientation = duoCapable && duoPosture?.activeScreenId === APPLE_DUO_INNER_SCREEN_ID
    ? APPLE_DUO_INNER_ORIENTATION[orientation]
    : orientation;

  /**
   * Fold the real simulator. Every caller here is the person at the rail or
   * the 3D hinge; the view moves first and the simulator's own posture events
   * settle it (the readback is what the guest actually did).
   */
  const sendDuoPosture = useCallback((target: { pose?: AppleDevicePose; angle?: number }) => {
    void window.ade.iosSimulator
      .setPosture({ laneId, chatSessionId: sessionId, ...target }, runtimePinRef.current)
      .then((result) => setDuoPosture(result.posture))
      .catch((cause: unknown) => setError(cause));
  }, [laneId, sessionId]);
  /** A hinge drag sends its latest angle once the drag pauses, not every frame. */
  const duoAngleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendDuoAngleSoon = useCallback((angle: number) => {
    if (duoAngleTimerRef.current) clearTimeout(duoAngleTimerRef.current);
    duoAngleTimerRef.current = setTimeout(() => {
      duoAngleTimerRef.current = null;
      sendDuoPosture({ angle: Math.round(angle) });
    }, 250);
  }, [sendDuoPosture]);
  useEffect(() => () => {
    if (duoAngleTimerRef.current) clearTimeout(duoAngleTimerRef.current);
  }, []);

  /* ── 3D renders ────────────────────────────────────────────────────────── */

  const rendererRef = useRef<AppleDeviceRenderer | null>(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const openRender = useCallback(() => {
    // Renders come from the 3D body; bring it up if the flat view is on.
    if (effectiveMode !== "3d") setMode("3d");
    setRenderOpen(true);
  }, [effectiveMode]);

  /**
   * Render the device: for a Duo each pose folds the REAL simulator first and
   * waits for it to settle, so every shot shows the panel and layout that
   * pose really has. Every image (and the video) is filed to the proof drawer.
   */
  const runRender = useCallback(async (request: AppleRenderRequest) => {
    const renderer = rendererRef.current;
    if (!renderer) {
      showToast({ id: "apple-render", tone: "warning", title: "The 3D view is still loading. Try again in a moment." });
      return;
    }
    setRendering(true);
    const options = {
      width: 1600,
      height: 1600,
      lighting: request.lighting,
      shadow: request.shadow,
    };
    const shots = APPLE_RENDER_ANGLES.filter((angle) => request.angles.includes(angle.id));
    const images: Array<{ dataUrl: string; label: string }> = [];
    /*
     * A pose is ready to shoot once the simulator itself says so: its hinge
     * at the pose's angle and the panel that pose lights on. Then iOS still
     * animates its interface into the new orientation, so give that time too.
     * A fixed wait shot the closed phone before its cover came on.
     */
    const POSE_TARGETS: Record<AppleDevicePose, { angle: number; screen: number }> = {
      closed: { angle: 0, screen: APPLE_DUO_COVER_SCREEN_ID },
      tent: { angle: 80, screen: APPLE_DUO_COVER_SCREEN_ID },
      laptop: { angle: 90, screen: APPLE_DUO_INNER_SCREEN_ID },
      book: { angle: 90, screen: APPLE_DUO_INNER_SCREEN_ID },
      open: { angle: 180, screen: APPLE_DUO_INNER_SCREEN_ID },
    };
    const settle = async (pose: AppleDevicePose) => {
      const target = POSE_TARGETS[pose];
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const posture = duoPostureRef.current;
        if (posture?.angle != null && Math.abs(posture.angle - target.angle) <= 3
          && posture.activeScreenId === target.screen) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    };
    try {
      const passes: Array<AppleDevicePose | null> = request.poses.length ? request.poses : [null];
      for (const pose of passes) {
        if (pose) {
          await window.ade.iosSimulator.setPosture({ laneId, chatSessionId: sessionId, pose }, runtimePinRef.current);
          await settle(pose);
        }
        const rendered = rendererRef.current?.renderShots(shots.map((angle) => angle.shot), options) ?? [];
        rendered.forEach((dataUrl, index) => images.push({
          dataUrl,
          label: [pose ? pose[0]!.toUpperCase() + pose.slice(1) : null, shots[index]!.label].filter(Boolean).join(" · "),
        }));
      }
      const name = deviceName ?? "device";
      // The scene bridge files a PNG or WebM to this chat's proof drawer. A
      // window without it (the web client) has nowhere to put renders.
      const attachRenderProof = (args: { dataUrl: string; title: string; sessionId: string | null }) =>
        window.ade.scene?.attachProof(args) ?? Promise.resolve(false);
      let filed = 0;
      for (const image of images) {
        if (await attachRenderProof({ dataUrl: image.dataUrl, title: `${name} · ${image.label}`, sessionId })) filed++;
      }
      if (request.contactSheet && images.length > 1) {
        const sheet = await appleRenderContactSheet(images);
        if (sheet && await attachRenderProof({ dataUrl: sheet, title: `${name} · contact sheet`, sessionId })) filed++;
      }
      if (request.video) {
        const blob = await rendererRef.current?.renderTurntable({ ...options, width: 1280, height: 1280, seconds: 6 });
        if (blob) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).replace(/^data:video\/webm;[^,]*,/, "data:video/webm;base64,"));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          if (await attachRenderProof({ dataUrl, title: `${name} · turntable`, sessionId })) filed++;
        }
      }
      showToast({ id: "apple-render", tone: "success", title: `Rendered ${filed} item${filed === 1 ? "" : "s"} to the proof drawer` });
      setRenderOpen(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setRendering(false);
    }
  }, [deviceName, laneId, sessionId]);

  /** Read the pose once the Duo is live; posture events keep it current after that. */
  const duoLive = duoCapable && state === "live";
  useEffect(() => {
    if (!duoLive) {
      setDuoPosture(null);
      return;
    }
    // An older host has no posture action: the Duo body still draws.
    if (typeof window.ade.iosSimulator.getPosture !== "function") return;
    let cancelled = false;
    void window.ade.iosSimulator
      .getPosture({ laneId, chatSessionId: sessionId }, runtimePinRef.current)
      .then((posture) => {
        if (cancelled) return;
        setDuoPosture(posture);
        if (posture.angle !== null) {
          setDuoState((current) => reduceAppleDuoState(current, { type: "angle", angle: posture.angle! }));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [duoLive, laneId, sessionId, runtimePin?.key]);
  const inputConnected = state === "live";

  const viewport = renderViewport();

  function renderViewport() {
    switch (state) {
      case "unsupported":
        return (
          <PaneMessage
            title="Apple simulators need a Mac runtime."
            description={status?.tools.find((tool) => !tool.available)?.detail ?? null}
          />
        );
      case "helper-missing":
        return (
          <PaneMessage
            title="ADE's simulator helper is missing from this install."
            description="Reinstall ADE to restore it."
          />
        );
      case "no-device":
        // Until a list read answers, "no device" only means "not known yet":
        // the picker's empty card would claim no simulators are installed.
        if (!listLoaded) {
          return listFailed ? (
            <div data-apple-list-failed="" className="flex size-full items-start justify-center px-4 py-6">
              <div className="w-full max-w-sm">
                <Banner
                  layout="inline"
                  model={{
                    id: "apple-device-list",
                    tone: "error",
                    title: "Couldn't load this lane's simulators.",
                    detail: describeAppleError(listError).sentence,
                    busy: refreshing,
                    actions: [{ label: "Retry", onClick: refreshList, disabled: refreshing }],
                  }}
                />
              </div>
            </div>
          ) : (
            <PaneMessage title="Loading simulators…" description={null} />
          );
        }
        return (
          <AppleDevicePicker
            installed={installed}
            owners={owners}
            laneDevice={laneDevice}
            disk={disk}
            measuringDisk={measuringDisk}
            runtimes={runtimes}
            defaultNewDevice={defaultNewDevice}
            ownership={ownership}
            pending={pendingStart}
            refreshing={refreshing}
            onStart={startInstalled}
            onCreate={createDevice}
            onCleanup={cleanupDevices}
            cleaning={cleaning}
            onDelete={deleteInstalled}
            onRefresh={refreshAll}
            playing={!hidden}
            runtimeInventory={runtimes$.inventory}
            removingRuntime={runtimes$.removing}
            onInstallAndCreate={installAndCreate}
            onCancelInstall={runtimes$.cancelInstall}
            onRemoveRuntime={removeRuntime}
            onPruneRuntimes={pruneRuntimes}
            onRunXcodeSetup={runtimes$.runXcodeSetup}
          />
        );
      case "starting":
        return (
          <AppleDeviceLoadingCard
            name={startingName()}
            runtime={startingRuntime()}
            model={startingIdentity().model}
            family={startingIdentity().family}
            isNew={pendingStart === "create"}
            /* Without a start in flight the device is already up and only the
               video is connecting; "Booting device" there read as ADE powering
               the simulator on by itself. */
            stage={pendingStart ? loadingStage : "streaming"}
            error={startError}
            /* A failure the service announced can be retried at once, even
               while its promise has not come back yet. */
            onRetry={() => (pendingStart && !startError ? undefined : restart())}
          />
        );
      case "preview":
        return (
          <div className="ade-tool-picker-static relative size-full overflow-auto p-4">
            <Button
              variant="outline"
              size="sm"
              className="absolute left-3 top-3 z-[2]"
              onClick={() => setPreview(null)}
            >
              ← Back to device
            </Button>
            {preview ? (
              <img
                src={preview.dataUrl}
                alt={`${preview.targetLabel} preview`}
                className="mx-auto max-h-full max-w-full object-contain"
              />
            ) : null}
          </div>
        );
      case "stopped":
      case "video-lost":
      case "live":
      default:
        return (
          <>
            <AppleDeviceStage
              streamUrl={stream.url}
              streamToken={stream.token}
              reconnectNonce={stream.reconnectNonce}
              mode={effectiveMode}
              viewNonce={viewNonce}
              family={familyOf(laneDevice)}
              deviceTypeName={deviceName}
              deviceTypeIdentifier={deviceTypeIdentifier}
              orientation={displayOrientation}
              devicePointSize={stream.devicePointSize}
              /*
               * §A4: while Inspect owns the pointer, so does the overlay.
               *
               * In FLAT that gesture layer IS the container the overlay is
               * drawn inside, and its pointer-down calls `setPointerCapture`,
               * which retargets the click to the container — so a layer left
               * live swallowed every click the overlay was there to receive.
               * The input hook already refuses to send while inspecting
               * (`enabled` above); this is the other half of that gate.
               */
              interactive={appleInputAllowed(state) && !inspectOn}
              duo={duoProps}
              rendererRef={rendererRef}
              onDeviceInput={input.send}
              onDeviceScroll={input.scroll}
              onDeviceKey={input.key}
              onReaderStatus={stream.handleReaderStatus}
              onDimensions={stream.handleDimensions}
              onFrame={stream.noteFrame}
              frameVersion={stream.frameVersion}
              onThreeUnavailable={handleThreeUnavailable}
              renderScreenOverlay={renderInspectOverlay}
              className={cn(
                "bg-transparent",
                (state === "video-lost" || state === "stopped") && "opacity-40",
              )}
            />
            {/*
              An OFF device is a dimmed body with one quiet word on it. It used
              to carry the Apple logo, which is what a booting device shows, so a
              powered-off lane device read as one that was about to come up. The
              label sits outside the stage so the dimming does not fade it too.
            */}
            {state === "stopped" ? (
              <div
                data-apple-off-screen=""
                className="pointer-events-none absolute inset-0 grid place-items-center"
              >
                <span className="rounded-full border border-border bg-surface px-3 py-1 font-sans text-xs text-muted-fg">
                  Off
                </span>
              </div>
            ) : null}
          </>
        );
    }
  }

  /** The runtime and model Create asked for, by name, while that device is being made. */
  function creatingNames(): { runtime: string | null; model: string | null; family: AppleDeviceFamilyId } | null {
    const spec = pendingStart === "create" ? creatingSpecRef.current : null;
    if (!spec) return null;
    const runtime = runtimes.find((entry) => entry.identifier === spec.runtime) ?? null;
    const type = runtime?.deviceTypes.find((entry) => entry.identifier === spec.deviceType) ?? null;
    return { runtime: runtime?.name ?? null, model: type?.name ?? null, family: type?.family ?? "iphone" };
  }

  function startingName(): string {
    const creating = creatingNames();
    if (creating) return creating.model ? `new ${creating.model}` : "new simulator";
    if (laneDevice) return laneDevice.name;
    const match = installed.find((entry) => entry.udid === pendingStart);
    return match?.name ?? "Simulator";
  }

  function startingRuntime(): string | null {
    const creating = creatingNames();
    if (creating) return creating.runtime;
    if (laneDevice) return laneDevice.runtime;
    return installed.find((entry) => entry.udid === pendingStart)?.runtime ?? null;
  }

  /**
   * The starting card's glyph and model line, from the device type identifier
   * rather than the lane record's two-value `family` — a Watch or a Vision Pro
   * booting under a phone outline is the same "what IS this?" the picker just
   * fixed.
   */
  function startingIdentity(): { family: AppleDeviceFamilyId; model: string | null } {
    const creating = creatingNames();
    // The name already says the model.
    if (creating) return { family: creating.family, model: null };
    const record = installed.find(
      (entry) => entry.udid === (laneDevice?.udid ?? pendingStart),
    );
    if (!record) return { family: familyOf(laneDevice), model: null };
    const identity = appleDeviceIdentity(record);
    return { family: identity.family, model: identity.renamed ? identity.model : null };
  }

  // Only this pane's lane: the status read falls back across lanes.
  const remoteHolder = status?.remoteHolder
    && (!status.activeSession?.laneId || !laneId || status.activeSession.laneId === laneId)
    ? status.remoteHolder
    : null;
  // "An agent on Mac mini": the wording the phone's owner ribbon uses too.
  const remoteHolderLabel = remoteHolder
    ? remoteAgentHolderLabel(remoteHolder.machineName, { sentenceStart: true })
    : null;
  async function freeDeviceFromRemoteAgent(): Promise<void> {
    const holderSessionId = status?.activeSession?.chatSessionId ?? null;
    if (!holderSessionId) return;
    const confirmed = await confirmDialog({
      title: "Free this device?",
      message: `${remoteHolderLabel} is driving this device. Freeing it ends that agent's session here and stops its live view. If the agent is still working, it can take the device again.`,
      confirmLabel: "Free device",
      destructive: true,
    });
    if (!confirmed) return;
    setEndingRemoteSession(true);
    try {
      // The service checks that the same agent still holds the device and
      // ends it in one step, so a session that changed hands while the dialog
      // was open is never ended by mistake.
      const result = await window.ade.iosSimulator.shutdown(
        { laneId: laneId ?? null, ignoreOwnership: true, expectedChatSessionId: holderSessionId },
        runtimePinRef.current,
      );
      if (!result.released) {
        showToast({
          tone: "info",
          title: result.previousSession
            ? "Another session took the device first; nothing was freed."
            : "The agent already let go of this device.",
        });
      }
      refreshList();
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setEndingRemoteSession(false);
    }
  }

  const strip = error != null
    ? (
      <AppleDeviceStatusStrip
        error={error}
        onAction={handleStripAction}
        onDismiss={() => setError(null)}
      />
    )
    : state === "video-lost"
      ? (
        <AppleDeviceNoticeStrip
          sentence="Video stopped."
          actionLabel="Reconnect"
          onAction={() => stream.reconnect()}
        />
      )
      : state === "stopped"
        ? (
          <AppleDeviceNoticeStrip
            sentence={`${deviceName} is off.`}
            actionLabel="Start"
            onAction={restart}
            /* One click, no confirm (the owner's 2026-09-23 ask): it only
               releases the device, it never deletes it. The rail's "Switch
               device…" on a RUNNING device keeps its confirm. */
            secondaryActionLabel="Choose another device"
            onSecondaryAction={chooseAnotherDevice}
          />
        )
        /* An agent on another machine (`ade apple … --machine`) holds this
           device. Said here, on the pane the person is looking at, so the
           simulator moving on its own has a reason; ending it asks first. */
        : remoteHolder && state !== "no-device"
          ? (
            <AppleDeviceNoticeStrip
              sentence={`${remoteHolderLabel} is driving this device.`}
              actionLabel="Free device"
              onAction={() => { void freeDeviceFromRemoteAgent(); }}
              busy={endingRemoteSession}
            />
          )
        /* §A1: the ONE sentence a fallback to flat is allowed to say. */
        : threeFailure
          ? (
            <AppleDeviceNoticeStrip
              sentence={`${threeFailure} Showing the flat view.`}
              actionLabel="Try 3D again"
              onAction={retryThreeD}
              onDismiss={() => setThreeFailure(null)}
            />
          )
          : null;

  return (
    <div
      data-apple-pane=""
      data-apple-device-state={state}
      className={cn("relative flex h-full min-h-0 min-w-0 flex-col bg-surface", className)}
    >
      {strip}
      <div ref={bodyRef} className="@container relative flex min-h-0 min-w-0 flex-1">
        {/* §B3: the device sits on the tools grid's page, not on pure black.
            The STATIC gradient, never the shader — a 30 fps WebGL mesh behind
            a live H.264 decode is two animations competing for one GPU, and
            the only part of it you can see is the 2px margin round the
            picture. */}
        <div className="ade-tool-picker-static relative flex min-h-0 min-w-0 flex-1 flex-col">
          {viewport}

          {appleRailVisible(state) ? (
            <AppleDeviceRail
              containerWidth={bodyWidth}
              deviceName={deviceName}
              deviceRuntime={laneDevice?.runtime ?? null}
              inputConnected={inputConnected}
              mode={effectiveMode}
              canUse3d={canUse3d}
              threeDisabledReason={threeDisabledReason}
              toolsOpen={toolsOpen}
              inspecting={inspectOn}
              recording={Boolean(recordingActive)}
              screenshotPending={screenshotPending}
              onHome={pressHome}
              onHardwareButton={pressHardwareButton}
              duo={duoControlsEnabled
                ? {
                    capable: true,
                    angle: duoState.pose.angle,
                    stance: nearestAppleDuoStance(duoState.pose.angle),
                    reported: duoPosture
                      ? {
                        angle: duoPosture.angle,
                        panel: duoPosture.activeScreenId === APPLE_DUO_COVER_SCREEN_ID
                          ? "cover"
                          : duoPosture.activeScreenId === APPLE_DUO_INNER_SCREEN_ID ? "inner" : null,
                        orientation: duoPosture.orientation,
                      }
                      : null,
                  }
                : undefined}
              onDuoStance={(stance) => {
                setDuoState((current) => reduceAppleDuoState(current, { type: "stance", stance }));
                sendDuoPosture({ pose: stance });
              }}
              onDuoAngle={(angle) =>
                setDuoState((current) => reduceAppleDuoState(current, { type: "angle", angle }))}
              onDuoAngleCommit={(angle) => sendDuoPosture({ angle })}
              onDuoAppStoreShots={() => {
                showToast({ id: "apple-duo-app-store", tone: "info", title: "Taking App Store screenshots…", message: "Folding the Duo closed, then open." });
                void window.ade.iosSimulator
                  .duoAppStoreScreenshots({ laneId, chatSessionId: sessionId }, runtimePinRef.current)
                  .then((result) => showToast({
                    id: "apple-duo-app-store",
                    tone: "success",
                    title: "App Store screenshots filed to the proof drawer",
                    message: result.shots.map((shot) => `${shot.display} ${shot.width}×${shot.height}`).join(" · "),
                  }))
                  .catch((cause: unknown) => setError(cause));
              }}
              onDuoNudge={(delta) => {
                const next = clampAppleDuoAngle(duoState.pose.angle + delta);
                setDuoState((current) => reduceAppleDuoState(current, { type: "nudge", delta }));
                sendDuoPosture({ angle: next });
              }}
              orientation={orientation}
              orientationPending={rotating}
              onOrientation={rotateTo}
              onScreenshot={screenshot}
              onRender={canUse3d ? openRender : undefined}
              rendering={rendering}
              onToggleTools={() => setToolsOpen((open) => !open)}
              onToggleInspect={toggleInspect}
              onMode={setMode}
              onResetView={() => setViewNonce((nonce) => nonce + 1)}
              onToggleRecording={() => (recordingActive ? recordings.stop() : recordings.start())}
              onFloat={float}
              onSwitchDevice={() => setConfirmSwitch(true)}
              onPowerOff={powerOff}
              /* A4: the preview toggle (and Maximize, where the pane provides
                 one) live in the TOOL's own rail, never in the tools tab
                 strip. Shared with every other screen tool. */
              extraControls={<WorkToolPreviewControls tool="ios" chatSessionId={sessionId} />}
            />
          ) : null}

          {confirmSwitch ? (
            <div className="absolute inset-x-0 bottom-0 z-20 flex min-w-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-2 font-sans text-xs text-fg">
              <span className="min-w-0 flex-1">Give up this device and pick another?</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmSwitch(false)}>
                Keep it
              </Button>
              <Button variant="danger" size="sm" onClick={switchDevice}>
                Switch device
              </Button>
            </div>
          ) : null}

          <AppleRecordingSavedRow
            recording={recordings.lastSaved}
            onDismiss={recordings.dismissLastSaved}
            onOpen={recordings.openProof}
          />

          {recordingActive && appleRailVisible(state) ? (
            <RecordingPill
              marker={{ "data-apple-recording-pill": "" }}
              elapsedMs={recordingElapsedMs(recordingActive, nowTick)}
              onStop={() => recordings.stop()}
            />
          ) : null}

        </div>

        {toolsOpen && laneDevice ? (
          <div
            data-apple-drawer=""
            className={cn(
              /* Narrow: an opaque overlay that still leaves the rail
                 reachable. Wide: docked beside the picture. The @700px
                 threshold is what guarantees §B4's floor — 700 − 288 = 412px
                 of viewport, twice the 200px the spec refuses to go under. */
              "absolute inset-y-0 right-0 z-20 w-[min(18rem,calc(100%-3.5rem))] shadow-lg",
              "@[700px]:static @[700px]:w-72 @[700px]:shrink-0 @[700px]:shadow-none",
            )}
          >
            <Suspense fallback={null}>
              <AppleToolsDrawer
                pin={runtimePin}
                laneId={laneId ?? ""}
                chatSessionId={sessionId}
                device={laneDevice}
                visible={toolsOpen && !hidden}
                onClose={() => setToolsOpen(false)}
                onPreviewRendered={setPreview}
                /* Record is a RAIL control now (§A5), so the drawer's Capture
                   card has no other way to know a recording just started or
                   stopped. The id changes once per transition; its effect is
                   what replaces a poll for the recordings this pane makes. */
                activeRecordingId={recordingActive?.id ?? null}
                onOpenProof={recordings.openProofArtifact}
              />
            </Suspense>
          </div>
        ) : null}
      </div>
      {renderOpen ? (
        <AppleRenderSheet
          open
          deviceName={deviceName}
          duo={duoCapable}
          rendering={rendering}
          onClose={() => setRenderOpen(false)}
          onRender={(request) => void runRender(request)}
        />
      ) : null}
    </div>
  );
}

function PaneMessage({ title, description }: { title: string; description: string | null }) {
  return (
    <div
      data-apple-pane-message=""
      className="ade-tool-picker-static flex size-full items-center justify-center px-6 py-10"
    >
      <div className="ade-tool-card flex w-full min-w-0 max-w-sm flex-col items-center gap-2 p-6 text-center">
        <AppleLogo size={28} aria-hidden="true" className="text-muted-fg/60" />
        <p className="min-w-0 break-words font-sans text-sm font-medium leading-5 text-fg">{title}</p>
        {description ? (
          <p className="min-w-0 break-words font-sans text-xs leading-5 text-muted-fg">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

export { describeAppleError };
