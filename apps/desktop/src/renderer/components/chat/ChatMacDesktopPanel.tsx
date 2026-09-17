import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import type { SystemSettingsPaneId } from "../../../shared/types/systemSettings";
import { cn } from "../ui/cn";
import {
  WORK_TOOL_CHROME_CHIP,
  WORK_TOOL_CHROME_ROW,
  WORK_TOOL_PRIMARY_BUTTON,
  WorkToolEmptyLine,
} from "../terminals/workToolChrome";
import { H264VideoCanvas } from "./H264VideoCanvas";
import { macDesktopApi } from "./macDesktopApi";
import { displayPointToViewPoint, viewPointToDisplayPoint } from "./macDesktopGeometry";
import {
  createMacDesktopLeaseHeartbeat,
  macDesktopUserHasControl,
} from "./macDesktopLease";
import { useMacDesktopLiveView } from "./useMacDesktopLiveView";
import { useMacDesktopRealInput } from "./useMacDesktopRealInput";
import { useMacDesktopStatus } from "./useMacDesktopStatus";

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
  const [busy, setBusy] = useState(false);
  const [viewRect, setViewRect] = useState({ left: 0, top: 0, width: 0, height: 0 });

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;

  const display: MacDesktopDisplay | null = status?.display ?? null;
  const lease: MacDesktopLeaseState | null = status?.lease ?? null;
  const windows: MacDesktopWindow[] = status?.windows ?? [];
  const supported = status?.supported ?? null;
  const iHaveControl = macDesktopUserHasControl(lease, macDesktopControllerId());
  const anyWindowParked = windows.some((entry) => entry.onDisplayId === display?.displayId);

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
      setStatusError(error instanceof Error ? error.message : String(error));
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
      setStatusError(error instanceof Error ? error.message : String(error));
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
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [laneId, refreshStatus, setStatusError]);

  const releaseWindow = useCallback(async (windowId: number) => {
    try {
      await macDesktopApi().releaseWindow({ laneId, windowId }, pinRef.current);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, [laneId, setStatusError]);

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
  const parkedLine = windows.length
    ? windows.map((entry) => [entry.appName, entry.title].filter(Boolean).join(" — ")).join(" · ")
    : "No windows parked yet";
  const notParkedNewest = notParked[0] ?? null;

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

        {realInput.inputError ? (
          <button
            type="button"
            className={cn(WORK_TOOL_CHROME_CHIP, "max-w-[280px] truncate text-amber-300")}
            title={realInput.inputError}
            data-testid="mac-desktop-input-error"
            onClick={realInput.clearInputError}
          >
            <WarningCircle size={11} />
            {realInput.inputError}
          </button>
        ) : null}

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
            onClick={() => void present(anyWindowParked ? "main" : "display")}
          >
            <ArrowsOut size={11} />
            {anyWindowParked ? "Bring to my screen" : "Send back"}
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
        onPointerDown={realInput.onPointerDown}
        onPointerUp={realInput.onPointerUp}
        onWheel={realInput.onWheel}
        onKeyDown={realInput.onKeyDown}
        onContextMenu={(event) => {
          if (iHaveControl) event.preventDefault();
        }}
      >
        {live.url ? (
          <H264VideoCanvas
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
    </div>
  );
}
