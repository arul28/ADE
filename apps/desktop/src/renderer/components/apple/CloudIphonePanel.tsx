import { useEffect, useRef, useState, type ReactNode, useCallback } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  CLOUD_PHONE_DEVICE_TYPE_NAME,
  CLOUD_PHONE_POINT_SIZE,
  type CloudPhoneStatusView,
  type CloudPhoneViewLink,
} from "../../../shared/cloudPhone";
import { ipcErrorMessage } from "../../lib/format";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { showToast } from "../app/toast/toastStore";
import { DEVICE_RAIL_WIDTH } from "../device/DeviceRail";
import { RecordingPill } from "../shared/RecordingReceipt";
import { WorkToolPreviewControls } from "../terminals/workToolPreviewControls";
import { Button } from "../ui/Button";
import { AppleDeviceLoadingCard } from "./AppleDeviceLoadingCard";
import { PaneMessage } from "./AppleDevicePane";
import { AppleDeviceRail } from "./AppleDeviceRail";
import { AppleDeviceStage } from "./AppleDeviceStage";
import { AppleDeviceNoticeStrip, AppleDeviceStatusStrip } from "./AppleDeviceStatusStrip";
import { readAppleViewMode, writeAppleViewMode, type AppleViewMode } from "./appleDeviceState";
import { useCloudPhoneFrames } from "./useCloudPhoneFrames";

/*
 * The ADE Cloud iPhone in the tools pane (`ios@cloud`).
 *
 * The phone runs at NoMac; the chat's brain starts it and reads it
 * (`cloud_phone`, always on the chat's machine: `pin`). This panel shows it two
 * ways, both from the same picture, in the same pane as a Mac's simulator:
 * the 3D body or the flat screen, with the shared rail and strips. The
 * picture comes from NoMac's control page painted offscreen in the desktop's
 * main process (`useCloudPhoneFrames`). ADE Web has no main process to paint
 * it, so its pane (no rail) shows the link in a flat iframe instead.
 *
 * No timer while the phone runs: the picture is the live state. A slow read
 * (every 20 s while the pane is open and no phone runs) picks up a phone an
 * agent starts, since the brain sends no event for one.
 */

const IDLE_READ_MS = 20_000;
const STARTING_READ_MS = 3_000;

const END_REASONS: Readonly<Record<string, string>> = {
  idle: "It stopped after 5 minutes with nothing to do.",
  time_limit: "It reached its time limit.",
  spend_cap: "It used the minutes this period had left.",
  stopped: "It was stopped.",
  credit: "ADE Cloud could not keep it running.",
  crashed: "It crashed.",
  no_capacity: "No cloud iPhone was free.",
};

function useCloudPhoneStatus(pin: OpenProjectBinding | null, hidden: boolean) {
  const [status, setStatus] = useState<CloudPhoneStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const api = window.ade?.cloudPhone;
    if (!api) {
      setError("This ADE can't reach the ADE Cloud iPhone.");
      return;
    }
    const mine = ++seq.current;
    try {
      const next = await api.status(pinRef.current);
      if (mine !== seq.current) return;
      setStatus(next);
      setError(null);
    } catch (caught) {
      if (mine !== seq.current) return;
      setError(caught instanceof Error ? ipcErrorMessage(caught) : String(caught));
    }
  }, []);
  const pinKey = pin?.key ?? null;
  useEffect(() => { void refresh(); }, [pinKey, refresh]);
  const phoneState = status?.phone?.state ?? null;
  useEffect(() => {
    if (hidden || status?.access !== "on" || phoneState === "ready") return undefined;
    const timer = window.setInterval(() => { void refresh(); }, phoneState === "starting" ? STARTING_READ_MS : IDLE_READ_MS);
    return () => window.clearInterval(timer);
  }, [hidden, phoneState, refresh, status?.access]);
  return { status, error, refresh };
}

