import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { ArrowClockwise, ArrowsClockwise, ArrowSquareOut, ArrowsInSimple, ArrowsOutSimple, BracketsCurly, CaretDown, CheckCircle, CursorClick, DeviceMobile, FileCode, ImageSquare, Lightning, MagnifyingGlassMinus, MagnifyingGlassPlus, Play, Power, Selection, SlidersHorizontal, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import type {
  AgentChatFileRef,
  IosElementContextItem,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosSimulatorRenderPreviewResult,
  IosScreenElement,
  IosScreenSnapshot,
  IosSimulatorDevice,
  IosSimulatorLaunchProgress,
  IosSimulatorLaunchTarget,
  IosSimulatorDrawerMode,
  IosSimulatorStatus,
  OpenProjectBinding,
} from "../../../shared/types";
import { IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE, inferAttachmentType } from "../../../shared/types";
import { cn } from "../ui/cn";
import { IosSimH264Video } from "./IosSimH264Video";
import { IosSimToolsColumn } from "./IosSimToolsColumn";
import { IosSimWatchRibbon } from "./IosSimWatchRibbon";
import { PaneTooltip } from "../ui/PaneTooltip";
import {
  WORK_TOOL_CHROME_CHIP,
  WORK_TOOL_CHROME_CHIP_WRAP,
  WORK_TOOL_CHROME_META,
  WORK_TOOL_CHROME_ROW,
  WORK_TOOL_PRIMARY_BUTTON,
  WorkToolChromeButton,
} from "../terminals/workToolChrome";
import { useChatRuntimeScopeForPin } from "./ChatRuntimeScope";
import { useIosSimBuildDuration } from "./useIosSimBuildDuration";
import { useIosSimDeviceTools } from "./useIosSimDeviceTools";
import { useIosSimLiveView } from "./useIosSimLiveView";
import { buildIosSimToolChips, IosSimToolChips, IosSimUnsupportedCard } from "./IosSimToolChips";
import { IosSimLaunchStepper, selectLaunchSteps } from "./IosSimLaunchStepper";
import { IosSimOwnershipCard } from "./IosSimOwnershipCard";
import { IosSimVideoOverlay } from "./IosSimVideoOverlay";
import {
  EMPTY_LAUNCH_EXTRAS,
  formatAge,
  readLaunchExtras,
  type IosSimLaunchExtras,
} from "./iosSimContracts";
import { abbreviatePathTail } from "../../../shared/pathDisplay";
import { normalizePathForComparison } from "../../lib/pathUtils";

const XCODE_MCP_DOCS_URL = "https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode";

/**
 * String-level only — never touches the filesystem, because this runs in the
 * renderer and only decides whether to show a chip.
 *
 * Normalizes first, then drops a leading `/private`: macOS firmlinks mean the
 * same directory is spelled `/var/folders/...` by one resolver and
 * `/private/var/folders/...` by another, and reporting that as "built somewhere
 * else" would be a false alarm on every temp-dir build. Stripping before
 * normalizing instead turned `/private//var/x` into `//var/x`, which reads as a
 * UNC root and is returned verbatim, so it never matched `/var/x`. Everything
 * else — separators, trailing slashes, `.`/`..` segments, and Windows
 * drive-letter casing — is the canonical comparison normalizer's job rather
 * than a second, case-sensitive spelling of it here.
 */
function normalizeRootForCompare(value: string): string {
  return normalizePathForComparison(value.trim()).replace(/^\/private(?=\/)/u, "");
}

function isOwnedByOtherSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code === IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE) return true;
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && name === "IosSimulatorOwnedBySessionError") return true;
  const message = error instanceof Error ? error.message : null;
  return Boolean(message?.startsWith(`${IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE}:`));
}

type SimulatorMode = "interact" | "inspect" | "preview";
type SimulatorSurface = "simulator" | "preview";
type PreviewMode = "control" | "capture";
type PreviewAgentHelpAction = "open-simulator-in-preview" | "add-realistic-mocks" | "fix-preview";
type PreviewBridgeAction = "open" | "create" | "find";
type PreviewAgentPromptContext = {
  selectedElement?: IosScreenElement | null;
  previewTarget?: IosSimulatorPreviewTarget | null;
  previewMatch?: IosSimulatorPreviewMatch | null;
  previewResult?: IosSimulatorRenderPreviewResult | null;
  includePreviewAttachment?: boolean;
};

const PREVIEW_AGENT_HELP_OPTIONS: Array<{
  value: PreviewAgentHelpAction;
  label: string;
  description: string;
}> = [
  {
    value: "open-simulator-in-preview",
    label: "Open simulator screen in preview",
    description: "Drafts a request to find the current simulator screen, ensure a #Preview exists, and render it through ADE CLI.",
  },
  {
    value: "add-realistic-mocks",
    label: "Add realistic mock data",
    description: "Drafts a request to fill the preview with fixture data based on the real screen.",
  },
  {
    value: "fix-preview",
    label: "Fix selected preview",
    description: "Drafts a request to repair the selected preview target or its setup.",
  },
];

type ChatIosSimulatorPanelProps = {
  sessionId: string | null;
  laneId?: string | null;
  projectRoot: string | null;
  controlDisabledReason?: string | null;
  ignoreChatOwnership?: boolean;
  onAddContext?: (item: IosElementContextItem) => void;
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
  onInsertDraft?: (text: string) => void;
  drawerModeRequest?: { mode: IosSimulatorDrawerMode; nonce: number } | null;
  runtimePin?: OpenProjectBinding | null;
};

type RenderedMediaBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
};

type DragStart = {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
};

type PreviewCrop = {
  dataUrl: string;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type PreviewCaptureSelection = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  bounds: RenderedMediaBounds;
};

const MEDIA_ZOOM_MIN = 1;
const MEDIA_ZOOM_MAX = 2;
const MEDIA_ZOOM_STEP = 0.25;

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

function shortChatId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(0, 4) + "…" + id.slice(-3);
}

function deviceLabel(device: IosSimulatorDevice | null | undefined): string {
  if (!device) return "No simulator";
  return `${device.name} - ${device.runtime} - ${device.state}`;
}

function targetLabel(target: IosSimulatorLaunchTarget | null | undefined): string {
  if (!target) return "Choose app";
  return `${target.name}${target.bundleId ? ` - ${target.bundleId}` : ""}`;
}

function elementLabel(element: IosScreenElement | null): string {
  if (!element) return "Coordinate fallback";
  return element.label || element.identifier || element.value || element.componentId || element.elementType || element.role || element.id;
}

function normalizeSwiftSourcePath(value: string | null | undefined): string | null {
  const raw = value?.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw) return null;
  return raw.replace(/^(?:.*\/)?apps\/ios\//u, "");
}

function swiftSourcePathsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeSwiftSourcePath(left);
  const normalizedRight = normalizeSwiftSourcePath(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (!normalizedLeft.includes("/") || !normalizedRight.includes("/")) {
    return normalizedLeft.split("/").pop() === normalizedRight.split("/").pop();
  }
  return normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function previewMatchBelongsToElement(match: IosSimulatorPreviewMatch | null, element: IosScreenElement | null): boolean {
  if (!match || !element) return false;
  if (element.sourceFile) {
    if (!match.selectedSourceFile || !swiftSourcePathsMatch(match.selectedSourceFile, element.sourceFile)) return false;
  } else if (match.selectedSourceFile) {
    return false;
  }
  if (element.sourceLine && match.selectedSourceLine && Math.abs(match.selectedSourceLine - element.sourceLine) > 3) return false;
  return true;
}

function previewBridgeActionForSelection(
  match: IosSimulatorPreviewMatch | null,
  element: IosScreenElement | null,
): PreviewBridgeAction {
  if (!element && match?.status === "matched" && match.target) return "open";
  if (!element) return "create";
  if (!previewMatchBelongsToElement(match, element)) return "find";
  if (match?.status === "matched" && match.target) return "open";
  if (match?.status === "missing-preview" || match?.status === "missing-source" || match?.status === "no-context") return "create";
  return "find";
}

function previewBridgeLabel(action: PreviewBridgeAction): string {
  if (action === "open") return "Open in preview";
  if (action === "create") return "Create preview";
  return "Find preview";
}

function previewBridgeTitle(action: PreviewBridgeAction, element: IosScreenElement | null): string {
  if (action === "open") return "Render the matching Preview Lab target for this frozen simulator selection";
  if (action === "create") {
    return element
      ? "Draft an agent task to create a Preview Lab target for this frozen simulator selection"
      : "Draft an agent task to create a Preview Lab target for the current simulator screen";
  }
  return "Find a Preview Lab target for this frozen simulator selection";
}

function previewBridgeTone(action: PreviewBridgeAction): string {
  if (action === "open") return "border-violet-300/22 bg-black/60 text-violet-50/85 hover:bg-black/72";
  if (action === "create") return "border-amber-300/24 bg-black/60 text-amber-50/88 hover:bg-black/72";
  return "border-white/[0.10] bg-black/60 text-fg/80 hover:bg-black/72";
}

function previewTargetLabel(target: IosSimulatorPreviewTarget | null | undefined): string {
  if (!target) return "No preview";
  const file = target.sourceFile.split(/[\\/]/).pop() ?? target.sourceFile;
  return `${target.title} - ${file}`;
}

function previewLaunchEnvironment(target: IosSimulatorPreviewTarget): Record<string, string> {
  return {
    ADE_PREVIEW_TARGET_ID: target.id,
    ADE_PREVIEW_TITLE: target.title,
    ADE_PREVIEW_SOURCE_FILE: target.sourceFilePath,
    ADE_PREVIEW_ABSOLUTE_SOURCE_FILE: target.absoluteSourceFile,
    ADE_PREVIEW_SOURCE_LINE: String(target.sourceLine),
    ADE_PREVIEW_DEFINITION_INDEX: String(target.previewDefinitionIndexInFile),
    ADE_PREVIEW_KIND: target.kind,
  };
}

function previewStatusLabel(capability: IosSimulatorPreviewCapability | null, targets: IosSimulatorPreviewTarget[]): string {
  if (!capability) return "Checking Xcode previews...";
  if (!capability.mcpbridgeAvailable) return "Xcode MCP unavailable";
  if (!capability.xcodeRunning) return "Open Xcode to render previews";
  if (capability.error) return "Xcode MCP needs attention";
  if (!capability.selectedWindow) return "Open the iOS project in Xcode";
  if (!targets.length) return "No #Preview found yet";
  return "Preview Lab ready";
}

function previewMatchLabel(match: IosSimulatorPreviewMatch | null): string {
  if (!match) return "Match not checked";
  if (match.status === "matched") {
    if (match.confidence === "exact") return "Matched selected file";
    if (match.confidence === "nearby") return "Matched nearby preview";
    return "Project fallback";
  }
  if (match.status === "missing-preview") return "Preview needed";
  if (match.status === "missing-source") return "Source missing";
  return "Select simulator source";
}

function previewMatchTone(match: IosSimulatorPreviewMatch | null): string {
  if (!match) return "border-white/[0.08] bg-white/[0.03] text-muted-fg/60";
  if (match.status === "matched" && match.confidence !== "fallback") return "border-emerald-300/20 bg-emerald-400/10 text-emerald-50/82";
  if (match.status === "matched") return "border-amber-300/20 bg-amber-400/10 text-amber-50/82";
  if (match.status === "missing-preview") return "border-amber-300/20 bg-amber-400/10 text-amber-50/82";
  return "border-white/[0.08] bg-white/[0.03] text-muted-fg/60";
}

function isLaunchTargetErrorMessage(message: string | null): boolean {
  if (!message) return false;
  return message.includes("ade.iosSimulator.listLaunchTargets") || /Project root .* does not exist/u.test(message);
}

function frameArea(element: IosScreenElement): number {
  return Math.max(1, element.pixelFrame.width) * Math.max(1, element.pixelFrame.height);
}

function rectIntersectionArea(a: IosScreenElement["pixelFrame"], b: IosScreenElement["pixelFrame"]): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function containsPoint(element: IosScreenElement, x: number, y: number): boolean {
  const frame = element.pixelFrame;
  return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
}

function hasSelectableIdentity(element: IosScreenElement): boolean {
  return Boolean(element.sourceFile || element.componentId || element.identifier || element.label || element.value);
}

function bestElementAt(elements: IosScreenElement[], x: number, y: number): IosScreenElement | null {
  const hits = elements.filter((element) => containsPoint(element, x, y));
  const byArea = (a: IosScreenElement, b: IosScreenElement) => frameArea(a) - frameArea(b);
  const describedHits = hits.filter(hasSelectableIdentity);
  return describedHits.filter((element) => element.source === "ade-inspector").sort(byArea)[0]
    ?? describedHits.sort(byArea)[0]
    ?? hits.sort(byArea)[0]
    ?? null;
}

function nextLargerElementAt(
  elements: IosScreenElement[],
  x: number,
  y: number,
  currentArea: number,
): IosScreenElement | null {
  const hits = elements.filter((element) => containsPoint(element, x, y) && frameArea(element) > currentArea);
  const byArea = (a: IosScreenElement, b: IosScreenElement) => frameArea(a) - frameArea(b);
  const describedHits = hits.filter(hasSelectableIdentity);
  return describedHits.filter((element) => element.source === "ade-inspector").sort(byArea)[0]
    ?? describedHits.sort(byArea)[0]
    ?? hits.sort(byArea)[0]
    ?? null;
}

function clampFrame(
  frame: IosScreenElement["pixelFrame"],
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(width, frame.x));
  const y = Math.max(0, Math.min(height, frame.y));
  const maxWidth = Math.max(1, width - x);
  const maxHeight = Math.max(1, height - y);
  return {
    x,
    y,
    width: Math.max(1, Math.min(maxWidth, frame.width)),
    height: Math.max(1, Math.min(maxHeight, frame.height)),
  };
}

function compactElementForContext(element: IosScreenElement): Record<string, unknown> {
  return {
    id: element.id,
    source: element.source,
    label: element.label,
    value: element.value,
    role: element.role,
    elementType: element.elementType,
    identifier: element.identifier,
    componentId: element.componentId,
    sourceFile: element.sourceFile,
    sourceLine: element.sourceLine,
    screenshotFrame: element.pixelFrame,
  };
}

function screenContextForSnapshot(snapshot: IosScreenSnapshot): Record<string, unknown> {
  return {
    deviceUdid: snapshot.deviceUdid,
    capturedAt: snapshot.capturedAt,
    screenWidth: snapshot.screen.width,
    screenHeight: snapshot.screen.height,
    screenScale: snapshot.screen.scale,
    screenshotWidth: snapshot.screenshot.width,
    screenshotHeight: snapshot.screenshot.height,
  };
}

function measureObjectContain(
  element: HTMLElement,
  intrinsicWidth: number,
  intrinsicHeight: number,
): RenderedMediaBounds | null {
  const rect = element.getBoundingClientRect();
  if (intrinsicWidth <= 0 || intrinsicHeight <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / intrinsicWidth, rect.height / intrinsicHeight);
  const width = intrinsicWidth * scale;
  const height = intrinsicHeight * scale;
  const parentRect = element.parentElement?.getBoundingClientRect() ?? rect;
  return {
    left: rect.left + ((rect.width - width) / 2) - parentRect.left,
    top: rect.top + ((rect.height - height) / 2) - parentRect.top,
    width,
    height,
    scaleX: width / intrinsicWidth,
    scaleY: height / intrinsicHeight,
  };
}

function pointerToMediaPoint(
  event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>,
  element: HTMLElement,
  intrinsicWidth: number,
  intrinsicHeight: number,
): { x: number; y: number; bounds: RenderedMediaBounds } | null {
  const bounds = measureObjectContain(element, intrinsicWidth, intrinsicHeight);
  if (!bounds) return null;
  const parentRect = element.parentElement?.getBoundingClientRect() ?? element.getBoundingClientRect();
  const localX = event.clientX - parentRect.left - bounds.left;
  const localY = event.clientY - parentRect.top - bounds.top;
  if (localX < 0 || localY < 0 || localX > bounds.width || localY > bounds.height) return null;
  return {
    x: localX / bounds.scaleX,
    y: localY / bounds.scaleY,
    bounds,
  };
}

