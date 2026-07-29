import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Desktop,
  Keyboard,
  Link,
  Minus,
  Play,
  SpinnerGap,
  Stop,
  Terminal,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import type {
  AgentChatFileRef,
  AppControlContextItem,
  AppControlElement,
  AppControlSession,
  AppControlSnapshot,
  AppControlStatus,
  AppControlTarget,
  OpenProjectBinding,
} from "../../../shared/types";
import { inferAttachmentType } from "../../../shared/types";
import { cn } from "../ui/cn";

type ChatAppControlPanelProps = {
  sessionId: string | null;
  laneId: string | null;
  projectRoot: string | null;
  controlDisabledReason?: string | null;
  onAddContext?: (item: AppControlContextItem) => void;
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
  onInsertDraft?: (text: string) => void;
  onShowTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  runtimePin?: OpenProjectBinding | null;
};

type MessageTone = "info" | "error";
type Message = { tone: MessageTone; text: string };
type AppControlMode = "control" | "inspect";
type LiveFrameDims = {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  scaleX: number;
  scaleY: number;
};
type MappedPoint = {
  viewportX: number;
  viewportY: number;
  imageX: number;
  imageY: number;
  leftPct: number;
  topPct: number;
};

type PanelUiState = {
  launchCommand: string;
  launchCwd: string;
  cdpPort: string;
  mode: AppControlMode;
};

const appControlPanelUiStateByKey = new Map<string, PanelUiState>();

function panelUiStateKey(
  sessionId: string | null | undefined,
  projectRoot: string | null | undefined,
  laneId: string | null | undefined,
): string {
  return sessionId ? `chat:${sessionId}` : `lane:${laneId ?? "project"}:${projectRoot ?? "unknown"}`;
}

