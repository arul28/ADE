/**
 * Electron Control, as the plugin's own page.
 *
 * Ported out of `apps/desktop/src/renderer/components/chat/ChatAppControlPanel.tsx`
 * (1,540 lines) rather than rewritten: the launch row, the attach row, the
 * status pill, the window picker, the waiting-for-CDP card, the message banner,
 * the mode toggle, the selection details and the type-text field are the
 * compiled pane's own markup and its own words.
 *
 * ## The one structural change
 *
 * The compiled pane drew the picture itself — an `<img>` fed by a
 * `requestAnimationFrame` loop off `appControl.onEvent`'s `frame` events — and
 * every input verb was a coordinate mapped off a click on that image. The page
 * cannot do either: thirty base64 PNGs a second through a structured clone is
 * not a cost a guest should pay, and a native view painted over the guest takes
 * the pointer events with it.
 *
 * So the live view stays in the HOST. This page reserves a rect
 * (`host/engine.ts`), the host paints `electron-control` into it, and the input
 * verbs the image used to carry become explicit controls beside it: a viewport
 * coordinate, a Click, a Scroll with its two deltas, an Inspect and a Select.
 * The coordinate space is the same one the compiled pane sent — `viewport` —
 * so the child's arguments did not change, only where the numbers come from.
 *
 * Four pieces of the compiled pane went with the image and are named in
 * `PARITY.md`: the click pulse, the hover outline, the element overlays and the
 * blank-screenshot detector all read pixels the page no longer has.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Crosshair,
  Cursor,
  Desktop,
  Keyboard,
  Link,
  Minus,
  MouseScroll,
  Play,
  SpinnerGap,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import type { PluginWebviewContext } from "../bridge";
import * as actions from "../host/actions";
import { ENGINE_ID, NO_ENGINE_MESSAGE, hasHostEngine, placeEngineOn } from "../host/engine";
import { canOpenPathInEditor, onHostChanged, openPathInEditor } from "../host/ui";
import { DEFAULT_UI_STATE, loadUiState, saveUiState } from "../host/uiState";
import type {
  AppControlElement,
  AppControlSnapshot,
  AppControlStatus,
  AppControlTarget,
  ControlPanelUiState,
} from "../types";
import {
  STATUS_DOT_TONE,
  STATUS_PILL_TONE,
  elementLabel,
  elementSubLabel,
  errorMessage,
  statusInfo,
  targetLabel,
} from "./status";

type Message = { tone: "info" | "error"; text: string };

/**
 * How often the window list is re-scanned while a session is connected.
 *
 * The compiled pane's own cadence, and its own reason: a reader who opens a
 * second window of the app should be able to switch to it without restarting
 * Electron Control. Guarded on visibility, which the compiled pane did not need
 * to be — it was one pane in one window, and a page is a guest the host may
 * leave mounted behind a hidden placement.
 */
const TARGET_POLL_MS = 2_500;

/** The inspect list never grows past this. The compiled snapshot capped at the same. */
const INSPECT_LIST_MAX = 40;

function useEnginePlacement(): (element: HTMLDivElement | null) => void {
  const placementRef = useRef<ReturnType<typeof placeEngineOn> | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const attach = useCallback((element: HTMLDivElement | null) => {
    // Tear the old placement down first: a ref callback fires with null before
    // it fires with the next node, and a placement left running would paint the
    // engine over whatever the reader opened next.
    observerRef.current?.disconnect();
    observerRef.current = null;
    placementRef.current?.release();
    placementRef.current = null;
    elementRef.current = element;
    if (!element) return;
    const placement = placeEngineOn(element, ENGINE_ID);
    placementRef.current = placement;
    placement.measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => placement.measure());
      observer.observe(element);
      observerRef.current = observer;
    }
  }, []);

  useEffect(() => {
    // The rect is measured against the VIEWPORT, so a window resize moves it
    // even when the element's own box is unchanged.
    function remeasure(): void {
      placementRef.current?.measure();
    }
    /**
     * A hidden placement releases the engine.
     *
     * The host destroys a guest when its placement hides, so unmount covers the
     * common case — but a host that keeps one mounted behind a hidden tab would
     * otherwise leave the live view painted over the tab in front of it.
     */
    function onVisibility(): void {
      const element = elementRef.current;
      if (!element) return;
      if (document.visibilityState === "hidden") {
        placementRef.current?.release();
        placementRef.current = null;
        return;
      }
      if (placementRef.current) return;
      const placement = placeEngineOn(element, ENGINE_ID);
      placementRef.current = placement;
      placement.measure();
    }
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
      document.removeEventListener("visibilitychange", onVisibility);
      observerRef.current?.disconnect();
      observerRef.current = null;
      placementRef.current?.release();
      placementRef.current = null;
    };
  }, []);

  return attach;
}