/** The view link for the live phone, fetched once per phone and again before it expires. */
function useCloudPhoneLink(pin: OpenProjectBinding | null, phoneId: string | null): { link: CloudPhoneViewLink | null; error: string | null } {
  const [link, setLink] = useState<CloudPhoneViewLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  useEffect(() => {
    setLink(null);
    setError(null);
    if (!phoneId) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const fetchLink = () => {
      void window.ade?.cloudPhone?.view({ control: true }, pinRef.current).then((next) => {
        if (cancelled) return;
        setLink(next);
        // A minute before it expires, a fresh one (the page reconnects by itself).
        timer = window.setTimeout(fetchLink, Math.max(60_000, next.expiresAt - Date.now() - 60_000));
      }, (caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? ipcErrorMessage(caught) : String(caught));
      });
    };
    fetchLink();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phoneId, pinKey]);
  return { link, error };
}

/** The phone models a cloud iPhone can be, for "Switch device". */
const CLOUD_PHONE_MODELS: ReadonlyArray<{ id: "iphone" | "iphone-pro-max" | "ipad"; label: string }> = [
  { id: "iphone", label: "iPhone 17 Pro" },
  { id: "iphone-pro-max", label: "iPhone 17 Pro Max" },
  { id: "ipad", label: "iPad Pro 11-inch" },
];

export function CloudIphonePanel(props: CloudIphonePanelProps) {
  // A bridge this host does not implement is still a callable stand-in on the
  // web, so feature-detect it rather than testing truthiness.
  if (typeof window === "undefined" || !isAdeAvailable(window.ade?.cloudPhone)) {
    return (
      <PaneMessage
        title="ADE Cloud iPhone"
        description="Open this chat in the ADE desktop app to see the phone. The chat's agents use it from here too."
      />
    );
  }
  // ADE Web has the phone's commands but no offscreen view (there is no main
  // process to paint the phone): the link goes in a flat iframe instead.
  return isAdeAvailable(window.ade?.cloudPhoneView)
    ? <CloudIphoneLive {...props} />
    : <CloudIphoneFlat {...props} />;
}

type CloudIphonePanelProps = {
  pin: OpenProjectBinding | null;
  /** The chat this pane serves: captures are filed to it. */
  sessionId: string | null;
  laneId: string | null;
  hidden?: boolean;
};

/**
 * The same pane as a Mac's simulator (`AppleDevicePane`): the notice strip on
 * top, the device on the tools grid's page in 3D or flat, and the rail on the
 * right. The rail shows what a cloud phone can do (Home, Screenshot, Record,
 * View, Reset view, Switch device, Power off); hardware keys, rotation,
 * Inspect, the tools drawer and Float are the local simulator's and are left
 * out rather than shown dead.
 */