function readPanelUiState(key: string): PanelUiState {
  const cached = appControlPanelUiStateByKey.get(key);
  if (cached) return cached;
  try {
    const raw = window.sessionStorage.getItem(`ade.chat.appControlPanel.${key}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PanelUiState>;
      const state = {
        launchCommand: typeof parsed.launchCommand === "string" ? parsed.launchCommand : "",
        launchCwd: typeof parsed.launchCwd === "string" ? parsed.launchCwd : "",
        cdpPort: typeof parsed.cdpPort === "string" ? parsed.cdpPort : "",
        mode: parsed.mode === "inspect" ? "inspect" as const : "control" as const,
      };
      appControlPanelUiStateByKey.set(key, state);
      return state;
    }
  } catch {
    // Best-effort panel state only.
  }
  return { launchCommand: "", launchCwd: "", cdpPort: "", mode: "control" };
}

function writePanelUiState(key: string, state: PanelUiState): void {
  appControlPanelUiStateByKey.set(key, state);
  try {
    window.sessionStorage.setItem(`ade.chat.appControlPanel.${key}`, JSON.stringify(state));
  } catch {
    // Best-effort panel state only.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function clampFrame(frame: AppControlElement["pixelFrame"], width: number, height: number) {
  const x = Math.max(0, Math.min(width, Math.round(frame.x)));
  const y = Math.max(0, Math.min(height, Math.round(frame.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(frame.width))),
    height: Math.max(1, Math.min(height - y, Math.round(frame.height))),
  };
}

async function cropFrameDataUrl(
  snapshot: AppControlSnapshot,
  pixelFrame: AppControlElement["pixelFrame"],
): Promise<string | null> {
  const screenshot = snapshot.screenshot;
  if (!screenshot) return null;
  const frame = clampFrame(pixelFrame, screenshot.width, screenshot.height);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = frame.width;
      canvas.height = frame.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, frame.x, frame.y, frame.width, frame.height, 0, 0, frame.width, frame.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(null);
    img.src = screenshot.dataUrl;
  });
}

function imageLooksBlank(image: HTMLImageElement): boolean {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width <= 0 || height <= 0) return true;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(48, width);
  canvas.height = Math.min(48, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const pixelCount = data.length / 4;
  let visiblePixels = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha <= 8) continue;
    visiblePixels += 1;
    const brightness = ((data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0)) / 3;
    sum += brightness;
    sumSquares += brightness * brightness;
  }
  if (visiblePixels / pixelCount < 0.05) return true;
  const mean = sum / visiblePixels;
  const variance = Math.max(0, sumSquares / visiblePixels - mean * mean);
  return mean < 8 && variance < 4;
}

function elementLabel(element: AppControlElement): string {
  return element.label ?? element.value ?? element.testId ?? element.role ?? element.tagName ?? "element";
}

function elementSubLabel(element: AppControlElement): string | null {
  if (element.role && (element.label || element.value)) return element.role;
  if (element.tagName && element.label) return element.tagName.toLowerCase();
  return null;
}

type StatusTone = "idle" | "active" | "warn" | "muted" | "error";
type StatusInfo = { label: string; detail: string; tone: StatusTone };

function shortId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 8) : null;
}

function statusInfo(session: AppControlSession | null): StatusInfo {
  if (!session) {
    return { label: "Idle", detail: "No active session", tone: "idle" };
  }
  const terminal = shortId(session.terminalSessionId);
  const waitingForCdp = session.cdpPort && !session.cdpEndpoint
    ? `waiting for CDP on 127.0.0.1:${session.cdpPort}`
    : null;
  const suffix = [waitingForCdp, terminal ? `terminal ${terminal}` : null].filter(Boolean).join(" · ");
  // The launch terminal is alive but the controlled app's CDP target is gone —
  // either it never connected yet or the user quit it after we attached.
  const lostConnection = session.status === "running" && Boolean(session.connectedAt) && !session.cdpEndpoint;
  switch (session.status) {
    case "connected":
      return {
        label: "Connected",
        detail: session.cdpPort ? `${session.label} on CDP port ${session.cdpPort}` : session.label,
        tone: "active",
      };
    case "starting":
      return { label: "Starting", detail: `${session.label} is starting${suffix ? ` · ${suffix}` : ""}`, tone: "warn" };
    case "running":
      if (lostConnection) {
        return {
          label: "Disconnected",
          detail: session.lastError ?? `${session.label} stopped responding. The app may have quit while the launch terminal is still running.`,
          tone: "error",
        };
      }
      return { label: "Running", detail: `${session.label} is running${suffix ? ` · ${suffix}` : " in the terminal"}`, tone: "warn" };
    case "stopping":
      return { label: "Stopping", detail: `${session.label} is stopping`, tone: "warn" };
    case "exited":
      return { label: "Exited", detail: `${session.label} has exited`, tone: "muted" };
    case "stopped":
      return { label: "Stopped", detail: `${session.label} stopped`, tone: "muted" };
    case "failed":
      return { label: "Failed", detail: session.lastError ?? `${session.label} failed`, tone: "error" };
    default:
      return { label: session.status, detail: session.label, tone: "muted" };
  }
}

const STATUS_PILL_TONE: Record<StatusTone, string> = {
  idle: "border-white/[0.08] bg-white/[0.03] text-muted-fg/65",
  active: "border-emerald-400/25 bg-emerald-500/10 text-emerald-100/85",
  warn: "border-amber-400/25 bg-amber-500/10 text-amber-100/85",
  muted: "border-white/[0.08] bg-white/[0.03] text-muted-fg/55",
  error: "border-rose-400/30 bg-rose-500/10 text-rose-200/85",
};

const STATUS_DOT_TONE: Record<StatusTone, string> = {
  idle: "bg-muted-fg/45",
  active: "bg-emerald-300",
  warn: "bg-amber-300",
  muted: "bg-muted-fg/40",
  error: "bg-rose-300",
};

export function ChatAppControlPanel({
  sessionId,
  laneId,
  projectRoot,
  controlDisabledReason = null,
  onAddContext,
  onAddAttachment,
  onInsertDraft,
  onShowTerminal,
  runtimePin = null,
}: ChatAppControlPanelProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const uiStateKey = panelUiStateKey(sessionId, projectRoot, laneId);
  const initialUiState = readPanelUiState(uiStateKey);
  const [status, setStatus] = useState<AppControlStatus | null>(null);
  const [launchCommand, setLaunchCommand] = useState(initialUiState.launchCommand);
  const [launchCwd, setLaunchCwd] = useState(initialUiState.launchCwd);
  const [cdpPort, setCdpPort] = useState(initialUiState.cdpPort);
  const [snapshot, setSnapshot] = useState<AppControlSnapshot | null>(null);
  const [targets, setTargets] = useState<AppControlTarget[]>([]);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [liveFrameActive, setLiveFrameActive] = useState(false);
  const [liveFrameInitialSrc, setLiveFrameInitialSrc] = useState<string | null>(null);
  const liveFrameDimsRef = useRef<LiveFrameDims | null>(null);
  const liveFrameActiveRef = useRef(false);
  const liveFrameSrcRef = useRef<string | null>(null);
  const liveFramePendingSrcRef = useRef<string | null>(null);
  const liveFrameRafRef = useRef<number | null>(null);
  const liveFrameLastAtRef = useRef<number | null>(null);
  const [frameHealthTick, setFrameHealthTick] = useState(0);
  const activeTargetIdRef = useRef<string | null>(null);
  const scrollPendingRef = useRef<{ x: number; y: number; deltaX: number; deltaY: number; coordinateSpace: "viewport" } | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  // Stable refs so the non-passive wheel listener (attached imperatively) reads
  // the latest values without re-binding on every render.
  const scrollEnabledRef = useRef<boolean>(false);
  const hoverInspectSeqRef = useRef(0);
  const hoverInspectTimerRef = useRef<number | null>(null);
  const [hoverElement, setHoverElement] = useState<AppControlElement | null>(null);
  const [selectedElement, setSelectedElement] = useState<AppControlElement | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<{ x: number; y: number } | null>(null);
  const [selectedContextItem, setSelectedContextItem] = useState<AppControlContextItem | null>(null);
  const [controlPulse, setControlPulse] = useState<{ leftPct: number; topPct: number; nonce: number } | null>(null);
  const [screenshotBlank, setScreenshotBlank] = useState(false);
  const [typeText, setTypeText] = useState("");
  const [mode, setMode] = useState<AppControlMode>(initialUiState.mode);
  const modeRef = useRef<AppControlMode>(mode);
  const [attachmentAck, setAttachmentAck] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const uiHydrationKeyRef = useRef<string | null>(uiStateKey);

  const activeSession = status?.activeSession ?? snapshot?.session ?? null;
  const sessionStatus = useMemo(() => statusInfo(activeSession), [activeSession]);
  const controlsDisabled = Boolean(controlDisabledReason);
  const controlsDisabledMessage = controlDisabledReason ?? "This App Control session is read-only from the current lane.";
  const sessionConnected = activeSession?.status === "connected";
  const waitingForCdp = Boolean(
    activeSession
    && (activeSession.status === "starting" || activeSession.status === "running")
    && activeSession.cdpPort
    && !activeSession.cdpEndpoint,
  );
  const hasActiveSession = Boolean(activeSession) && !["exited", "stopped", "failed"].includes(activeSession?.status ?? "");
  const canLaunch = launchCommand.trim().length > 0 && !hasActiveSession && !controlsDisabled;
  const canStop = hasActiveSession && !controlsDisabled;
  const canType = mode === "control" && typeText.trim().length > 0 && sessionConnected && !controlsDisabled;

  useEffect(() => {
    activeTargetIdRef.current = activeSession?.cdpTargetId ?? null;
  }, [activeSession?.cdpTargetId]);

  useEffect(() => {
    uiHydrationKeyRef.current = uiStateKey;
    const saved = readPanelUiState(uiStateKey);
    setLaunchCommand(saved.launchCommand);
    setLaunchCwd(saved.launchCwd);
    setCdpPort(saved.cdpPort);
    setMode(saved.mode);
  }, [uiStateKey]);

  useEffect(() => {
    if (uiHydrationKeyRef.current === uiStateKey) {
      uiHydrationKeyRef.current = null;
      return;
    }
    writePanelUiState(uiStateKey, { launchCommand, launchCwd, cdpPort, mode });
  }, [cdpPort, launchCommand, launchCwd, mode, uiStateKey]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    scrollEnabledRef.current = liveFrameActive && mode === "control";
    liveFrameActiveRef.current = liveFrameActive;
  }, [liveFrameActive, mode]);

  useEffect(() => {
    if (!liveFrameActive) return undefined;
    const timer = window.setInterval(() => setFrameHealthTick((value) => value + 1), 2_000);
    return () => window.clearInterval(timer);
  }, [liveFrameActive]);

  const getDisplayedMetrics = useCallback((): LiveFrameDims | null => {
    if (liveFrameActive) {
      const live = liveFrameDimsRef.current;
      if (live && live.width > 0 && live.height > 0 && live.viewportWidth > 0 && live.viewportHeight > 0) {
        return live;
      }
    }
    const sw = snapshot?.screenshot?.width ?? 0;
    const sh = snapshot?.screenshot?.height ?? 0;
    if (sw <= 0 || sh <= 0) return null;
    const scaleX = snapshot?.screen.scaleX ?? snapshot?.screen.scale ?? 1;
    const scaleY = snapshot?.screen.scaleY ?? snapshot?.screen.scale ?? scaleX;
    return {
      width: sw,
      height: sh,
      viewportWidth: snapshot?.screen.viewportWidth && snapshot.screen.viewportWidth > 0
        ? snapshot.screen.viewportWidth
        : sw / scaleX,
      viewportHeight: snapshot?.screen.viewportHeight && snapshot.screen.viewportHeight > 0
        ? snapshot.screen.viewportHeight
        : sh / scaleY,
      scale: snapshot?.screen.scale ?? scaleX,
      scaleX,
      scaleY,
    };
  }, [liveFrameActive, snapshot]);

  const mapClientPoint = useCallback((clientX: number, clientY: number, image: HTMLImageElement | null = imageRef.current): MappedPoint | null => {
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    const metrics = getDisplayedMetrics();
    if (!metrics || rect.width <= 0 || rect.height <= 0) return null;
    const xRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const yRatio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return {
      viewportX: Math.round(xRatio * metrics.viewportWidth),
      viewportY: Math.round(yRatio * metrics.viewportHeight),
      imageX: Math.round(xRatio * metrics.width),
      imageY: Math.round(yRatio * metrics.height),
      leftPct: xRatio * 100,
      topPct: yRatio * 100,
    };
  }, [getDisplayedMetrics]);

  const overlayStyleForElement = useCallback((element: AppControlElement): CSSProperties | null => {
    const metrics = getDisplayedMetrics();
    if (!metrics || metrics.viewportWidth <= 0 || metrics.viewportHeight <= 0) return null;
    return {
      left: `${(element.frame.x / metrics.viewportWidth) * 100}%`,
      top: `${(element.frame.y / metrics.viewportHeight) * 100}%`,
      width: `${(element.frame.width / metrics.viewportWidth) * 100}%`,
      height: `${(element.frame.height / metrics.viewportHeight) * 100}%`,
    };
  }, [getDisplayedMetrics]);

  // Wheel forwarding: must be a NON-passive listener so preventDefault works,
  // and React's synthetic onWheel is passive in modern React. Attach
  // imperatively via addEventListener({ passive: false }).
  useEffect(() => {
    const img = imageRef.current;
    if (!img) return undefined;
    const handler = (event: WheelEvent) => {
      if (!scrollEnabledRef.current) return;
      const point = mapClientPoint(event.clientX, event.clientY, img);
      if (!point) return;
      const deltaX = event.deltaX;
      const deltaY = event.deltaY;
      if (deltaX === 0 && deltaY === 0) return;
      event.preventDefault();
      const pending = scrollPendingRef.current;
      if (pending) {
        scrollPendingRef.current = {
          x: point.viewportX,
          y: point.viewportY,
          deltaX: pending.deltaX + deltaX,
          deltaY: pending.deltaY + deltaY,
          coordinateSpace: "viewport",
        };
      } else {
        scrollPendingRef.current = {
          x: point.viewportX,
          y: point.viewportY,
          deltaX,
          deltaY,
          coordinateSpace: "viewport",
        };
      }
      if (scrollRafRef.current == null) {
        scrollRafRef.current = window.requestAnimationFrame(() => {
          scrollRafRef.current = null;
          const next = scrollPendingRef.current;
          scrollPendingRef.current = null;
          if (!next || controlsDisabled) return;
          void window.ade.appControl.scroll(next).catch(() => {});
        });
      }
    };
    img.addEventListener("wheel", handler, { passive: false });
    return () => img.removeEventListener("wheel", handler);
    // imageRef is stable across re-renders (same DOM node), so the only thing
    // that should re-bind is the live/empty mount flip. Only depending on
    // liveFrameActive here is intentional — re-binding on every snapshot
    // refresh would create a brief gap where wheel events get missed.
  }, [controlsDisabled, liveFrameActive, mapClientPoint]);

  useEffect(() => {
    setScreenshotBlank(false);
  }, [snapshot?.screenshot?.dataUrl]);

  useEffect(() => {
    if (mode !== "inspect") {
      setHoverElement(null);
    }
  }, [mode]);

  useEffect(() => {
    if (!controlPulse) return undefined;
    const timer = window.setTimeout(() => setControlPulse(null), 600);
    return () => window.clearTimeout(timer);
  }, [controlPulse]);

  useEffect(() => {
    return () => {
      if (hoverInspectTimerRef.current != null) {
        window.clearTimeout(hoverInspectTimerRef.current);
        hoverInspectTimerRef.current = null;
      }
      hoverInspectSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (mode !== "inspect") return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHoverElement(null);
      setSelectedPoint(null);
      setAttachmentAck(null);
      setMode("control");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode]);

  const refreshStatus = useCallback(async () => {
    const nextStatus = await window.ade.appControl.getStatus();
    setStatus(nextStatus);
    return nextStatus;
  }, []);

  const refreshTargets = useCallback(async () => {
    try {
      const list = await window.ade.appControl.listTargets();
      setTargets(list);
      // Clear the optimistic pick once the backend confirms it's active —
      // OR if the picked target disappeared entirely (window closed mid-attach),
      // otherwise the dropdown would appear permanently stuck on a phantom id.
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
    const nextSnapshot = await window.ade.appControl.getSnapshot({ projectRoot });
    setSnapshot(nextSnapshot);
    setSelectedElement(nextSnapshot.hitElement);
    return nextSnapshot;
  }, [projectRoot]);

  useEffect(() => {
    let cancelled = false;
    function resetSessionState(): void {
      setSnapshot(null);
      setSelectedElement(null);
      setSelectedPoint(null);
      setSelectedContextItem(null);
      setHoverElement(null);
      setLiveFrameActive(false);
      setLiveFrameInitialSrc(null);
      liveFrameDimsRef.current = null;
      liveFrameLastAtRef.current = null;
      liveFrameSrcRef.current = null;
      liveFramePendingSrcRef.current = null;
    }
    void refreshStatus().then((nextStatus) => {
      if (!cancelled && nextStatus.activeSession?.status === "connected") {
        void refreshSnapshot().catch(() => {});
      }
    }).catch(() => {});
    const unsubscribe = window.ade.appControl.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        const previousTargetId = activeTargetIdRef.current;
        const nextTargetId = event.session?.cdpTargetId ?? null;
        activeTargetIdRef.current = nextTargetId;
        setStatus((current) => (current ? { ...current, activeSession: event.session } : current));
        const nextStatus = event.session?.status ?? null;
        if (nextStatus === "connected") {
          if (previousTargetId !== nextTargetId) {
            setLiveFrameActive(false);
            setLiveFrameInitialSrc(null);
            liveFrameDimsRef.current = null;
            liveFrameLastAtRef.current = null;
            liveFrameSrcRef.current = null;
            liveFramePendingSrcRef.current = null;
            if (imageRef.current) imageRef.current.removeAttribute("src");
          }
          void refreshSnapshot().catch(() => {});
        } else if (
          nextStatus === "running"
          || nextStatus === "starting"
          || nextStatus === "exited"
          || nextStatus === "stopped"
          || nextStatus === "failed"
        ) {
          // Either the app hasn't connected yet, or it just disappeared. Drop
          // the last screenshot so the panel doesn't keep claiming to be live.
          resetSessionState();
        }
        void refreshStatus().catch(() => {});
      }
      if (event.type === "session-stopped") {
        void refreshStatus().catch(() => {});
        resetSessionState();
      }
      if (event.type === "frame") {
        if (event.frame.cdpTargetId !== activeTargetIdRef.current) return;
        const src = `data:${event.frame.mimeType};base64,${event.frame.data}`;
        liveFrameSrcRef.current = src;
        liveFrameLastAtRef.current = Date.now();
        if (!liveFrameActiveRef.current) setLiveFrameInitialSrc(src);
        // Hot-path: avoid React state churn at 30+ fps. Stash the latest data
        // URL and let a single requestAnimationFrame paint the freshest one
        // onto the <img> ref directly.
        liveFramePendingSrcRef.current = src;
        if (event.frame.width > 0 && event.frame.height > 0) {
          liveFrameDimsRef.current = {
            width: event.frame.width,
            height: event.frame.height,
            viewportWidth: event.frame.viewportWidth && event.frame.viewportWidth > 0
              ? event.frame.viewportWidth
              : Math.round(event.frame.width / (event.frame.scale || 1)),
            viewportHeight: event.frame.viewportHeight && event.frame.viewportHeight > 0
              ? event.frame.viewportHeight
              : Math.round(event.frame.height / (event.frame.scale || 1)),
            scale: event.frame.scale || event.frame.scaleX || 1,
            scaleX: event.frame.scaleX || event.frame.scale || 1,
            scaleY: event.frame.scaleY || event.frame.scale || 1,
          };
        }
        if (liveFrameRafRef.current == null) {
          liveFrameRafRef.current = window.requestAnimationFrame(() => {
            liveFrameRafRef.current = null;
            const next = liveFramePendingSrcRef.current;
            liveFramePendingSrcRef.current = null;
            if (next && imageRef.current) imageRef.current.src = next;
          });
        }
        // Flip to "live" once on the first frame; this triggers a single React
        // render that swaps the static screenshot out for the live <img>.
        setLiveFrameActive((current) => {
          if (current) return current;
          liveFrameActiveRef.current = true;
          return true;
        });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (liveFrameRafRef.current != null) {
        window.cancelAnimationFrame(liveFrameRafRef.current);
        liveFrameRafRef.current = null;
      }
      if (scrollRafRef.current != null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      scrollPendingRef.current = null;
    };
  }, [refreshSnapshot, refreshStatus]);

  // Refresh the list of CDP targets while the session is connected so the
  // user can switch to a freshly-opened window without restarting App Control.
  useEffect(() => {
    if (status?.activeSession?.status !== "connected") {
      setTargets([]);
      return undefined;
    }
    let cancelled = false;
    void refreshTargets();
    const timer = window.setInterval(() => {
      if (cancelled) return;
      void refreshTargets();
    }, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshTargets, status?.activeSession?.status, status?.activeSession?.id]);

  useEffect(() => {
    if (!attachmentAck) return undefined;
    const timer = window.setTimeout(() => setAttachmentAck(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [attachmentAck]);

  const runBusy = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }, []);

  const launchSelected = useCallback(
    () =>
      runBusy("launch", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const command = launchCommand.trim();
        if (!command) throw new Error("Enter a launch command.");
        const cwd = launchCwd.trim();
        const launched = await window.ade.appControl.launchInTerminal({
          projectRoot,
          laneId,
          command,
          cwd: cwd.length ? cwd : null,
          chatSessionId: sessionId,
          force: true,
        });
        const nextStatus = await window.ade.appControl.getStatus();
        setStatus({ ...nextStatus, activeSession: launched });
        setMode("control");
        if (launched.terminalSessionId && launched.terminalPtyId) {
          onShowTerminal?.({
            terminalId: launched.terminalSessionId,
            ptyId: launched.terminalPtyId,
            label: launched.label,
          });
        }
        if (launched.status === "connected") await refreshSnapshot();
        if (launched.lastError) {
          setMessage({ tone: "error", text: launched.lastError });
        } else {
          const cdpHint = launched.cdpPort
            ? ` Waiting for CDP on 127.0.0.1:${launched.cdpPort}. ADE forwards debug flags for common npm/pnpm/yarn/bun and direct Electron launches. If it stays blank, quit any old app instance or wire ADE_APP_CONTROL_DEBUG_FLAGS into the launcher.`
            : "";
          setMessage({ tone: "info", text: `Started ${launched.label} in the terminal.${cdpHint}` });
        }
      }),
    [controlsDisabled, controlsDisabledMessage, laneId, launchCommand, launchCwd, onShowTerminal, projectRoot, refreshSnapshot, runBusy, sessionId],
  );

  const attachToTargetId = useCallback(
    (targetId: string) => {
      if (controlsDisabled) {
        setMessage({ tone: "error", text: controlsDisabledMessage });
        return undefined;
      }
      // Optimistically reflect the user's pick in the dropdown so it doesn't
      // appear to "snap back" while the new screencast spins up.
      setPendingTargetId(targetId);
      return runBusy("attach", async () => {
        try {
          const session = await window.ade.appControl.attachToTarget({ targetId });
          setStatus((current) => (current ? { ...current, activeSession: session } : current));
          await refreshTargets();
        } finally {
          setPendingTargetId((current) => (current === targetId ? null : current));
        }
      });
    },
    [controlsDisabled, controlsDisabledMessage, refreshTargets, runBusy],
  );

  const connectPort = useCallback(
    () =>
      runBusy("connect", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const port = Number(cdpPort);
        if (!Number.isFinite(port) || port <= 0) throw new Error("Enter a valid CDP port.");
        const connected = await window.ade.appControl.connect({
          projectRoot,
          laneId,
          cdpPort: port,
          chatSessionId: sessionId,
          force: true,
        });
        const nextStatus = await window.ade.appControl.getStatus();
        setStatus({ ...nextStatus, activeSession: connected });
        setMode("control");
        await refreshSnapshot();
        setMessage({ tone: "info", text: `Connected to ${connected.label}.` });
      }),
    [cdpPort, controlsDisabled, controlsDisabledMessage, laneId, projectRoot, refreshSnapshot, runBusy, sessionId],
  );

  const stopSession = useCallback(
    () =>
      runBusy("stop", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        await window.ade.appControl.stop();
        const nextStatus = await window.ade.appControl.getStatus();
        setStatus(nextStatus);
        setSnapshot(null);
        setSelectedElement(null);
        setSelectedPoint(null);
        setSelectedContextItem(null);
        setMessage({ tone: "info", text: "Session stopped." });
      }),
    [controlsDisabled, controlsDisabledMessage, runBusy],
  );

  const focusWindow = useCallback(
    () =>
      runBusy("focus-window", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        await window.ade.appControl.focusWindow();
      }),
    [controlsDisabled, controlsDisabledMessage, runBusy],
  );

  const minimizeWindow = useCallback(
    () =>
      runBusy("minimize-window", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        await window.ade.appControl.minimizeWindow();
      }),
    [controlsDisabled, controlsDisabledMessage, runBusy],
  );

  const attachSelection = useCallback(
    async (x: number, y: number) => {
      if (modeRef.current !== "inspect") {
        throw new Error("Switch to Inspect mode to attach App Control context.");
      }
      if (controlsDisabled) {
        throw new Error(controlsDisabledMessage);
      }
      if (screenshotBlank) {
        throw new Error("The renderer is attached but the screenshot is blank. Open the app window or menu bar item, then refresh the snapshot before attaching context.");
      }
      if (!onAddContext) {
        throw new Error("Context insertion is not available in this panel.");
      }
      const result = await window.ade.appControl.selectPoint({
        projectRoot,
        x,
        y,
        coordinateSpace: "viewport",
        includeScreenshot: false,
      });
      const element = result.snapshot?.hitElement ?? null;
      let attachmentPath: string | null = null;
      let screenshotDataUrl = result.item.screenshotDataUrl ?? null;
      if (snapshot && (onAddAttachment || screenshotDataUrl)) {
        const cropFrame = element?.pixelFrame ?? result.item.frame;
        if (cropFrame) {
          const crop = await cropFrameDataUrl(snapshot, cropFrame);
          if (crop) screenshotDataUrl = crop;
        }
      }
      if (screenshotDataUrl && onAddAttachment) {
        try {
          const { path } = await window.ade.agentChat.saveTempAttachment({
            data: stripDataUrlPrefix(screenshotDataUrl),
            filename: "app-control-selection.png",
          }, ...(runtimePin ? [runtimePin] as const : []));
          attachmentPath = path;
          onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
        } catch (error) {
          throw new Error(`Could not attach screenshot crop: ${errorMessage(error)}`);
        }
      }
      const contextItem = {
        ...result.item,
        screenshotDataUrl,
        metadata: {
          ...result.item.metadata,
          ...(attachmentPath ? { attachmentPath } : {}),
        },
      };
      try {
        onAddContext(contextItem);
      } catch (error) {
        throw new Error(`Could not insert App Control context: ${errorMessage(error)}`);
      }
      setSelectedContextItem(contextItem);
      setSelectedPoint({ x, y });
      setSelectedElement(element);
      let attachedLabel: string;
      if (result.source === "coordinate-fallback") {
        attachedLabel = "coordinate";
      } else if (element) {
        attachedLabel = elementLabel(element);
      } else {
        attachedLabel = String(result.source);
      }
      setAttachmentAck(attachedLabel);
      setMessage({
        tone: "info",
        text: `Inserted ${attachedLabel} context.`,
      });
    },
    [controlsDisabled, controlsDisabledMessage, onAddAttachment, onAddContext, projectRoot, runtimePin, screenshotBlank, snapshot],
  );

  const handleImageClick = useCallback(
    (event: MouseEvent<HTMLImageElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const point = mapClientPoint(event.clientX, event.clientY, event.currentTarget);
      if (!point) return;
      if (controlsDisabled) {
        setMessage({ tone: "error", text: controlsDisabledMessage });
        return;
      }
      if (!liveFrameActive && screenshotBlank) {
        setMessage({
          tone: "error",
          text: "The renderer is attached but the screenshot is blank. Open the app window or menu bar item, then refresh the snapshot.",
        });
        return;
      }
      const activeMode = modeRef.current;
      if (activeMode === "inspect") {
        void runBusy("select", () => attachSelection(point.viewportX, point.viewportY));
        return;
      }
      if (activeMode !== "control") return;
      setControlPulse({ leftPct: point.leftPct, topPct: point.topPct, nonce: Date.now() });
      // Fire-and-forget: do NOT block on the CDP round-trip and do NOT refresh
      // the snapshot. The screencast is live, so the rendered image already
      // updates on its own; gating busy/disabled state through every click
      // makes the dropdown and Stop button flash and feel locked.
      window.ade.appControl
        .click({ x: point.viewportX, y: point.viewportY, coordinateSpace: "viewport" })
        .catch((error) => {
          setMessage({ tone: "error", text: `Click failed: ${errorMessage(error)}` });
        });
      setMessage(null);
    },
    [attachSelection, controlsDisabled, controlsDisabledMessage, liveFrameActive, mapClientPoint, runBusy, screenshotBlank],
  );

  const inspectHoverAt = useCallback(
    (point: MappedPoint) => {
      if (controlsDisabled || !sessionConnected || screenshotBlank) return;
      if (hoverInspectTimerRef.current != null) {
        window.clearTimeout(hoverInspectTimerRef.current);
        hoverInspectTimerRef.current = null;
      }
      const requestSeq = hoverInspectSeqRef.current + 1;
      hoverInspectSeqRef.current = requestSeq;
      hoverInspectTimerRef.current = window.setTimeout(() => {
        hoverInspectTimerRef.current = null;
        void window.ade.appControl
          .inspectPoint({
            projectRoot,
            x: point.viewportX,
            y: point.viewportY,
            coordinateSpace: "viewport",
            includeScreenshot: false,
          })
          .then((result) => {
            if (hoverInspectSeqRef.current !== requestSeq || modeRef.current !== "inspect") return;
            setHoverElement(result.snapshot.hitElement);
          })
          .catch(() => {
            if (hoverInspectSeqRef.current === requestSeq) setHoverElement(null);
          });
      }, 60);
    },
    [controlsDisabled, projectRoot, screenshotBlank, sessionConnected],
  );

  const typeIntoApp = useCallback(
    () =>
      runBusy("type", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        if (modeRef.current !== "control") throw new Error("Switch to Control mode to type into the app.");
        if (!typeText.trim()) return;
        await window.ade.appControl.typeText({ text: typeText });
        setTypeText("");
        try {
          await refreshSnapshot();
        } catch (error) {
          setMessage({ tone: "info", text: `Typed into focused element. Snapshot refresh failed: ${errorMessage(error)}` });
          return;
        }
        setMessage({ tone: "info", text: "Typed into focused element." });
      }),
    [controlsDisabled, controlsDisabledMessage, refreshSnapshot, runBusy, typeText],
  );

  const requestDebugHelp = useCallback(() => {
    onInsertDraft?.(
      [
        "Set up this Electron app for ADE App Control.",
        "Wire ADE_APP_CONTROL_DEBUG_FLAGS or ADE_APP_CONTROL_CDP_PORT into the launch command, then verify with `ade app-control launch --command \"<command>\" --text` and `ade app-control snapshot --text`.",
      ].join("\n"),
    );
  }, [onInsertDraft]);

  const screenshot = snapshot?.screenshot ?? null;
  // frameHealthTick * 0 is intentional: it refreshes age from a ref-backed timestamp.
  const liveFrameAgeMs = liveFrameActive && liveFrameLastAtRef.current != null
    ? Date.now() - liveFrameLastAtRef.current + frameHealthTick * 0
    : null;
  const liveFrameStale = liveFrameAgeMs != null && liveFrameAgeMs > 4_000;
  const focusElement = hoverElement ?? selectedElement;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 font-sans text-[11px] text-fg/75">
      {/* Top row: launch input + Run, or running command + Stop/Terminal */}
      {!hasActiveSession ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <input
            value={launchCommand}
            onChange={(event) => {
              setLaunchCommand(event.target.value);
              if (launchCwd) setLaunchCwd("");
            }}
            placeholder='Launch command, e.g. "pnpm dev"'
            aria-label="App Control launch command"
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
            aria-label="Launch App Control command"
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
          {activeSession?.terminalSessionId && activeSession.terminalPtyId && onShowTerminal ? (
            <button
              type="button"
              onClick={() => {
                onShowTerminal({
                  terminalId: activeSession.terminalSessionId!,
                  ptyId: activeSession.terminalPtyId!,
                  label: activeSession.label,
                });
              }}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-[10px] font-medium text-fg/65 transition-colors hover:bg-white/[0.06] hover:text-fg/85"
              title="Show the launch terminal"
            >
              <Terminal size={11} />
              Terminal
            </button>
          ) : null}
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
              aria-label="Stop App Control session"
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
            value={cdpPort}
            onChange={(event) => setCdpPort(event.target.value)}
            placeholder="CDP port"
            aria-label="CDP port"
            inputMode="numeric"
            disabled={controlsDisabled}
            className="w-[80px] shrink-0 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 text-[10px] text-fg/80 outline-none placeholder:text-muted-fg/40 focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
            onKeyDown={(event) => {
              if (event.key === "Enter" && cdpPort.trim()) void connectPort();
            }}
          />
          <button
            type="button"
            disabled={Boolean(busy) || !cdpPort.trim() || controlsDisabled}
            onClick={connectPort}
            className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-[10px] font-medium text-fg/72 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
            title="Connect to a running Electron app via CDP"
          >
            {busy === "connect" ? <SpinnerGap size={11} className="animate-spin" /> : <Link size={11} />}
            Connect
          </button>
          {onInsertDraft ? (
            <button
              type="button"
              onClick={requestDebugHelp}
              className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-[10px] font-medium text-muted-fg/65 transition-colors hover:text-fg/85"
              title="Insert a draft asking the agent to wire CDP debug flags into this app"
            >
              <Wrench size={11} />
              Help wire CDP
            </button>
          ) : null}
        </div>
      ) : null}

      {sessionConnected && targets.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-fg/55">
            Window
          </span>
          <select
            value={pendingTargetId ?? targets.find((target) => target.active)?.id ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              void attachToTargetId(value);
            }}
            className="min-w-0 flex-1 rounded-md border border-white/[0.06] bg-black/30 px-2 py-1 text-[11px] text-fg/85 outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
            aria-label="Switch the controlled window"
            disabled={Boolean(busy) || targets.length < 2 || controlsDisabled}
          >
            {targets.map((target) => {
              const baseTitle = (target.title ?? "").trim();
              const url = (target.url ?? "").trim();
              const urlLabel = url ? url.replace(/^https?:\/\//, "").replace(/^file:\/\//, "") : "";
              // Don't number windows positionally — `/json/list` order isn't
              // stable across polls, so a "Window N" label would point at a
              // different underlying target between refreshes. Prefer URL +
              // a short id suffix (always unique per target).
              const idSuffix = target.id.length > 6 ? `…${target.id.slice(-6)}` : target.id;
              const label = [baseTitle || null, urlLabel || null, idSuffix]
                .filter((part): part is string => Boolean(part && part.length > 0))
                .join(" · ")
                .slice(0, 130);
              return (
                <option key={target.id} value={target.id}>
                  {target.active ? "● " : ""}{label}
                </option>
              );
            })}
          </select>
          <button
            type="button"
            onClick={() => void refreshTargets()}
            disabled={controlsDisabled}
            className="inline-flex h-6 shrink-0 items-center justify-center rounded border border-white/[0.06] bg-white/[0.02] px-1.5 text-[10px] text-muted-fg/65 hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
            title="Re-scan controlled app windows"
          >
            {targets.length}
          </button>
        </div>
      ) : null}

      {waitingForCdp && activeSession?.cdpPort ? (
        <div
          className="flex shrink-0 items-start gap-2 rounded-md border border-amber-400/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-100/85"
          role="status"
        >
          <WarningCircle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">
            Waiting for CDP on 127.0.0.1:{activeSession.cdpPort}. If the app is running but App Control is blank, quit any existing app instance or wire ADE_APP_CONTROL_DEBUG_FLAGS into the launcher.
          </span>
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

      {/* Snapshot surface */}
      <div className="relative flex min-h-[240px] min-w-0 flex-1 flex-col overflow-hidden rounded border border-white/[0.08] bg-white/[0.02]">
        <div className="absolute left-2 top-2 z-10 flex flex-col items-start gap-1">
          <button
            type="button"
            disabled={Boolean(busy) || !sessionConnected || controlsDisabled}
            onClick={() =>
              void runBusy("snapshot", async () => {
                await refreshSnapshot();
                setMessage({ tone: "info", text: "Snapshot refreshed." });
              })
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-black/55 px-2 text-[10px] font-medium text-fg/72 backdrop-blur transition-colors hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-45"
            title="Re-capture screenshot and DOM snapshot"
          >
            {busy === "snapshot" ? (
              <SpinnerGap size={11} className="animate-spin" />
            ) : (
              <ArrowClockwise size={11} />
            )}
            Snapshot
          </button>
          <div
            className={cn(
              "inline-flex items-center rounded-md border border-white/[0.08] bg-black/55 p-0.5 backdrop-blur",
              !hasActiveSession ? "opacity-45" : null,
            )}
            aria-label="App Control mode"
          >
            {(["control", "inspect"] as const).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                disabled={!hasActiveSession || controlsDisabled}
                onClick={() => setMode(nextMode)}
                className={cn(
                  "h-6 rounded-[3px] px-2 text-[10px] font-medium transition-colors disabled:cursor-not-allowed",
                  mode === nextMode
                    ? "bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-fg/90 shadow-sm"
                    : "text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg/80",
                )}
              >
                {nextMode === "control" ? "Control" : "Inspect"}
              </button>
            ))}
          </div>
        </div>

        {snapshot?.url ? (
          <div
            className="absolute right-2 top-2 z-10 max-w-[60%] truncate rounded-md border border-white/[0.08] bg-black/55 px-2 py-1 text-[10px] text-muted-fg/65 backdrop-blur"
            title={snapshot.url}
          >
            {snapshot.title ?? snapshot.url}
          </div>
        ) : null}
        {liveFrameStale ? (
          <div className="absolute right-2 top-9 z-10 rounded-md border border-amber-300/20 bg-amber-500/12 px-2 py-1 text-[10px] font-medium text-amber-100/85 backdrop-blur">
            Stream stale
          </div>
        ) : null}

        {screenshot || liveFrameActive ? (
          <div className="relative flex h-full min-h-0 w-full items-center justify-center overflow-auto p-2">
            <div className="relative max-h-full">
              <img
                ref={imageRef}
                // When the screencast is live the src is driven by raf via
                // imageRef directly. Falls back to the static snapshot only
                // before the first live frame arrives. We keep this <img>
                // mounted whenever EITHER source can paint, so a missing
                // static snapshot doesn't blank out an active live stream.
                src={liveFrameActive ? liveFrameInitialSrc ?? snapshot?.screenshot?.dataUrl : snapshot?.screenshot?.dataUrl}
                alt="Electron app screenshot"
                draggable={false}
                className={cn(
                  "block max-h-[60vh] max-w-full rounded-sm border border-white/[0.06] object-contain",
                  screenshotBlank ? "cursor-not-allowed opacity-35" : mode === "inspect" ? "cursor-crosshair" : "cursor-pointer",
                )}
                onLoad={(event) => {
                  const blank = Boolean(snapshot?.elements.length) && imageLooksBlank(event.currentTarget);
                  setScreenshotBlank(blank);
                  if (blank) {
                    setHoverElement(null);
                    setSelectedElement(null);
                    setSelectedPoint(null);
                  }
                }}
                onError={() => {
                  liveFrameActiveRef.current = false;
                  liveFrameLastAtRef.current = null;
                  liveFrameSrcRef.current = null;
                  liveFramePendingSrcRef.current = null;
                  setLiveFrameInitialSrc(null);
                  setLiveFrameActive(false);
                  setScreenshotBlank(false);
                }}
                onClick={handleImageClick}
                onMouseMove={(event) => {
                  if (mode !== "inspect") return;
                  const point = mapClientPoint(event.clientX, event.clientY, event.currentTarget);
                  if (!point) return;
                  inspectHoverAt(point);
                }}
                onMouseLeave={() => {
                  if (hoverInspectTimerRef.current != null) {
                    window.clearTimeout(hoverInspectTimerRef.current);
                    hoverInspectTimerRef.current = null;
                  }
                  hoverInspectSeqRef.current += 1;
                  setHoverElement(null);
                }}
              />
              {screenshotBlank ? (
                <div className="absolute inset-0 flex items-center justify-center rounded-sm border border-amber-300/18 bg-black/70 px-4 text-center backdrop-blur-sm">
                  <div className="max-w-[360px] text-[11px] leading-5 text-amber-100/85">
                    Renderer attached, but the screenshot is blank. Open the app window or menu bar item, then refresh Snapshot.
                  </div>
                </div>
              ) : null}
              {/* Inspect-only: persistent outline for the attached/selected element */}
              {mode === "inspect" && selectedElement && (screenshot || liveFrameActive) && !screenshotBlank ? (() => {
                const style = overlayStyleForElement(selectedElement);
                if (!style) return null;
                return (
                  <div
                    key={`selected-${selectedElement.id}`}
                    className="pointer-events-none absolute rounded-sm border-2 border-sky-300/85 bg-sky-300/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.18)]"
                    style={style}
                  />
                );
              })() : null}
              {/* Inspect-only: hover affordance to telegraph what's selectable */}
              {mode === "inspect" && hoverElement && (screenshot || liveFrameActive) && !screenshotBlank && hoverElement.id !== selectedElement?.id ? (() => {
                const style = overlayStyleForElement(hoverElement);
                if (!style) return null;
                return (
                  <div
                    key={`hover-${hoverElement.id}`}
                    className="pointer-events-none absolute rounded-sm border border-sky-200/60 bg-sky-200/5"
                    style={style}
                  />
                );
              })() : null}
              {/* Inspect-only: coordinate marker when no element matched */}
              {mode === "inspect" && selectedPoint && (screenshot || liveFrameActive) && !screenshotBlank && !selectedElement ? (() => {
                const metrics = getDisplayedMetrics();
                if (!metrics) return null;
                return (
                  <div
                    className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-300/90 bg-sky-300/40"
                    style={{
                      left: `${(selectedPoint.x / metrics.viewportWidth) * 100}%`,
                      top: `${(selectedPoint.y / metrics.viewportHeight) * 100}%`,
                    }}
                  />
                );
              })() : null}
              {/* Control-only: brief click pulse so the user gets feedback without persistent chrome */}
              {mode === "control" && controlPulse && !screenshotBlank ? (
                <div
                  key={`pulse-${controlPulse.nonce}`}
                  className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-200/70 bg-sky-200/35 motion-safe:animate-ping"
                  style={{
                    left: `${controlPulse.leftPct}%`,
                    top: `${controlPulse.topPct}%`,
                  }}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-muted-fg/55">
            <Desktop size={28} className="text-muted-fg/30" />
            <div className="text-[12px] font-medium text-fg/70">
              {sessionConnected ? "Capture a snapshot to begin" : "No app session yet"}
            </div>
            <div className="max-w-[360px] text-[11px] leading-5 text-muted-fg/55">
              {sessionConnected
                ? "Click Snapshot to capture the current screen and DOM."
                : "Run a launch command above, or attach to a running app via its CDP port."}
            </div>
          </div>
        )}
      </div>

      {/* Selection details + actions */}
      <div className="flex shrink-0 flex-col gap-1">
        <div className="min-w-0 rounded border border-white/[0.08] bg-white/[0.025] px-1.5 py-1">
          {mode === "control" ? (
            screenshotBlank ? (
              <div className="text-[11px] text-amber-100/80">
                Screenshot is blank. Open the app window or menu bar item, then refresh Snapshot.
              </div>
            ) : (
              <div className="text-[11px] text-muted-fg/55">
                {sessionConnected
                  ? "Click the screenshot to drive the app, or type into the focused element below."
                  : "Launch or connect to start controlling the app."}
              </div>
            )
          ) : focusElement ? (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[11px] font-medium text-fg/85" title={elementLabel(focusElement)}>
                  {elementLabel(focusElement)}
                </span>
                {elementSubLabel(focusElement) ? (
                  <span className="shrink-0 rounded border border-white/[0.08] bg-white/[0.03] px-1 py-0 font-mono text-[9px] uppercase tracking-wide text-muted-fg/60">
                    {elementSubLabel(focusElement)}
                  </span>
                ) : null}
                {hoverElement && hoverElement.id !== selectedElement?.id ? (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-fg/45">hovering</span>
                ) : attachmentAck ? (
                  <span className="ml-auto shrink-0 rounded-full border border-emerald-300/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-100/85">
                    Attached
                  </span>
                ) : selectedElement?.id === focusElement.id ? (
                  <span className="ml-auto shrink-0 text-[10px] text-sky-200/70">selected</span>
                ) : null}
              </div>
              {focusElement.selector ? (
                <div className="truncate font-mono text-[10px] text-muted-fg/55" title={focusElement.selector}>
                  {focusElement.selector}
                </div>
              ) : null}
              {selectedContextItem?.sourceFile ? (
                <div
                  className="truncate font-mono text-[10px] text-sky-100/65"
                  title={`${selectedContextItem.sourceFile}${selectedContextItem.sourceLine ? `:${selectedContextItem.sourceLine}` : ""}`}
                >
                  {selectedContextItem.sourceFile}
                  {selectedContextItem.sourceLine ? `:${selectedContextItem.sourceLine}` : ""}
                </div>
              ) : null}
              <div className="text-[10px] text-muted-fg/45">
                {Math.round(focusElement.pixelFrame.x)}, {Math.round(focusElement.pixelFrame.y)} · {Math.round(focusElement.pixelFrame.width)}×{Math.round(focusElement.pixelFrame.height)}
                {focusElement.testId ? <span className="ml-2">testId={focusElement.testId}</span> : null}
              </div>
            </div>
          ) : selectedPoint ? (
            <div className="text-[11px] text-fg/70">
              Coordinate {selectedPoint.x}, {selectedPoint.y} attached
            </div>
          ) : screenshotBlank ? (
            <div className="text-[11px] text-amber-100/80">
              Screenshot is blank. Open the app window or menu bar item, then refresh Snapshot.
            </div>
          ) : (
            <div className="text-[11px] text-muted-fg/55">
              {sessionConnected
                ? "Click an element to insert its source context."
                : "Launch or connect to inspect elements."}
            </div>
          )}
        </div>

        {mode === "control" ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded border border-white/[0.08] bg-black/20 pl-1.5 focus-within:border-sky-300/30">
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
        ) : (
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "inline-flex h-8 shrink-0 items-center rounded-md border px-2 text-[10px] font-medium",
                attachmentAck
                  ? "border-emerald-300/25 bg-emerald-500/10 text-emerald-100/85"
                  : "border-white/[0.08] bg-white/[0.03] text-muted-fg/60",
              )}
            >
              {attachmentAck ? `Inserted ${attachmentAck} context` : "Inspect mode inserts clicked element context"}
            </div>
            <button
              type="button"
              disabled={Boolean(busy) || screenshotBlank || !selectedPoint || !sessionConnected || controlsDisabled}
              onClick={() => {
                if (selectedPoint) void runBusy("select", () => attachSelection(selectedPoint.x, selectedPoint.y));
              }}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 text-[11px] font-medium text-fg/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
              title="Attach the selected element again"
            >
              {busy === "select" ? <SpinnerGap size={12} className="animate-spin" /> : <ArrowClockwise size={12} />}
              Re-attach
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
