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
  AppleDeviceDiskUsage,
  AppleDeviceOrientation,
  AppleDeviceStartArgs,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleSimulatorOwner,
  IosElementContextItem,
  IosSimulatorStatus,
  OpenProjectBinding,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { AppleDeviceStage, isWebCodecsAvailable } from "./AppleDeviceStage";
import type { AppleDevice3DFailure } from "./AppleDevice3DView";
import { AppleInspectOverlay } from "./AppleInspectOverlay";
import { AppleDeviceLoadingCard, type AppleLoadingStage } from "./AppleDeviceLoadingCard";
import { AppleDevicePicker } from "./AppleDevicePicker";
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
  appleCommandForElement,
  appleElementContextItem,
  appleInputAllowed,
  appleObservedOrientationFamily,
  appleOrientationFamily,
  appleRailVisible,
  readAppleViewMode,
  resolveAppleDeviceState,
  writeAppleViewMode,
  type AppleDeviceState,
  type AppleViewMode,
} from "./appleDeviceState";
import { inspectContextFor, type IosSimulatorSnapshotElement } from "./appleInspectGeometry";
import { formatRecordingElapsed, recordingElapsedMs, useAppleRecordings } from "./appleRecording";
import { useAppleDeviceInput } from "./useAppleDeviceInput";
import { AppleRecordingSavedRow } from "./AppleRecordingSavedRow";
import { isAppleDeviceOffError } from "./appleErrors";
import { useAppleDeviceStream } from "./useAppleDeviceStream";
import { openAppleMiniPlayer } from "./appleMiniPlayerStore";
import type { AppleRenderedPreview } from "./drawer/sections/PreviewLabSection";

/**
 * The Apple device, as the body of the Work tools pane's Apple tab.
 *
 * There is no header bar, no Device/Preview Lab toggle, no sibling column and
 * no modal. Top to bottom the pane is: an optional one-line strip, and a body
 * that is either the picker, the loading card, the device, or a rendered
 * preview — with the rail floating on the right of the picture and the tools
 * drawer overlaying it (or docked beside it at ≥700px).
 */

const STATUS_POLL_MS = 6_000;

/**
 * How often a loading card that has not moved re-reads the truth.
 *
 * The card used to wait on exactly one thing — the `deviceStart` promise, or
 * the stream hook — and when that answer never came it sat on "Booting
 * device" until the pane was remounted, over a device that was already
 * streaming. A re-read every few seconds is what makes that impossible.
 */
export const APPLE_LOADING_RECHECK_MS = 8_000;
/**
 * Past this a start has failed whatever its promise says: `bootstatus` gives
 * up at 90s and the helper's capture at 30s. The card turns into the "taking
 * too long" sentence with Start, instead of spinning.
 */
