import { useEffect, useRef, useState, type ReactNode, useCallback } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  CLOUD_PHONE_DEVICES,
  CLOUD_PHONE_IDLE_MINUTES,
  CLOUD_PHONE_MODELS,
  cloudPhoneDeviceOf,
  type CloudPhoneDevice,
  type CloudPhoneStatusView,
  type CloudPhoneView,
} from "../../../shared/cloudPhone";
import { ipcErrorMessage } from "../../lib/format";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { usePaneOffScreen } from "../../lib/parkedSurface";
import { showToast } from "../app/toast/toastStore";
import { DEVICE_RAIL_WIDTH } from "../device/DeviceRail";
import { RecordingPill } from "../shared/RecordingReceipt";
import { WorkToolPreviewControls } from "../terminals/workToolPreviewControls";
import { Button } from "../ui/Button";
import { AppleDeviceConfirmBar } from "./AppleDeviceConfirmBar";
import { AppleDeviceLoadingCard } from "./AppleDeviceLoadingCard";
import { PaneMessage } from "./PaneMessage";
import { AppleDeviceRail } from "./AppleDeviceRail";
import { AppleDeviceStage } from "./AppleDeviceStage";
import { AppleDeviceNoticeStrip, AppleDeviceStatusStrip } from "./AppleDeviceStatusStrip";
import { readAppleViewMode, writeAppleViewMode, type AppleViewMode } from "./appleDeviceState";
import { useCloudPhoneFrames } from "./useCloudPhoneFrames";
import {
  cloudPhoneMinutesLeft,
  formatPhoneSpan,
  noteCloudPhoneInput,
  keepCloudPhoneOn,
  readCloudPhoneStatus,
  useCloudPhoneLive,
  useCloudPhoneIdleCountdown,
} from "../../state/cloudPhoneLive";

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
 * While the phone runs the pane reads it every 30 s: the picture says when it
 * ends, but the idle countdown needs the brain's last call (an agent working
 * keeps it on). A slow read (every 20 s while the pane is open and no phone
 * runs, or the last read failed) picks up a phone an agent starts, since the
 * brain sends no event for one. Every read is shared (`cloudPhoneLive`): the
 * top bar shows the same phone.
 */

const IDLE_READ_MS = 20_000;
const STARTING_READ_MS = 3_000;
/** While the phone runs: its end, and the brain's last call for the idle countdown. */
const LIVE_READ_MS = 30_000;
/** A view link that could not be fetched is asked for again after this. */
const LINK_RETRY_MS = 10_000;

const END_REASONS: Readonly<Record<string, string>> = {
  idle: `It stopped after ${CLOUD_PHONE_IDLE_MINUTES} minutes with nothing to do.`,
  time_limit: "It reached its time limit.",
  spend_cap: "It used the minutes this period had left.",
  stopped: "It was stopped.",
  credit: "ADE Cloud could not keep it running.",
  crashed: "It crashed.",
  no_capacity: "No cloud iPhone was free.",
};

/**
 * How often the pane reads the phone: again, slowly, when it hasn't been read
 * or the last read failed; often while it starts; slowly while it is off;
 * while it runs, for its end and the idle countdown.
 */
function readCadence(status: CloudPhoneStatusView | null, failed: boolean): number | null {
  if (!status || failed) return IDLE_READ_MS;
  if (status.access !== "on") return null;
  const state = status.phone?.state ?? null;
  if (state === "starting") return STARTING_READ_MS;
  if (state === "ready") return LIVE_READ_MS;
  return IDLE_READ_MS;
}