function pointerToClampedMediaPoint(
  event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>,
  element: HTMLElement,
  intrinsicWidth: number,
  intrinsicHeight: number,
): { x: number; y: number; bounds: RenderedMediaBounds } | null {
  const bounds = measureObjectContain(element, intrinsicWidth, intrinsicHeight);
  if (!bounds) return null;
  const parentRect = element.parentElement?.getBoundingClientRect() ?? element.getBoundingClientRect();
  const localX = Math.max(0, Math.min(bounds.width, event.clientX - parentRect.left - bounds.left));
  const localY = Math.max(0, Math.min(bounds.height, event.clientY - parentRect.top - bounds.top));
  return {
    x: localX / bounds.scaleX,
    y: localY / bounds.scaleY,
    bounds,
  };
}

function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function cropElementDataUrl(snapshot: IosScreenSnapshot, element: IosScreenElement): Promise<string | null> {
  const screenshotWidth = snapshot.screenshot.width ?? snapshot.screen.width;
  const screenshotHeight = snapshot.screenshot.height ?? snapshot.screen.height;
  if (!screenshotWidth || !screenshotHeight) return null;
  const frame = clampFrame(element.pixelFrame, screenshotWidth, screenshotHeight);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(frame.width));
      canvas.height = Math.max(1, Math.round(frame.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(
        img,
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(null);
    img.src = snapshot.screenshot.dataUrl;
  });
}

function previewCaptureFrame(
  selection: PreviewCaptureSelection,
  previewWidth: number,
  previewHeight: number,
): PreviewCrop["frame"] {
  const rawX = Math.min(selection.startX, selection.currentX);
  const rawY = Math.min(selection.startY, selection.currentY);
  const rawWidth = Math.abs(selection.currentX - selection.startX);
  const rawHeight = Math.abs(selection.currentY - selection.startY);
  const x = Math.max(0, Math.min(previewWidth, Math.round(rawX)));
  const y = Math.max(0, Math.min(previewHeight, Math.round(rawY)));
  return {
    x,
    y,
    width: Math.max(0, Math.min(previewWidth - x, Math.round(rawWidth))),
    height: Math.max(0, Math.min(previewHeight - y, Math.round(rawHeight))),
  };
}

