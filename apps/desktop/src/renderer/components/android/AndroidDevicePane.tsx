import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsInSimple, ArrowsOutSimple } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type {
  AndroidDeviceInventory,
  AndroidEmulatorStatus,
  AndroidHardwareKey,
  AndroidLaneDeviceStatus,
  AndroidOrientation,
} from "../../../shared/types/androidEmulator";
import { useAppStore } from "../../state/appStore";
import { effectiveRuntimeBinding } from "../../lib/chatMachineRouting";
import { isInParkedSurface } from "../../lib/parkedSurface";
import { cn } from "../ui/cn";
import { Banner, type NoticeAction } from "../ui/notice";
import { showToast } from "../app/toast/toastStore";
import { WorkToolChromeButton } from "../terminals/workToolChrome";
import { useWorkToolsMaximize } from "../terminals/workToolsMaximize";
import { WORK_TOOL_MAXIMIZE_PANE_LABEL, WORK_TOOL_RESTORE_PANE_LABEL } from "../terminals/workToolPreviewControls";
import {
  androidAvdSpecLine,
  androidDevicePixelSize,
  androidInputAllowed,
  androidLaneDeviceName,
  androidRailVisible,
  describeAndroidError,
  resolveAndroidPaneState,
  type AndroidErrorDescription,
} from "./androidDeviceState";
import { androidStreamLeaseKey, androidStreamLeases } from "./androidStreamLease";
import { AndroidDevicePicker } from "./AndroidDevicePicker";
import { AndroidDeviceRail } from "./AndroidDeviceRail";
import { DEVICE_RAIL_WIDTH } from "../device/DeviceRail";
import { DeviceErrorStrip } from "../device/DeviceStatusStrip";
import { AndroidDeviceStage } from "./AndroidDeviceStage";
import { AndroidSetupCard } from "./AndroidSetupCard";
import {
  AndroidDeviceLoadingCard,
  AndroidDeviceNoticeStrip,
  AndroidLiveLine,
  AndroidPaneMessage,
} from "./AndroidDeviceStatus";
import { useAndroidDeviceInput } from "./useAndroidDeviceInput";
import { useAndroidDeviceStream } from "./useAndroidDeviceStream";

/**
 * The Android emulator, as the body of the Work tools pane's Android tab.
 *
 * The Apple pane's layout, so moving between the two is easy: an optional
 * one-line strip at the top, and a body that is the setup card, the picker,
 * the loading card or the device, with the rail floating on the right of the
 * picture. P0 is flat only and has no tools drawer.
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
  /** The lane host's OS when known, for the setup card's default folder. */
  hostPlatform: string | null;
  /**
   * Set for a lane this pane must not change, such as a chat's work copy on
   * another machine, where the agent picks the device. The picker is never
   * offered, and this line takes its place when the lane holds no device.
   */
  noPicker?: string | null;
  className?: string;
};

/** Events in a burst (a boot sends several) become one status read. */
const EVENT_READ_DELAY_MS = 150;
/** Input failures this close together are one burst, so one notice (the toast's own 6 s). */
const INPUT_FAILED_NOTICE_GAP_MS = 6_000;

type PendingStart = { kind: "create" } | { kind: "attach"; avdName: string } | { kind: "start" };

export function AndroidDevicePane({
  laneId,
  laneName,
  runtimePin,
  machineName,
  hostPlatform,
  noPicker = null,
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
  useEffect(() => {
    if (!api?.onEvent) return undefined;
    let timer: number | null = null;
    let inventoryDirty = false;
    const unsubscribe = api.onEvent((event) => {
      if (event.type === "android.stream.state") return; // the stream hook's
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

  // A failed tap, key or swipe is an event, so a toast, and one per burst: a
  // stalled link fails every queued input, and one notice says it. The stable
  // id replaces the card in place; the gap keeps a long burst from re-raising it.
  const inputFailedAtRef = useRef(0);
  const onInputError = useCallback((caught: unknown) => {
    const now = Date.now();
    if (now - inputFailedAtRef.current < INPUT_FAILED_NOTICE_GAP_MS) return;
    inputFailedAtRef.current = now;
    showToast({
      id: "android-input-failed",
      tone: "warning",
      title: "Input didn't reach the device",
      message: describeAndroidError(caught).sentence,
    });
  }, []);
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

  const create = useCallback((profileId: string) => {
    if (!api) return;
    void runStart({ kind: "create" }, async () => {
      await releaseCurrent();
      return api.createDevice({ laneId, profileId, start: true }, runtimePinRef.current);
    });
  }, [api, laneId, releaseCurrent, runStart]);

  const start = useCallback(() => {
    if (!api) return;
    void runStart({ kind: "start" }, () => api.start({ laneId }, runtimePinRef.current));
  }, [api, laneId, runStart]);

  const powerOff = useCallback(() => {
    if (!api) return;
    forgetStream();
    void api.stop({ laneId }, runtimePinRef.current)
      .then(applyLane)
      .catch((caught: unknown) => setError(describeAndroidError(caught)))
      .finally(() => void readStatus());
  }, [api, applyLane, forgetStream, laneId, readStatus]);

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

  const deleteAvd = useCallback((name: string) => {
    if (!api) return;
    void api.deleteDevice({ avdName: name }, runtimePinRef.current)
      .then((result) => {
        if (result.deleted) showToast({ id: "android-avd-delete", tone: "success", title: `Deleted ${name}` });
      })
      .catch((caught: unknown) => setError(describeAndroidError(caught)))
      .finally(() => void readInventory());
  }, [api, readInventory]);

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
  const maximize = useWorkToolsMaximize();
  const accel = status?.sdk.acceleration ?? null;

  const strip = (() => {
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

  function renderBody() {
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
          <AndroidSetupCard sdk={status.sdk} hostPlatform={hostPlatform} refreshing={refreshing} onRefresh={refreshAll} />
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
            onCreate={create}
            onRelease={release}
            onDelete={deleteAvd}
            onRefresh={refreshAll}
            playing={!hidden}
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
        const booting = pending != null || laneState !== "booted";
        if (booting) {
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
            interactive={androidInputAllowed(paneState)}
            onDeviceInput={input.send}
            onDeviceScroll={input.scroll}
            onDeviceKey={input.key}
            onReaderStatus={stream.handleReaderStatus}
            onDimensions={stream.handleDimensions}
            onFrame={stream.noteFrame}
            // The screen moves left only when the rail would cover its right
            // edge and take its taps, as on the Apple stage.
            railInset={androidRailVisible(paneState) ? DEVICE_RAIL_WIDTH : 0}
            className={cn("bg-transparent", paneState === "video-lost" && "opacity-40")}
          >
            {paneState === "starting" ? (
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
                extraControls={maximize ? (
                  <WorkToolChromeButton
                    label={maximize.maximized ? WORK_TOOL_RESTORE_PANE_LABEL : WORK_TOOL_MAXIMIZE_PANE_LABEL}
                    onClick={() => maximize.setMaximized(!maximize.maximized)}
                    active={maximize.maximized}
                    testId="work-tool-maximize"
                  >
                    {maximize.maximized ? <ArrowsInSimple size={16} /> : <ArrowsOutSimple size={16} />}
                  </WorkToolChromeButton>
                ) : null}
              />
              <AndroidLiveLine
                state={paneState !== "live" ? "lost" : stream.reconnecting ? "reconnecting" : "live"}
                fps={stream.fps}
                laneName={laneName}
                machineName={machineName}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
