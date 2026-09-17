import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareIn,
  ArrowsInSimple,
  ArrowsOutSimple,
  CaretDown,
  Cursor,
  Eye,
  Monitor,
  SignOut,
  Record,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { macDesktopNotParkedPhrase } from "../../../shared/types/macDesktop";
import type {
  MacDesktopDisplay,
  MacDesktopLeaseState,
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
  MacDesktopMinimizedBadge,
  MacDesktopRowAction,
  MacDesktopWindowGlyph,
} from "./macDesktopWindowList";
import { macDesktopHasLease } from "./macDesktopClaimPicker.logic";
import { macDesktopErrorText } from "./macDesktopErrorText";
import {
  macDesktopAppGlyph,
  macDesktopIsWidePane,
  macDesktopParkedWindows,
  macDesktopPresentAction,
  macDesktopRelativeTime,
  macDesktopStatusPill,
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
 * How long full screen keeps its floating strip up with nothing happening.
 *
 * Two seconds: long enough to read the status and reach the button you just
 * revealed, short enough that a screen you are only watching is unobstructed.
 */
export const MAC_DESKTOP_CHROME_IDLE_MS = 2000;

/** How close to the top of the picture the pointer has to come to bring it back. */
export const MAC_DESKTOP_CHROME_EDGE_PX = 72;

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


/* ── The windows rail ───────────────────────────────────────────────────── */

/**
 * One parked window, as a card.
 *
 * The pane is a tall column and a 16:9 picture uses a third of it, so the space
 * under the picture is where the lane's windows are named — a row per window
 * with what it is, who holds it, and the two things you can do to it. The line
 * this replaces ("TextEdit — Untitled", centred under 300px of empty pane) named
 * the same windows and offered nothing.
 *
 * Memoised per window: a frame arriving, a lease renewing or the pane resizing
 * re-renders the panel several times a second, and nothing on this card changes
 * on any of them.
 */
type MacDesktopWindowCardProps = {
  window: MacDesktopWindow;
  owned: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: (windowId: number) => void;
  onRelease: (windowId: number) => void;
  /** Null when the surface cannot observe, which drops the action entirely. */
  onFocus: ((windowId: number) => void) | null;
};

const MacDesktopWindowCard = memo(function MacDesktopWindowCard({
  window: entry,
  owned,
  selected,
  busy,
  onSelect,
  onRelease,
  onFocus,
}: MacDesktopWindowCardProps) {
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
        "group flex w-full cursor-default items-center gap-2 rounded-[10px] px-2 py-1.5 text-left",
        "transition-colors duration-[120ms] ease-out",
        selected
          ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]"
          : "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_60%,transparent)] hover:bg-white/[0.04]",
      )}
    >
      <span
        aria-hidden
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-white/[0.07] font-sans text-[10px] font-semibold tracking-[0.02em] text-fg/75"
      >
        {macDesktopAppGlyph(entry.appName)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] text-fg/90" title={macDesktopWindowTitle(entry)}>
          {macDesktopWindowTitle(entry)}
        </span>
        <span className="truncate text-[11px] text-muted-fg">{entry.appName}</span>
      </span>
      {owned ? <MacDesktopLeaseChip /> : null}
      {onFocus ? (
        <button
          type="button"
          aria-label={`Observe ${macDesktopWindowTitle(entry)}`}
          title="Observe this window next"
          disabled={busy}
          data-testid="mac-desktop-window-focus"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-fg transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          onClick={(event) => { event.stopPropagation(); onFocus(entry.id); }}
        >
          <Eye size={13} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Release ${macDesktopWindowTitle(entry)}`}
        title="Release back to your screen"
        data-testid="mac-desktop-window-release"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-fg transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-fg"
        onClick={(event) => { event.stopPropagation(); onRelease(entry.id); }}
      >
        <SignOut size={13} />
      </button>
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
  const {
    status,
    setStatus,
    error: statusError,
    setError: setStatusError,
    refresh: refreshStatus,
    cursor,
    notParked,
    dismissNotParked,
  } = useMacDesktopStatus({ laneId, laneName, sessionId, runtimePin });
  const [windowsOpen, setWindowsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [claimable, setClaimable] = useState<MacDesktopWindow[]>([]);
  const [claimableLoading, setClaimableLoading] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  /**
   * Whether full screen is currently showing its floating strip.
   *
   * Full screen used to REMOVE the chrome: the pane's one row is drawn above
   * the picture, the expanded picture is `fixed inset-0` over the whole app,
   * and so the status, the window list and the button that got you here all
   * disappeared with no way back but Escape — which is not discoverable and is
   * also forwarded to the lane's Mac while you hold the lease. The chrome is
   * kept, floated over the picture, and it fades out on its own after
   * {@link MAC_DESKTOP_CHROME_IDLE_MS} so the screen is unobstructed while you
   * watch it. Pointing anywhere near the top edge brings it back.
   */
  const [chromeVisible, setChromeVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [viewRect, setViewRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  /** The pane's own box, which decides stacked vs side by side. */
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 });
  /** The window the rail is pointing at on the picture, if any. */
  const [selectedWindowId, setSelectedWindowId] = useState<number | null>(null);
  const [lastObservation, setLastObservation] = useState<MacDesktopLastObservation | null>(null);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;

  const display: MacDesktopDisplay | null = status?.display ?? null;
  const lease: MacDesktopLeaseState | null = status?.lease ?? null;
  const windows: MacDesktopWindow[] = status?.windows ?? [];
  const supported = status?.supported ?? null;
  const iHaveControl = macDesktopUserHasControl(lease, macDesktopControllerId());
  const parkedWindows = macDesktopParkedWindows(windows, display?.displayId);

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
    const node = surfaceRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setViewRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
    };
  }, [display?.displayId]);

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
   * Every way this view can stop being the controller.
   *
   * Unmount, the window losing focus, and the page going away are all the same
   * fact — nobody is driving — and a lease held by a view the user has walked
   * away from is exactly the state the agent waits forever on. The heartbeat
   * deadline is the backstop; these are the courtesies that make it rare.
   */
  useEffect(() => {
    if (!iHaveControl) return;
    const release = () => {
      heartbeat.stop();
      void returnControl();
    };
    window.addEventListener("blur", release);
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("blur", release);
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
      setStatusError(macDesktopErrorText(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }, [laneId, setStatus, setStatusError]);

  /* ── Real input, only while the user holds the lease ──────────────────── */

  const realInput = useMacDesktopRealInput({
    laneId,
    sessionId,
    controllerId: macDesktopControllerId(),
    enabled: iHaveControl,
    toDisplayPoint,
    runtimePin,
  });

  /* ── Recording and presenting ────────────────────────────────────────── */

  const recording = status?.recording ?? null;
  const toggleRecording = useCallback(async () => {
    setBusy(true);
    try {
      const next = recording?.running
        ? await macDesktopApi().stopRecording({ laneId, chatSessionId: sessionId }, pinRef.current)
        : await macDesktopApi().startRecording({ laneId, chatSessionId: sessionId }, pinRef.current);
      setStatus((current) => (current ? { ...current, recording: next } : current));
    } catch (error) {
      setStatusError(macDesktopErrorText(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }, [laneId, recording?.running, sessionId, setStatus, setStatusError]);

  const present = useCallback(async (destination: "main" | "display") => {
    setBusy(true);
    try {
      await macDesktopApi().present({ laneId, destination }, pinRef.current);
      await refreshStatus();
    } catch (error) {
      setStatusError(macDesktopErrorText(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }, [laneId, refreshStatus, setStatusError]);

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
      setClaimError(macDesktopErrorText(error instanceof Error ? error.message : String(error)));
    } finally {
      setClaimableLoading(false);
    }
  }, []);

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
      setClaimError(macDesktopErrorText(error instanceof Error ? error.message : String(error)));
      throw error;
    } finally {
      setBusy(false);
    }
  }, [laneId, refreshStatus, sessionId]);

  const releaseWindow = useCallback(async (windowId: number) => {
    try {
      await macDesktopApi().releaseWindow({ laneId, windowId }, pinRef.current);
    } catch (error) {
      setStatusError(macDesktopErrorText(error instanceof Error ? error.message : String(error)));
    }
  }, [laneId, setStatusError]);

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

  /**
   * Put one window's element tree into the next observation.
   *
   * `observe` with a `windowId` is the existing narrowing, so this is a real
   * call rather than a new capability: the agent's next look at the screen comes
   * back scoped to this window, and the observation event it emits is what
   * updates the line under the rail.
   */
  const observeWindow = useCallback(async (windowId: number) => {
    setBusy(true);
    try {
      await macDesktopApi().observe({ laneId, windowId, chatSessionId: sessionId }, pinRef.current);
    } catch (error) {
      setStatusError(macDesktopErrorText(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }, [laneId, sessionId, setStatusError]);

  /* Void-returning, stable identities, so a memoised card is not re-rendered
     by a new closure every time a frame lands. */
  const releaseWindowById = useCallback((windowId: number) => { void releaseWindow(windowId); }, [releaseWindow]);
  const observeWindowById = useCallback((windowId: number) => { void observeWindow(windowId); }, [observeWindow]);

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

  /**
   * Show the floating strip, and start its clock.
   *
   * ONE timer, in a ref, so the effects below and the surface's pointer move
   * cannot each be holding a deadline for the same strip — two timers is how a
   * bar hides itself half a second after you moved the mouse to reach it.
   */
  const chromeTimerRef = useRef<number | null>(null);
  const clearChromeTimer = useCallback(() => {
    if (chromeTimerRef.current != null) window.clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = null;
  }, []);
  const showChrome = useCallback((hold = false) => {
    setChromeVisible(true);
    clearChromeTimer();
    // `hold` is the Windows menu being open: a menu that closed itself two
    // seconds after you opened it would be the same defect in a smaller box.
    if (hold) return;
    chromeTimerRef.current = window.setTimeout(() => setChromeVisible(false), MAC_DESKTOP_CHROME_IDLE_MS);
  }, [clearChromeTimer]);

  /*
    Entering full screen shows the strip first — you have just pressed a button,
    and arriving at a picture with no chrome at all is the state this replaces.
    Leaving it puts the chrome back unconditionally, because the pane's own row
    is always visible and must never be left in a faded state.
  */
  useEffect(() => {
    if (!expanded) {
      clearChromeTimer();
      setChromeVisible(true);
      return;
    }
    showChrome(windowsOpen);
  }, [clearChromeTimer, expanded, showChrome, windowsOpen]);

  useEffect(() => () => clearChromeTimer(), [clearChromeTimer]);

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
    return (
      <WorkToolEmptyLine
        testId="mac-desktop-starting"
        title={statusError ?? "Starting this lane's screen…"}
        action={statusError ? (
          <button type="button" className={WORK_TOOL_PRIMARY_BUTTON} onClick={() => void refreshStatus()}>
            <Monitor size={14} />
            Try again
          </button>
        ) : undefined}
      />
    );
  }

  /**
   * The one permission line, and which pane it opens.
   *
   * Screen Recording first when both are missing: without it there is no
   * picture at all, so it is the grant that changes what the user can see. The
   * pane ids are the app-level ones from `SYSTEM_SETTINGS_PANE_URLS`, which is
   * the one table main resolves against — the renderer never holds the URL.
   */
  const blockedPermission: { message: string; pane: SystemSettingsPaneId } | null =
    status?.permissions.screenRecording === "denied"
      ? { message: "Screen Recording is off for ADE on the lane's Mac.", pane: "macos-screen-recording" }
      : status?.permissions.accessibility === "denied"
        ? { message: "Accessibility is off for ADE on the lane's Mac.", pane: "macos-accessibility" }
        : null;
  const pill = macDesktopStatusPill({ live: live.status, lease, iHaveControl });
  const selectedWindow = parkedWindows.find((entry) => entry.id === selectedWindowId) ?? null;
  /* Where the selected window sits on the picture. A positioned div over the
     canvas, never a second canvas: it moves when the pane resizes and when the
     window moves, and a compositor layer is the whole cost. */
  const selectedRect = selectedWindow
    ? displayFrameToViewRect({ frame: selectedWindow.frame, rect: viewRect, display })
    : null;
  const canObserve = typeof window.ade.macDesktop?.observe === "function";
  const presentAction = macDesktopPresentAction({
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

  /* ── The three controls the strip and full screen both carry ──────────
     Built here, once, and rendered in whichever of the two rows is on screen:
     the pane's 40px chrome row, or the bar floating over the expanded picture.
     Two copies of this JSX is how the expanded view ended up with no way back
     in the first place. */

  const statusChip = (
    <span
      className={cn(
        WORK_TOOL_CHROME_META,
        "inline-flex min-w-0 shrink items-center gap-1.5 whitespace-nowrap px-1",
      )}
      data-testid="mac-desktop-live-chip"
    >
      <span
        className={cn(
          "size-[6px] shrink-0 rounded-full",
          pill.tone === "live" ? "bg-emerald-400" : pill.tone === "error" ? "bg-rose-400/85" : "bg-amber-400",
        )}
      />
      <span className="truncate">
        {pill.label}
        <span className="px-1 opacity-60">·</span>
        {pill.detail}
      </span>
    </span>
  );

  const expandButton = (
    <WorkToolChromeButton
      label={expanded ? "Exit full screen" : "Full screen"}
      shortcut={expanded ? "Esc" : undefined}
      onClick={() => setExpanded((open) => !open)}
      active={expanded}
      testId="mac-desktop-expand"
    >
      {expanded ? <ArrowsInSimple size={16} /> : <ArrowsOutSimple size={16} />}
    </WorkToolChromeButton>
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
  const windowsChip = (
    <div className="shrink-0">
      <button
        type="button"
        className={cn(WORK_TOOL_CHROME_CHIP, "shrink-0 whitespace-nowrap")}
        aria-expanded={windowsOpen}
        data-testid="mac-desktop-windows-toggle"
        onClick={() => setWindowsOpen((open) => !open)}
      >
        Windows
        <span className="tabular-nums">{parkedWindows.length}</span>
        {parkedWindows.length === 0 ? (
          <span
            aria-hidden
            data-testid="mac-desktop-windows-dot"
            className="size-[5px] shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_70%,transparent)]"
          />
        ) : null}
        <CaretDown size={10} />
      </button>
      {windowsOpen ? (
        <div
          /* `max-w` in view units, not a fixed pixel cap: a window title is
             the only way to tell two windows of one app apart, and
             "TextEdit — Untit…" in a menu with room to spare was the pane
             refusing to say which one it holds. */
          className={cn(
            MENU_SURFACE_CLASS,
            /* Narrow enough to fit the pane, which is the only box that
               matters: the tools pane can be ~240px wide, an overflow-hidden
               ancestor clips anything wider, and both a right-anchored menu
               (clipped on the pane's left edge, "ADE lease" reading "DE
               lease") and a 420px left-anchored one (clipped on the right,
               losing the app and Release columns) were cut in half. The
               window title truncates instead. */
            /* Positioned against the STRIP ROW, not the chip: the chip sits
               near the left of a tools pane that can be 240px wide, and an
               overflow-hidden ancestor clips anything that leaves the pane —
               a left-anchored menu lost its app and Release columns off the
               right edge, a right-anchored one lost "ADE lease" off the left.
               Spanning the row is the only width that is always available. */
            "absolute inset-x-0 top-full z-50 mt-1 max-h-[280px] overflow-auto",
          )}
          data-testid="mac-desktop-windows-menu"
        >
          {parkedWindows.length ? (
            <p className={MAC_DESKTOP_LIST_HEADER}>
              <span className="min-w-0 flex-1 truncate">On this screen</span>
              <span className="shrink-0 tabular-nums text-muted-fg/60">{parkedWindows.length}</span>
            </p>
          ) : (
            <p className="px-2 py-1.5 text-[11.5px] text-muted-fg" data-testid="mac-desktop-windows-empty">
              No windows on this screen
            </p>
          )}
          {parkedWindows.map((entry) => (
            <div key={entry.id} className={MAC_DESKTOP_LIST_ROW} data-testid="mac-desktop-windows-row">
              <MacDesktopWindowGlyph />
              <span className={MAC_DESKTOP_LIST_TITLE} title={macDesktopWindowTitle(entry)}>
                {macDesktopWindowTitle(entry)}
              </span>
              {entry.minimized ? <MacDesktopMinimizedBadge /> : null}
              {/* Ownership, stated where the window is listed: a lane can be
                  watching a window it does not hold, and the chip is the
                  only place that difference is visible. */}
              {macDesktopHasLease(entry, laneId) ? <MacDesktopLeaseChip /> : null}
              <span className={MAC_DESKTOP_LIST_META} title={entry.appName}>{entry.appName}</span>
              <MacDesktopRowAction
                label="Release"
                testId="mac-desktop-windows-release"
                title={`Release “${macDesktopWindowTitle(entry)}” back to your screen`}
                onClick={() => void releaseWindow(entry.id)}
              />
            </div>
          ))}
          {/* The one way into the picker from the strip. The dropdown used
              to inline a second list of every claimable window, which made
              a menu that answered two questions badly. */}
          <button
            type="button"
            className={cn(
              MAC_DESKTOP_LIST_ROW,
              "mt-0.5 border-t border-white/[0.06] text-[12px] text-fg/85 hover:bg-white/[0.05]",
            )}
            data-testid="mac-desktop-claim-another"
            onClick={() => { setWindowsOpen(false); setPickerOpen(true); }}
          >
            <ArrowSquareIn size={13} className="shrink-0 text-muted-fg/70" />
            {parkedWindows.length ? "Claim another…" : "Claim a window…"}
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="mac-desktop-panel">
      {/* ── Strip ─────────────────────────────────────────────────────────

          One row that holds its line from 600px up: two short text chips on
          the left, icon buttons on the right, and nothing in between that can
          grow. `flex-nowrap` is the guarantee; `min-w-0` + `truncate` on the
          status pill is what it spends when the pane gets narrow. */}
      {expanded ? null : (
      <div className={cn(WORK_TOOL_CHROME_ROW, "relative flex-nowrap gap-1")}>
        {statusChip}

        {realInput.inputError ? (
          <button
            type="button"
            className={cn(WORK_TOOL_CHROME_CHIP, "max-w-[180px] truncate text-amber-300")}
            title={macDesktopErrorText(realInput.inputError) ?? undefined}
            data-testid="mac-desktop-input-error"
            onClick={realInput.clearInputError}
          >
            <WarningCircle size={11} />
            {macDesktopErrorText(realInput.inputError)}
          </button>
        ) : null}

        {windowsChip}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <WorkToolChromeButton
            label={recording?.running ? "Stop recording" : "Record this screen"}
            onClick={() => void toggleRecording()}
            disabled={busy}
            active={recording?.running ?? false}
            testId="mac-desktop-record"
          >
            {recording?.running ? <Stop size={16} weight="fill" /> : <Record size={16} weight="fill" />}
          </WorkToolChromeButton>

          {expandButton}

          {presentAction ? (
            <WorkToolChromeButton
              label={presentAction.label}
              onClick={() => void present(presentAction.destination)}
              disabled={busy}
              testId="mac-desktop-present"
            >
              <ArrowSquareIn size={16} />
            </WorkToolChromeButton>
          ) : null}

          <WorkToolChromeButton
            label={iHaveControl ? "Return control to the agent" : "Take over"}
            onClick={() => void (iHaveControl ? returnControl() : takeControl())}
            disabled={busy}
            active={iHaveControl}
            testId="mac-desktop-takeover"
          >
            <Cursor size={16} />
          </WorkToolChromeButton>
        </div>
      </div>
      )}

      {/* ── One-line permission state ─────────────────────────────────── */}
      {blockedPermission ? (
        <p className="flex items-center gap-2 px-1 text-[12px] text-amber-300" data-testid="mac-desktop-permission">
          <WarningCircle size={12} />
          {blockedPermission.message}
          {/*
            The opener only appears for a display hosted on THIS Mac. A grant is
            made on the machine the display lives on, so opening this computer's
            System Settings for a remote lane would send the user to the wrong
            box entirely — the sentence names that machine instead.
          */}
          {status?.hostIsLocal ? (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => openSettingsPane(blockedPermission.pane)}
            >
              Open System Settings
            </button>
          ) : null}
        </p>
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
      <div className={cn("flex min-w-0 shrink-0 items-start", wide ? "h-full flex-1" : "w-full")}>
      <div
        ref={surfaceRef}
        role={iHaveControl ? "application" : undefined}
        tabIndex={iHaveControl ? 0 : -1}
        data-testid="mac-desktop-surface"
        data-control={iHaveControl ? "user" : "agent"}
        /*
          The pane's own surface, not a black box.

          The first version painted `bg-black/60` under a canvas that keeps its
          aspect ratio, so before the first frame the pane was a black
          rectangle, and after it a black letterbox band above and below the
          picture. The surrounding area is the panel's surface colour now and
          the canvas draws the display's aspect ratio on top of it; a screen
          that has not arrived yet is a line of text, which is a state, where a
          black rectangle was a defect.
        */
        style={expanded ? undefined : { aspectRatio: `${display.width} / ${display.height}` }}
        className={cn(
          expanded
            ? "fixed inset-0 z-[1000] overflow-hidden bg-[color-mix(in_srgb,var(--color-surface)_92%,black)]"
            // Aspect-correct and pinned to the top of the pane: the picture
            // owns exactly the box it fills, so there is no letterbox band for
            // a border to frame and nothing above it to explain.
            // `max-h-full` only bites in the side-by-side layout, where the
            // column has a definite height; stacked, its parent's height is
            // auto and the picture simply takes the width it is given.
            : "relative w-full max-h-full overflow-hidden bg-surface",
          "flex items-center justify-center",
          // While the user is driving, the pointer they see is the one drawn
          // at the lane's Mac coordinates, not this machine's arrow.
          iHaveControl && MAC_DESKTOP_TAKEOVER_CURSOR_HIDDEN_CLASS,
        )}
        onPointerDown={realInput.onPointerDown}
        onPointerUp={realInput.onPointerUp}
        onPointerLeave={realInput.onPointerLeave}
        /*
          Full screen's one discovery gesture.

          The band is the top 72px of the picture, measured against the
          surface's own box rather than the viewport: a person driving an app
          over there moves the pointer constantly, and a bar that reappeared on
          any movement would sit over the menu bar of whatever they are using.
          Passive — it reads a coordinate and never calls `preventDefault`, so
          it cannot interfere with the input the surface forwards.
        */
        onPointerMove={(event) => {
          realInput.onPointerMove(event);
          if (!expanded) return;
          const top = event.currentTarget.getBoundingClientRect().top;
          if (event.clientY - top <= MAC_DESKTOP_CHROME_EDGE_PX) showChrome(windowsOpen);
        }}
        onWheel={realInput.onWheel}
        onKeyDown={realInput.onKeyDown}
        onContextMenu={(event) => {
          if (iHaveControl) event.preventDefault();
        }}
      >
        {/*
          The canvas is mounted as soon as there is an address and stays
          mounted: its own `data-status` is what the strip reads, and
          unmounting it on every status wobble would restart the decode. It is
          transparent until the first frame lands, so the line underneath shows
          through rather than a black plate sitting on top of it.
        */}
        {live.status !== "playing" ? (
          <p
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 text-center text-[12px] text-muted-fg"
            data-testid="mac-desktop-surface-status"
          >
            {macDesktopErrorText(live.error) ?? (live.url ? "Starting display…" : "Connecting to the lane's screen…")}
          </p>
        ) : null}
        {live.url ? (
          <H264VideoCanvas
            url={live.url}
            reconnectNonce={live.reconnectNonce}
            onStatus={live.onStatus}
            onDimensions={live.onDimensions}
            onCanvas={live.onCanvas}
            className={live.status === "playing" ? undefined : "opacity-0"}
          />
        ) : null}

        {/*
          The frame, drawn on the picture rather than around the pane.

          `pointer-events-none` on purpose: this is chrome, and every gesture
          underneath it belongs to the surface, including the ones that land in
          the letterbox and are refused there.
        */}
        {contentBox && contentBox.width > 0 ? (
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

        {selectedRect ? (
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

        <MacDesktopTakeoverCursor
          feed={realInput.cursorFeed}
          rect={viewRect}
          display={display}
          active={iHaveControl}
        />

        {cursorPoint ? (
          <span
            aria-hidden
            data-testid="mac-desktop-agent-cursor"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 text-accent"
            style={{ left: cursorPoint.x, top: cursorPoint.y }}
          >
            <Cursor size={16} weight="fill" />
          </span>
        ) : null}

        {/*
          ── Full screen's floating strip ───────────────────────────────

          The pane's chrome row is not rendered while this is up, so this is
          the only copy of these controls in the tree and a test cannot match
          two of anything. It carries exactly what full screen needs: what the
          stream is doing, the window list, and the way out. Recording and
          takeover stay on the pane's row — full screen is for watching.

          `stopPropagation` on the pointer events, not `pointer-events-none`
          on a wrapper: the surface under this forwards every pointer press to
          the lane's Mac while the user holds the lease, and a click meant for
          "exit full screen" must not also be a click over there.
        */}
        {expanded ? (
          <div
            data-testid="mac-desktop-fullscreen-chrome"
            data-visible={chromeVisible ? "true" : "false"}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerMove={() => showChrome(windowsOpen)}
            className={cn(
              // Top-RIGHT rather than centred: the expanded picture's
              // containing block is the pane, not the window (an ancestor
              // carries a backdrop filter), so a centred bar lands wherever
              // that box happens to be. An edge is the one anchor that is the
              // same in both.
              "absolute right-3 top-3 z-30 flex min-w-[300px] items-center gap-1 rounded-[10px] px-1.5",
              // The Windows menu is positioned against this bar, so it is the
              // bar that has to be the positioning context.
              "relative",
              "border border-white/[0.08] bg-[color-mix(in_srgb,var(--color-surface-overlay)_88%,transparent)]",
              "shadow-float backdrop-blur-md transition-opacity duration-200 ease-out",
              chromeVisible ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {statusChip}
            {windowsChip}
            {expandButton}
          </div>
        ) : null}

        {iHaveControl ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-amber-500/15 py-1 text-[11px] text-amber-200"
            data-testid="mac-desktop-takeover-banner"
          >
            You have control
            <button
              type="button"
              className="pointer-events-auto underline underline-offset-2"
              onClick={() => void returnControl()}
            >
              Return to agent
            </button>
          </div>
        ) : null}
      </div>

      </div>

      {/* ── The windows rail ────────────────────────────────────────────

          One card per parked window, under the picture or beside it. Nothing
          at all when the screen is empty — that case is answered ON the
          picture by the overlay card, and a rail with a "nothing here" line
          under an overlay that already says so is the same sentence twice. */}
      {parkedWindows.length || lastObservation ? (
        <div
          data-testid="mac-desktop-rail"
          className={cn(
            "flex min-h-0 flex-col gap-1",
            wide ? "w-[280px] max-w-[280px] shrink-0 overflow-y-auto" : "shrink-0",
          )}
        >
          {parkedWindows.map((entry) => (
            <MacDesktopWindowCard
              key={entry.id}
              window={entry}
              owned={macDesktopHasLease(entry, laneId)}
              selected={entry.id === selectedWindowId}
              busy={busy}
              onSelect={selectWindow}
              onRelease={releaseWindowById}
              onFocus={canObserve ? observeWindowById : null}
            />
          ))}

          {/* ── Last observation ──────────────────────────────────────
              One row: what the agent last did, when, how much it saw, and the
              frame it saw it on when the live view has one to lend. */}
          {lastObservation ? (
            <div
              className="mt-0.5 flex items-center gap-2 px-1 text-[11px] text-muted-fg"
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
        />
      ) : null}
    </div>
  );
}
