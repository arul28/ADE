import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowSquareIn,
  ArrowsInSimple,
  ArrowsOutSimple,
  Camera,
  Cursor,
  Monitor,
  Plus,
  Power,
  Record,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { macDesktopPaneCaption } from "../../../shared/types/macDesktop";
import { macDesktopNotParkedSentence } from "./macDesktopActivityText";
import type {
  MacDesktopDisplay,
  MacDesktopLeaseState,
  MacDesktopPermissionKind,
  MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import type { SystemSettingsPaneId } from "../../../shared/types/systemSettings";
import { cn } from "../ui/cn";
import { RecordingPill, RecordingSavedRow } from "../shared/RecordingReceipt";
import { RECORDING_RECEIPT_MS, revealProofArtifactRow } from "../shared/recordingFormat";
import {
  WORK_TOOL_CHROME_CHIP,
  WORK_TOOL_CHROME_ROW,
  WORK_TOOL_PRIMARY_BUTTON,
  WORK_TOOL_SECTION_LABEL_TEXT,
  WorkToolChromeButton,
  WorkToolEmptyLine,
} from "../terminals/workToolChrome";
import { WorkToolPreviewControls } from "../terminals/workToolPreviewControls";
import { H264VideoCanvas } from "./H264VideoCanvas";
import { MacDesktopAgentCursor } from "./MacDesktopAgentCursor";
import { macDesktopApi } from "./macDesktopApi";
import {
  MacDesktopPermissionCard,
  macDesktopMissingPermissions,
  type MacDesktopPermissionCheck,
} from "./MacDesktopPermissionCard";
import { MAC_DESKTOP_SECONDARY_BUTTON, MacDesktopStateCard } from "./MacDesktopStateCard";
import { MAC_DESKTOP_NOT_ANSWERING } from "./macDesktopStatusStore";
import { MacDesktopStatusStrip, type MacDesktopStripMessage } from "./MacDesktopStatusStrip";
import { useWorkToolsMaximize } from "../terminals/workToolsMaximize";
import {
  displayFrameToViewRect,
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
import { MacDesktopClaimPicker } from "./MacDesktopClaimPicker";
import {
  MAC_DESKTOP_LIST_ROW,
  MAC_DESKTOP_LIST_TITLE,
  MacDesktopAppIcon,
  MacDesktopMinimizedBadge,
  MacDesktopRowAction,
} from "./macDesktopWindowList";
import { macDesktopClaimAppIcons } from "./macDesktopClaimPicker.logic";
import { macDesktopErrorText } from "./macDesktopErrorText";
import { useMacDesktopMachineFacts } from "./useMacDesktopMachineFacts";
import {
  macDesktopParkedWindows,
  macDesktopPresentAction,
  macDesktopRelativeTime,
  macDesktopStatusPill,
  macDesktopStatusSegments,
  macDesktopStripControls,
  macDesktopWindowTitle,
} from "./macDesktopStrip";

/**
 * The lane's private macOS screen, as a Work tools pane tool.
 *
 * There is no device picker: a lane that has the tool has exactly one screen,
 * and choosing it is not a decision anybody has. Opening the tab never creates
 * that screen, as opening the Apple tool never boots a device. A lane with no
 * display shows "Mac Desktop is off." and Start. The pane is the screen, a
 * one-line strip above it, and a one-line window list below.
 *
 * Nothing here is gated on `process.platform`. This exact component runs on a
 * Windows or Linux desktop watching a Mac-hosted lane: the display, the driver
 * and the encoder all live on the runtime host, and the only thing that crosses
 * is H.264 and JSON. The two places the viewer's own machine matters are named
 * explicitly — `status.hostIsLocal` gates "Bring to my screen", and a permission
 * grant can only be opened on the Mac that needs it.
 */

/**
 * Where full screen sits in the renderer's one z stack.
 *
 * Above the app's own modal family (9998-10001) and the Linear overlays
 * (10000). Full screen is a takeover of the ADE window; anything drawn on
 * top of it would be chrome about something the user cannot see. The claim
 * picker is given one step more than this so a picker opened FROM full
 * screen is still in front of it.
 */
export const MAC_DESKTOP_FULLSCREEN_Z = 40_000;

/** The picture's breathing room inside the overlay, in CSS px. */
const MAC_DESKTOP_FULLSCREEN_MARGIN = 16;

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

/* ── The Apps list ──────────────────────────────────────────────────────── */

/**
 * One parked window, as a row in the Apps section.
 *
 * A row and not a card: the first version drew a 28px initials tile ("GB") next
 * to the app's name printed twice, over two lines, inside a bordered box — a
 * 44px card per window in a 240px column, for a list whose whole job is to name
 * three windows. It is the app's own list row now, the same one the pane's Apps
 * list and the Add app picker use, so both lists look like one list.
 *
 * The app's name leads and the window's own title follows, muted: the app is
 * what a person recognises, the title is what tells its windows apart. No
 * ownership words — a window is either on this desktop (listed) or it is not.
 *
 * Memoised per window: a frame arriving or the pane resizing re-renders the
 * panel several times a second, and nothing on this row changes on any of them.
 */
type MacDesktopWindowCardProps = {
  window: MacDesktopWindow;
  selected: boolean;
  /** Resolved PNG for this app. The window row may not carry one of its own. */
  iconPng: string | null;
  onSelect: (windowId: number) => void;
  onRelease: (windowId: number) => void;
};

const MacDesktopWindowCard = memo(function MacDesktopWindowCard({
  window: entry,
  selected,
  iconPng,
  onSelect,
  onRelease,
}: MacDesktopWindowCardProps) {
  const title = macDesktopWindowTitle(entry);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-testid="mac-desktop-window-card"
      data-window-id={entry.id}
      onClick={() => onSelect(entry.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(entry.id);
      }}
      title={title}
      className={cn(
        // A card, not a row: the list wraps left to right, so each one is a
        // fixed rectangle and the wrap point is the pane's width rather than
        // one window per line down the whole panel.
        "group flex h-8 w-[196px] shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 text-left",
        "border border-border/50 bg-surface transition-colors duration-[120ms] ease-out",
        "cursor-default",
        selected
          ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]"
          : "hover:bg-white/[0.05]",
      )}
    >
      <MacDesktopAppIcon iconPng={iconPng ?? entry.iconPng} appName={entry.appName} />
      {/* The window's own title is the card's tooltip: it is what tells two
          windows of one app apart, and it does not fit on the face. */}
      <span className={cn(MAC_DESKTOP_LIST_TITLE, "text-[11.5px]")}>{entry.appName}</span>
      {entry.minimized ? <MacDesktopMinimizedBadge /> : null}
      <MacDesktopRowAction
        label="Release"
        testId="mac-desktop-window-release"
        title={`Send “${title}” back to your main screen`}
        onClick={() => onRelease(entry.id)}
      />
    </div>
  );
});

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

