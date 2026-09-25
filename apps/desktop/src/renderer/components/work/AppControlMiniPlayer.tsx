import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppControlEventPayload,
  AppControlScreencastFrame,
  AppControlSession,
  OpenProjectBinding,
} from "../../../shared/types";
import { useAppStore, type WorkSidebarTab } from "../../state/appStore";
import { isWorkLivePreviewDisabled } from "../../state/workLiveCardState";
import { workRuntimeScopeKey } from "../../lib/chatMachineRouting";
import {
  noteFloatingWorkSurfaceShown,
  useWorkSurfaceElementMounted,
  workSurfaceKey,
} from "../../lib/workToolOnScreen";
import { cn } from "../ui/cn";
import { closeWorkLiveCardForChat, useChatCompanionUiState } from "../chat/chatCompanionUiState";
import { AppControlAgentCursor, type AgentCursorState } from "../chat/AppControlOverlays";
import { CURSOR_TRACE_ACTIONS, traceCursorPoint } from "../chat/appControlTrace";
import { useNativeToolFeedHandlers, useNativeToolFeeds } from "../terminals/NativeToolFeedsContext";
import type { NativeToolFeedScope } from "../terminals/useNativeToolSessions";
import {
  FloatingPlayerShell,
  useCanvasPictureInPicture,
  useFloatingPlayerFrame,
} from "../shared/FloatingPlayer";
import { floatingPlayerSourceSize, type FloatingPlayerSize } from "../shared/floatingPlayerLayout";
import { isWorkLivePictureInPictureSupported } from "./workLiveIosPictureInPicture";
import { appControlFloatState } from "./workLiveCard";
import {
  APP_CONTROL_CARD_ON_SCREEN_KEY,
  readAppControlMiniPlayerChoice,
  revokeAppControlCardForChat,
  useAppControlCardGrant,
  writeAppControlMiniPlayerChoice,
} from "./appControlCardGrants";

/**
 * The lane's App Control app, floating over the chat.
 *
 * The same player as the floating Apple device and Mac Desktop
 * (`FloatingPlayerShell`): drag it, resize it from any edge, hover it for Open
 * in pane, picture in picture and Close. At rest it is the picture and an 8px
 * dot, red while the app records. On hover it names itself: App Control, the
 * app, and Live or Recording.
 *
 * It replaces App Control's place in the corner card. The picture is the
 * lane's CDP screencast, which the Work page's one App Control feed already
 * receives: this player opens no stream of its own. Frames are painted onto a
 * canvas inside one rAF, so a 30 fps feed causes no React renders, and the
 * canvas is what picture in picture captures.
 */

/** An app window shape until the first frame reports its own size. */
const APP_FALLBACK: FloatingPlayerSize = { width: 1_280, height: 800 };
/** How long the agent cursor lingers after the action that summoned it. */
const AGENT_CURSOR_LINGER_MS = 1_400;

/**
 * The pane header's status word for the session (`statusInfo` in
 * `ChatAppControlPanel`), so the player and the pane never name one state two
 * ways: "live" for a connected app.
 */
function appControlStatusWord(session: AppControlSession): string {
  switch (session.status) {
    case "connected":
      return "live";
    case "starting":
      return "launching";
    case "running":
      return session.connectedAt && !session.cdpEndpoint ? "disconnected" : "launching";
    default:
      return session.status;
  }
}

function sessionIsLive(session: AppControlSession | null): boolean {
  return Boolean(session) && session?.status !== "stopped" && session?.status !== "exited";
}

