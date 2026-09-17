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
import {
  ArrowsOut,
  CaretDown,
  Cursor,
  Monitor,
  Record,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type {
  MacDesktopDisplay,
  MacDesktopLeaseState,
  MacDesktopStatus,
  MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import { cn } from "../ui/cn";
import {
  WORK_TOOL_CHROME_CHIP,
  WORK_TOOL_CHROME_ROW,
  WORK_TOOL_PRIMARY_BUTTON,
  WorkToolEmptyLine,
} from "../terminals/workToolChrome";
import { IosSimH264Video } from "./IosSimH264Video";
import { openIosSimSettingsPane } from "./iosSimContracts";
import {
  MAC_DESKTOP_CURSOR_FADE_MS,
  displayPointToViewPoint,
  viewPointToDisplayPoint,
} from "./macDesktopGeometry";
import {
  createMacDesktopLeaseHeartbeat,
  macDesktopUserHasControl,
} from "./macDesktopLease";
import { captionMacDesktopFrame, clearMacDesktopFrame } from "./macDesktopFrameStore";
import { useMacDesktopLiveView } from "./useMacDesktopLiveView";

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
 * The namespace, or a stated absence.
 *
 * Every call in this panel goes through here so that a surface without the
 * namespace shows the panel's own error line instead of throwing out of an
 * effect and taking the Work pane with it.
 */
function macDesktopApi(): NonNullable<Window["ade"]["macDesktop"]> {
  const api = window.ade.macDesktop;
  if (!api) throw new Error("Mac Desktop is not available on this surface.");
  return api;
}

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

type AgentCursor = { x: number; y: number; at: number; caption: string | null };

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
  const [status, setStatus] = useState<MacDesktopStatus | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [windowsOpen, setWindowsOpen] = useState(false);
  const [cursor, setCursor] = useState<AgentCursor | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewRect, setViewRect] = useState({ left: 0, top: 0, width: 0, height: 0 });

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const display: MacDesktopDisplay | null = status?.display ?? null;
  const lease: MacDesktopLeaseState | null = status?.lease ?? null;
  const windows: MacDesktopWindow[] = status?.windows ?? [];
  const supported = status?.supported ?? null;
  const iHaveControl = macDesktopUserHasControl(lease, macDesktopControllerId());

  const live = useMacDesktopLiveView({
    laneId,
    runtimePin,
    enabled: Boolean(display),
    chatSessionId: sessionId,
  });

  /* ── Status: one read, then events ───────────────────────────────────── */

  const refreshStatus = useCallback(async () => {
    const next = await macDesktopApi().getStatus(
      { laneId, chatSessionId: sessionId },
      pinRef.current,
    );
    setStatus(next);
    return next;
  }, [laneId, sessionId]);

  /**
   * Auto-start.
   *
   * The spec's "there is no intermediate card" is load bearing: a tab that
   * opens onto a button saying "Start display" is a step nobody can decline
   * meaningfully. `start` is idempotent and serialized per lane on the host, so
   * two chats in the lane opening the tab at once both get the first display.
   */
  useEffect(() => {
    let cancelled = false;
    setStartError(null);
    void (async () => {
      try {
        const current = await refreshStatus();
        if (cancelled || !current.supported || current.display) return;
        const started = await macDesktopApi().start(
          { laneId, laneName: laneName ?? null, chatSessionId: sessionId },
          pinRef.current,
        );
        if (!cancelled) setStatus(started);
      } catch (error) {
        if (!cancelled) setStartError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [laneId, laneName, refreshStatus, sessionId]);

  /**
   * Events, not a poller.
   *
   * Every field the strip shows moves on an event the service already emits, so
   * a `getStatus` interval here would be a second source of truth that is
   * always a beat behind the first.
   */
  useEffect(() => {
    const api = window.ade.macDesktop;
    if (!api) return;
    return api.onEvent((event) => {
      switch (event.type) {
        case "display-created":
          if (event.display.laneId !== laneId) return;
          setStatus((current) => (current ? { ...current, display: event.display } : current));
          return;
        case "display-destroyed":
          if (event.laneId !== laneId) return;
          clearMacDesktopFrame(laneId);
          setStatus((current) => (current ? { ...current, display: null, windows: [] } : current));
          return;
        case "windows-changed":
          if (event.laneId !== laneId) return;
          setStatus((current) => (current ? { ...current, windows: event.windows } : current));
          return;
        case "lease-changed":
          if (event.laneId !== laneId) return;
          setStatus((current) => (current ? { ...current, lease: event.lease } : current));
          return;
        case "observation": {
          if (event.laneId !== laneId) return;
          const caption = event.observation.caption;
          captionMacDesktopFrame(laneId, caption);
          // The agent's cursor is the last action's own point. Elements come
          // back in the same global plane the display's origin uses, so there
          // is no second coordinate space to reconcile.
          const focused = event.observation.elements.find((element) => element.focused)
            ?? event.observation.elements[0]
            ?? null;
          if (focused) {
            setCursor({ x: focused.center.x, y: focused.center.y, at: Date.now(), caption });
          }
          return;
        }
        case "recording-changed":
          if (event.status.laneId !== laneId) return;
          setStatus((current) => (current ? { ...current, recording: event.status } : current));
          return;
        case "stream-started":
        case "stream-status":
        case "stream-stopped":
        case "stream-error":
          if (event.status.laneId !== laneId) return;
          setStatus((current) => (current
            ? {
                ...current,
                stream: {
                  running: event.status.running,
                  idle: event.status.idle,
                  fps: event.status.fps,
                  bitrateKbps: event.status.bitrateKbps,
                  lastError: event.status.lastError,
                },
              }
            : current));
          return;
        case "permission-changed":
          setStatus((current) => (current ? { ...current, permissions: event.permissions } : current));
          return;
        case "driver-health":
          setStatus((current) => (current ? { ...current, driver: event.health } : current));
          return;
        default:
          return;
      }
    }, pinRef.current);
  }, [laneId, runtimePin]);

  /** The cursor glyph fades on its own; no timer runs while nothing happened. */
  useEffect(() => {
    if (!cursor) return;
    const timer = setTimeout(() => setCursor(null), MAC_DESKTOP_CURSOR_FADE_MS);
    return () => clearTimeout(timer);
  }, [cursor]);

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

  const toDisplayPoint = useCallback((clientX: number, clientY: number) => {
    if (!display) return null;
    return viewPointToDisplayPoint({ clientX, clientY, rect: viewRect, display });
  }, [display, viewRect]);

  const cursorPoint = useMemo(() => {
    if (!cursor || !display) return null;
    return displayPointToViewPoint({ x: cursor.x, y: cursor.y, rect: viewRect, display });
  }, [cursor, display, viewRect]);

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
  }, [laneId]);

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
    [laneId],
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
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [laneId]);

  /* ── Real input, only while the user holds the lease ──────────────────── */

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!iHaveControl) return;
    const point = toDisplayPoint(event.clientX, event.clientY);
    if (!point) return;
    dragStartRef.current = point;
  }, [iHaveControl, toDisplayPoint]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!iHaveControl) return;
    const from = dragStartRef.current;
    dragStartRef.current = null;
    const to = toDisplayPoint(event.clientX, event.clientY);
    if (!to) return;
    // A press and release more than a few points apart is a drag, not a click.
    // Sending it as a click would drop the gesture the user actually made.
    const dragged = from
      && (Math.abs(from.x - to.x) > 4 || Math.abs(from.y - to.y) > 4);
    if (dragged && from) {
      void macDesktopApi().drag(
        { laneId, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, mode: "real", chatSessionId: sessionId },
        pinRef.current,
      ).catch(() => {});
      return;
    }
    void macDesktopApi().click(
      {
        laneId,
        x: to.x,
        y: to.y,
        mode: "real",
        button: event.button === 2 ? "right" : "left",
        count: event.detail >= 2 ? 2 : 1,
        chatSessionId: sessionId,
      },
      pinRef.current,
    ).catch(() => {});
  }, [iHaveControl, laneId, sessionId, toDisplayPoint]);

  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!iHaveControl) return;
    const point = toDisplayPoint(event.clientX, event.clientY);
    if (!point) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    void macDesktopApi().scroll(
      {
        laneId,
        x: point.x,
        y: point.y,
        mode: "real",
        direction: horizontal
          ? (event.deltaX > 0 ? "right" : "left")
          : (event.deltaY > 0 ? "down" : "up"),
        amount: Math.max(1, Math.round(Math.abs(horizontal ? event.deltaX : event.deltaY) / 20)),
        chatSessionId: sessionId,
      },
      pinRef.current,
    ).catch(() => {});
  }, [iHaveControl, laneId, sessionId, toDisplayPoint]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!iHaveControl) return;
    event.preventDefault();
    const modifiers: Array<"cmd" | "shift" | "option" | "control"> = [];
    if (event.metaKey) modifiers.push("cmd");
    if (event.shiftKey) modifiers.push("shift");
    if (event.altKey) modifiers.push("option");
    if (event.ctrlKey) modifiers.push("control");
    // A bare printable character is text, and typing it as text is what makes
    // dead keys, IME output and pasted-looking input arrive intact. Everything
    // else — and anything with a command modifier — is a key press.
    const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
    const call = printable
      ? macDesktopApi().type({ laneId, text: event.key, mode: "real", chatSessionId: sessionId }, pinRef.current)
      : macDesktopApi().press(
          { laneId, key: event.key.toLowerCase(), modifiers, mode: "real", chatSessionId: sessionId },
          pinRef.current,
        );
    void call.catch(() => {});
  }, [iHaveControl, laneId, sessionId]);

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
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [laneId, recording?.running, sessionId]);

  const present = useCallback(async (destination: "main" | "display") => {
    setBusy(true);
    try {
      await macDesktopApi().present({ laneId, destination }, pinRef.current);
      await refreshStatus();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [laneId, refreshStatus]);

  const releaseWindow = useCallback(async (windowId: number) => {
    try {
      await macDesktopApi().releaseWindow({ laneId, windowId }, pinRef.current);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  }, [laneId]);

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
        title={startError ?? "Starting this lane's screen…"}
        action={startError ? (
          <button type="button" className={WORK_TOOL_PRIMARY_BUTTON} onClick={() => void refreshStatus()}>
            <Monitor size={14} />
            Try again
          </button>
        ) : undefined}
      />
    );
  }

  const permissionBlocked = status?.permissions.screenRecording === "denied"
    || status?.permissions.accessibility === "denied";
  const parkedLine = windows.length
    ? windows.map((entry) => [entry.appName, entry.title].filter(Boolean).join(" — ")).join(" · ")
    : "No windows parked yet";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="mac-desktop-panel">
      {/* ── Strip ─────────────────────────────────────────────────────── */}
      <div className={cn(WORK_TOOL_CHROME_ROW, "gap-2")}>
        <span className={WORK_TOOL_CHROME_CHIP} data-testid="mac-desktop-live-chip">
          <span
            className={cn(
              "inline-block size-[6px] rounded-full",
              live.status === "playing" ? "bg-emerald-400" : "bg-amber-400",
            )}
          />
          {live.status === "playing" ? "Live" : live.status === "error" ? "Reconnecting" : "Starting"}
          <span className="opacity-60">·</span>
          {iHaveControl ? "You are driving" : lease?.holder === "agent" ? "Agent driving" : "Idle"}
        </span>

        <div className="relative">
          <button
            type="button"
            className={WORK_TOOL_CHROME_CHIP}
            aria-expanded={windowsOpen}
            data-testid="mac-desktop-windows-toggle"
            onClick={() => setWindowsOpen((open) => !open)}
          >
            Windows {windows.length}
            <CaretDown size={10} />
          </button>
          {windowsOpen ? (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-[10px] border border-border bg-surface p-1 shadow-float">
              {windows.length === 0 ? (
                <p className="px-2 py-1.5 text-[12px] text-muted-fg">Nothing parked on this screen.</p>
              ) : windows.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2 px-2 py-1.5 text-[12px]">
                  <span className="min-w-0 flex-1 truncate">{entry.appName}{entry.title ? ` — ${entry.title}` : ""}</span>
                  <button
                    type="button"
                    className="shrink-0 text-muted-fg hover:text-fg"
                    onClick={() => void releaseWindow(entry.id)}
                  >
                    Release
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className={WORK_TOOL_CHROME_CHIP}
          disabled={busy}
          aria-pressed={recording?.running ?? false}
          data-testid="mac-desktop-record"
          onClick={() => void toggleRecording()}
        >
          {recording?.running ? <Stop size={11} weight="fill" /> : <Record size={11} weight="fill" />}
          {recording?.running ? "Stop" : "Rec"}
        </button>

        <div className="flex-1" />

        {status?.hostIsLocal ? (
          <button
            type="button"
            className={WORK_TOOL_CHROME_CHIP}
            disabled={busy}
            data-testid="mac-desktop-present"
            onClick={() => void present(windows.some((entry) => entry.onDisplayId === display.displayId) ? "main" : "display")}
          >
            <ArrowsOut size={11} />
            {windows.some((entry) => entry.onDisplayId === display.displayId) ? "Bring to my screen" : "Send back"}
          </button>
        ) : null}

        <button
          type="button"
          className={cn(WORK_TOOL_CHROME_CHIP, iHaveControl && "text-amber-300")}
          disabled={busy}
          data-testid="mac-desktop-takeover"
          onClick={() => void (iHaveControl ? returnControl() : takeControl())}
        >
          <Cursor size={11} />
          {iHaveControl ? "Return to agent" : "Take over"}
        </button>
      </div>

      {/* ── One-line permission state ─────────────────────────────────── */}
      {permissionBlocked ? (
        <p className="flex items-center gap-2 px-1 text-[12px] text-amber-300" data-testid="mac-desktop-permission">
          <WarningCircle size={12} />
          {status?.permissions.screenRecording === "denied"
            ? "Screen Recording is off for ADE on the lane's Mac."
            : "Accessibility is off for ADE on the lane's Mac."}
          {status?.hostIsLocal && status.permissions.screenRecording === "denied" ? (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => void openIosSimSettingsPane("screen-recording").catch(() => {})}
            >
              Open System Settings
            </button>
          ) : null}
        </p>
      ) : null}

      {/* ── The screen ────────────────────────────────────────────────── */}
      <div
        ref={surfaceRef}
        role={iHaveControl ? "application" : undefined}
        tabIndex={iHaveControl ? 0 : -1}
        data-testid="mac-desktop-surface"
        data-control={iHaveControl ? "user" : "agent"}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden rounded-[10px] bg-black/60",
          "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)]",
          iHaveControl && "shadow-[inset_0_0_0_2px_rgb(251_191_36_/_0.8)]",
        )}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          if (iHaveControl) event.preventDefault();
        }}
      >
        {live.url ? (
          <IosSimH264Video
            url={live.url}
            reconnectNonce={live.reconnectNonce}
            onStatus={live.onStatus}
            onDimensions={live.onDimensions}
            onCanvas={live.onCanvas}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-muted-fg">
            {live.error ?? "Connecting to the lane's screen…"}
          </div>
        )}

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

      {/* ── Parked windows ────────────────────────────────────────────── */}
      <p className="truncate px-1 text-[11px] text-muted-fg" data-testid="mac-desktop-parked">
        {parkedLine}
      </p>
    </div>
  );
}