async function cropPreviewAreaDataUrl(
  dataUrl: string,
  previewWidth: number,
  previewHeight: number,
  frame: PreviewCrop["frame"],
): Promise<PreviewCrop | null> {
  if (!previewWidth || !previewHeight) return null;
  const cropWidth = Math.max(1, Math.min(previewWidth, Math.round(frame.width)));
  const cropHeight = Math.max(1, Math.min(previewHeight, Math.round(frame.height)));
  const x = Math.max(0, Math.min(previewWidth - cropWidth, Math.round(frame.x)));
  const y = Math.max(0, Math.min(previewHeight - cropHeight, Math.round(frame.y)));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = cropWidth;
      canvas.height = cropHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, x, y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      resolve({
        dataUrl: canvas.toDataURL("image/png"),
        frame: { x, y, width: cropWidth, height: cropHeight },
      });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export function ChatIosSimulatorPanel({
  sessionId,
  laneId = null,
  projectRoot,
  controlDisabledReason = null,
  ignoreChatOwnership = false,
  onAddContext,
  onAddAttachment,
  onInsertDraft,
  drawerModeRequest,
  runtimePin = null,
}: ChatIosSimulatorPanelProps) {
  // Every `iosSimulator.*` call below drives the machine this chat lives on.
  // Read through a ref, never a dep: a local pin object is rebuilt on each
  // cross-machine merge (~10s), and depending on its identity would restart the
  // live stream on that timer. The panel is keyed on the pin at its render
  // sites, so a machine change remounts instead.
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
  const chatScope = useChatRuntimeScopeForPin(runtimePin, laneId);
  const [status, setStatus] = useState<IosSimulatorStatus | null>(null);
  const [devices, setDevices] = useState<IosSimulatorDevice[]>([]);
  const [launchTargets, setLaunchTargets] = useState<IosSimulatorLaunchTarget[]>([]);
  const [selectedDeviceUdid, setSelectedDeviceUdid] = useState<string | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [mode, setMode] = useState<SimulatorMode>("interact");
  const [lastSimulatorMode, setLastSimulatorMode] = useState<Exclude<SimulatorMode, "preview">>("interact");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("control");
  const [snapshot, setSnapshot] = useState<IosScreenSnapshot | null>(null);
  const [previewCapability, setPreviewCapability] = useState<IosSimulatorPreviewCapability | null>(null);
  const [previewTargets, setPreviewTargets] = useState<IosSimulatorPreviewTarget[]>([]);
  const [previewMatch, setPreviewMatch] = useState<IosSimulatorPreviewMatch | null>(null);
  const [selectedPreviewTargetId, setSelectedPreviewTargetId] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<IosSimulatorRenderPreviewResult | null>(null);
  const [previewAgentHelpAction, setPreviewAgentHelpAction] = useState<PreviewAgentHelpAction>("open-simulator-in-preview");
  const [previewCaptureSelection, setPreviewCaptureSelection] = useState<PreviewCaptureSelection | null>(null);
  const [simulatorCaptureActive, setSimulatorCaptureActive] = useState(false);
  const [simulatorCaptureSelection, setSimulatorCaptureSelection] = useState<PreviewCaptureSelection | null>(null);
  /**
   * Device hub state.
   *
   * The tools column and the event log are opt-in: reading device settings
   * costs nine `simctl` calls and the log costs a process, so neither runs
   * until the human opens the column.
   */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [launchProgress, setLaunchProgress] = useState<IosSimulatorLaunchProgress[]>([]);
  /** The launch whose stepper the user closed. Nothing else can dismiss a failure. */
  const [dismissedLaunchId, setDismissedLaunchId] = useState<string | null>(null);
  // Extras describe *one* binary, so they are stored with the session they came
  // from. Untagged, a launch this panel ran kept accusing every session after
  // it: the "prebuilt" chip survived a rebuild, both header chips survived Stop,
  // and a new launch fell through to the previous session's extras.
  const [panelLaunchExtras, setPanelLaunchExtras] = useState<{
    sessionId: string | null;
    extras: IosSimLaunchExtras;
  }>({ sessionId: null, extras: EMPTY_LAUNCH_EXTRAS });
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [hoveredElement, setHoveredElement] = useState<IosScreenElement | null>(null);
  const [selectedElement, setSelectedElement] = useState<IosScreenElement | null>(null);
  const [bounds, setBounds] = useState<RenderedMediaBounds | null>(null);
  const [busy, setBusy] = useState(false);
  const [launchBusy, setLaunchBusy] = useState(false);
  const [snapshotRefreshing, setSnapshotRefreshing] = useState(false);
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [typedText, setTypedText] = useState("");
  const [mediaExpanded, setMediaExpanded] = useState(false);
  const [mediaZoom, setMediaZoom] = useState(MEDIA_ZOOM_MIN);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const suppressNextSelectionEventRef = useRef(false);
  const dragStartRef = useRef<DragStart | null>(null);
  const snapshotRefreshInFlightRef = useRef(false);
  const snapshotRefreshSequenceRef = useRef(0);

  const activeDevice = useMemo(() => {
    if (selectedDeviceUdid) return devices.find((device) => device.udid === selectedDeviceUdid) ?? null;
    return status?.activeDevice ?? devices[0] ?? null;
  }, [devices, selectedDeviceUdid, status?.activeDevice]);
  const activeSession = status?.activeSession ?? null;
  /**
   * A booted simulator this chat opened with no app of its own.
   *
   * The live view keys off a session, and a device session is a session for
   * that purpose: there is a booted device to watch. Without this, "Open
   * <device> without an app" claimed the device and then showed the same empty
   * state it started from.
   */
  const deviceSession = status?.deviceSession ?? null;
  /**
   * Whether a booted device stands behind the drawer at all.
   *
   * Declared here, beside the two sessions it reads, because everything that
   * needs a device — the live view, the screen snapshot, the recovery restart —
   * needs exactly this and not an app session. Asking for `activeSession`
   * instead is what left "Open <device> without an app" with an unscaled tap.
   */
  const hasActiveSession = Boolean(activeSession || deviceSession);
  /** The device those sessions name, whichever kind of session it is. */
  const activeSessionDeviceUdid = activeSession?.deviceUdid ?? deviceSession?.deviceUdid ?? null;
  const activeDeviceUdid = activeDevice?.udid ?? null;
  const activeDeviceName = activeDevice?.name ?? null;
  // A device session has no session id of its own, so its device udid stands in
  // as the identity the live-view effect restarts on.
  const activeSessionId = activeSession?.id ?? (deviceSession ? `device:${deviceSession.deviceUdid}` : null);
  const statusSupported = status?.supported ?? null;
  /**
   * Which tree every scoped iOS Simulator call means.
   *
   * An explicit `projectRoot` beats `laneId` service-side, so sending both is
   * not belt-and-braces — it silently discards the lane. The pane's own
   * `projectRoot` is resolved from the lane list and can trail a lane that was
   * just created or moved, and the resulting build lands in the primary
   * checkout while the drawer reports success. When a lane is scoped, name only
   * the lane: the service resolves its worktree and fails loudly if it cannot.
   */
  const rootScope = useMemo(
    (): { laneId: string } | { projectRoot: string | null } => (laneId ? { laneId } : { projectRoot }),
    [laneId, projectRoot],
  );
  const refreshSnapshot = useCallback(async (options: { silent?: boolean; priority?: boolean } = {}) => {
    const deviceUdid = selectedDeviceUdid ?? activeDevice?.udid ?? undefined;
    if (snapshotRefreshInFlightRef.current && options.silent && !options.priority) return;
    const sequence = snapshotRefreshSequenceRef.current + 1;
    snapshotRefreshSequenceRef.current = sequence;
    snapshotRefreshInFlightRef.current = true;
    if (!options.silent) setBusy(true);
    setSnapshotRefreshing(true);
    try {
      const next = await window.ade.iosSimulator.getScreenSnapshot({ deviceUdid, ...rootScope }, runtimePinRef.current);
      if (sequence !== snapshotRefreshSequenceRef.current) return;
      setSnapshot(next);
      setHoveredElement(null);
      setSelectedElement(next.hitElement);
      if (!options.silent) setMessage(`Snapshot captured with ${next.elements.length} selectable elements.`);
    } catch (error) {
      if (sequence === snapshotRefreshSequenceRef.current && !options.silent) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (sequence === snapshotRefreshSequenceRef.current) {
        snapshotRefreshInFlightRef.current = false;
        setSnapshotRefreshing(false);
        if (!options.silent) setBusy(false);
      }
    }
  }, [activeDevice?.udid, rootScope, selectedDeviceUdid]);

  const controlsDisabled = Boolean(controlDisabledReason);
  const controlsDisabledMessage = controlDisabledReason ?? "Read-only from this lane.";

  const visibleLaunchTargets = useMemo(() => {
    const projectTargets = launchTargets.filter((target) => target.kind === "project");
    return projectTargets.length ? projectTargets : launchTargets;
  }, [launchTargets]);

  const activeTarget = useMemo(() => (
    visibleLaunchTargets.find((target) => target.id === selectedTargetId) ?? visibleLaunchTargets[0] ?? null
  ), [selectedTargetId, visibleLaunchTargets]);

  const selectedPreviewTarget = useMemo(() => (
    previewTargets.find((target) => target.id === selectedPreviewTargetId) ?? previewTargets[0] ?? null
  ), [previewTargets, selectedPreviewTargetId]);
  const activeSurface: SimulatorSurface = mode === "preview" ? "preview" : "simulator";
  const previewCaptureActive = activeSurface === "preview" && previewMode === "capture";
  const previewAgentHelpOption = PREVIEW_AGENT_HELP_OPTIONS.find((option) => option.value === previewAgentHelpAction)
    ?? PREVIEW_AGENT_HELP_OPTIONS[0]!;

  const snapshotImage = snapshot?.screenshot.dataUrl
    ? {
        dataUrl: snapshot.screenshot.dataUrl,
        width: snapshot.screenshot.width,
        height: snapshot.screenshot.height,
        alt: "iOS Simulator snapshot",
      }
    : null;
  const previewImage = useMemo(() => (
    previewResult?.dataUrl
      ? {
        dataUrl: previewResult.dataUrl,
        width: previewResult.width,
        height: previewResult.height,
        alt: "Xcode preview snapshot",
      }
      : null
  ), [previewResult?.dataUrl, previewResult?.height, previewResult?.width]);
  const mediaZoomStyle: CSSProperties | undefined = mediaZoom > MEDIA_ZOOM_MIN
    ? {
        width: `${Math.round(mediaZoom * 100)}%`,
        height: `${Math.round(mediaZoom * 100)}%`,
      }
    : undefined;
  const mediaZoomLabel = `${Math.round(mediaZoom * 100)}%`;

  // The chip builder is the single place tool status becomes a verdict, so the
  // panel reads its answers rather than re-deriving them from the tool matrix.
  const toolChips = useMemo(() => buildIosSimToolChips(status, devices), [devices, status]);
  const toolChipsHealthy = toolChips.every((chip) => chip.state === "ok");
  // idb + idb_companion, collapsed into the Controls chip: tap/type/drag need
  // both, and "ok" is exactly that conjunction.
  const controlAvailable = toolChips.some((chip) => chip.key === "controls" && chip.state === "ok");
  // A missing chip is the whole story: off macOS the macOS chip is missing, and
  // every way a mac can be unsupported (no xcrun/xcodebuild, no Simulator.app)
  // shows up as a missing Xcode or Runtime chip. So "unsupported platform" and
  // "incomplete setup" were always the same verdict rendered twice. Guarded on
  // `status` because the chips read missing until the first status lands, and a
  // loading drawer must not accuse the machine of anything.
  const setupBlocked = Boolean(status) && toolChips.some((chip) => chip.state === "missing");
  const previewSetupSteps = previewCapability?.setupSteps ?? [];
  const previewIssue = useMemo(() => {
    if (!previewCapability) {
      return {
        title: "Checking Xcode preview support",
        detail: "ADE is checking for Xcode, the Xcode MCP bridge, and a matching open iOS project window.",
      };
    }
    if (!previewCapability.mcpbridgeAvailable) {
      return {
        title: "Xcode MCP bridge is not available",
        detail: "Install or select Xcode 26.3 or newer so `xcrun mcpbridge` is available on this computer.",
      };
    }
    if (!previewCapability.xcodeRunning) {
      return {
        title: "Open the iOS project in Xcode",
        detail: "Preview rendering does not need the simulator, but it does need Xcode running with this lane's iOS project open.",
      };
    }
    if (previewCapability.error) {
      return {
        title: "Waiting for Xcode approval",
        detail: `${previewCapability.error} The first connection can take a bit because Xcode needs an explicit Allow click. After approving, press Retry and leave ADE open until the check finishes.`,
      };
    }
    if (!previewCapability.selectedWindow) {
      return {
        title: "Open this lane's iOS project window",
        detail: "Open apps/ios/ADE.xcodeproj in Xcode. If it is already open, bring that Xcode window forward and press Retry.",
      };
    }
    if (!previewTargets.length) {
      return {
        title: "No #Preview tag found",
        detail: previewMatch?.suggestedSourceFile
          ? `The preview lab is connected to Xcode, but it could not find a nearby #Preview. ADE can ask the active agent to add one in ${previewMatch.suggestedSourceFile}.`
          : "The preview lab is connected to Xcode, but it could not find a nearby #Preview or PreviewProvider.",
      };
    }
    return {
      title: "Ready to render Xcode previews",
      detail: "Choose a preview target, render it, then use Inspect to drag exact preview context into the active session.",
    };
  }, [previewCapability, previewMatch?.suggestedSourceFile, previewTargets.length]);
  const emptyStateFileLabel = useMemo(() => {
    if (!previewCapability?.supported || previewTargets.length) return null;
    return previewMatch?.selectedSourceFile ?? selectedElement?.sourceFile ?? null;
  }, [previewCapability?.supported, previewMatch?.selectedSourceFile, previewTargets.length, selectedElement?.sourceFile]);
  const previewReady = Boolean(previewCapability?.supported && selectedPreviewTarget);
  const previewTargetSource = selectedPreviewTarget
    ? `${selectedPreviewTarget.sourceFile}:${selectedPreviewTarget.sourceLine}`
    : null;
  const previewSuggestionReason = previewMatch?.reason
    ?? (selectedElement?.sourceFile
      ? `Matched from simulator selection: ${elementLabel(selectedElement)}`
      : selectedPreviewTarget
        ? "Selected preview target"
        : "No preview target selected");
  const inspectBridgeElement = selectedElement;
  const previewBridgeAction = previewBridgeActionForSelection(previewMatch, inspectBridgeElement);
  const previewBridgeButtonLabel = previewBridgeLabel(previewBridgeAction);
  const previewBridgeButtonTitle = previewBridgeTitle(previewBridgeAction, inspectBridgeElement);

  const otherChatSessionId = useMemo(() => {
    if (ignoreChatOwnership) return null;
    // An app session's owner wins, because it is the more specific claim. A
    // device session owner still blocks: a chat that opened a simulator owns
    // what happens to it just as much as a chat that launched an app into one.
    const owner = activeSession?.chatSessionId ?? deviceSession?.chatSessionId ?? null;
    if (!owner) return null;
    if (!sessionId) return owner;
    return owner !== sessionId ? owner : null;
  }, [activeSession?.chatSessionId, deviceSession?.chatSessionId, ignoreChatOwnership, sessionId]);
  const ownedByOtherChat = otherChatSessionId !== null;
  const contextControlsBlocked = controlsDisabled;
  const simulatorMutationBlocked = ownedByOtherChat || controlsDisabled;
  const inputBlockedMessage = ownedByOtherChat
    ? "Another chat owns the simulator."
    : controlsDisabledMessage;
  const simulatorControlUnavailable = mode === "interact" && !controlAvailable;
  const liveInputBlocked = simulatorMutationBlocked || simulatorControlUnavailable;
  const liveInputBlockedMessage = simulatorMutationBlocked
    ? inputBlockedMessage
    : "Simulator controls unavailable.";

  const changeMediaZoom = useCallback((delta: number) => {
    setMediaZoom((current) => {
      const next = Math.round((current + delta) / MEDIA_ZOOM_STEP) * MEDIA_ZOOM_STEP;
      return Math.max(MEDIA_ZOOM_MIN, Math.min(MEDIA_ZOOM_MAX, Number(next.toFixed(2))));
    });
  }, []);

  const resetMediaZoom = useCallback(() => {
    setMediaZoom(MEDIA_ZOOM_MIN);
  }, []);

  const launchRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!drawerModeRequest) return;
    setMode(drawerModeRequest.mode);
  }, [drawerModeRequest]);

  /* ------------------------------------------------------------------ *
   * Live view
   *
   * Both backends — the renderer's window capture and the host-encoded H.264
   * stream — live in `useIosSimLiveView`, together with the capture-cancel
   * token, the parking hold, the reconnect retry and the bezel calibration the
   * pointer mapping is measured against. The drawer keeps only what it shares
   * with Inspect and Preview Lab.
   *
   * Declared after `runtimePinRef.current = runtimePin` above, which is a
   * render-time assignment the hook's calls read through.
   * ------------------------------------------------------------------ */
  const {
    liveVisual,
    liveVisualKind,
    liveWidth,
    liveHeight,
    liveChip,
    liveBlocker,
    handleBlockerAction,
    h264ReconnectNonce,
    h264Canvas,
    setH264Canvas,
    handleH264Status,
    handleH264Dimensions,
    setVideoNode,
    videoRef,
    mapLivePointToSimulatorPixel,
    armWindowCaptureRecoveryAfterInput,
    syncExistingStreamStatus,
    handleStreamEvent,
  } = useIosSimLiveView({
    mode,
    activeDevice,
    activeDeviceUdid,
    activeDeviceName,
    activeSessionDeviceUdid,
    activeSessionId,
    statusSupported,
    hasActiveSession,
    snapshot,
    chatIsRemote: chatScope.isRemote,
    chatMachineName: chatScope.machineName,
    refreshSnapshot,
    runtimePinRef,
    launchRef,
    imageRef,
    onError: setMessage,
  });

  let mediaWidth: number;
  let mediaHeight: number;
  if (mode === "interact") {
    // Any live backend measures in its own frames: the window capture's video
    // and the host encoder's canvas both carry the intrinsic size the pointer
    // math needs. Only a still snapshot falls back to the screenshot's size.
    if (liveVisualKind !== null) {
      mediaWidth = liveWidth ?? snapshot?.screenshot.width ?? snapshot?.screen.width ?? 0;
      mediaHeight = liveHeight ?? snapshot?.screenshot.height ?? snapshot?.screen.height ?? 0;
    } else {
      mediaWidth = snapshot?.screenshot.width ?? liveWidth ?? snapshot?.screen.width ?? 0;
      mediaHeight = snapshot?.screenshot.height ?? liveHeight ?? snapshot?.screen.height ?? 0;
    }
  } else if (mode === "preview") {
    mediaWidth = previewImage?.width ?? previewResult?.width ?? 0;
    mediaHeight = previewImage?.height ?? previewResult?.height ?? 0;
  } else {
    mediaWidth = snapshotImage?.width ?? snapshot?.screen.width ?? 0;
    mediaHeight = snapshotImage?.height ?? snapshot?.screen.height ?? 0;
  }
  const activePreviewCaptureFrame = useMemo(() => (
    previewCaptureSelection && mediaWidth && mediaHeight
      ? previewCaptureFrame(previewCaptureSelection, mediaWidth, mediaHeight)
      : null
  ), [mediaHeight, mediaWidth, previewCaptureSelection]);
  const activeSimulatorCaptureFrame = useMemo(() => (
    simulatorCaptureSelection && mediaWidth && mediaHeight
      ? previewCaptureFrame(simulatorCaptureSelection, mediaWidth, mediaHeight)
      : null
  ), [mediaHeight, mediaWidth, simulatorCaptureSelection]);

  const refreshStatus = useCallback(async () => {
    const [nextStatus, nextDevices, nextStreamStatus] = await Promise.all([
      window.ade.iosSimulator.getStatus(runtimePinRef.current),
      window.ade.iosSimulator.listDevices(runtimePinRef.current),
      window.ade.iosSimulator.getStreamStatus(runtimePinRef.current).catch(() => null),
    ]);
    setStatus(nextStatus);
    setDevices(nextDevices);
    syncExistingStreamStatus(nextStreamStatus);
    const nextDeviceUdid = nextStatus.activeDevice?.udid ?? nextDevices[0]?.udid ?? null;
    setSelectedDeviceUdid((current) => current ?? nextDeviceUdid);
  }, [syncExistingStreamStatus]);

  const shutdownSimulator = useCallback(async (force = false) => {
    if (controlsDisabled) {
      setMessage(controlsDisabledMessage);
      return false;
    }
    try {
      // Shutdown enforces the same single-owner rule as launch, so the drawer
      // has to name itself or the service refuses its own Stop button as a
      // foreign caller. `ignoreChatOwnership` is the lane-scoped surface, which
      // by design drives whatever session the lane is running and hides the
      // ownership card, so it asks the service to stand the rule down — it does
      // not replay the owner's id as its own. Impersonating the owner worked,
      // but it logged the wrong caller and taught every other caller that
      // reading an id off `getStatus` is how you get past the guard.
      //
      // The trade: impersonation worked against *any* host build, because it
      // only ever used fields the host already had. `ignoreOwnership` is a
      // contract the host has to honour, so against an older remote runtime
      // this Stop is refused with IOS_SIMULATOR_OWNED_BY_OTHER_SESSION and the
      // message lands in the drawer. That is a clean, legible failure rather
      // than a silent one, and it is preferred to auto-retrying with `force`:
      // `force` is not the same request — it also hard-resets the launch lock
      // and sweeps tracked idb companions — so falling back to it would quietly
      // do more than the user's Stop asked for.
      await window.ade.iosSimulator.shutdown({
        chatSessionId: sessionId ?? null,
        force,
        ...(ignoreChatOwnership ? { ignoreOwnership: true } : {}),
      }, runtimePinRef.current);
      await refreshStatus();
      setSnapshot(null);
      setSelectedElement(null);
      setHoveredElement(null);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [
    controlsDisabled,
    controlsDisabledMessage,
    ignoreChatOwnership,
    refreshStatus,
    sessionId,
  ]);

  const takeOver = useCallback(async () => {
    const evicted = activeSession?.laneId ?? (activeSession?.chatSessionId ? shortChatId(activeSession.chatSessionId) : null);
    const stopped = await shutdownSimulator(true);
    if (!stopped) return;
    setMessage(evicted ? `Took the simulator from ${evicted}. Relaunching...` : "Relaunching the simulator here...");
    void launchRef.current?.();
  }, [activeSession?.chatSessionId, activeSession?.laneId, shutdownSimulator]);

  // Non-destructive hand-off: adopt the running session in this chat without
  // a shutdown/rebuild. takeOver bypasses the ownership guard service-side.
  const attachToSessionCallback = useCallback(async () => {
    if (!sessionId) return;
    try {
      await window.ade.iosSimulator.attachToChatSession({
        chatSessionId: sessionId,
        callerChatSessionId: sessionId,
        takeOver: true,
      }, runtimePinRef.current);
      await refreshStatus();
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [refreshStatus, sessionId]);
  const attachToSession = sessionId ? attachToSessionCallback : null;

  const copyInstallHint = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`Copied: ${text}`);
    } catch {
      setMessage("Could not copy to clipboard.");
    }
  }, []);

  const refreshLaunchTargets = useCallback(async (deviceUdid?: string | null) => {
    const nextTargets = await window.ade.iosSimulator.listLaunchTargets({ deviceUdid, ...rootScope }, runtimePinRef.current);
    setLaunchTargets(nextTargets);
    setSelectedTargetId((current) => (
      current && nextTargets.some((target) => target.id === current)
        ? current
        : nextTargets[0]?.id ?? null
    ));
    setMessage((current) => (isLaunchTargetErrorMessage(current) ? null : current));
  }, [rootScope]);

  const refreshPreviewLab = useCallback(async () => {
    setPreviewRefreshing(true);
    setPreviewResult(null);
    setMessage("Checking the Xcode preview bridge. Click Allow if Xcode asks.");
    try {
      const sourceFile = selectedElement?.sourceFile ?? null;
      const sourceLine = selectedElement?.sourceLine ?? null;
      const selectedLabel = selectedElement ? elementLabel(selectedElement) : null;
      const selectedComponentId = selectedElement?.componentId ?? null;
      const [workspace, targets, match] = await Promise.all([
        window.ade.iosSimulator.ensurePreviewWorkspace({ ...rootScope, sourceFile, sourceLine, openIfNeeded: true }, runtimePinRef.current),
        window.ade.iosSimulator.listPreviewTargets({ ...rootScope, sourceFile, sourceLine }, runtimePinRef.current),
        window.ade.iosSimulator.resolvePreviewMatch({
          ...rootScope,
          sourceFile,
          sourceLine,
          elementLabel: selectedLabel,
          componentId: selectedComponentId,
        }, runtimePinRef.current),
      ]);
      const capability = workspace.capability;
      setPreviewCapability(capability);
      setPreviewTargets(targets);
      setPreviewMatch(match);
      const matchedTargetId = match.target?.id ?? null;
      setSelectedPreviewTargetId((current) => (
        matchedTargetId && targets.some((target) => target.id === matchedTargetId)
          ? matchedTargetId
          : current && targets.some((target) => target.id === current)
          ? current
          : targets[0]?.id ?? null
      ));
      if (!capability.supported) {
        setMessage(previewStatusLabel(capability, targets));
      } else if (match.status === "missing-preview") {
        setMessage("No #Preview found near the selected source.");
      } else if (match.status === "matched") {
        setMessage(match.confidence === "fallback" ? "Using a project preview fallback." : "Preview match ready.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewRefreshing(false);
    }
  }, [rootScope, selectedElement]);

  useEffect(() => {
    if (!selectedElement?.sourceFile) return;
    if (previewMatchBelongsToElement(previewMatch, selectedElement)) return;
    let cancelled = false;
    void window.ade.iosSimulator.resolvePreviewMatch({
      ...rootScope,
      sourceFile: selectedElement.sourceFile,
      sourceLine: selectedElement.sourceLine ?? null,
      elementLabel: elementLabel(selectedElement),
      componentId: selectedElement.componentId ?? null,
    }, runtimePinRef.current).then((match) => {
      if (cancelled) return;
      setPreviewMatch(match);
      const matchedTarget = match.target;
      if (matchedTarget) {
        setPreviewTargets((current) => (
          current.some((target) => target.id === matchedTarget.id)
            ? current
            : [matchedTarget, ...current]
        ));
      }
    }).catch(() => {
      // Preview routing is optional while inspecting the live simulator.
    });
    return () => {
      cancelled = true;
    };
  }, [previewMatch, rootScope, selectedElement]);


  useEffect(() => {
    void refreshStatus().catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refreshStatus]);

  useEffect(() => {
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
      if (event.type === "launch-progress") {
        // These events broadcast project-wide, so a second drawer in the same
        // project used to render another chat's steps over its own live view —
        // and, once a foreign launch failed, kept rendering them. Progress that
        // names an owner is only ours if the name matches. Unstamped progress
        // is still accepted: an older host sends none, and dropping it would
        // leave the stepper permanently blank.
        //
        // `ignoreChatOwnership` is the lane-scoped surface (the Work sidebar's
        // iOS tab). It still carries a sessionId to route its own actions, so
        // reading that id here would drop every step of a launch another chat
        // in the same lane started — a blank stepper for the whole build. The
        // lane check below is the only scoping that surface wants.
        const owningChatSessionId = trimmedOrNull(event.progress.chatSessionId);
        if (!ignoreChatOwnership && owningChatSessionId && sessionId && owningChatSessionId !== sessionId) return;
        const owningLaneId = trimmedOrNull(event.progress.laneId);
        if (owningLaneId && laneId && owningLaneId !== laneId) return;
        setLaunchProgress((current) => {
          const withoutStep = current.filter((item) => item.launchId !== event.progress.launchId || item.step !== event.progress.step);
          return [...withoutStep, event.progress];
        });
        return;
      }
      if (event.type === "selection") {
        if (suppressNextSelectionEventRef.current) {
          suppressNextSelectionEventRef.current = false;
          return;
        }
        const itemSessionId = typeof event.item.metadata.chatSessionId === "string" ? event.item.metadata.chatSessionId : null;
        if (itemSessionId && sessionId && itemSessionId !== sessionId) return;
        if (!onAddContext) return;
        onAddContext(event.item);
        setMessage("Added selected simulator context.");
        return;
      }
      if (event.type === "stream-started" || event.type === "stream-status" || event.type === "stream-stopped" || event.type === "stream-error") {
        const errorMessage = handleStreamEvent(event.type, event.status);
        if (errorMessage) setMessage(errorMessage);
        return;
      }
      if (event.type === "session-released") {
        setSnapshot(null);
        setSelectedElement(null);
        setHoveredElement(null);
        // Launch progress is deliberately kept: a release mid-launch is exactly
        // when the last completed step is the only diagnosis available.
        void refreshStatus().catch(() => {});
        return;
      }
      if (event.type === "session-updated" || event.type === "session-started") {
        void refreshStatus().catch(() => {});
        return;
      }
    }, runtimePinRef.current);
    return () => {
      unsubscribe();
    };
  }, [handleStreamEvent, ignoreChatOwnership, laneId, onAddContext, refreshStatus, sessionId]);

  useEffect(() => {
    void refreshLaunchTargets(selectedDeviceUdid ?? activeDevice?.udid ?? undefined).catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [activeDevice?.udid, refreshLaunchTargets, selectedDeviceUdid]);

  useEffect(() => {
    if (mode !== "preview") return;
    void refreshPreviewLab();
  }, [mode, refreshPreviewLab]);

  useEffect(() => {
    if (!previewCaptureActive) setPreviewCaptureSelection(null);
  }, [previewCaptureActive, previewResult?.dataUrl]);

  useEffect(() => {
    if (mode !== "inspect") {
      setSimulatorCaptureActive(false);
      setSimulatorCaptureSelection(null);
    }
  }, [mode]);

  // Same rule as the live view: the snapshot comes off a booted device, so a
  // device session qualifies. Inspect showed an empty frame for one otherwise.
  useEffect(() => {
    if (mode !== "inspect" || !activeDevice || !status?.supported) return;
    if (!hasActiveSession) return;
    void refreshSnapshot({ priority: true }).catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [activeDevice, hasActiveSession, mode, refreshSnapshot, status?.supported]);

  const ownerLabel = activeSession?.laneId ?? deviceSession?.laneId ?? shortChatId(otherChatSessionId ?? "");
  const ownerAgeLabel = formatAge(
    activeSession?.claimedAt ?? activeSession?.startedAt ?? deviceSession?.openedAt,
    nowTick,
  );
  /**
   * The ribbon replaces the card wherever there is a live view under it.
   *
   * The card costs a row of height above the video and repeats what the ribbon
   * says in the place the eye already is. Preview mode keeps the card: it shows
   * a rendered SwiftUI preview, not the session, so a ribbon over it would name
   * an owner of something the user is not looking at.
   */
  const showWatchRibbon = !mediaExpanded && ownedByOtherChat && mode !== "preview" && !setupBlocked;
  /**
   * The tools act on a device, so they only show once there is one.
   *
   * Preview Lab is excluded for the same reason its chrome hides the toggle:
   * the surface renders a SwiftUI preview, not the device. Without the mode
   * check the column stayed beside the preview with no button left to close it,
   * and kept polling the device behind it.
   */
  const toolsVisible = toolsOpen
    && mode !== "preview"
    && !mediaExpanded
    && !setupBlocked
    && Boolean(activeDeviceUdid);

  /* ------------------------------------------------------------------ *
   * Device tools
   *
   * The device half of the drawer — settings, app lifecycle, and the event
   * log — lives in `useIosSimDeviceTools`. It shares no state with the live
   * view, the launch, or the inspector, and it is the only part here that
   * leaves a process running on the host.
   * ------------------------------------------------------------------ */

  const toolsBundleId = activeSession?.bundleId ?? null;

  const deviceTools = useIosSimDeviceTools({
    activeDeviceUdid,
    bundleId: toolsBundleId,
    chatSessionId: sessionId ?? null,
    ignoreOwnership: ignoreChatOwnership,
    visible: toolsVisible,
    requested: toolsOpen && Boolean(activeDeviceUdid),
    runtimePinRef,
    onError: setMessage,
  });

  /**
   * Boots the selected device and claims it, with no build and no app.
   *
   * The only other way into the drawer is a launch, which rebuilds the lane.
   * That is the wrong price for "show me the app that is already installed".
   */
  const openDeviceOnly = useCallback(async () => {
    try {
      await window.ade.iosSimulator.openDevice({
        deviceUdid: selectedDeviceUdid ?? activeDevice?.udid ?? null,
        chatSessionId: sessionId ?? null,
        laneId: laneId ?? null,
      }, runtimePinRef.current);
      await refreshStatus();
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [activeDevice?.udid, laneId, refreshStatus, selectedDeviceUdid, sessionId]);


  // The drawer is not always the thing that launched. An agent launches, the
  // user opens the drawer afterwards, and the session is then the only place
  // the build root and the prebuilt flag exist — without this fallback the
  // "prebuilt — changes not included" warning never appeared on that path at
  // all. A launch this panel ran stays authoritative — but only over the
  // session it produced, which is what `panelLaunchExtras.sessionId` pins.
  //
  // Derived, not an effect that seeds its own state: the old version listed the
  // state it wrote in its own dependency array, so it re-ran on every value it
  // produced and the "is it already populated" guard was load-bearing rather
  // than an optimisation.
  const launchExtras = useMemo<IosSimLaunchExtras>(() => {
    // A launch in flight invalidates everything known: the session still on
    // screen is the one being replaced, and its extras would otherwise badge
    // the new launch's own stepper.
    if (launchBusy || !activeSession) return EMPTY_LAUNCH_EXTRAS;
    const own = panelLaunchExtras.sessionId === activeSession.id ? panelLaunchExtras.extras : null;
    if (own && (own.buildRoot || own.usedInstalledBinary)) return own;
    return readLaunchExtras(activeSession);
  }, [activeSession, launchBusy, panelLaunchExtras]);

  // How long the last build of this root took, remembered per machine. The
  // stepper shows it because a cold Xcode build has no other ceiling a reader
  // can see. See `useIosSimBuildDuration`.
  const lastBuildMs = useIosSimBuildDuration({
    launchProgress,
    buildRoot: launchExtras.buildRoot,
    projectRoot,
  });


  const launch = useCallback(async (options: { previewTarget?: IosSimulatorPreviewTarget | null } = {}) => {
    if (simulatorMutationBlocked) {
      setMessage(inputBlockedMessage);
      return;
    }
    const previewTarget = options.previewTarget ?? null;
    setBusy(true);
    setLaunchBusy(true);
    setLaunchProgress([]);
    setPanelLaunchExtras({ sessionId: null, extras: EMPTY_LAUNCH_EXTRAS });
    setDismissedLaunchId(null);
    setMessage(null);
    try {
      const session = await window.ade.iosSimulator.launch({
        deviceUdid: selectedDeviceUdid,
        ...rootScope,
        targetId: activeTarget?.id ?? selectedTargetId,
        chatSessionId: sessionId,
        build: true,
        mode: "live",
        keepSimulatorInBackground: false,
        environment: previewTarget ? previewLaunchEnvironment(previewTarget) : null,
        // Agent launches no longer force the drawer open; this one is the user's
        // own click on Launch, so it opts in.
        openDrawer: true,
      }, runtimePinRef.current);
      setPanelLaunchExtras({ sessionId: session.id, extras: readLaunchExtras(session) });
      setSelectedDeviceUdid(session.deviceUdid);
      await refreshStatus();
      setMode("interact");
      void refreshSnapshot({ silent: true, priority: true });
      // The live view is the confirmation; no "launched." line needed.
      setMessage(previewTarget ? `Launched. Ask the agent to route to ${previewTarget.title} if it did not open.` : null);
    } catch (error) {
      suppressNextSelectionEventRef.current = false;
      if (isOwnedByOtherSessionError(error)) {
        // The ownership card carries the owner and the two actions.
        await refreshStatus().catch(() => {});
        setMessage(null);
      } else {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setLaunchBusy(false);
      setBusy(false);
    }
  }, [activeTarget?.id, inputBlockedMessage, refreshSnapshot, refreshStatus, rootScope, selectedDeviceUdid, selectedTargetId, sessionId, simulatorMutationBlocked]);

  useEffect(() => {
    launchRef.current = launch;
  }, [launch]);

  const renderSelectedPreview = useCallback(async (override?: IosSimulatorPreviewTarget) => {
    const target = override ?? selectedPreviewTarget;
    if (!target) {
      setMessage("Choose a #Preview before rendering.");
      return;
    }
    setPreviewRefreshing(true);
    setMessage(`Rendering ${target.title} through Xcode Preview...`);
    try {
      const result = await window.ade.iosSimulator.renderPreview({
        ...rootScope,
        sourceFilePath: target.sourceFilePath,
        previewDefinitionIndexInFile: target.previewDefinitionIndexInFile,
        tabIdentifier: previewCapability?.selectedWindow?.tabIdentifier ?? null,
        timeoutSec: 120,
      }, runtimePinRef.current);
      setPreviewResult(result);
      setPreviewCapability(result.capability);
      setMessage(result.ok
        ? `Rendered ${target.title}.`
        : result.error ?? "Preview render failed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewRefreshing(false);
    }
  }, [previewCapability?.selectedWindow?.tabIdentifier, rootScope, selectedPreviewTarget]);

  const openPreviewWorkspace = useCallback(async () => {
    try {
      await window.ade.iosSimulator.openPreviewWorkspace({ ...rootScope }, runtimePinRef.current);
      setMessage("Opened the iOS project in Xcode. Click Allow if asked, then Retry.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [rootScope]);

  const draftPreviewAgentHelpRef = useRef<((actionOverride?: PreviewAgentHelpAction, context?: PreviewAgentPromptContext) => Promise<void>) | null>(null);
  const openCurrentPageInPreview = useCallback(async () => {
    const element = inspectBridgeElement;
    const elementSource = element?.sourceFile ?? null;
    const elementSourceLine = element?.sourceLine ?? null;
    setPreviewRefreshing(true);
    setMessage("Opening the current simulator selection in Preview Lab...");
    try {
      const current = await window.ade.iosSimulator.renderCurrentPreview({
        ...rootScope,
        sourceFile: elementSource,
        sourceLine: elementSourceLine,
        elementLabel: element ? elementLabel(element) : null,
        componentId: element?.componentId ?? null,
        tabIdentifier: previewCapability?.selectedWindow?.tabIdentifier ?? null,
        timeoutSec: 120,
      }, runtimePinRef.current);
      const match = current.match;
      setPreviewMatch(match);
      const matchingTarget = current.target;
      if (matchingTarget) {
        setPreviewTargets((targets) => (
          targets.some((target) => target.id === matchingTarget.id)
            ? targets
            : [matchingTarget, ...targets]
        ));
      }
      if (current.render?.capability) {
        setPreviewCapability(current.render.capability);
      }
      if (current.render) {
        setPreviewResult(current.render);
      }
      if (matchingTarget && current.render) {
        setMode("preview");
        setPreviewMode("control");
        setSelectedPreviewTargetId(matchingTarget.id);
        setMessage(current.ok
          ? `Rendered ${matchingTarget.title}.`
          : current.error ?? "Preview render failed.");
        return;
      }
      setPreviewAgentHelpAction("open-simulator-in-preview");
      setMessage(elementSource
        ? `No #Preview matched ${elementSource}. Drafting an agent-backed preview task...`
        : "No source-backed simulator element is selected. Drafting an agent prompt with the current snapshot workflow...");
      void draftPreviewAgentHelpRef.current?.("open-simulator-in-preview", {
        selectedElement: element,
        previewTarget: null,
        previewMatch: match,
        previewResult: null,
        includePreviewAttachment: false,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewRefreshing(false);
    }
  }, [inspectBridgeElement, previewCapability?.selectedWindow?.tabIdentifier, rootScope]);

  const sendTypedText = useCallback(async () => {
    const text = typedText;
    if (!text.trim()) return;
    if (liveInputBlocked) {
      setMessage(liveInputBlockedMessage);
      return;
    }
    setTypedText("");
    armWindowCaptureRecoveryAfterInput();
    try {
      await window.ade.iosSimulator.typeText({ deviceUdid: selectedDeviceUdid, text }, runtimePinRef.current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [armWindowCaptureRecoveryAfterInput, liveInputBlocked, liveInputBlockedMessage, selectedDeviceUdid, typedText]);

  const updateInspectBounds = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;
    setBounds(measureObjectContain(image, mediaWidth, mediaHeight));
  }, [mediaHeight, mediaWidth]);

  useEffect(() => {
    if (mode !== "inspect") return;
    updateInspectBounds();
  }, [mediaZoom, mode, updateInspectBounds]);

  const handleInspectPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (simulatorCaptureActive) return;
    const image = imageRef.current;
    if (!image || !snapshot || !mediaWidth || !mediaHeight) return;
    const point = pointerToMediaPoint(event, image, mediaWidth, mediaHeight);
    if (!point) {
      setHoveredElement(null);
      return;
    }
    setBounds(point.bounds);
    setHoveredElement(bestElementAt(snapshot.elements, point.x, point.y));
  }, [mediaHeight, mediaWidth, simulatorCaptureActive, snapshot]);

  const attachCrop = useCallback(async (element: IosScreenElement): Promise<{ dataUrl: string; path: string | null } | null> => {
    if (!snapshot) return null;
    const cropDataUrl = await cropElementDataUrl(snapshot, element);
    if (!cropDataUrl) return null;
    let attachmentPath: string | null = null;
    if (onAddAttachment) {
      const { path } = await window.ade.agentChat.saveTempAttachment({
        data: stripDataUrlPrefix(cropDataUrl),
        filename: "ios-element.png",
      }, ...(runtimePin ? [runtimePin] as const : []));
      attachmentPath = path;
      onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    }
    return { dataUrl: cropDataUrl, path: attachmentPath };
  }, [onAddAttachment, runtimePin, snapshot]);

  const selectElementAt = useCallback(async (x: number, y: number, element: IosScreenElement | null) => {
    if (!onAddContext) {
      setMessage("Context insertion is not available in this panel.");
      return;
    }
    setBusy(true);
    try {
      suppressNextSelectionEventRef.current = true;
      const result = await window.ade.iosSimulator.selectPoint({ deviceUdid: selectedDeviceUdid, ...rootScope, x, y }, runtimePinRef.current);
      if (element) {
        setSelectedElement(element);
        const crop = await attachCrop(element);
        onAddContext(crop ? {
          ...result.item,
          screenshotDataUrl: crop.dataUrl,
          metadata: {
            ...result.item.metadata,
            attachmentPath: crop.path,
          },
        } : result.item);
      } else {
        onAddContext(result.item);
      }
      const contextMessage = result.source === "coordinate-fallback"
        ? "Added a coordinate. No element matched that point."
        : "Added selected UI context.";
      setMessage(`${contextMessage} Simulator inspect context inserted.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [attachCrop, onAddContext, rootScope, selectedDeviceUdid]);

  const attachPreviewSnapshot = useCallback(async (): Promise<string | null> => {
    if (!previewResult?.dataUrl || !onAddAttachment) return null;
    const { path } = await window.ade.agentChat.saveTempAttachment({
      data: stripDataUrlPrefix(previewResult.dataUrl),
      filename: "xcode-preview.png",
    }, ...(runtimePin ? [runtimePin] as const : []));
    onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    return path;
  }, [onAddAttachment, previewResult?.dataUrl, runtimePin]);

  const attachPreviewCapture = useCallback(async (frame: PreviewCrop["frame"]): Promise<({ path: string | null } & PreviewCrop) | null> => {
    if (!previewResult?.dataUrl || !previewResult.width || !previewResult.height) return null;
    const crop = await cropPreviewAreaDataUrl(previewResult.dataUrl, previewResult.width, previewResult.height, frame);
    if (!crop) return null;
    let attachmentPath: string | null = null;
    if (onAddAttachment) {
      const { path } = await window.ade.agentChat.saveTempAttachment({
        data: stripDataUrlPrefix(crop.dataUrl),
        filename: "xcode-preview-capture.png",
      }, ...(runtimePin ? [runtimePin] as const : []));
      attachmentPath = path;
      onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    }
    return { ...crop, path: attachmentPath };
  }, [onAddAttachment, previewResult?.dataUrl, previewResult?.height, previewResult?.width, runtimePin]);

  const attachSimulatorScreenshot = useCallback(async (): Promise<string | null> => {
    if (!onAddAttachment) return null;
    let sourceSnapshot = snapshot;
    if (!sourceSnapshot?.screenshot.dataUrl) {
      try {
        const next = await window.ade.iosSimulator.getScreenSnapshot({
          deviceUdid: selectedDeviceUdid ?? activeDevice?.udid ?? undefined,
          ...rootScope,
        }, runtimePinRef.current);
        sourceSnapshot = next;
        setSnapshot(next);
        setHoveredElement(null);
        setSelectedElement(next.hitElement);
      } catch {
        sourceSnapshot = null;
      }
    }
    if (!sourceSnapshot?.screenshot.dataUrl) return null;
    const { path } = await window.ade.agentChat.saveTempAttachment({
      data: stripDataUrlPrefix(sourceSnapshot.screenshot.dataUrl),
      filename: "ios-simulator-screen.png",
    }, ...(runtimePin ? [runtimePin] as const : []));
    onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    return path;
  }, [activeDevice?.udid, onAddAttachment, rootScope, runtimePin, selectedDeviceUdid, snapshot]);

  const attachSimulatorCapture = useCallback(async (frame: PreviewCrop["frame"]): Promise<({ path: string | null } & PreviewCrop) | null> => {
    const screenshot = snapshot?.screenshot;
    if (!screenshot?.dataUrl || !screenshot.width || !screenshot.height) return null;
    const crop = await cropPreviewAreaDataUrl(screenshot.dataUrl, screenshot.width, screenshot.height, frame);
    if (!crop) return null;
    let attachmentPath: string | null = null;
    if (onAddAttachment) {
      const { path } = await window.ade.agentChat.saveTempAttachment({
        data: stripDataUrlPrefix(crop.dataUrl),
        filename: "ios-simulator-capture.png",
      }, ...(runtimePin ? [runtimePin] as const : []));
      attachmentPath = path;
      onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    }
    return { ...crop, path: attachmentPath };
  }, [onAddAttachment, runtimePin, snapshot?.screenshot]);

  const addSimulatorCaptureContext = useCallback(async (frame: PreviewCrop["frame"]) => {
    if (!snapshot?.screenshot.dataUrl) return;
    if (!onAddContext) {
      setMessage("Context insertion is not available in this panel.");
      return;
    }
    const capture = await attachSimulatorCapture(frame).catch(() => null);
    const captureFrame = capture?.frame ?? frame;
    const overlappingElements = snapshot.elements
      .map((element) => ({
        element,
        intersection: rectIntersectionArea(element.pixelFrame, captureFrame),
      }))
      .filter((entry) => entry.intersection > 0)
      .sort((a, b) => b.intersection - a.intersection)
      .slice(0, 12)
      .map(({ element, intersection }) => ({
        ...compactElementForContext(element),
        relation: "inside-captured-region",
        intersectionPx: Math.round(intersection),
      }));
    onAddContext({
      kind: "ios_element",
      id: `ios-simulator-capture:${Date.now()}`,
      componentId: "iOS Simulator screenshot capture",
      sourceFile: null,
      sourceLine: null,
      frame: {
        x: captureFrame.x,
        y: captureFrame.y,
        width: captureFrame.width,
        height: captureFrame.height,
      },
      metadata: {
        iosInspectPacketVersion: 1,
        contextSurface: "simulator",
        screenElementSource: "simulator-region-capture",
        sourceConfidence: "none",
        screenSnapshotCapturedAt: snapshot.capturedAt,
        screen: screenContextForSnapshot(snapshot),
        attachmentPath: capture?.path ?? null,
        selectedElement: {
          source: "simulator-region-capture",
          label: "Dragged simulator screenshot region",
          screenshotFrame: captureFrame,
        },
        nearbyElements: overlappingElements,
        selectionExplanation: "The user dragged a screenshot region inside the live iOS Simulator inspect snapshot. The crop is visual evidence for this exact simulator screen area; nearbyElements are overlapping inspector/accessibility frames and may help identify source.",
      },
      screenshotDataUrl: capture?.dataUrl ?? snapshot.screenshot.dataUrl,
      selectedAt: new Date().toISOString(),
    });
    setMessage(capture?.path
      ? "Added the selected region."
      : "Added simulator screenshot region context.");
  }, [attachSimulatorCapture, onAddContext, snapshot]);

  const buildPreviewAgentPrompt = useCallback((action: PreviewAgentHelpAction, attachmentPaths: { simulator: string | null; preview: string | null }, context?: PreviewAgentPromptContext) => {
    const selected = context && "selectedElement" in context ? context.selectedElement ?? null : selectedElement;
    const target = context && "previewTarget" in context ? context.previewTarget ?? null : selectedPreviewTarget;
    const match = context && "previewMatch" in context ? context.previewMatch ?? null : previewMatch;
    const result = context && "previewResult" in context ? context.previewResult ?? null : previewResult;
    let previewState: string;
    if (result?.ok) {
      previewState = `Rendered preview ${target?.title ?? "selected preview"} successfully.`;
    } else if (result?.error) {
      previewState = `Preview render failed: ${result.error}`;
    } else if (target) {
      previewState = "Preview target exists but has not rendered in the preview lab yet.";
    } else {
      previewState = "No renderable #Preview was found near the selected UI source.";
    }
    let source: string;
    if (selected?.sourceFile) {
      source = `${selected.sourceFile}${selected.sourceLine ? `:${selected.sourceLine}` : ""}`;
    } else if (target?.sourceFile) {
      source = `${target.sourceFile}:${target.sourceLine}`;
    } else {
      source = "unknown";
    }
    const visibleContext = selected
      ? {
          label: elementLabel(selected),
          componentId: selected.componentId,
          identifier: selected.identifier,
          role: selected.role,
          value: selected.value,
          frame: selected.pixelFrame,
          source: selected.source,
        }
      : null;
    const selectedAction = PREVIEW_AGENT_HELP_OPTIONS.find((option) => option.value === action) ?? PREVIEW_AGENT_HELP_OPTIONS[0]!;
    let requestedWork: string[];
    if (action === "open-simulator-in-preview") {
      const suggestedPreviewLine = match?.suggestedSourceFile
        ? `- Step 5b: If no matching preview exists, add one in ${match.suggestedSourceFile}${match.suggestedTitle ? ` named ${JSON.stringify(match.suggestedTitle)}` : ""}. Prefer a lightweight harness with bindings, env objects, no-op callbacks, fake state, and no live sync/network dependencies.`
        : "- Step 5b: If no matching preview exists, add one (prefer a `<Feature>Previews.swift` sidecar; use a lightweight harness with bindings, env objects, no-op callbacks, fake state).";
      requestedWork = [
        "- Step 1: Identify the screen that is currently open in the live iOS Simulator. Start with `ade --socket ios-sim status --text` and `ade --socket ios-sim snapshot --text` so you are using ADE's current simulator session, not a guessed route.",
        "- Step 2: If the simulator is not running, there is no active simulator session, or ADE cannot capture a current screen/snapshot, stop and warn the user with the exact blocker. Do not guess from stale code.",
        "- Step 3: If the selected source is unknown, inspect the snapshot elements and run `ade --socket ios-sim select --x <x> --y <y> --text` on a source-backed element before editing code. If the prompt already provides a source file/line, use that directly.",
        "- Step 4: Resolve and render ADE's current preview bridge with `ade --socket ios-sim preview-current --text`. If you have an explicit source, use `ade --socket ios-sim preview-current --source <swift-file> --line <n> --text`.",
        "- Step 5a: If a matching preview already exists, use it. Do not add a duplicate preview just because the first search was imperfect.",
        suggestedPreviewLine,
        "- Step 6: Finish by running `ade --socket ios-sim preview-current --text` again, or `ade --socket ios-sim preview-render --source <file> --index <previewDefinitionIndexInFile> --text` when you intentionally chose a specific preview.",
        "- Report back with the screen you identified, the file:line of the preview that was used or added, and the `ade --socket ios-sim preview-current` or `preview-render` result.",
      ];
    } else if (action === "add-realistic-mocks") {
      requestedWork = [
        "- Improve the selected preview's mock data so the rendered preview resembles the real simulator screen.",
        "- Derive representative labels, rows, counts, selected states, empty states, and badges from the screenshot or inspector packet when available.",
        "- Keep fixtures deterministic and reusable so future UI refinement can happen without relaunching the simulator.",
      ];
    } else {
      requestedWork = [
        "- Diagnose why the selected preview is missing, blank, stale, or failing to render.",
        "- Repair preview discovery, required dependencies, mock state, and compile errors for the affected SwiftUI files.",
        "- Re-render or run the smallest useful Swift/Xcode check after editing when tooling is available.",
      ];
    }
    return [
      "Make this iOS SwiftUI surface work well in ADE's simulator and Xcode Preview workflow.",
      "",
      "Requested help:",
      `- ${selectedAction.label}`,
      `- ${selectedAction.description}`,
      "",
      "Do this:",
      ...requestedWork,
      "",
      "Selected source:",
      `- ${source}`,
      target ? `- Preview target: ${target.title} (${target.sourceFile}:${target.sourceLine}, index ${target.previewDefinitionIndexInFile})` : "- Preview target: none found",
      "",
      "Preview status:",
      `- ${previewState}`,
      match ? `- Preview match: ${match.status} / ${match.confidence} - ${match.reason}` : "- Preview match: not checked.",
      match?.suggestedSourceFile ? `- Suggested preview file: ${match.suggestedSourceFile}` : null,
      match?.suggestedTitle ? `- Suggested preview title: ${match.suggestedTitle}` : null,
      previewCapability?.setupSteps.length ? `- Setup gaps: ${previewCapability.setupSteps.join("; ")}` : "- Xcode preview setup appears ready or was not checked.",
      "",
      "Visual evidence:",
      attachmentPaths.simulator ? `- Real simulator screenshot attached: ${attachmentPaths.simulator}` : "- Real simulator screenshot is not attached; use `ade ios-sim snapshot --text` before making code changes.",
      attachmentPaths.preview ? `- Current Xcode preview snapshot attached: ${attachmentPaths.preview}` : "- Current Xcode preview snapshot is not attached.",
      visibleContext ? `- Selected visible element: ${JSON.stringify(visibleContext, null, 2)}` : "- No simulator element is currently selected; identify the current screen from the live simulator snapshot before searching code.",
      "",
      "Implementation constraints:",
      "- Prefer feature sidecar previews such as `<Feature>Previews.swift`; leaf component previews can live inline when tiny.",
      "- Put reusable fake data in DEBUG-only preview fixtures or feature-local fixture enums.",
      "- Do not rely on live sync, keychain, network, push, sockets, or the production database.",
      "- Ensure the affected source file, or a nearby related source file, contains a discoverable `#Preview` or `PreviewProvider` so ADE can render it from the Preview surface.",
      "- Do not stop after finding or adding preview code. The final action is the ADE CLI render/open command for the chosen preview.",
      "- If the real screen shows user/project data, create representative mock values from the visible labels, rows, counts, and UI state rather than leaving the preview empty.",
      "- If light/dark appearance is relevant to the visual context, add named preview variants with `.preferredColorScheme(.light)` and/or `.preferredColorScheme(.dark)` and avoid hardcoded colors that only work in one scheme.",
      "- If the selected view requires environment objects or bindings, add a small preview harness with no-op callbacks and fake state.",
      "- After edits, run the smallest useful Swift/Xcode check or render the preview if ADE/Xcode tooling is available.",
    ].filter((line): line is string => line !== null).join("\n");
  }, [previewCapability?.setupSteps, previewMatch, previewResult, selectedElement, selectedPreviewTarget]);

  const draftPreviewAgentHelp = useCallback(async (actionOverride?: PreviewAgentHelpAction, context?: PreviewAgentPromptContext) => {
    const action = actionOverride ?? previewAgentHelpAction;
    const option = PREVIEW_AGENT_HELP_OPTIONS.find((entry) => entry.value === action) ?? PREVIEW_AGENT_HELP_OPTIONS[0]!;
    try {
      const [simulatorAttachment, previewAttachment] = await Promise.all([
        attachSimulatorScreenshot().catch(() => null),
        context?.includePreviewAttachment === false ? Promise.resolve(null) : attachPreviewSnapshot().catch(() => null),
      ]);
      const prompt = buildPreviewAgentPrompt(action, {
        simulator: simulatorAttachment,
        preview: previewAttachment,
      }, context);
      if (onInsertDraft) {
        onInsertDraft(prompt);
        setMessage(`Prepared "${option.label}" prompt in the composer.`);
      } else {
        await window.ade.app.writeClipboardText(prompt);
        setMessage(`Copied "${option.label}" prompt.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [attachPreviewSnapshot, attachSimulatorScreenshot, buildPreviewAgentPrompt, onInsertDraft, previewAgentHelpAction]);
  useEffect(() => {
    draftPreviewAgentHelpRef.current = draftPreviewAgentHelp;
  }, [draftPreviewAgentHelp]);

  const addPreviewCaptureContext = useCallback(async (frame: PreviewCrop["frame"]) => {
    if (!previewImage || !selectedPreviewTarget || !previewResult?.dataUrl) return;
    if (!onAddContext) {
      setMessage("Context insertion is not available in this panel.");
      return;
    }
    const capture = await attachPreviewCapture(frame).catch(() => null);
    const captureFrame = capture?.frame ?? frame;
    onAddContext({
      kind: "ios_element",
      id: `xcode-preview:${selectedPreviewTarget.id}:${Date.now()}`,
      componentId: `Xcode Preview capture: ${selectedPreviewTarget.title}`,
      sourceFile: selectedPreviewTarget.sourceFile,
      sourceLine: selectedPreviewTarget.sourceLine,
      frame: {
        x: captureFrame.x,
        y: captureFrame.y,
        width: captureFrame.width,
        height: captureFrame.height,
      },
      metadata: {
        iosInspectPacketVersion: 1,
        contextSurface: "xcode-preview",
        screenElementSource: "xcode-preview-capture",
        sourceConfidence: "exact",
        previewTarget: selectedPreviewTarget,
        previewSnapshotPath: previewResult.previewSnapshotPath,
        previewRenderedAt: previewResult.renderedAt,
        attachmentPath: capture?.path ?? null,
        previewCaptureFrame: captureFrame,
        selectedElement: {
          source: "xcode-preview-capture",
          label: `${selectedPreviewTarget.title} capture`,
          screenshotFrame: {
            x: captureFrame.x,
            y: captureFrame.y,
            width: captureFrame.width,
            height: captureFrame.height,
          },
        },
        selectionExplanation: "The user dragged a capture area inside an Xcode SwiftUI preview rendered by ADE Preview Lab. The crop is visual evidence for the selected SwiftUI preview target/source, not a live simulator element rectangle.",
      },
      screenshotDataUrl: capture?.dataUrl ?? previewResult.dataUrl,
      selectedAt: new Date().toISOString(),
    });
    setMessage(capture?.path
      ? "Captured preview area and inserted it with Swift source context."
      : "Added preview capture context with Swift source context.");
  }, [attachPreviewCapture, onAddContext, previewImage, previewResult, selectedPreviewTarget]);

  const handlePreviewCapturePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!previewCaptureActive || !previewImage || !selectedPreviewTarget || !previewResult?.dataUrl || !mediaWidth || !mediaHeight) return;
    const image = imageRef.current;
    if (!image) return;
    const point = pointerToMediaPoint(event, image, mediaWidth, mediaHeight);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreviewCaptureSelection({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      bounds: point.bounds,
    });
  }, [mediaHeight, mediaWidth, previewCaptureActive, previewImage, previewResult?.dataUrl, selectedPreviewTarget]);

  const handlePreviewCapturePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!previewCaptureSelection || !previewCaptureActive || !mediaWidth || !mediaHeight) return;
    const image = imageRef.current;
    if (!image) return;
    const point = pointerToClampedMediaPoint(event, image, mediaWidth, mediaHeight);
    if (!point) return;
    setPreviewCaptureSelection((current) => current
      ? { ...current, currentX: point.x, currentY: point.y, bounds: point.bounds }
      : current);
  }, [mediaHeight, mediaWidth, previewCaptureActive, previewCaptureSelection]);

  const finishPreviewCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!previewCaptureSelection || !activePreviewCaptureFrame) return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPreviewCaptureSelection(null);
    if (activePreviewCaptureFrame.width < 12 || activePreviewCaptureFrame.height < 12) {
      setMessage("Drag a larger preview area to capture.");
      return;
    }
    void addPreviewCaptureContext(activePreviewCaptureFrame);
  }, [activePreviewCaptureFrame, addPreviewCaptureContext, previewCaptureSelection]);

  const cancelPreviewCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!previewCaptureSelection) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPreviewCaptureSelection(null);
  }, [previewCaptureSelection]);

  const handleSimulatorCapturePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!simulatorCaptureActive || !snapshot?.screenshot.dataUrl || !mediaWidth || !mediaHeight) return;
    const image = imageRef.current;
    if (!image) return;
    const point = pointerToMediaPoint(event, image, mediaWidth, mediaHeight);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSimulatorCaptureSelection({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      bounds: point.bounds,
    });
  }, [mediaHeight, mediaWidth, simulatorCaptureActive, snapshot?.screenshot.dataUrl]);

  const handleSimulatorCapturePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!simulatorCaptureSelection || !simulatorCaptureActive || !mediaWidth || !mediaHeight) return;
    const image = imageRef.current;
    if (!image) return;
    const point = pointerToClampedMediaPoint(event, image, mediaWidth, mediaHeight);
    if (!point) return;
    setSimulatorCaptureSelection((current) => current
      ? { ...current, currentX: point.x, currentY: point.y, bounds: point.bounds }
      : current);
  }, [mediaHeight, mediaWidth, simulatorCaptureActive, simulatorCaptureSelection]);

  const finishSimulatorCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!simulatorCaptureSelection || !activeSimulatorCaptureFrame) return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setSimulatorCaptureSelection(null);
    if (activeSimulatorCaptureFrame.width < 12 || activeSimulatorCaptureFrame.height < 12) {
      setMessage("Drag a larger simulator region to capture.");
      return;
    }
    void addSimulatorCaptureContext(activeSimulatorCaptureFrame);
  }, [activeSimulatorCaptureFrame, addSimulatorCaptureContext, simulatorCaptureSelection]);

  const cancelSimulatorCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!simulatorCaptureSelection) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setSimulatorCaptureSelection(null);
  }, [simulatorCaptureSelection]);

  const handleInspectClick = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (simulatorCaptureActive) return;
    const image = imageRef.current;
    if (!image || !snapshot || !mediaWidth || !mediaHeight) return;
    const point = pointerToMediaPoint(event, image, mediaWidth, mediaHeight);
    if (!point) return;
    const useParent = event.altKey && selectedElement && containsPoint(selectedElement, point.x, point.y);
    const element = useParent
      ? nextLargerElementAt(snapshot.elements, point.x, point.y, frameArea(selectedElement!))
        ?? bestElementAt(snapshot.elements, point.x, point.y)
      : bestElementAt(snapshot.elements, point.x, point.y);
    const selectX = element ? element.pixelFrame.x + (element.pixelFrame.width / 2) : point.x;
    const selectY = element ? element.pixelFrame.y + (element.pixelFrame.height / 2) : point.y;
    void selectElementAt(selectX, selectY, element);
  }, [mediaHeight, mediaWidth, selectElementAt, selectedElement, simulatorCaptureActive, snapshot]);

  const liveSimulatorPointFromPointer = useCallback((event: PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    // The host-encoded backend draws to a canvas, not a video element, and both
    // are laid out with the same `object-contain` rule, so the same measurement
    // works once it is handed the right node.
    const media: HTMLElement | null = liveVisualKind === "h264" ? h264Canvas : videoRef.current;
    if (!media || !mediaWidth || !mediaHeight) return null;
    const point = pointerToMediaPoint(event, media, mediaWidth, mediaHeight);
    if (!point) return null;
    return mapLivePointToSimulatorPixel(point);
  }, [h264Canvas, liveVisualKind, mapLivePointToSimulatorPixel, mediaHeight, mediaWidth, videoRef]);

  const handleSnapshotInteractPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (liveInputBlocked) {
      setMessage(liveInputBlockedMessage);
      return;
    }
    const point = liveSimulatorPointFromPointer(event);
    if (!point) return;
    dragStartRef.current = {
      x: point.x,
      y: point.y,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [liveInputBlocked, liveInputBlockedMessage, liveSimulatorPointFromPointer]);

  const handleSnapshotInteractPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) return;
    if (liveInputBlocked) {
      setMessage(liveInputBlockedMessage);
      return;
    }
    const point = liveSimulatorPointFromPointer(event);
    if (!point) return;
    const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
    void (async () => {
      try {
        const controlScale = snapshot?.screen.scale && Number.isFinite(snapshot.screen.scale) && snapshot.screen.scale > 0
          ? snapshot.screen.scale
          : 1;
        armWindowCaptureRecoveryAfterInput();
        if (moved < 8) {
          await window.ade.iosSimulator.tap({ deviceUdid: selectedDeviceUdid, x: point.x / controlScale, y: point.y / controlScale }, runtimePinRef.current);
        } else {
          await window.ade.iosSimulator.drag({
            deviceUdid: selectedDeviceUdid,
            startX: start.x / controlScale,
            startY: start.y / controlScale,
            endX: point.x / controlScale,
            endY: point.y / controlScale,
          }, runtimePinRef.current);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [armWindowCaptureRecoveryAfterInput, liveInputBlocked, liveInputBlockedMessage, liveSimulatorPointFromPointer, selectedDeviceUdid, snapshot?.screen.scale]);

  const handleVideoKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (liveInputBlocked) {
      setMessage(liveInputBlockedMessage);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      armWindowCaptureRecoveryAfterInput();
      void window.ade.iosSimulator.typeText({ deviceUdid: selectedDeviceUdid, text: "\n" }, runtimePinRef.current).catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      armWindowCaptureRecoveryAfterInput();
      void window.ade.iosSimulator.typeText({ deviceUdid: selectedDeviceUdid, text: event.key }, runtimePinRef.current).catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
    }
  }, [armWindowCaptureRecoveryAfterInput, liveInputBlocked, liveInputBlockedMessage, selectedDeviceUdid]);

  const activeInspectElement = hoveredElement ?? selectedElement;
  const activeInspectSource = activeInspectElement?.source ?? null;
  let previewModeHint: string | null = null;
  if (mode === "preview") {
    if (previewResult?.error) {
      previewModeHint = previewResult.error;
    } else if (previewCaptureActive) {
      previewModeHint = "Drag a region on the preview to insert an exact crop as context.";
    } else if (previewResult?.ok) {
      previewModeHint = `Preview rendered at ${new Date(previewResult.renderedAt).toLocaleTimeString()}.`;
    } else if (previewTargets.length) {
      previewModeHint = `${previewIssue.title} — choose a target and press Render.`;
    } else {
      previewModeHint = previewIssue.title;
    }
  }

  let simulatorModeHint: string | null = null;
  if (mode === "inspect" && selectedElement && !simulatorCaptureActive) {
    simulatorModeHint = elementLabel(selectedElement);
  }
  // Blockers render on the video, never in a footer line.
  const footerStatus = message ?? previewModeHint ?? simulatorModeHint;

  const visibleLaunchProgress = useMemo(() => selectLaunchSteps(launchProgress), [launchProgress]);
  const visibleLaunchId = visibleLaunchProgress[0]?.launchId ?? null;
  const launchReady = visibleLaunchProgress.some((step) => step.step === "ready" && step.status === "complete");
  const lastLaunchUpdateAt = visibleLaunchProgress.reduce((latest, step) => {
    const parsed = Date.parse(step.updatedAt);
    return Number.isFinite(parsed) && parsed > latest ? parsed : latest;
  }, 0);
  // Progress survives a transport timeout: it stays until the launch actually
  // reaches a terminal state, or until it has clearly gone quiet.
  const launchProgressFresh = lastLaunchUpdateAt > 0 && nowTick - lastLaunchUpdateAt < 180_000;
  // A failure used to pin this stepper over every other mode forever: it had no
  // staleness bound, only a new launch cleared it, and the Control/Inspect
  // toggle that would take the user anywhere else lives *inside* the branches
  // this one sits above. So it now expires on the same 180s clock as a running
  // launch, and Close is the way out before then.
  const showLaunchProgress = visibleLaunchProgress.length > 0
    && !launchReady
    && visibleLaunchId !== dismissedLaunchId
    && (launchBusy || launchProgressFresh);

  useEffect(() => {
    if (!showLaunchProgress && !ownedByOtherChat) return;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), showLaunchProgress ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [ownedByOtherChat, showLaunchProgress]);

  /**
   * The build root, but only when it is news. "Built the checkout you are
   * looking at" is the expected case and deserves no chrome; a build root that
   * is not this pane's project root is the failure that otherwise looks exactly
   * like success.
   */
  const foreignBuildRoot = useMemo(() => {
    const buildRoot = launchExtras.buildRoot;
    if (!buildRoot || !projectRoot) return null;
    return normalizeRootForCompare(buildRoot) === normalizeRootForCompare(projectRoot) ? null : buildRoot;
  }, [launchExtras.buildRoot, projectRoot]);

  const canShowLiveVisual = mode === "interact" && liveVisual;
  const canShowSnapshot = mode === "inspect" && Boolean(snapshotImage);
  const interactionDisabled = simulatorMutationBlocked || setupBlocked;
  const activeInspectFrame = useMemo(() => {
    if (!snapshot || !activeInspectElement) return null;
    return clampFrame(
      activeInspectElement.pixelFrame,
      snapshot.screenshot.width ?? snapshot.screen.width,
      snapshot.screenshot.height ?? snapshot.screen.height,
    );
  }, [activeInspectElement, snapshot]);

  let projectWindowValue: string;
  if (previewCapability?.error) {
    projectWindowValue = "not checked";
  } else if (previewCapability?.selectedWindow) {
    projectWindowValue = "connected";
  } else {
    projectWindowValue = "not connected";
  }
  const mediaSurfaceLabel = activeSurface === "preview" ? "preview" : "simulator";
  const mediaViewToolbar = (
    <div
      className="pointer-events-auto absolute bottom-3 right-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-end gap-1 rounded-md border border-white/[0.08] bg-black/62 p-1 shadow-lg backdrop-blur"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-fg/68 transition-colors hover:bg-white/[0.06] hover:text-fg/90"
        onClick={(event) => {
          event.stopPropagation();
          setMediaExpanded((current) => !current);
        }}
        aria-label={mediaExpanded ? `Exit expanded ${mediaSurfaceLabel} view` : `Expand ${mediaSurfaceLabel} view`}
        title={mediaExpanded ? `Exit expanded ${mediaSurfaceLabel} view` : `Expand ${mediaSurfaceLabel} view`}
      >
        {mediaExpanded ? <ArrowsInSimple size={13} /> : <ArrowsOutSimple size={13} />}
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-fg/68 transition-colors hover:bg-white/[0.06] hover:text-fg/90 disabled:cursor-not-allowed disabled:opacity-35"
        onClick={(event) => {
          event.stopPropagation();
          changeMediaZoom(-MEDIA_ZOOM_STEP);
        }}
        disabled={mediaZoom <= MEDIA_ZOOM_MIN}
        aria-label={`Zoom out ${mediaSurfaceLabel} view`}
        title={`Zoom out ${mediaSurfaceLabel} view`}
      >
        <MagnifyingGlassMinus size={13} />
      </button>
      <button
        type="button"
        className="inline-flex h-7 min-w-10 items-center justify-center rounded px-1 font-sans text-[10px] font-medium tabular-nums text-muted-fg/72 transition-colors hover:bg-white/[0.06] hover:text-fg/90"
        onClick={(event) => {
          event.stopPropagation();
          resetMediaZoom();
        }}
        aria-label={`Reset ${mediaSurfaceLabel} zoom`}
        title={`Reset ${mediaSurfaceLabel} zoom`}
      >
        {mediaZoomLabel}
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-fg/68 transition-colors hover:bg-white/[0.06] hover:text-fg/90 disabled:cursor-not-allowed disabled:opacity-35"
        onClick={(event) => {
          event.stopPropagation();
          changeMediaZoom(MEDIA_ZOOM_STEP);
        }}
        disabled={mediaZoom >= MEDIA_ZOOM_MAX}
        aria-label={`Zoom in ${mediaSurfaceLabel} view`}
        title={`Zoom in ${mediaSurfaceLabel} view`}
      >
        <MagnifyingGlassPlus size={13} />
      </button>
    </div>
  );

  const handleStopSimulator = useCallback(() => {
    if (typeof window === "undefined") return;
    const ok = window.confirm("Stop the iOS simulator? Any running app will be terminated.");
    if (!ok) return;
    void shutdownSimulator(false);
  }, [shutdownSimulator]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", mediaExpanded ? "gap-0" : "gap-1")}>
      <div className={cn("shrink-0", mediaExpanded ? "hidden" : null)}>
        {/*
          One 40px chrome row, in the tools pane's own language.

          This was three stacked rows — a segmented mode switch beside a run of
          tinted status pills, then a bordered `<select>` with its own refresh
          and Stop, then a second `<select>` with Launch and Apply. Eleven
          controls and four fills before the simulator itself got any height.
          The same jobs are a device chip, a target chip, and four ghost glyphs;
          what each one does is a tooltip, not a label.
        */}
        <div className={WORK_TOOL_CHROME_ROW} data-testid="ios-pane-chrome">
          {activeSurface === "simulator" ? (
            <>
              <PaneTooltip
                label={deviceLabel(activeDevice)}
                side="bottom"
                className={cn(WORK_TOOL_CHROME_CHIP_WRAP, "max-w-[190px]")}
              >
                <span className={cn(WORK_TOOL_CHROME_CHIP, "relative")}>
                  <DeviceMobile size={12} aria-hidden className="shrink-0 text-muted-fg" />
                  <span className="min-w-0 truncate">{deviceLabel(activeDevice)}</span>
                  <CaretDown size={10} aria-hidden className="shrink-0 text-muted-fg/70" />
                  {/* The native menu is the control; the chip is its face. An
                      invisible `<select>` on top keeps the OS picker, the
                      keyboard behaviour and the a11y role for free. */}
                  <select
                    aria-label="Simulator device"
                    className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
                    value={activeDevice?.udid ?? ""}
                    disabled={interactionDisabled}
                    onChange={(event) => {
                      setSelectedDeviceUdid(event.currentTarget.value || null);
                      setSnapshot(null);
                    }}
                  >
                    {devices.length ? devices.map((device) => (
                      <option key={device.udid} value={device.udid}>{deviceLabel(device)}</option>
                    )) : (
                      <option value="">No available simulator</option>
                    )}
                  </select>
                </span>
              </PaneTooltip>

              <PaneTooltip
                label={activeTarget ? targetLabel(activeTarget) : "No launchable app found"}
                side="bottom"
                className={cn(WORK_TOOL_CHROME_CHIP_WRAP, "max-w-[150px]")}
              >
                <span className={cn(WORK_TOOL_CHROME_CHIP, "relative", !activeTarget && "text-muted-fg")}>
                  <span className="min-w-0 truncate">
                    {activeTarget ? targetLabel(activeTarget) : "No app"}
                  </span>
                  {visibleLaunchTargets.length > 1 ? (
                    <>
                      <CaretDown size={10} aria-hidden className="shrink-0 text-muted-fg/70" />
                      <select
                        aria-label="Launch target"
                        className="absolute inset-0 cursor-pointer opacity-0"
                        value={activeTarget?.id ?? ""}
                        onChange={(event) => setSelectedTargetId(event.currentTarget.value || null)}
                      >
                        {visibleLaunchTargets.map((target) => (
                          <option key={target.id} value={target.id}>{targetLabel(target)}</option>
                        ))}
                      </select>
                    </>
                  ) : null}
                </span>
              </PaneTooltip>

              {/* Which machine you are actually watching, and what it costs.
                  A remote live view looks identical to a local one, so without
                  this the only clue that the pixels crossed a network is that
                  they are late. */}
              {liveChip ? (
                <PaneTooltip label={liveChip.detail} side="bottom">
                  <span className={cn(WORK_TOOL_CHROME_META, "inline-flex min-w-0 items-center gap-1")} data-testid="ios-live-chip">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        liveChip.tone === "active"
                          ? "bg-emerald-400/85"
                          : liveChip.tone === "error"
                            ? "bg-rose-400/85"
                            : "bg-amber-300/80",
                      )}
                    />
                    <span className="min-w-0 truncate">{liveChip.label}</span>
                  </span>
                </PaneTooltip>
              ) : null}

              {/* Two build facts that change what you are looking at, as one
                  muted word each rather than an amber pill each. */}
              {launchExtras.usedInstalledBinary ? (
                <PaneTooltip label="This launch reused the installed app instead of building." side="bottom">
                  <span className={WORK_TOOL_CHROME_META}>prebuilt</span>
                </PaneTooltip>
              ) : null}
              {foreignBuildRoot ? (
                <PaneTooltip label={`Built in ${foreignBuildRoot}, not this project's checkout.`} side="bottom">
                  <span className={cn(WORK_TOOL_CHROME_META, "min-w-0 truncate")}>
                    {abbreviatePathTail(foreignBuildRoot)}
                  </span>
                </PaneTooltip>
              ) : null}
            </>
          ) : (
            <span className="min-w-0 truncate px-2 text-[12px] text-muted-fg">Xcode previews</span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {activeSurface === "simulator" ? (
              <>
                <WorkToolChromeButton
                  label={hasActiveSession ? "Rebuild and relaunch" : "Launch"}
                  onClick={() => void launch()}
                  disabled={busy || !status?.supported || !activeTarget || interactionDisabled}
                  testId="ios-pane-launch"
                >
                  <Play size={16} weight="fill" />
                </WorkToolChromeButton>
                {hasActiveSession && !simulatorMutationBlocked ? (
                  <WorkToolChromeButton
                    label="Stop simulator"
                    onClick={handleStopSimulator}
                    disabled={busy}
                    testId="ios-pane-stop"
                  >
                    <Power size={16} weight="bold" />
                  </WorkToolChromeButton>
                ) : null}
                <WorkToolChromeButton
                  label="Screenshot a region"
                  onClick={() => {
                    setSimulatorCaptureSelection(null);
                    setSimulatorCaptureActive((current) => !current);
                    setHoveredElement(null);
                  }}
                  active={simulatorCaptureActive}
                  disabled={!snapshot?.screenshot.dataUrl || contextControlsBlocked}
                  testId="ios-pane-screenshot"
                >
                  <ImageSquare size={16} />
                </WorkToolChromeButton>
                <WorkToolChromeButton
                  label="Refresh simulator state"
                  onClick={() => {
                    void refreshStatus()
                      .then(() => refreshLaunchTargets(selectedDeviceUdid ?? activeDevice?.udid ?? undefined))
                      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
                  }}
                  disabled={contextControlsBlocked}
                  testId="ios-pane-refresh"
                >
                  <ArrowsClockwise size={16} />
                </WorkToolChromeButton>
              </>
            ) : null}
            {mode !== "preview" ? (
              <WorkToolChromeButton
                label={toolsOpen ? "Hide device tools" : "Device tools"}
                onClick={() => setToolsOpen((open) => !open)}
                active={toolsOpen}
                testId="ios-pane-tools"
              >
                <SlidersHorizontal size={16} />
              </WorkToolChromeButton>
            ) : null}
            <WorkToolChromeButton
              label={activeSurface === "preview" ? "Live simulator" : "Previews"}
              onClick={() => setMode(activeSurface === "preview" ? lastSimulatorMode : "preview")}
              testId="ios-pane-surface"
            >
              {activeSurface === "preview" ? <DeviceMobile size={16} /> : <BracketsCurly size={16} />}
            </WorkToolChromeButton>
          </div>
        </div>

        {mode === "preview" ? (
          <div className="space-y-1.5 px-0.5 pt-1">
            <div className="flex items-center gap-2">
              {previewTargets.length ? (
                <select
                  className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/20 px-2 py-1.5 font-sans text-[11px] text-fg/75 outline-none"
                  value={selectedPreviewTarget?.id ?? ""}
                  onChange={(event) => {
                    setSelectedPreviewTargetId(event.currentTarget.value || null);
                    setPreviewResult(null);
                  }}
                >
                  {previewTargets.map((target) => (
                    <option key={target.id} value={target.id}>{previewTargetLabel(target)}</option>
                  ))}
                </select>
              ) : (
                <div className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/20 px-2 py-1.5 font-sans text-[11px] text-muted-fg/60">
                  {previewStatusLabel(previewCapability, previewTargets)}
                </div>
              )}
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-violet-300/20 bg-violet-400/10 px-2 font-sans text-[11px] font-medium text-violet-50/85 transition-colors hover:bg-violet-400/15 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!previewReady || previewRefreshing}
                onClick={() => void renderSelectedPreview()}
                title="Render selected Xcode preview"
              >
                {previewRefreshing ? <SpinnerGap size={13} className="animate-spin" /> : <ImageSquare size={13} />}
                Render
              </button>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-300/20 bg-emerald-400/10 px-2 font-sans text-[11px] font-medium text-emerald-50/85 transition-colors hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!selectedPreviewTarget || !activeTarget || launchBusy || interactionDisabled}
                onClick={() => void launch({ previewTarget: selectedPreviewTarget })}
                title="Launch the app in the live simulator with this preview target as debug context"
              >
                {launchBusy ? <SpinnerGap size={13} className="animate-spin" /> : <DeviceMobile size={13} />}
                View in simulator
              </button>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5 px-1 font-sans text-[10px] text-muted-fg/55">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className={cn(
                  "inline-flex h-5 shrink-0 items-center rounded border px-1.5 font-medium",
                  previewMatchTone(previewMatch),
                )}>
                  {previewMatchLabel(previewMatch)}
                </span>
                <span className="min-w-0 truncate" title={previewSuggestionReason}>
                  {previewSuggestionReason}
                </span>
              </div>
              <div className="min-w-0 shrink-0 truncate text-muted-fg/45" title={previewTargetSource ?? undefined}>
                {previewTargetSource ?? previewMatch?.suggestedSourceFile ?? "No #Preview selected"}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 font-sans text-[10px] font-medium text-muted-fg/60 transition-colors hover:text-fg/85"
                onClick={() => void refreshPreviewLab()}
                disabled={previewRefreshing}
              >
                <ArrowClockwise size={11} className={previewRefreshing ? "animate-spin" : undefined} />
                Refresh
              </button>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 font-sans text-[10px] font-medium text-muted-fg/60 transition-colors hover:text-fg/85"
                onClick={() => void openPreviewWorkspace()}
              >
                <FileCode size={11} />
                Open Xcode
              </button>
              {previewMatch?.status === "matched" && previewMatch.confidence === "fallback" ? (
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300/20 bg-amber-400/10 px-2 font-sans text-[10px] font-medium text-amber-50/82 transition-colors hover:bg-amber-400/15"
                  onClick={() => {
                    setPreviewAgentHelpAction("open-simulator-in-preview");
                    void draftPreviewAgentHelp("open-simulator-in-preview");
                  }}
                >
                  <Lightning size={11} />
                  Create closer preview
                </button>
              ) : null}
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 font-sans text-[10px] font-medium text-muted-fg/60 transition-colors hover:text-fg/85"
                onClick={() => void window.ade.app.openExternal(previewCapability?.docsUrl ?? XCODE_MCP_DOCS_URL)}
              >
                <ArrowSquareOut size={11} />
                Setup docs
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/*
        The card only renders where the ribbon cannot: the ribbon floats over
        the live view, so a drawer with no live view to float over would say
        nothing about who owns the session.
      */}
      {!mediaExpanded && ownedByOtherChat && !showWatchRibbon ? (
        <IosSimOwnershipCard
          ownerLabel={ownerLabel}
          ageLabel={ownerAgeLabel}
          onAttach={attachToSession}
          onTakeOver={() => void takeOver()}
          busy={busy}
        />
      ) : null}

      {/*
        Guarded on `status` for the same reason `setupBlocked` is: the chips read
        "missing" until the first status lands, so an unguarded row flashed
        "Xcode ● missing / Runtime ● missing" on a perfectly healthy Mac every
        time the drawer opened. Nothing renders until the machine has answered.
      */}
      {!mediaExpanded && Boolean(status) && !setupBlocked && !toolChipsHealthy ? (
        <IosSimToolChips chips={toolChips} onCopy={(text) => void copyInstallHint(text)} className="shrink-0 px-0.5" />
      ) : null}

      <div className="flex min-h-0 flex-1 gap-1.5">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-white/[0.08] bg-white/[0.02]">
        {showWatchRibbon ? (
          <IosSimWatchRibbon
            ownerLabel={ownerLabel}
            ageLabel={ownerAgeLabel}
            onAttach={attachToSession}
            onTakeOver={() => void takeOver()}
            busy={busy}
          />
        ) : null}
        {setupBlocked && mode !== "preview" ? (
          <IosSimUnsupportedCard chips={toolChips} onCopy={(text) => void copyInstallHint(text)} />
        ) : mode === "preview" ? (
          <div className="relative h-full min-h-[300px]">
            <div className="pointer-events-auto absolute left-3 top-3 z-10 flex rounded-md border border-white/[0.08] bg-black/60 p-0.5 shadow-lg backdrop-blur">
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium transition-colors",
                  previewMode === "control" ? "bg-violet-500/22 text-violet-100/95" : "text-muted-fg/55 hover:text-fg/85",
                )}
                onClick={() => setPreviewMode("control")}
              >
                <ImageSquare size={11} />
                Control
              </button>
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium transition-colors",
                  previewMode === "capture" ? "bg-cyan-500/22 text-cyan-100/95" : "text-muted-fg/55 hover:text-fg/85",
                )}
                onClick={() => setPreviewMode("capture")}
                title="Inspect a preview region"
              >
                <Selection size={11} />
                Inspect
              </button>
            </div>
            <div className="pointer-events-auto absolute right-3 top-3 z-10 inline-flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-md border border-amber-300/22 bg-black/60 px-1.5 py-1 font-sans text-[10px] text-amber-50/82 shadow-lg backdrop-blur">
              <Lightning size={11} className="shrink-0 text-amber-200/80" />
              <select
                className="min-w-0 max-w-[180px] truncate rounded border-0 bg-transparent px-1 font-sans text-[10px] text-amber-50/85 outline-none hover:text-amber-50"
                value={previewAgentHelpAction}
                onChange={(event) => setPreviewAgentHelpAction(event.currentTarget.value as PreviewAgentHelpAction)}
                title={previewAgentHelpOption.description}
              >
                {PREVIEW_AGENT_HELP_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} title={option.description}>{option.label}</option>
                ))}
              </select>
              <button
                type="button"
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-amber-300/22 bg-amber-400/15 px-1.5 font-sans text-[10px] font-medium text-amber-50/90 transition-colors hover:bg-amber-400/22"
                onClick={() => void draftPreviewAgentHelp()}
                title="Insert this request into the active session input"
              >
                Ask agent
              </button>
            </div>
            {previewImage ? (
              <div
                className={cn("relative h-full", previewCaptureActive ? "cursor-crosshair" : "cursor-default")}
                onPointerDown={handlePreviewCapturePointerDown}
                onPointerMove={handlePreviewCapturePointerMove}
                onPointerUp={finishPreviewCapture}
                onPointerCancel={cancelPreviewCapture}
              >
                <div className={cn("absolute inset-0", mediaZoom > MEDIA_ZOOM_MIN ? "overflow-auto" : "overflow-hidden")}>
                  <div className="relative h-full w-full" style={mediaZoomStyle}>
                    <img
                      ref={imageRef}
                      src={previewImage.dataUrl}
                      alt={previewImage.alt}
                      className="h-full w-full object-contain"
                      draggable={false}
                    />
                    {previewCaptureActive && previewCaptureSelection && activePreviewCaptureFrame ? (
                      <div
                        className="pointer-events-none absolute left-0 top-0 rounded-[3px] border-2 border-violet-300/95 bg-violet-400/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.28),0_0_0_1px_rgba(168,85,247,0.35),0_10px_28px_rgba(88,28,135,0.22)] transition-[height,transform,width] duration-100 ease-out"
                        style={{
                          transform: `translate3d(${Math.round(previewCaptureSelection.bounds.left + (activePreviewCaptureFrame.x * previewCaptureSelection.bounds.scaleX))}px, ${Math.round(previewCaptureSelection.bounds.top + (activePreviewCaptureFrame.y * previewCaptureSelection.bounds.scaleY))}px, 0)`,
                          width: Math.max(1, activePreviewCaptureFrame.width * previewCaptureSelection.bounds.scaleX),
                          height: Math.max(1, activePreviewCaptureFrame.height * previewCaptureSelection.bounds.scaleY),
                        }}
                      />
                    ) : null}
                  </div>
                </div>
                {previewRefreshing ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 text-violet-50/75">
                    <div className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-black/55 px-3 py-2 font-sans text-[11px]">
                      <SpinnerGap size={15} className="animate-spin" />
                      Rendering preview...
                    </div>
                  </div>
                ) : null}
              </div>
            ) : previewRefreshing ? (
              <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-2 text-muted-fg/45">
                <SpinnerGap size={22} className="animate-spin" />
                <div className="font-sans text-[12px]">Rendering preview...</div>
              </div>
            ) : (
              <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-4 px-6 py-6 text-center">
                <div className="flex size-11 items-center justify-center rounded-md border border-violet-300/15 bg-violet-400/10 text-violet-100/80">
                  {previewCapability?.supported ? (
                    <BracketsCurly size={20} />
                  ) : (
                    <WarningCircle size={20} />
                  )}
                </div>
                <div className="max-w-[440px] space-y-1">
                  <div className="font-sans text-[13px] font-semibold text-fg/90">{previewIssue.title}</div>
                  <div className="font-sans text-[11px] leading-5 text-muted-fg/65">{previewIssue.detail}</div>
                  {emptyStateFileLabel ? (
                    <div className="pt-1 font-mono text-[10px] text-muted-fg/45">{emptyStateFileLabel}</div>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {previewCapability?.supported && !previewTargets.length ? (
                    <button
                      type="button"
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-300/22 bg-amber-400/12 px-3 font-sans text-[11px] font-medium text-amber-50/88 transition-colors hover:bg-amber-400/18"
                      onClick={() => {
                        setPreviewAgentHelpAction("open-simulator-in-preview");
                        void draftPreviewAgentHelp("open-simulator-in-preview");
                      }}
                    >
                      <Lightning size={12} />
                      Create preview
                    </button>
                  ) : null}
                  {!previewCapability?.supported ? (
                    <>
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-3 font-sans text-[11px] font-medium text-fg/75 transition-colors hover:text-fg/95"
                        onClick={() => void openPreviewWorkspace()}
                      >
                        <FileCode size={12} />
                        Open Xcode
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-3 font-sans text-[11px] font-medium text-fg/75 transition-colors hover:text-fg/95"
                        onClick={() => void refreshPreviewLab()}
                      >
                        <ArrowClockwise size={12} className={previewRefreshing ? "animate-spin" : undefined} />
                        Retry
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-3 font-sans text-[11px] font-medium text-fg/75 transition-colors hover:text-fg/95"
                        onClick={() => void window.ade.app.openExternal(previewCapability?.docsUrl ?? XCODE_MCP_DOCS_URL)}
                      >
                        <ArrowSquareOut size={12} />
                        Setup docs
                      </button>
                    </>
                  ) : null}
                </div>
                <details className="group w-full max-w-[440px] cursor-pointer rounded-md border border-white/[0.05] bg-black/15 px-3 py-1.5 text-left">
                  <summary className="flex items-center gap-1.5 font-sans text-[10px] text-muted-fg/50 transition-colors hover:text-fg/75 [&::-webkit-details-marker]:hidden">
                    <span className="inline-block transition-transform group-open:rotate-90">▸</span>
                    Diagnostics
                  </summary>
                  <div className="mt-2 grid grid-cols-2 gap-1.5 font-sans text-[10px] text-muted-fg/72">
                    {[
                      { label: "Xcode", value: previewCapability?.xcodeVersion ?? "checking", ok: Boolean(previewCapability?.xcodeVersion) },
                      { label: "MCP bridge", value: previewCapability?.mcpbridgeAvailable ? "found" : "not found", ok: Boolean(previewCapability?.mcpbridgeAvailable) },
                      { label: "Xcode app", value: previewCapability?.xcodeRunning ? "running" : "not running", ok: Boolean(previewCapability?.xcodeRunning) },
                      { label: "Project window", value: projectWindowValue, ok: !previewCapability?.error && Boolean(previewCapability?.selectedWindow) },
                    ].map((item) => (
                      <div key={item.label} className="flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-black/20 px-2 py-1.5">
                        {item.ok ? (
                          <CheckCircle size={12} weight="fill" className="shrink-0 text-emerald-300/85" />
                        ) : (
                          <WarningCircle size={12} weight="fill" className="shrink-0 text-rose-300/80" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-fg/72">{item.label}:</span> {item.value}
                        </span>
                      </div>
                    ))}
                  </div>
                  {previewSetupSteps.length ? (
                    <div className="mt-2 space-y-1">
                      {previewSetupSteps.slice(0, 4).map((step) => (
                        <div key={step} className="rounded-md border border-amber-300/12 bg-amber-400/[0.05] px-2 py-1 font-sans text-[10px] leading-4 text-amber-50/72">
                          {step}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </details>
              </div>
            )}
            {mediaViewToolbar}
          </div>
        ) : showLaunchProgress ? (
          <IosSimLaunchStepper
            steps={visibleLaunchProgress}
            buildRoot={launchExtras.buildRoot}
            usedInstalledBinary={launchExtras.usedInstalledBinary}
            now={nowTick}
            lastBuildMs={lastBuildMs}
            onDismiss={() => setDismissedLaunchId(visibleLaunchId)}
          />
        ) : canShowLiveVisual ? (
          <div
            className={cn(
              "relative h-full min-h-[300px]",
              controlAvailable ? "cursor-pointer" : "cursor-default",
            )}
            tabIndex={controlAvailable ? 0 : -1}
            onKeyDown={handleVideoKeyDown}
            onPointerLeave={() => setHoveredElement(null)}
            onPointerDown={handleSnapshotInteractPointerDown}
            onPointerUp={handleSnapshotInteractPointerUp}
          >
            <div
              className="pointer-events-auto absolute left-3 top-3 z-10 flex rounded-md border border-white/[0.08] bg-black/60 p-0.5 shadow-lg backdrop-blur"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium transition-colors",
                  mode === "interact" ? "bg-emerald-500/22 text-emerald-100/95" : "text-muted-fg/55 hover:text-fg/85",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  setLastSimulatorMode("interact");
                  setMode("interact");
                }}
              >
                <CursorClick size={11} />
                Control
              </button>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium text-muted-fg/55 transition-colors hover:text-fg/85"
                onClick={(event) => {
                  event.stopPropagation();
                  setLastSimulatorMode("inspect");
                  setMode("inspect");
                }}
              >
                <Selection size={11} />
                Inspect
              </button>
            </div>
            <button
              type="button"
              className={cn(
                "pointer-events-auto absolute right-3 top-3 z-10 inline-flex h-7 items-center gap-1.5 rounded-md border px-2 font-sans text-[10px] font-medium shadow-lg backdrop-blur transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                previewBridgeTone(previewBridgeAction),
              )}
              onClick={(event) => { event.stopPropagation(); void openCurrentPageInPreview(); }}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              title={previewBridgeButtonTitle}
            >
              {previewBridgeAction === "create" ? <Lightning size={11} /> : <BracketsCurly size={11} />}
              {previewBridgeButtonLabel}
            </button>
            {liveVisual?.kind === "h264" ? (
              liveVisual.url ? (
                <div className={cn("absolute inset-0", mediaZoom > MEDIA_ZOOM_MIN ? "overflow-auto" : "overflow-hidden")}>
                  <div className="relative h-full w-full" style={mediaZoomStyle}>
                    <IosSimH264Video
                      url={liveVisual.url}
                      reconnectNonce={h264ReconnectNonce}
                      onCanvas={setH264Canvas}
                      onStatus={handleH264Status}
                      onDimensions={handleH264Dimensions}
                    />
                  </div>
                </div>
              ) : (
                <div className="h-full min-h-[300px]" />
              )
            ) : liveVisual?.kind === "window" && liveVisual.sourceId ? (
              <div className={cn("absolute inset-0", mediaZoom > MEDIA_ZOOM_MIN ? "overflow-auto" : "overflow-hidden")}>
                <div className="relative h-full w-full" style={mediaZoomStyle}>
                  <video
                    ref={setVideoNode}
                    className="h-full w-full object-contain"
                    muted
                    playsInline
                  />
                </div>
              </div>
            ) : (
              <div className="h-full min-h-[300px]" />
            )}
            {liveBlocker ? (
              <IosSimVideoOverlay blocker={liveBlocker} busy={busy} onAction={handleBlockerAction} />
            ) : null}
            {mediaViewToolbar}
          </div>
        ) : mode === "inspect" && snapshotRefreshing && !snapshotImage ? (
          <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-2 text-muted-fg/45">
            <SpinnerGap size={22} className="animate-spin" />
            <div className="font-sans text-[12px]">Loading inspector...</div>
          </div>
        ) : canShowSnapshot && snapshotImage ? (
          <div
            className={cn("relative h-full min-h-[300px]", simulatorCaptureActive ? "cursor-crosshair" : "cursor-pointer")}
            onPointerMove={simulatorCaptureActive ? handleSimulatorCapturePointerMove : handleInspectPointerMove}
            onPointerLeave={() => setHoveredElement(null)}
            onPointerDown={simulatorCaptureActive ? handleSimulatorCapturePointerDown : handleInspectClick}
            onPointerUp={simulatorCaptureActive ? finishSimulatorCapture : undefined}
            onPointerCancel={simulatorCaptureActive ? cancelSimulatorCapture : undefined}
          >
            <div
              className="pointer-events-auto absolute left-3 top-3 z-10 flex flex-col items-start gap-1.5"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="flex items-center gap-1.5">
                <div className="flex rounded-md border border-white/[0.08] bg-black/60 p-0.5 shadow-lg backdrop-blur">
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium text-muted-fg/55 transition-colors hover:text-fg/85"
                    onClick={(event) => {
                      event.stopPropagation();
                      setLastSimulatorMode("interact");
                      setMode("interact");
                    }}
                  >
                    <CursorClick size={11} />
                    Control
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium transition-colors",
                      mode === "inspect" ? "bg-cyan-500/22 text-cyan-100/95" : "text-muted-fg/55 hover:text-fg/85",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      setLastSimulatorMode("inspect");
                      setMode("inspect");
                    }}
                  >
                    <Selection size={11} />
                    Inspect
                  </button>
                </div>
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-black/60 px-2 font-sans text-[10px] font-medium shadow-lg backdrop-blur transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    simulatorCaptureActive ? "text-amber-50/90 ring-1 ring-amber-300/30" : "text-muted-fg/65 hover:text-fg/90",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSimulatorCaptureSelection(null);
                    setSimulatorCaptureActive((current) => !current);
                    setHoveredElement(null);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  disabled={!snapshot?.screenshot.dataUrl || contextControlsBlocked}
                  title="Drag a screenshot region to insert it with simulator context"
                >
                  <ImageSquare size={11} />
                  Screenshot
                </button>
              </div>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-black/60 px-2 font-sans text-[10px] font-medium text-muted-fg/65 shadow-lg backdrop-blur transition-colors hover:text-fg/90 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={(event) => {
                  event.stopPropagation();
                  void refreshSnapshot({ priority: true }).catch(() => {});
                }}
                disabled={!hasActiveSession || snapshotRefreshing || contextControlsBlocked}
                title="Refresh inspector snapshot"
              >
                <ArrowClockwise size={11} className={snapshotRefreshing ? "animate-spin" : undefined} />
                Refresh
              </button>
            </div>
            <button
              type="button"
              className={cn(
                "pointer-events-auto absolute right-3 top-3 z-10 inline-flex h-7 items-center gap-1.5 rounded-md border px-2 font-sans text-[10px] font-medium shadow-lg backdrop-blur transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                previewBridgeTone(previewBridgeAction),
              )}
              onClick={(event) => { event.stopPropagation(); void openCurrentPageInPreview(); }}
              onPointerDown={(event) => event.stopPropagation()}
              title={previewBridgeButtonTitle}
            >
              {previewBridgeAction === "create" ? <Lightning size={11} /> : <BracketsCurly size={11} />}
              {previewBridgeButtonLabel}
            </button>
            <div className={cn("absolute inset-0", mediaZoom > MEDIA_ZOOM_MIN ? "overflow-auto" : "overflow-hidden")}>
              <div className="relative h-full w-full" style={mediaZoomStyle}>
                <img
                  ref={imageRef}
                  src={snapshotImage.dataUrl}
                  alt={snapshotImage.alt}
                  className="h-full w-full object-contain"
                  draggable={false}
                  onLoad={updateInspectBounds}
                />
                {mode === "inspect" && bounds && activeInspectFrame ? (
                  <div
                    className="pointer-events-none absolute left-0 top-0 rounded-[3px] border-2 border-violet-300/95 bg-violet-400/10 shadow-[0_0_0_1px_rgba(168,85,247,0.35),0_10px_28px_rgba(88,28,135,0.22)] transition-[height,opacity,transform,width] duration-100 ease-out"
                    style={{
                      transform: `translate3d(${Math.round(bounds.left + (activeInspectFrame.x * bounds.scaleX))}px, ${Math.round(bounds.top + (activeInspectFrame.y * bounds.scaleY))}px, 0)`,
                      width: Math.max(2, Math.round(activeInspectFrame.width * bounds.scaleX)),
                      height: Math.max(2, Math.round(activeInspectFrame.height * bounds.scaleY)),
                      opacity: activeInspectElement ? 1 : 0,
                    }}
                  />
                ) : null}
                {mode === "inspect" && simulatorCaptureActive && simulatorCaptureSelection && activeSimulatorCaptureFrame ? (
                  <div
                    className="pointer-events-none absolute left-0 top-0 rounded-[3px] border-2 border-violet-300/95 bg-violet-400/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.26),0_0_0_1px_rgba(168,85,247,0.35),0_10px_28px_rgba(88,28,135,0.22)] transition-[height,transform,width] duration-100 ease-out"
                    style={{
                      transform: `translate3d(${Math.round(simulatorCaptureSelection.bounds.left + (activeSimulatorCaptureFrame.x * simulatorCaptureSelection.bounds.scaleX))}px, ${Math.round(simulatorCaptureSelection.bounds.top + (activeSimulatorCaptureFrame.y * simulatorCaptureSelection.bounds.scaleY))}px, 0)`,
                      width: Math.max(1, activeSimulatorCaptureFrame.width * simulatorCaptureSelection.bounds.scaleX),
                      height: Math.max(1, activeSimulatorCaptureFrame.height * simulatorCaptureSelection.bounds.scaleY),
                    }}
                  />
                ) : null}
                {mode === "inspect" && bounds && activeInspectElement && activeInspectFrame ? (
                  <div
                    className="pointer-events-none absolute max-w-[260px] rounded-md border border-violet-300/30 bg-black/72 px-2 py-1 font-sans text-[10px] text-violet-50/90 shadow-lg backdrop-blur"
                    style={{
                      left: Math.min(bounds.left + bounds.width - 180, bounds.left + (activeInspectFrame.x * bounds.scaleX)),
                      top: Math.max(4, bounds.top + (activeInspectFrame.y * bounds.scaleY) - 30),
                    }}
                  >
                    <span className="font-medium">{elementLabel(activeInspectElement)}</span>
                    <span className="ml-1 opacity-65">{activeInspectSource}</span>
                  </div>
                ) : null}
              </div>
            </div>
            {snapshotRefreshing ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 text-cyan-50/70">
                <div className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-black/55 px-3 py-2 font-sans text-[11px]">
                  <SpinnerGap size={15} className="animate-spin" />
                  Loading inspector...
                </div>
              </div>
            ) : null}
            {mediaViewToolbar}
          </div>
        ) : hasActiveSession ? (
          // The header reads a session straight off the status, but the live
          // visual only exists after three IPC round trips. Mounting onto an
          // already-running simulator therefore showed the cyan Live chip and
          // Stop next to a body saying "No simulator running" with Launch
          // enabled. Both sides now agree: a session with no picture yet is
          // connecting, not absent.
          <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-2.5 px-6 text-center">
            <SpinnerGap size={20} className="animate-spin text-cyan-200/75" />
            <div className="font-sans text-[11px] text-muted-fg/60">Connecting to the simulator...</div>
          </div>
        ) : (
          <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="font-sans text-[14px] font-medium text-fg/85">Boot a simulator</p>
            <button
              type="button"
              className={WORK_TOOL_PRIMARY_BUTTON}
              disabled={busy || !status?.supported || !activeTarget || interactionDisabled}
              onClick={() => void launch()}
              data-testid="ios-empty-launch"
            >
              <Play size={14} weight="fill" />
              <span>Launch</span>
            </button>
            {/*
              Opening a device is not the same ask as launching an app, and it
              is the only one available when the thing to look at is already
              installed. Naming the device makes it a single click rather than a
              trip through the picker.
            */}
            {activeDevice ? (
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 font-sans text-[11px] font-medium text-fg/78 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45"
                disabled={busy || !status?.supported || interactionDisabled}
                onClick={() => void openDeviceOnly()}
                data-testid="ios-empty-open-device"
              >
                <DeviceMobile size={13} />
                <span>Open {activeDevice.name} without an app</span>
              </button>
            ) : null}
          </div>
        )}
      </div>
      {toolsVisible ? (
        <IosSimToolsColumn
          {...deviceTools}
          busy={busy}
          disabled={simulatorMutationBlocked}
        />
      ) : null}
      </div>

      {!mediaExpanded ? <div className="shrink-0 space-y-1">
        {/* Nothing to type into until something is booted. The composer used to
            sit under the "Boot a simulator" empty state with its own Send
            button, which read as a second, competing primary next to the one
            button that page exists for. */}
        {hasActiveSession && mode === "interact" && controlAvailable && !simulatorMutationBlocked && !setupBlocked ? (
          <div className="flex items-center gap-1" data-testid="ios-type-composer">
            <input
              className="min-w-0 flex-1 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 font-sans text-[10px] text-fg/75 outline-none"
              value={typedText}
              onChange={(event) => setTypedText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sendTypedText();
              }}
              placeholder="Type into the active simulator app"
            />
            <button
              type="button"
              className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-1 font-sans text-[10px] text-fg/65 transition-colors hover:text-fg/90"
              onClick={() => void sendTypedText()}
            >
              Send
            </button>
          </div>
        ) : null}
        {footerStatus ? (
          <div className="max-h-16 overflow-auto whitespace-pre-wrap break-words rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-1 font-sans text-[10px] text-muted-fg/70">
            {footerStatus}
          </div>
        ) : null}
      </div> : null}
    </div>
  );
}
