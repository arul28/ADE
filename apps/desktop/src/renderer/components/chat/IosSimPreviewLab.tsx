import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  ArrowsInSimple,
  ArrowsOutSimple,
  BracketsCurly,
  CheckCircle,
  DeviceMobile,
  FileCode,
  ImageSquare,
  Lightning,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Selection,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  AgentChatFileRef,
  IosElementContextItem,
  IosScreenElement,
  IosScreenSnapshot,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosSimulatorRenderPreviewResult,
  OpenProjectBinding,
} from "../../../shared/types";
import { inferAttachmentType } from "../../../shared/types";
import { cn } from "../ui/cn";
import { WORK_TOOL_CHROME_ROW } from "../terminals/workToolChrome";

export const XCODE_MCP_DOCS_URL = "https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode";

type PreviewMode = "control" | "capture";
type PreviewAgentHelpAction = "open-simulator-in-preview" | "add-realistic-mocks" | "fix-preview";
export type PreviewBridgeAction = "open" | "create" | "find";
type PreviewAgentPromptContext = {
  selectedElement?: IosScreenElement | null;
  previewTarget?: IosSimulatorPreviewTarget | null;
  previewMatch?: IosSimulatorPreviewMatch | null;
  previewResult?: IosSimulatorRenderPreviewResult | null;
  includePreviewAttachment?: boolean;
};