export function AppControlMiniPlayer({
  active,
  laneId,
  paneTool,
  chatSessionId,
  sessionLaneId = null,
  runtimePin,
  onOpenInPane,
}: {
  /** The Work route is on screen. */
  active: boolean;
  /** The tools pane's lane. App Control keeps one session per lane. */
  laneId: string | null;
  /** The tool filling the tools pane, or null when the pane is closed. */
  paneTool: WorkSidebarTab | null;
  /** The chat on screen. */
  chatSessionId: string | null;
  /** The chat's own lane; null for a lane-less chat. */
  sessionLaneId?: string | null;
  runtimePin: OpenProjectBinding | null;
  onOpenInPane: () => void;
}) {
  const boundBinding = useAppStore((s) => s.projectBinding);
  const scopeKey = workRuntimeScopeKey(runtimePin, boundBinding);
  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;

  const { appControlSession: session, canAppControl, context } = useNativeToolFeeds();
  const companionUi = useChatCompanionUiState(chatSessionId);
  const floated = companionUi.workLiveCardFloating.includes("app-control");
  const dismissed = isWorkLivePreviewDisabled(companionUi.workLiveCardClosedByTool, "app-control") && !floated;
  const grantedAt = useAppControlCardGrant(laneId, chatSessionId);
  const paneMounted = useWorkSurfaceElementMounted(laneId ? workSurfaceKey("app-control", scopeKey, laneId) : null);

  const { present, visible } = appControlFloatState({
    active,
    laneId,
    chatSessionId,
    sessionLaneId,
    // The hosted web client gets App Control frames over its own stream
    // subscription, not the event feed this player paints from.
    available: canAppControl && !context.isWebClient,
    live: sessionIsLive(session),
    ownerChatSessionId: session?.chatSessionId ?? null,
    granted: grantedAt != null,
    floated,
    dismissed,
    paneTool,
    paneMounted,
  });

  const close = useCallback(() => {
    if (!chatSessionId) return;
    closeWorkLiveCardForChat(chatSessionId, "app-control", session?.id ?? laneId ?? "");
    revokeAppControlCardForChat(laneId, chatSessionId);
  }, [chatSessionId, laneId, session?.id]);

  if (!present || !laneId || !session) return null;
  return (
    <AppControlMiniPlayerBox
      laneId={laneId}
      session={session}
      onScreenKey={workSurfaceKey(APP_CONTROL_CARD_ON_SCREEN_KEY, scopeKey, laneId)}
      visible={visible}
      runtimePinRef={runtimePinRef}
      onOpenInPane={onOpenInPane}
      onClose={close}
    />
  );
}