function useCloudPhoneStatus(pin: OpenProjectBinding | null, hidden: boolean) {
  // The account's phone, as any surface of this window last read it.
  const status = useCloudPhoneLive().status;
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
      await readCloudPhoneStatus(pinRef.current);
      if (mine !== seq.current) return;
      setError(null);
    } catch (caught) {
      if (mine !== seq.current) return;
      setError(caught instanceof Error ? ipcErrorMessage(caught) : String(caught));
    }
  }, []);
  const pinKey = pin?.key ?? null;
  useEffect(() => { void refresh(); }, [pinKey, refresh]);
  const cadence = readCadence(status, error != null);
  useEffect(() => {
    if (hidden || cadence == null) return undefined;
    const timer = window.setInterval(() => { void refresh(); }, cadence);
    return () => window.clearInterval(timer);
  }, [cadence, hidden, refresh]);
  return { status, error, refresh };
}

/**
 * The view link for the live phone, fetched once per phone and again before it
 * expires; a failed fetch is tried again after 10 s. Not fetched while the pane
 * is hidden: it waits until the pane shows.
 */
function useCloudPhoneLink(pin: OpenProjectBinding | null, phoneId: string | null, hidden: boolean): { link: CloudPhoneView | null; error: string | null } {
  const [link, setLink] = useState<CloudPhoneView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const pinKey = pin?.key ?? null;
  useEffect(() => {
    setLink(null);
    setError(null);
    if (!phoneId) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const fetchLink = () => {
      if (hiddenRef.current) {
        timer = window.setTimeout(fetchLink, LINK_RETRY_MS);
        return;
      }
      void window.ade?.cloudPhone?.view({ control: true }, pinRef.current).then((next) => {
        if (cancelled) return;
        setLink(next);
        setError(null);
        // A minute before it expires, a fresh one (the page reconnects by itself).
        timer = window.setTimeout(fetchLink, Math.max(60_000, next.expiresAt - Date.now() - 60_000));
      }, (caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? ipcErrorMessage(caught) : String(caught));
        timer = window.setTimeout(fetchLink, LINK_RETRY_MS);
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

/**
 * Everything both panes share: the account's phone, its link, its model, and
 * Start / Stop. Always on the chat's machine (`pin`).
 */
function useCloudPhoneControl(pin: OpenProjectBinding | null, hidden: boolean) {
  const { status, error: statusError, refresh } = useCloudPhoneStatus(pin, hidden);
  const phone = status?.phone ?? null;
  const ready = phone?.state === "ready";
  const { link, error: linkError } = useCloudPhoneLink(pin, ready ? phone.id : null, hidden);
  const device = cloudPhoneDeviceOf(phone?.device);
  const [error, setError] = useState<unknown>(null);
  // A dismissed read failure stays hidden until a different one comes (the reads go on retrying).
  const [dismissedRead, setDismissedRead] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const readFailure = statusError ?? linkError;
  const shownReadFailure = readFailure && readFailure !== dismissedRead ? readFailure : null;

  const run = async (what: "start" | "stop", nextDevice?: CloudPhoneDevice) => {
    const api = window.ade.cloudPhone;
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      if (what === "start") await api.start(nextDevice ? { device: nextDevice } : {}, pinRef.current);
      else await api.stop(pinRef.current);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const minutes = status?.minutes ?? null;
  return {
    status,
    refresh,
    phone,
    ready,
    link,
    /** What the strip shows first: a failed Start/Stop or capture, else a failed read not dismissed. */
    failure: error ?? (shownReadFailure ? new Error(shownReadFailure) : null),
    /** Dismisses what the strip shows. */
    dismiss: () => {
      setError(null);
      setDismissedRead(readFailure);
    },
    pinRef,
    device,
    model: CLOUD_PHONE_MODELS[device],
    family: device === "ipad" ? "ipad" as const : "iphone" as const,
    minutes,
    minutesLine: minutes ? `${minutes.left} of ${minutes.included} min left` : null,
    off: !phone || phone.state === "ended",
    setError,
    busy,
    run,
  };
}

type CloudPhoneControl = ReturnType<typeof useCloudPhoneControl>;

/** The one line on top, as the local pane has: a failure, else a fact about the device. */
function CloudPhoneStrip({ control, failure = control.failure }: { control: CloudPhoneControl; failure?: unknown }) {
  const { status, phone, minutes, off, busy, run, dismiss } = control;
  if (failure) return <AppleDeviceStatusStrip error={failure} onDismiss={dismiss} />;
  if (status?.access === "on" && off) {
    const why = phone?.endReason ? ` ${END_REASONS[phone.endReason] ?? `It ended (${phone.endReason}).`}` : "";
    // Start stays even with the plan's minutes used up: extra minutes may
    // allow it, and when they don't the server's refusal shows here.
    return (
      <AppleDeviceNoticeStrip
        sentence={minutes && minutes.included <= 0
          // Every plan has minutes: none at all is a free plan the free-plan checks hold.
          ? "The free plan's iPhone minutes need the same check as its free hours. Finish it in Settings › ADE Cloud, or pick a plan."
          : minutes && minutes.left <= 0
            ? `This period's ${minutes.included} ADE Cloud iPhone minutes are used up.${why}`
            : `The ADE Cloud iPhone is off.${why}`}
        actionLabel={busy === "start" ? "Starting" : "Start"}
        busy={busy === "start"}
        onAction={() => void run("start")}
      />
    );
  }
  if (phone?.stopNotice) return <AppleDeviceNoticeStrip sentence={phone.stopNotice} actionLabel="Stop" onAction={() => void run("stop")} />;
  if (phone?.state === "ready") return <CloudPhoneRunningStrip control={control} />;
  return null;
}

/**
 * The running phone in one line: its model, how long it has been on, the
 * plan's minutes left, and when it stops with nothing to do. In the idle
 * countdown's last 90 s it counts in seconds and offers Keep on (one cheap
 * call to the phone, which NoMac counts as use).
 */
function CloudPhoneRunningStrip({ control }: { control: CloudPhoneControl }) {
  const live = useCloudPhoneLive();
  const { phone, model, busy, run, refresh, pinRef } = control;
  const { now, stopAt, warn } = useCloudPhoneIdleCountdown(live, true, true);
  const [keeping, setKeeping] = useState(false);
  // Entering the last stretch, and at the stop itself: read again, since an
  // agent's calls (on any machine) keep the phone on without this pane knowing.
  const warnedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!warn || stopAt == null || warnedFor.current === stopAt) return undefined;
    warnedFor.current = stopAt;
    void refresh();
    const timer = window.setTimeout(() => { void refresh(); }, Math.max(1_000, stopAt - Date.now() + 2_000));
    return () => window.clearTimeout(timer);
  }, [warn, stopAt, refresh]);

  const [keepError, setKeepError] = useState<string | null>(null);
  const keepOn = () => {
    if (keeping) return;
    setKeeping(true);
    setKeepError(null);
    void keepCloudPhoneOn(pinRef.current)
      .then(setKeepError, (caught: unknown) => setKeepError(`Couldn't keep it on: ${caught instanceof Error ? ipcErrorMessage(caught) : String(caught)}`))
      .finally(() => setKeeping(false));
  };

  const left = cloudPhoneMinutesLeft(live, now);
  const minutesPart = left != null && live.status?.minutes ? ` · ${left} of ${live.status.minutes.included} min left` : "";
  const onFor = phone?.readyAt ? ` · on ${formatPhoneSpan(now - phone.readyAt, false)}` : "";
  if (warn && stopAt != null) {
    const remaining = stopAt - now;
    // Past the stop time Keep on can't help: the phone is ending.
    if (remaining <= 0) {
      return (
        <AppleDeviceNoticeStrip
          sentence={`Stopping: nothing used it for ${CLOUD_PHONE_IDLE_MINUTES} minutes.`}
          actionLabel={busy === "stop" ? "Stopping" : "Stop"}
          busy={busy === "stop"}
          onAction={() => void run("stop")}
        />
      );
    }
    return (
      <AppleDeviceNoticeStrip
        sentence={keepError ?? `Stops in ${formatPhoneSpan(remaining, true)} with no command or input${minutesPart}.`}
        actionLabel={keeping ? "Keeping on" : "Keep on"}
        busy={keeping}
        onAction={keepOn}
        secondaryActionLabel={busy === "stop" ? "Stopping" : "Stop"}
        onSecondaryAction={() => void run("stop")}
      />
    );
  }
  const idlePart = stopAt != null ? ` · idle stop in ${formatPhoneSpan(stopAt - now, false)}` : "";
  return (
    <AppleDeviceNoticeStrip
      sentence={`${model.label}${onFor}${minutesPart}${idlePart}`}
      actionLabel={busy === "stop" ? "Stopping" : "Stop"}
      busy={busy === "stop"}
      onAction={() => void run("stop")}
    />
  );
}

/** Every viewport but the live phone: reading, not on this account, off, or starting. */
function cloudPhoneIdleViewport(control: CloudPhoneControl, showing: boolean): ReactNode | null {
  const { status, off, minutesLine, model, family, ready, run } = control;
  if (!status) return <PaneMessage title="ADE Cloud iPhone" description="Reading this account's cloud iPhone…" />;
  if (status.access !== "on") {
    return <PaneMessage title={status.access === "soon" ? "ADE Cloud iPhone is coming soon" : "ADE Cloud iPhone"} description={status.reason} />;
  }
  if (off) {
    return (
      <PaneMessage
        title="ADE Cloud iPhone"
        description={`${minutesLine ? `${minutesLine} this period. ` : ""}Agents start it with ade apple launch, which builds this lane's app on it.`}
      />
    );
  }
  if (!showing) {
    return (
      <AppleDeviceLoadingCard
        name={model.deviceTypeName}
        runtime="iOS 27 · ADE Cloud"
        isNew
        family={family}
        stage={ready ? "streaming" : "starting"}
        onRetry={() => void run("start")}
      />
    );
  }
  return null;
}

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
function CloudIphoneLive({ pin, sessionId, laneId, hidden: hiddenProp = false }: CloudIphonePanelProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Off screen, the view stops painting and the status read stops, as the local pane's stream does.
  // Parked too: the offscreen page only stops painting, so the phone is back at once.
  const offScreen = usePaneOffScreen(bodyRef, { parked: true });
  const hidden = hiddenProp || offScreen;
  const control = useCloudPhoneControl(pin, hidden);
  const { ready, link, device, model, family, minutesLine, off, refresh, run, setError, pinRef } = control;
  const frames = useCloudPhoneFrames({ url: link?.url ?? null, family, pointSize: model.points, hidden });

  const [mode, setModeState] = useState<AppleViewMode>(() => readAppleViewMode(null));
  const [canUse3d, setCanUse3d] = useState(true);
  const [threeDisabledReason, setThreeDisabledReason] = useState<string | null>(null);
  const [viewNonce, setViewNonce] = useState(0);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [bodyWidth, setBodyWidth] = useState(720);

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

  const switchDevice = async (next: CloudPhoneDevice) => {
    setConfirmSwitch(false);
    if (next === device && !off) return;
    if (!off) await run("stop");
    await run("start", next);
  };

  const screenshot = () => {
    setScreenshotPending(true);
    void window.ade.cloudPhone.screenshot({ chatSessionId: sessionId, laneId }, pinRef.current)
      .then((result) => showToast({
        id: "cloud-iphone-screenshot",
        tone: "success",
        title: "Screenshot filed to the proof drawer",
        message: result.artifactId ? `ADE Cloud iPhone · ${model.label}` : "Saved, but this project has no proof drawer here.",
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
            message: `ADE Cloud iPhone · ${model.label}`,
          });
        }
      })
      .catch((caught: unknown) => {
        if (action === "start") setRecordingSince(null);
        setError(caught);
      });
  };

  const live = ready && Boolean(link) && frames.state === "live";
  const failure = control.failure
    ?? (ready && frames.state === "error" ? new Error(frames.message ?? "The phone's screen could not be shown.") : null);

  const viewport = cloudPhoneIdleViewport(control, live) ?? (
    <AppleDeviceStage
      screenSource={{ canvas: frames.canvas, pixelSize: frames.pixelSize }}
      mode={effectiveMode}
      viewNonce={viewNonce}
      family={family}
      deviceTypeName={model.deviceTypeName}
      orientation="portrait"
      devicePointSize={model.points}
      interactive
      onDeviceInput={({ phase, x, y }) => { noteCloudPhoneInput(); frames.input(phase, x, y); }}
      onDeviceScroll={({ x, y, deltaX, deltaY }) => { noteCloudPhoneInput(); frames.scroll(x, y, deltaX, deltaY); }}
      onDeviceKey={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return false;
        noteCloudPhoneInput();
        frames.key(event.key);
        return true;
      }}
      frames={frames.canvas ? frames.frames : null}
      onThreeUnavailable={(reason) => {
        setCanUse3d(false);
        setThreeDisabledReason(reason);
      }}
      railInset={DEVICE_RAIL_WIDTH}
      className="bg-transparent"
    />
  );

  return (
    <div
      data-apple-pane=""
      data-testid="cloud-iphone-panel"
      data-apple-device-state={live ? "live" : off ? "off" : "starting"}
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-surface"
    >
      <CloudPhoneStrip control={control} failure={failure} />
      <div ref={bodyRef} className="@container relative flex min-h-0 min-w-0 flex-1">
        <div className="ade-tool-picker-static relative flex min-h-0 min-w-0 flex-1 flex-col">
          {viewport}

          {live ? (
            <AppleDeviceRail
              containerWidth={bodyWidth}
              deviceName={model.deviceTypeName}
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
              onHome={() => { noteCloudPhoneInput(); frames.home(); }}
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
            <AppleDeviceConfirmBar sentence="Switch the cloud iPhone? Its apps and data go; the project and its build cache stay.">
              {/* The phone it already is isn't a choice: "Keep it" is. Device names read in sentence case. */}
              {CLOUD_PHONE_DEVICES.filter((id) => id !== device).map((id) => (
                <Button key={id} variant="outline" size="sm" casing="sentence" onClick={() => void switchDevice(id)}>
                  {CLOUD_PHONE_MODELS[id].label}
                </Button>
              ))}
              <Button variant="ghost" size="sm" casing="sentence" onClick={() => setConfirmSwitch(false)}>
                Keep it
              </Button>
            </AppleDeviceConfirmBar>
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
function CloudIphoneFlat({ pin, hidden: hiddenProp = false }: CloudIphonePanelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const offScreen = usePaneOffScreen(rootRef, { parked: true });
  const control = useCloudPhoneControl(pin, hiddenProp || offScreen);
  const { ready, link, model, off } = control;
  const live = ready && Boolean(link);
  const [frameBox, setFrameBox] = useState<{ width: number; height: number } | null>(null);
  const sizerRef = useRef<HTMLDivElement | null>(null);

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


  let viewport = cloudPhoneIdleViewport(control, live);
  if (!viewport && link) {
    const { width: pointWidth, height: pointHeight } = model.points;
    const ratio = pointWidth / pointHeight;
    const width = frameBox ? Math.max(0, Math.min(frameBox.width, frameBox.height * ratio)) : null;
    viewport = (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4">
        <div ref={sizerRef} className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <div
            data-testid="cloud-iphone-flat"
            className="relative overflow-hidden bg-black ring-1 ring-inset ring-fg/[0.06]"
            style={width ? { width, height: width / ratio } : { aspectRatio: `${pointWidth} / ${pointHeight}`, height: "100%" }}
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
      ref={rootRef}
      data-apple-pane=""
      data-testid="cloud-iphone-panel"
      data-apple-device-state={live ? "live" : off ? "off" : "starting"}
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-surface"
    >
      <CloudPhoneStrip control={control} />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="ade-tool-picker-static relative flex min-h-0 min-w-0 flex-1 flex-col">
          {viewport}
        </div>
      </div>
    </div>
  );
}
