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
import type {
  MacDesktopDisplay,
  MacDesktopLeaseState,
  MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import type { SystemSettingsPaneId } from "../../../shared/types/systemSettings";
import { cn } from "../ui/cn";
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
import { MacDesktopEmptyOverlay } from "./MacDesktopEmptyOverlay";
import { macDesktopHasLease } from "./macDesktopClaimPicker.logic";
import { macDesktopErrorText } from "./macDesktopErrorText";
import {
  macDesktopAppGlyph,
  macDesktopIsWidePane,
  macDesktopParkedWindows,
  macDesktopPresentAction,
  macDesktopRelativeTime,
  macDesktopStatusPill,
  macDesktopWindowLabel,
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
  /** The empty-screen card, until this person waves it away for this mount. */
  const [emptyDismissed, setEmptyDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
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
   * A dismissal lasts until the screen is used, not forever.
   *
   * Waving the card away says "not now"; parking a window and then releasing it
   * is a new empty screen, and the person who arrives at it should be offered
   * the same two buttons rather than a blank pane with a silent history.
   */
  useEffect(() => {
    if (parkedWindows.length) setEmptyDismissed(false);
  }, [parkedWindows.length]);

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

  /** `open` on the lane's Mac, from the empty card's inline input. */
  const openApp = useCallback(async (target: string) => {
    await macDesktopApi().open({ laneId, target, chatSessionId: sessionId }, pinRef.current);
    await refreshStatus();
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="mac-desktop-panel">
      {/* ── Strip ─────────────────────────────────────────────────────────

          One row that holds its line from 600px up: two short text chips on
          the left, icon buttons on the right, and nothing in between that can
          grow. `flex-nowrap` is the guarantee; `min-w-0` + `truncate` on the
          status pill is what it spends when the pane gets narrow. */}
      <div className={cn(WORK_TOOL_CHROME_ROW, "flex-nowrap gap-1")}>
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

        <div className="relative shrink-0">
          <button
            type="button"
            className={cn(WORK_TOOL_CHROME_CHIP, "shrink-0 whitespace-nowrap")}
            aria-expanded={windowsOpen}
            data-testid="mac-desktop-windows-toggle"
            onClick={() => setWindowsOpen((open) => !open)}
          >
            Windows {parkedWindows.length}
            <CaretDown size={10} />
          </button>
          {windowsOpen ? (
            <div
              /* `max-w` in view units, not a fixed pixel cap: a window title is
                 the only way to tell two windows of one app apart, and
                 "TextEdit — Untit…" in a menu with room to spare was the pane
                 refusing to say which one it holds. */
              className="absolute left-0 top-full z-50 mt-1 max-h-[280px] w-max min-w-[240px] max-w-[min(420px,80vw)] overflow-auto rounded-[10px] border border-border bg-surface p-1 shadow-float"
              data-testid="mac-desktop-windows-menu"
            >
              {parkedWindows.length ? null : (
                <p className="px-2 py-1.5 text-[11px] text-muted-fg">Nothing on this lane's screen yet.</p>
              )}
              {parkedWindows.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2 px-2 py-1.5 text-[12px]">
                  <span className="min-w-0 flex-1 truncate">{macDesktopWindowLabel(entry)}</span>
                  {/* Ownership, stated where the window is listed: a lane can be
                      watching a window it does not hold, and the chip is the
                      only place that difference is visible. */}
                  {macDesktopHasLease(entry, laneId) ? <MacDesktopLeaseChip /> : null}
                  <button
                    type="button"
                    className="shrink-0 text-muted-fg hover:text-fg"
                    onClick={() => void releaseWindow(entry.id)}
                  >
                    Release
                  </button>
                </div>
              ))}
              {/* The one way into the picker from the strip. The dropdown used
                  to inline a second list of every claimable window, which made
                  a menu that answered two questions badly. */}
              <button
                type="button"
                className="mt-0.5 flex w-full items-center gap-2 rounded-[7px] border-t border-border/50 px-2 py-1.5 text-left text-[12px] hover:bg-white/[0.06]"
                data-testid="mac-desktop-claim-another"
                onClick={() => { setWindowsOpen(false); setPickerOpen(true); }}
              >
                <ArrowSquareIn size={12} className="shrink-0 text-muted-fg" />
                Claim another…
              </button>
            </div>
          ) : null}
        </div>

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

          <WorkToolChromeButton
            label={expanded ? "Exit full screen" : "Full screen"}
            onClick={() => setExpanded((open) => !open)}
            active={expanded}
            testId="mac-desktop-expand"
          >
            {expanded ? <ArrowsInSimple size={16} /> : <ArrowsOutSimple size={16} />}
          </WorkToolChromeButton>

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
        )}
        onPointerDown={realInput.onPointerDown}
        onPointerUp={realInput.onPointerUp}
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
          Nothing parked: a card ON the picture, not a line under it.

          Gated on a display that is actually up and a stream that is not still
          erroring, so the card never argues with "Connecting to the lane's
          screen…" underneath it. It disappears on its own the moment a window
          parks, because `parkedWindows` is what renders it.
        */}
        {!parkedWindows.length && !emptyDismissed && !pickerOpen ? (
          <MacDesktopEmptyOverlay
            busy={busy}
            onClaim={() => setPickerOpen(true)}
            onOpenApp={openApp}
            onDismiss={() => setEmptyDismissed(true)}
          />
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
            {`Window ${notParkedNewest.windowId} stayed on your screen (${notParkedNewest.reason})`}
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
