import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Camera,
  Crosshair,
  Keyboard,
  ListChecks,
  Minus,
  SpinnerGap,
  Stack,
  Stop,
  Terminal,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  AgentChatFileRef,
  AppControlActionTraceEntry,
  AppControlContextItem,
  AppControlDriver,
  AppControlDriversResult,
  AppControlElement,
  AppControlElementSnapshot,
  AppControlObservation,
  AppControlSession,
  AppControlSnapshot,
  AppControlStatus,
  AppControlTarget,
  OpenProjectBinding,
} from "../../../shared/types";
import { inferAttachmentType } from "../../../shared/types";
import { cn } from "../ui/cn";
import {
  appControlDisplayedMetrics,
  appControlOverlayBox,
  mapClientPointToFrame,
  type LiveFrameDims,
  type MappedPoint,
} from "./appControlFrameGeometry";
import { AppControlMenuItem, AppControlMenuLabel } from "./AppControlMenu";
import { APP_CONTROL_FRAME_STALE_MS, useAppControlLiveFrame } from "./useAppControlLiveFrame";
import {
  AppControlAgentCursor,
  AppControlObserveOverlay,
  type AgentCursorState,
} from "./AppControlOverlays";
import { AppControlStatusRow, AppControlTraceDrawer } from "./AppControlTraceDrawer";
import {
  WORK_TOOL_PRIMARY_BUTTON,
  WorkToolEmptyLine,
} from "../terminals/workToolChrome";
import { AppControlToolbar, type AppControlLaunchRecent, type AppControlStatusTone } from "./AppControlToolbar";
import {
  CURSOR_TRACE_ACTIONS,
  countConsoleErrors,
  countNetworkFailures,
  elementSummary,
  formatLastActionLine,
  formatTraceRow,
  traceCursorPoint,
} from "./appControlTrace";

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
type PanelUiState = {
  launchCommand: string;
  launchCwd: string;
  cdpPort: string;
  mode: AppControlMode;
  recents: AppControlLaunchRecent[];
};

const MAX_RECENT_LAUNCHES = 5;
/** How long the agent cursor lingers after the action that summoned it. */
const AGENT_CURSOR_LINGER_MS = 1_400;

const appControlPanelUiStateByKey = new Map<string, PanelUiState>();

function panelUiStateKey(
  sessionId: string | null | undefined,
  projectRoot: string | null | undefined,
  laneId: string | null | undefined,
  machineKey: string | null | undefined,
): string {
  // The launch command and CDP port describe a process on ONE machine, so the
  // key has to name it. A lane id is only unique within its machine, and the
  // same project root exists on both sides of a cross-machine checkout.
  const machine = machineKey ?? "bound";
  return sessionId
    ? `chat:${sessionId}`
    : `lane:${machine}:${laneId ?? "project"}:${projectRoot ?? "unknown"}`;
}

function normalizeRecents(value: unknown): AppControlLaunchRecent[] {
  if (!Array.isArray(value)) return [];
  const out: AppControlLaunchRecent[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const command = (entry as { command?: unknown }).command;
    if (typeof command !== "string" || command.trim().length === 0) continue;
    const cwd = (entry as { cwd?: unknown }).cwd;
    out.push({ command: command.trim(), cwd: typeof cwd === "string" && cwd ? cwd : null });
    if (out.length >= MAX_RECENT_LAUNCHES) break;
  }
  return out;
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
        recents: normalizeRecents(parsed.recents),
      };
      appControlPanelUiStateByKey.set(key, state);
      return state;
    }
  } catch {
    // Best-effort panel state only.
  }
  return { launchCommand: "", launchCwd: "", cdpPort: "", mode: "control", recents: [] };
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

type StatusInfo = { label: string; word: string; detail: string; tone: AppControlStatusTone };

function shortId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 8) : null;
}

function statusInfo(session: AppControlSession | null): StatusInfo {
  if (!session) {
    // One phrase, one casing. The pane said "no app", "No app attached" and
    // "Pick an app to drive" about the same fact; the header's "No app" is the
    // spelling every surface now uses.
    return { label: "Idle", word: "No app", detail: "No active session", tone: "idle" };
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
        word: "attached",
        detail: session.cdpPort ? `${session.label} on CDP port ${session.cdpPort}` : session.label,
        tone: "active",
      };
    case "starting":
      return {
        label: "Starting",
        word: "launching",
        detail: `${session.label} is starting${suffix ? ` · ${suffix}` : ""}`,
        tone: "warn",
      };
    case "running":
      if (lostConnection) {
        return {
          label: "Disconnected",
          word: "disconnected",
          detail: session.lastError ?? `${session.label} stopped responding. The app may have quit while the launch terminal is still running.`,
          tone: "error",
        };
      }
      return {
        label: "Running",
        word: "launching",
        detail: `${session.label} is running${suffix ? ` · ${suffix}` : " in the terminal"}`,
        tone: "warn",
      };
    case "stopping":
      return { label: "Stopping", word: "stopping", detail: `${session.label} is stopping`, tone: "warn" };
    case "exited":
      return { label: "Exited", word: "exited", detail: `${session.label} has exited`, tone: "muted" };
    case "stopped":
      return { label: "Stopped", word: "stopped", detail: `${session.label} stopped`, tone: "muted" };
    case "failed":
      return { label: "Failed", word: "failed", detail: session.lastError ?? `${session.label} failed`, tone: "error" };
    default:
      return { label: session.status, word: session.status, detail: session.label, tone: "muted" };
  }
}

