/**
 * iOS Sim Control, as one page.
 *
 * The compiled `ChatIosSimulatorPanel.tsx` was 3,777 lines because it held two
 * jobs at once: the chrome, and the live `Simulator.app` window capture that
 * drives it — `desktopCapturer` constraints, a `<video>` element, frame-stall
 * detection, window-parking retain/release, a heuristic that finds the device
 * screen inside the captured window. The second job cannot cross into a guest
 * and has not: it stays in the host engine, and this page reserves a rect for
 * it (`components/EngineStage.tsx`).
 *
 * What moved is everything a reader touches: the device picker, the launch
 * target picker, Launch / Apply / Stop, the Control and Inspect toolbar, the
 * zoom rail, the setup chips, the ownership card and Preview Lab. Every verb
 * behind them goes through `host/actions.ts` into the plugin's own child.
 *
 * The pointer surface is the one piece that had to be re-derived rather than
 * copied. The compiled pane measured the `<video>`'s object-contain box and
 * mapped a pointer through it; the page has no video, so it maps through the
 * RESERVED RECT instead — which is the same number, because the rect is exactly
 * what the host paints into.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BracketsCurly, DeviceMobile, Desktop } from "@phosphor-icons/react";
import { cn, EmptyState } from "@ade-dev/ui";

import type { HostEngineRect, PluginWebviewContext } from "../bridge";
import * as actions from "../host/actions";
import { NO_ENGINE_MESSAGE, hasHostEngine } from "../host/engine";
import * as ui from "../host/ui";
import {
  DEFAULT_UI_STATE,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  loadUiState,
  saveUiState,
  type SimUiState,
} from "../host/uiState";
import type {
  IosScreenElement,
  IosSimulatorDevice,
  IosSimulatorLaunchTarget,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosSimulatorRenderPreviewResult,
  IosSimulatorStatus,
  SimulatorMode,
} from "../types";
import { EngineStage } from "../components/EngineStage";
import { DevicePicker, LaunchTargetPicker } from "../components/LaunchBar";
import { OwnershipCard } from "../components/OwnershipCard";
import { PreviewLab } from "../components/PreviewLab";
import { ModeToolbar, ZoomControl } from "../components/StageControls";
import { ToolChips, UnsupportedCard } from "../components/ToolChips";
import {
  buildToolChips,
  chipsHealthy,
  elementLabel,
  formatAge,
  setupBlocked as chipsBlockSetup,
  shortChatId,
} from "../components/simFormat";

/** How far a pointer may travel before a tap is read as a drag. */
const DRAG_THRESHOLD_PX = 6;

/** The stream the compiled pane asked for, kept so the host gets the same rate. */
const STREAM_FPS = 60;

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