export function ChatMacDesktopPanel({
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

  /* ── Render ──────────────────────────────────────────────────────────── */

  // Hidden entirely when the host cannot host a display. The tab is hidden too
  // (`workToolAvailability`); this is the case where the tab was already open
  // when the answer arrived.
  if (supported === false) {
    return (
      <WorkToolEmptyLine
        testId="mac-desktop-unsupported"
        title={status?.unsupportedReason ?? "This lane's runtime host cannot host a Mac display."}
      />
    );
  }

  /**
   * Every screen without a picture keeps a slim top row with the per-chat
   * floating-preview toggle, as the Apple tool's rail does. The Off, permission
   * and waiting screens used to return early with no row at all, so the toggle
   * was only reachable once a display was live.
   */
  const idle = (screen: ReactNode) => (
    <div className="relative flex h-full min-h-0 flex-col gap-2" data-testid="mac-desktop-panel">
      <div className={cn(WORK_TOOL_CHROME_ROW, "flex-nowrap justify-end gap-1")} data-testid="mac-desktop-idle-row">
        <WorkToolPreviewControls tool="mac-desktop" chatSessionId={sessionId} showMaximize={false} />
      </div>
      <div className="min-h-0 flex-1">{screen}</div>
    </div>
  );

  // A stop in flight wins over whatever the last status said. The host keeps
  // listing the display until the stop lands, and showing it live meanwhile is
  // the flicker a reopened tab used to have.
  if (stopping) {
    return idle(<MacDesktopStateCard testId="mac-desktop-stopping" tone="busy" title="Stopping Mac Desktop…" />);
  }

  if (!display) {
    /*
      No display: one state at a time, in this order, each on the same card.

        Stopping  a stop is in flight (above, whether or not a display shows)
        Starting  the person pressed Start here
        Checking  the first read has not answered (it times out into the next)
        Not answering  the newest read failed: Try again, or Reset
        Permissions    a grant is off: the permission card
        Failed    a Start that failed: the reason, and Start again
        Off       "Mac Desktop is off" and Start

      Watching never creates a display, and nothing on this list starts one
      except the person's Start. That is the fix for a pane that went from Off
      to Starting on its own: "Check again" used to start a display when the
      grants came back.
    */
    const resetButton = (
      <button
        type="button"
        data-testid="mac-desktop-reset"
        className={MAC_DESKTOP_SECONDARY_BUTTON}
        onClick={() => void stopDisplay()}
      >
        <Power size={14} />
        Reset
      </button>
    );
    if (starting) {
      return idle(
        <MacDesktopStateCard
          testId="mac-desktop-starting"
          tone="busy"
          title="Starting Mac Desktop…"
          detail="Making a private screen for this lane."
        />
      );
    }
    if (status == null || (unconfirmed && readError)) {
      if (!readError) {
        return idle(<MacDesktopStateCard testId="mac-desktop-checking" tone="busy" title="Checking Mac Desktop…" />);
      }
      return idle(
        <MacDesktopStateCard
          testId="mac-desktop-unreachable"
          tone="error"
          title="Can't reach Mac Desktop"
          detail={readError}
          actions={(
            <>
              <button
                type="button"
                data-testid="mac-desktop-read-again"
                className={WORK_TOOL_PRIMARY_BUTTON}
                onClick={() => void readAgain()}
              >
                Try again
              </button>
              {resetButton}
            </>
          )}
        />
      );
    }
    if (missingPermissions.length > 0) {
      return idle(
        <MacDesktopPermissionCard
          variant="page"
          permissions={status.permissions}
          appName={status.responsibleAppName ?? "ADE"}
          signing={status.signing ?? "unknown"}
          hostIsLocal={laneHostIsLocal}
          machineName={machineFacts.machineName}
          checking={checkingPermissions}
          lastCheck={permissionCheck}
          onOpenSettings={(kind) => openSettingsPane(SETTINGS_PANE[kind])}
          onCheckAgain={() => void checkAgain()}
          onStartAnyway={missingPermissions.includes("screenRecording") ? null : () => void start()}
        />
      );
    }
    if (statusError) {
      return idle(
        <MacDesktopStateCard
          testId="mac-desktop-failed"
          tone="error"
          title={gaveUp ? "Mac Desktop did not start" : "Something went wrong"}
          detail={statusError}
          actions={(
            <button
              type="button"
              data-testid="mac-desktop-start"
              className={WORK_TOOL_PRIMARY_BUTTON}
              onClick={() => void start()}
            >
              <Monitor size={14} />
              Start again
            </button>
          )}
        />
      );
    }
    return idle(
      <MacDesktopStateCard
        testId="mac-desktop-off"
        tone="idle"
        title="Mac Desktop is off"
        detail="A private screen for this lane's apps."
        footer={appsLeftOpen.length > 0 ? (
          /* The apps the stop could not quit, in the driver's own sentence.
             Nothing at all when every app quit. */
          <ul className="flex w-full min-w-0 flex-col gap-1.5 text-left" data-testid="mac-desktop-apps-left-open">
            {appsLeftOpen.map((app) => (
              <li
                key={app.pid}
                data-testid="mac-desktop-app-left-open"
                className="flex min-w-0 items-start gap-2 font-sans text-xs leading-5 text-muted-fg"
              >
                <span className="min-w-0 flex-1 break-words">{app.message}</span>
                <button
                  type="button"
                  className="shrink-0 text-muted-fg underline-offset-2 hover:text-fg hover:underline"
                  onClick={() => dismissAppLeftOpen(app.pid)}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        actions={(
          <button
            type="button"
            data-testid="mac-desktop-start"
            className={WORK_TOOL_PRIMARY_BUTTON}
            onClick={() => void start()}
          >
            <Monitor size={14} />
            Start
          </button>
        )}
      />
    );
  }

  /**
   * The inline permission line for a LIVE display.
   *
   * The denied first screen (no display yet) is the real block above; this is
   * the reminder while a display exists and one grant was revoked mid-session.
   */
  const pill = macDesktopStatusPill({ live: live.status, lease, iHaveControl });
  const statusSegments = macDesktopStatusSegments(pill);
  // The dot's tooltip is the only place the strip still says the state in words:
  // the name/status text that used to lead the row was the confusing part.
  const statusTooltip = [statusSegments.status, statusSegments.detail].filter(Boolean).join(" · ");
  const selectedWindow = parkedWindows.find((entry) => entry.id === selectedWindowId) ?? null;
  /* Where the selected window sits on the picture. A positioned div over the
     canvas, never a second canvas: it moves when the pane resizes and when the
     window moves, and a compositor layer is the whole cost. */
  const selectedRect = selectedWindow
    ? displayFrameToViewRect({ frame: selectedWindow.frame, rect: viewRect, display })
    : null;
  const presentAction = macDesktopPresentAction({
    hostIsLocal: Boolean(status?.hostIsLocal),
    ownedCount: windows.filter((entry) => entry.laneId === laneId).length,
    parkedCount: parkedWindows.length,
  });
  const controls = macDesktopStripControls({
    expanded,
    hostIsLocal: Boolean(status?.hostIsLocal),
    ownedCount: windows.filter((entry) => entry.laneId === laneId).length,
    parkedCount: parkedWindows.length,
  });
  /* ── The chrome row, built once and drawn in two places ───────────────

     The pane's 40px row and full screen's bar carry the SAME controls, which
     is the whole correction: full screen used to carry three of them and then
     fade even those out, so the owner arrived at a picture with no status, no
     Record, no Take over and no way back. Both rows are in the tree at once —
     the pane keeps rendering normally behind the overlay so leaving full
     screen is a z-index change and not a remount — so everything here is
     per-scope, including the testids. */

  /**
   * The one state mark left in the row: a small coloured dot with a tooltip.
   *
   * The strip used to lead with "ADE · <lane> · Live · Idle" in text, which was
   * the bulk of what made the pane read as confusing. The live/idle state is
   * still true and worth a glance, so it stays as a dot; the words move into
   * the tooltip, and the lane name and window count are gone from the strip
   * entirely (the Apps section below states the windows).
   */
  const renderStatusDot = (scope: MacDesktopChromeScope) => (
    <span
      title={statusTooltip}
      aria-label={statusTooltip}
      data-testid={scope === "pane" ? "mac-desktop-live-chip" : "mac-desktop-fs-live-chip"}
      className="inline-flex size-7 shrink-0 items-center justify-center"
    >
      <span
        data-testid={scope === "pane" ? "mac-desktop-live-dot" : "mac-desktop-fs-live-dot"}
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          pill.tone === "live" ? "bg-emerald-400" : pill.tone === "error" ? "bg-rose-400/85" : "bg-amber-400",
        )}
      />
    </span>
  );

  const renderChromeRow = (scope: MacDesktopChromeScope) => {
    const suffix = scope === "pane" ? "" : "-fs";
    return (
      <>
        {renderStatusDot(scope)}

        {/* The per-chat floating-preview toggle, beside the dot at the left.
            At the far right it was the first thing a narrow MacBook pane
            clipped, and the owner could not find it. Maximize is
            `mac-desktop-expand` below, so this adds only the toggle. */}
        <WorkToolPreviewControls
          tool="mac-desktop"
          chatSessionId={sessionId}
          showMaximize={false}
          testIdSuffix={suffix}
        />

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {iHaveControl ? (
            <span
              className="mr-1 flex shrink-0 items-center gap-1.5 whitespace-nowrap px-1 text-[12px] text-amber-200"
              data-testid={`mac-desktop-takeover-banner${suffix}`}
            >
              You have control
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => void returnControl()}
              >
                Return to agent
              </button>
              <span className="text-[10px] text-muted-fg">Esc</span>
            </span>
          ) : null}

          <WorkToolChromeButton
            label={recording?.running ? "Stop recording" : "Record this screen"}
            onClick={() => void toggleRecording()}
            disabled={busy}
            active={recording?.running ?? false}
            testId={`mac-desktop-record${suffix}`}
          >
            {recording?.running ? <Stop size={16} weight="fill" /> : <Record size={16} weight="fill" />}
          </WorkToolChromeButton>

          <WorkToolChromeButton
            label={screenshotPending ? "Saving screenshot…" : "Save screenshot"}
            onClick={() => void saveScreenshot()}
            disabled={screenshotPending}
            testId={`mac-desktop-screenshot${suffix}`}
          >
            <Camera size={16} />
          </WorkToolChromeButton>

          {presentAction ? (
            <WorkToolChromeButton
              label={presentAction.label}
              onClick={() => void present(presentAction.destination)}
              disabled={busy}
              testId={`mac-desktop-present${suffix}`}
            >
              <ArrowSquareIn size={16} />
            </WorkToolChromeButton>
          ) : null}

          {iHaveControl ? null : (
            <WorkToolChromeButton
              label="Take over"
              onClick={() => void takeControl()}
              disabled={busy}
              testId={`mac-desktop-takeover${suffix}`}
            >
              <Cursor size={16} />
            </WorkToolChromeButton>
          )}

          {/* Always here while a display exists: the way out that does not
              depend on the picture, the lease or the video working. */}
          <WorkToolChromeButton
            label="Stop Mac Desktop"
            onClick={() => setConfirmStop(true)}
            disabled={stopping}
            active={confirmStop}
            testId={`mac-desktop-stop${suffix}`}
          >
            <Power size={16} />
          </WorkToolChromeButton>

          {/* The way out, spelled out in full screen and an icon in the pane —
              the one control whose label is a fact about where the row is. */}
          {scope === "fullscreen" ? (
            <button
              type="button"
              data-testid="mac-desktop-expand-fs"
              onClick={() => setExpanded(false)}
              className={cn(
                WORK_TOOL_CHROME_CHIP,
                "ml-1 shrink-0 gap-1.5 whitespace-nowrap px-2 text-fg/90 hover:bg-white/[0.08]",
              )}
            >
              <ArrowsInSimple size={14} />
              {controls.fullscreen.label}
              <span className="text-[10px] text-muted-fg">Esc</span>
            </button>
          ) : (
            <WorkToolChromeButton
              label={paneMaximize?.maximized ? "Restore pane" : controls.fullscreen.label}
              onClick={() => {
                if (paneMaximize) paneMaximize.setMaximized(!paneMaximize.maximized);
                else setExpanded(true);
              }}
              testId="mac-desktop-expand"
            >
              {paneMaximize?.maximized ? <ArrowsInSimple size={16} /> : <ArrowsOutSimple size={16} />}
            </WorkToolChromeButton>
          )}
        </div>
      </>
    );
  };

  /* ── The picture ──────────────────────────────────────────────────────

     One renderer, drawn in the pane and again in the full-screen overlay. The
     canvas itself is in NEITHER: it lives in a detached host node that is moved
     between the two slots, so entering and leaving full screen never unmounts
     the decoder and the stream is not restarted. Everything drawn ON the
     picture — the frame, the window outline, both cursors — is rendered only in
     the copy that is currently on screen, and positioned from that copy's own
     measured rect. */

  const renderPicture = (scope: MacDesktopChromeScope) => {
    const active = scope === (expanded ? "fullscreen" : "pane");
    return (
      <div
        ref={active ? attachSurface : undefined}
        role={iHaveControl && active ? "application" : undefined}
        tabIndex={iHaveControl && active ? 0 : -1}
        data-testid={scope === "pane" ? "mac-desktop-surface" : "mac-desktop-surface-fs"}
        data-control={iHaveControl ? "user" : "agent"}
        /*
          The pane's own surface, not a black box.

          The first version painted `bg-black/60` under a canvas that keeps its
          aspect ratio, so before the first frame the pane was a black
          rectangle, and after it a black letterbox band above and below the
          picture. The surrounding area is the panel's surface colour now and
          the canvas draws the display's aspect ratio on top of it.
        */
        style={scope === "pane"
          ? { aspectRatio: `${display.width} / ${display.height}` }
          : { width: "100%", height: "100%" }}
        className={cn(
          "relative flex items-center justify-center overflow-hidden bg-surface-recessed",
          scope === "pane" ? "w-full max-h-full" : "rounded-[10px] shadow-float",
          // While the user is driving, the pointer they see is the one drawn
          // at the lane's Mac coordinates, not this machine's arrow.
          "cursor-default",
        )}
        title={iHaveControl ? undefined : "Click to take control"}
        /* Pointer, wheel and key handling are native listeners bound to this
           node while it is the active copy — see the effect on `surfaceNode`. */
      >
        {/* Where the decoder's canvas is parked while this copy is the one on
            screen. Empty in the other copy, which is behind an opaque overlay
            or not expanded. */}
        {active && handoverFrame ? (
          <img
            src={handoverFrame}
            alt=""
            aria-hidden="true"
            draggable={false}
            data-testid="mac-desktop-handover-frame"
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
          />
        ) : null}
        <div ref={active ? attachCanvasSlot : undefined} className="absolute inset-0" />

        {/* Only the wait is painted on the picture here. A stopped or stuck
            video is the overlay card's to say, because it has the Reconnect.
            The handover frame is the picture while the decoder connects. */}
        {active && !handoverFrame && live.status !== "playing" && live.status !== "error" && !connectSlow ? (
          <p
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 text-center text-[12px] text-muted-fg"
            data-testid="mac-desktop-surface-status"
          >
            {/* Without a start in flight the display is already up and only the
                video is connecting, as on the Apple pane. */}
            {starting ? "Starting Mac Desktop…" : "Connecting video"}
          </p>
        ) : null}

        {/*
          What the pointer is doing, because a locked pointer is a mode and an
          unexplained mode is a trap: the cursor vanishes, the mouse stops
          reaching the rest of the screen, and nothing says how to get out.
        */}
        {active && iHaveControl && live.status === "playing" ? (
          <span
            className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/85 backdrop-blur-sm"
            data-testid={`mac-desktop-pointer-hint-${scope}`}
          >
            Driving this screen
          </span>
        ) : null}

        {/*
          The frame, drawn on the picture rather than around the pane.

          `pointer-events-none` on purpose: this is chrome, and every gesture
          underneath it belongs to the surface, including the ones that land in
          the letterbox and are refused there.
        */}
        {active && contentBox && contentBox.width > 0 ? (
          <span
            aria-hidden
            data-testid="mac-desktop-frame"
            className={cn(
              "pointer-events-none absolute z-[9] rounded-[10px]",
              iHaveControl
                ? "shadow-[inset_0_0_0_2px_rgb(251_191_36_/_0.8)]"
                : "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)]",
            )}
            style={{
              left: contentBox.offsetX,
              top: contentBox.offsetY,
              width: contentBox.width,
              height: contentBox.height,
            }}
          />
        ) : null}

        {active && selectedRect ? (
          <span
            aria-hidden
            data-testid="mac-desktop-window-outline"
            className="pointer-events-none absolute z-[9] rounded-[4px] shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-accent)_85%,transparent)]"
            style={{
              left: selectedRect.left,
              top: selectedRect.top,
              width: selectedRect.width,
              height: selectedRect.height,
            }}
          />
        ) : null}

        {/* Glides between action points and fades once the agent is idle. */}
        {active ? <MacDesktopAgentCursor point={cursorPoint} /> : null}

      </div>
    );
  };

  /**
   * The pane's one strip, most pressing thing first.
   *
   * A refusal or a note about the capture the person just made leads, because
   * it answers the click they made. A missing grant comes next: it is usually WHY the video or the mouse
   * is not working, so it outranks their symptoms. Real input and a capture
   * both fail while the picture is fine, so neither may write `statusError` —
   * that slot titles the EMPTY state.
   */
  const inputErrorText = realInput.inputError
    ? macDesktopErrorText(realInput.inputError, { laneId, laneName })
    : null;
  const stripMessage = ((): MacDesktopStripMessage | null => {
    // The host did not answer the newest read. Everything below may be out of
    // date, so this outranks every symptom it could be causing.
    if (unconfirmed) {
      return {
        key: `unconfirmed:${readError ?? ""}`,
        tone: "error",
        sentence: "Mac Desktop is not answering. This picture may be out of date.",
        detail: readError === MAC_DESKTOP_NOT_ANSWERING ? null : readError,
        actions: [
          { label: "Try again", onClick: () => void readAgain() },
          { label: "Reset", onClick: () => setConfirmStop(true) },
        ],
        testId: "mac-desktop-unconfirmed",
      };
    }
    if (statusError) {
      return {
        key: `status:${statusError}`,
        tone: "error",
        sentence: statusError,
        onDismiss: () => setStatusError(null),
        testId: "mac-desktop-status-error",
      };
    }
    if (captureError) {
      return {
        key: `capture:${captureError}`,
        tone: "error",
        sentence: captureError,
        onDismiss: () => setCaptureError(null),
        testId: "mac-desktop-capture-error",
      };
    }
    if (captureNotice) {
      return {
        key: `notice:${captureNotice}`,
        tone: "notice",
        sentence: captureNotice,
        onDismiss: () => setCaptureNotice(null),
        testId: "mac-desktop-capture-notice",
      };
    }
    if (inputErrorText) {
      return {
        key: `input:${inputErrorText}`,
        tone: "error",
        sentence: inputErrorText,
        onDismiss: realInput.clearInputError,
        testId: "mac-desktop-input-error",
      };
    }
    // A missing grant is not a strip line any more: it is the permission card
    // under the top row, which names the grant, its path and its one button.
    // The video's own state is not a strip line either: it is drawn on the
    // picture (`renderVideoOverlay`), where the problem is.
    return null;
  })();

  /**
   * The video's trouble, on the picture it is about.
   *
   * This used to be the top strip: a full-width red bar reading "Video
   * stopped." with RECONNECT and DETAILS in red capitals, which the owner
   * called the message up top that did not fit. It is now a small card over
   * the picture, in the Apple pane's tone: one sentence, one Reconnect, and
   * Details as a quiet link that folds the raw reason open.
   *
   * A sibling of the surface, never a child: the surface takes control on any
   * pointer-down, and pressing Reconnect must not also grab the lease.
   */
  const renderVideoOverlay = (scope: MacDesktopChromeScope) => {
    if (scope !== (expanded ? "fullscreen" : "pane")) return null;
    const stopped = live.status === "error";
    if (!stopped && !connectSlow) return null;
    const detail = stopped ? macDesktopErrorText(live.error, { laneId, laneName }) : null;
    const suffix = scope === "pane" ? "" : "-fs";
    return (
      <div className="pointer-events-none absolute inset-0 z-[12] flex items-center justify-center p-3">
        <div
          role="status"
          data-testid={`${stopped ? "mac-desktop-video-stopped" : "mac-desktop-connect-slow"}${suffix}`}
          className="pointer-events-auto flex max-w-[320px] flex-col items-center gap-2 rounded-[12px] border border-border/70 bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)] px-4 py-3 text-center font-sans shadow-float"
        >
          <p className="text-[13px] font-medium text-fg">
            {stopped ? "Video stopped" : "The picture is not coming through"}
          </p>
          <p className="text-[12px] leading-5 text-muted-fg">
            {stopped ? "Mac Desktop is still running." : "Mac Desktop is up, but no video has arrived yet."}
          </p>
          <div className="flex items-center gap-3">
            {/* A fresh `startStream`, budget included: the automatic retries
                give up after a few tries, and this is the way back after that. */}
            <button type="button" className={cn(WORK_TOOL_PRIMARY_BUTTON, "h-7")} onClick={live.restart}>
              Reconnect
            </button>
            {stopped && detail ? (
              <button
                type="button"
                aria-expanded={videoDetailsOpen}
                className="text-[12px] text-muted-fg underline-offset-2 hover:text-fg hover:underline"
                onClick={() => setVideoDetailsOpen((open) => !open)}
              >
                Details
              </button>
            ) : null}
            {stopped ? null : (
              <button
                type="button"
                className="text-[12px] text-muted-fg underline-offset-2 hover:text-fg hover:underline"
                onClick={() => setConfirmStop(true)}
              >
                Stop
              </button>
            )}
          </div>
          {stopped && detail && videoDetailsOpen ? (
            <p className="max-w-full break-words text-left font-mono text-[11px] leading-4 text-muted-fg">{detail}</p>
          ) : null}
        </div>
      </div>
    );
  };

  /** Missing grants while a display is live: the card, not a strip line. */
  const renderPermissionNotice = () => (missingPermissions.length > 0 && status ? (
    <MacDesktopPermissionCard
      variant="inline"
      permissions={status.permissions}
      appName={status.responsibleAppName ?? "ADE"}
      signing={status.signing ?? "unknown"}
      hostIsLocal={laneHostIsLocal}
      machineName={machineFacts.machineName}
      checking={checkingPermissions}
      lastCheck={permissionCheck}
      onOpenSettings={(kind) => openSettingsPane(SETTINGS_PANE[kind])}
      onCheckAgain={() => void checkAgain()}
    />
  ) : null);

  /**
   * "Stop Mac Desktop?", asked in the pane like the Apple pane asks before it
   * switches devices. Stop quits the apps the lane opened and sends the
   * windows it borrowed back to the main screen.
   */
  const renderStopConfirm = () => (confirmStop ? (
    <div
      role="alertdialog"
      aria-label="Stop Mac Desktop?"
      data-testid="mac-desktop-stop-confirm"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 font-sans text-[12px] text-fg"
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium">Stop Mac Desktop?</span>
        <span className="text-muted-fg"> Apps it opened quit, even with unsaved work. Windows you moved here go back to your main screen.</span>
      </span>
      <button
        type="button"
        className={cn(MAC_DESKTOP_SECONDARY_BUTTON, "h-7")}
        onClick={() => setConfirmStop(false)}
      >
        Keep running
      </button>
      <button
        type="button"
        data-testid="mac-desktop-stop-confirm-yes"
        className={cn(
          MAC_DESKTOP_SECONDARY_BUTTON,
          "h-7 border-[color-mix(in_srgb,var(--color-error)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-error)_26%,transparent)]",
        )}
        onClick={stopNow}
      >
        Stop
      </button>
    </div>
  ) : null);

  /**
   * The recording pill and the "Saved to proof" receipt, over the picture.
   *
   * Siblings of the surface, never children: the surface takes control on
   * any pointer-down, and a Stop or an Open must not also grab the lease.
   * Lifted clear of the "Driving this screen" hint while the person drives.
   */
  const renderCaptureOverlay = (scope: MacDesktopChromeScope) => {
    if (scope !== (expanded ? "fullscreen" : "pane")) return null;
    const driving = iHaveControl && live.status === "playing";
    const inset = scope === "fullscreen" ? MAC_DESKTOP_FULLSCREEN_MARGIN + 12 : 12;
    const bottom = inset + (driving ? 32 : 0);
    return (
      <>
        {recording?.running ? (
          <RecordingPill
            marker={{ "data-testid": `mac-desktop-recording-pill${scope === "pane" ? "" : "-fs"}` }}
            elapsedMs={Math.max(0, nowTick - (Date.parse(recording.startedAt ?? "") || nowTick))}
            onStop={() => void toggleRecording()}
            stopDisabled={busy}
            className="z-[11]"
            style={{ bottom }}
          />
        ) : null}
        {receipt ? (
          <RecordingSavedRow
            marker={{ "data-testid": `mac-desktop-saved-receipt${scope === "pane" ? "" : "-fs"}` }}
            durationMs={receipt.durationMs}
            bytes={receipt.bytes}
            onOpen={() => openReceipt(receipt)}
            onDismiss={() => setReceipt(null)}
            style={{ bottom, left: inset, right: inset }}
          />
        ) : null}
      </>
    );
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2" data-testid="mac-desktop-panel">
      {/* ── Add app, over the whole pane ─────────────────────────────────

          The picker used to be drawn INLINE where the list goes, so it opened
          in a short box under the preview and the thing it was adding to was
          the thing it replaced. It covers the pane instead: opaque, its own
          scroll box, and the preview keeps streaming behind it.

          Inside this panel rather than a window-level modal on purpose — it
          belongs to this lane's desktop, and a second pane in another window
          must not have its picker taken over by this one. */}
      {pickerOpen ? (
        <div
          className="absolute inset-0 z-20 flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-sm)] border border-border bg-surface"
          data-testid="mac-desktop-picker-overlay"
        >
          <MacDesktopClaimPicker
            inline
            laneId={laneId}
            displayId={display?.displayId}
            laneNames={laneNames}
            windows={claimable}
            loading={claimableLoading}
            error={claimError}
            onRefresh={() => void refreshClaimable()}
            onClaim={claimWindow}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      ) : null}

      {/* The decoder, mounted once and never moved in the React tree. Its host
          node is what travels between the pane and the overlay. */}
      {videoHost && live.url
        ? createPortal(
            <H264VideoCanvas
              url={live.url}
              reconnectNonce={live.reconnectNonce}
              onStatus={live.onStatus}
              onDimensions={live.onDimensions}
              onCanvas={live.onCanvas}
              className={live.status === "playing" ? undefined : "opacity-0"}
            />,
            videoHost,
          )
        : null}

      {/* ── Strip ─────────────────────────────────────────────────────────

          One row that holds its line from 600px up: two short text chips on
          the left, icon buttons on the right, and nothing in between that can
          grow. `flex-nowrap` is the guarantee; `min-w-0` + `truncate` on the
          status pill is what it spends when the pane gets narrow. */}
      <div className={cn(WORK_TOOL_CHROME_ROW, "relative flex-nowrap gap-1")}>
        {renderChromeRow("pane")}
      </div>
      {/* ── The one strip ─────────────────────────────────────────────
          A missing grant, a refused action, or a stopped video, one at a
          time and each with the button that fixes it. */}
      <MacDesktopStatusStrip message={stripMessage} suffix="" />
      {renderStopConfirm()}
      {renderPermissionNotice()}

      {/* ── The screen, and the windows on it ───────────────────────────

          Stacked in the tall tools column the pane usually is, side by side
          once it is appreciably wider than tall. The picture is pinned under
          the strip at the display's own aspect ratio in both, which is what
          removed the ~350px of empty pane that used to sit above a vertically
          centred 16:9 image. */}
      <div
        data-testid="mac-desktop-body"
        data-layout="stacked"
        // Always stacked, picture above Apps. The side-by-side mode for wide
        // panes put the list to the RIGHT of the picture, which is not where
        // the owner asked for it and read as a second toolbar.
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      >
        <div className="relative flex w-full min-w-0 shrink-0 flex-col items-stretch">
          {renderPicture("pane")}
          {renderCaptureOverlay("pane")}
          {renderVideoOverlay("pane")}
        </div>

        {/* ── Apps ────────────────────────────────────────────────────────

            The lane's desktop, named in the user's vocabulary: one card per
            window parked here, wrapping left to right, and a trailing button
            that opens the picker over the whole pane. No lease/claim words —
            a window is on this desktop or it is not. */}
        <div
          data-testid="mac-desktop-apps"
          className="flex min-h-0 shrink-0 flex-col gap-0.5"
        >
          <div className="flex h-7 items-center gap-1 px-1" data-testid="mac-desktop-apps-header">
            <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Apps</span>
          </div>

          {/* The cards wrap left to right, and the way to add one is the last
              thing in the same run rather than a button in the heading. With
              nothing here yet it is the only thing in the run, so the empty
              state needs no button of its own. */}
          <div className="flex flex-wrap items-center gap-1.5 px-1" data-testid="mac-desktop-apps-list">
            {parkedWindows.map((entry) => (
              <MacDesktopWindowCard
                key={entry.id}
                window={entry}
                selected={entry.id === selectedWindowId}
                iconPng={claimAppIcons[entry.bundleId ?? entry.appName] ?? entry.iconPng ?? null}
                onSelect={selectWindow}
                onRelease={releaseWindowById}
              />
            ))}
            <button
              type="button"
              data-testid="mac-desktop-add-app"
              onClick={() => setPickerOpen(true)}
              title="Add an app to this desktop"
              className={cn(
                "flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2",
                "border border-dashed border-border/70 text-[11.5px] text-muted-fg",
                "transition-colors duration-[120ms] ease-out hover:bg-white/[0.06] hover:text-fg",
              )}
            >
              <Plus size={12} />
              {parkedWindows.length ? <span className="sr-only">Add app</span> : "Add app"}
            </button>
          </div>

        </div>

        {/* ── Activity ────────────────────────────────────────────────
            What happened on this screen that the picture does not show: a
            window that would not move over, and the agent's last look.

            These used to be two differently styled lines, one of them a
            footer pinned under the whole pane, which read as a stray log.
            They are one list now, in the Apps section's row shape: a glyph,
            one truncating line, and a fixed right-hand column. */}
        {notParked.length > 0 || lastObservation ? (
          <div className="flex min-h-0 shrink-0 flex-col gap-0.5" data-testid="mac-desktop-activity">
            <div className="flex h-7 items-center gap-1 px-1">
              <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Activity</span>
            </div>
            <ul className="flex flex-col">
              {notParked.map((entry) => {
                const label = windows.find((candidate) => candidate.id === entry.windowId)?.title?.trim()
                  || `Window ${entry.windowId}`;
                const sentence = macDesktopNotParkedSentence(label, entry.reason);
                return (
                  <li
                    key={entry.windowId}
                    data-testid="mac-desktop-not-parked"
                    className="group flex h-8 min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 text-[12px] hover:bg-white/[0.04]"
                  >
                    <WarningCircle size={14} weight="fill" className="shrink-0 text-[var(--color-warning)]" />
                    <span className="min-w-0 flex-1 truncate text-fg/85" title={sentence}>{sentence}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[11px] text-muted-fg transition-colors hover:bg-white/[0.07] hover:text-fg"
                      data-testid="mac-desktop-not-parked-dismiss"
                      onClick={() => dismissNotParked(entry.windowId)}
                    >
                      Dismiss
                    </button>
                  </li>
                );
              })}
              {lastObservation ? (
                <li
                  data-testid="mac-desktop-last-observation"
                  className="flex h-8 min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 text-[12px] hover:bg-white/[0.04]"
                >
                  {lastFrame ? (
                    <img
                      src={lastFrame.dataUrl}
                      alt=""
                      aria-hidden
                      className="h-5 w-[34px] shrink-0 rounded-[3px] object-cover opacity-85 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_60%,transparent)]"
                    />
                  ) : (
                    <Cursor size={14} className="shrink-0 text-muted-fg/80" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-fg/85" title={lastObservation.caption ?? undefined}>
                    <span className="text-muted-fg">Agent looked · </span>
                    {lastObservation.caption ?? "this screen"}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-fg">
                    {`${macDesktopRelativeTime(lastObservation.at, Date.now())} · ${lastObservation.elementCount} items`}
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>

      {/*
        ── Full screen ──────────────────────────────────────────────────

        A portal to `document.documentElement`, covering the ADE window. The
        expanded picture used to sit in a box that left the Work sidebar
        showing through beside it. From `html`, `fixed` + viewport units are
        the window. Opaque page background, chrome on top, picture filling
        the rest. X / Esc puts the pane back.
      */}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            <div
              data-testid="mac-desktop-fullscreen"
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                width: "100vw",
                height: "100vh",
                zIndex: MAC_DESKTOP_FULLSCREEN_Z,
                background: "var(--color-bg)",
              }}
              className="flex flex-col"
            >
              <div
                data-testid="mac-desktop-fullscreen-chrome"
                className={cn(
                  WORK_TOOL_CHROME_ROW,
                  "relative z-10 shrink-0 flex-nowrap gap-1 border-b border-white/[0.06] px-3",
                )}
              >
                {renderChromeRow("fullscreen")}
              </div>
              <MacDesktopStatusStrip message={stripMessage} suffix="-fs" />
              {confirmStop || missingPermissions.length > 0 ? (
                <div className="flex shrink-0 flex-col gap-2 px-4 pt-3">
                  {renderStopConfirm()}
                  {renderPermissionNotice()}
                </div>
              ) : null}
              <div
                className="relative flex min-h-0 flex-1 items-stretch justify-stretch"
                style={{ padding: MAC_DESKTOP_FULLSCREEN_MARGIN }}
              >
                {renderPicture("fullscreen")}
                {renderCaptureOverlay("fullscreen")}
                {renderVideoOverlay("fullscreen")}
              </div>
            </div>,
            document.documentElement,
          )
        : null}
    </div>
  );
}