function AppControlMiniPlayerBox({
  laneId,
  session,
  onScreenKey,
  visible,
  runtimePinRef,
  onOpenInPane,
  onClose,
}: {
  laneId: string;
  session: AppControlSession;
  onScreenKey: string;
  visible: boolean;
  runtimePinRef: { readonly current: OpenProjectBinding | null };
  onOpenInPane: () => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pip = useCanvasPictureInPicture(() => canvasRef.current);
  const stopPip = pip.stop;
  const [frameSize, setFrameSize] = useState<FloatingPlayerSize | null>(null);
  const [viewport, setViewport] = useState<{ viewportWidth: number; viewportHeight: number } | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [recording, setRecording] = useState(false);
  const [cursor, setCursor] = useState<AgentCursorState | null>(null);

  /* ── Frames: newest wins, one decode in flight, one paint per rAF ─────── */
  const pendingRef = useRef<AppControlScreencastFrame | null>(null);
  const decodingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const visibleRef = useRef(visible || pip.active);
  visibleRef.current = visible || pip.active;
  const targetIdRef = useRef<string | null>(session.cdpTargetId);
  targetIdRef.current = session.cdpTargetId;

  const pump = useCallback(() => {
    rafRef.current = null;
    if (decodingRef.current) return;
    const frame = pendingRef.current;
    pendingRef.current = null;
    if (!frame) return;
    decodingRef.current = true;
    const image = new Image();
    const done = () => {
      decodingRef.current = false;
      if (pendingRef.current && rafRef.current == null) rafRef.current = window.requestAnimationFrame(pump);
    };
    image.onload = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
        }
        canvas.getContext("2d")?.drawImage(image, 0, 0);
      }
      done();
    };
    image.onerror = done;
    image.src = `data:${frame.mimeType};base64,${frame.data}`;
  }, []);

  useEffect(() => () => {
    if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  /** Paints one frame (newest wins) and learns the picture's shape from it. */
  const acceptFrame = useCallback((frame: AppControlScreencastFrame) => {
    if (frame.cdpTargetId && targetIdRef.current && frame.cdpTargetId !== targetIdRef.current) return;
    // A hidden player keeps its place but paints nothing.
    if (!visibleRef.current) return;
    pendingRef.current = frame;
    if (rafRef.current == null) rafRef.current = window.requestAnimationFrame(pump);
    if (frame.width > 0 && frame.height > 0) {
      setFrameSize((current) => (
        current && current.width === frame.width && current.height === frame.height
          ? current
          : { width: frame.width, height: frame.height }
      ));
      const viewportWidth = frame.viewportWidth && frame.viewportWidth > 0
        ? frame.viewportWidth
        : Math.round(frame.width / (frame.scale || 1));
      const viewportHeight = frame.viewportHeight && frame.viewportHeight > 0
        ? frame.viewportHeight
        : Math.round(frame.height / (frame.scale || 1));
      setViewport((current) => (
        current && current.viewportWidth === viewportWidth && current.viewportHeight === viewportHeight
          ? current
          : { viewportWidth, viewportHeight }
      ));
    }
    setHasFrame(true);
  }, [pump]);

  const lastTraceIdRef = useRef<string | null>(session.lastTraceEntryId);
  const onAppControlEvent = useCallback((event: AppControlEventPayload, scope: NativeToolFeedScope) => {
    if (event.laneId !== laneId) return;
    if (event.type === "frame") {
      acceptFrame(event.frame);
      return;
    }
    if (event.type === "recording-changed") {
      setRecording(event.status.running === true);
      return;
    }
    if (event.type === "session-stopped") {
      setRecording(false);
      setHasFrame(false);
      return;
    }
    if (event.type !== "session-started" && event.type !== "session-updated") return;
    // An agent action moves `lastTraceEntryId`; read that one entry to learn
    // where it landed, and show the cursor there.
    const traceId = event.session?.lastTraceEntryId ?? null;
    if (!traceId || traceId === lastTraceIdRef.current) return;
    lastTraceIdRef.current = traceId;
    void window.ade?.appControl?.getTrace?.({ laneId, limit: 1 }, runtimePinRef.current)
      .then((result) => {
        const entry = result?.entries?.[result.entries.length - 1] ?? null;
        if (!scope.isActive() || !entry || entry.id !== traceId) return;
        if (!CURSOR_TRACE_ACTIONS.has(entry.action)) return;
        const point = traceCursorPoint(entry);
        if (!point) return;
        setCursor({ nonce: Date.now(), x: point.x, y: point.y, action: entry.action, failed: entry.status === "error" });
      })
      .catch(() => {});
  }, [acceptFrame, laneId, runtimePinRef]);
  useNativeToolFeedHandlers(useMemo(() => ({ onAppControlEvent }), [onAppControlEvent]));

  /*
   * The first picture. The screencast sends a frame only when the app paints,
   * and this player drops frames while hidden, so a player that mounts or
   * comes back over a still app would stay blank. One read each time it
   * shows a connected window: the lane's newest frame, or a fresh capture.
   */
  const shownForSeed = visible || pip.active;
  const connectedTargetId = session.status === "connected" ? session.cdpTargetId : null;
  // Web client: frames cross the relay only while a view shows them. The
  // feed's own listener is status-only, so the player holds them while shown.
  useEffect(() => {
    if (!shownForSeed) return undefined;
    return window.ade?.appControl?.holdFrames?.();
  }, [shownForSeed]);
  useEffect(() => {
    const read = window.ade?.appControl?.getLatestFrame;
    if (!shownForSeed || !connectedTargetId || typeof read !== "function") return undefined;
    let cancelled = false;
    void read({ laneId }, runtimePinRef.current)
      .then((frame) => {
        if (!cancelled && frame) acceptFrame(frame);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [acceptFrame, connectedTargetId, laneId, runtimePinRef, shownForSeed]);

  useEffect(() => {
    if (!cursor) return undefined;
    const timer = window.setTimeout(() => setCursor(null), AGENT_CURSOR_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [cursor]);

  // A recording that was already running when the player mounted gets no
  // event to learn from: one read, then events.
  useEffect(() => {
    const api = window.ade?.appControl;
    if (typeof api?.getRecordingStatus !== "function") return undefined;
    let cancelled = false;
    void api.getRecordingStatus({ laneId }, runtimePinRef.current)
      .then((status) => {
        if (!cancelled) setRecording(status?.running === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [laneId, runtimePinRef, session.id]);

  const source = floatingPlayerSourceSize(frameSize, APP_FALLBACK);
  const [initial] = useState(readAppControlMiniPlayerChoice);
  const { hostRef, frame, startDrag, startResize } = useFloatingPlayerFrame({
    source,
    initial,
    onCommit: writeAppControlMiniPlayerChoice,
  });

  // The picture went away (the app stopped): the PiP window would freeze on
  // the last frame.
  useEffect(() => {
    if (pip.active && !hasFrame) stopPip();
  }, [hasFrame, pip.active, stopPip]);

  // `ade app-control show --floating` answers "shown" only while this is set.
  const shown = visible || pip.active;
  useLayoutEffect(
    () => (shown ? noteFloatingWorkSurfaceShown(onScreenKey) : undefined),
    [onScreenKey, shown],
  );

  const connected = session.status === "connected" || (session.status === "running" && Boolean(session.cdpEndpoint));
  const stateLabel = recording ? "recording" : appControlStatusWord(session);

  return (
    <FloatingPlayerShell
      hostRef={hostRef}
      frame={frame}
      hidden={!shown}
      concealed={pip.active}
      attrPrefix="app-control-mini"
      playerId={laneId}
      ariaLabel="App, floating"
      recording={recording}
      onStartDrag={startDrag}
      onStartResize={startResize}
      onOpenInPane={() => {
        stopPip();
        onOpenInPane();
      }}
      onClose={() => {
        stopPip();
        onClose();
      }}
      pip={{
        supported: isWorkLivePictureInPictureSupported(),
        ready: hasFrame,
        onToggle: () => (pip.active ? stopPip() : void pip.enter()),
      }}
      barLeading={session.chatSessionId ? (
        <span
          data-app-control-mini-owner="agent"
          title="The agent is driving"
          className="shrink-0 whitespace-nowrap pl-1.5 pr-0.5 font-sans text-[11px] text-muted-fg"
        >
          agent
        </span>
      ) : null}
    >
      {/* The picture takes no input (driving is the pane's), so all of it
          moves the player. A group, so the tags can show on hover. */}
      <div
        data-app-control-mini-picture=""
        className="group absolute inset-0 cursor-grab active:cursor-grabbing"
        onPointerDown={startDrag}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 h-full w-full select-none object-contain",
            hasFrame ? null : "opacity-0",
          )}
        />
        {viewport && hasFrame ? (
          /* The cursor is laid out in the app's viewport space; this box has
             the picture's own shape, so percentages land on the picture. */
          <div className="pointer-events-none absolute inset-0">
            <AppControlAgentCursor cursor={cursor} viewport={viewport} />
          </div>
        ) : null}
        {!hasFrame ? (
          <p
            data-app-control-mini-waiting=""
            className="absolute inset-0 flex items-center justify-center px-4 text-center font-sans text-[12px] text-fg/70"
          >
            {connected ? "Waiting for the first frame…" : "Starting the app…"}
          </p>
        ) : null}
        <div
          data-app-control-mini-tags=""
          className={cn(
            "pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1",
            "opacity-0 transition-opacity duration-[120ms] ease-out group-hover:opacity-100 motion-reduce:transition-none",
          )}
        >
          {/* "App", never the session label: without `--label` that is the
              launch command ("npm start"). */}
          <span className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 font-sans text-[10.5px] font-medium text-fg/85">
            App
          </span>
          <span
            data-app-control-mini-state={stateLabel}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 font-sans text-[10.5px] text-fg/85"
          >
            <span
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                recording
                  ? "bg-[var(--color-error)] motion-safe:animate-pulse"
                  : connected
                    ? "bg-emerald-400"
                    : "bg-amber-400",
              )}
            />
            {stateLabel}
          </span>
        </div>
      </div>
    </FloatingPlayerShell>
  );
}
