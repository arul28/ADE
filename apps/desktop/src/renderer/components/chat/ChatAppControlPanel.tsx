import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Camera,
  Crosshair,
  Desktop,
  Keyboard,
  ListChecks,
  Minus,
  PictureInPicture,
  Power,
  Record,
  SealCheck,
  SpinnerGap,
  Stop,
  Terminal,
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
  WORK_TOOL_CHROME_ROW,
  WorkToolChromeButton,
  WorkToolEmptyLine,
} from "../terminals/workToolChrome";
import { WorkToolPreviewControls } from "../terminals/workToolPreviewControls";
import { appControlAppName } from "../terminals/useWorkToolStatuses";
import { useWorkToolsMaximize } from "../terminals/workToolsMaximize";
import { selectActiveProjectStateKey, useAppStore } from "../../state/appStore";
import { floatWorkLiveCardForChat } from "./chatCompanionUiState";
import {
  APP_CONTROL_DRIVER_LABEL,
  AppControlToolbar,
  type AppControlLaunchRecent,
  type AppControlStatusTone,
} from "./AppControlToolbar";
import { AppControlOffCard } from "./AppControlOffCard";
import { AppControlStatusStrip, type AppControlStripMessage } from "./AppControlStatusStrip";
import { AppControlStopConfirm, appControlStopQuitsApp } from "./AppControlStopConfirm";
import { MacDesktopStateCard, MAC_DESKTOP_SECONDARY_BUTTON } from "./MacDesktopStateCard";
import { MacDesktopPermissionCard } from "./MacDesktopPermissionCard";
import { RecordingSavedRow } from "../shared/RecordingReceipt";
import { formatRecordingElapsed } from "../shared/recordingFormat";
import { useAppControlRecording } from "./useAppControlRecording";
import { appControlProofCaption } from "../../../shared/proofProvenance";
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
  /** The lane whose App Control session this pane shows. One session per lane. */
  laneId: string | null;
  laneName?: string | null;
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
/** How long "The agent is driving" stays in the strip after its last action. */
const AGENT_DRIVING_LINGER_MS = 6_000;

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

/** `name` is `appControlAppName` or "App", never the launch command. */
function statusInfo(session: AppControlSession | null, name: string): StatusInfo {
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
        word: "live",
        detail: session.cdpPort ? `${name} on CDP port ${session.cdpPort}` : name,
        tone: "active",
      };
    case "starting":
      return {
        label: "Starting",
        word: "launching",
        detail: `${name} is starting${suffix ? ` · ${suffix}` : ""}`,
        tone: "warn",
      };
    case "running":
      if (lostConnection) {
        return {
          label: "Disconnected",
          word: "disconnected",
          detail: session.lastError ?? `${name} stopped responding. The app may have quit while the launch terminal is still running.`,
          tone: "error",
        };
      }
      return {
        label: "Running",
        word: "launching",
        detail: `${name} is running${suffix ? ` · ${suffix}` : " in the terminal"}`,
        tone: "warn",
      };
    case "stopping":
      return { label: "Stopping", word: "stopping", detail: `${name} is stopping`, tone: "warn" };
    case "exited":
      return { label: "Exited", word: "exited", detail: `${name} has exited`, tone: "muted" };
    case "stopped":
      return { label: "Stopped", word: "stopped", detail: `${name} stopped`, tone: "muted" };
    case "failed":
      return { label: "Failed", word: "failed", detail: session.lastError ?? `${name} failed`, tone: "error" };
    default:
      return { label: session.status, word: session.status, detail: name, tone: "muted" };
  }
}

function remoteMachineLabel(pin: OpenProjectBinding | null | undefined): string | null {
  if (!pin || pin.kind !== "remote") return null;
  return pin.runtimeName || pin.hostname || pin.displayName || "remote machine";
}

