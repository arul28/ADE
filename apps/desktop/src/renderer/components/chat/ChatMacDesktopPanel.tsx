import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowSquareIn,
  ArrowsInSimple,
  ArrowsOutSimple,
  CaretDown,
  Cursor,
  Monitor,
  Record,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { macDesktopNotParkedPhrase } from "../../../shared/types/macDesktop";
import type {
  MacDesktopDisplay,
  MacDesktopLeaseState,
  MacDesktopPermissionKind,
  MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import type { SystemSettingsPaneId } from "../../../shared/types/systemSettings";
import { cn } from "../ui/cn";
import { MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import {
  WORK_TOOL_CHROME_CHIP,
  WORK_TOOL_CHROME_META,
  WORK_TOOL_CHROME_ROW,
  WORK_TOOL_PRIMARY_BUTTON,
  WorkToolChromeButton,
  WorkToolEmptyLine,
} from "../terminals/workToolChrome";
import { H264VideoCanvas } from "./H264VideoCanvas";
import { macDesktopApi } from "./macDesktopApi";
import { MacDesktopPermissionBlock } from "./MacDesktopPermissionBlock";
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
import { useMacDesktopRealInput } from "./useMacDesktopRealInput";
import { useMacDesktopStatus } from "./useMacDesktopStatus";
import { MacDesktopClaimPicker, MacDesktopLeaseChip } from "./MacDesktopClaimPicker";
import {
  MAC_DESKTOP_TAKEOVER_CURSOR_HIDDEN_CLASS,
  MacDesktopTakeoverCursor,
} from "./MacDesktopTakeoverCursor";
import {
  MAC_DESKTOP_LIST_HEADER,
  MAC_DESKTOP_LIST_META,
  MAC_DESKTOP_LIST_ROW,
  MAC_DESKTOP_LIST_TITLE,
  MacDesktopAppIcon,
  MacDesktopMinimizedBadge,
  MacDesktopRowAction,
} from "./macDesktopWindowList";
import { macDesktopClaimAppIcons, macDesktopHasLease } from "./macDesktopClaimPicker.logic";
import { macDesktopErrorText } from "./macDesktopErrorText";
import { useMacDesktopMachineFacts } from "./useMacDesktopMachineFacts";
import {
  macDesktopIsWidePane,
  macDesktopParkedWindows,
  macDesktopPresentAction,
  macDesktopRelativeTime,
  macDesktopStatusPill,
  macDesktopStatusSegments,
  macDesktopStripControls,
  macDesktopStripName,
  macDesktopWindowRowText,
  macDesktopWindowTitle,
} from "./macDesktopStrip";

/**
 * The lane's private macOS screen, as a Work tools pane tool.
 *
 * What this component is NOT: a launcher. There is no "create a display" card
 * and no device picker — opening the tab starts the display, because a lane
 * that has the tool has exactly one screen and choosing it is not a decision
 * anybody has. The pane is the screen, a one-line strip above it, and a one-line
 * window list below.
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

/* ── The windows rail ───────────────────────────────────────────────────── */

/**
 * One parked window, as a row.
 *
 * A row and not a card: the first version drew a 28px initials tile ("GB") next
 * to the app's name printed twice, over two lines, inside a bordered box — a
 * 44px card per window in a 240px column, for a list whose whole job is to name
 * three windows. It is the app's own list row now, the same one the Windows
 * menu and the claim picker use, so the three places this app lists windows
 * look like one list.
 *
 * There is no "observe" action. Observing is what the AGENT does to a window
 * before it acts on it; an eye button offering a person the chance to queue an
 * agent capture was a piece of the agent's plumbing wearing a human control's
 * clothes.
 *
 * Memoised per window: a frame arriving, a lease renewing or the pane resizing
 * re-renders the panel several times a second, and nothing on this row changes
 * on any of them.
 */
type MacDesktopWindowCardProps = {
  window: MacDesktopWindow;
  owned: boolean;
  selected: boolean;
  /** Resolved PNG for this app. The window row may not carry one of its own. */
  iconPng: string | null;
  onSelect: (windowId: number) => void;
  onRelease: (windowId: number) => void;
};

const MacDesktopWindowCard = memo(function MacDesktopWindowCard({
  window: entry,
  owned,
  selected,
  iconPng,
  onSelect,
  onRelease,
}: MacDesktopWindowCardProps) {
  const text = macDesktopWindowRowText(entry);
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
      className={cn(
        MAC_DESKTOP_LIST_ROW,
        "cursor-default",
        selected
          ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]"
          : "hover:bg-white/[0.05]",
      )}
    >
      <MacDesktopAppIcon iconPng={iconPng ?? entry.iconPng} appName={entry.appName} />
      <span className={MAC_DESKTOP_LIST_TITLE} title={macDesktopWindowTitle(entry)}>
        {text.primary}
      </span>
      {entry.minimized ? <MacDesktopMinimizedBadge /> : null}
      {owned ? <MacDesktopLeaseChip /> : null}
      {text.secondary ? (
        <span className={MAC_DESKTOP_LIST_META} title={text.secondary}>{text.secondary}</span>
      ) : null}
      <MacDesktopRowAction
        label="Release"
        testId="mac-desktop-window-release"
        title={`Release “${macDesktopWindowTitle(entry)}” back to your screen`}
        onClick={() => onRelease(entry.id)}
      />
    </div>
  );
});

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
    refresh: refreshStatus,
    start,
    starting,
    cursor,
    notParked,
    dismissNotParked,
  } = useMacDesktopStatus({
    laneId,
    laneName,
    sessionId,
    runtimePin,
    machineName: machineFacts.machineName,
    machineVersion: machineFacts.machineVersion,
  });
  /**
   * Which chrome row has its Windows menu open, if either.
   *
   * A scope and not a boolean: the pane's row and full screen's bar are both in
   * the tree at the same time now, and a shared boolean opened two menus at
   * once — one of them behind an opaque overlay.
   */
  const [windowsOpenScope, setWindowsOpenScope] = useState<MacDesktopChromeScope | null>(null);
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
   * A recording toggle that failed, kept OUT of `statusError`.
   *
   * `statusError` is the display-state slot: it titles the empty state when
   * the display is gone. A failed `stopRecording` on a lane whose recorder the
   * helper already closed used to be written there and then surfaced as
   * "Lane <uuid> is not recording." over an empty pane — an error about the
   * wrong thing, in the wrong place, with an id in it.
   */
  const [recordingError, setRecordingError] = useState<string | null>(null);
  // The line belongs to one lane's recorder; a lane change starts a new one.
  useEffect(() => {
    setRecordingError(null);
  }, [laneId]);
  const [viewRect, setViewRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  /** The pane's own box, which decides stacked vs side by side. */
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 });
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
  const bodyRef = useRef<HTMLDivElement | null>(null);

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
   * The one permission that is blocking, and which pane it opens.
   *
   * Screen Recording first when both are missing: without it there is no
   * picture at all, so it is the grant that changes what the user can see. The
   * pane ids are the app-level ones from `SYSTEM_SETTINGS_PANE_URLS`, which is
   * the one table main resolves against — the renderer never holds the URL.
   * Computed above the empty-state branch because the denied first screen is
   * its own block, not the one-line start card.
   */
  const blockedPermission: {
    kind: MacDesktopPermissionKind;
    pane: SystemSettingsPaneId;
  } | null =
    status?.permissions.screenRecording === "denied"
      ? { kind: "screenRecording", pane: "macos-screen-recording" }
      : status?.permissions.accessibility === "denied"
        ? { kind: "accessibility", pane: "macos-accessibility" }
        : null;

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

  /* ── Geometry ────────────────────────────────────────────────────────── */

  useEffect(() => {
    const node = surfaceNode;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setViewRect((current) =>
        current.left === rect.left && current.top === rect.top
          && current.width === rect.width && current.height === rect.height
          ? current
          : { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
    };
  }, [display?.displayId, surfaceNode]);

  /**
   * The pane's box, measured the same way the picture's is.
   *
   * Separate from `viewRect` on purpose: that one is the stream surface, whose
   * size is an OUTPUT of this decision, so reading the layout mode off it would
   * be a loop that settles one frame late in one direction and oscillates in
   * the other.
   */
  useEffect(() => {
    const node = bodyRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setBodySize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [display?.displayId]);

  const wide = macDesktopIsWidePane(bodySize.width, bodySize.height);

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

  const realInput = useMacDesktopRealInput({
    laneId,
    sessionId,
    controllerId: macDesktopControllerId(),
    enabled: iHaveControl,
    toDisplayPoint,
    runtimePin,
  });

  useEffect(() => {
    if (!iHaveControl) realInput.clearInputError();
  }, [iHaveControl, realInput.clearInputError]);

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
      const next = recording?.running
        ? await macDesktopApi().stopRecording({ laneId, chatSessionId: sessionId }, pinRef.current)
        : await macDesktopApi().startRecording({ laneId, chatSessionId: sessionId }, pinRef.current);
      setStatus((current) => (current ? { ...current, recording: next } : current));
      setRecordingError(null);
    } catch (error) {
      setRecordingError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [display, errorText, recording?.running, sessionId, setStatus]);

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
   * Escape leaves the expanded screen.
   *
   * Capturing, and before the surface's own key handler: while the user holds
   * the lease every key on that surface is forwarded to the lane's Mac, so an
   * Escape typed to get out of full screen would otherwise go to whatever app
   * is focused over there and never come back here.
   */
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  useEffect(() => {
    if (!expanded || typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.add("ade-mac-desktop-fullscreen");
    return () => root.classList.remove("ade-mac-desktop-fullscreen");
  }, [expanded]);

  /**
   * Full screen closes its own Windows menu on the way out.
   *
   * The two rows share one scope, so a menu left open in full screen would come
   * back as a menu hanging under the pane's row the next time it is opened.
   */
  useEffect(() => {
    setWindowsOpenScope((current) => (current === (expanded ? "pane" : "fullscreen") ? null : current));
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
   * "Check again": restart the helper, re-probe, and start only if the grant is
   * now there.
   *
   * The restart is the point. macOS usually will not show a grant made after a
   * process started to that same process, so re-reading the old helper's cached
   * "denied" is exactly the retry that never worked. `start()` then runs only
   * when Screen Recording is not denied, because creating a display without it
   * can only fail again with the same error.
   */
  const checkAgain = useCallback(async () => {
    setCheckingPermissions(true);
    setStatusError(null);
    try {
      const permissions = await macDesktopApi().recheckPermissions(
        { restartDriver: true },
        pinRef.current,
      );
      setStatus((current) => (current ? { ...current, permissions } : current));
      if (permissions.screenRecording !== "denied") {
        await start();
      } else {
        await refreshStatus();
      }
    } catch (error) {
      setStatusError(errorText(error));
    } finally {
      setCheckingPermissions(false);
    }
  }, [errorText, refreshStatus, start, setStatus, setStatusError]);

  /**
   * "Ask macOS": the explicit local prompt. Only ever drawn for a display on
   * this computer, and the host refuses it for a remote caller regardless.
   */
  const askMacos = useCallback(async (which: MacDesktopPermissionKind) => {
    setCheckingPermissions(true);
    setStatusError(null);
    try {
      const permissions = await macDesktopApi().requestPermission({ which }, pinRef.current);
      setStatus((current) => (current ? { ...current, permissions } : current));
    } catch (error) {
      setStatusError(errorText(error));
    } finally {
      setCheckingPermissions(false);
    }
  }, [errorText, setStatus, setStatusError]);

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

  if (!display) {
    /*
      An absent display with a settled status is a start, not a spinner.
  
      The auto-start only runs on mount, so after `mac-desktop stop` the pane
      used to sit on "Starting…" forever, and a stale action error used to take
      its place. `statusError` is the display's own failure (a denied
      permission, a refused create), and the manual start is idempotent, so
      both the retry and the stopped case get the same button.
    */
    const settled = status != null && !starting;
    /*
      A denied grant is its own screen, not the one-line start card. The card
      offered a single "Try again" that re-read a cached "denied" and changed
      nothing, which is the exact bug this block replaces. The block leads with
      the two things that can actually change the state: opening the pane, and a
      restart-and-reprobe.
    */
    if (blockedPermission) {
      return (
        <MacDesktopPermissionBlock
          kind={blockedPermission.kind}
          appName={status?.responsibleAppName ?? "ADE"}
          signing={status?.signing ?? "unknown"}
          hostIsLocal={laneHostIsLocal}
          machineName={machineFacts.machineName}
          checking={checkingPermissions}
          onOpenSettings={() => openSettingsPane(blockedPermission.pane)}
          onCheckAgain={() => void checkAgain()}
          onAskMacos={laneHostIsLocal ? () => void askMacos(blockedPermission.kind) : null}
        />
      );
    }
    return (
      <WorkToolEmptyLine
        testId="mac-desktop-starting"
        title={statusError
          ?? (settled ? "Start Mac Desktop for this lane" : "Starting this lane's screen…")}
        action={statusError || settled ? (
          <button
            type="button"
            className={WORK_TOOL_PRIMARY_BUTTON}
            onClick={() => void (statusError ? checkAgain() : start())}
          >
            <Monitor size={14} />
            {statusError ? "Try again" : "Start Mac Desktop"}
          </button>
        ) : undefined}
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
  // "ADE · <lane>", the display's own name, leading the strip's status chip.
  const stripName = macDesktopStripName({ displayName: display.name, laneName });
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
  const notParkedNewest = notParked[0] ?? null;
  // The window's own title when the lane still knows it, and its id when it
  // does not — an id is what the user can find in Mission Control, a title is
  // what they already see on their screen.
  const notParkedLabel = notParkedNewest
    ? windows.find((entry) => entry.id === notParkedNewest.windowId)?.title?.trim()
      || String(notParkedNewest.windowId)
    : null;

  /* ── The chrome row, built once and drawn in two places ───────────────

     The pane's 40px row and full screen's bar carry the SAME controls, which
     is the whole correction: full screen used to carry three of them and then
     fade even those out, so the owner arrived at a picture with no status, no
     window list, no Record, no Take over and no way back. Both rows are in the
     tree at once — the pane keeps rendering normally behind the overlay so
     leaving full screen is a z-index change and not a remount — so everything
     here is per-scope, including the testids and which one owns the open
     Windows menu. */

  const renderStatusChip = (scope: MacDesktopChromeScope) => (
    <span
      className={cn(
        WORK_TOOL_CHROME_META,
        "inline-flex min-w-0 shrink items-center gap-1.5 whitespace-nowrap px-1",
      )}
      data-testid={scope === "pane" ? "mac-desktop-live-chip" : "mac-desktop-fs-live-chip"}
    >
      <span
        className={cn(
          "size-[6px] shrink-0 rounded-full",
          pill.tone === "live" ? "bg-emerald-400" : pill.tone === "error" ? "bg-rose-400/85" : "bg-amber-400",
        )}
      />
      {/*
        The name truncates first, the detail second, and the status word never:
        the takeover controls are wide, and "Live · Idle" collapsing into a
        sliver that read as a bare separator is what this split prevents.
      */}
      {stripName ? (
        <>
          <span className="min-w-0 truncate" title={stripName}>{stripName}</span>
          <span aria-hidden="true" className="shrink-0 text-muted-fg/50">·</span>
        </>
      ) : null}
      <span className="shrink-0">{statusSegments.status}</span>
      {statusSegments.detail ? (
        <>
          <span aria-hidden="true" className="shrink-0 opacity-60">{statusSegments.separator}</span>
          <span className="min-w-0 truncate">{statusSegments.detail}</span>
        </>
      ) : null}
    </span>
  );

  /**
   * "Windows N", and the menu behind it.
   *
   * The menu is where an empty screen is answered now. The card that used to
   * float over the picture said the same thing much louder — a headline, a
   * paragraph and a text field asking for an app name — on top of the one
   * thing the pane exists to show. An empty screen is a fact about the window
   * list, so it is stated in the window list, and the chip wears a dot so the
   * menu is worth opening.
   */
  const renderWindowsChip = (scope: MacDesktopChromeScope) => {
    const open = windowsOpenScope === scope;
    const suffix = scope === "pane" ? "" : "-fs";
    return (
      <div className="relative shrink-0">
        <button
          type="button"
          className={cn(WORK_TOOL_CHROME_CHIP, "shrink-0 whitespace-nowrap")}
          aria-expanded={open}
          data-testid={`mac-desktop-windows-toggle${suffix}`}
          onClick={() => setWindowsOpenScope((current) => (current === scope ? null : scope))}
        >
          Windows
          <span className="tabular-nums">{parkedWindows.length}</span>
          {parkedWindows.length === 0 ? (
            <span
              aria-hidden
              data-testid={`mac-desktop-windows-dot${suffix}`}
              className="size-[5px] shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_70%,transparent)]"
            />
          ) : null}
          <CaretDown size={10} />
        </button>
        {open ? (
          <div
            className={cn(
              MENU_SURFACE_CLASS,
              /* In the pane the menu spans the strip row, which is the only
                 width always available: the tools pane can be ~240px wide and
                 an overflow-hidden ancestor clips anything that leaves it — a
                 left-anchored menu lost its app and Release columns off the
                 right edge, a right-anchored one lost "ADE lease" off the
                 left. Full screen has the whole window, so there the menu is
                 anchored to its own chip at a readable width. */
              "absolute top-full z-[60] mt-1 max-h-[280px] overflow-auto",
              scope === "pane" ? "inset-x-0" : "left-0 w-[min(420px,calc(100vw-32px))]",
            )}
            data-testid={`mac-desktop-windows-menu${suffix}`}
          >
            {parkedWindows.length ? (
              <p className={MAC_DESKTOP_LIST_HEADER}>
                <span className="min-w-0 flex-1 truncate">On this screen</span>
                <span className="shrink-0 tabular-nums text-muted-fg/60">{parkedWindows.length}</span>
              </p>
            ) : (
              <p className="px-2 py-1.5 text-[11.5px] text-muted-fg" data-testid={`mac-desktop-windows-empty${suffix}`}>
                No windows on this screen
              </p>
            )}
            {parkedWindows.map((entry) => {
              const text = macDesktopWindowRowText(entry);
              return (
                <div key={entry.id} className={MAC_DESKTOP_LIST_ROW} data-testid="mac-desktop-windows-row">
                  <MacDesktopAppIcon
                    iconPng={claimAppIcons[entry.bundleId ?? entry.appName] ?? entry.iconPng}
                    appName={entry.appName}
                  />
                  <span className={MAC_DESKTOP_LIST_TITLE} title={macDesktopWindowTitle(entry)}>
                    {text.primary}
                  </span>
                  {entry.minimized ? <MacDesktopMinimizedBadge /> : null}
                  {/* Ownership, stated where the window is listed: a lane can be
                      watching a window it does not hold, and the chip is the
                      only place that difference is visible. */}
                  {macDesktopHasLease(entry, laneId) ? <MacDesktopLeaseChip /> : null}
                  {text.secondary ? (
                    <span className={MAC_DESKTOP_LIST_META} title={text.secondary}>{text.secondary}</span>
                  ) : null}
                  <MacDesktopRowAction
                    label="Release"
                    testId="mac-desktop-windows-release"
                    title={`Release “${macDesktopWindowTitle(entry)}” back to your screen`}
                    onClick={() => void releaseWindow(entry.id)}
                  />
                </div>
              );
            })}
            {/* The one way into the picker from the strip. The dropdown used
                to inline a second list of every claimable window, which made
                a menu that answered two questions badly. */}
            <button
              type="button"
              className={cn(
                MAC_DESKTOP_LIST_ROW,
                "mt-0.5 border-t border-white/[0.06] text-[12px] text-fg/85 hover:bg-white/[0.05]",
              )}
              data-testid={`mac-desktop-claim-another${suffix}`}
              onClick={() => { setWindowsOpenScope(null); setPickerOpen(true); }}
            >
              <ArrowSquareIn size={13} className="shrink-0 text-muted-fg/70" />
              {parkedWindows.length ? "Claim another…" : "Claim a window…"}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderChromeRow = (scope: MacDesktopChromeScope) => {
    const suffix = scope === "pane" ? "" : "-fs";
    return (
      <>
        {renderStatusChip(scope)}

        {renderWindowsChip(scope)}

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
          "relative flex items-center justify-center overflow-hidden bg-surface",
          scope === "pane" ? "w-full max-h-full" : "rounded-[10px] shadow-float",
          // While the user is driving, the pointer they see is the one drawn
          // at the lane's Mac coordinates, not this machine's arrow.
          iHaveControl ? MAC_DESKTOP_TAKEOVER_CURSOR_HIDDEN_CLASS : "cursor-pointer",
        )}
        title={iHaveControl ? undefined : "Click to take control"}
        /* Pointer, wheel and key handling are native listeners bound to this
           node while it is the active copy — see the effect on `surfaceNode`. */
      >
        {/* Where the decoder's canvas is parked while this copy is the one on
            screen. Empty in the other copy, which is behind an opaque overlay
            or not expanded. */}
        <div ref={active ? attachCanvasSlot : undefined} className="absolute inset-0" />

        {active && live.status !== "playing" ? (
          <p
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 text-center text-[12px] text-muted-fg"
            data-testid="mac-desktop-surface-status"
          >
            {macDesktopErrorText(live.error) ?? (live.url ? "Starting display…" : "Connecting to the lane's screen…")}
          </p>
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

        {active ? (
          <MacDesktopTakeoverCursor
            feed={realInput.cursorFeed}
            rect={viewRect}
            display={display}
            active={iHaveControl}
          />
        ) : null}

        {active && cursorPoint ? (
          <span
            aria-hidden
            data-testid="mac-desktop-agent-cursor"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 text-accent"
            style={{ left: cursorPoint.x, top: cursorPoint.y }}
          >
            <Cursor size={16} weight="fill" />
          </span>
        ) : null}

      </div>
    );
  };

  /**
   * One amber line for a refusal that belongs to an action, not the display.
   *
   * Real input and a recording toggle both fail while the picture is fine, so
   * neither may write `statusError` — that slot titles the EMPTY state, and the
   * recording refusal used to end up there with the lane's raw uuid in it.
   */
  const renderStripErrorLine = (
    suffix: string,
    testId: string,
    message: string | null,
    onDismiss: () => void,
  ) => (
    message ? (
      <div
        className="flex w-full items-start gap-2 px-1 text-left text-[12px] text-amber-300"
        data-testid={`${testId}${suffix}`}
      >
        <WarningCircle size={12} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 whitespace-normal break-words">
          {message}
        </span>
        <button
          type="button"
          className="mt-0.5 shrink-0 rounded-[4px] p-0.5 text-amber-200/80 hover:bg-white/[0.06] hover:text-amber-100"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X size={12} />
        </button>
      </div>
    ) : null
  );

  const renderInputErrorLine = (suffix: string) => renderStripErrorLine(
    suffix,
    "mac-desktop-input-error",
    realInput.inputError ? macDesktopErrorText(realInput.inputError, { laneId, laneName }) : null,
    realInput.clearInputError,
  );

  const renderRecordingErrorLine = (suffix: string) => renderStripErrorLine(
    suffix,
    "mac-desktop-recording-error",
    recordingError,
    () => setRecordingError(null),
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="mac-desktop-panel">
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

      {/* ── Permission banner over a live picture ──────────────────────
          The picture streams without Accessibility; the mouse does not work.
          The banner names the grant and carries the same two buttons as the
          first screen, so the fix is never a hunt through System Settings. */}
      {blockedPermission ? (
        <div
          data-testid="mac-desktop-permission"
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[10px] border border-amber-400/25 bg-amber-400/[0.08] px-3 py-2 text-[12px] text-amber-100"
        >
          <WarningCircle size={14} className="shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1">
            {blockedPermission.kind === "screenRecording"
              ? `Screen Recording is off for ${status?.responsibleAppName ?? "ADE"}${laneHostIsLocal ? "" : ` on ${machineFacts.machineName ?? "the lane's Mac"}`}. The picture cannot stream.`
              : `Accessibility is off for ${status?.responsibleAppName ?? "ADE"}${laneHostIsLocal ? "" : ` on ${machineFacts.machineName ?? "the lane's Mac"}`}. The mouse and keyboard do nothing until it is on.`}
          </span>
          {laneHostIsLocal ? (
            <button
              type="button"
              className={cn(WORK_TOOL_PRIMARY_BUTTON, "h-7 px-2.5 text-[11.5px]")}
              onClick={() => openSettingsPane(blockedPermission.pane)}
            >
              {`Open ${blockedPermission.kind === "screenRecording" ? "Screen Recording" : "Accessibility"} settings`}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-[8px] border border-amber-300/30 px-2.5 text-[11.5px] font-medium text-amber-100 hover:bg-amber-400/15 disabled:opacity-50"
            onClick={() => void checkAgain()}
            disabled={checkingPermissions}
          >
            {checkingPermissions ? "Checking…" : "Check again"}
          </button>
        </div>
      ) : null}

      {/* ── The screen, and the windows on it ───────────────────────────

          Stacked in the tall tools column the pane usually is, side by side
          once it is appreciably wider than tall. The picture is pinned under
          the strip at the display's own aspect ratio in both, which is what
          removed the ~350px of empty pane that used to sit above a vertically
          centred 16:9 image. */}
      <div
        ref={bodyRef}
        data-testid="mac-desktop-body"
        data-layout={wide ? "wide" : "stacked"}
        className={cn("flex min-h-0 flex-1 gap-2", wide ? "flex-row" : "flex-col overflow-y-auto")}
      >
        <div className={cn("flex min-w-0 shrink-0 flex-col items-stretch", wide ? "h-full flex-1" : "w-full")}>
          {renderInputErrorLine("")}
          {renderRecordingErrorLine("")}
          {renderPicture("pane")}
        </div>

        {/* ── The windows rail ────────────────────────────────────────────

            One row per parked window, under the picture or beside it, in the
            app's own list row. Nothing at all when the screen is empty — that
            case is answered in the Windows menu, and a rail with a "nothing
            here" line under a chip that already says so is the same sentence
            twice. */}
        {parkedWindows.length || lastObservation ? (
          <div
            data-testid="mac-desktop-rail"
            className={cn(
              "flex min-h-0 flex-col gap-0.5",
              wide ? "w-[280px] max-w-[280px] shrink-0 overflow-y-auto" : "shrink-0",
            )}
          >
            {parkedWindows.map((entry) => (
              <MacDesktopWindowCard
                key={entry.id}
                window={entry}
                owned={macDesktopHasLease(entry, laneId)}
                selected={entry.id === selectedWindowId}
                iconPng={claimAppIcons[entry.bundleId ?? entry.appName] ?? entry.iconPng ?? null}
                onSelect={selectWindow}
                onRelease={releaseWindowById}
              />
            ))}

            {/* ── The agent's last look ─────────────────────────────────
                One row: what the AGENT last did to this screen, when, how much
                it saw, and the frame it saw it on when the live view has one to
                lend. Named for whose action it is — "Last observation" read
                like something the person watching had done. */}
            {lastObservation ? (
              <div
                className="mt-1 flex items-center gap-2 px-1 text-[11px] text-muted-fg"
                data-testid="mac-desktop-last-observation"
              >
                {lastFrame ? (
                  <img
                    src={lastFrame.dataUrl}
                    alt=""
                    aria-hidden
                    className="h-7 w-[46px] shrink-0 rounded-[4px] object-cover opacity-80 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_60%,transparent)]"
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate" title={lastObservation.caption ?? undefined}>
                  <span className="text-muted-fg/70">Agent’s last look</span>
                  <span className="px-1 opacity-60">·</span>
                  {lastObservation.caption ?? "Looked at this screen"}
                </span>
                <span className="shrink-0 tabular-nums">
                  {macDesktopRelativeTime(lastObservation.at, Date.now())}
                  <span className="px-1 opacity-60">·</span>
                  {`${lastObservation.elementCount} elements`}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/*
        ── A window that would not go ──────────────────────────────────

        The service forwards `window-not-parked` precisely because the window is
        still on the user's OWN screen, and until this line existed the only
        surface that knew was the event log. Newest only: the list holds three so
        a repeat replaces the entry instead of stacking, but the footer has room
        for one sentence and the second one would push the screen up.
      */}
      {notParkedNewest ? (
        <p
          className="flex items-center gap-2 px-1 text-[11px] text-amber-300"
          data-testid="mac-desktop-not-parked"
        >
          <WarningCircle size={12} className="shrink-0" />
          <span className="truncate">
            {`Window ${notParkedLabel} ${macDesktopNotParkedPhrase(notParkedNewest.reason)}. It is still on your main screen.`}
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 underline underline-offset-2"
            data-testid="mac-desktop-not-parked-dismiss"
            onClick={() => dismissNotParked(notParkedNewest.windowId)}
          >
            Dismiss
          </button>
        </p>
      ) : null}

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
              {renderInputErrorLine("-fs")}
              {renderRecordingErrorLine("-fs")}
              <div
                className="flex min-h-0 flex-1 items-stretch justify-stretch"
                style={{ padding: MAC_DESKTOP_FULLSCREEN_MARGIN }}
              >
                {renderPicture("fullscreen")}
              </div>
            </div>,
            document.documentElement,
          )
        : null}

      {pickerOpen ? (
        <MacDesktopClaimPicker
          laneId={laneId}
          displayId={display?.displayId}
          laneNames={laneNames}
          windows={claimable}
          loading={claimableLoading}
          error={claimError}
          onRefresh={() => void refreshClaimable()}
          onClaim={claimWindow}
          onClose={() => setPickerOpen(false)}
          /* One step above full screen, so a picker opened from inside the
             overlay is still in front of it. */
          zIndex={expanded ? MAC_DESKTOP_FULLSCREEN_Z + 1 : undefined}
        />
      ) : null}
    </div>
  );
}
