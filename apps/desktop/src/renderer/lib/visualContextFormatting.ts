import type {
  AppControlContextItem,
  BuiltInBrowserContextItem,
  IosElementContextItem,
  MacosVmContextItem,
  MacosVmStatus,
} from "../../shared/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function frameFromUnknown(value: unknown): BuiltInBrowserContextItem["frame"] | null {
  const record = asRecord(value);
  if (!record) return null;
  const x = numberOrNull(record.x);
  const y = numberOrNull(record.y);
  const width = numberOrNull(record.width);
  const height = numberOrNull(record.height);
  if (x == null || y == null || width == null || height == null) return null;
  return { x, y, width, height };
}

function contextInstanceSuffix(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function iosContextLabel(item: IosElementContextItem): string {
  const metadata = item.metadata ?? {};
  const label = typeof metadata.label === "string" && metadata.label.trim()
    ? metadata.label.trim()
    : null;
  const role = typeof metadata.role === "string" && metadata.role.trim()
    ? metadata.role.trim()
    : null;
  return label ?? item.componentId ?? role ?? "iOS simulator element";
}

export function iosContextSurface(item: IosElementContextItem): "simulator" | "xcode-preview" {
  const source = typeof item.metadata?.screenElementSource === "string" ? item.metadata.screenElementSource : "";
  return item.metadata?.contextSurface === "xcode-preview" || source.startsWith("xcode-preview")
    ? "xcode-preview"
    : "simulator";
}

export function formatIosElementContextChipsForDisplay(items: IosElementContextItem[]): string {
  if (!items.length) return "";
  return items.map((item) => `\`${iosContextLabel(item)}\``).join(" ");
}

export function getIosContextAttachmentPath(item: IosElementContextItem): string | null {
  const value = item.metadata?.attachmentPath;
  return typeof value === "string" && value.length ? value : null;
}

export function createIosContextInstanceId(item: IosElementContextItem): string {
  return `${item.id}::${contextInstanceSuffix()}`;
}

export function formatIosElementContextForPrompt(items: IosElementContextItem[]): string {
  if (!items.length) return "";
  const rows = items.map((item, index) => {
    const metadata = item.metadata ?? {};
    const sourceConfidence = typeof metadata.sourceConfidence === "string"
      ? metadata.sourceConfidence
      : item.sourceFile ? "exact" : "none";
    let source: string;
    if (item.sourceFile) {
      source = `${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}`;
    } else if (sourceConfidence === "candidate") {
      source = "no exact source; ranked candidates below";
    } else {
      source = "no source match";
    }
    const frame = item.frame
      ? `x=${item.frame.x}, y=${item.frame.y}, w=${item.frame.width}, h=${item.frame.height}`
      : "unknown frame";
    const attachmentPath = getIosContextAttachmentPath(item);
    const sourceCandidates = asRecordArray(metadata.sourceCandidates ?? metadata.sourceMatches)
      .slice(0, 3)
      .map((candidate) => ({
        sourceFile: candidate.sourceFile,
        sourceLine: candidate.sourceLine,
        confidence: candidate.confidence,
        reason: candidate.reason,
        snippet: typeof candidate.snippet === "string" ? candidate.snippet : undefined,
      }));
    const nearbyElements = asRecordArray(metadata.nearbyElements)
      .slice(0, 8)
      .map((element) => ({
        label: element.label,
        value: element.value,
        role: element.role,
        elementType: element.elementType,
        identifier: element.identifier,
        componentId: element.componentId,
        source: element.source,
        relation: element.relation,
        screenshotFrame: element.screenshotFrame,
      }));
    const packet = {
      contextId: item.id,
      visualAttachmentPath: attachmentPath,
      selectedAt: item.selectedAt,
      selectedElement: metadata.selectedElement ?? {
        componentId: item.componentId,
        accessibilityIdentifier: item.accessibilityIdentifier ?? null,
        label: metadata.label,
        value: metadata.value,
        role: metadata.role,
        elementType: metadata.elementType,
        screenshotFrame: frame,
      },
      screen: metadata.screen,
      sourceConfidence,
      exactSource: item.sourceFile ? {
        sourceFile: item.sourceFile,
        sourceLine: item.sourceLine,
        snippet: typeof metadata.sourceSnippet === "string" ? metadata.sourceSnippet : null,
      } : null,
      sourceCandidates,
      nearbyElements,
    };
    const snippet = typeof metadata.sourceSnippet === "string" && metadata.sourceSnippet.trim().length
      ? `\nExact source snippet:\n${metadata.sourceSnippet}`
      : "";
    return `${index + 1}. ${iosContextLabel(item)} (${source}, frame=${frame})\nPacket:\n${JSON.stringify(packet, null, 2)}${snippet}`;
  });
  return [
    "iOS visual inspect context attached by the user.",
    "Each packet came from the user clicking a UI element in the real iOS Simulator, dragging a simulator screenshot region, or dragging a capture area in an Xcode SwiftUI preview. Image attachments/crops are visual evidence for the same packet and use the same screenshot coordinate space.",
    "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked best guesses, not proof; prefer nearbyElements and the screenshot when the source is missing or only candidate quality.",
    "When the packet surface is xcode-preview, treat it as fast fixture/mock-data feedback rather than live app state. Keep SwiftUI changes previewable with nearby #Preview definitions and deterministic mock fixtures.",
    ...rows,
    "",
  ].join("\n");
}

function appControlContextLabel(item: AppControlContextItem): string {
  const metadata = item.metadata ?? {};
  for (const value of [metadata.label, metadata.value, item.componentId, metadata.role, metadata.tagName]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "App Control element";
}

export function formatAppControlContextChipsForDisplay(items: AppControlContextItem[]): string {
  if (!items.length) return "";
  return items.map((item) => `\`${appControlContextLabel(item)}\``).join(" ");
}

export function getAppControlContextAttachmentPath(item: AppControlContextItem): string | null {
  const value = item.metadata?.attachmentPath;
  return typeof value === "string" && value.length ? value : null;
}

export function createAppControlContextInstanceId(item: AppControlContextItem): string {
  return `${item.id}::${contextInstanceSuffix()}`;
}

export function formatAppControlContextForPrompt(items: AppControlContextItem[]): string {
  if (!items.length) return "";
  const rows = items.map((item, index) => {
    const metadata = item.metadata ?? {};
    const sourceConfidence = typeof metadata.sourceConfidence === "string"
      ? metadata.sourceConfidence
      : item.sourceFile ? "exact" : "none";
    const frame = item.frame
      ? `x=${item.frame.x}, y=${item.frame.y}, w=${item.frame.width}, h=${item.frame.height}`
      : "unknown frame";
    const attachmentPath = getAppControlContextAttachmentPath(item);
    const sourceCandidates = asRecordArray(metadata.sourceCandidates)
      .slice(0, 5)
      .map((candidate) => ({
        sourceFile: candidate.sourceFile,
        sourceLine: candidate.sourceLine,
        confidence: candidate.confidence,
        reason: candidate.reason,
        snippet: typeof candidate.snippet === "string" ? candidate.snippet : undefined,
      }));
    const nearbyElements = asRecordArray(metadata.nearbyElements).slice(0, 8);
    const packet = {
      contextId: item.id,
      appKind: item.appKind,
      provider: item.provider,
      visualAttachmentPath: attachmentPath,
      selectedAt: item.selectedAt,
      selectedElement: metadata.selectedElement ?? {
        componentId: item.componentId,
        label: metadata.label,
        value: metadata.value,
        role: metadata.role,
        tagName: metadata.tagName,
        selector: metadata.selector,
        testId: metadata.testId,
        screenshotFrame: frame,
      },
      screen: metadata.screen,
      url: metadata.url,
      title: metadata.title,
      sourceConfidence,
      exactSource: item.sourceFile ? {
        sourceFile: item.sourceFile,
        sourceLine: item.sourceLine,
        snippet: typeof metadata.sourceSnippet === "string" ? metadata.sourceSnippet : null,
      } : null,
      sourceCandidates,
      nearbyElements,
    };
    const source = item.sourceFile
      ? `${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}`
      : sourceConfidence === "candidate" ? "no exact source; ranked candidates below" : "no source match";
    const snippet = typeof metadata.sourceSnippet === "string" && metadata.sourceSnippet.trim().length
      ? `\nBest source snippet:\n${metadata.sourceSnippet}`
      : "";
    return `${index + 1}. ${appControlContextLabel(item)} (${source}, frame=${frame})\nPacket:\n${JSON.stringify(packet, null, 2)}${snippet}`;
  });
  return [
    "App Control visual inspect context attached by the user.",
    "Each packet came from a developer-owned app session, usually Electron launched or connected through ADE CLI with a local CDP port. Image attachments/crops are visual evidence for the same packet and use screenshot pixel coordinates.",
    "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked guesses from DOM text/test ids/selectors and source search, not proof. Prefer the screenshot, DOM selector, nearbyElements, console/browser context, and exact source when available.",
    ...rows,
    "",
  ].join("\n");
}

function macosVmContextLabel(item: MacosVmContextItem): string {
  return item.vmName || "macOS VM";
}

export function formatMacosVmContextChipsForDisplay(items: MacosVmContextItem[]): string {
  if (!items.length) return "";
  return items.map((item) => `\`${macosVmContextLabel(item)}\``).join(" ");
}

export function createMacosVmContextInstanceId(item: MacosVmContextItem): string {
  return `${item.id}::${contextInstanceSuffix()}`;
}

export function getMacosVmContextAttachmentPath(item: MacosVmContextItem): string | null {
  const value = item.metadata?.screenshotPath ?? item.metadata?.attachmentPath;
  return typeof value === "string" && value.length ? value : null;
}

export function formatMacosVmContextForPrompt(items: MacosVmContextItem[]): string {
  if (!items.length) return "";
  const rows = items.map((item, index) => {
    const metadata = item.metadata ?? {};
    const attachmentPath = getMacosVmContextAttachmentPath(item);
    const packet = {
      contextId: item.id,
      provider: item.provider,
      state: item.state,
      visualAttachmentPath: attachmentPath,
      laneId: item.laneId,
      laneName: item.laneName,
      vmName: item.vmName,
      hostLanePath: item.hostLanePath,
      guestLanePath: item.guestLanePath,
      runCommand: item.runCommand,
      sshCommand: item.sshCommand,
      vncUrl: item.vncUrl,
      windowTitleQuery: item.windowTitleQuery,
      selectedAt: item.selectedAt,
      selectedPoint: metadata.selectedPoint,
      screenshotPath: metadata.screenshotPath,
      metadata,
    };
    return `${index + 1}. ${macosVmContextLabel(item)} (${item.state}, lane=${item.laneName})\nPacket:\n${JSON.stringify(packet, null, 2)}`;
  });
  return [
    "macOS VM target context attached by the user.",
    "Use this VM for isolated GUI validation tied to the active lane. The host lane path is shared into the guest with VirtioFS, so edits in the mounted folder stay synced between host and guest. When visualAttachmentPath or selectedPoint is present, treat it as screenshot-backed VM context.",
    "For GUI computer use, prefer ADE macos-vm screenshot/click/type tools; they use headless VNC when available and only fall back to a visible Lume/VNC/macOS VM window. Do not target the host ADE window unless the user asks to switch back.",
    "For shell commands inside the guest, use sshCommand when present or configure SSH/in-guest agent access, then work from guestLanePath.",
    "Keep secrets out of the VM; ADE blocks lane roots that contain .ade/secrets from being mounted.",
    ...rows,
    "",
  ].join("\n");
}

function formatAutomaticMacosVmContextForPrompt(status: MacosVmStatus, laneId: string): string {
  if (!status.supported || !status.activeProvider.available) return "";
  const vm = status.laneVm;
  const state = vm?.state ?? "not_created";
  const guestPath = vm?.guestSharedPath ?? "/Volumes/My Shared Files";
  const hostPath = vm?.laneRoot ?? "current ADE lane worktree";
  const lines = [
    "ADE macOS VM capability for this lane (automatic context).",
    "Use this capability only when the user asks to use the ADE VM, needs isolated macOS GUI validation, or asks for VM-backed computer use. Query fresh state before acting; do not assume this snapshot is current.",
    `- Lane id: ${laneId}`,
    `- Provider: ${status.activeProvider.kind}${status.activeProvider.version ? ` ${status.activeProvider.version}` : ""}`,
    vm
      ? `- Current lane VM: ${vm.name} (${state})`
      : "- Current lane VM: not provisioned yet",
    `- Host lane path: ${hostPath}`,
    `- Guest lane path: ${guestPath}`,
    vm?.sharedDirectory ? `- Shared directory mounted into the VM: ${vm.sharedDirectory}` : null,
    vm?.sshCommand ? `- Guest SSH command: ${vm.sshCommand}` : "- Guest SSH command: not configured yet",
    vm?.vncUrl ? `- Sanitized VNC URL: ${vm.vncUrl}` : "- Sanitized VNC URL: available after the VM is running",
    "- ADE RPC tools: macos_vm_status, macos_vm_start, macos_vm_focus, macos_vm_screenshot, macos_vm_select, macos_vm_click, macos_vm_type.",
    `- ADE CLI examples: ade macos-vm status --lane ${laneId} --text; ade macos-vm start --lane ${laneId} --create --no-display; ade macos-vm screenshot --lane ${laneId} --text.`,
    "- GUI control goes through ADE's direct headless VNC bridge when available, then falls back to a visible VM viewer. Do not target the host ADE window when the task is to control the lane VM.",
    state === "running"
      ? "- The VM is currently running; prefer macos_vm_screenshot first, then click/type/select against the VM."
      : "- The VM is not running; start it only if the user asked for VM use or the task clearly needs isolated macOS GUI validation.",
    vm?.metadata?.shareMode === "sanitized-mirror"
      ? "- This lane uses a sanitized mirror for the VM share; ADE syncs code while excluding secrets, runtime databases, caches, transcripts, generated local history, and .git."
      : "- Keep VM-side edits inside the mounted guest lane path so the host lane and guest stay aligned.",
    "",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export async function buildAutomaticMacosVmContextForPrompt(laneId: string): Promise<string> {
  const api = window.ade?.macosVm;
  if (!api?.getStatus) return "";
  try {
    const status = await api.getStatus({ laneId });
    return formatAutomaticMacosVmContextForPrompt(status, laneId);
  } catch {
    return "";
  }
}

export function normalizeBuiltInBrowserContextItem(value: unknown): BuiltInBrowserContextItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const metadata = asRecord(record.metadata) ?? {};
  const pixelFrameCandidate = frameFromUnknown(record.pixelFrame);
  const frame = frameFromUnknown(record.frame) ?? pixelFrameCandidate ?? frameFromUnknown(record.bounds) ?? {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };
  const pixelFrame = pixelFrameCandidate ?? frame;
  const componentId = stringOrNull(record.componentId)
    ?? stringOrNull(metadata.selector)
    ?? stringOrNull(metadata.testId)
    ?? stringOrNull(metadata.tagName)
    ?? "browser-element";
  const kind = stringOrNull(record.kind) === "built_in_browser_capture" ? "built_in_browser_capture" : "built_in_browser_element";
  return {
    kind,
    id: stringOrNull(record.id) ?? `built-in-browser:${Date.now().toString(36)}`,
    provider: "cdp",
    componentId,
    url: stringOrNull(record.url),
    title: stringOrNull(record.title),
    sourceFile: stringOrNull(record.sourceFile),
    sourceLine: numberOrNull(record.sourceLine),
    frame,
    pixelFrame,
    metadata,
    screenshotDataUrl: stringOrNull(record.screenshotDataUrl) ?? stringOrNull(record.dataUrl),
    selectedAt: stringOrNull(record.selectedAt) ?? new Date().toISOString(),
  };
}

function builtInBrowserContextLabel(item: BuiltInBrowserContextItem): string {
  const metadata = item.metadata ?? {};
  if (item.kind === "built_in_browser_capture") {
    const selectedElement = asRecord(metadata.selectedElement);
    const selectedLabel = stringOrNull(selectedElement?.label);
    return selectedLabel ? `Browser capture: ${selectedLabel}` : "Browser screenshot capture";
  }
  for (const value of [
    metadata.label,
    metadata.text,
    metadata.value,
    item.componentId,
    metadata.selector,
    metadata.role,
    metadata.tagName,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Browser element";
}

export function formatBuiltInBrowserContextChipsForDisplay(items: BuiltInBrowserContextItem[]): string {
  if (!items.length) return "";
  return items.map((item) => `\`${builtInBrowserContextLabel(item)}\``).join(" ");
}

export function getBuiltInBrowserContextAttachmentPath(item: BuiltInBrowserContextItem): string | null {
  const value = item.metadata?.attachmentPath;
  return typeof value === "string" && value.length ? value : null;
}

export function createBuiltInBrowserContextInstanceId(item: BuiltInBrowserContextItem): string {
  return `${item.id}::${contextInstanceSuffix()}`;
}

export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

export function formatBuiltInBrowserContextForPrompt(items: BuiltInBrowserContextItem[]): string {
  if (!items.length) return "";
  const rows = items.map((item, index) => {
    const metadata = item.metadata ?? {};
    const frame = item.frame
      ? `x=${item.frame.x}, y=${item.frame.y}, w=${item.frame.width}, h=${item.frame.height}`
      : "unknown frame";
    const attachmentPath = getBuiltInBrowserContextAttachmentPath(item);
    const packet = {
      contextId: item.id,
      provider: item.provider,
      visualAttachmentPath: attachmentPath,
      selectedAt: item.selectedAt,
      url: item.url ?? metadata.url ?? null,
      title: item.title ?? metadata.title ?? null,
      selectedElement: metadata.selectedElement ?? {
        componentId: item.componentId,
        label: metadata.label,
        value: metadata.value,
        role: metadata.role,
        tagName: metadata.tagName,
        selector: metadata.selector,
        testId: metadata.testId,
        screenshotFrame: frame,
      },
      attributes: metadata.attributes,
      href: metadata.href,
      inputType: metadata.inputType,
      disabled: metadata.disabled,
      checked: metadata.checked,
      viewport: metadata.viewport,
      scroll: metadata.scroll,
      captureFrame: metadata.captureFrame,
      crop: metadata.crop,
      centerPoint: metadata.centerPoint,
      source: metadata.source,
      sourceConfidence: metadata.sourceConfidence,
      selectionExplanation: metadata.selectionExplanation,
    };
    return `${index + 1}. ${builtInBrowserContextLabel(item)} (global browser, frame=${frame})\nPacket:\n${JSON.stringify(packet, null, 2)}`;
  });
  return [
    "Built-in browser visual and DOM context attached by the user.",
    "Each packet came from ADE's global built-in browser, which is not lane-scoped. Image attachments/crops are visual evidence for the same page area and use browser viewport coordinates.",
    "Use selectors, ARIA labels, attributes, text, URL/title, and the screenshot together. Do not assume the selected page belongs to the current lane unless the URL or user message says so.",
    ...rows,
    "",
  ].join("\n");
}
