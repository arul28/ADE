import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { ArrowClockwise, ArrowSquareOut, ArrowsInSimple, ArrowsOutSimple, BracketsCurly, CheckCircle, Circle, Copy, CursorClick, Desktop, DeviceMobile, FileCode, ImageSquare, Lightning, Lock, MagnifyingGlassMinus, MagnifyingGlassPlus, Play, Power, Selection, SpinnerGap, WarningCircle, Wrench } from "@phosphor-icons/react";
import type {
  AgentChatFileRef,
  IosElementContextItem,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewTarget,
  IosSimulatorRenderPreviewResult,
  IosScreenElement,
  IosScreenSnapshot,
  IosSimulatorDevice,
  IosSimulatorLaunchProgress,
  IosSimulatorLaunchTarget,
  IosSimulatorDrawerMode,
  IosSimulatorStreamStatus,
  IosSimulatorStatus,
  IosSimulatorToolStatus,
  IosSimulatorWindowState,
  IosSimulatorWindowSource,
} from "../../../shared/types";
import { IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE, inferAttachmentType } from "../../../shared/types";
import { cn } from "../ui/cn";

const XCODE_MCP_DOCS_URL = "https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode";

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
};

type RenderedMediaBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
};

type WindowScreenRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  source: "matched" | "heuristic";
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

type LiveVisual =
  {
    kind: "window";
    status: "starting" | "reconnecting" | "active" | "error";
    sourceId: string | null;
    sourceName: string | null;
    width: number | null;
    height: number | null;
    error: string | null;
  };

type VideoFrameMetadata = {
  presentationTime?: number;
  expectedDisplayTime?: number;
  width?: number;
  height?: number;
};

type VideoFrameRequestElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

type ToolKey = IosSimulatorToolStatus["name"];

type ToolDescriptor = {
  title: string;
  description: string;
  required: boolean;
};

const MEDIA_ZOOM_MIN = 1;
const MEDIA_ZOOM_MAX = 2;
const MEDIA_ZOOM_STEP = 0.25;

const TOOL_DESCRIPTORS: Record<ToolKey, ToolDescriptor> = {
  xcrun: {
    title: "Xcode command-line tools",
    description: "Required to drive the iOS Simulator from the command line.",
    required: true,
  },
  xcodebuild: {
    title: "Xcode",
    description: "Needed to build and install your app onto the simulator.",
    required: true,
  },
  simulator_window: {
    title: "Live simulator",
    description: "Required to show the running simulator in ADE.",
    required: true,
  },
  idb: {
    title: "Simulator controls",
    description: "Optional support for tap, drag, typing, and inspection.",
    required: false,
  },
  idb_companion: {
    title: "Simulator controls",
    description: "Optional support for tap, drag, typing, and inspection.",
    required: false,
  },
};

function makeReactKeysById<T extends { id: string }>(items: T[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const collisions = seen.get(item.id) ?? 0;
    seen.set(item.id, collisions + 1);
    return collisions === 0 ? item.id : `${item.id}:${index}`;
  });
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

function liveViewMessage(message: string): string {
  return message
    .replaceAll("Simulator.app", "Simulator")
    .replace(/Simulator window capture/gi, "Live view")
    .replace(/window capture/gi, "live view")
    .replace(/visual stream/gi, "live view")
    .replace(/live window stream/gi, "live view");
}

function pickSimulatorWindowSource(
  sources: IosSimulatorWindowSource[],
  device: IosSimulatorDevice | null,
): IosSimulatorWindowSource | null {
  if (!sources.length) return null;
  const deviceName = device?.name.toLowerCase() ?? "";
  return [...sources]
    .filter((source) => !/developer tools|devtools|ade/i.test(source.name))
    .map((source) => {
      const name = source.name.toLowerCase();
      let score = 0;
      if (deviceName && name.includes(deviceName)) score += 80;
      if (name.includes("simulator")) score += 50;
      if (/\biphone\b|\bipad\b|\bios\b/.test(name)) score += 30;
      if (name.includes("apple tv") || name.includes("watch")) score -= 20;
      return { source, score };
    })
    .filter(({ source, score }) => {
      const name = source.name.toLowerCase();
      if (deviceName) return name.includes(deviceName) || name.includes("simulator");
      return score >= 50;
    })
    .sort((a, b) => b.score - a.score || a.source.name.localeCompare(b.source.name))[0]?.source ?? null;
}

function buildDesktopCaptureConstraints(sourceId: string, maxFrameRate: number): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        minFrameRate: Math.min(30, maxFrameRate),
        maxFrameRate,
      },
      optional: [{ cursor: "never" }],
    },
  } as unknown as MediaStreamConstraints;
}

function elementLabel(element: IosScreenElement | null): string {
  if (!element) return "Coordinate fallback";
  return element.label || element.identifier || element.value || element.componentId || element.elementType || element.role || element.id;
}