function remoteMachineLabel(pin: OpenProjectBinding | null | undefined): string | null {
  if (!pin || pin.kind !== "remote") return null;
  return pin.runtimeName || pin.hostname || pin.displayName || "remote machine";
}

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
  // Every `appControl.*` call below drives the machine this chat lives on.
  // Read through a ref, not a dep: a local pin object is rebuilt on each
  // cross-machine merge, and the panel is keyed on the pin at its render sites.
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
  const uiStateKey = panelUiStateKey(sessionId, projectRoot, laneId, runtimePin?.key ?? null);
  const initialUiState = readPanelUiState(uiStateKey);
  const [status, setStatus] = useState<AppControlStatus | null>(null);
  const [launchCommand, setLaunchCommand] = useState(initialUiState.launchCommand);
  const [launchCwd, setLaunchCwd] = useState(initialUiState.launchCwd);
  const [cdpPort, setCdpPort] = useState(initialUiState.cdpPort);
  const [recents, setRecents] = useState<AppControlLaunchRecent[]>(initialUiState.recents);
  const [snapshot, setSnapshot] = useState<AppControlSnapshot | null>(null);
  const [targets, setTargets] = useState<AppControlTarget[]>([]);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  // The 30fps transport — refs, the rAF pump and the health tick — lives in its
  // own hook; the panel keeps only what its JSX reads.
  const liveFrame = useAppControlLiveFrame(imageRef);
  const {
    active: liveFrameActive,
    initialSrc: liveFrameInitialSrc,
    staleSrc: staleFrameSrc,
    dimsRef: liveFrameDimsRef,
    // Stable identities (the hook's `useCallback`s), so the panel's one
    // `onEvent` subscription can depend on them without re-subscribing on
    // every render — which depending on `liveFrame` itself would have done.
    onFrame: onLiveFrame,
    reset: resetLiveFrame,
    clear: clearLiveFrame,
  } = liveFrame;
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
  const [mode, setMode] = useState<AppControlMode>(
    onAddContext ? initialUiState.mode : "control",
  );
  const modeRef = useRef<AppControlMode>(mode);
  const [attachmentAck, setAttachmentAck] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const uiHydrationKeyRef = useRef<string | null>(uiStateKey);

  // Agent action model — the observe map, the trace ledger and the cursor.
  const [drivers, setDrivers] = useState<AppControlDriversResult | null>(null);
  const [observation, setObservation] = useState<AppControlObservation | null>(null);
  const [observeMapOn, setObserveMapOn] = useState(false);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [copiedHandle, setCopiedHandle] = useState<string | null>(null);
  const [traceEntries, setTraceEntries] = useState<AppControlActionTraceEntry[]>([]);
  const [traceOpen, setTraceOpen] = useState(false);
  const [agentCursor, setAgentCursor] = useState<AgentCursorState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastTraceIdRef = useRef<string | null>(null);
  const cursorTraceIdRef = useRef<string | null>(null);
  const observationElementsRef = useRef<AppControlElementSnapshot[]>([]);

  const activeSession = status?.activeSession ?? snapshot?.session ?? null;
  const sessionStatus = useMemo(() => statusInfo(activeSession), [activeSession]);
  const controlsDisabled = Boolean(controlDisabledReason);
  /**
   * This host has somewhere to send an element or a screenshot.
   *
   * False in a shell session, which has no chat, draft or agent CLI behind it.
   * Inspect mode and the whole "Send to chat" group exist only to produce an
   * insert, so they are not rendered at all here — a disabled control with a
   * tooltip would be explaining a capability that is structurally absent, not
   * a state that will change.
   */
  const canSendToChat = Boolean(onAddContext || onAddAttachment);
  // Read by the ui-state hydration effect, which is keyed on the persisted
  // state's own key and must not re-run just because the host's callbacks did.
  const canAttachRef = useRef(Boolean(onAddContext));
  canAttachRef.current = Boolean(onAddContext);
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
  const remoteLabel = remoteMachineLabel(runtimePin);
  const activeDriver: AppControlDriver = activeSession?.driver ?? drivers?.activeDriver ?? "cdp";

  useEffect(() => {
    activeTargetIdRef.current = activeSession?.cdpTargetId ?? null;
  }, [activeSession?.cdpTargetId]);

  useEffect(() => {
    uiHydrationKeyRef.current = uiStateKey;
    const saved = readPanelUiState(uiStateKey);
    setLaunchCommand(saved.launchCommand);
    setLaunchCwd(saved.launchCwd);
    setCdpPort(saved.cdpPort);
    // A restored (or previously chosen) Inspect mode is not honoured where
    // there is nothing to attach to: the toggle that would let you leave it is
    // not rendered either, so the pane would be stuck picking elements nobody
    // can receive.
    setMode(canAttachRef.current ? saved.mode : "control");
    setRecents(saved.recents);
  }, [uiStateKey]);

  // …and a host that loses the capability while mounted (switching from a chat
  // to a shell session in the same pane) leaves Inspect with it.
  useEffect(() => {
    if (!onAddContext) setMode("control");
  }, [onAddContext]);

  useEffect(() => {
    if (uiHydrationKeyRef.current === uiStateKey) {
      uiHydrationKeyRef.current = null;
      return;
    }
    writePanelUiState(uiStateKey, { launchCommand, launchCwd, cdpPort, mode, recents });
  }, [cdpPort, launchCommand, launchCwd, mode, recents, uiStateKey]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    scrollEnabledRef.current = liveFrameActive && mode === "control";
  }, [liveFrameActive, mode]);

  // Relative times in the drawer only need to be roughly right, and a 1s tick
  // would repaint the whole list for no one's benefit.
  useEffect(() => {
    if (!traceOpen) return undefined;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [traceOpen]);

  // The maths lives in `appControlFrameGeometry` — pure, DOM-free and tested.
  // These three are the thin bindings that hand it the panel's current state.
  const getDisplayedMetrics = useCallback((): LiveFrameDims | null => appControlDisplayedMetrics({
    liveFrameActive,
    liveFrameDims: liveFrameDimsRef.current,
    snapshot,
  }), [liveFrameActive, liveFrameDimsRef, snapshot]);

  const mapClientPoint = useCallback((
    clientX: number,
    clientY: number,
    image: HTMLImageElement | null = imageRef.current,
  ): MappedPoint | null => {
    if (!image) return null;
    return mapClientPointToFrame({
      clientX,
      clientY,
      rect: image.getBoundingClientRect(),
      metrics: getDisplayedMetrics(),
    });
  }, [getDisplayedMetrics]);

  const overlayStyleForElement = useCallback(
    (element: AppControlElement): CSSProperties | null =>
      appControlOverlayBox(element.frame, getDisplayedMetrics()),
    [getDisplayedMetrics],
  );

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
          void window.ade.appControl.scroll(next, runtimePinRef.current).catch(() => {});
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
    if (!agentCursor) return undefined;
    const timer = window.setTimeout(() => setAgentCursor(null), AGENT_CURSOR_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [agentCursor]);

  useEffect(() => {
    if (!copiedHandle) return undefined;
    const timer = window.setTimeout(() => setCopiedHandle(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [copiedHandle]);

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
    const nextStatus = await window.ade.appControl.getStatus(runtimePinRef.current);
    setStatus(nextStatus);
    return nextStatus;
  }, []);

  const refreshTargets = useCallback(async () => {
    try {
      const list = await window.ade.appControl.listTargets(runtimePinRef.current);
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
    const nextSnapshot = await window.ade.appControl.getSnapshot({ projectRoot }, runtimePinRef.current);
    setSnapshot(nextSnapshot);
    setSelectedElement(nextSnapshot.hitElement);
    return nextSnapshot;
  }, [projectRoot]);

  // Trace is pulled, never pushed: the service bumps `session.lastTraceEntryId`
  // on every agent action, so a session-updated event with a new id is the
  // signal to re-read. No timer — an idle app costs nothing.
  const refreshTrace = useCallback(async () => {
    try {
      const result = await window.ade.appControl.getTrace({ limit: 20 }, runtimePinRef.current);
      setTraceEntries(result.entries);
      const latest = result.entries[result.entries.length - 1] ?? null;
      if (!latest || latest.id === cursorTraceIdRef.current) return;
      cursorTraceIdRef.current = latest.id;
      if (!CURSOR_TRACE_ACTIONS.has(latest.action)) return;
      const point = traceCursorPoint(latest, observationElementsRef.current);
      if (!point) return;
      setAgentCursor({
        nonce: Date.now(),
        x: point.x,
        y: point.y,
        action: latest.action,
        failed: latest.status === "error",
      });
    } catch {
      // A trace read races session changes ("… is not the active session") and
      // is unavailable without a project runtime. Neither is worth a banner.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    function resetSessionState(): void {
      // Keeps the last painted frame as the stale one, so a dropped session can
      // show it dimmed behind Reconnect instead of blanking to an empty pane.
      resetLiveFrame();
      setSnapshot(null);
      setSelectedElement(null);
      setSelectedPoint(null);
      setSelectedContextItem(null);
      setHoverElement(null);
      setObservation(null);
      setObserveMapOn(false);
      setActiveHandle(null);
      observationElementsRef.current = [];
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
        const nextTraceId = event.session?.lastTraceEntryId ?? null;
        if (nextTraceId && nextTraceId !== lastTraceIdRef.current) {
          lastTraceIdRef.current = nextTraceId;
          void refreshTrace();
        }
        const nextStatus = event.session?.status ?? null;
        if (nextStatus === "connected") {
          if (previousTargetId !== nextTargetId) {
            // A different window: the previous one's last frame is not a
            // "stale" view of this one, so it is dropped rather than kept.
            clearLiveFrame();
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
        setTraceEntries([]);
        lastTraceIdRef.current = null;
        cursorTraceIdRef.current = null;
      }
      if (event.type === "frame") {
        onLiveFrame(event.frame, activeTargetIdRef.current);
      }
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
      if (scrollRafRef.current != null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      scrollPendingRef.current = null;
    };
  }, [clearLiveFrame, onLiveFrame, refreshSnapshot, refreshStatus, refreshTrace, resetLiveFrame]);

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

  // Driver capabilities are static per machine, so this reads once per session
  // rather than on a timer.
  useEffect(() => {
    if (!sessionConnected) return undefined;
    let cancelled = false;
    void window.ade.appControl.listDrivers(runtimePinRef.current)
      .then((result) => {
        if (!cancelled) setDrivers(result);
      })
      .catch(() => {
        if (!cancelled) setDrivers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionConnected, activeSession?.id]);

  // Pick up any actions an agent took before this panel mounted.
  useEffect(() => {
    if (!sessionConnected) return;
    void refreshTrace();
  }, [refreshTrace, sessionConnected, activeSession?.id]);

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

  const rememberLaunch = useCallback((command: string, cwd: string | null) => {
    setRecents((current) => {
      const next = [{ command, cwd }, ...current.filter((entry) => entry.command !== command)];
      return next.slice(0, MAX_RECENT_LAUNCHES);
    });
  }, []);

  const launchSelected = useCallback(
    (commandOverride?: string, cwdOverride?: string | null) =>
      runBusy("launch", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const command = (commandOverride ?? launchCommand).trim();
        if (!command) throw new Error("Enter a launch command.");
        const cwd = (cwdOverride === undefined ? launchCwd : cwdOverride ?? "").trim();
        const launched = await window.ade.appControl.launchInTerminal({
          projectRoot,
          laneId,
          command,
          cwd: cwd.length ? cwd : null,
          chatSessionId: sessionId,
          force: true,
        }, runtimePinRef.current);
        rememberLaunch(command, cwd.length ? cwd : null);
        const nextStatus = await window.ade.appControl.getStatus(runtimePinRef.current);
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
    [controlsDisabled, controlsDisabledMessage, laneId, launchCommand, launchCwd, onShowTerminal, projectRoot, refreshSnapshot, rememberLaunch, runBusy, sessionId],
  );

  const attachToTargetId = useCallback(
    (targetId: string) => {
      if (controlsDisabled) {
        setMessage({ tone: "error", text: controlsDisabledMessage });
        return undefined;
      }
      // Optimistically reflect the user's pick in the switcher so it doesn't
      // appear to "snap back" while the new screencast spins up.
      setPendingTargetId(targetId);
      return runBusy("attach", async () => {
        try {
          // `switchWindow` also clears the service-side trace, because handles
          // minted against the previous document stop resolving. Fall back to
          // the older attach path when it is not reachable.
          try {
            const result = await window.ade.appControl.switchWindow({ targetId }, runtimePinRef.current);
            setTargets(result.windows);
          } catch {
            const session = await window.ade.appControl.attachToTarget({ targetId }, runtimePinRef.current);
            setStatus((current) => (current ? { ...current, activeSession: session } : current));
            await refreshTargets();
          }
          setTraceEntries([]);
          setObservation(null);
          setObserveMapOn(false);
          setActiveHandle(null);
          observationElementsRef.current = [];
          cursorTraceIdRef.current = null;
          setAgentCursor(null);
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
        }, runtimePinRef.current);
        const nextStatus = await window.ade.appControl.getStatus(runtimePinRef.current);
        setStatus({ ...nextStatus, activeSession: connected });
        setMode("control");
        await refreshSnapshot();
        setMessage({ tone: "info", text: `Connected to ${connected.label}.` });
      }),
    [cdpPort, controlsDisabled, controlsDisabledMessage, laneId, projectRoot, refreshSnapshot, runBusy, sessionId],
  );

  const reconnect = useCallback(
    () =>
      runBusy("reconnect", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        const port = activeSession?.cdpPort ?? Number(cdpPort);
        if (Number.isFinite(port) && Number(port) > 0) {
          const connected = await window.ade.appControl.connect({
            projectRoot,
            laneId,
            cdpPort: Number(port),
            chatSessionId: sessionId,
            force: true,
          }, runtimePinRef.current);
          setStatus((current) => (current ? { ...current, activeSession: connected } : current));
        }
        await refreshStatus();
        await refreshSnapshot();
      }),
    [activeSession?.cdpPort, cdpPort, controlsDisabled, controlsDisabledMessage, laneId, projectRoot, refreshSnapshot, refreshStatus, runBusy, sessionId],
  );

  const stopSession = useCallback(
    () =>
      runBusy("stop", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        await window.ade.appControl.stop(undefined, runtimePinRef.current);
        const nextStatus = await window.ade.appControl.getStatus(runtimePinRef.current);
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
        await window.ade.appControl.focusWindow(runtimePinRef.current);
      }),
    [controlsDisabled, controlsDisabledMessage, runBusy],
  );

  const minimizeWindow = useCallback(
    () =>
      runBusy("minimize-window", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        await window.ade.appControl.minimizeWindow(runtimePinRef.current);
      }),
    [controlsDisabled, controlsDisabledMessage, runBusy],
  );

  /**
   * Capture an observation and paint its handles over the frame.
   *
   * Explicitly user-driven: `observe` writes an observation record, prunes
   * older ones, and bumps `session.lastObservationId`, so polling it would
   * churn disk and invalidate handles an agent is mid-loop on.
   */
  const runObserve = useCallback(
    () =>
      runBusy("observe", async () => {
        // `maxElements` is deliberately NOT set: element indices are assigned
        // AFTER the bound is applied, so a 60-element observation numbers the
        // same element differently than the service default of 80 that
        // `ade app-control observe` gets. The badge you read on screen has to
        // be the badge an agent is talking about, so take the same default.
        const result = await window.ade.appControl.observe({
          includeDom: true,
          includeDiagnostics: true,
          includeDataUrl: false,
        }, runtimePinRef.current);
        setObservation(result);
        observationElementsRef.current = result.dom?.elements ?? [];
        setObserveMapOn(true);
        setActiveHandle(null);
      }),
    [runBusy],
  );

  const screenshotToChat = useCallback(
    () =>
      runBusy("screenshot", async () => {
        if (!onAddAttachment) throw new Error("Attachments are not available in this panel.");
        const shot = await window.ade.appControl.screenshot(runtimePinRef.current);
        const { path } = await window.ade.agentChat.saveTempAttachment({
          data: stripDataUrlPrefix(shot.dataUrl),
          filename: "app-control-screenshot.png",
        }, ...(runtimePin ? [runtimePin] as const : []));
        onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
        setMessage({ tone: "info", text: "Attached a screenshot to the chat." });
      }),
    [onAddAttachment, runBusy, runtimePin],
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
      }, runtimePinRef.current);
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

  /** Hand an observed element's stable handle to the chat, not a coordinate. */
  const addHandleToChat = useCallback(
    (element: AppControlElementSnapshot) => {
      const handle = element.handle;
      if (!handle || !onAddContext) return;
      const summary = elementSummary(element) ?? `element ${element.index}`;
      onAddContext({
        kind: "app_control_element",
        id: handle,
        appKind: activeSession?.appKind ?? "electron",
        sessionId: activeSession?.id ?? null,
        provider: "cdp",
        componentId: summary,
        sourceFile: null,
        sourceLine: null,
        frame: element.frame,
        metadata: {
          handle,
          elementIndex: element.index,
          observationId: observation?.id ?? null,
          role: element.role,
          tagName: element.tagName,
          selector: element.selector,
          testId: element.testId,
          summary,
        },
        selectedAt: new Date().toISOString(),
      });
      setMessage({ tone: "info", text: `Added ${handle} (${summary}) to the chat.` });
    },
    [activeSession?.appKind, activeSession?.id, observation?.id, onAddContext],
  );

  const copyHandle = useCallback((handle: string) => {
    setActiveHandle((current) => (current === handle ? null : handle));
    void navigator.clipboard?.writeText?.(handle)
      .then(() => setCopiedHandle(handle))
      .catch(() => {});
  }, []);

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
      // makes the picker and Stop button flash and feel locked.
      window.ade.appControl
        .click({ x: point.viewportX, y: point.viewportY, coordinateSpace: "viewport" }, runtimePinRef.current)
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
          }, runtimePinRef.current)
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
        await window.ade.appControl.typeText({ text: typeText }, runtimePinRef.current);
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
  const liveFrameAgeMs = liveFrame.ageMs;
  const liveFrameStale = liveFrameAgeMs != null && liveFrameAgeMs > APP_CONTROL_FRAME_STALE_MS;
  const focusElement = hoverElement ?? selectedElement;
  const metrics = getDisplayedMetrics();
  const overlayViewport = metrics
    ? { viewportWidth: metrics.viewportWidth, viewportHeight: metrics.viewportHeight }
    : null;
  const observedElements = useMemo(() => observation?.dom?.elements ?? [], [observation]);
  const traceRows = useMemo(
    () => traceEntries.map((entry) => formatTraceRow(entry, nowMs, observedElements)).reverse(),
    [nowMs, observedElements, traceEntries],
  );
  const lastActionLine = formatLastActionLine(
    traceEntries[traceEntries.length - 1] ?? null,
    nowMs,
    observedElements,
  );
  const hasFrame = Boolean(screenshot || liveFrameActive);
  const launching = hasActiveSession && !sessionConnected;
  // "The app stopped responding" is for a session that DROPPED, not for one you
  // stopped. Gated on the session's own error tone (`Disconnected`, `Failed`)
  // rather than on "there is a stale frame and no live one", which was also
  // true one beat after the ⋯ → Stop you just chose — so a deliberate stop
  // rendered a greyed-out frame and a Reconnect button instead of the "No app
  // attached" empty state.
  const showDisconnected = !hasFrame
    && !launching
    && Boolean(staleFrameSrc)
    && sessionStatus.tone === "error";

  const renderOverflow = useCallback((close: () => void) => (
    <>
      <AppControlMenuLabel>Observe</AppControlMenuLabel>
      <AppControlMenuItem
        icon={<Crosshair size={11} />}
        label={observeMapOn ? "Hide observe map" : "Observe with map"}
        checked={observeMapOn}
        disabled={!sessionConnected || Boolean(busy)}
        disabledReason={sessionConnected ? undefined : "Attach an app first."}
        onSelect={() => {
          if (observeMapOn) {
            setObserveMapOn(false);
            setActiveHandle(null);
          } else {
            void runObserve();
          }
          close();
        }}
      />
      <AppControlMenuItem
        icon={<ListChecks size={11} />}
        label={traceOpen ? "Hide trace" : "Trace"}
        checked={traceOpen}
        onSelect={() => {
          setTraceOpen((value) => !value);
          close();
        }}
      />
      <AppControlMenuItem
        icon={<ArrowClockwise size={11} />}
        label="Refresh snapshot"
        hint="Re-capture screenshot and DOM snapshot"
        disabled={Boolean(busy) || !sessionConnected || controlsDisabled}
        onSelect={() => {
          void runBusy("snapshot", async () => {
            await refreshSnapshot();
            setMessage({ tone: "info", text: "Snapshot refreshed." });
          });
          close();
        }}
      />

      {/* No "Windows" group here. The toolbar already exposes every window —
          up to three segments plus a `+N` menu listing the rest — and this was
          a second, complete copy of the same list with a different label rule
          (raw URL, no host stripping), so the two disagreed on any window
          without a title. One affordance, one label. */}

      {/* Only where there is a chat, draft or CLI session to send to. */}
      {canSendToChat ? <AppControlMenuLabel>Send to chat</AppControlMenuLabel> : null}
      {onAddAttachment ? (
        <AppControlMenuItem
          icon={<Camera size={11} />}
          label="Screenshot to chat"
          disabled={!sessionConnected || Boolean(busy)}
          disabledReason="Attach an app first."
          onSelect={() => {
            void screenshotToChat();
            close();
          }}
        />
      ) : null}
      {onAddContext ? (
        <AppControlMenuItem
          icon={<Crosshair size={11} />}
          label="Insert as context"
          hint="Switch to Inspect and click an element"
          disabled={!sessionConnected || controlsDisabled}
          disabledReason="Attach an app first."
          onSelect={() => {
            setMode("inspect");
            if (selectedPoint) void runBusy("select", () => attachSelection(selectedPoint.x, selectedPoint.y));
            close();
          }}
        />
      ) : null}

      <AppControlMenuLabel>Session</AppControlMenuLabel>
      <AppControlMenuItem
        icon={<Terminal size={11} />}
        label="Reveal terminal"
        disabled={!activeSession?.terminalSessionId || !activeSession?.terminalPtyId || !onShowTerminal}
        disabledReason="This session has no launch terminal."
        onSelect={() => {
          if (activeSession?.terminalSessionId && activeSession.terminalPtyId) {
            onShowTerminal?.({
              terminalId: activeSession.terminalSessionId,
              ptyId: activeSession.terminalPtyId,
              label: activeSession.label,
            });
          }
          close();
        }}
      />
      <AppControlMenuItem
        icon={<ArrowSquareOut size={11} />}
        label="Show app window"
        disabled={!sessionConnected || Boolean(busy) || controlsDisabled}
        onSelect={() => {
          void focusWindow();
          close();
        }}
      />
      <AppControlMenuItem
        icon={<Minus size={11} />}
        label="Minimize app window"
        disabled={!sessionConnected || Boolean(busy) || controlsDisabled}
        onSelect={() => {
          void minimizeWindow();
          close();
        }}
      />
      <AppControlMenuItem
        icon={<Stop size={11} weight="fill" />}
        label="Stop"
        tone="danger"
        disabled={!canStop || Boolean(busy)}
        disabledReason="No session to stop."
        onSelect={() => {
          void stopSession();
          close();
        }}
      />
    </>
  ), [
    activeSession, attachSelection, busy, canSendToChat, canStop, controlsDisabled, focusWindow,
    minimizeWindow, observeMapOn, onAddAttachment, onAddContext, onShowTerminal,
    refreshSnapshot, runBusy, runObserve, screenshotToChat, selectedPoint, sessionConnected, stopSession,
    traceOpen,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col font-sans text-[11px] text-fg/75">
      <AppControlToolbar
        appLabel={activeSession?.label ?? "Pick an app"}
        hasSession={hasActiveSession}
        recents={recents}
        launchCommand={launchCommand}
        onLaunchCommandChange={(value) => {
          setLaunchCommand(value);
          if (launchCwd) setLaunchCwd("");
        }}
        onLaunch={(command, cwd) => void launchSelected(command, cwd)}
        canLaunch={canLaunch}
        launching={busy === "launch"}
        cdpPort={cdpPort}
        onCdpPortChange={setCdpPort}
        onConnect={() => void connectPort()}
        connecting={busy === "connect"}
        onHelpWireCdp={onInsertDraft ? requestDebugHelp : null}
        drivers={drivers}
        activeDriver={activeDriver}
        statusWord={sessionStatus.word}
        statusTone={sessionStatus.tone}
        statusDetail={sessionStatus.detail}
        remoteLabel={remoteLabel}
        windows={targets}
        activeWindowId={pendingTargetId ?? targets.find((target) => target.active)?.id ?? null}
        onSwitchWindow={(targetId) => void attachToTargetId(targetId)}
        switching={busy === "attach"}
        controlsDisabled={controlsDisabled}
        pickerOpen={pickerOpen}
        onPickerOpenChange={setPickerOpen}
        renderOverflow={renderOverflow}
      />

      {waitingForCdp && activeSession?.cdpPort ? (
        <div
          className="flex shrink-0 items-start gap-2 border-b border-amber-400/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-100/85"
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
            "flex shrink-0 items-start gap-2 border-b px-2.5 py-1.5 text-[11px]",
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

      {/*
        Body — the same card the browser stage draws.

        The frame is inset 8px from the pane, 10px-radius, with a 1px inset
        ring over the muted surface, so App Control and the browser next door
        read as one product instead of two panes that merely sit side by side.
        Every overlay — the mode toggle, the URL chip, the observe badges, the
        agent cursor — is a child of this inner frame, so all of them stay
        aligned to the inset edge rather than to the pane's own edge.
      */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col p-2">
        <div
          data-testid="app-control-stage"
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px]",
            "bg-[var(--color-surface)] ring-1 ring-inset ring-white/[0.08]",
          )}
        >
          {/* Inspect exists to attach an element to a chat, so without one there
              is only Control left — and a one-option toggle is chrome that asks
              a question with a single answer. */}
          {hasActiveSession && onAddContext ? (
            <div
              className="absolute left-2 top-2 z-10 inline-flex items-center rounded-[var(--radius-sm)] border border-white/[0.1] bg-black/55 p-0.5 backdrop-blur"
              role="group"
              aria-label="App Control mode"
            >
              {(["control", "inspect"] as const).map((nextMode) => (
                <button
                  key={nextMode}
                  type="button"
                  disabled={controlsDisabled}
                  aria-pressed={mode === nextMode}
                  onClick={() => setMode(nextMode)}
                  className={cn(
                    "h-[20px] rounded-[3px] px-2 text-[10px] font-medium transition-colors duration-[120ms] ease-out",
                    "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                    "disabled:cursor-not-allowed disabled:opacity-45",
                    mode === nextMode
                      ? "bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-fg/90"
                      : "text-muted-fg/65 hover:bg-white/[0.06] hover:text-fg/85",
                  )}
                >
                  {nextMode === "control" ? "Control" : "Inspect"}
                </button>
              ))}
            </div>
          ) : null}

          {snapshot?.url ? (
            <div
              className="absolute right-2 top-2 z-10 max-w-[55%] truncate rounded-[var(--radius-sm)] border border-white/[0.1] bg-black/55 px-2 py-1 text-[10px] text-muted-fg backdrop-blur"
              title={snapshot.url}
            >
              {snapshot.title ?? snapshot.url}
            </div>
          ) : null}
          {liveFrameStale ? (
            <div className="absolute right-2 top-9 z-10 rounded-[var(--radius-sm)] border border-amber-300/20 bg-amber-500/12 px-2 py-1 text-[10px] font-medium text-amber-100/85 backdrop-blur">
              Stream stale
            </div>
          ) : null}

          {hasFrame ? (
            <div className="relative flex h-full min-h-0 w-full items-center justify-center overflow-auto">
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
                    // 9px, not 10: one pixel inside the frame's own radius, so
                    // the corner never shows a sliver of surface between the
                    // frame's ring and the frame it holds.
                    "block max-h-[60vh] max-w-full rounded-[9px] object-contain",
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
                    // A frame the browser refused to decode is not a frame worth
                    // keeping as the "last good" one either.
                    clearLiveFrame();
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
                  <div className="absolute inset-0 flex items-center justify-center rounded-[9px] border border-amber-300/18 bg-black/70 px-4 text-center backdrop-blur-sm">
                    <div className="max-w-[360px] text-[11px] leading-5 text-amber-100/85">
                      Renderer attached, but the screenshot is blank. Open the app window or menu bar item, then refresh Snapshot.
                    </div>
                  </div>
                ) : null}

                {/* Observe map — numbered handles an agent can quote back. */}
                {observeMapOn && overlayViewport && !screenshotBlank ? (
                  <AppControlObserveOverlay
                    elements={observedElements}
                    viewport={overlayViewport}
                    activeHandle={activeHandle}
                    copiedHandle={copiedHandle}
                    onSelectHandle={copyHandle}
                    onAddToChat={onAddContext ? addHandleToChat : null}
                  />
                ) : null}

                {/* Agent cursor — where the last agent action actually landed. */}
                {overlayViewport && !screenshotBlank ? (
                  <AppControlAgentCursor cursor={agentCursor} viewport={overlayViewport} />
                ) : null}

                {/* Inspect-only: persistent outline for the attached/selected element */}
                {mode === "inspect" && selectedElement && !screenshotBlank ? (() => {
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
                {mode === "inspect" && hoverElement && !screenshotBlank && hoverElement.id !== selectedElement?.id ? (() => {
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
                {mode === "inspect" && selectedPoint && !screenshotBlank && !selectedElement && metrics ? (
                  <div
                    className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-300/90 bg-sky-300/40"
                    style={{
                      left: `${(selectedPoint.x / metrics.viewportWidth) * 100}%`,
                      top: `${(selectedPoint.y / metrics.viewportHeight) * 100}%`,
                    }}
                  />
                ) : null}
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
          ) : launching ? (
            <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4" role="status">
              <div className="ade-tool-skeleton h-[132px] w-full max-w-[320px] rounded-[var(--radius-lg)]" aria-hidden="true" />
              <div className="flex items-center gap-1.5 text-[11px] text-muted-fg">
                <SpinnerGap size={12} className="animate-spin" />
                {sessionStatus.detail}
              </div>
            </div>
          ) : showDisconnected ? (
            <div className="relative flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
              <img
                src={staleFrameSrc ?? undefined}
                alt="Last frame before the app disconnected"
                draggable={false}
                className="block max-h-[60vh] max-w-full rounded-[9px] object-contain opacity-25 grayscale"
              />
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                <div className="text-[12px] font-medium text-fg/85">The app stopped responding</div>
                <div className="max-w-[300px] text-[11px] leading-[16px] text-muted-fg">
                  {sessionStatus.detail}
                </div>
                <button
                  type="button"
                  disabled={Boolean(busy) || controlsDisabled}
                  onClick={() => void reconnect()}
                  className={cn(
                    "inline-flex h-[26px] items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-[11px] font-medium",
                    "border border-white/[0.12] bg-white/[0.05] text-fg/85",
                    "transition-colors duration-[120ms] ease-out hover:bg-white/[0.1]",
                    "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                    "disabled:cursor-not-allowed disabled:opacity-45",
                  )}
                >
                  {busy === "reconnect" ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowClockwise size={11} />}
                  Reconnect
                </button>
              </div>
            </div>
          ) : (
            /* One line and one action, like every other tool's empty state.
               This was a glyph, a headline, a paragraph, a button and a CLI
               hint — five things saying the same thing the header already
               says, in three different casings of "no app". */
            <WorkToolEmptyLine
              title={sessionConnected ? "Capture a snapshot to begin" : "No app attached"}
              action={sessionConnected ? undefined : (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className={WORK_TOOL_PRIMARY_BUTTON}
                  data-testid="app-control-empty-pick"
                >
                  <Stack size={14} weight="regular" />
                  <span>Pick an app</span>
                </button>
              )}
            />
          )}
        </div>
      </div>

      {/* Control-mode keyboard input — the one action the frame can't express. */}
      {mode === "control" && hasActiveSession ? (
        <div className="flex h-[28px] shrink-0 items-center gap-1 border-t border-white/[0.08] pl-2 focus-within:bg-white/[0.02]">
          <Keyboard size={10} className="shrink-0 text-muted-fg/55" />
          <input
            value={typeText}
            onChange={(event) => setTypeText(event.target.value)}
            placeholder="Type into focused element"
            aria-label="Text to type into the focused app element"
            className="h-full min-w-0 flex-1 bg-transparent text-[10.5px] text-fg/85 outline-none placeholder:text-muted-fg/45"
            onKeyDown={(event) => {
              if (event.key === "Enter") void typeIntoApp();
            }}
          />
          <button
            type="button"
            disabled={Boolean(busy) || !canType}
            onClick={typeIntoApp}
            className={cn(
              "inline-flex h-full shrink-0 items-center justify-center border-l border-white/[0.06] px-2 text-[10.5px] font-medium",
              "text-fg/80 transition-colors duration-[120ms] ease-out hover:bg-white/[0.06]",
              "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
              "disabled:cursor-not-allowed disabled:opacity-45",
            )}
            title="Send keystrokes to the focused element"
            aria-label="Type into focused app element"
          >
            {busy === "type" ? <SpinnerGap size={12} className="animate-spin" /> : "Type"}
          </button>
        </div>
      ) : null}

      {/* Inspect-mode detail — what the last click attached. */}
      {mode === "inspect" ? (
        <div className="flex min-h-[28px] shrink-0 items-center gap-2 border-t border-white/[0.08] px-2">
          {focusElement ? (
            <>
              <span className="min-w-0 truncate text-[11px] font-medium text-fg/85" title={elementLabel(focusElement)}>
                {elementLabel(focusElement)}
              </span>
              {elementSubLabel(focusElement) ? (
                <span className="shrink-0 rounded border border-white/[0.08] bg-white/[0.03] px-1 font-mono text-[9px] uppercase tracking-wide text-muted-fg">
                  {elementSubLabel(focusElement)}
                </span>
              ) : null}
              {selectedContextItem?.sourceFile ? (
                <span
                  className="min-w-0 truncate font-mono text-[9.5px] text-sky-100/65"
                  title={`${selectedContextItem.sourceFile}${selectedContextItem.sourceLine ? `:${selectedContextItem.sourceLine}` : ""}`}
                >
                  {selectedContextItem.sourceFile}
                  {selectedContextItem.sourceLine ? `:${selectedContextItem.sourceLine}` : ""}
                </span>
              ) : null}
              {hoverElement && hoverElement.id !== selectedElement?.id ? (
                <span className="ml-auto shrink-0 text-[10px] text-muted-fg/50">hovering</span>
              ) : attachmentAck ? (
                <span className="ml-auto shrink-0 rounded-full border border-emerald-300/25 bg-emerald-500/10 px-1.5 text-[9px] font-medium text-emerald-100/85">
                  Attached
                </span>
              ) : null}
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-fg">
              {attachmentAck
                ? `Inserted ${attachmentAck} context`
                : sessionConnected
                  ? "Click an element to insert its source context."
                  : "Launch or connect to inspect elements."}
            </span>
          )}
          <button
            type="button"
            disabled={Boolean(busy) || screenshotBlank || !selectedPoint || !sessionConnected || controlsDisabled}
            onClick={() => {
              if (selectedPoint) void runBusy("select", () => attachSelection(selectedPoint.x, selectedPoint.y));
            }}
            className={cn(
              "ml-auto inline-flex h-[20px] shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-[10.5px] font-medium",
              "text-muted-fg transition-colors duration-[120ms] ease-out hover:bg-white/[0.06] hover:text-fg/85",
              "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
              "disabled:cursor-not-allowed disabled:opacity-45",
            )}
            title="Attach the selected element again"
          >
            {busy === "select" ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowClockwise size={11} />}
            Re-attach
          </button>
        </div>
      ) : null}

      <AppControlTraceDrawer
        open={traceOpen}
        rows={traceRows}
        onClose={() => setTraceOpen(false)}
      />

      <AppControlStatusRow
        lastLine={lastActionLine}
        // Nothing to report is not a sentence worth a footer row: the empty
        // state above already says there is no app.
        hint={sessionConnected ? "No agent actions on this app yet." : ""}
        consoleErrors={countConsoleErrors(observation?.diagnostics)}
        networkFailures={countNetworkFailures(observation?.diagnostics)}
        diagnosticsKnown={Boolean(observation?.diagnostics)}
        traceCount={traceEntries.length}
        traceOpen={traceOpen}
        onToggleTrace={() => setTraceOpen((value) => !value)}
      />
    </div>
  );
}