/** The chat this placement is drawn beside, when it is drawn beside one. */
function chatIdOf(context: PluginWebviewContext): string | null {
  const subject = context.subject;
  if (!subject || subject.kind !== "chat") return null;
  const id = (subject as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

export function SimEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const projectRoot = context.project?.root ?? null;
  const chatSessionId = chatIdOf(context);

  const [uiState, setUiState] = useState<SimUiState>(DEFAULT_UI_STATE);
  const [status, setStatus] = useState<IosSimulatorStatus | null>(null);
  const [devices, setDevices] = useState<IosSimulatorDevice[]>([]);
  const [targets, setTargets] = useState<IosSimulatorLaunchTarget[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [rect, setRect] = useState<HostEngineRect | null>(null);
  const [selectedElement, setSelectedElement] = useState<IosScreenElement | null>(null);
  const [previewCapability, setPreviewCapability] = useState<IosSimulatorPreviewCapability | null>(null);
  const [previewTargets, setPreviewTargets] = useState<IosSimulatorPreviewTarget[]>([]);
  const [previewMatch, setPreviewMatch] = useState<IosSimulatorPreviewMatch | null>(null);
  const [preview, setPreview] = useState<IosSimulatorRenderPreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const mode: SimulatorMode = uiState.mode;
  const surface = mode === "preview" ? "preview" : "simulator";
  const session = status?.activeSession ?? null;
  const live = Boolean(session);
  const ownedByOther = Boolean(
    session?.chatSessionId && chatSessionId && session.chatSessionId !== chatSessionId,
  );

  const chips = useMemo(() => buildToolChips(status, devices), [status, devices]);
  const setupBlocked = chipsBlockSetup(chips);
  const healthy = chipsHealthy(chips);

  const activeDevice = useMemo(
    () => devices.find((device) => device.udid === uiState.deviceUdid) ?? devices[0] ?? null,
    [devices, uiState.deviceUdid],
  );
  const activeTarget = useMemo(
    () => targets.find((target) => target.id === uiState.targetId) ?? targets[0] ?? null,
    [targets, uiState.targetId],
  );
  const engineAvailable = hasHostEngine();

  const patch = useCallback(
    (next: Partial<SimUiState>) => {
      setUiState((current) => {
        const merged = { ...current, ...next };
        void saveUiState(projectRoot, merged);
        return merged;
      });
    },
    [projectRoot],
  );

  /* ── Reads ────────────────────────────────────────────────────────────── */

  const refreshTargets = useCallback(async (deviceUdid: string | null) => {
    try {
      setTargets(await actions.listLaunchTargets(deviceUdid));
    } catch (error) {
      // A read whose failure has an honest place to live: the target row draws
      // "No launchable app found" and the line below says why.
      setTargets([]);
      setMessage(messageOf(error, "Could not list launchable apps."));
    }
  }, []);

  const refreshStatus = useCallback(async (): Promise<IosSimulatorStatus | null> => {
    const [next, nextDevices] = await Promise.all([
      actions.getStatus().catch((error: unknown) => {
        setMessage(messageOf(error, "Could not read this machine's simulator state."));
        return null;
      }),
      actions.listDevices().catch(() => [] as IosSimulatorDevice[]),
    ]);
    setStatus(next);
    setDevices(nextDevices);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadUiState(projectRoot);
      if (cancelled) return;
      setUiState(stored);
      const next = await refreshStatus();
      if (cancelled) return;
      const udid = stored.deviceUdid ?? next?.activeDevice?.udid ?? null;
      await refreshTargets(udid);
      if (cancelled) return;
      await actions.getStreamStatus().catch(() => null);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRoot, refreshStatus, refreshTargets]);

  /**
   * The child's own publish is the page's event feed.
   *
   * The compiled pane subscribed to `window.ade.iosSimulator.onEvent`, which a
   * guest has no reach to. The plugin's child holds that subscription instead
   * and republishes its status row, so a `changed` frame on the `status`
   * collection means exactly what a `session-updated` event meant.
   */
  useEffect(() => {
    const api = typeof window === "undefined" ? null : window.adePlugin ?? null;
    if (!api) return;
    try {
      return api.events.on("changed", (event) => {
        if (event.collection && event.collection !== "status") return;
        void refreshStatus();
      });
    } catch {
      return;
    }
  }, [refreshStatus]);

  // The ownership card's age line, which is only ever a minute stale.
  useEffect(() => {
    if (!ownedByOther) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [ownedByOther]);

  /* ── The session ──────────────────────────────────────────────────────── */

  const launch = useCallback(
    async (previewTargetId?: string | null) => {
      setBusy(true);
      setMessage("Building and launching…");
      try {
        const result = await actions.launch({
          deviceUdid: activeDevice?.udid ?? null,
          targetId: activeTarget?.id ?? null,
          ...(previewTargetId ? { previewTargetId } : {}),
        });
        if (!result.ok) {
          setMessage(result.message ?? "The launch was refused.");
          return;
        }
        setMessage(result.message ?? "Launched.");
        await refreshStatus();
        const stream = await actions.startStream({
          deviceUdid: activeDevice?.udid ?? null,
          fps: STREAM_FPS,
        });
        if (!stream.ok) setMessage(stream.message ?? "The live screen could not start.");
      } catch (error) {
        setMessage(messageOf(error, "The launch failed."));
      } finally {
        setBusy(false);
      }
    },
    [activeDevice, activeTarget, refreshStatus],
  );

  const stop = useCallback(async () => {
    const confirmed = await ui.confirm({
      title: "Stop the simulator?",
      body: "Any running app will be terminated.",
      confirmLabel: "Stop",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await actions.stopStream();
      const result = await actions.shutdown();
      setMessage(result.ok ? result.message ?? "Stopped." : result.message ?? "Could not stop.");
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  const attach = useCallback(
    async (takeOver: boolean) => {
      setBusy(true);
      try {
        const result = await actions.attachToChatSession({ chatSessionId, takeOver });
        setMessage(result.message ?? (result.ok ? "Attached." : "That session belongs to another chat."));
        await refreshStatus();
      } finally {
        setBusy(false);
      }
    },
    [chatSessionId, refreshStatus],
  );

  /* ── Control and Inspect ──────────────────────────────────────────────── */

  /**
   * A client point, in the running device's own coordinates.
   *
   * The reserved rect IS the painted box, so the mapping is the rect's origin
   * and its scale — no `object-contain` measurement, because the host fits the
   * screen to the rect it was given.
   */
  const toDevicePoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: Math.round(clientX - rect.x),
        y: Math.round(clientY - rect.y),
      };
    },
    [rect],
  );

  const onStagePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const point = toDevicePoint(event.clientX, event.clientY);
      if (!point) return;
      dragStart.current = point;
    },
    [toDevicePoint],
  );

  const onStagePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStart.current;
      dragStart.current = null;
      const point = toDevicePoint(event.clientX, event.clientY);
      if (!point) return;
      const udid = activeDevice?.udid ?? null;

      if (mode === "inspect") {
        void (async () => {
          const result = await actions.selectPoint({ deviceUdid: udid, x: point.x, y: point.y });
          if (!result.ok) {
            setMessage(result.message ?? "Nothing to inspect at that point.");
            return;
          }
          const element = (result.element ?? null) as IosScreenElement | null;
          setSelectedElement(element);
          setMessage(element ? `Selected ${elementLabel(element)}.` : "No element at that point.");
        })();
        return;
      }

      const travelled = start
        ? Math.hypot(point.x - start.x, point.y - start.y)
        : 0;
      void (async () => {
        const result =
          start && travelled > DRAG_THRESHOLD_PX
            ? await actions.drag({
              deviceUdid: udid,
              fromX: start.x,
              fromY: start.y,
              toX: point.x,
              toY: point.y,
            })
            : await actions.tap({ deviceUdid: udid, x: point.x, y: point.y });
        if (!result.ok) setMessage(result.message ?? "That gesture was refused.");
      })();
    },
    [activeDevice, mode, toDevicePoint],
  );

  const onStageKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (mode !== "interact") return;
      const text = event.key === "Enter" ? "\n" : event.key.length === 1 ? event.key : null;
      if (!text) return;
      event.preventDefault();
      void actions
        .typeText({ deviceUdid: activeDevice?.udid ?? null, text })
        .then((result) => {
          if (!result.ok) setMessage(result.message ?? "Typing was refused.");
        })
        .catch((error: unknown) => setMessage(messageOf(error, "Typing failed.")));
    },
    [activeDevice, mode],
  );

  /* ── Preview Lab ──────────────────────────────────────────────────────── */

  const refreshPreviewLab = useCallback(async () => {
    setPreviewBusy(true);
    setMessage("Checking the Xcode preview bridge. Click Allow if Xcode asks.");
    try {
      const sourceFile = selectedElement?.sourceFile ?? null;
      const sourceLine = selectedElement?.sourceLine ?? null;
      const [workspace, nextTargets, match] = await Promise.all([
        actions.ensurePreviewWorkspace({ sourceFile, sourceLine, openIfNeeded: true }),
        actions.listPreviewTargets({ sourceFile, sourceLine }),
        actions.resolvePreviewMatch({
          sourceFile,
          sourceLine,
          elementLabel: selectedElement ? elementLabel(selectedElement) : null,
          componentId: selectedElement?.componentId ?? null,
        }),
      ]);
      setPreviewCapability(workspace.capability ?? null);
      setPreviewTargets(nextTargets);
      setPreviewMatch(match);
      const matched = match?.target?.id ?? null;
      patch({
        previewTargetId:
          matched && nextTargets.some((target) => target.id === matched)
            ? matched
            : uiState.previewTargetId
              && nextTargets.some((target) => target.id === uiState.previewTargetId)
              ? uiState.previewTargetId
              : nextTargets[0]?.id ?? null,
      });
      if (!workspace.ok) setMessage(workspace.message ?? "Preview Lab is not ready on this Mac.");
      else setMessage(null);
    } catch (error) {
      setMessage(messageOf(error, "Could not reach the Xcode preview bridge."));
    } finally {
      setPreviewBusy(false);
    }
  }, [patch, selectedElement, uiState.previewTargetId]);

  useEffect(() => {
    if (mode !== "preview") return;
    if (previewCapability) return;
    void refreshPreviewLab();
  }, [mode, previewCapability, refreshPreviewLab]);

  const renderSelectedPreview = useCallback(async () => {
    const target =
      previewTargets.find((entry) => entry.id === uiState.previewTargetId) ?? previewTargets[0] ?? null;
    if (!target) return;
    setPreviewBusy(true);
    try {
      const result = await actions.renderPreview({
        sourceFilePath: target.sourceFilePath,
        previewDefinitionIndexInFile: target.previewDefinitionIndexInFile,
        tabIdentifier: previewCapability?.selectedWindow?.tabIdentifier ?? null,
      });
      setPreview(result.preview ?? null);
      if (!result.ok) setMessage(result.message ?? "The preview did not render.");
    } finally {
      setPreviewBusy(false);
    }
  }, [previewCapability, previewTargets, uiState.previewTargetId]);

  const openWorkspace = useCallback(async () => {
    const result = await actions.openPreviewWorkspace();
    if (!result.ok) {
      setMessage(result.message ?? "Could not open the Xcode workspace.");
      return;
    }
    if (result.path && projectRoot) {
      await ui.openPathInEditor({
        rootPath: projectRoot,
        relativePath: ui.relativePathFromRoot(projectRoot, result.path),
        target: "default",
      });
    }
  }, [projectRoot]);

  /* ── Layout ───────────────────────────────────────────────────────────── */

  const stageActive =
    surface === "simulator" && !setupBlocked && !ownedByOther && live;

  const zoomStyle = useMemo(
    () => ({ width: `${uiState.zoom * 100}%`, height: `${uiState.zoom * 100}%` }),
    [uiState.zoom],
  );

  const changeZoom = useCallback(
    (delta: number) => {
      patch({ zoom: clampZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, uiState.zoom + delta))) });
    },
    [patch, uiState.zoom],
  );

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", expanded ? "gap-0" : "gap-1", "p-1")}
      data-sim-pane="root"
    >
      <div className={cn("shrink-0 space-y-1", expanded ? "hidden" : null)}>
        <div className="flex flex-wrap items-center justify-between gap-1.5 px-0.5 py-0.5">
          <div className="flex rounded border border-white/[0.08] bg-black/20 p-px">
            <button
              type="button"
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-[3px] px-2 font-sans text-[10px] font-medium transition-colors",
                surface === "simulator" ? "bg-white/[0.10] text-fg/90" : "text-muted-fg/50 hover:text-fg/75",
              )}
              aria-pressed={surface === "simulator"}
              onClick={() => patch({ mode: "interact" })}
            >
              <DeviceMobile size={11} />
              Simulator
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-[3px] px-2 font-sans text-[10px] font-medium transition-colors",
                surface === "preview" ? "bg-white/[0.10] text-fg/90" : "text-muted-fg/50 hover:text-fg/75",
              )}
              aria-pressed={surface === "preview"}
              onClick={() => patch({ mode: "preview" })}
            >
              <BracketsCurly size={11} />
              Preview
            </button>
          </div>
          {surface === "simulator" && live ? (
            <div className="inline-flex h-6 items-center gap-1 rounded-full border border-cyan-300/20 bg-cyan-400/[0.09] px-2 font-sans text-[10px] font-medium text-cyan-50/80">
              <Desktop size={11} />
              Live
            </div>
          ) : null}
        </div>

        {surface === "simulator" ? (
          <>
            <DevicePicker
              devices={devices}
              selectedUdid={activeDevice?.udid ?? null}
              disabled={busy || ownedByOther}
              busy={busy}
              canStop={live && !ownedByOther}
              onSelect={(udid) => {
                patch({ deviceUdid: udid });
                setSelectedElement(null);
                void refreshTargets(udid);
              }}
              onRefresh={() => {
                void refreshStatus().then(() => refreshTargets(activeDevice?.udid ?? null));
              }}
              onStop={() => void stop()}
            />
            <LaunchTargetPicker
              targets={targets}
              selectedId={activeTarget?.id ?? null}
              canLaunch={Boolean(status?.supported) && !ownedByOther}
              busy={busy}
              live={live && !ownedByOther}
              onSelect={(id) => patch({ targetId: id })}
              onLaunch={() => void launch()}
            />
          </>
        ) : (
          <PreviewLab
            capability={previewCapability}
            targets={previewTargets}
            match={previewMatch}
            selectedTargetId={uiState.previewTargetId}
            preview={preview}
            busy={previewBusy}
            canOpenInEditor={ui.canOpenPathInEditor()}
            onSelect={(id) => {
              patch({ previewTargetId: id });
              setPreview(null);
            }}
            onRender={() => void renderSelectedPreview()}
            onViewInSimulator={() => void launch(uiState.previewTargetId)}
            onRefresh={() => void refreshPreviewLab()}
            onOpenWorkspace={() => void openWorkspace()}
            onOpenDocs={(url) => void ui.openLink(url)}
          />
        )}
      </div>

      {!expanded && ownedByOther ? (
        <OwnershipCard
          ownerLabel={session?.laneId ?? shortChatId(session?.chatSessionId ?? "")}
          ageLabel={formatAge(session?.claimedAt ?? session?.startedAt, now)}
          onAttach={chatSessionId ? () => void attach(false) : null}
          onTakeOver={() => void attach(true)}
          busy={busy}
        />
      ) : null}

      {/*
        Guarded on `status` for the same reason `setupBlocked` is: the chips read
        "missing" until the first status lands, so an unguarded row flashed
        "Xcode ● missing / Runtime ● missing" on a perfectly healthy Mac every
        time the pane opened.
      */}
      {!expanded && Boolean(status) && !setupBlocked && !healthy ? (
        <ToolChips
          chips={chips}
          onCopy={(text) => void ui.writeClipboard(text)}
          className="shrink-0 px-0.5"
        />
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-white/[0.08] bg-white/[0.02]">
        {setupBlocked && surface === "simulator" ? (
          <UnsupportedCard chips={chips} onCopy={(text) => void ui.writeClipboard(text)} />
        ) : surface === "preview" ? (
          <div className="flex h-full items-center justify-center p-4 text-center font-sans text-[11px] text-muted-fg/55">
            {preview?.dataUrl
              ? "The rendered preview is above."
              : "Render a #Preview to see it here."}
          </div>
        ) : !live ? (
          <EmptyState
            icon={DeviceMobile}
            iconSize={22}
            title="No simulator running"
            description={
              engineAvailable
                ? "Pick a device and a launch target, then press Launch."
                : NO_ENGINE_MESSAGE
            }
          />
        ) : (
          <>
            <div
              className={cn(
                "absolute inset-0",
                uiState.zoom > ZOOM_MIN ? "overflow-auto" : "overflow-hidden",
              )}
            >
              <EngineStage
                active={stageActive}
                style={zoomStyle}
                remeasureKey={`${uiState.zoom}:${expanded ? 1 : 0}`}
                onRectChange={setRect}
              >
                {/*
                  The control surface. Transparent, absolutely filling the
                  reserved rect, and the only thing between a reader's pointer
                  and the running app — which is why the toolbar and the zoom
                  rail are drawn OUTSIDE the stage, where they cannot be tapped
                  through into the device.
                */}
                <div
                  data-sim-pane="control-surface"
                  role="application"
                  aria-label="Simulator screen"
                  tabIndex={0}
                  className={cn("absolute inset-0", mode === "inspect" ? "cursor-crosshair" : "cursor-pointer")}
                  onPointerDown={onStagePointerDown}
                  onPointerUp={onStagePointerUp}
                  onKeyDown={onStageKeyDown}
                />
              </EngineStage>
            </div>
            <ModeToolbar mode={mode} onMode={(next) => patch({ mode: next })} />
            <ZoomControl
              zoom={uiState.zoom}
              expanded={expanded}
              onZoom={changeZoom}
              onResetZoom={() => patch({ zoom: ZOOM_MIN })}
              onToggleExpanded={() => setExpanded((current) => !current)}
              surfaceLabel="simulator"
            />
          </>
        )}
      </div>

      {selectedElement ? (
        <div
          className="shrink-0 truncate rounded border border-cyan-300/20 bg-cyan-400/[0.07] px-2 py-1 font-sans text-[10px] text-cyan-50/85"
          data-sim-pane="selection"
        >
          {elementLabel(selectedElement)}
          {selectedElement.sourceFile ? (
            <span className="ml-1 text-cyan-100/55">
              {selectedElement.sourceFile}
              {selectedElement.sourceLine ? `:${selectedElement.sourceLine}` : ""}
            </span>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <div
          className="shrink-0 truncate px-1 font-sans text-[10px] text-muted-fg/60"
          data-sim-pane="message"
        >
          {message}
        </div>
      ) : null}
    </div>
  );
}