export const PREVIEW_AGENT_HELP_OPTIONS: Array<{
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

type RenderedMediaBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
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

/**
 * Whether a resolved preview match is about the element the device surface has
 * selected, rather than a leftover match for a previous selection.
 */
export function previewMatchBelongsToElement(match: IosSimulatorPreviewMatch | null, element: IosScreenElement | null): boolean {
  if (!match || !element) return false;
  if (element.sourceFile) {
    if (!match.selectedSourceFile || !swiftSourcePathsMatch(match.selectedSourceFile, element.sourceFile)) return false;
  } else if (match.selectedSourceFile) {
    return false;
  }
  if (element.sourceLine && match.selectedSourceLine && Math.abs(match.selectedSourceLine - element.sourceLine) > 3) return false;
  return true;
}

/** Which of the three bridge verbs the device surface's Preview button offers. */
export function previewBridgeActionForSelection(
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

export function previewBridgeLabel(action: PreviewBridgeAction): string {
  if (action === "open") return "Open in preview";
  if (action === "create") return "Create preview";
  return "Find preview";
}

export function previewBridgeTitle(action: PreviewBridgeAction, element: IosScreenElement | null): string {
  if (action === "open") return "Render the matching Preview Lab target for this frozen simulator selection";
  if (action === "create") {
    return element
      ? "Draft an agent task to create a Preview Lab target for this frozen simulator selection"
      : "Draft an agent task to create a Preview Lab target for the current simulator screen";
  }
  return "Find a Preview Lab target for this frozen simulator selection";
}

export function previewBridgeTone(action: PreviewBridgeAction): string {
  if (action === "open") return "border-violet-300/22 bg-black/60 text-violet-50/85 hover:bg-black/72";
  if (action === "create") return "border-amber-300/24 bg-black/60 text-amber-50/88 hover:bg-black/72";
  return "border-white/[0.10] bg-black/60 text-fg/80 hover:bg-black/72";
}

function previewTargetLabel(target: IosSimulatorPreviewTarget | null | undefined): string {
  if (!target) return "No preview";
  const file = target.sourceFile.split(/[\\/]/).pop() ?? target.sourceFile;
  return `${target.title} - ${file}`;
}

/** The env a live launch carries so the app can route itself to this preview. */
export function previewLaunchEnvironment(target: IosSimulatorPreviewTarget): Record<string, string> {
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
  event: PointerEvent<HTMLElement>,
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
  event: PointerEvent<HTMLElement>,
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

export type IosSimPreviewLabProps = {
  /** The chat this surface acts for. Reserved for ownership-scoped calls. */
  sessionId?: string | null;
  laneId?: string | null;
  projectRoot: string | null;
  runtimePin?: OpenProjectBinding | null;
  /** Non-null makes the simulator-bound action read-only, with this as the reason. */
  controlDisabledReason?: string | null;
  /**
   * The device surface's current frozen-snapshot selection, when there is one.
   * Preview Lab routes its match off it exactly as the old drawer did; with no
   * selection it falls back to the project's own previews.
   */
  selectedElement?: IosScreenElement | null;
  /**
   * Bumping the nonce runs "open the current simulator screen in Preview Lab" —
   * the device surface's preview bridge button, which lives on the device side
   * but renders its result here.
   */
  openCurrentRequest?: { nonce: number } | null;
  /**
   * Launches the app in the live simulator with this preview target as debug
   * context. Absent when the host has no device surface to launch into.
   */
  onViewInSimulator?: (target: IosSimulatorPreviewTarget) => void;
  onAddContext?: (item: IosElementContextItem) => void;
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
  onInsertDraft?: (text: string) => void;
  /** The host's surface toggle, rendered in this surface's own header. */
  headerExtra?: ReactNode;
  className?: string;
};

/**
 * Preview Lab: Xcode SwiftUI previews rendered through `xcrun mcpbridge`.
 *
 * Lifted verbatim out of the 3,000-line simulator drawer. It shares nothing
 * with the device stream — it does not need a booted simulator, only Xcode with
 * the lane's project open — so it is its own surface with its own media zoom,
 * its own crop-to-context flow, and its own agent-help prompt builder.
 */
export function IosSimPreviewLab({
  laneId = null,
  projectRoot,
  runtimePin = null,
  controlDisabledReason = null,
  selectedElement = null,
  openCurrentRequest = null,
  onViewInSimulator,
  onAddContext,
  onAddAttachment,
  onInsertDraft,
  headerExtra,
  className,
}: IosSimPreviewLabProps) {
  // Read the pin through a ref, never a dep: a local pin object is rebuilt on
  // every cross-machine merge, and depending on its identity would re-run every
  // preview effect on that timer.
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;

  const [previewMode, setPreviewMode] = useState<PreviewMode>("control");
  const [previewCapability, setPreviewCapability] = useState<IosSimulatorPreviewCapability | null>(null);
  const [previewTargets, setPreviewTargets] = useState<IosSimulatorPreviewTarget[]>([]);
  const [previewMatch, setPreviewMatch] = useState<IosSimulatorPreviewMatch | null>(null);
  const [selectedPreviewTargetId, setSelectedPreviewTargetId] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<IosSimulatorRenderPreviewResult | null>(null);
  const [previewAgentHelpAction, setPreviewAgentHelpAction] = useState<PreviewAgentHelpAction>("open-simulator-in-preview");
  const [previewCaptureSelection, setPreviewCaptureSelection] = useState<PreviewCaptureSelection | null>(null);
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [mediaExpanded, setMediaExpanded] = useState(false);
  const [mediaZoom, setMediaZoom] = useState(MEDIA_ZOOM_MIN);
  /** The last simulator screenshot, kept only as evidence for agent prompts. */
  const [snapshot, setSnapshot] = useState<IosScreenSnapshot | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  /**
   * Which tree every scoped iOS Simulator call means. An explicit `projectRoot`
   * beats `laneId` service-side, so sending both silently discards the lane.
   */
  const rootScope = useMemo(
    (): { laneId: string } | { projectRoot: string | null } => (laneId ? { laneId } : { projectRoot }),
    [laneId, projectRoot],
  );

  const selectedPreviewTarget = useMemo(() => (
    previewTargets.find((target) => target.id === selectedPreviewTargetId) ?? previewTargets[0] ?? null
  ), [previewTargets, selectedPreviewTargetId]);
  const previewCaptureActive = previewMode === "capture";
  const previewAgentHelpOption = PREVIEW_AGENT_HELP_OPTIONS.find((option) => option.value === previewAgentHelpAction)
    ?? PREVIEW_AGENT_HELP_OPTIONS[0]!;

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

  const mediaWidth = previewImage?.width ?? previewResult?.width ?? 0;
  const mediaHeight = previewImage?.height ?? previewResult?.height ?? 0;
  const activePreviewCaptureFrame = useMemo(() => (
    previewCaptureSelection && mediaWidth && mediaHeight
      ? previewCaptureFrame(previewCaptureSelection, mediaWidth, mediaHeight)
      : null
  ), [mediaHeight, mediaWidth, previewCaptureSelection]);

  const changeMediaZoom = useCallback((delta: number) => {
    setMediaZoom((current) => {
      const next = Math.round((current + delta) / MEDIA_ZOOM_STEP) * MEDIA_ZOOM_STEP;
      return Math.max(MEDIA_ZOOM_MIN, Math.min(MEDIA_ZOOM_MAX, Number(next.toFixed(2))));
    });
  }, []);

  const resetMediaZoom = useCallback(() => {
    setMediaZoom(MEDIA_ZOOM_MIN);
  }, []);

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
    void refreshPreviewLab();
  }, [refreshPreviewLab]);

  useEffect(() => {
    if (!previewCaptureActive) setPreviewCaptureSelection(null);
  }, [previewCaptureActive, previewResult?.dataUrl]);

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

  /**
   * The real screen, as evidence for the agent prompt.
   *
   * Preview Lab does not own the device surface, so it captures the snapshot on
   * demand rather than reading one the device surface happens to hold.
   */
  const attachSimulatorScreenshot = useCallback(async (): Promise<string | null> => {
    if (!onAddAttachment) return null;
    let sourceSnapshot = snapshot;
    if (!sourceSnapshot?.screenshot.dataUrl) {
      try {
        const next = await window.ade.iosSimulator.getScreenSnapshot({ ...rootScope }, runtimePinRef.current);
        sourceSnapshot = next;
        setSnapshot(next);
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
  }, [onAddAttachment, rootScope, runtimePin, snapshot]);

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

  const draftPreviewAgentHelpRef = useRef<((actionOverride?: PreviewAgentHelpAction, context?: PreviewAgentPromptContext) => Promise<void>) | null>(null);
  useEffect(() => {
    draftPreviewAgentHelpRef.current = draftPreviewAgentHelp;
  }, [draftPreviewAgentHelp]);

  const openCurrentPageInPreview = useCallback(async () => {
    const element = selectedElement;
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
  }, [previewCapability?.selectedWindow?.tabIdentifier, rootScope, selectedElement]);

  const openCurrentNonce = openCurrentRequest?.nonce ?? null;
  const openCurrentRef = useRef(openCurrentPageInPreview);
  openCurrentRef.current = openCurrentPageInPreview;
  useEffect(() => {
    if (openCurrentNonce === null) return;
    void openCurrentRef.current();
  }, [openCurrentNonce]);

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

  let previewModeHint: string | null;
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
  const footerStatus = message ?? previewModeHint;

  let projectWindowValue: string;
  if (previewCapability?.error) {
    projectWindowValue = "not checked";
  } else if (previewCapability?.selectedWindow) {
    projectWindowValue = "connected";
  } else {
    projectWindowValue = "not connected";
  }

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
        aria-label={mediaExpanded ? "Exit expanded preview view" : "Expand preview view"}
        title={mediaExpanded ? "Exit expanded preview view" : "Expand preview view"}
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
        aria-label="Zoom out preview view"
        title="Zoom out preview view"
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
        aria-label="Reset preview zoom"
        title="Reset preview zoom"
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
        aria-label="Zoom in preview view"
        title="Zoom in preview view"
      >
        <MagnifyingGlassPlus size={13} />
      </button>
    </div>
  );

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", mediaExpanded ? "gap-0" : "gap-1", className)}
      data-testid="ios-preview-lab"
    >
      <div className={cn("shrink-0", mediaExpanded ? "hidden" : null)}>
        <div className={WORK_TOOL_CHROME_ROW} data-testid="ios-preview-chrome">
          <span className="min-w-0 truncate px-2 text-[12px] text-muted-fg">Xcode previews</span>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">{headerExtra}</div>
        </div>

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
            {onViewInSimulator ? (
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-300/20 bg-emerald-400/10 px-2 font-sans text-[11px] font-medium text-emerald-50/85 transition-colors hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!selectedPreviewTarget || Boolean(controlDisabledReason)}
                onClick={() => {
                  if (selectedPreviewTarget) onViewInSimulator(selectedPreviewTarget);
                }}
                title="Launch the app in the live simulator with this preview target as debug context"
              >
                <DeviceMobile size={13} />
                View in simulator
              </button>
            ) : null}
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
      </div>

      <div className="flex min-h-0 flex-1 gap-1.5">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-white/[0.08] bg-white/[0.02]">
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
        </div>
      </div>

      {!mediaExpanded && footerStatus ? (
        <div className="shrink-0 max-h-16 overflow-auto whitespace-pre-wrap break-words rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-1 font-sans text-[10px] text-muted-fg/70">
          {footerStatus}
        </div>
      ) : null}
    </div>
  );
}