function CloudIphoneLive({ pin, sessionId, laneId, hidden = false }: CloudIphonePanelProps) {
  const { status, error: statusError, refresh } = useCloudPhoneStatus(pin, hidden);
  const phone = status?.phone ?? null;
  const ready = phone?.state === "ready";
  const { link, error: linkError } = useCloudPhoneLink(pin, ready ? phone.id : null);
  const device = phone?.device ?? "iphone";
  const family = device === "ipad" ? "ipad" : "iphone";
  const points = CLOUD_PHONE_POINT_SIZE[device] ?? CLOUD_PHONE_POINT_SIZE.iphone!;
  const deviceName = CLOUD_PHONE_DEVICE_TYPE_NAME[device] ?? "iPhone 17 Pro";
  const frames = useCloudPhoneFrames({ url: link?.url ?? null, family, pointSize: points, hidden });

  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [mode, setModeState] = useState<AppleViewMode>(() => readAppleViewMode(null));
  const [canUse3d, setCanUse3d] = useState(true);
  const [threeDisabledReason, setThreeDisabledReason] = useState<string | null>(null);
  const [viewNonce, setViewNonce] = useState(0);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [bodyWidth, setBodyWidth] = useState(720);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;

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

  // The phone ended under the view (idle, its limit, the plan's minutes): read why, at once.
  const frameState = frames.state;
  useEffect(() => {
    if (frameState === "ended" || frameState === "error") void refresh();
  }, [frameState, refresh]);

  // The recording pill's clock, only while a recording runs.
  useEffect(() => {
    if (recordingSince == null) return undefined;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [recordingSince]);

  const effectiveMode: AppleViewMode = canUse3d ? mode : "flat";
  const setMode = (next: AppleViewMode) => {
    setModeState(next);
    writeAppleViewMode(null, next);
  };

  const run = async (what: "start" | "stop", device?: string) => {
    const api = window.ade.cloudPhone;
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      if (what === "start") await api.start(device ? { device } : {}, pinRef.current);
      else await api.stop(pinRef.current);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const switchDevice = async (next: string) => {
    setConfirmSwitch(false);
    if (next === device && phone && phone.state !== "ended") return;
    if (phone && phone.state !== "ended") await run("stop");
    await run("start", next);
  };

  const screenshot = () => {
    setScreenshotPending(true);
    void window.ade.cloudPhone.screenshot({ chatSessionId: sessionId, laneId }, pinRef.current)
      .then((result) => showToast({
        id: "cloud-iphone-screenshot",
        tone: "success",
        title: "Screenshot filed to the proof drawer",
        message: result.artifactId ? `ADE Cloud iPhone · ${deviceName}` : "Saved, but this project has no proof drawer here.",
      }))
      .catch((caught: unknown) => setError(caught))
      .finally(() => setScreenshotPending(false));
  };

  const toggleRecording = () => {
    const action = recordingSince == null ? "start" : "stop";
    if (action === "start") {
      setRecordingSince(Date.now());
      setNowTick(Date.now());
    } else {
      setRecordingSince(null);
    }
    void window.ade.cloudPhone.record({ action, chatSessionId: sessionId, laneId }, pinRef.current)
      .then((result) => {
        if (result.failed) {
          if (action === "start") setRecordingSince(null);
          setError(new Error(result.text || "The recording did not start."));
          return;
        }
        if (action === "stop") {
          showToast({
            id: "cloud-iphone-recording",
            tone: "success",
            title: "Recording filed to the proof drawer",
            message: `ADE Cloud iPhone · ${deviceName}`,
          });
        }
      })
      .catch((caught: unknown) => {
        if (action === "start") setRecordingSince(null);
        setError(caught);
      });
  };

  const minutes = status?.minutes ?? null;
  const minutesLine = minutes ? `${minutes.left} of ${minutes.included} min left` : null;
  const off = !phone || phone.state === "ended";
  const live = ready && Boolean(link) && frames.state === "live";

  // One line on top, as the local pane has: a failure, else a fact about the device.
  let strip: ReactNode = null;
  const failure = error ?? (statusError ? new Error(statusError) : null) ?? (linkError ? new Error(linkError) : null)
    ?? (ready && frames.state === "error" ? new Error(frames.message ?? "The phone's screen could not be shown.") : null);
  if (failure) {
    strip = <AppleDeviceStatusStrip error={failure} onDismiss={() => setError(null)} />;
  } else if (status?.access === "on" && off) {
    const why = phone?.endReason ? ` ${END_REASONS[phone.endReason] ?? `It ended (${phone.endReason}).`}` : "";
    strip = minutes && minutes.left <= 0
      ? <AppleDeviceNoticeStrip sentence={`This period's ${minutes.included} ADE Cloud iPhone minutes are used up.${why}`} actionLabel="Refresh" onAction={() => void refresh()} />
      : (
        <AppleDeviceNoticeStrip
          sentence={`The ADE Cloud iPhone is off.${why}`}
          actionLabel={busy === "start" ? "Starting" : "Start"}
          busy={busy === "start"}
          onAction={() => void run("start")}
        />
      );
  } else if (phone?.stopNotice) {
    strip = <AppleDeviceNoticeStrip sentence={phone.stopNotice} actionLabel="Stop" onAction={() => void run("stop")} />;
  }

  let viewport: ReactNode;
  if (!status) {
    viewport = <PaneMessage title="ADE Cloud iPhone" description="Reading this account's cloud iPhone…" />;
  } else if (status.access !== "on") {
    viewport = <PaneMessage title="ADE Cloud iPhone is coming soon" description={status.reason} />;
  } else if (off) {
    viewport = (
      <PaneMessage
        title="ADE Cloud iPhone"
        description={`${minutesLine ? `${minutesLine} this period. ` : ""}Agents start it with ade apple launch, which builds this lane's app on it.`}
      />
    );
  } else if (!live) {
    viewport = (
      <AppleDeviceLoadingCard
        name={deviceName}
        runtime="iOS 27 · ADE Cloud"
        isNew
        family={family}
        stage={ready ? "streaming" : "starting"}
        onRetry={() => void run("start")}
      />
    );
  } else {
    viewport = (
      <AppleDeviceStage
        streamUrl={null}
        streamToken={null}
        screenSource={{ canvas: frames.canvas, pixelSize: frames.pixelSize }}
        reconnectNonce={0}
        mode={effectiveMode}
        viewNonce={viewNonce}
        family={family}
        deviceTypeName={deviceName}
        orientation="portrait"
        devicePointSize={points}
        interactive
        onDeviceInput={({ phase, x, y }) => frames.input(phase, x, y)}
        onDeviceScroll={({ x, y, deltaX, deltaY }) => frames.scroll(x, y, deltaX, deltaY)}
        onDeviceKey={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return false;
          frames.key(event.key);
          return true;
        }}
        onReaderStatus={() => undefined}
        onDimensions={() => undefined}
        onFrame={() => undefined}
        frames={frames.canvas ? frames.frames : null}
        onThreeUnavailable={(reason) => {
          setCanUse3d(false);
          setThreeDisabledReason(reason);
        }}
        railInset={DEVICE_RAIL_WIDTH}
        className="bg-transparent"
      />
    );
  }

  return (
    <div
      data-apple-pane=""
      data-testid="cloud-iphone-panel"
      data-apple-device-state={live ? "live" : off ? "off" : "starting"}
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-surface"
    >
      {strip}
      <div ref={bodyRef} className="@container relative flex min-h-0 min-w-0 flex-1">
        <div className="ade-tool-picker-static relative flex min-h-0 min-w-0 flex-1 flex-col">
          {viewport}

          {live ? (
            <AppleDeviceRail
              containerWidth={bodyWidth}
              deviceName={deviceName}
              deviceRuntime={`iOS 27 · ADE Cloud${minutesLine ? ` · ${minutesLine}` : ""}`}
              inputConnected={live}
              mode={effectiveMode}
              canUse3d={canUse3d}
              threeDisabledReason={threeDisabledReason}
              toolsOpen={false}
              inspecting={false}
              recording={recordingSince != null}
              screenshotPending={screenshotPending}
              orientation="portrait"
              onHome={() => frames.home()}
              onScreenshot={screenshot}
              onMode={setMode}
              onResetView={() => setViewNonce((nonce) => nonce + 1)}
              onToggleRecording={toggleRecording}
              onSwitchDevice={() => setConfirmSwitch(true)}
              onPowerOff={() => void run("stop")}
              extraControls={<WorkToolPreviewControls tool="ios" chatSessionId={sessionId} />}
            />
          ) : null}

          {confirmSwitch ? (
            <div className="absolute inset-x-0 bottom-0 z-20 flex min-w-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-2 font-sans text-xs text-fg">
              <span className="min-w-0 flex-1">Switch the cloud iPhone? Its apps and data go; the project and its build cache stay.</span>
              {CLOUD_PHONE_MODELS.map((model) => (
                <Button
                  key={model.id}
                  variant={model.id === device ? "ghost" : "outline"}
                  size="sm"
                  disabled={model.id === device}
                  onClick={() => void switchDevice(model.id)}
                >
                  {model.label}
                </Button>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setConfirmSwitch(false)}>
                Keep it
              </Button>
            </div>
          ) : null}

          {recordingSince != null && live ? (
            <RecordingPill
              marker={{ "data-apple-recording-pill": "" }}
              elapsedMs={Math.max(0, nowTick - recordingSince)}
              onStop={toggleRecording}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * NoMac's bare phone (no viewer chrome) for an iframe: the view link with
 * `embed=1`, keeping any `#visitor` signature the link carries.
 */
function cloudPhoneEmbedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("embed", "1");
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * ADE Web's pane: the same strip, off state and Start as the desktop, with
 * NoMac's own view in an iframe where the 3D body would be. No rail: Home,
 * Screenshot and Record need the desktop's offscreen view. The phone's screen
 * keeps its aspect and is centred in the tools pane.
 */
function CloudIphoneFlat({ pin, hidden = false }: CloudIphonePanelProps) {
  const { status, error: statusError, refresh } = useCloudPhoneStatus(pin, hidden);
  const phone = status?.phone ?? null;
  const ready = phone?.state === "ready";
  const { link, error: linkError } = useCloudPhoneLink(pin, ready ? phone.id : null);
  const device = phone?.device ?? "iphone";
  const family = device === "ipad" ? "ipad" : "iphone";
  const deviceName = CLOUD_PHONE_DEVICE_TYPE_NAME[device] ?? "iPhone 17 Pro";
  const minutes = status?.minutes ?? null;
  const minutesLine = minutes ? `${minutes.left} of ${minutes.included} min left` : null;
  const off = !phone || phone.state === "ended";
  const live = ready && Boolean(link);

  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [frameBox, setFrameBox] = useState<{ width: number; height: number } | null>(null);
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;

  // Fit the phone's screen inside the pane without cropping it.
  useEffect(() => {
    const node = sizerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setFrameBox({ width: rect.width, height: rect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [live]);

  const run = async (what: "start" | "stop") => {
    const api = window.ade.cloudPhone;
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      if (what === "start") await api.start({}, pinRef.current);
      else await api.stop(pinRef.current);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  // One line on top, as the desktop pane has: a failure, else a fact about the device.
  let strip: ReactNode = null;
  const failure = error ?? (statusError ? new Error(statusError) : null) ?? (linkError ? new Error(linkError) : null);
  if (failure) {
    strip = <AppleDeviceStatusStrip error={failure} onDismiss={() => setError(null)} />;
  } else if (status?.access === "on" && off) {
    const why = phone?.endReason ? ` ${END_REASONS[phone.endReason] ?? `It ended (${phone.endReason}).`}` : "";
    strip = minutes && minutes.left <= 0
      ? <AppleDeviceNoticeStrip sentence={`This period's ${minutes.included} ADE Cloud iPhone minutes are used up.${why}`} actionLabel="Refresh" onAction={() => void refresh()} />
      : (
        <AppleDeviceNoticeStrip
          sentence={`The ADE Cloud iPhone is off.${why}`}
          actionLabel={busy === "start" ? "Starting" : "Start"}
          busy={busy === "start"}
          onAction={() => void run("start")}
        />
      );
  } else if (phone?.stopNotice) {
    strip = <AppleDeviceNoticeStrip sentence={phone.stopNotice} actionLabel="Stop" onAction={() => void run("stop")} />;
  }

  let viewport: ReactNode;
  if (!status) {
    viewport = <PaneMessage title="ADE Cloud iPhone" description="Reading this account's cloud iPhone…" />;
  } else if (status.access !== "on") {
    viewport = <PaneMessage title="ADE Cloud iPhone is coming soon" description={status.reason} />;
  } else if (off) {
    viewport = (
      <PaneMessage
        title="ADE Cloud iPhone"
        description={`${minutesLine ? `${minutesLine} this period. ` : ""}Agents start it with ade apple launch, which builds this lane's app on it.`}
      />
    );
  } else if (!ready || !link) {
    viewport = (
      <AppleDeviceLoadingCard
        name={deviceName}
        runtime="iOS 27 · ADE Cloud"
        isNew
        family={family}
        stage={ready ? "streaming" : "starting"}
        onRetry={() => void run("start")}
      />
    );
  } else {
    const ratio = family === "ipad" ? 834 / 1210 : 402 / 874;
    const width = frameBox ? Math.max(0, Math.min(frameBox.width, frameBox.height * ratio)) : null;
    viewport = (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4">
        <div ref={sizerRef} className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <div
            data-testid="cloud-iphone-flat"
            className="relative overflow-hidden bg-black ring-1 ring-inset ring-fg/[0.06]"
            style={width ? { width, height: width / ratio } : { aspectRatio: `${402} / ${874}`, height: "100%" }}
          >
            <iframe
              src={cloudPhoneEmbedUrl(link.url)}
              title="ADE Cloud iPhone"
              allow="clipboard-read; clipboard-write"
              referrerPolicy="no-referrer"
              className="block h-full w-full border-0 bg-black"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-apple-pane=""
      data-testid="cloud-iphone-panel"
      data-apple-device-state={live ? "live" : off ? "off" : "starting"}
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-surface"
    >
      {strip}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="ade-tool-picker-static relative flex min-h-0 min-w-0 flex-1 flex-col">
          {viewport}
        </div>
      </div>
    </div>
  );
}
