import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { macDesktopPaneCaption } from "../../../shared/types/macDesktop";
import type {
  MacDesktopDisplay,
  MacDesktopLeaseState,
  MacDesktopPermissionKind,
  MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import type { SystemSettingsPaneId } from "../../../shared/types/systemSettings";
import { RECORDING_RECEIPT_MS, revealProofArtifactRow } from "../shared/recordingFormat";
import { macDesktopApi } from "./macDesktopApi";
import { macDesktopMissingPermissions, type MacDesktopPermissionCheck } from "./MacDesktopPermissionCard";
import { useWorkToolsMaximize } from "../terminals/workToolsMaximize";
import {
  displayPointToViewPoint,
  macDesktopContentBox,
  viewPointToDisplayPoint,
} from "./macDesktopGeometry";
import { useMacDesktopFrame } from "./macDesktopFrameStore";
import {
  createMacDesktopLeaseHeartbeat,
  macDesktopUserHasControl,
} from "./macDesktopLease";
import { useMacDesktopLiveView } from "./useMacDesktopLiveView";
import {
  createMacDesktopFastInputSender,
  useMacDesktopRealInput,
} from "./useMacDesktopRealInput";
import { useMacDesktopRecheck, useMacDesktopStatus } from "./useMacDesktopStatus";
import { macDesktopClaimAppIcons } from "./macDesktopClaimPicker.logic";
import { macDesktopErrorText } from "./macDesktopErrorText";
import { useMacDesktopMachineFacts } from "./useMacDesktopMachineFacts";
import { macDesktopParkedWindows } from "./macDesktopStrip";

export const MAC_DESKTOP_FULLSCREEN_Z = 40_000;

/**
 * A video that has not started after this long is not coming.
 *
 * The first frame normally arrives in under two seconds. Past this the strip
 * says so and offers Reconnect and Stop, so a display that died with no event
 * cannot leave the pane on "Connecting video" with nothing to press.
 */
export const MAC_DESKTOP_CONNECT_SLOW_MS = 20_000;

/**
 * How old the lane's last frame may be and still stand in for the picture
 * while the pane's own decoder connects.
 *
 * The floating player writes the frame store four times a second while it
 * decodes, so a handover from it finds a frame well inside this. A frame older
 * than this is a picture of a screen that has since moved on.
 */
export const MAC_DESKTOP_HANDOVER_FRAME_TTL_MS = 10_000;

/** A Check again that answers at once still shows it looked. */
const MAC_DESKTOP_CHECK_MIN_MS = 600;

const SETTINGS_PANE: Record<MacDesktopPermissionKind, SystemSettingsPaneId> = {
  screenRecording: "macos-screen-recording",
  accessibility: "macos-accessibility",
};

/**
 * This window's identity as a lease controller.
 *
 * Stable for the life of the renderer and unique per window: the lease is held
 * by a controller id, and two ADE windows on one machine must be able to take
 * control from each other. A per-mount id would make a re-render look like a
 * different controller and silently strand the lease until its TTL.
 */
let controllerId: string | null = null;
function macDesktopControllerId(): string {
  if (!controllerId) {
    const uuid = globalThis.crypto?.randomUUID?.();
    controllerId = `ade-window:${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  }
  return controllerId;
}


/** Which of the two chrome rows a control is being drawn in. */
export type MacDesktopChromeScope = "pane" | "fullscreen";

/** A capture the pane just filed as proof, for the receipt over the picture. */
type MacDesktopReceipt = {
  artifactId: string;
  /** Null for a screenshot, which has no running time. */
  durationMs: number | null;
  bytes: number | null;
  /** Host-absolute. Opened only when the host is this Mac. */
  filePath: string | null;
};

/** What the last observation event said, for the one line under the rail. */
type MacDesktopLastObservation = {
  caption: string | null;
  at: number;
  elementCount: number;
};

export type ChatMacDesktopPanelProps = {
  laneId: string;
  laneName?: string | null;
  /** The chat the tab is attached to, for lease and proof attribution. */
  sessionId: string | null;
  runtimePin: OpenProjectBinding | null;
};

export function useMacDesktopPanelController({
  laneId,
  laneName,
  sessionId,
  runtimePin,
}: ChatMacDesktopPanelProps) {
  // The machine on the other end of the pin, for the one failure that is about
  // it rather than about this screen: a brain with no `mac_desktop` domain.
  const machineFacts = useMacDesktopMachineFacts(runtimePin);
  const {
    status,
    setStatus,
    error: statusError,
    setError: setStatusError,
    readError,
    unconfirmed,
    refresh: refreshStatus,
    stop: stopDisplay,
    stopping,
    start,
    starting,
    gaveUp,
    cursor,
    notParked,
    dismissNotParked,
    appsLeftOpen,
    dismissAppLeftOpen,
  } = useMacDesktopStatus({
    laneId,
    laneName,
    sessionId,
    runtimePin,
    machineName: machineFacts.machineName,
    machineVersion: machineFacts.machineVersion,
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [claimable, setClaimable] = useState<MacDesktopWindow[]>([]);
  const [claimableLoading, setClaimableLoading] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Inside the Work sidebar the whole pane maximises (tabs stay); the panel's
  // own overlay is the fallback where no sidebar hosts it.
  const paneMaximize = useWorkToolsMaximize();
  const [busy, setBusy] = useState(false);
  /**
   * A permission re-probe or prompt is in flight.
   *
   * Separate from `busy` so the screen, the rail and the strip stay live while
   * the one control that is waiting says "Checking…". Two simultaneous calls
   * would race two helper restarts.
   */
  const [checkingPermissions, setCheckingPermissions] = useState(false);
  /**
   * A recording toggle or a screenshot that failed, kept OUT of `statusError`.
   *
   * `statusError` is the display-state slot: it titles the empty state when
   * the display is gone. A failed `stopRecording` on a lane whose recorder the
   * helper already closed used to be written there and then surfaced as
   * "Lane <uuid> is not recording." over an empty pane — an error about the
   * wrong thing, in the wrong place, with an id in it.
   */
  const [captureError, setCaptureError] = useState<string | null>(null);
  /** A quiet line about a capture that is fine, such as where a receipt went. */
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<MacDesktopReceipt | null>(null);
  const [screenshotPending, setScreenshotPending] = useState(false);
  // All three belong to one lane's captures; a lane change starts fresh.
  useEffect(() => {
    setCaptureError(null);
    setCaptureNotice(null);
    setReceipt(null);
  }, [laneId]);
  // The receipt says the file exists and where it went, then goes away.
  useEffect(() => {
    if (!receipt) return undefined;
    const timer = window.setTimeout(() => setReceipt(null), RECORDING_RECEIPT_MS);
    return () => window.clearTimeout(timer);
  }, [receipt]);
  const [viewRect, setViewRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  /** The pane's own box, which decides stacked vs side by side. */
  /** The window the rail is pointing at on the picture, if any. */
  const [selectedWindowId, setSelectedWindowId] = useState<number | null>(null);
  const [lastObservation, setLastObservation] = useState<MacDesktopLastObservation | null>(null);

  /**
   * State and not a ref, because every overlay drawn ON the picture is
   * positioned from its measured rect: the observer has to be re-pointed at the
   * new element the frame full screen opens, and a ref would not re-run the
   * effect that does it. This is the fix for the takeover and agent cursors
   * landing at pane coordinates over a full-screen picture.
   */
  const [surfaceNode, setSurfaceNode] = useState<HTMLDivElement | null>(null);

  /**
   * The decoder's home, which is a node and not a place in the tree.
   *
   * Entering full screen moves the picture from the pane into an overlay, and
   * every React way of doing that — a second `H264VideoCanvas`, the same
   * element rendered under a different parent, a portal whose container
   * changes — unmounts the canvas and restarts the decode: the stream drops,
   * reconnects, and the status pill flashes "Starting" on every toggle. So the
   * canvas is rendered ONCE into this detached host through a portal whose
   * container never changes, and the host node itself is appended to whichever
   * slot is on screen. A 2D canvas keeps its context and its pixels across a
   * DOM move, so the decode never notices.
   */
  const [videoHost] = useState<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    const node = document.createElement("div");
    node.className = "absolute inset-0";
    node.dataset.testid = "mac-desktop-video-host";
    return node;
  });
  const [canvasSlot, setCanvasSlot] = useState<HTMLDivElement | null>(null);

  /**
   * Which slot the host belongs to, resolved against the DOM rather than order.
   *
   * Both copies of the picture are mounted at once, so a commit that swaps
   * which one is active runs one ref detach and one ref attach with no
   * guaranteed order. A detach only wins if the node it is detaching from has
   * actually left the document, which is the difference between "the pane
   * stopped being active" and "the overlay was torn down".
   */
  const attachCanvasSlot = useCallback((node: HTMLDivElement | null) => {
    setCanvasSlot((current) => node ?? (current?.isConnected ? current : null));
  }, []);
  const attachSurface = useCallback((node: HTMLDivElement | null) => {
    setSurfaceNode((current) => node ?? (current?.isConnected ? current : null));
  }, []);

  useEffect(() => {
    if (!videoHost || !canvasSlot) return;
    if (videoHost.parentElement !== canvasSlot) canvasSlot.appendChild(videoHost);
  }, [canvasSlot, videoHost]);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;

  /**
   * One place every user-facing failure is routed through, so a lane id never
   * reaches a panel: the lane's name replaces it when the caller has one.
   */
  const errorText = useCallback(
    (error: unknown): string | null => macDesktopErrorText(
      error instanceof Error ? error.message : String(error),
      {
        laneId,
        laneName,
        machineName: machineFacts.machineName,
        machineVersion: machineFacts.machineVersion,
      },
    ),
    [laneId, laneName, machineFacts.machineName, machineFacts.machineVersion],
  );

  const display: MacDesktopDisplay | null = status?.display ?? null;
  const lease: MacDesktopLeaseState | null = status?.lease ?? null;
  const windows: MacDesktopWindow[] = status?.windows ?? [];
  const supported = status?.supported ?? null;
  const iHaveControl = macDesktopUserHasControl(lease, macDesktopControllerId());
  const parkedWindows = macDesktopParkedWindows(windows, display?.displayId);
  const claimAppIcons = useMemo(() => macDesktopClaimAppIcons(windows), [windows]);

  /**
   * The grants the host reported as off, Screen Recording first.
   *
   * Without Screen Recording there is no picture at all, so a lane with no
   * display cannot start until it is on. Without Accessibility the picture
   * works and clicks do not, so Start stays possible and the card says so.
   */
  const missingPermissions = macDesktopMissingPermissions(status?.permissions);
  const [permissionCheck, setPermissionCheck] = useState<MacDesktopPermissionCheck | null>(null);
  /**
   * The pane's own "Stop Mac Desktop?" question, for the header's Stop and
   * for Reset while a display may still exist.
   */
  const [confirmStop, setConfirmStop] = useState(false);
  /** The video has been connecting for longer than a connect ever takes. */
  const [connectSlow, setConnectSlow] = useState(false);
  /** The stopped-video card's Details fold. */
  const [videoDetailsOpen, setVideoDetailsOpen] = useState(false);

  /**
   * Whether a grant can be made from THIS window.
   *
   * The pin is the reliable half: a `remote` binding means the lane's Mac is
   * another machine, where opening this computer's System Settings or firing a
   * local prompt reaches the wrong box. `hostIsLocal` is the host's own answer
   * and stays true for a runtime that has not been told which client asked.
   */
  const laneHostIsLocal = runtimePin?.kind !== "remote" && Boolean(status?.hostIsLocal);

  /**
   * Lane id → name, for "ADE · docs-fix" on a window parked somewhere else.
   *
   * Only this lane's own name, deliberately. The tab store's lane list belongs
   * to the PROJECT tab's machine, and this display can be hosted on another
   * one, so a name taken from there would be a different lane that happens to
   * share an id-shaped slot. A lane the viewer has no row for degrades to a
   * short id, which is at least true.
   */
  const laneNames = useMemo(
    () => (laneName ? { [laneId]: laneName } : {}),
    [laneId, laneName],
  );

  const live = useMacDesktopLiveView({
    laneId,
    runtimePin,
    enabled: Boolean(display),
    chatSessionId: sessionId,
  });

  // While the video connects, re-read the status: a display that went away
  // without an event must turn into the Off card, not a "Connecting video"
  // that never ends.
  const connecting = Boolean(display) && !starting && live.status !== "playing" && live.status !== "error";
  useMacDesktopRecheck(connecting, refreshStatus);
  // And past a normal connect, the strip says so and offers the ways out.
  useEffect(() => {
    setConnectSlow(false);
    if (!connecting) return undefined;
    const timer = window.setTimeout(() => setConnectSlow(true), MAC_DESKTOP_CONNECT_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [connecting]);
  // A new failure starts with its Details folded.
  useEffect(() => {
    setVideoDetailsOpen(false);
  }, [live.error]);

  /* ── Geometry ────────────────────────────────────────────────────────── */

  useEffect(() => {
    const node = surfaceNode;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setViewRect((current) =>
        current.left === rect.left && current.top === rect.top
          && current.width === rect.width && current.height === rect.height
          ? current
          : { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    // The first reading does not wait on ResizeObserver. A test DOM, and any
    // browser that has the rect API without the observer, still has to know
    // where the picture is or every click maps to nothing.
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
    };
  }, [display?.displayId, surfaceNode]);



  const toDisplayPoint = useCallback((clientX: number, clientY: number) => {
    if (!display) return null;
    return viewPointToDisplayPoint({ clientX, clientY, rect: viewRect, display });
  }, [display, viewRect]);

  const cursorPoint = useMemo(() => {
    if (!cursor || !display) return null;
    return displayPointToViewPoint({ x: cursor.x, y: cursor.y, rect: viewRect, display });
  }, [cursor, display, viewRect]);

  /**
   * Where the picture actually is, so the frame can sit on it.
   *
   * A 16:9 desktop in a tall tools column left a third of the pane empty above
   * the image and a third below it, inside a rounded border drawn around the
   * whole pane — so the border framed the emptiness rather than the screen.
   * The canvas still fills the surface and letterboxes itself; only the border,
   * the radius and the takeover ring follow the image.
   */
  const contentBox = useMemo(
    () => (display ? macDesktopContentBox(viewRect, display) : null),
    [display, viewRect],
  );

  /**
   * The last thing the agent looked at, for the line under the rail.
   *
   * An event subscription, never a poll: the service already emits an
   * `observation` for every look, and the only fields kept are the three the
   * line prints. The picture itself comes from the frame store, which the live
   * view fills, so this costs one small object per observation.
   */
  useEffect(() => {
    const api = window.ade.macDesktop;
    if (!api) return;
    return api.onEvent((event) => {
      if (event.type !== "observation" || event.laneId !== laneId) return;
      setLastObservation({
        caption: event.observation.caption,
        at: Date.parse(event.observation.capturedAt) || Date.now(),
        elementCount: event.observation.elementCount,
      });
    }, runtimePin);
  }, [laneId, runtimePin]);

  const lastFrame = useMacDesktopFrame(laneId);
  /**
   * The last frame, shown under the decoder until it draws its own.
   *
   * Expanding the floating player into the pane hands the lane's decoder over:
   * the pane dials the stream and waits for a keyframe, which took a second or
   * two of "Connecting video" although the player had just drawn the picture.
   */
  const handoverFrame = lastFrame
    && live.status !== "playing"
    && Date.now() - lastFrame.at <= MAC_DESKTOP_HANDOVER_FRAME_TTL_MS
    ? lastFrame.dataUrl
    : null;

  /* ── Takeover ────────────────────────────────────────────────────────── */

  const returnControl = useCallback(async () => {
    try {
      const next = await macDesktopApi().returnControl(
        { laneId, controllerId: macDesktopControllerId() },
        pinRef.current,
      );
      setStatus((current) => (current ? { ...current, lease: next } : current));
    } catch {
      // The lease is a deadline: a failed return costs at most one TTL, and
      // surfacing it would be a modal about something already self-healing.
    }
  }, [laneId, setStatus]);

  const heartbeat = useMemo(
    () => createMacDesktopLeaseHeartbeat({
      renew: () => macDesktopApi().renewLease(
        { laneId, holderId: macDesktopControllerId() },
        pinRef.current,
      ),
      onLost: () => {
        setStatus((current) => (current ? { ...current, lease: null } : current));
      },
    }),
    [laneId, setStatus],
  );

  useEffect(() => {
    if (iHaveControl) heartbeat.start();
    else heartbeat.stop();
  }, [heartbeat, iHaveControl]);

  /**
   * Drop the lease when this view is gone, not when the ADE window blurs.
   *
   * A real click on a parked window makes that window key on the lane display.
   * ADE then loses focus, `window` fires `blur`, and treating that as "walked
   * away" ended takeover on the first click. The heartbeat deadline still
   * lapses a holder that actually left; pagehide and unmount still drop it
   * immediately.
   */
  useEffect(() => {
    if (!iHaveControl) return;
    const release = () => {
      heartbeat.stop();
      void returnControl();
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [heartbeat, iHaveControl, returnControl]);

  const takeControl = useCallback(async () => {
    setBusy(true);
    try {
      const next = await macDesktopApi().takeControl(
        { laneId, controllerId: macDesktopControllerId(), controllerLabel: "You" },
        pinRef.current,
      );
      setStatus((current) => (current ? { ...current, lease: next } : current));
    } catch (error) {
      setStatusError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [errorText, laneId, setStatus, setStatusError]);

  /* ── Real input, only while the user holds the lease ──────────────────── */

  // Local takeover goes over the stream's loopback port, not the brain RPC:
  // one request per event instead of a full IPC → brain → service hop.
  const fastSender = useMemo(
    // The driver puts the person's cursor back after every post. Nothing holds
    // it: absolute pointing has no mode to stay in.
    () => createMacDesktopFastInputSender(live.url, { holdCursor: () => false }),
    [live.url],
  );
  const realInput = useMacDesktopRealInput({
    laneId,
    sessionId,
    controllerId: macDesktopControllerId(),
    enabled: iHaveControl,
    toDisplayPoint,
    runtimePin,
    sender: fastSender,
    // Hover posts only when the person is not sitting at the host. On this
    // Mac a hover `CGEvent` warps the one system cursor onto the lane's
    // display, and doing that sixty times a second is the jitter this pane is
    // named for — the local glyph is the pointer instead. From another
    // computer the host's cursor is free, and the picture has to track it.
    forwardPointerMoves: !laneHostIsLocal,
    // `home` is this window's own pointer. It is only meaningful on the Mac
    // that owns the display; a remote window's screen coordinates would send
    // the host's cursor somewhere that Mac has never drawn.
    reportCursorHome: laneHostIsLocal,
  });

  useEffect(() => {
    if (!iHaveControl) realInput.clearInputError();
  }, [iHaveControl, realInput.clearInputError]);

  /*
    While the person drives, the menu's shortcuts belong to the lane.

    A takeover forwards every keystroke to the lane's display, and somebody
    driving reasonably presses ⌘Q to quit an app over there, or ⌘W to close a
    window. `preventDefault` in the key handler cannot reach an Electron menu
    accelerator — it fires first and independently of the page — so ⌘Q aimed
    at the remote desktop quit ADE itself, cleanly, with nothing in any log to
    explain it. That is what kept closing this window mid-test.

    Scoped to the takeover and released with it, so the menu works normally
    everywhere else, including in this pane when the agent holds the lease.
  */
  useEffect(() => {
    void window.ade?.app?.setIgnoreMenuShortcuts?.(iHaveControl);
    if (!iHaveControl) return;
    return () => { void window.ade?.app?.setIgnoreMenuShortcuts?.(false); };
  }, [iHaveControl]);

  /*
    Input reaches the surface as DOM events, on purpose.

    The decoder's canvas is a React portal into a host node that is parked
    inside the surface. A portal's synthetic events bubble through the React
    tree, to the portal's owner, and never through the surface that is its DOM
    parent. With React handlers on the surface, every click and every hover on
    the picture itself vanished, and only the letterbox responded: the takeover
    looked dead and the hover cursor never appeared. Native listeners follow
    the DOM, where the canvas really is.
  */
  const takeControlRef = useRef(takeControl);
  takeControlRef.current = takeControl;
  const realInputRef = useRef(realInput);
  realInputRef.current = realInput;
  const controlStateRef = useRef({ iHaveControl, busy });
  controlStateRef.current = { iHaveControl, busy };
  useEffect(() => {
    const node = surfaceNode;
    if (!node) return;
    const onPointerDown = (event: PointerEvent) => {
      const state = controlStateRef.current;
      if (!state.iHaveControl) {
        // The first click on the screen takes control; the strip button is
        // the same action. Right-click is a menu, not a claim.
        if (!state.busy && event.button !== 2) void takeControlRef.current();
        return;
      }
      realInputRef.current.onPointerDown(event as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    const onPointerMove = (event: PointerEvent) => {
      realInputRef.current.onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    const onPointerUp = (event: PointerEvent) => {
      realInputRef.current.onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    const onPointerLeave = () => realInputRef.current.onPointerLeave();
    const onWheel = (event: WheelEvent) => {
      realInputRef.current.onWheel(event as unknown as ReactWheelEvent<HTMLDivElement>);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      realInputRef.current.onKeyDown(event as unknown as ReactKeyboardEvent<HTMLDivElement>);
    };
    const onContextMenu = (event: MouseEvent) => {
      if (controlStateRef.current.iHaveControl) event.preventDefault();
    };
    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", onPointerUp);
    node.addEventListener("pointerleave", onPointerLeave);
    // Non-passive: a scroll forwarded to the lane must not also scroll the pane.
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("contextmenu", onContextMenu);
    return () => {
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointerleave", onPointerLeave);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("contextmenu", onContextMenu);
    };
  }, [surfaceNode]);

  /* ── Recording and presenting ────────────────────────────────────────── */

  const recording = status?.recording ?? null;
  const toggleRecording = useCallback(async () => {
    // No display means no recorder: the helper closed it with the display, and
    // a stale `running: true` would otherwise send a stop for a recording that
    // no longer exists.
    if (!display) return;
    setBusy(true);
    try {
      // A person pressing Record wants the file kept, so the pane always sends
      // a caption: that is what files it as proof. An agent still has to
      // write its own.
      const next = recording?.running
        ? await macDesktopApi().stopRecording({ laneId, chatSessionId: sessionId }, pinRef.current)
        : await macDesktopApi().startRecording({
          laneId,
          chatSessionId: sessionId,
          caption: macDesktopPaneCaption("recording", laneName),
        }, pinRef.current);
      setStatus((current) => (current ? { ...current, recording: next } : current));
      setCaptureError(null);
      if (!next.running && next.proofArtifactId) {
        setReceipt({
          artifactId: next.proofArtifactId,
          durationMs: next.durationMs ?? 0,
          bytes: next.bytes ?? null,
          filePath: next.filePath,
        });
      } else if (!next.running && next.caption && next.proofArtifactId === null) {
        // Null is the host saying the filing failed. An older host sends no
        // field at all, and it still filed the captioned movie.
        setCaptureError("The recording was saved, but it could not be filed as proof.");
      }
    } catch (error) {
      setCaptureError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [display, errorText, laneId, laneName, recording?.running, sessionId, setStatus]);

  /** Save screenshot: one picture of the lane's screen, filed as proof. */
  const saveScreenshot = useCallback(async () => {
    if (!display) return;
    setScreenshotPending(true);
    try {
      const shot = await macDesktopApi().screenshot({
        laneId,
        chatSessionId: sessionId,
        caption: macDesktopPaneCaption("screenshot", laneName),
      }, pinRef.current);
      setCaptureError(null);
      if (shot.proofArtifactId) {
        setReceipt({
          artifactId: shot.proofArtifactId,
          durationMs: null,
          bytes: shot.bytes ?? null,
          filePath: shot.filePath,
        });
      } else {
        setCaptureError("The screenshot was taken, but it could not be filed as proof.");
      }
    } catch (error) {
      setCaptureError(errorText(error));
    } finally {
      setScreenshotPending(false);
    }
  }, [display, errorText, laneId, laneName, sessionId]);

  /**
   * The receipt's Open, the way the Apple pane's does it: the proof row when
   * the proof panel is on screen, the file when it is not. A file on another
   * Mac cannot be opened from here, so a remote lane is pointed at the drawer.
   */
  const openReceipt = useCallback((entry: MacDesktopReceipt) => {
    if (revealProofArtifactRow(entry.artifactId)) return;
    if (laneHostIsLocal && entry.filePath) {
      void window.ade.app.openPath(entry.filePath).catch((error: unknown) => {
        setCaptureError(errorText(error));
      });
      return;
    }
    setCaptureNotice("It is in this chat's proof drawer.");
  }, [errorText, laneHostIsLocal]);

  /* The pill's clock. Ticks only while something is recording. */
  const [nowTick, setNowTick] = useState(() => Date.now());
  const recordingRunning = Boolean(recording?.running);
  useEffect(() => {
    if (!recordingRunning) return undefined;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [recordingRunning]);

  const present = useCallback(async (destination: "main" | "display") => {
    setBusy(true);
    try {
      await macDesktopApi().present({ laneId, destination }, pinRef.current);
      await refreshStatus();
    } catch (error) {
      setStatusError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [errorText, laneId, refreshStatus, setStatusError]);

  /**
   * What is open on the user's own screen that this lane could adopt.
   *
   * Read when the picker opens rather than kept in the status: it is a
   * snapshot of the whole Mac's windows, it changes every time the user opens
   * anything, and nothing in the strip depends on it until somebody is looking
   * for a window to claim. Unfiltered on purpose — the picker decides what a
   * row means, including the ones it has to show as locked.
   */
  const refreshClaimable = useCallback(async () => {
    setClaimableLoading(true);
    setClaimError(null);
    try {
      const all = await macDesktopApi().listWindows({ laneId: null }, pinRef.current);
      setClaimable(all);
    } catch (error) {
      setClaimError(errorText(error));
    } finally {
      setClaimableLoading(false);
    }
  }, [errorText]);

  useEffect(() => {
    if (!pickerOpen) return;
    void refreshClaimable();
  }, [pickerOpen, refreshClaimable]);

  /**
   * Adopt one window onto this lane's screen.
   *
   * The failure is reported INSIDE the picker rather than replacing the
   * picture: the user is mid-choice in a list, and a claim that the window
   * server refused should leave them in the list with a reason, not drop them
   * back onto a pane-wide error line with the dialog gone.
   */
  const claimWindow = useCallback(async (windowId: number) => {
    setBusy(true);
    try {
      await macDesktopApi().claimWindow({ laneId, windowId, chatSessionId: sessionId }, pinRef.current);
      await refreshStatus();
    } catch (error) {
      setClaimError(errorText(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }, [errorText, laneId, refreshStatus, sessionId]);

  const releaseWindow = useCallback(async (windowId: number) => {
    try {
      await macDesktopApi().releaseWindow({ laneId, windowId }, pinRef.current);
    } catch (error) {
      setStatusError(errorText(error));
    }
  }, [errorText, laneId, setStatusError]);

  /**
   * Point the rail at one window, or stop pointing.
   *
   * Selection is a drawing, not a mode: the only thing it changes is a thin
   * accent rectangle over that window's frame on the picture, which is the
   * cheapest honest answer to "which one is that?" for two windows of one app.
   */
  const selectWindow = useCallback((windowId: number) => {
    setSelectedWindowId((current) => (current === windowId ? null : windowId));
  }, []);

  /* Void-returning, stable identities, so a memoised card is not re-rendered
     by a new closure every time a frame lands. */
  const releaseWindowById = useCallback((windowId: number) => { void releaseWindow(windowId); }, [releaseWindow]);

  /**
   * Escape: the way out, and it is not only about full screen.
   *
   * This used to bind only while expanded, and only called `setExpanded`.
   * That left the one key a person reaches for when the pointer misbehaves
   * doing nothing in the pane — worse, the surface's own handler forwarded it
   * to the lane's Mac, so the escape hatch was delivered to the wrong
   * computer. It is bound here whenever there is something to escape FROM.
   *
   * Order matters. The listener is on `window` in the capture phase, so it
   * runs before the surface's key forwarder, which is a bubble-phase listener
   * on the surface node. Escape therefore never reaches the lane.
   *
   * The release is local first and asks the host second. Everything the
   * person feels — the gesture forgotten, the pump stopped, the page's
   * pointer events freed, the pane back to its normal size — happens in this
   * handler with no round trip. `cancelInput` posts the button release and
   * the cursor warp without awaiting, and `returnControl` gives the lease
   * back. A wedged transport is the usual reason for pressing Escape, so
   * nothing here may wait on one.
   */
  const escapeRef = useRef<() => boolean>(() => false);
  escapeRef.current = () => {
    // Nothing of ours to escape from: let the key through to whatever dialog
    // or menu is open. A global capture listener that swallowed every Escape
    // in the window would break the rest of the app.
    if (!iHaveControl && !expanded) return false;
    if (iHaveControl) {
      realInput.cancelInput();
      heartbeat.stop();
      void returnControl();
    }
    if (expanded) setExpanded(false);
    return true;
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // No modifier: Cmd-Escape and friends belong to macOS, and a person
      // holding a modifier is not panicking.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!escapeRef.current()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  /**
   * The same Escape, for the case the listener above cannot see.
   *
   * A takeover on the Mac that owns the display posts its clicks through the
   * HID tap, which macOS cannot tell from a real one — so the first click
   * activates whatever window is under it on the lane's display, and from then
   * on the lane's app owns the keyboard. The renderer gets no `keydown` at
   * all, and the panic key is dead exactly when it is needed. Main registers a
   * machine-wide accelerator for the takeover's lifetime and calls back here.
   *
   * Armed only while the lane's Mac is this one. A remote lane keeps focus in
   * this window, so the listener above is enough and taking the key
   * system-wide would be an intrusion that buys nothing.
   */
  const wantsEscapeHotkey = iHaveControl && laneHostIsLocal;
  useEffect(() => {
    const api = window.ade.macDesktop;
    if (!api?.setEscapeHotkey || !api.onEscapeHotkey) return;
    if (!wantsEscapeHotkey) return;
    const off = api.onEscapeHotkey(() => { escapeRef.current(); });
    void api.setEscapeHotkey({ laneId, armed: true }).catch(() => {});
    return () => {
      off();
      void api.setEscapeHotkey({ laneId, armed: false }).catch(() => {});
    };
  }, [laneId, wantsEscapeHotkey]);

  useEffect(() => {
    if (!expanded || typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.add("ade-mac-desktop-fullscreen");
    return () => root.classList.remove("ade-mac-desktop-fullscreen");
  }, [expanded]);

  /**
   * The one remediation button, routed through the app-level opener.
   *
   * `x-apple.systempreferences:` is outside the external-URL scheme allowlist,
   * so main resolves a pane ID against `SYSTEM_SETTINGS_PANE_URLS` and opens it
   * itself. A refusal is reported rather than swallowed: a dead "Open System
   * Settings" button is exactly how this control broke the last time.
   */
  const openSettingsPane = useCallback((paneId: SystemSettingsPaneId) => {
    const failed = () => {
      setStatusError("Could not open System Settings on this Mac. Open Privacy & Security yourself.");
    };
    const open = window.ade.app.openSystemSettingsPane;
    if (typeof open !== "function") {
      failed();
      return;
    }
    void open(paneId).then((result) => {
      if (!result?.opened) failed();
    }, failed);
  }, [setStatusError]);

  /**
   * "Check again": re-probe the grants and say what it found. It never starts
   * a display: Start is the one start, so the pane does not jump from the
   * permission card to "Starting" behind the person's back.
   *
   * With no display the helper is restarted first. macOS usually will not show
   * a Screen Recording grant made after a process started to that same
   * process, so re-reading the old helper's cached "denied" is the retry that
   * never worked. With a live display the helper is NOT restarted, because
   * that would close the display, and the Accessibility probe is live anyway.
   */
  const checkAgain = useCallback(async () => {
    setCheckingPermissions(true);
    setStatusError(null);
    const began = Date.now();
    let result: MacDesktopPermissionCheck;
    try {
      const permissions = await macDesktopApi().recheckPermissions(
        { restartDriver: !display },
        pinRef.current,
      );
      setStatus((current) => (current ? { ...current, permissions } : current));
      await refreshStatus().catch(() => undefined);
      result = { at: Date.now(), stillMissing: macDesktopMissingPermissions(permissions) };
    } catch (error) {
      result = { at: Date.now(), error: errorText(error) ?? "Could not check. Try again." };
    }
    const wait = MAC_DESKTOP_CHECK_MIN_MS - (Date.now() - began);
    if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
    setPermissionCheck(result);
    setCheckingPermissions(false);
  }, [display, errorText, refreshStatus, setStatus, setStatusError]);

  /** Reads the status again after a failed read, and nothing more. */
  const readAgain = useCallback(async () => {
    setStatusError(null);
    await refreshStatus().catch(() => undefined);
  }, [refreshStatus, setStatusError]);

  /**
   * Stop, after the pane's own question. Reset is the same stop, offered when
   * the pane cannot tell what state the lane is in.
   */
  const stopNow = useCallback(() => {
    setConfirmStop(false);
    setExpanded(false);
    void stopDisplay();
  }, [stopDisplay]);


  return {
    laneId, laneName, sessionId, runtimePin, machineFacts,
    status, setStatus, statusError, setStatusError, readError, unconfirmed, refreshStatus, stopDisplay, stopping,
    start, starting, gaveUp, cursor, notParked, dismissNotParked, appsLeftOpen, dismissAppLeftOpen,
    pickerOpen, setPickerOpen, claimable, claimableLoading, claimError,
    expanded, setExpanded, paneMaximize, busy, setBusy, checkingPermissions, setCheckingPermissions,
    captureError, setCaptureError, captureNotice, setCaptureNotice, receipt, setReceipt, screenshotPending,
    viewRect, selectedWindowId, setSelectedWindowId, lastObservation, surfaceNode, videoHost, canvasSlot,
    attachCanvasSlot, attachSurface, errorText, display, lease, windows, supported, iHaveControl, parkedWindows,
    claimAppIcons, missingPermissions, permissionCheck, setPermissionCheck, confirmStop, setConfirmStop,
    connectSlow, setConnectSlow, videoDetailsOpen, setVideoDetailsOpen, laneHostIsLocal, laneNames, live, connecting,
    cursorPoint, contentBox, lastFrame, handoverFrame, returnControl, takeControl, realInput, recording,
    toggleRecording, saveScreenshot, openReceipt, nowTick, recordingRunning, present, refreshClaimable, claimWindow,
    releaseWindow, releaseWindowById, selectWindow, openSettingsPane, checkAgain, readAgain, stopNow, SETTINGS_PANE,
  };
}

export type MacDesktopPanelController = ReturnType<typeof useMacDesktopPanelController>;