export const APPLE_START_GIVE_UP_MS = 150_000;

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

  const [status, setStatus] = useState<IosSimulatorStatus | null>(null);
  const [installed, setInstalled] = useState<AppleInstalledSimulator[]>([]);
  const [laneDevice, setLaneDevice] = useState<AppleLaneDevice | null>(null);
  /**
   * Who owns the OTHER installed simulators (round 5's picker).
   *
   * The picker cannot tell a free device from one lane B is mid-test in
   * without this, which is how it came to offer Open on a device it should
   * not have — and how an agent came to ask a human for permission instead of
   * creating its own.
   */
  const [owners, setOwners] = useState<AppleSimulatorOwner[]>([]);
  /** Measured by a SECOND `deviceList`, after the list has painted. */
  const [disk, setDisk] = useState<AppleDeviceDiskUsage | null>(null);
  const [measuringDisk, setMeasuringDisk] = useState(false);
  const [listNonce, setListNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const pendingStartRef = useRef<string | null>(null);
  pendingStartRef.current = pendingStart;
  /** Which `start` call is current, so an older one settling late changes nothing. */
  const startTokenRef = useRef(0);
  /**
   * A device the service just told us is off (`APPLE_DEVICE_OFF`).
   *
   * Wins over every "booted" reading until something says it is on again: a
   * start, a boot event, or a fresh `simctl` read. Without it a status read
   * that still said Booted would ask for the stream again and again.
   */
  const [offUdid, setOffUdid] = useState<string | null>(null);
  const [loadingStage, setLoadingStage] = useState<AppleLoadingStage>("starting");
  const [startError, setStartError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);

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
  const [rotating, setRotating] = useState(false);
  const [inspectOn, setInspectOn] = useState(false);
  const [inspectElements, setInspectElements] = useState<IosSimulatorSnapshotElement[]>([]);
  const [inspectHovered, setInspectHovered] = useState<string | null>(null);
  const [inspectSelected, setInspectSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<AppleRenderedPreview | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [bodyWidth, setBodyWidth] = useState(720);
  const [hidden, setHidden] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const refreshList = useCallback(() => setListNonce((nonce) => nonce + 1), []);

  /** Patch one device's power in the listed state, ahead of the re-read that confirms it. */
  const markInstalledState = useCallback((udid: string, next: "Booted" | "Shutdown") => {
    setInstalled((current) => (
      current.some((entry) => entry.udid === udid && entry.state !== next)
        ? current.map((entry) => (entry.udid === udid ? { ...entry, state: next } : entry))
        : current
    ));
  }, []);

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
        offScreen = !entry.isIntersecting;
        apply();
      });
      observer.observe(node);
    }
    apply();
    return () => {
      observer?.disconnect();
    };
  }, []);

  /* ── status + devices ──────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const next = await window.ade.iosSimulator.getStatus(runtimePinRef.current);
        if (!cancelled) setStatus(next);
      } catch (cause: unknown) {
        if (!cancelled) setError(cause);
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
  }, [hidden, listNonce]);

  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    void window.ade.iosSimulator
      .deviceList({ laneId, chatSessionId: sessionId, installed: true }, runtimePinRef.current)
      .then((next) => {
        if (cancelled) return;
        setInstalled(next.installed);
        setLaneDevice(next.lane);
        const laneUdid = next.lane?.udid ?? null;
        if (laneUdid && next.installed.find((entry) => entry.udid === laneUdid)?.state === "Booted") {
          setOffUdid((current) => (current === laneUdid ? null : current));
        }
        setOwners(next.owners ?? []);
        /*
         * Disk is the picker's line and nothing else's, and the picker is on
         * screen exactly when this lane owns no device. So it is asked for in
         * a second, `installed: false` call that only measures — the first
         * call must not wait behind a `du` over a 20 GB device store, which
         * on this owner's machine is the difference between a list that
         * paints and a list that hangs.
         */
        if (next.lane || next.installed.length === 0) return;
        setMeasuringDisk(true);
        void window.ade.iosSimulator
          .deviceList(
            { laneId, chatSessionId: sessionId, installed: false, disk: true },
            runtimePinRef.current,
          )
          .then((measured) => {
            if (!cancelled) setDisk(measured.disk ?? null);
          })
          // A measurement that fails costs the line its number, never the page.
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) setMeasuringDisk(false);
          });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, listNonce, sessionId]);

  const deviceUdid = laneDevice?.udid ?? null;
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
      if (udid) setOffUdid(udid);
      refreshList();
      return;
    }
    setError(new Error(message));
  }, [refreshList]);

  const statusSaysBooted = status?.activeDevice?.udid === deviceUdid && status?.activeDevice?.state === "Booted";
  // A status read of this device as Booted is fresh `simctl` truth too.
  useEffect(() => {
    if (offUdid && statusSaysBooted && deviceUdid === offUdid) setOffUdid(null);
  }, [deviceUdid, offUdid, statusSaysBooted]);

  /*
   * `simctl` is the truth about power. An open device session is not: it
   * outlives a power-off, and reading it as "booted" is what asked for a
   * stream on a device that was off. It still counts before the installed
   * list has loaded.
   */
  const booted = deviceUdid !== null && deviceUdid === offUdid
    ? false
    : Boolean(
      installedForLane
        ? installedForLane.state === "Booted" || statusSaysBooted
        : statusSaysBooted || (deviceUdid && status?.deviceSession?.deviceUdid === deviceUdid),
    );

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

  /* ── a loading card that cannot hang ───────────────────────────────────── */

  /*
   * While the card is up, re-read the truth every few seconds: the device
   * list and status (which land an off device on the Off card and a running
   * one on the stream), and for a start in flight, whether the lane is
   * already streaming — in which case the start is done, whatever its promise
   * is doing. A start still going past `APPLE_START_GIVE_UP_MS` is given up
   * with the "taking too long" sentence and Start.
   */
  const loading = state === "starting";
  const streamReconnectRef = useRef(stream.reconnect);
  streamReconnectRef.current = stream.reconnect;
  useEffect(() => {
    if (!loading) return undefined;
    const since = Date.now();
    const timer = window.setInterval(() => {
      const pending = pendingStartRef.current;
      refreshList();
      if (!pending) {
        // "Connecting video" with no start in flight: the device is up and
        // only this viewer's stream is missing. Ask for it again — the
        // service joins a capture another viewer (the floating player, a
        // phone) is running, or opens one.
        streamReconnectRef.current();
        return;
      }
      const token = startTokenRef.current;
      const settle = () => {
        if (startTokenRef.current !== token) return;
        startTokenRef.current += 1;
        setPendingStart(null);
      };
      if (Date.now() - since >= APPLE_START_GIVE_UP_MS) {
        settle();
        setError(new Error(
          `Simulator did not become ready within ${Math.round(APPLE_START_GIVE_UP_MS / 1000)}s. CoreSimulator may be stuck.`,
        ));
        return;
      }
      void window.ade.iosSimulator.getStreamStatus?.(runtimePinRef.current, { laneId, chatSessionId: sessionId })
        .then((next) => {
          if (next?.running) settle();
        })
        .catch(() => undefined);
    }, APPLE_LOADING_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [laneId, loading, refreshList, sessionId]);

  /* ── service events ────────────────────────────────────────────────────── */

  const applyStreamEventRef = useRef(stream.applyStreamEvent);
  applyStreamEventRef.current = stream.applyStreamEvent;

  useEffect(() => {
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
      switch (event.type) {
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
          if (event.phase === "stopped") {
            // Powered off (the tab close, the CLI, another window): show the
            // Off card now rather than after the next read.
            markInstalledState(event.udid, "Shutdown");
            refreshList();
            return;
          }
          if (event.phase === "booted" || event.phase === "streaming") {
            markInstalledState(event.udid, "Booted");
            setOffUdid((current) => (current === event.udid ? null : current));
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
            startTokenRef.current += 1;
            setPendingStart(null);
            refreshList();
          }
          return;
        }
        case "stream-started":
          if (event.status.deviceUdid) {
            const udid = event.status.deviceUdid;
            setOffUdid((current) => (current === udid ? null : current));
          }
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
  }, [laneId, markInstalledState, refreshList]);

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

  const toggleInspect = useCallback(() => {
    setInspectOn((on) => !on);
    setInspectSelected(null);
    setInspectHovered(null);
  }, []);

  /**
   * One snapshot per switch-on. The frames describe the screen as it was when
   * Inspect was turned on; driving the device is off while it is on, so they
   * cannot go stale underneath the pointer.
   */
  useEffect(() => {
    if (!inspectOn || !deviceUdid || state !== "live") {
      if (!inspectOn) setInspectElements([]);
      return undefined;
    }
    let cancelled = false;
    void window.ade.iosSimulator
      .getScreenSnapshot({ deviceUdid, laneId, projectRoot }, runtimePinRef.current)
      .then((snapshot) => {
        if (cancelled) return;
        const elements = snapshot.elements ?? [];
        setInspectElements(elements);
        /*
         * Free truth. The snapshot describes the interface as it really is, so
         * an orientation the pane has wrong — a device someone rotated before
         * this pane opened, or a rotate the device quietly ignored — is
         * corrected here at no extra cost. Only the SHAPE is corrected: the
         * tree cannot tell landscape-left from landscape-right.
         */
        const observed = appleObservedOrientationFamily(elements);
        if (observed) {
          setOrientation((current) => (
            appleOrientationFamily(current) === observed
              ? current
              : observed === "landscape" ? "landscape-left" : "portrait"
          ));
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceUdid, inspectOn, laneId, projectRoot, state]);

  // Escape closes the card wherever the focus happens to be (§A4).
  useEffect(() => {
    if (!inspectSelected) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInspectSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspectSelected]);

  const insertInspectElement = useMemo(() => {
    if (!onAddContext && !onInsertDraft) return undefined;
    return (element: IosSimulatorSnapshotElement) => {
      try {
        if (onAddContext) onAddContext(appleElementContextItem(element));
        else onInsertDraft?.(inspectContextFor(element, inspectElements));
      } catch (cause: unknown) {
        // `workToolContextInsertion` throws with the reason when there is no
        // chat, draft or CLI session to insert into. Say it, never swallow it.
        setError(cause);
      }
    };
  }, [inspectElements, onAddContext, onInsertDraft]);

  const copyInspectElement = useCallback((element: IosSimulatorSnapshotElement) => {
    void window.ade.app.writeClipboardText(appleCommandForElement(element)).catch(() => {});
  }, []);

  const renderInspectOverlay = useCallback((
    deviceToView: ((point: { x: number; y: number }) => { x: number; y: number }) | null,
  ) => {
    if (!inspectOn) return null;
    return (
      <AppleInspectOverlay
        elements={inspectElements}
        deviceToView={deviceToView}
        hoveredRef={inspectHovered}
        selectedRef={inspectSelected}
        onHover={setInspectHovered}
        onSelect={setInspectSelected}
        onInsertIntoChat={insertInspectElement}
        onCopy={copyInspectElement}
      />
    );
  }, [
    copyInspectElement,
    insertInspectElement,
    inspectElements,
    inspectHovered,
    inspectOn,
    inspectSelected,
  ]);

  /* ── actions ───────────────────────────────────────────────────────────── */

  const start = useCallback((args: AppleDeviceStartArgs, key: string) => {
    const token = startTokenRef.current + 1;
    startTokenRef.current = token;
    setStartError(null);
    setError(null);
    setOffUdid(null);
    setLoadingStage("starting");
    setPendingStart(key);
    // Only the current start may settle the card. One that the `streaming`
    // event, the give-up timer or a newer start already replaced changes
    // nothing when its promise finally lands.
    const current = () => startTokenRef.current === token;
    void window.ade.iosSimulator.deviceStart(args, runtimePinRef.current)
      .then(() => {
        refreshList();
      })
      .catch((cause: unknown) => {
        if (current()) setStartError(cause);
      })
      .finally(() => {
        if (current()) setPendingStart(null);
      });
  }, [refreshList]);

  const startInstalled = useCallback((udid: string) => {
    start({ laneId, chatSessionId: sessionId, udid }, udid);
  }, [laneId, sessionId, start]);

  const createDevice = useCallback((sourceUdid: string) => {
    start({ laneId, chatSessionId: sessionId, create: { sourceUdid } }, "create");
  }, [laneId, sessionId, start]);

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
   * `deviceStop`, the verb that runs `simctl shutdown`. This used to be
   * `closeDevice`, which only powers off a device the hub opened a session
   * for — and the pane's own starts never open one, so Power off did nothing
   * to a device the pane had started. `deviceStop` also announces `stopped`,
   * which is what moves this pane and the tools card to "Off" at once.
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
   * picker. It is the ONLY way back, which is why `APPLE_DEVICE_EXISTS` can
   * never reach a person: nothing else ever asks for a second one.
   */
  const switchDevice = useCallback(() => {
    setConfirmSwitch(false);
    void window.ade.iosSimulator
      .deviceDelete({ laneId, chatSessionId: sessionId, force: true }, runtimePinRef.current)
      .then(() => {
        setLaneDevice(null);
        refreshList();
      })
      .catch((cause: unknown) => setError(cause));
  }, [laneId, refreshList, sessionId]);

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
   * lane device's NAME is whatever ADE or a person called the clone.
   */
  const deviceTypeIdentifier = laneDevice
    ? installed.find((entry) => entry.udid === laneDevice.udid)?.deviceTypeIdentifier ?? null
    : null;
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
        return (
          <AppleDevicePicker
            installed={installed}
            owners={owners}
            laneDevice={laneDevice}
            disk={disk}
            measuringDisk={measuringDisk}
            pending={pendingStart}
            lastUsedUdid={laneDevice?.templateUdid ?? null}
            refreshing={refreshing}
            onStart={startInstalled}
            onCreate={createDevice}
            onDelete={deleteInstalled}
            onRefresh={refreshList}
            playing={!hidden}
          />
        );
      case "starting":
        return (
          <AppleDeviceLoadingCard
            name={pendingStart === "create" ? "New simulator" : startingName()}
            runtime={startingRuntime()}
            model={startingIdentity().model}
            family={startingIdentity().family}
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
              orientation={orientation}
              devicePointSize={stream.devicePointSize}
              interactive={appleInputAllowed(state)}
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

  function startingName(): string {
    if (laneDevice) return laneDevice.name;
    const match = installed.find((entry) => entry.udid === pendingStart);
    return match?.name ?? "Simulator";
  }

  function startingRuntime(): string | null {
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
    const record = installed.find(
      (entry) => entry.udid === (laneDevice?.udid ?? pendingStart),
    );
    if (!record) return { family: familyOf(laneDevice), model: null };
    const identity = appleDeviceIdentity(record);
    return { family: identity.family, model: identity.renamed ? identity.model : null };
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
            /* No second confirm here. The device is already off, the person
               already confirmed the shut down, and this button says what it
               does; asking again was the owner's "double confirmation"
               (2026-09-23). The rail's "Switch device…" on a RUNNING device
               keeps its confirm. */
            secondaryActionLabel="Choose another device"
            onSecondaryAction={switchDevice}
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
              orientation={orientation}
              orientationPending={rotating}
              onOrientation={rotateTo}
              onScreenshot={screenshot}
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
            <div
              data-apple-recording-pill=""
              className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 font-sans text-xs text-fg shadow-sm"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-error)] motion-safe:animate-pulse" />
              <span className="tabular-nums">
                Recording {formatRecordingElapsed(recordingElapsedMs(recordingActive, nowTick))}
              </span>
              <Button variant="ghost" size="sm" className="h-5 px-1.5" onClick={() => recordings.stop()}>
                Stop
              </Button>
            </div>
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