function sourceTone(source: IosScreenElement["source"] | "coordinate"): string {
  if (source === "ade-inspector") return "border-emerald-300/55 bg-emerald-400/10 text-emerald-50";
  if (source === "accessibility") return "border-cyan-300/55 bg-cyan-400/10 text-cyan-50";
  return "border-amber-300/55 bg-amber-400/10 text-amber-50";
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

function isLaunchTargetErrorMessage(message: string | null): boolean {
  if (!message) return false;
  return message.includes("ade.iosSimulator.listLaunchTargets") || /Project root .* does not exist/u.test(message);
}

function frameArea(element: IosScreenElement): number {
  return Math.max(1, element.pixelFrame.width) * Math.max(1, element.pixelFrame.height);
}

function rectArea(frame: IosScreenElement["pixelFrame"]): number {
  return Math.max(0, frame.width) * Math.max(0, frame.height);
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

function shouldShowInspectElement(element: IosScreenElement, snapshot: IosScreenSnapshot, selected: IosScreenElement | null, hovered: IosScreenElement | null): boolean {
  if (selected?.id === element.id || hovered?.id === element.id) return true;
  const screenshotWidth = snapshot.screenshot.width ?? snapshot.screen.width;
  const screenshotHeight = snapshot.screenshot.height ?? snapshot.screen.height;
  if (!screenshotWidth || !screenshotHeight) return true;
  const frame = clampFrame(element.pixelFrame, screenshotWidth, screenshotHeight);
  if (frame.width < 4 || frame.height < 4) return false;
  const screenArea = screenshotWidth * screenshotHeight;
  const areaRatio = rectArea(frame) / Math.max(1, screenArea);
  const isNearlyFullscreen = areaRatio > 0.72
    || (frame.x <= 2 && frame.y <= 2 && frame.width >= screenshotWidth - 4 && frame.height >= screenshotHeight - 4);
  if (isNearlyFullscreen) return false;
  if (areaRatio > 0.35 && !element.sourceFile && !element.componentId && !element.identifier && !element.label && !element.value) {
    return false;
  }
  return hasSelectableIdentity(element);
}

function visibleInspectElements(snapshot: IosScreenSnapshot, selected: IosScreenElement | null, hovered: IosScreenElement | null): IosScreenElement[] {
  const screenshotWidth = snapshot.screenshot.width ?? snapshot.screen.width;
  const screenshotHeight = snapshot.screenshot.height ?? snapshot.screen.height;
  const seen = new Set<string>();
  return snapshot.elements
    .filter((element) => shouldShowInspectElement(element, snapshot, selected, hovered))
    .filter((element) => {
      const frame = screenshotWidth && screenshotHeight
        ? clampFrame(element.pixelFrame, screenshotWidth, screenshotHeight)
        : element.pixelFrame;
      const signature = [
        Math.round(frame.x / 2) * 2,
        Math.round(frame.y / 2) * 2,
        Math.round(frame.width / 2) * 2,
        Math.round(frame.height / 2) * 2,
        element.sourceFile || element.componentId || element.identifier || element.label || element.role || element.id,
      ].join(":");
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .sort((a, b) => {
      const selectedA = selected?.id === a.id ? -1 : 0;
      const selectedB = selected?.id === b.id ? -1 : 0;
      if (selectedA !== selectedB) return selectedA - selectedB;
      const hoveredA = hovered?.id === a.id ? -1 : 0;
      const hoveredB = hovered?.id === b.id ? -1 : 0;
      if (hoveredA !== hoveredB) return hoveredA - hoveredB;
      return frameArea(a) - frameArea(b);
    })
    .slice(0, 120);
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load iOS snapshot for window calibration."));
    image.src = src;
  });
}

function heuristicWindowScreenRect(
  videoWidth: number,
  videoHeight: number,
  screenWidth: number | null | undefined,
  screenHeight: number | null | undefined,
): WindowScreenRect | null {
  if (videoWidth <= 0 || videoHeight <= 0 || !screenWidth || !screenHeight) return null;
  const aspect = screenWidth / screenHeight;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  const widthLimited = videoWidth * 0.91;
  const heightLimited = videoHeight * 0.9 * aspect;
  const width = Math.min(widthLimited, heightLimited);
  const height = width / aspect;
  const residualX = Math.max(0, videoWidth - width);
  const residualY = Math.max(0, videoHeight - height);
  return {
    x: residualX / 2,
    y: Math.min(residualY, Math.max(videoHeight * 0.065, residualY * 0.82)),
    width,
    height,
    confidence: 0.45,
    source: "heuristic",
  };
}

function luminanceAt(data: Uint8ClampedArray, index: number): number {
  return (data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114);
}

async function calibrateWindowScreenRect(
  video: HTMLVideoElement,
  snapshot: IosScreenSnapshot,
): Promise<WindowScreenRect | null> {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  const screenWidth = snapshot.screenshot.width;
  const screenHeight = snapshot.screenshot.height;
  const fallback = heuristicWindowScreenRect(videoWidth, videoHeight, screenWidth, screenHeight);
  if (!fallback || !snapshot.screenshot.dataUrl || video.readyState < video.HAVE_CURRENT_DATA) return fallback;

  try {
    const image = await loadImage(snapshot.screenshot.dataUrl);
    const aspect = screenWidth && screenHeight ? screenWidth / screenHeight : image.naturalWidth / image.naturalHeight;
    const sampleWidth = 28;
    const sampleHeight = Math.max(40, Math.round(sampleWidth / aspect));

    const referenceCanvas = document.createElement("canvas");
    referenceCanvas.width = sampleWidth;
    referenceCanvas.height = sampleHeight;
    const referenceCtx = referenceCanvas.getContext("2d", { willReadFrequently: true });
    if (!referenceCtx) return fallback;
    referenceCtx.drawImage(image, 0, 0, sampleWidth, sampleHeight);
    const reference = referenceCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;

    const videoCanvas = document.createElement("canvas");
    videoCanvas.width = videoWidth;
    videoCanvas.height = videoHeight;
    const videoCtx = videoCanvas.getContext("2d");
    if (!videoCtx) return fallback;
    videoCtx.drawImage(video, 0, 0, videoWidth, videoHeight);

    const candidateCanvas = document.createElement("canvas");
    candidateCanvas.width = sampleWidth;
    candidateCanvas.height = sampleHeight;
    const candidateCtx = candidateCanvas.getContext("2d", { willReadFrequently: true });
    if (!candidateCtx) return fallback;

    let bestRect: WindowScreenRect = fallback;
    let bestScore = Number.POSITIVE_INFINITY;
    const heightScales = [0.96, 0.98, 1, 1.02, 1.04];
    const xOffsets = [-0.04, -0.025, -0.01, 0, 0.01, 0.025, 0.04];
    const yOffsets = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06];

    for (const heightScale of heightScales) {
      const height = fallback.height * heightScale;
      const width = height * aspect;
      if (width <= 0 || height <= 0 || width > videoWidth || height > videoHeight) continue;
      const baseX = fallback.x + ((fallback.width - width) / 2);
      const baseY = fallback.y + ((fallback.height - height) / 2);
      for (const xOffset of xOffsets) {
        for (const yOffset of yOffsets) {
          const x = Math.max(0, Math.min(videoWidth - width, baseX + (videoWidth * xOffset)));
          const y = Math.max(0, Math.min(videoHeight - height, baseY + (videoHeight * yOffset)));
          candidateCtx.clearRect(0, 0, sampleWidth, sampleHeight);
          candidateCtx.drawImage(videoCanvas, x, y, width, height, 0, 0, sampleWidth, sampleHeight);
          const candidate = candidateCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
          let score = 0;
          for (let index = 0; index < reference.length; index += 4) {
            score += Math.abs(luminanceAt(reference, index) - luminanceAt(candidate, index));
          }
          score /= reference.length / 4;
          if (score < bestScore) {
            bestScore = score;
            bestRect = {
              x,
              y,
              width,
              height,
              confidence: Math.max(0, Math.min(1, 1 - (score / 255))),
              source: "matched",
            };
          }
        }
      }
    }
    return bestRect.confidence > 0.55 ? bestRect : fallback;
  } catch {
    return fallback;
  }
}

function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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
}: ChatIosSimulatorPanelProps) {
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
  const [selectedPreviewTargetId, setSelectedPreviewTargetId] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<IosSimulatorRenderPreviewResult | null>(null);
  const [previewAgentHelpAction, setPreviewAgentHelpAction] = useState<PreviewAgentHelpAction>("open-simulator-in-preview");
  const [previewCaptureSelection, setPreviewCaptureSelection] = useState<PreviewCaptureSelection | null>(null);
  const [simulatorCaptureActive, setSimulatorCaptureActive] = useState(false);
  const [simulatorCaptureSelection, setSimulatorCaptureSelection] = useState<PreviewCaptureSelection | null>(null);
  const [liveVisual, setLiveVisual] = useState<LiveVisual | null>(null);
  const [windowScreenRect, setWindowScreenRect] = useState<WindowScreenRect | null>(null);
  const [simulatorWindowState, setSimulatorWindowState] = useState<IosSimulatorWindowState | null>(null);
  const [streamStatus, setStreamStatus] = useState<IosSimulatorStreamStatus | null>(null);
  const [launchProgress, setLaunchProgress] = useState<IosSimulatorLaunchProgress[]>([]);
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const windowScreenRectRef = useRef<WindowScreenRect | null>(null);
  const liveFrameCountRef = useRef(0);
  const liveFrameWindowStartRef = useRef(0);
  const windowCaptureRecoveryTimerRef = useRef<number | null>(null);
  const windowCaptureRecoveryAttemptedAtRef = useRef(0);
  const lastWindowFrameAtRef = useRef(0);
  const suppressNextSelectionEventRef = useRef(false);
  const dragStartRef = useRef<DragStart | null>(null);
  const snapshotRefreshInFlightRef = useRef(false);
  const snapshotRefreshSequenceRef = useRef(0);

  const activeDevice = useMemo(() => {
    if (selectedDeviceUdid) return devices.find((device) => device.udid === selectedDeviceUdid) ?? null;
    return status?.activeDevice ?? devices[0] ?? null;
  }, [devices, selectedDeviceUdid, status?.activeDevice]);
  const activeSession = status?.activeSession ?? null;
  const controlsDisabled = Boolean(controlDisabledReason);
  const controlsDisabledMessage = controlDisabledReason ?? "This iOS Simulator session is read-only from the current lane.";

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
  const liveWidth = liveVisual?.width ?? videoRef.current?.videoWidth ?? imageRef.current?.naturalWidth ?? null;
  const liveHeight = liveVisual?.height ?? videoRef.current?.videoHeight ?? imageRef.current?.naturalHeight ?? null;
  const liveVisualKind = liveVisual?.kind ?? null;
  const liveWindowSourceId = liveVisual?.kind === "window" ? liveVisual.sourceId : null;
  const liveWindowHeight = liveVisual?.kind === "window" ? liveVisual.height : null;
  const liveWindowWidth = liveVisual?.kind === "window" ? liveVisual.width : null;
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
  const liveVisualUsesSimulatorWindow = mode === "interact" && liveVisualKind === "window";
  let mediaWidth: number;
  let mediaHeight: number;
  if (mode === "interact") {
    if (liveVisualUsesSimulatorWindow) {
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
  const mediaZoomStyle: CSSProperties | undefined = mediaZoom > MEDIA_ZOOM_MIN
    ? {
        width: `${Math.round(mediaZoom * 100)}%`,
        height: `${Math.round(mediaZoom * 100)}%`,
      }
    : undefined;
  const mediaZoomLabel = `${Math.round(mediaZoom * 100)}%`;

  const toolByName = useMemo(() => new Map((status?.tools ?? []).map((tool) => [tool.name, tool])), [status?.tools]);
  const idbInputAvailable = (toolByName.get("idb")?.available ?? false)
    && (toolByName.get("idb_companion")?.available ?? false);
  const controlAvailable = idbInputAvailable;

  const missingRequiredTools = useMemo(() => (
    (status?.tools ?? []).filter((tool) => !tool.available && (TOOL_DESCRIPTORS[tool.name]?.required ?? false))
  ), [status?.tools]);
  const showSetupChecklist = Boolean(status?.supported) && missingRequiredTools.length > 0;
  const bestPerformanceItems = useMemo(() => {
    const xcode = toolByName.get("xcodebuild");
    const xcrun = toolByName.get("xcrun");
    const simulatorWindow = toolByName.get("simulator_window");
    const idb = toolByName.get("idb");
    const companion = toolByName.get("idb_companion");
    return [
      {
        key: "simulator-window-stream",
        label: "Simulator live view",
        ok: Boolean(simulatorWindow?.available),
        detail: simulatorWindow?.available
          ? "Ready to show the running simulator in ADE."
          : simulatorWindow?.detail || "Install an iOS Simulator runtime in Xcode Settings.",
      },
      {
        key: "xcode-runtime",
        label: "Xcode and iOS runtime",
        ok: Boolean(xcode?.available && xcrun?.available && simulatorWindow?.available),
        detail: xcode?.available && xcrun?.available && simulatorWindow?.available
          ? "Build, boot, launch, and screenshot commands are available."
          : "Install full Xcode and an iOS Simulator runtime in Xcode Settings.",
      },
      {
        key: "input-tools",
        label: "Input and inspection",
        ok: Boolean(idb?.available && companion?.available),
        detail: idb?.available && companion?.available
          ? "Tap, drag, type, and inspect actions are ready."
          : "Tap, drag, type, and inspect actions are unavailable on this Mac.",
      },
    ];
  }, [toolByName]);
  const bestPerformanceReady = bestPerformanceItems.every((item) => item.ok);
  const bestPerformanceMissingCount = bestPerformanceItems.filter((item) => !item.ok).length;
  const showBestPerformanceChecklist = Boolean(status?.supported) && !showSetupChecklist;
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
        detail: "Install or select Xcode 26.3 or newer so `xcrun mcpbridge` is available on this Mac.",
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
        detail: "The preview lab is connected to Xcode, but it could not find a nearby `#Preview` or `PreviewProvider`. Ask the agent to add one so this screen can render without the simulator.",
      };
    }
    return {
      title: "Ready to render Xcode previews",
      detail: "Choose a preview target, render it, then use Capture area to drag exact preview context into the active session.",
    };
  }, [previewCapability, previewTargets.length]);
  const emptyStateFileLabel = useMemo(() => {
    if (!previewCapability?.supported || previewTargets.length) return null;
    return selectedElement?.sourceFile ?? null;
  }, [previewCapability?.supported, previewTargets.length, selectedElement?.sourceFile]);
  const previewReady = Boolean(previewCapability?.supported && selectedPreviewTarget);
  const previewTargetSource = selectedPreviewTarget
    ? `${selectedPreviewTarget.sourceFile}:${selectedPreviewTarget.sourceLine}`
    : null;
  const previewSuggestionReason = selectedElement?.sourceFile
    ? `Matched from simulator selection: ${elementLabel(selectedElement)}`
    : selectedPreviewTarget
      ? "Selected preview target"
      : "No preview target selected";

  const otherChatSessionId = useMemo(() => {
    if (ignoreChatOwnership) return null;
    const owner = activeSession?.chatSessionId ?? null;
    if (!owner) return null;
    if (!sessionId) return owner;
    return owner !== sessionId ? owner : null;
  }, [activeSession?.chatSessionId, ignoreChatOwnership, sessionId]);
  const ownedByOtherChat = otherChatSessionId !== null;
  const contextControlsBlocked = controlsDisabled;
  const simulatorMutationBlocked = ownedByOtherChat || controlsDisabled;
  const inputBlockedMessage = ownedByOtherChat
    ? "Another chat is already connected to the simulator. Use Take over to claim it."
    : controlsDisabledMessage;
  const simulatorControlUnavailable = mode === "interact" && !controlAvailable;
  const liveInputBlocked = simulatorMutationBlocked || simulatorControlUnavailable;
  const liveInputBlockedMessage = simulatorMutationBlocked
    ? inputBlockedMessage
    : "Simulator controls are unavailable on this Mac.";

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

  const syncExistingStreamStatus = useCallback((nextStreamStatus: IosSimulatorStreamStatus | null) => {
    if (!nextStreamStatus) return;
    setStreamStatus(nextStreamStatus);
  }, []);

  const refreshStatus = useCallback(async () => {
    const [nextStatus, nextDevices, nextStreamStatus] = await Promise.all([
      window.ade.iosSimulator.getStatus(),
      window.ade.iosSimulator.listDevices(),
      window.ade.iosSimulator.getStreamStatus().catch(() => null),
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
      await window.ade.iosSimulator.shutdown({ force });
      await refreshStatus();
      setSnapshot(null);
      setSelectedElement(null);
      setHoveredElement(null);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [controlsDisabled, controlsDisabledMessage, refreshStatus]);

  const takeOver = useCallback(async () => {
    const stopped = await shutdownSimulator(true);
    if (!stopped) return;
    setMessage("Reconnecting simulator to this session...");
    void launchRef.current?.();
  }, [shutdownSimulator]);

  const copyInstallHint = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`Copied: ${text}`);
    } catch {
      setMessage("Could not copy to clipboard.");
    }
  }, []);

  const refreshLaunchTargets = useCallback(async (deviceUdid?: string | null) => {
    const nextTargets = await window.ade.iosSimulator.listLaunchTargets({ deviceUdid, projectRoot });
    setLaunchTargets(nextTargets);
    setSelectedTargetId((current) => (
      current && nextTargets.some((target) => target.id === current)
        ? current
        : nextTargets[0]?.id ?? null
    ));
    setMessage((current) => (isLaunchTargetErrorMessage(current) ? null : current));
  }, [projectRoot]);

  const refreshPreviewLab = useCallback(async () => {
    setPreviewRefreshing(true);
    setMessage("Checking Xcode preview bridge. If Xcode asks for access, click Allow and keep ADE open while this finishes.");
    try {
      const sourceFile = selectedElement?.sourceFile ?? null;
      const sourceLine = selectedElement?.sourceLine ?? null;
      const [capability, targets] = await Promise.all([
        window.ade.iosSimulator.getPreviewCapability({ projectRoot, sourceFile, sourceLine }),
        window.ade.iosSimulator.listPreviewTargets({ projectRoot, sourceFile, sourceLine }),
      ]);
      setPreviewCapability(capability);
      setPreviewTargets(targets);
      setSelectedPreviewTargetId((current) => (
        current && targets.some((target) => target.id === current)
          ? current
          : targets[0]?.id ?? null
      ));
      if (!capability.supported) {
        setMessage(previewStatusLabel(capability, targets));
      } else if (!targets.length) {
        setMessage("No #Preview found near the selected source.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewRefreshing(false);
    }
  }, [projectRoot, selectedElement?.sourceFile, selectedElement?.sourceLine]);

  const stopRendererLiveVisual = useCallback((options: { preserveVisual?: boolean } = {}) => {
    const preserveVisual = options.preserveVisual === true;
    if (windowCaptureRecoveryTimerRef.current != null) {
      window.clearTimeout(windowCaptureRecoveryTimerRef.current);
      windowCaptureRecoveryTimerRef.current = null;
    }
    const video = videoRef.current as VideoFrameRequestElement | null;
    if (video && videoFrameCallbackRef.current != null && video.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
    }
    videoFrameCallbackRef.current = null;
    liveStreamRef.current?.getTracks().forEach((track) => track.stop());
    liveStreamRef.current = null;
    if (video) video.srcObject = null;
    liveFrameCountRef.current = 0;
    liveFrameWindowStartRef.current = 0;
    lastWindowFrameAtRef.current = 0;
    if (preserveVisual) {
      setLiveVisual((current) => current ? { ...current, status: "reconnecting", error: null } : current);
      return;
    }
    windowScreenRectRef.current = null;
    setWindowScreenRect(null);
    setLiveVisual(null);
  }, []);

  const trackWindowVideoFrames = useCallback((video: HTMLVideoElement) => {
    const frameVideo = video as VideoFrameRequestElement;
    if (!frameVideo.requestVideoFrameCallback) return;
    liveFrameCountRef.current = 0;
    liveFrameWindowStartRef.current = performance.now();
    const onFrame = (now: number, metadata: VideoFrameMetadata) => {
      lastWindowFrameAtRef.current = Date.now();
      liveFrameCountRef.current += 1;
      const elapsedMs = Math.max(1, now - liveFrameWindowStartRef.current);
      if (elapsedMs >= 1_000) {
        const fps = Math.round((liveFrameCountRef.current * 1000) / elapsedMs);
        liveFrameCountRef.current = 0;
        liveFrameWindowStartRef.current = now;
        setStreamStatus((current) => current && current.backend === "simulator-window-capture"
          ? {
              ...current,
              fps,
              frameCount: current.frameCount + fps,
              lastFrameAt: new Date().toISOString(),
            }
          : current);
      }
      if (metadata.width || metadata.height) {
        setLiveVisual((current) => current?.kind === "window"
          ? {
              ...current,
              status: "active",
              width: metadata.width ?? current.width,
              height: metadata.height ?? current.height,
            }
          : current);
      }
      videoFrameCallbackRef.current = frameVideo.requestVideoFrameCallback?.(onFrame) ?? null;
    };
    videoFrameCallbackRef.current = frameVideo.requestVideoFrameCallback(onFrame);
  }, []);

  const startWindowCaptureVisual = useCallback(async (device: IosSimulatorDevice) => {
    const status = await window.ade.iosSimulator.startStream({ deviceUdid: device.udid, backend: "simulator-window-capture", fps: 60 });
    setStreamStatus(status);
    setLiveVisual({
      kind: "window",
      status: "starting",
      sourceId: null,
      sourceName: null,
      width: null,
      height: null,
      error: null,
    });
    let source: IosSimulatorWindowSource | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      source = pickSimulatorWindowSource(await window.ade.iosSimulator.listSimulatorWindowSources(), device);
      if (source) break;
      await wait(250);
    }
    if (!source) throw new Error(`ADE could not find ${device.name}. Launch the simulator from ADE to start the live view.`);
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("ADE cannot show the simulator in this window.");
    const stream = await navigator.mediaDevices.getUserMedia(buildDesktopCaptureConstraints(source.id, 60));
    liveStreamRef.current = stream;
    setLiveVisual({
      kind: "window",
      status: "active",
      sourceId: source.id,
      sourceName: source.name,
      width: null,
      height: null,
      error: null,
    });
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const stream = liveStreamRef.current;
    if (!video || !stream || liveVisualKind !== "window") return;
    video.srcObject = stream;
    void video.play().then(() => {
      setLiveVisual((current) => current?.kind === "window"
        ? {
            ...current,
            status: "active",
            width: video.videoWidth || current.width,
            height: video.videoHeight || current.height,
          }
        : current);
      trackWindowVideoFrames(video);
    }).catch((error) => {
      setLiveVisual((current) => current?.kind === "window"
        ? { ...current, status: "error", error: error instanceof Error ? error.message : String(error) }
        : current);
    });
  }, [liveVisualKind, liveWindowSourceId, trackWindowVideoFrames]);

  useEffect(() => {
    windowScreenRectRef.current = windowScreenRect;
  }, [windowScreenRect]);

  const refreshSnapshot = useCallback(async (options: { silent?: boolean; priority?: boolean } = {}) => {
    const deviceUdid = selectedDeviceUdid ?? activeDevice?.udid ?? undefined;
    if (snapshotRefreshInFlightRef.current && options.silent && !options.priority) return;
    const sequence = snapshotRefreshSequenceRef.current + 1;
    snapshotRefreshSequenceRef.current = sequence;
    snapshotRefreshInFlightRef.current = true;
    if (!options.silent) setBusy(true);
    setSnapshotRefreshing(true);
    try {
      const next = await window.ade.iosSimulator.getScreenSnapshot({ deviceUdid, projectRoot });
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
  }, [activeDevice?.udid, projectRoot, selectedDeviceUdid]);

  const scheduleWindowCaptureRecovery = useCallback((reason: string) => {
    if (
      mode !== "interact"
      || !activeDevice
      || !activeSession
      || activeSession.deviceUdid !== activeDevice.udid
      || liveVisualKind !== "window"
    ) {
      return;
    }
    if (windowCaptureRecoveryTimerRef.current != null) return;
    const now = Date.now();
    if (now - windowCaptureRecoveryAttemptedAtRef.current < 2_500) return;
    windowCaptureRecoveryAttemptedAtRef.current = now;
    setMessage(`${reason} Restoring the live view...`);
    windowCaptureRecoveryTimerRef.current = window.setTimeout(() => {
      windowCaptureRecoveryTimerRef.current = null;
      void (async () => {
        try {
          stopRendererLiveVisual();
          await window.ade.iosSimulator.stopStream().catch(() => {});
          await startWindowCaptureVisual(activeDevice);
          void refreshSnapshot({ silent: true, priority: true });
        } catch (windowError) {
          const windowMessage = liveViewMessage(windowError instanceof Error ? windowError.message : String(windowError));
          setLiveVisual({
            kind: "window",
            status: "error",
            sourceId: null,
            sourceName: null,
            width: null,
            height: null,
            error: `Could not restore the live view. ${windowMessage}`,
          });
          setMessage(`Could not restore the live view. ${windowMessage}`);
        }
      })().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setLiveVisual({
          kind: "window",
          status: "error",
          sourceId: null,
          sourceName: null,
          width: null,
          height: null,
          error: `Live view failed. ${message}`,
        });
        setMessage(`Live view failed. ${message}`);
      });
    }, 250);
  }, [
    activeDevice,
    activeSession,
    liveVisualKind,
    mode,
    refreshSnapshot,
    startWindowCaptureVisual,
    stopRendererLiveVisual,
  ]);

  const armWindowCaptureRecoveryAfterInput = useCallback(() => {
    if (mode !== "interact" || liveVisualKind !== "window") return;
    const previousFrameAt = lastWindowFrameAtRef.current;
    if (windowCaptureRecoveryTimerRef.current != null) {
      window.clearTimeout(windowCaptureRecoveryTimerRef.current);
      windowCaptureRecoveryTimerRef.current = null;
    }
    windowCaptureRecoveryTimerRef.current = window.setTimeout(() => {
      windowCaptureRecoveryTimerRef.current = null;
      if (lastWindowFrameAtRef.current <= previousFrameAt) {
        scheduleWindowCaptureRecovery("The simulator view did not update after input.");
      }
    }, 1_500);
  }, [liveVisualKind, mode, scheduleWindowCaptureRecovery]);

  useEffect(() => {
    void refreshStatus().catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refreshStatus]);

  useEffect(() => {
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
      if (event.type === "launch-progress") {
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
        setStreamStatus(event.status);
        if (event.type === "stream-error") {
          const errorMessage = event.status.lastError ? liveViewMessage(event.status.lastError) : null;
          setLiveVisual((current) => current ? { ...current, status: "error", error: errorMessage ?? current.error } : current);
          if (errorMessage) setMessage(errorMessage);
        }
        return;
      }
      if (event.type === "session-released") {
        setSnapshot(null);
        setSelectedElement(null);
        setHoveredElement(null);
        setLaunchProgress([]);
        void refreshStatus().catch(() => {});
        return;
      }
      if (event.type === "session-updated" || event.type === "session-started") {
        void refreshStatus().catch(() => {});
        return;
      }
    });
    return () => {
      unsubscribe();
    };
  }, [onAddContext, refreshStatus, sessionId]);

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

  useEffect(() => {
    if (mode !== "inspect" || !activeDevice || !status?.supported) return;
    if (!activeSession) return;
    void refreshSnapshot({ priority: true }).catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [activeDevice, activeSession, mode, refreshSnapshot, status?.supported]);

  useEffect(() => {
    if (mode !== "interact") {
      stopRendererLiveVisual();
      void window.ade.iosSimulator.stopStream().catch(() => {});
      return;
    }
    if (!status) return;
    if (!activeDevice || !status.supported) {
      stopRendererLiveVisual();
      void window.ade.iosSimulator.stopStream().catch(() => {});
      return;
    }
    if (!activeSession || activeSession.deviceUdid !== activeDevice.udid) {
      stopRendererLiveVisual();
      void window.ade.iosSimulator.stopStream().catch(() => {});
      return;
    }
    let cancelled = false;
    const device = activeDevice;
    void (async () => {
      try {
        stopRendererLiveVisual();
        await window.ade.iosSimulator.stopStream().catch(() => {});
        await startWindowCaptureVisual(device);
        if (cancelled) {
          stopRendererLiveVisual();
        }
      } catch (streamError) {
        if (cancelled) return;
        const message = liveViewMessage(streamError instanceof Error ? streamError.message : String(streamError));
        setLiveVisual({
          kind: "window",
          status: "error",
          sourceId: null,
          sourceName: null,
          width: null,
          height: null,
          error: `Could not start the live view. ${message}`,
        });
        setMessage(`Could not start the live view. ${message}`);
      }
    })();
    return () => {
      cancelled = true;
      stopRendererLiveVisual();
    };
  }, [activeDevice, activeSession, mode, startWindowCaptureVisual, status, stopRendererLiveVisual]);

  useEffect(() => {
    if (mode !== "interact" || liveVisualKind !== "window" || !activeSession) {
      setSimulatorWindowState(null);
      return;
    }
    let cancelled = false;
    const refreshSimulatorWindowState = async () => {
      try {
        const next = await window.ade.iosSimulator.getSimulatorWindowState();
        if (!cancelled) setSimulatorWindowState(next);
      } catch {
        if (!cancelled) setSimulatorWindowState(null);
      }
    };
    void refreshSimulatorWindowState();
    const timer = window.setInterval(refreshSimulatorWindowState, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSession, liveVisualKind, mode]);

  useEffect(() => {
    if (mode !== "interact" || liveVisualKind !== "window" || !activeSession || snapshot) return;
    void refreshSnapshot({ silent: true, priority: true });
  }, [activeSession, liveVisualKind, mode, refreshSnapshot, snapshot]);

  useEffect(() => {
    if (mode !== "interact" || liveVisualKind !== "window" || !snapshot) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const fallback = heuristicWindowScreenRect(
      video.videoWidth,
      video.videoHeight,
      snapshot.screenshot.width,
      snapshot.screenshot.height,
    );
    if (fallback) {
      windowScreenRectRef.current = fallback;
      setWindowScreenRect(fallback);
    }
    let cancelled = false;
    void calibrateWindowScreenRect(video, snapshot).then((rect) => {
      if (cancelled || !rect) return;
      windowScreenRectRef.current = rect;
      setWindowScreenRect(rect);
    });
    return () => {
      cancelled = true;
    };
  }, [
    liveVisualKind,
    liveWindowHeight,
    liveWindowWidth,
    mode,
    snapshot,
    snapshot?.capturedAt,
    snapshot?.screenshot.dataUrl,
    snapshot?.screenshot.height,
    snapshot?.screenshot.width,
  ]);

  const launch = useCallback(async (options: { previewTarget?: IosSimulatorPreviewTarget | null } = {}) => {
    if (simulatorMutationBlocked) {
      setMessage(inputBlockedMessage);
      return;
    }
    const previewTarget = options.previewTarget ?? null;
    setBusy(true);
    setLaunchBusy(true);
    setLaunchProgress([]);
    setMessage(previewTarget ? `Launching selected iOS app for ${previewTarget.title}...` : "Launching selected iOS app...");
    try {
      const session = await window.ade.iosSimulator.launch({
        deviceUdid: selectedDeviceUdid,
        projectRoot,
        laneId,
        targetId: activeTarget?.id ?? selectedTargetId,
        chatSessionId: sessionId,
        build: true,
        mode: "live",
        keepSimulatorInBackground: false,
        environment: previewTarget ? previewLaunchEnvironment(previewTarget) : null,
      });
      setSelectedDeviceUdid(session.deviceUdid);
      await refreshStatus();
      setMode("interact");
      void refreshSnapshot({ silent: true, priority: true });
      setMessage(previewTarget
        ? `${session.appName ?? session.bundleId} launched. If it does not open ${previewTarget.title}, ask the agent to route the app to that screen.`
        : `${session.appName ?? session.bundleId} launched.`);
    } catch (error) {
      suppressNextSelectionEventRef.current = false;
      if (isOwnedByOtherSessionError(error)) {
        await refreshStatus().catch(() => {});
        setMessage("Another chat is already connected to the simulator. Use Take over to claim it.");
      } else {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setLaunchBusy(false);
      setBusy(false);
    }
  }, [activeTarget?.id, inputBlockedMessage, laneId, projectRoot, refreshSnapshot, refreshStatus, selectedDeviceUdid, selectedTargetId, sessionId, simulatorMutationBlocked]);

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
        projectRoot,
        sourceFilePath: target.sourceFilePath,
        previewDefinitionIndexInFile: target.previewDefinitionIndexInFile,
        tabIdentifier: previewCapability?.selectedWindow?.tabIdentifier ?? null,
        timeoutSec: 120,
      });
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
  }, [previewCapability?.selectedWindow?.tabIdentifier, projectRoot, selectedPreviewTarget]);

  const openPreviewWorkspace = useCallback(async () => {
    try {
      await window.ade.iosSimulator.openPreviewWorkspace({ projectRoot });
      setMessage("Opened apps/ios/ADE.xcodeproj in Xcode. If Xcode asks to allow ADE Preview Lab access, click Allow, then press Retry.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [projectRoot]);

  const draftPreviewAgentHelpRef = useRef<(() => Promise<void>) | null>(null);
  const openCurrentPageInPreview = useCallback(() => {
    const elementSource = selectedElement?.sourceFile ?? null;
    const matchingTarget = elementSource
      ? previewTargets.find((target) => target.sourceFile === elementSource || target.sourceFilePath === elementSource)
        ?? null
      : null;
    setMode("preview");
    setPreviewMode("control");
    if (matchingTarget) {
      setSelectedPreviewTargetId(matchingTarget.id);
      setPreviewResult(null);
      void renderSelectedPreview(matchingTarget);
      return;
    }
    setPreviewAgentHelpAction("open-simulator-in-preview");
    setMessage(elementSource
      ? `No #Preview matched ${elementSource}. Drafting an agent prompt to find or wire one...`
      : "No element is selected. Drafting an agent prompt to find the #Preview for the current screen...");
    void draftPreviewAgentHelpRef.current?.();
  }, [previewTargets, renderSelectedPreview, selectedElement?.sourceFile]);

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
      await window.ade.iosSimulator.typeText({ deviceUdid: selectedDeviceUdid, projectRoot, text });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [armWindowCaptureRecoveryAfterInput, liveInputBlocked, liveInputBlockedMessage, projectRoot, selectedDeviceUdid, typedText]);

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
      });
      attachmentPath = path;
      onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    }
    return { dataUrl: cropDataUrl, path: attachmentPath };
  }, [onAddAttachment, snapshot]);

  const selectElementAt = useCallback(async (x: number, y: number, element: IosScreenElement | null) => {
    if (!onAddContext) {
      setMessage("Context insertion is not available in this panel.");
      return;
    }
    setBusy(true);
    try {
      suppressNextSelectionEventRef.current = true;
      const result = await window.ade.iosSimulator.selectPoint({ deviceUdid: selectedDeviceUdid, projectRoot, x, y });
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
        ? "Added screen position context. No matching UI element was found at that point."
        : "Added selected UI context.";
      setMessage(`${contextMessage} Simulator inspect context inserted.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [attachCrop, onAddContext, projectRoot, selectedDeviceUdid]);

  const attachPreviewSnapshot = useCallback(async (): Promise<string | null> => {
    if (!previewResult?.dataUrl || !onAddAttachment) return null;
    const { path } = await window.ade.agentChat.saveTempAttachment({
      data: stripDataUrlPrefix(previewResult.dataUrl),
      filename: "xcode-preview.png",
    });
    onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    return path;
  }, [onAddAttachment, previewResult?.dataUrl]);

  const attachPreviewCapture = useCallback(async (frame: PreviewCrop["frame"]): Promise<({ path: string | null } & PreviewCrop) | null> => {
    if (!previewResult?.dataUrl || !previewResult.width || !previewResult.height) return null;
    const crop = await cropPreviewAreaDataUrl(previewResult.dataUrl, previewResult.width, previewResult.height, frame);
    if (!crop) return null;
    let attachmentPath: string | null = null;
    if (onAddAttachment) {
      const { path } = await window.ade.agentChat.saveTempAttachment({
        data: stripDataUrlPrefix(crop.dataUrl),
        filename: "xcode-preview-capture.png",
      });
      attachmentPath = path;
      onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    }
    return { ...crop, path: attachmentPath };
  }, [onAddAttachment, previewResult?.dataUrl, previewResult?.height, previewResult?.width]);

  const attachSimulatorScreenshot = useCallback(async (): Promise<string | null> => {
    if (!onAddAttachment) return null;
    let sourceSnapshot = snapshot;
    if (!sourceSnapshot?.screenshot.dataUrl) {
      try {
        const next = await window.ade.iosSimulator.getScreenSnapshot({
          deviceUdid: selectedDeviceUdid ?? activeDevice?.udid ?? undefined,
          projectRoot,
        });
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
    });
    onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    return path;
  }, [activeDevice?.udid, onAddAttachment, projectRoot, selectedDeviceUdid, snapshot]);

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
      });
      attachmentPath = path;
      onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
    }
    return { ...crop, path: attachmentPath };
  }, [onAddAttachment, snapshot?.screenshot]);

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
      ? "Captured simulator screenshot region and inserted it with screen context."
      : "Added simulator screenshot region context.");
  }, [attachSimulatorCapture, onAddContext, snapshot]);

  const buildPreviewAgentPrompt = useCallback((action: PreviewAgentHelpAction, attachmentPaths: { simulator: string | null; preview: string | null }) => {
    const selected = selectedElement;
    const target = selectedPreviewTarget;
    let previewState: string;
    if (previewResult?.ok) {
      previewState = `Rendered preview ${target?.title ?? "selected preview"} successfully.`;
    } else if (previewResult?.error) {
      previewState = `Preview render failed: ${previewResult.error}`;
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
      requestedWork = [
        "- Step 1: Identify the screen that is currently open in the live iOS Simulator. Start with `ade --socket ios-sim status --text` and `ade --socket ios-sim snapshot --text` so you are using ADE's current simulator session, not a guessed route.",
        "- Step 2: If the simulator is not running, there is no active simulator session, or ADE cannot capture a current screen/snapshot, stop and warn the user with the exact blocker. Do not guess from stale code.",
        "- Step 3: Use the simulator snapshot, attached screenshot, visible labels, navigation title, inspector packets, and SwiftUI file search to find the matching screen in code.",
        "- Step 4: Check whether that screen already has a `#Preview` or `PreviewProvider`. Run `ade --socket ios-sim previews --source <swift-file> --text` to list nearby preview definitions for the matched file.",
        "- Step 5a: If a matching preview already exists, use it. Do not add a duplicate preview just because the first search was imperfect.",
        "- Step 5b: If no matching preview exists, add one (prefer a `<Feature>Previews.swift` sidecar; use a lightweight harness with bindings, env objects, no-op callbacks, fake state).",
        "- Step 6: Finish by opening/rendering the chosen preview through ADE CLI with `ade --socket ios-sim preview-render --source <file> --index <previewDefinitionIndexInFile> --text` so the result lands in ADE's Preview surface.",
        "- Report back with the screen you identified, the file:line of the preview that was used or added, and the `ade ios-sim preview-render` result.",
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
      previewCapability?.setupSteps.length ? `- Setup gaps: ${previewCapability.setupSteps.join("; ")}` : "- Xcode preview setup appears ready or was not checked.",
      "",
      "Visual evidence:",
      attachmentPaths.simulator ? `- Real simulator screenshot attached: ${attachmentPaths.simulator}` : "- Real simulator screenshot is not attached; use `ade --socket ios-sim snapshot --text` before making code changes.",
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
    ].join("\n");
  }, [previewCapability?.setupSteps, previewResult?.error, previewResult?.ok, selectedElement, selectedPreviewTarget]);

  const draftPreviewAgentHelp = useCallback(async () => {
    try {
      const [simulatorAttachment, previewAttachment] = await Promise.all([
        attachSimulatorScreenshot().catch(() => null),
        attachPreviewSnapshot().catch(() => null),
      ]);
      const prompt = buildPreviewAgentPrompt(previewAgentHelpAction, {
        simulator: simulatorAttachment,
        preview: previewAttachment,
      });
      if (onInsertDraft) {
        onInsertDraft(prompt);
        setMessage(`Prepared "${previewAgentHelpOption.label}" prompt in the composer.`);
      } else {
        await window.ade.app.writeClipboardText(prompt);
        setMessage(`Copied "${previewAgentHelpOption.label}" prompt.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [attachPreviewSnapshot, attachSimulatorScreenshot, buildPreviewAgentPrompt, onInsertDraft, previewAgentHelpAction, previewAgentHelpOption.label]);
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

  const mapLivePointToSimulatorPixel = useCallback((point: { x: number; y: number }): { x: number; y: number } | null => {
    if (liveVisualKind !== "window") return point;
    if (!snapshot || !snapshot.screenshot.width || !snapshot.screenshot.height) return null;
    const rect = windowScreenRectRef.current
      ?? heuristicWindowScreenRect(
        liveWidth ?? 0,
        liveHeight ?? 0,
        snapshot.screenshot.width,
        snapshot.screenshot.height,
      );
    if (!rect) return null;
    if (
      point.x < rect.x
      || point.y < rect.y
      || point.x > rect.x + rect.width
      || point.y > rect.y + rect.height
    ) {
      return null;
    }
    return {
      x: ((point.x - rect.x) / rect.width) * snapshot.screenshot.width,
      y: ((point.y - rect.y) / rect.height) * snapshot.screenshot.height,
    };
  }, [liveHeight, liveVisualKind, liveWidth, snapshot]);

  const liveSimulatorPointFromPointer = useCallback((event: PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const media = videoRef.current;
    if (!media || !mediaWidth || !mediaHeight) return null;
    const point = pointerToMediaPoint(event, media, mediaWidth, mediaHeight);
    if (!point) return null;
    return mapLivePointToSimulatorPixel(point);
  }, [mapLivePointToSimulatorPixel, mediaHeight, mediaWidth]);

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
          await window.ade.iosSimulator.tap({ deviceUdid: selectedDeviceUdid, projectRoot, x: point.x / controlScale, y: point.y / controlScale });
        } else {
          await window.ade.iosSimulator.drag({
            deviceUdid: selectedDeviceUdid,
            projectRoot,
            startX: start.x / controlScale,
            startY: start.y / controlScale,
            endX: point.x / controlScale,
            endY: point.y / controlScale,
            durationMs: 180,
          });
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [armWindowCaptureRecoveryAfterInput, liveInputBlocked, liveInputBlockedMessage, liveSimulatorPointFromPointer, projectRoot, selectedDeviceUdid, snapshot?.screen.scale]);

  const handleVideoKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (liveInputBlocked) {
      setMessage(liveInputBlockedMessage);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      armWindowCaptureRecoveryAfterInput();
      void window.ade.iosSimulator.typeText({ deviceUdid: selectedDeviceUdid, projectRoot, text: "\n" }).catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      armWindowCaptureRecoveryAfterInput();
      void window.ade.iosSimulator.typeText({ deviceUdid: selectedDeviceUdid, projectRoot, text: event.key }).catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
    }
  }, [armWindowCaptureRecoveryAfterInput, liveInputBlocked, liveInputBlockedMessage, projectRoot, selectedDeviceUdid]);

  const snapshotElementCount = snapshot?.elements.length ?? 0;
  const providerSummary = snapshot
    ? snapshotElementCount > 0
      ? `Snapshot ready with ${snapshotElementCount} selectable item${snapshotElementCount === 1 ? "" : "s"}.`
      : "Snapshot ready with no selectable elements. Click a point or use Screenshot to attach visual context."
    : null;
  const hoverSource = hoveredElement?.source ?? null;
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
  if (mode === "interact") {
    if (streamStatus?.running) {
      simulatorModeHint = controlAvailable
        ? "Simulator is live. Tap, drag, or type to control it."
        : "Simulator is live.";
    } else {
      simulatorModeHint = controlAvailable
        ? "Tap to control the simulator. Click and drag to scroll or swipe."
        : "Launch the simulator to start the live view.";
    }
  } else if (mode === "inspect") {
    simulatorModeHint = simulatorCaptureActive
      ? "Drag a region on the simulator snapshot to attach a screenshot crop and screen context."
      : selectedElement
      ? `Selected element: ${elementLabel(selectedElement)}. Click another outline to swap, or Alt-click to select a parent.`
      : snapshot && snapshotElementCount === 0
      ? "No inspectable elements found. Click a point to attach coordinate context, or use Screenshot to capture a region."
      : "Click a UI element outline to insert it as context. Alt-click to select a larger container.";
  }
  const simulatorWindowWarning = mode === "interact"
    && liveVisualKind === "window"
    && simulatorWindowState?.capturable === false
    ? simulatorWindowState.message
    : null;
  const footerStatus = message
    ?? previewModeHint
    ?? simulatorModeHint
    ?? providerSummary;
  const launchStepOrder: IosSimulatorLaunchProgress["step"][] = [
    "resolve-device",
    "boot-simulator",
    "open-simulator",
    "resolve-target",
    "build-app",
    "install-app",
    "launch-app",
    "ready",
  ];
  const latestLaunchId = launchProgress.length ? launchProgress[launchProgress.length - 1]?.launchId ?? null : null;
  const visibleLaunchProgress = latestLaunchId
    ? launchStepOrder
        .map((step) => launchProgress.find((item) => item.launchId === latestLaunchId && item.step === step))
        .filter((item): item is IosSimulatorLaunchProgress => Boolean(item))
    : [];
  const showLaunchProgress = launchBusy && visibleLaunchProgress.length > 0;
  let liveVisualOverlayTitle: string | null = null;
  let liveVisualOverlayDetail: string | null = null;
  switch (liveVisual?.status) {
    case "reconnecting":
      liveVisualOverlayTitle = "Reconnecting live view...";
      liveVisualOverlayDetail = liveVisual.error ?? streamStatus?.degradationReason ?? streamStatus?.fallbackReason ?? null;
      break;
    case "starting":
      liveVisualOverlayTitle = "Starting live view...";
      break;
    case "error":
      liveVisualOverlayTitle = "Live view paused";
      liveVisualOverlayDetail = liveVisual.error;
      break;
  }
  const canShowLiveVisual = mode === "interact"
    && liveVisual;
  const canShowSnapshot = mode === "inspect" && Boolean(snapshotImage);
  const hasActiveSession = Boolean(activeSession);
  const interactionDisabled = simulatorMutationBlocked || showSetupChecklist;
  const inspectOverlayElements = useMemo(
    () => (snapshot ? visibleInspectElements(snapshot, selectedElement, hoveredElement) : []),
    [hoveredElement, selectedElement, snapshot],
  );
  const inspectOverlayKeys = useMemo(
    () => makeReactKeysById(inspectOverlayElements),
    [inspectOverlayElements],
  );

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
        className="inline-flex h-7 min-w-10 items-center justify-center rounded px-1 font-mono text-[10px] font-medium text-muted-fg/72 transition-colors hover:bg-white/[0.06] hover:text-fg/90"
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
      <div className={cn("space-y-1 shrink-0", mediaExpanded ? "hidden" : null)}>
        <div className="flex flex-wrap items-center justify-between gap-1.5 px-0.5 py-0.5">
          <div className="flex rounded border border-white/[0.08] bg-black/20 p-px">
            <button
              type="button"
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-[3px] px-2 font-sans text-[10px] font-medium transition-colors",
                activeSurface === "simulator" ? "bg-white/[0.10] text-fg/90" : "text-muted-fg/50 hover:text-fg/75",
              )}
              onClick={() => setMode(lastSimulatorMode)}
            >
              <DeviceMobile size={11} />
              Simulator
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-[3px] px-2 font-sans text-[10px] font-medium transition-colors",
                activeSurface === "preview" ? "bg-white/[0.10] text-fg/90" : "text-muted-fg/50 hover:text-fg/75",
              )}
              onClick={() => setMode("preview")}
            >
              <BracketsCurly size={11} />
              Preview
            </button>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="font-sans text-[9px] uppercase tracking-wider text-muted-fg/60">
              {activeSurface === "simulator" ? "Simulator" : "Preview"}
            </div>
            {activeSurface === "simulator" && hasActiveSession ? (
              <div className="inline-flex h-6 items-center gap-1 rounded border border-cyan-300/18 bg-cyan-400/10 px-1.5 font-sans text-[10px] font-medium text-cyan-50/76">
                <Desktop size={11} />
                Live
              </div>
            ) : null}
          </div>
        </div>

        {activeSurface === "simulator" ? (
          <>
            <div className="flex items-center gap-1">
              <select
                className="min-w-0 flex-1 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 font-sans text-[10px] text-fg/75 outline-none disabled:opacity-50"
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
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded border border-white/[0.08] bg-white/[0.03] text-fg/55 transition-colors hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => {
                  void refreshStatus()
                    .then(() => refreshLaunchTargets(selectedDeviceUdid ?? activeDevice?.udid ?? undefined))
                    .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
                }}
                disabled={contextControlsBlocked}
                title="Refresh simulator state"
              >
                <ArrowClockwise size={14} />
              </button>
              {hasActiveSession && !simulatorMutationBlocked ? (
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded border border-rose-400/22 bg-rose-500/8 px-1.5 font-sans text-[10px] font-medium text-rose-200/80 transition-colors hover:bg-rose-500/12 disabled:cursor-not-allowed disabled:opacity-45"
                  onClick={handleStopSimulator}
                  disabled={busy}
                  title="Stop the running simulator"
                >
                  <Power size={12} weight="bold" />
                  Stop
                </button>
              ) : null}
            </div>

            <div className="flex items-center gap-1">
              {visibleLaunchTargets.length > 1 ? (
                <select
                  className="min-w-0 flex-1 rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 font-sans text-[10px] text-fg/75 outline-none"
                  value={activeTarget?.id ?? ""}
                  onChange={(event) => setSelectedTargetId(event.currentTarget.value || null)}
                >
                  {visibleLaunchTargets.map((target) => (
                    <option key={target.id} value={target.id}>{targetLabel(target)}</option>
                  ))}
                </select>
              ) : (
                <div className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/20 px-2 py-1.5 font-sans text-[11px] text-fg/75">
                  {activeTarget ? targetLabel(activeTarget) : "No launchable app found"}
                </div>
              )}
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-2 font-sans text-[11px] font-medium text-emerald-100/85 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={busy || !status?.supported || !activeTarget || interactionDisabled}
                onClick={() => void launch()}
              >
                <Play size={13} weight="fill" />
                Launch
              </button>
              {hasActiveSession && !simulatorMutationBlocked ? (
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-cyan-400/20 bg-cyan-500/10 px-2 font-sans text-[11px] font-medium text-cyan-100/85 transition-colors hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={busy || !status?.supported || !activeTarget}
                  onClick={() => void launch()}
                  title="Rebuild, reinstall, and relaunch the active app"
                >
                  <ArrowClockwise size={13} />
                  Apply
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {mode === "preview" ? (
          <div className="space-y-1.5">
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
            <div className="flex min-w-0 items-center justify-between gap-3 px-1 font-sans text-[10px] text-muted-fg/55">
              <div className="min-w-0 truncate" title={previewSuggestionReason}>
                {previewSuggestionReason}
              </div>
              <div className="min-w-0 shrink-0 truncate text-muted-fg/45" title={previewTargetSource ?? undefined}>
                {previewTargetSource ?? "No #Preview selected"}
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

      {!mediaExpanded && ownedByOtherChat ? (
        <div className="shrink-0 rounded-md border border-amber-400/20 bg-amber-500/8 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <Lock size={14} weight="fill" className="mt-0.5 shrink-0 text-amber-200/80" />
            <div className="min-w-0 flex-1">
              <div className="font-sans text-[11px] font-medium text-amber-50/85">
                Another chat is using the simulator
              </div>
              <div className="mt-0.5 font-sans text-[10px] text-amber-100/55">
                Connected to chat {shortChatId(otherChatSessionId ?? "")}.
              </div>
            </div>
            <button
              type="button"
              className="rounded-md border border-amber-400/30 bg-amber-500/12 px-2 py-1 font-sans text-[10px] font-medium text-amber-50/85 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => void takeOver()}
              disabled={busy}
            >
              Take over
            </button>
          </div>
        </div>
      ) : null}

      {!mediaExpanded && showBestPerformanceChecklist ? (
        <details className="group shrink-0 rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 font-sans text-[10px] text-muted-fg/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 outline-none [&::-webkit-details-marker]:hidden">
            <Lightning size={12} className={bestPerformanceReady ? "text-emerald-200/75" : "text-amber-200/75"} />
            <span className="font-medium text-fg/72">Simulator readiness</span>
            <span className={cn(
              "ml-auto rounded px-1.5 py-[1px] font-medium",
              bestPerformanceReady ? "bg-emerald-500/12 text-emerald-100/75" : "bg-amber-400/12 text-amber-100/75",
            )}>
              {bestPerformanceReady ? "Ready" : `${bestPerformanceMissingCount} item${bestPerformanceMissingCount === 1 ? "" : "s"} need attention`}
            </span>
          </summary>
          <div className="mt-2 grid gap-1.5">
            {bestPerformanceItems.map((item) => (
              <div key={item.key} className="flex items-start gap-2 rounded-md border border-white/[0.05] bg-black/15 px-2 py-1.5">
                {item.ok ? (
                  <CheckCircle size={12} weight="fill" className="mt-0.5 shrink-0 text-emerald-300/75" />
                ) : (
                  <Circle size={12} weight="fill" className="mt-0.5 shrink-0 text-amber-200/65" />
                )}
                <div className="min-w-0">
                  <div className="text-[10px] font-medium text-fg/75">{item.label}</div>
                  <div className="mt-0.5 text-[10px] leading-4 text-muted-fg/55">{item.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-white/[0.08] bg-white/[0.02]">
        {showSetupChecklist && mode !== "preview" ? (
          <div className="flex h-full min-h-[300px] flex-col gap-3 px-4 py-4">
            <div className="flex items-center gap-2 font-sans text-[12px] font-medium text-fg/85">
              <Wrench size={14} className="text-amber-200/75" />
              Set up iOS prerequisites
            </div>
            <div className="font-sans text-[11px] leading-5 text-muted-fg/65">
              Install the missing tools below to launch a simulator from this session.
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1">
              {missingRequiredTools.map((tool) => {
                const desc = TOOL_DESCRIPTORS[tool.name];
                if (!desc) return null;
                const hint = tool.installHint?.trim() ? tool.installHint : null;
                return (
                  <div key={tool.name} className="rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Circle size={11} weight="fill" className={desc.required ? "text-rose-300/75" : "text-muted-fg/40"} />
                      <div className="font-sans text-[11px] font-medium text-fg/85">{desc.title}</div>
                      <span className={cn(
                        "ml-auto rounded px-1.5 py-[1px] font-sans text-[9px] font-medium uppercase tracking-wide",
                        desc.required ? "bg-rose-500/12 text-rose-200/75" : "bg-white/[0.05] text-muted-fg/55",
                      )}>
                        {desc.required ? "required" : "optional"}
                      </span>
                    </div>
                    <div className="mt-1 font-sans text-[10px] leading-4 text-muted-fg/60">{desc.description}</div>
                    {hint ? (
                      <div className="mt-2 flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-black/25 px-2 py-1">
                        <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg/75">{hint}</code>
                        <button
                          type="button"
                          className="inline-flex shrink-0 items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-sans text-[9px] text-muted-fg/65 transition-colors hover:text-fg/85"
                          onClick={() => void copyInstallHint(hint)}
                          title="Copy install command"
                        >
                          <Copy size={9} />
                          Copy
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
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
              >
                <Selection size={11} />
                Capture area
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
                        className="pointer-events-none absolute rounded-[3px] border border-cyan-200/75 bg-cyan-300/12 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]"
                        style={{
                          left: previewCaptureSelection.bounds.left + (activePreviewCaptureFrame.x * previewCaptureSelection.bounds.scaleX),
                          top: previewCaptureSelection.bounds.top + (activePreviewCaptureFrame.y * previewCaptureSelection.bounds.scaleY),
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
                        void draftPreviewAgentHelp();
                      }}
                    >
                      <Lightning size={12} />
                      Ask agent to add a #Preview
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
          <div className="flex h-full min-h-[300px] flex-col justify-center gap-3 px-5 py-4">
            <div className="flex items-center gap-2 font-sans text-[12px] font-medium text-fg/80">
              <DeviceMobile size={16} className="text-emerald-200/80" />
              Starting iOS simulator
            </div>
            <div className="space-y-2">
              {visibleLaunchProgress.map((step) => (
                <div key={`${step.launchId}:${step.step}`} className="flex items-start gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2">
                  {step.status === "complete" || step.status === "skipped" ? (
                    <CheckCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-emerald-300/85" />
                  ) : step.status === "failed" ? (
                    <WarningCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-rose-300/85" />
                  ) : step.status === "running" ? (
                    <SpinnerGap size={15} className="mt-0.5 shrink-0 animate-spin text-cyan-200/85" />
                  ) : (
                    <Circle size={15} className="mt-0.5 shrink-0 text-muted-fg/35" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-sans text-[11px] text-fg/75">{step.message}</div>
                    {step.detail ? <div className="truncate font-sans text-[10px] text-muted-fg/45">{step.detail}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
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
              className="pointer-events-auto absolute right-3 top-3 z-10 inline-flex h-7 items-center gap-1.5 rounded-md border border-violet-300/22 bg-black/60 px-2 font-sans text-[10px] font-medium text-violet-50/85 shadow-lg backdrop-blur transition-colors hover:bg-black/72 disabled:cursor-not-allowed disabled:opacity-45"
              onClick={(event) => { event.stopPropagation(); openCurrentPageInPreview(); }}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              title={selectedElement
                ? "Open the source file for the selected element in Preview Lab"
                : "Switch to Preview Lab and ask the agent to find a #Preview for the current screen"}
            >
              <BracketsCurly size={11} />
              Open in preview
            </button>
            {liveVisual.sourceId ? (
              <div className={cn("absolute inset-0", mediaZoom > MEDIA_ZOOM_MIN ? "overflow-auto" : "overflow-hidden")}>
                <div className="relative h-full w-full" style={mediaZoomStyle}>
                  <video
                    ref={videoRef}
                    className="h-full w-full object-contain"
                    muted
                    playsInline
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[300px] items-center justify-center px-4 text-muted-fg/55">
                <div className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-black/35 px-3 py-2">
                  <SpinnerGap size={15} className="animate-spin text-cyan-100/75" />
                  <span className="font-sans text-[11px]">{liveVisualOverlayTitle ?? "Starting live view..."}</span>
                </div>
              </div>
            )}
            {liveVisualOverlayTitle ? (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/24 px-4 text-muted-fg/70">
                <div className="flex max-w-[280px] items-center gap-2 rounded-md border border-white/[0.08] bg-black/65 px-3 py-2 shadow-lg backdrop-blur">
                  {liveVisual.status === "error" ? (
                    <WarningCircle size={15} className="shrink-0 text-amber-200/80" />
                  ) : (
                    <SpinnerGap size={15} className="shrink-0 animate-spin text-cyan-100/80" />
                  )}
                  <div className="min-w-0">
                    <div className="font-sans text-[11px] font-medium text-fg/78">{liveVisualOverlayTitle}</div>
                    {liveVisualOverlayDetail ? (
                      <div className="mt-0.5 line-clamp-2 font-sans text-[10px] leading-4 text-muted-fg/60">{liveVisualOverlayDetail}</div>
                    ) : null}
                  </div>
                </div>
              </div>
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
              className="pointer-events-auto absolute right-3 top-3 z-10 inline-flex h-7 items-center gap-1.5 rounded-md border border-violet-300/22 bg-black/60 px-2 font-sans text-[10px] font-medium text-violet-50/85 shadow-lg backdrop-blur transition-colors hover:bg-black/72 disabled:cursor-not-allowed disabled:opacity-45"
              onClick={(event) => { event.stopPropagation(); openCurrentPageInPreview(); }}
              onPointerDown={(event) => event.stopPropagation()}
              title={selectedElement
                ? "Open the source file for the selected element in Preview Lab"
                : "Ask the agent to find the current simulator screen and open its #Preview"}
            >
              <BracketsCurly size={11} />
              Open in preview
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
                {mode === "inspect" && bounds && snapshot ? inspectOverlayElements.map((element, index) => {
                  const frame = clampFrame(
                    element.pixelFrame,
                    snapshot.screenshot.width ?? snapshot.screen.width,
                    snapshot.screenshot.height ?? snapshot.screen.height,
                  );
                  const isHovered = hoveredElement?.id === element.id;
                  const isSelected = selectedElement?.id === element.id;
                  return (
                    <div
                      key={inspectOverlayKeys[index] ?? `${element.id}:${index}`}
                      className={cn(
                        "pointer-events-none absolute rounded-[3px] border",
                        isHovered || isSelected ? sourceTone(element.source) : "border-cyan-200/22 bg-cyan-400/[0.03]",
                      )}
                      style={{
                        left: bounds.left + (frame.x * bounds.scaleX),
                        top: bounds.top + (frame.y * bounds.scaleY),
                        width: Math.max(2, frame.width * bounds.scaleX),
                        height: Math.max(2, frame.height * bounds.scaleY),
                      }}
                    />
                  );
                }) : null}
                {mode === "inspect" && simulatorCaptureActive && simulatorCaptureSelection && activeSimulatorCaptureFrame ? (
                  <div
                    className="pointer-events-none absolute rounded-[3px] border border-amber-200/80 bg-amber-300/12 shadow-[0_0_0_9999px_rgba(0,0,0,0.26)]"
                    style={{
                      left: simulatorCaptureSelection.bounds.left + (activeSimulatorCaptureFrame.x * simulatorCaptureSelection.bounds.scaleX),
                      top: simulatorCaptureSelection.bounds.top + (activeSimulatorCaptureFrame.y * simulatorCaptureSelection.bounds.scaleY),
                      width: Math.max(1, activeSimulatorCaptureFrame.width * simulatorCaptureSelection.bounds.scaleX),
                      height: Math.max(1, activeSimulatorCaptureFrame.height * simulatorCaptureSelection.bounds.scaleY),
                    }}
                  />
                ) : null}
                {mode === "inspect" && bounds && hoveredElement ? (
                  <div
                    className={cn(
                      "pointer-events-none absolute max-w-[260px] rounded-md border px-2 py-1 font-sans text-[10px] shadow-lg",
                      sourceTone(hoveredElement.source),
                    )}
                    style={{
                      left: Math.min(bounds.left + bounds.width - 180, bounds.left + (hoveredElement.pixelFrame.x * bounds.scaleX)),
                      top: Math.max(4, bounds.top + (hoveredElement.pixelFrame.y * bounds.scaleY) - 30),
                    }}
                  >
                    <span className="font-medium">{elementLabel(hoveredElement)}</span>
                    <span className="ml-1 opacity-65">{hoverSource}</span>
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
        ) : (
          <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-2 px-6 text-center text-muted-fg/55">
            {liveVisual?.status === "error" ? (
              <WarningCircle size={26} className="text-rose-300/70" />
            ) : (
              <DeviceMobile size={26} className="text-muted-fg/40" />
            )}
            <div className="font-sans text-[12px] text-fg/75">
              {liveVisual?.error ?? "No simulator yet"}
            </div>
            {!liveVisual?.error ? (
              <div className="font-sans text-[10px] leading-4 text-muted-fg/55">
                Pick a device and an app, then press Launch.
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!mediaExpanded ? <div className="shrink-0 space-y-1">
        {mode === "interact" && controlAvailable && !simulatorMutationBlocked && !showSetupChecklist ? (
          <div className="flex items-center gap-1">
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
        {simulatorWindowWarning ? (
          <div className="flex items-start gap-1.5 rounded border border-amber-300/20 bg-amber-400/10 px-1.5 py-1 font-sans text-[10px] leading-[14px] text-amber-50/78">
            <WarningCircle size={12} className="mt-px shrink-0 text-amber-200/75" />
            <span>{simulatorWindowWarning}</span>
          </div>
        ) : null}
        {footerStatus ? (
          <div className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-1 font-sans text-[10px] text-muted-fg/70">
            {footerStatus}
          </div>
        ) : null}
        {mode === "interact" && !controlAvailable && !showSetupChecklist && !simulatorMutationBlocked ? (
          <div className="rounded border border-amber-400/15 bg-amber-500/10 px-1.5 py-1 font-sans text-[10px] text-amber-100/70">
            Simulator controls are unavailable on this Mac.
          </div>
        ) : null}
      </div> : null}
    </div>
  );
}