export function ControlPane({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const projectRoot = context.project?.root ?? null;
  const laneId = typeof context.subject?.laneId === "string" ? (context.subject.laneId as string) : null;
  const chatSessionId = typeof context.subject?.sessionId === "string"
    ? (context.subject.sessionId as string)
    : null;

  const [status, setStatus] = useState<AppControlStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [targets, setTargets] = useState<AppControlTarget[]>([]);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AppControlSnapshot | null>(null);
  const [elements, setElements] = useState<AppControlElement[]>([]);
  const [selectedElement, setSelectedElement] = useState<AppControlElement | null>(null);
  const [attachmentAck, setAttachmentAck] = useState<string | null>(null);
  const [form, setForm] = useState<ControlPanelUiState>(DEFAULT_UI_STATE);
  const [pointX, setPointX] = useState("0");
  const [pointY, setPointY] = useState("0");
  const [deltaY, setDeltaY] = useState("120");
  const [typeText, setTypeText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const engineAvailable = useMemo(() => hasHostEngine(), []);
  const editorAvailable = useMemo(() => canOpenPathInEditor(), []);
  const attachEngine = useEnginePlacement();

  const activeSession = status?.activeSession ?? snapshot?.session ?? null;
  const sessionStatus = useMemo(() => statusInfo(activeSession), [activeSession]);
  const controlsDisabledReason = status?.disabledReason ?? null;
  const controlsDisabled = Boolean(controlsDisabledReason);
  const controlsDisabledMessage = controlsDisabledReason
    ?? "This Electron Control session is read-only from the current lane.";
  const sessionConnected = activeSession?.status === "connected";
  const waitingForCdp = Boolean(
    activeSession
    && (activeSession.status === "starting" || activeSession.status === "running")
    && activeSession.cdpPort
    && !activeSession.cdpEndpoint,
  );
  const hasActiveSession = Boolean(activeSession)
    && !["exited", "stopped", "failed"].includes(activeSession?.status ?? "");
  const canLaunch = form.launchCommand.trim().length > 0 && !hasActiveSession && !controlsDisabled;
  const canStop = hasActiveSession && !controlsDisabled;
  const canType = form.mode === "control"
    && typeText.trim().length > 0
    && sessionConnected
    && !controlsDisabled;

  /* ── Reads ────────────────────────────────────────────────────────────── */

  const refreshStatus = useCallback(async () => {
    try {
      const next = await actions.getStatus();
      setStatus(next);
      setStatusError(null);
      return next;
    } catch (error) {
      // A read with an honest place for its failure: the card says so instead of
      // the page throwing over a host that is still starting up.
      setStatusError(errorMessage(error));
      return null;
    }
  }, []);

  const refreshTargets = useCallback(async () => {
    try {
      const list = await actions.listTargets();
      setTargets(list);
      // Clear the optimistic pick once the child confirms it — OR if the picked
      // target disappeared entirely (window closed mid-attach), otherwise the
      // dropdown would appear permanently stuck on a phantom id.
      setPendingTargetId((current) => {
        if (!current) return current;
        const matched = list.find((target) => target.id === current);
        if (!matched) return null;
        return matched.active ? null : current;
      });
    } catch {
      setTargets([]);
    }
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const next = await actions.getSnapshot({ projectRoot });
    setSnapshot(next);
    setElements(next.elements.slice(0, INSPECT_LIST_MAX));
    setSelectedElement(next.hitElement);
    return next;
  }, [projectRoot]);

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    void loadUiState(projectRoot).then((stored) => {
      if (!cancelled) setForm(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  useEffect(() => {
    void refreshStatus();
    // The session half of the compiled `appControl.onEvent`: the child
    // republishes its status row on every transition, the host turns that into
    // a `changed`, and the page re-reads. The FRAME half is the host engine's.
    return onHostChanged(() => {
      void refreshStatus();
    });
  }, [refreshStatus]);

  useEffect(() => {
    if (!sessionConnected) {
      setTargets([]);
      return undefined;
    }
    let cancelled = false;
    void refreshTargets();
    const timer = window.setInterval(() => {
      if (cancelled || document.visibilityState === "hidden") return;
      void refreshTargets();
    }, TARGET_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshTargets, sessionConnected]);

  useEffect(() => {
    if (!attachmentAck) return undefined;
    const timer = window.setTimeout(() => setAttachmentAck(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [attachmentAck]);

  const patchForm = useCallback(
    (patch: Partial<ControlPanelUiState>) => {
      setForm((current) => {
        const next = { ...current, ...patch };
        void saveUiState(projectRoot, next);
        return next;
      });
    },
    [projectRoot],
  );

  /**
   * Run one press, with its spinner and its banner.
   *
   * The compiled `runBusy` verbatim, with one rule added: a page action answers
   * `{ok, message}` rather than throwing for a host refusal, so a falsy `ok` is
   * turned into the same banner an exception would have produced. Both paths
   * exist because a plugin bug still throws, and that is worth seeing.
   */
  const runBusy = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label);
      setMessage(null);
      try {
        await action();
      } catch (error) {
        setMessage({ tone: "error", text: errorMessage(error) });
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  function refused(result: actions.PageActionResult, fallback: string): string | null {
    if (result?.ok) return null;
    return result?.message ?? fallback;
  }

  /* ── The session ──────────────────────────────────────────────────────── */

  const launchSelected = useCallback(
    () =>
      runBusy("launch", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const command = form.launchCommand.trim();
        if (!command) throw new Error("Enter a launch command.");
        const cwd = form.launchCwd.trim();
        const result = await actions.launchInTerminal({
          projectRoot,
          laneId,
          command,
          cwd: cwd.length ? cwd : null,
          chatSessionId,
        });
        const problem = refused(result, "Could not launch the app.");
        if (problem) {
          setMessage({ tone: "error", text: problem });
          await refreshStatus();
          return;
        }
        patchForm({ mode: "control" });
        const next = await refreshStatus();
        const session = result.session ?? next?.activeSession ?? null;
        if (session?.status === "connected") await refreshSnapshot().catch(() => {});
        const cdpHint = session?.cdpPort
          ? ` Waiting for CDP on 127.0.0.1:${session.cdpPort}. ADE forwards debug flags for common npm/pnpm/yarn/bun and direct Electron launches. If it stays blank, quit any old app instance or wire ADE_APP_CONTROL_DEBUG_FLAGS into the launcher.`
          : "";
        setMessage({
          tone: "info",
          text: `Started ${session?.label ?? command} in the terminal.${cdpHint}`,
        });
      }),
    [
      chatSessionId,
      controlsDisabled,
      controlsDisabledMessage,
      form.launchCommand,
      form.launchCwd,
      laneId,
      patchForm,
      projectRoot,
      refreshSnapshot,
      refreshStatus,
      runBusy,
    ],
  );

  const connectPort = useCallback(
    () =>
      runBusy("connect", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const port = Number(form.cdpPort);
        if (!Number.isFinite(port) || port <= 0) throw new Error("Enter a valid CDP port.");
        const result = await actions.connectToPort({
          projectRoot,
          laneId,
          cdpPort: port,
          chatSessionId,
        });
        const problem = refused(result, "Could not connect to that port.");
        if (problem) {
          setMessage({ tone: "error", text: problem });
          await refreshStatus();
          return;
        }
        patchForm({ mode: "control" });
        const next = await refreshStatus();
        const session = result.session ?? next?.activeSession ?? null;
        await refreshSnapshot().catch(() => {});
        setMessage({ tone: "info", text: `Connected to ${session?.label ?? `127.0.0.1:${port}`}.` });
      }),
    [
      chatSessionId,
      controlsDisabled,
      controlsDisabledMessage,
      form.cdpPort,
      laneId,
      patchForm,
      projectRoot,
      refreshSnapshot,
      refreshStatus,
      runBusy,
    ],
  );

  const stopSession = useCallback(
    () =>
      runBusy("stop", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const result = await actions.stopSession();
        const problem = refused(result, "Could not stop the session.");
        await refreshStatus();
        setSnapshot(null);
        setElements([]);
        setSelectedElement(null);
        setMessage(problem ? { tone: "error", text: problem } : { tone: "info", text: "Session stopped." });
      }),
    [controlsDisabled, controlsDisabledMessage, refreshStatus, runBusy],
  );

  const attachToTargetId = useCallback(
    (targetId: string) => {
      if (controlsDisabled) {
        setMessage({ tone: "error", text: controlsDisabledMessage });
        return;
      }
      // Optimistically reflect the reader's pick so the dropdown does not appear
      // to snap back while the new screencast spins up.
      setPendingTargetId(targetId);
      void runBusy("attach", async () => {
        try {
          const result = await actions.attachToTarget(targetId);
          const problem = refused(result, "Could not attach to that window.");
          if (problem) setMessage({ tone: "error", text: problem });
          await refreshStatus();
          await refreshTargets();
        } finally {
          setPendingTargetId((current) => (current === targetId ? null : current));
        }
      });
    },
    [controlsDisabled, controlsDisabledMessage, refreshStatus, refreshTargets, runBusy],
  );

  const focusWindow = useCallback(
    () =>
      runBusy("focus-window", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const problem = refused(await actions.focusWindow(), "Could not show the app window.");
        if (problem) setMessage({ tone: "error", text: problem });
      }),
    [controlsDisabled, controlsDisabledMessage, runBusy],
  );

  const minimizeWindow = useCallback(
    () =>
      runBusy("minimize-window", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const problem = refused(await actions.minimizeWindow(), "Could not minimize the app window.");
        if (problem) setMessage({ tone: "error", text: problem });
      }),
    [controlsDisabled, controlsDisabledMessage, runBusy],
  );

  /* ── Driving ──────────────────────────────────────────────────────────── */

  /** The coordinate the drive controls act on, in the CDP viewport's own space. */
  const point = useMemo(() => {
    const x = Number.parseInt(pointX, 10);
    const y = Number.parseInt(pointY, 10);
    return {
      x: Number.isFinite(x) ? Math.max(0, x) : 0,
      y: Number.isFinite(y) ? Math.max(0, y) : 0,
    };
  }, [pointX, pointY]);

  const clickPoint = useCallback(
    () =>
      runBusy("click", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        if (form.mode !== "control") throw new Error("Switch to Control mode to click in the app.");
        const problem = refused(await actions.click({ ...point, coordinateSpace: "viewport" }), "Click failed.");
        setMessage(problem
          ? { tone: "error", text: `Click failed: ${problem}` }
          : { tone: "info", text: `Clicked ${point.x}, ${point.y}.` });
      }),
    [controlsDisabled, controlsDisabledMessage, form.mode, point, runBusy],
  );

  const scrollPoint = useCallback(
    () =>
      runBusy("scroll", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        if (form.mode !== "control") throw new Error("Switch to Control mode to scroll the app.");
        const delta = Number.parseInt(deltaY, 10);
        if (!Number.isFinite(delta) || delta === 0) throw new Error("Enter a non-zero scroll amount.");
        const problem = refused(
          await actions.scroll({ ...point, deltaX: 0, deltaY: delta, coordinateSpace: "viewport" }),
          "Scroll failed.",
        );
        if (problem) setMessage({ tone: "error", text: `Scroll failed: ${problem}` });
      }),
    [controlsDisabled, controlsDisabledMessage, deltaY, form.mode, point, runBusy],
  );

  const typeIntoApp = useCallback(
    () =>
      runBusy("type", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        if (form.mode !== "control") throw new Error("Switch to Control mode to type into the app.");
        if (!typeText.trim()) return;
        const problem = refused(await actions.typeText(typeText), "Could not type into the app.");
        if (problem) {
          setMessage({ tone: "error", text: problem });
          return;
        }
        setTypeText("");
        try {
          await refreshSnapshot();
        } catch (error) {
          setMessage({
            tone: "info",
            text: `Typed into focused element. Snapshot refresh failed: ${errorMessage(error)}`,
          });
          return;
        }
        setMessage({ tone: "info", text: "Typed into focused element." });
      }),
    [controlsDisabled, controlsDisabledMessage, form.mode, refreshSnapshot, runBusy, typeText],
  );

  const inspectAtPoint = useCallback(
    () =>
      runBusy("inspect", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const result = await actions.inspectPoint({ projectRoot, ...point, coordinateSpace: "viewport" });
        setSnapshot(result.snapshot);
        setElements(result.snapshot.elements.slice(0, INSPECT_LIST_MAX));
        setSelectedElement(result.snapshot.hitElement);
        setMessage(result.snapshot.hitElement
          ? { tone: "info", text: `Inspected ${elementLabel(result.snapshot.hitElement)}.` }
          : { tone: "info", text: `Nothing at ${point.x}, ${point.y}.` });
      }),
    [controlsDisabled, controlsDisabledMessage, point, projectRoot, runBusy],
  );

  const selectAtPoint = useCallback(
    () =>
      runBusy("select", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        if (form.mode !== "inspect") throw new Error("Switch to Inspect mode to attach Electron Control context.");
        const result = await actions.selectPoint({ projectRoot, ...point, coordinateSpace: "viewport" });
        const element = result.snapshot?.hitElement ?? null;
        if (result.snapshot) {
          setSnapshot(result.snapshot);
          setElements(result.snapshot.elements.slice(0, INSPECT_LIST_MAX));
        }
        setSelectedElement(element);
        const problem = refused(await actions.attachContext(result.item), "Could not insert Electron Control context.");
        if (problem) {
          setMessage({ tone: "error", text: problem });
          return;
        }
        const label = result.source === "coordinate-fallback"
          ? "coordinate"
          : element
            ? elementLabel(element)
            : String(result.source);
        setAttachmentAck(label);
        setMessage({ tone: "info", text: `Inserted ${label} context.` });
      }),
    [controlsDisabled, controlsDisabledMessage, form.mode, point, projectRoot, runBusy],
  );

  const openSource = useCallback(
    (file: string) => {
      if (!projectRoot) return;
      void openPathInEditor({ rootPath: projectRoot, relativePath: file, target: "default" });
    },
    [projectRoot],
  );

  /* ── Draw ─────────────────────────────────────────────────────────────── */

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 p-1 font-sans text-[11px] text-fg/75">
      {/* Top row: launch input + Run, or running command + Stop/Show/Minimize */}
      {!hasActiveSession ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <input
            value={form.launchCommand}
            onChange={(event) => patchForm({ launchCommand: event.target.value })}
            placeholder='Launch command, e.g. "pnpm dev"'
            aria-label="Electron Control launch command"
            className="min-w-0 flex-1 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 text-[10px] text-fg/80 outline-none placeholder:text-muted-fg/40 focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
            onKeyDown={(event) => {
              if (event.key === "Enter" && canLaunch) void launchSelected();
            }}
          />
          <button
            type="button"
            disabled={Boolean(busy) || !canLaunch}
            onClick={launchSelected}
            className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded border border-[color-mix(in_srgb,var(--color-accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] px-2 text-[10px] font-medium text-fg/90 transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-45"
            title="Launch command in the terminal"
            aria-label="Launch Electron Control command"
          >
            {busy === "launch" ? <SpinnerGap size={13} className="animate-spin" /> : <Play size={12} weight="fill" />}
            Run
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.025] px-2.5 py-1.5">
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide",
              STATUS_PILL_TONE[sessionStatus.tone],
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                STATUS_DOT_TONE[sessionStatus.tone],
                sessionStatus.tone === "warn" || sessionStatus.tone === "active" ? "animate-pulse" : null,
              )}
            />
            {sessionStatus.label}
          </span>
          <div className="min-w-0 flex-1 truncate text-[11px] text-fg/72" title={sessionStatus.detail}>
            {activeSession?.label ?? sessionStatus.detail}
          </div>
          {sessionConnected ? (
            <>
              <button
                type="button"
                disabled={Boolean(busy) || controlsDisabled}
                onClick={focusWindow}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-[10px] font-medium text-fg/65 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
                title="Show the controlled app window"
                aria-label="Show controlled app window"
              >
                {busy === "focus-window" ? <SpinnerGap size={12} className="animate-spin" /> : <ArrowSquareOut size={11} />}
                Show
              </button>
              <button
                type="button"
                disabled={Boolean(busy) || controlsDisabled}
                onClick={minimizeWindow}
                className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-fg/65 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
                title="Minimize the controlled app window"
                aria-label="Minimize controlled app window"
              >
                {busy === "minimize-window" ? <SpinnerGap size={12} className="animate-spin" /> : <Minus size={11} />}
              </button>
            </>
          ) : null}
          {canStop ? (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={stopSession}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-rose-400/22 bg-rose-500/10 px-2 text-[10px] font-medium text-rose-100/85 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-45"
              title="Stop the active session"
              aria-label="Stop Electron Control session"
            >
              {busy === "stop" ? <SpinnerGap size={12} className="animate-spin" /> : <Stop size={11} weight="fill" />}
              Stop
            </button>
          ) : null}
        </div>
      )}

      {/* Compact CDP attach row */}
      {!hasActiveSession ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <span className="font-sans text-[9px] uppercase tracking-wide text-muted-fg/50">Or attach</span>
          <input
            value={form.cdpPort}
            onChange={(event) => patchForm({ cdpPort: event.target.value })}
            placeholder="CDP port"
            aria-label="CDP port"
            inputMode="numeric"
            disabled={controlsDisabled}
            className="w-[80px] shrink-0 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 text-[10px] text-fg/80 outline-none placeholder:text-muted-fg/40 focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
            onKeyDown={(event) => {
              if (event.key === "Enter" && form.cdpPort.trim()) void connectPort();
            }}
          />
          <button
            type="button"
            disabled={Boolean(busy) || !form.cdpPort.trim() || controlsDisabled}
            onClick={connectPort}
            className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-[10px] font-medium text-fg/72 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
            title="Connect to a running Electron app via CDP"
          >
            {busy === "connect" ? <SpinnerGap size={11} className="animate-spin" /> : <Link size={11} />}
            Connect
          </button>
        </div>
      ) : null}

      {/* The target picker */}
      {sessionConnected && targets.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-fg/55">Window</span>
          <select
            value={pendingTargetId ?? targets.find((target) => target.active)?.id ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              if (value) attachToTargetId(value);
            }}
            className="min-w-0 flex-1 rounded-md border border-white/[0.06] bg-black/30 px-2 py-1 text-[11px] text-fg/85 outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
            aria-label="Switch the controlled window"
            disabled={Boolean(busy) || targets.length < 2 || controlsDisabled}
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.active ? "● " : ""}{targetLabel(target)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void refreshTargets()}
            disabled={controlsDisabled}
            className="inline-flex h-6 shrink-0 items-center justify-center rounded border border-white/[0.06] bg-white/[0.02] px-1.5 text-[10px] text-muted-fg/65 hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
            title="Re-scan controlled app windows"
            aria-label="Re-scan controlled app windows"
          >
            {targets.length}
          </button>
        </div>
      ) : null}

      {/* The blockers card: why this host will not drive, and what it is waiting on */}
      {controlsDisabledReason || statusError || (waitingForCdp && activeSession?.cdpPort) ? (
        <div
          className="flex shrink-0 flex-col gap-1 rounded-md border border-amber-400/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-100/85"
          role="status"
        >
          {controlsDisabledReason ? (
            <div className="flex items-start gap-2">
              <WarningCircle size={12} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{controlsDisabledReason}</span>
            </div>
          ) : null}
          {statusError ? (
            <div className="flex items-start gap-2">
              <WarningCircle size={12} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">Could not read Electron Control: {statusError}</span>
            </div>
          ) : null}
          {waitingForCdp && activeSession?.cdpPort ? (
            <div className="flex items-start gap-2">
              <WarningCircle size={12} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">
                Waiting for CDP on 127.0.0.1:{activeSession.cdpPort}. If the app is running but Electron Control is
                blank, quit any existing app instance or wire ADE_APP_CONTROL_DEBUG_FLAGS into the launcher.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <div
          className={cn(
            "flex shrink-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px]",
            message.tone === "error"
              ? "border-rose-400/22 bg-rose-500/10 text-rose-100/85"
              : "border-sky-400/18 bg-sky-500/8 text-sky-100/80",
          )}
          role={message.tone === "error" ? "alert" : "status"}
        >
          <WarningCircle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{message.text}</span>
          <button
            type="button"
            onClick={() => setMessage(null)}
            className="ml-auto shrink-0 rounded p-0.5 text-current opacity-50 transition-opacity hover:opacity-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* The reserved rect. The HOST paints `electron-control` here. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded border border-white/[0.08] bg-white/[0.02]">
        <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-1.5 py-1">
          <button
            type="button"
            disabled={Boolean(busy) || !sessionConnected || controlsDisabled}
            onClick={() =>
              void runBusy("snapshot", async () => {
                await refreshSnapshot();
                setMessage({ tone: "info", text: "Snapshot refreshed." });
              })
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-black/25 px-2 text-[10px] font-medium text-fg/72 transition-colors hover:bg-black/40 disabled:cursor-not-allowed disabled:opacity-45"
            title="Re-capture the DOM snapshot"
          >
            {busy === "snapshot" ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowClockwise size={11} />}
            Snapshot
          </button>
          <div
            className={cn(
              "inline-flex items-center rounded-md border border-white/[0.08] bg-black/25 p-0.5",
              !hasActiveSession ? "opacity-45" : null,
            )}
            aria-label="Electron Control mode"
          >
            {(["control", "inspect"] as const).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                disabled={!hasActiveSession || controlsDisabled}
                onClick={() => patchForm({ mode: nextMode })}
                className={cn(
                  "h-6 rounded-[3px] px-2 text-[10px] font-medium transition-colors disabled:cursor-not-allowed",
                  form.mode === nextMode
                    ? "bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-fg/90 shadow-sm"
                    : "text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg/80",
                )}
              >
                {nextMode === "control" ? "Control" : "Inspect"}
              </button>
            ))}
          </div>
          {snapshot?.url ? (
            <div
              className="ml-auto max-w-[50%] truncate rounded-md border border-white/[0.08] bg-black/25 px-2 py-1 text-[10px] text-muted-fg/65"
              title={snapshot.url}
            >
              {snapshot.title ?? snapshot.url}
            </div>
          ) : null}
        </div>

        <div
          ref={attachEngine}
          data-ade-engine-rect={ENGINE_ID}
          data-testid="engine-rect"
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        >
          {/*
            Empty ON PURPOSE when the host can paint. The engine's native view
            lands over this box, and anything drawn here would be covered by it
            or, worse, would show through as a flash before the first frame.
          */}
          {engineAvailable ? null : (
            <div className="flex max-w-[360px] flex-col items-center gap-3 px-4 text-center text-muted-fg/55">
              <Desktop size={28} className="text-muted-fg/30" />
              <div className="text-[12px] font-medium text-fg/70">No live view</div>
              <div className="text-[11px] leading-5 text-muted-fg/55">{NO_ENGINE_MESSAGE}</div>
            </div>
          )}
        </div>
      </div>

      {/* Drive controls: the coordinate the compiled pane read off a click. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 rounded border border-white/[0.08] bg-white/[0.025] px-1.5 py-1">
        <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-fg/50">Point</span>
        <input
          value={pointX}
          onChange={(event) => setPointX(event.target.value)}
          aria-label="Viewport x"
          inputMode="numeric"
          className="w-[56px] shrink-0 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 text-[10px] text-fg/80 outline-none"
        />
        <input
          value={pointY}
          onChange={(event) => setPointY(event.target.value)}
          aria-label="Viewport y"
          inputMode="numeric"
          className="w-[56px] shrink-0 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 text-[10px] text-fg/80 outline-none"
        />
        {form.mode === "control" ? (
          <>
            <button
              type="button"
              disabled={Boolean(busy) || !sessionConnected || controlsDisabled}
              onClick={clickPoint}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-[10px] font-medium text-fg/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
              title="Click the app at this viewport coordinate"
              aria-label="Click the app"
            >
              {busy === "click" ? <SpinnerGap size={11} className="animate-spin" /> : <Cursor size={11} />}
              Click
            </button>
            <input
              value={deltaY}
              onChange={(event) => setDeltaY(event.target.value)}
              aria-label="Scroll amount"
              inputMode="numeric"
              className="w-[56px] shrink-0 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 text-[10px] text-fg/80 outline-none"
            />
            <button
              type="button"
              disabled={Boolean(busy) || !sessionConnected || controlsDisabled}
              onClick={scrollPoint}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-[10px] font-medium text-fg/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
              title="Scroll the app at this viewport coordinate"
              aria-label="Scroll the app"
            >
              {busy === "scroll" ? <SpinnerGap size={11} className="animate-spin" /> : <MouseScroll size={11} />}
              Scroll
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={Boolean(busy) || !sessionConnected || controlsDisabled}
              onClick={inspectAtPoint}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-[10px] font-medium text-fg/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
              title="Read what the app has at this viewport coordinate"
              aria-label="Inspect point"
            >
              {busy === "inspect" ? <SpinnerGap size={11} className="animate-spin" /> : <Crosshair size={11} />}
              Inspect
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !sessionConnected || controlsDisabled}
              onClick={selectAtPoint}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-[10px] font-medium text-fg/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
              title="Attach what is at this coordinate to the chat"
              aria-label="Attach point context"
            >
              {busy === "select" ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowClockwise size={11} />}
              Attach
            </button>
            <span
              className={cn(
                "inline-flex h-7 shrink-0 items-center rounded-md border px-2 text-[10px] font-medium",
                attachmentAck
                  ? "border-emerald-300/25 bg-emerald-500/10 text-emerald-100/85"
                  : "border-white/[0.08] bg-white/[0.03] text-muted-fg/60",
              )}
            >
              {attachmentAck ? `Inserted ${attachmentAck} context` : "Inspect mode inserts clicked element context"}
            </span>
          </>
        )}
      </div>

      {/* The inspect list */}
      <div
        className="max-h-[30%] min-h-0 shrink-0 overflow-y-auto rounded border border-white/[0.08] bg-white/[0.025] px-1.5 py-1"
        data-testid="inspect-list"
      >
        {elements.length === 0 ? (
          <div className="text-[11px] text-muted-fg/55">
            {sessionConnected
              ? "Take a snapshot, or inspect a point, to list what the app is showing."
              : "Launch or connect to inspect elements."}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {elements.map((element) => {
              const sub = elementSubLabel(element);
              return (
                <li
                  key={element.id}
                  className={cn(
                    "rounded px-1 py-0.5",
                    selectedElement?.id === element.id ? "bg-sky-300/10" : null,
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[11px] font-medium text-fg/85" title={elementLabel(element)}>
                      {elementLabel(element)}
                    </span>
                    {sub ? (
                      <span className="shrink-0 rounded border border-white/[0.08] bg-white/[0.03] px-1 font-mono text-[9px] uppercase tracking-wide text-muted-fg/60">
                        {sub}
                      </span>
                    ) : null}
                    {selectedElement?.id === element.id ? (
                      <span className="ml-auto shrink-0 text-[10px] text-sky-200/70">selected</span>
                    ) : null}
                  </div>
                  {element.selector ? (
                    <div className="truncate font-mono text-[10px] text-muted-fg/55" title={element.selector}>
                      {element.selector}
                    </div>
                  ) : null}
                  <div className="text-[10px] text-muted-fg/45">
                    {Math.round(element.pixelFrame.x)}, {Math.round(element.pixelFrame.y)} ·{" "}
                    {Math.round(element.pixelFrame.width)}×{Math.round(element.pixelFrame.height)}
                    {element.testId ? <span className="ml-2">testId={element.testId}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* The source line of whatever is selected, and the type-text field */}
      {selectedElement && typeof selectedElement.metadata?.sourceFile === "string" && projectRoot ? (
        editorAvailable ? (
          <button
            type="button"
            onClick={() => openSource(selectedElement.metadata.sourceFile as string)}
            className="shrink-0 truncate rounded border border-white/[0.08] bg-white/[0.02] px-1.5 py-1 text-left font-mono text-[10px] text-sky-100/65 hover:text-sky-100/90"
            title="Open this element's source in ADE"
          >
            {String(selectedElement.metadata.sourceFile)}
            {typeof selectedElement.metadata.sourceLine === "number"
              ? `:${selectedElement.metadata.sourceLine}`
              : ""}
          </button>
        ) : (
          <div
            className="shrink-0 truncate rounded border border-white/[0.08] bg-white/[0.02] px-1.5 py-1 text-left font-mono text-[10px] text-muted-fg/55"
            title="This ADE cannot open the file in an editor."
            data-testid="source-inert"
          >
            {String(selectedElement.metadata.sourceFile)}
            {typeof selectedElement.metadata.sourceLine === "number"
              ? `:${selectedElement.metadata.sourceLine}`
              : ""}
          </div>
        )
      ) : null}

      <div className="flex min-w-0 shrink-0 items-center gap-1 rounded border border-white/[0.08] bg-black/20 pl-1.5 focus-within:border-sky-300/30">
        <Keyboard size={10} className="shrink-0 text-muted-fg/55" />
        <input
          value={typeText}
          onChange={(event) => setTypeText(event.target.value)}
          placeholder="Type into focused element"
          aria-label="Text to type into the focused app element"
          className="h-7 min-w-0 flex-1 bg-transparent text-[10px] text-fg/80 outline-none placeholder:text-muted-fg/40"
          onKeyDown={(event) => {
            if (event.key === "Enter") void typeIntoApp();
          }}
        />
        <button
          type="button"
          disabled={Boolean(busy) || !canType}
          onClick={typeIntoApp}
          className="inline-flex h-7 shrink-0 items-center justify-center rounded-r border-l border-white/[0.06] px-1.5 text-[10px] font-medium text-fg/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
          title="Send keystrokes to the focused element"
          aria-label="Type into focused app element"
        >
          {busy === "type" ? <SpinnerGap size={12} className="animate-spin" /> : "Type"}
        </button>
      </div>
    </div>
  );
}