export function ChatAppControlPanel({
  sessionId,
  laneId,
  laneName = null,
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
  /**
   * Which lane every call acts on. App Control keeps one session per lane, and
   * a call that names no lane is refused, so the pane names its lane — or, in
   * a chat with no lane, the chat, whose lane the service resolves.
   */
  const laneArgsRef = useRef<{ laneId?: string | null; chatSessionId?: string | null }>({});
  laneArgsRef.current = laneId ? { laneId } : { chatSessionId: sessionId };
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const uiStateKey = panelUiStateKey(sessionId, projectRoot, laneId, runtimePin?.key ?? null);
  const initialUiState = readPanelUiState(uiStateKey);
  const [status, setStatus] = useState<AppControlStatus | null>(null);
  /**
   * The lane whose events this pane follows: its own, or the one the service
   * resolved for a lane-less chat. One stream carries every lane's events.
   */
  const eventLaneId = laneId ?? status?.laneId ?? null;
  const eventLaneIdRef = useRef<string | null>(eventLaneId);
  eventLaneIdRef.current = eventLaneId;
  const [launchCommand, setLaunchCommand] = useState(initialUiState.launchCommand);
  const [launchCwd, setLaunchCwd] = useState(initialUiState.launchCwd);
  const [cdpPort, setCdpPort] = useState(initialUiState.cdpPort);
  const [recents, setRecents] = useState<AppControlLaunchRecent[]>(initialUiState.recents);
  const [snapshot, setSnapshot] = useState<AppControlSnapshot | null>(null);
  const [targets, setTargets] = useState<AppControlTarget[]>([]);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  // The 30fps transport — refs, the rAF pump and the health tick — lives in its
  // own hook; the panel keeps only what its JSX reads.
  // A pane that opens over a still app gets the lane's current picture at
  // once instead of waiting for the next paint.
  const seedSession = status?.activeSession ?? snapshot?.session ?? null;
  const liveFrame = useAppControlLiveFrame(imageRef, {
    laneId: eventLaneId,
    targetId: seedSession?.status === "connected" ? seedSession.cdpTargetId ?? null : null,
    runtimePinRef,
  });
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
  const [confirmStop, setConfirmStop] = useState(false);
  /** The caption a Record or Proof press asks for, or null when not asking. */
  const [captionDraft, setCaptionDraft] = useState<string | null>(null);
  /** Which button the caption prompt belongs to. */
  const [captionFor, setCaptionFor] = useState<"record" | "proof">("record");
  const [agentDrivingAt, setAgentDrivingAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastTraceIdRef = useRef<string | null>(null);
  const cursorTraceIdRef = useRef<string | null>(null);
  const observationElementsRef = useRef<AppControlElementSnapshot[]>([]);

  const activeSession = status?.activeSession ?? snapshot?.session ?? null;
  const activeSessionRef = useRef<AppControlSession | null>(activeSession);
  activeSessionRef.current = activeSession;
  // The page title only counts when the snapshot is of this session.
  const snapshotTitle = snapshot?.session?.id === activeSession?.id ? snapshot?.title ?? null : null;
  const appName = appControlAppName(activeSession, snapshotTitle);
  const sessionStatus = useMemo(
    () => statusInfo(activeSession, appName ?? "App"),
    [activeSession, appName],
  );
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
          void window.ade.appControl.scroll({ ...laneArgsRef.current, ...next }, runtimePinRef.current).catch(() => {});
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
    const nextStatus = await window.ade.appControl.getStatus(laneArgsRef.current, runtimePinRef.current);
    setStatus(nextStatus);
    return nextStatus;
  }, []);

  const refreshTargets = useCallback(async () => {
    try {
      const list = await window.ade.appControl.listTargets(laneArgsRef.current, runtimePinRef.current);
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
    const nextSnapshot = await window.ade.appControl.getSnapshot({ ...laneArgsRef.current, projectRoot }, runtimePinRef.current);
    setSnapshot(nextSnapshot);
    setSelectedElement(nextSnapshot.hitElement);
    return nextSnapshot;
  }, [projectRoot]);

  // Trace is pulled, never pushed: the service bumps `session.lastTraceEntryId`
  // on every agent action, so a session-updated event with a new id is the
  // signal to re-read. No timer — an idle app costs nothing.
  const refreshTrace = useCallback(async () => {
    try {
      const result = await window.ade.appControl.getTrace({ ...laneArgsRef.current, limit: 20 }, runtimePinRef.current);
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
    setStatus(null);
    setTraceEntries([]);
    lastTraceIdRef.current = null;
    cursorTraceIdRef.current = null;
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
    // A lane switch: the last lane's picture is not a stale view of this one.
    resetSessionState();
    clearLiveFrame();
    void refreshStatus().then((nextStatus) => {
      if (!cancelled && nextStatus.activeSession?.status === "connected") {
        void refreshSnapshot().catch(() => {});
      }
    }).catch(() => {});
    const unsubscribe = window.ade.appControl.onEvent((event) => {
      // Another lane's app is not this pane's. Before the first status names
      // the lane of a lane-less chat, only its own chat's session counts.
      const followed = eventLaneIdRef.current;
      if (followed ? event.laneId !== followed : !(
        (event.type === "session-started" || event.type === "session-updated")
        && event.session?.chatSessionId
        && event.session.chatSessionId === sessionIdRef.current
      )) return;
      if (event.type === "session-started" || event.type === "session-updated") {
        const previousTargetId = activeTargetIdRef.current;
        const nextTargetId = event.session?.cdpTargetId ?? null;
        activeTargetIdRef.current = nextTargetId;
        setStatus((current) => (current ? { ...current, activeSession: event.session } : current));
        const nextTraceId = event.session?.lastTraceEntryId ?? null;
        if (nextTraceId && nextTraceId !== lastTraceIdRef.current) {
          // The first id a pane sees may predate it; only a change is news.
          if (lastTraceIdRef.current) setAgentDrivingAt(Date.now());
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
        setConfirmStop(false);
        setAgentDrivingAt(null);
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
    // `laneId`: a different lane is a different session, read afresh.
  }, [clearLiveFrame, laneId, onLiveFrame, refreshSnapshot, refreshStatus, refreshTrace, resetLiveFrame]);

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
    void window.ade.appControl.listDrivers(laneArgsRef.current, runtimePinRef.current)
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
        const nextStatus = await window.ade.appControl.getStatus(laneArgsRef.current, runtimePinRef.current);
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
        // The wait for the debug port is the strip's own line while it lasts,
        // so the launch says only what it did.
        if (launched.lastError) {
          setMessage({ tone: "error", text: launched.lastError });
        } else {
          setMessage({ tone: "info", text: `Started ${launched.label} in the terminal.` });
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
            const result = await window.ade.appControl.switchWindow({ ...laneArgsRef.current, targetId }, runtimePinRef.current);
            setTargets(result.windows);
          } catch {
            const session = await window.ade.appControl.attachToTarget({ ...laneArgsRef.current, targetId }, runtimePinRef.current);
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
        const nextStatus = await window.ade.appControl.getStatus(laneArgsRef.current, runtimePinRef.current);
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
        setConfirmStop(false);
        const stopping = activeSessionRef.current;
        const quits = appControlStopQuitsApp(stopping);
        await window.ade.appControl.stop({ ...laneArgsRef.current, chatSessionId: sessionIdRef.current }, runtimePinRef.current);
        const nextStatus = await window.ade.appControl.getStatus(laneArgsRef.current, runtimePinRef.current);
        setStatus(nextStatus);
        setSnapshot(null);
        setSelectedElement(null);
        setSelectedPoint(null);
        setSelectedContextItem(null);
        const label = stopping?.label ?? "the app";
        setMessage({ tone: "info", text: quits ? `Quit ${label}.` : `Detached from ${label}. It is still running.` });
      }),
    [controlsDisabled, controlsDisabledMessage, runBusy],
  );

  const focusWindow = useCallback(
    () =>
      runBusy("focus-window", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        await window.ade.appControl.focusWindow(laneArgsRef.current, runtimePinRef.current);
      }),
    [controlsDisabled, controlsDisabledMessage, runBusy],
  );

  const minimizeWindow = useCallback(
    () =>
      runBusy("minimize-window", async () => {
        if (controlsDisabled) throw new Error(controlsDisabledMessage);
        await window.ade.appControl.minimizeWindow(laneArgsRef.current, runtimePinRef.current);
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
          ...laneArgsRef.current,
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
        const shot = await window.ade.appControl.screenshot(laneArgsRef.current, runtimePinRef.current);
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
        ...laneArgsRef.current,
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
        .click({ ...laneArgsRef.current, x: point.viewportX, y: point.viewportY, coordinateSpace: "viewport" }, runtimePinRef.current)
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
            ...laneArgsRef.current,
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
        await window.ade.appControl.typeText({ ...laneArgsRef.current, text: typeText }, runtimePinRef.current);
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
  // A still page sends no screencast frames, so frame age alone is not a
  // fault. Only an old frame on a session that is no longer connected is.
  const liveFrameStale = !sessionConnected && liveFrameAgeMs != null && liveFrameAgeMs > APP_CONTROL_FRAME_STALE_MS;
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

  const maximize = useWorkToolsMaximize();
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const setWorkViewState = useAppStore((state) => state.setWorkViewState);
  /**
   * "Show floating": float this lane's app over the chat and put the tools
   * pane away, so the float is what you see. Only in the Work tools pane,
   * which is where the floating player lives; a chat drawer has no pane to
   * minimize into.
   */
  const canFloat = Boolean(maximize && sessionId && projectStateKey);
  const showFloating = useCallback(() => {
    if (!sessionId || !projectStateKey) return;
    floatWorkLiveCardForChat(sessionId, "app-control");
    maximize?.setMaximized(false);
    setWorkViewState(projectStateKey, { workSidebarOpen: false });
  }, [maximize, projectStateKey, sessionId, setWorkViewState]);

  const recorder = useAppControlRecording({
    laneId: eventLaneId,
    chatSessionId: sessionId,
    runtimePin,
    enabled: hasActiveSession,
  });
  // The app's page title and the lane; the service files the same default.
  const defaultCaption = appControlProofCaption(appName, laneName);
  const toggleRecording = useCallback(() => {
    if (recorder.running) {
      void recorder.stop();
      return;
    }
    // A person pressing Record wants the file kept, and a caption is what
    // files it as proof. So Record asks for one, prefilled.
    setConfirmStop(false);
    setCaptionDraft((current) => (current != null && captionFor === "record" ? null : defaultCaption));
    setCaptionFor("record");
  }, [captionFor, defaultCaption, recorder]);
  // Proof: one still of the app, filed as proof. Like Record, it asks for a
  // caption, prefilled, because the caption is what a reviewer judges it on.
  const toggleProof = useCallback(() => {
    setConfirmStop(false);
    setCaptionDraft((current) => (current != null && captionFor === "proof" ? null : defaultCaption));
    setCaptionFor("proof");
  }, [captionFor, defaultCaption]);
  const submitCaption = useCallback(() => {
    if (captionFor === "proof") {
      const caption = captionDraft?.trim() || defaultCaption;
      setCaptionDraft(null);
      void recorder.captureProof(caption);
      return;
    }
    const caption = captionDraft?.trim() || defaultCaption;
    setCaptionDraft(null);
    void recorder.start(caption);
  }, [captionDraft, captionFor, defaultCaption, recorder]);

  // "The agent is driving" fades a few seconds after its last action. One
  // timer per action, never a poll.
  useEffect(() => {
    if (agentDrivingAt == null) return undefined;
    const timer = window.setTimeout(() => setAgentDrivingAt(null), AGENT_DRIVING_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [agentDrivingAt]);

  // A session that went away takes its questions with it.
  useEffect(() => {
    if (hasActiveSession) return;
    setConfirmStop(false);
    setCaptionDraft(null);
  }, [hasActiveSession]);

  /**
   * The pane's one strip, most pressing thing first: what went wrong, what is
   * still starting, what is recording, what the agent is doing, and the note
   * about the last thing you did. Live and quiet is no line at all.
   */
  const stripMessage = ((): AppControlStripMessage | null => {
    if (message?.tone === "error") {
      return {
        key: `error:${message.text}`,
        tone: "error",
        sentence: message.text,
        onDismiss: () => setMessage(null),
        testId: "app-control-error",
      };
    }
    if (recorder.error) {
      return {
        key: `recording-error:${recorder.error}`,
        tone: "error",
        sentence: recorder.error,
        onDismiss: recorder.clearError,
        testId: "app-control-recording-error",
      };
    }
    if (activeSession && sessionStatus.tone === "error" && !showDisconnected) {
      return {
        key: `session:${activeSession.id}:${sessionStatus.detail}`,
        tone: "error",
        sentence: sessionStatus.detail,
        actions: activeSession.cdpPort && !controlsDisabled
          ? [{ label: "Reconnect", onClick: () => void reconnect(), disabled: Boolean(busy) }]
          : undefined,
        testId: "app-control-session-error",
      };
    }
    if (waitingForCdp && activeSession?.cdpPort) {
      const terminal = activeSession.terminalSessionId && activeSession.terminalPtyId && onShowTerminal
        ? { terminalId: activeSession.terminalSessionId, ptyId: activeSession.terminalPtyId, label: activeSession.label }
        : null;
      return {
        key: `waiting:${activeSession.id}`,
        tone: "notice",
        busy: true,
        sentence: `Starting ${appName ?? "the app"}. Waiting for its debug port on 127.0.0.1:${activeSession.cdpPort}.`,
        detail: "ADE adds the debug flags for common npm, pnpm, yarn, bun and direct Electron launches. If this does not end, quit any older copy of the app, or pass ADE_APP_CONTROL_DEBUG_FLAGS to the launcher.",
        actions: terminal ? [{ label: "Show terminal", onClick: () => onShowTerminal?.(terminal), muted: true }] : undefined,
        testId: "app-control-waiting",
      };
    }
    if (recorder.running) {
      return {
        key: "recording",
        tone: "notice",
        icon: <span aria-hidden="true" className="block h-2 w-2 rounded-full bg-[var(--color-error)] motion-safe:animate-pulse" />,
        sentence: `Recording ${formatRecordingElapsed(recorder.elapsedMs)}`,
        detail: recorder.recording?.caption ?? null,
        actions: [{ label: "Stop recording", onClick: () => void recorder.stop(), disabled: recorder.busy }],
        testId: "app-control-recording",
      };
    }
    if (recorder.notice) {
      return {
        key: `recording-notice:${recorder.notice}`,
        tone: "notice",
        sentence: recorder.notice,
        onDismiss: recorder.clearNotice,
        testId: "app-control-recording-notice",
      };
    }
    if (agentDrivingAt != null && sessionConnected) {
      return {
        key: `driving:${agentDrivingAt}`,
        tone: "notice",
        icon: <Crosshair size={13} />,
        sentence: lastActionLine
          ? `The agent is driving ${appName ?? "the app"} · ${lastActionLine}`
          : `The agent is driving ${appName ?? "the app"}`,
        testId: "app-control-agent-driving",
      };
    }
    if (message) {
      return {
        key: `info:${message.text}`,
        tone: "notice",
        sentence: message.text,
        onDismiss: () => setMessage(null),
        testId: "app-control-message",
      };
    }
    return null;
  })();

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
      {canFloat ? (
        <AppControlMenuItem
          icon={<PictureInPicture size={11} />}
          label="Show floating"
          hint="Float the app over the chat and close the tools pane"
          disabled={!hasActiveSession}
          disabledReason="Launch or attach an app first."
          onSelect={() => {
            showFloating();
            close();
          }}
        />
      ) : null}
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
          setCaptionDraft(null);
          setConfirmStop(true);
          close();
        }}
      />

      {/* How ADE drives the app. Read once per session; a driver that is
          not available here says why in its tooltip. */}
      <AppControlMenuLabel>Driver</AppControlMenuLabel>
      {(drivers?.drivers ?? []).length === 0 ? (
        <div className="px-2 pb-1.5 text-[10.5px] text-muted-fg/65">
          {APP_CONTROL_DRIVER_LABEL[activeDriver]}
        </div>
      ) : (
        (drivers?.drivers ?? []).map((row) => (
          <AppControlMenuItem
            key={row.driver}
            label={APP_CONTROL_DRIVER_LABEL[row.driver]}
            checked={row.driver === activeDriver}
            disabled={row.status !== "available"}
            disabledReason={row.reason}
            onSelect={close}
          />
        ))
      )}
    </>
  ), [
    activeDriver, activeSession, attachSelection, busy, canFloat, canSendToChat, canStop, controlsDisabled,
    drivers, focusWindow, hasActiveSession, minimizeWindow, observeMapOn, onAddAttachment, onAddContext,
    onShowTerminal, refreshSnapshot, runBusy, runObserve, screenshotToChat, selectedPoint, sessionConnected,
    showFloating, traceOpen,
  ]);

  /* The toolbar's own buttons, in the Mac Desktop row's order. */
  const chromeActions = hasActiveSession ? (
    <>
      <WorkToolChromeButton
        label={recorder.running ? "Stop recording" : "Record this app"}
        onClick={toggleRecording}
        disabled={recorder.busy || controlsDisabled || (!sessionConnected && !recorder.running)}
        active={recorder.running || (captionDraft != null && captionFor === "record")}
        testId="app-control-record"
      >
        {recorder.running ? <Stop size={16} weight="fill" /> : <Record size={16} weight="fill" />}
      </WorkToolChromeButton>
      <WorkToolChromeButton
        label={recorder.proofBusy ? "Saving screenshot to proof…" : "Save screenshot to proof"}
        onClick={toggleProof}
        disabled={recorder.proofBusy || controlsDisabled || !sessionConnected}
        active={captionDraft != null && captionFor === "proof"}
        testId="app-control-proof"
      >
        <SealCheck size={16} />
      </WorkToolChromeButton>
      {onAddAttachment ? (
        <WorkToolChromeButton
          label={busy === "screenshot" ? "Attaching screenshot…" : "Screenshot to chat"}
          onClick={() => void screenshotToChat()}
          disabled={!sessionConnected || Boolean(busy)}
          className="@max-[340px]:hidden"
          testId="app-control-screenshot"
        >
          <Camera size={16} />
        </WorkToolChromeButton>
      ) : null}
      {/* Inspect exists to attach an element to a chat, so without one there
          is only Control, and no toggle. Esc leaves it. */}
      {onAddContext ? (
        <WorkToolChromeButton
          label={mode === "inspect" ? "Stop inspecting" : "Inspect"}
          shortcut={mode === "inspect" ? "Esc" : undefined}
          onClick={() => setMode((current) => (current === "inspect" ? "control" : "inspect"))}
          disabled={controlsDisabled}
          active={mode === "inspect"}
          testId="app-control-inspect"
        >
          <Crosshair size={16} />
        </WorkToolChromeButton>
      ) : null}
      <WorkToolChromeButton
        label={appControlStopQuitsApp(activeSession) ? "Stop app" : "Detach from app"}
        onClick={() => {
          setCaptionDraft(null);
          setConfirmStop((current) => !current);
        }}
        disabled={!canStop || busy === "stop"}
        active={confirmStop}
        testId="app-control-stop"
      >
        <Power size={16} />
      </WorkToolChromeButton>
    </>
  ) : null;

  const previewControls = <WorkToolPreviewControls tool="app-control" chatSessionId={sessionId} />;

  /* ── The body: one state at a time ─────────────────────────────────── */
  const renderBody = () => {
    if (!hasActiveSession && !showDisconnected && !hasFrame) {
      return (
        <div className="min-h-0 flex-1 p-2">
          <AppControlOffCard
            launchCommand={launchCommand}
            onLaunchCommandChange={setLaunchCommand}
            launchCwd={launchCwd}
            onLaunchCwdChange={setLaunchCwd}
            onLaunch={(command, cwd) => void launchSelected(command, cwd)}
            canLaunch={canLaunch}
            launching={busy === "launch"}
            cdpPort={cdpPort}
            onCdpPortChange={setCdpPort}
            onConnect={() => void connectPort()}
            connecting={busy === "connect"}
            recents={recents}
            onHelpWireCdp={onInsertDraft ? requestDebugHelp : null}
            controlsDisabled={controlsDisabled}
            laneName={laneName}
          />
        </div>
      );
    }
    if (launching && !hasFrame) {
      return (
        <div className="min-h-0 flex-1 p-2">
          <MacDesktopStateCard
            testId="app-control-starting"
            tone="busy"
            icon={Desktop}
            title={`Starting ${appName ?? "the app"}…`}
            detail={sessionStatus.detail}
            actions={canStop ? (
              <button type="button" className={MAC_DESKTOP_SECONDARY_BUTTON} onClick={() => setConfirmStop(true)}>
                <Power size={14} />
                Stop
              </button>
            ) : null}
          />
        </div>
      );
    }
    return (
      /*
        The same card the browser stage draws: inset 8px, 10px radius, a 1px
        inset ring over the muted surface. Every overlay (the URL chip, the
        observe badges, the agent cursor, the receipt) is a child of this
        frame, so all of them stay aligned to its inset edge.
      */
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col p-2">
        <div
          data-testid="app-control-stage"
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px]",
            "bg-[var(--color-surface)] ring-1 ring-inset ring-white/[0.08]",
          )}
        >
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
            <WorkToolEmptyLine title="Capture a snapshot to begin" />
          )}

          {recorder.receipt ? (
            <RecordingSavedRow
              marker={{ "data-testid": "app-control-saved-receipt" }}
              durationMs={recorder.receipt.durationMs}
              bytes={recorder.receipt.bytes}
              onOpen={() => recorder.receipt && recorder.openReceipt(recorder.receipt)}
              onDismiss={recorder.clearReceipt}
            />
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col font-sans text-[11px] text-fg/75" data-testid="app-control-panel">
      {hasActiveSession ? (
        <AppControlToolbar
          appLabel={activeSession ? appName ?? "App" : "Pick an app"}
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
          actions={chromeActions}
          previewControls={previewControls}
        />
      ) : (
        /* No app: the slim row every idle tool keeps, with the per-chat
           floating-preview toggle, as the Mac Desktop pane's Off state does. */
        <div className={cn(WORK_TOOL_CHROME_ROW, "flex-nowrap justify-end gap-1")} data-testid="app-control-idle-row">
          {remoteLabel ? (
            <span
              className="mr-auto inline-flex h-5 shrink-0 items-center rounded-full bg-white/[0.06] px-2 text-[10px] font-medium text-fg/70"
              title={`App Control runs on ${remoteLabel}`}
            >
              remote: {remoteLabel}
            </span>
          ) : null}
          {previewControls}
        </div>
      )}

      <AppControlStatusStrip message={stripMessage} />

      {confirmStop && hasActiveSession ? (
        <AppControlStopConfirm
          session={activeSession}
          busy={busy === "stop"}
          onKeep={() => setConfirmStop(false)}
          onStop={() => void stopSession()}
        />
      ) : null}

      {captionDraft != null && hasActiveSession ? (
        <form
          role="dialog"
          aria-label={captionFor === "proof" ? "Save screenshot to proof" : "Record this app"}
          data-testid="app-control-caption-prompt"
          className="mx-2 mt-1.5 flex min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 font-sans text-[12px] text-fg"
          onSubmit={(event) => {
            event.preventDefault();
            submitCaption();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setCaptionDraft(null);
          }}
        >
          <label className="flex min-w-0 flex-1 basis-[180px] flex-col gap-1">
            <span className="text-muted-fg">
              {captionFor === "proof" ? "Caption. It files the screenshot as proof." : "Caption. It files the video as proof."}
            </span>
            <input
              autoFocus
              value={captionDraft}
              onChange={(event) => setCaptionDraft(event.target.value)}
              aria-label={captionFor === "proof" ? "Proof caption" : "Recording caption"}
              className="h-7 min-w-0 rounded-[7px] border border-border/70 bg-[color-mix(in_srgb,var(--color-bg)_55%,transparent)] px-2 text-[12px] text-fg outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
            />
          </label>
          <div className="flex shrink-0 items-center gap-2 self-end">
            <button type="button" className={cn(MAC_DESKTOP_SECONDARY_BUTTON, "h-7")} onClick={() => setCaptionDraft(null)}>
              Cancel
            </button>
            {captionFor === "proof" ? (
              <button
                type="submit"
                data-testid="app-control-proof-save"
                disabled={recorder.proofBusy}
                className={cn(MAC_DESKTOP_SECONDARY_BUTTON, "h-7")}
              >
                <SealCheck size={12} />
                Save to proof
              </button>
            ) : (
              <button
                type="submit"
                data-testid="app-control-record-start"
                disabled={recorder.busy}
                className={cn(
                  MAC_DESKTOP_SECONDARY_BUTTON,
                  "h-7 border-[color-mix(in_srgb,var(--color-error)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_14%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-error)_22%,transparent)]",
                )}
              >
                <Record size={12} weight="fill" className="text-[var(--color-error)]" />
                Record
              </button>
            )}
          </div>
        </form>
      ) : null}

      {recorder.missingPermissions.length > 0 && recorder.permissions ? (
        <div className="mx-2 mt-1.5 shrink-0">
          <MacDesktopPermissionCard
            variant="inline"
            productName="App Control"
            purposes={{ screenRecording: "Records the app's window. Driving the app does not need it." }}
            permissions={{ screenRecording: recorder.permissions.screenRecording, accessibility: "granted" }}
            appName="ADE"
            signing="unknown"
            hostIsLocal={recorder.hostIsLocal}
            machineName={remoteLabel}
            checking={recorder.checkingPermissions}
            lastCheck={recorder.permissionCheck}
            onOpenSettings={recorder.openSettings}
            onCheckAgain={() => void recorder.checkPermissionsAgain()}
          />
        </div>
      ) : null}

      {renderBody()}

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

      {/* The action ledger belongs to a session; the Off card has none. */}
      {hasActiveSession || traceEntries.length > 0 ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}

