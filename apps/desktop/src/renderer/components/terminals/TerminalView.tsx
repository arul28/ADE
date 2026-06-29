import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cn } from "../ui/cn";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_PREFERENCES,
  selectActiveProjectRoot,
  useAppStore,
  type TerminalPreferences,
  type ThemeId,
} from "../../state/appStore";
import { WORK_SURFACE_REVEALED_EVENT } from "./workSurfaceVisibility";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import type {
  PtyDataEvent,
  PtyExitEvent,
  TerminalSerializedSnapshot,
  TerminalSnapshotCell,
  TerminalSnapshotRow,
  TerminalSessionStatus,
} from "../../../shared/types";

type XtermTheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"];
type TerminalRendererMode = "webgl" | "dom";

export type TerminalHealthCounters = {
  fitFailures: number;
  zeroDimFits: number;
  rendererFallbacks: number;
  droppedChunks: number;
  fitRecoveries: number;
};

type RuntimeSnapshot = {
  exitCode: number | null;
  renderer: TerminalRendererMode;
  health: TerminalHealthCounters;
};

type TerminalRenderPreferences = Pick<TerminalPreferences, "fontFamily" | "fontSize" | "lineHeight" | "scrollback">;

type RuntimeListener = (snapshot: RuntimeSnapshot) => void;

type CachedRuntime = {
  key: string;
  ptyId: string;
  sessionId: string;
  projectRoot: string | null;
  projectRevision: number;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  opened: boolean;
  disposed: boolean;
  refs: number;
  listeners: Set<RuntimeListener>;
  exitCode: number | null;
  renderer: TerminalRendererMode;
  rendererAddon: { dispose: () => void } | null;
  rendererResetInFlight: boolean;
  lastRendererResetAt: number;
  health: TerminalHealthCounters;
  lastDims: TerminalDims | null;
  lastPtyResizeDims: TerminalDims | null;
  ptyResizeInFlight: boolean;
  inFlightPtyResizeDims: TerminalDims | null;
  queuedPtyResizeDims: TerminalDims | null;
  pendingForceResize: boolean;
  fitRafId: number | null;
  settleTimer1: ReturnType<typeof setTimeout> | null;
  settleTimer2: ReturnType<typeof setTimeout> | null;
  hydrateTimer: ReturnType<typeof setTimeout> | null;
  hydrateRetryTimer: ReturnType<typeof setTimeout> | null;
  hydrationBackfillTimer: ReturnType<typeof setTimeout> | null;
  hydrationBackfillAttempts: number;
  hasFittedOnce: boolean;
  hydrationStarted: boolean;
  hydrationCompleted: boolean;
  hasAppliedTerminalContent: boolean;
  displayedLiveDataBeforeHydration: boolean;
  pendingHydrationChunks: string[];
  pendingHydrationBytes: number;
  frameWriteChunks: string[];
  frameWriteBytes: number;
  inputWriteChunks: string[];
  inputWriteBytes: number;
  inputFlushTimer: ReturnType<typeof setTimeout> | null;
  liveStreamPaused: boolean;
  flushRafId: number | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  lastFitSafetyAt: number;
  ptyDataUnsub: (() => void) | null;
  ptyExitUnsub: (() => void) | null;
  termDataSub: { dispose: () => void } | null;
  linkProviderSub: { dispose: () => void } | null;
  rendererInitStarted: boolean;
  inputEnabled: boolean;
  active: boolean;
  visible: boolean;
  imagePasteMode: TerminalImagePasteMode;
  bracketedPasteMode: boolean;
  mouseTrackingModes: Set<number>;
  // Set when a webgl→dom fallback is in flight and the runtime turned
  // invisible before the webgl restore could run. Persists across renderer
  // changes so the restore can be retried on the next visibility-true.
  pendingWebGLRestore: boolean;
  invalidFitRetryTimer: ReturnType<typeof setTimeout> | null;
  fitWarningLogged: boolean;
  replayMode: boolean;
};

const HYDRATE_TAIL_BYTES = 2_000_000;
// Maximum transcript bytes loaded when replaying a disposed chat-CLI session.
// Keep this small enough that reopening a noisy terminal cannot balloon the
// renderer heap while the runtime still retains a larger disk transcript.
const REPLAY_TRANSCRIPT_MAX_BYTES = 3_000_000;
// Scrollback override for replay-mode runtimes so the entire flattened
// transcript stays scrollable in the chat pane.
const REPLAY_SCROLLBACK_LINES = 30_000;
const HYDRATION_BACKFILL_RETRY_MS = 250;
const HYDRATION_VISIBLE_BLANK_BACKFILL_RETRY_MS = 100;
const HYDRATION_BACKFILL_MAX_ATTEMPTS = 120;
const MAX_PENDING_HYDRATION_BYTES = 2_000_000;
const MAX_FRAME_WRITE_BYTES = 1_000_000;
const MAX_PTY_INPUT_BATCH_BYTES = 16_384;
const PTY_INPUT_BATCH_MS = 16;
const EXITED_RUNTIME_KEEPALIVE_MS = 8_000;
const MIN_VALID_COLS = 20;
const MIN_VALID_ROWS = 6;
const MIN_HOST_WIDTH_PX = 120;
const MIN_HOST_HEIGHT_PX = 48;
const INVALID_FIT_RETRY_MS = 90;
const RENDERER_RESET_COOLDOWN_MS = 250;
const TERMINAL_RENDERER_STORAGE_KEY = "ade.terminalRenderer";
const TERMINAL_CTRL_V = "\x16";
const TERMINAL_BRACKETED_PASTE_START = "\x1b[200~";
const TERMINAL_BRACKETED_PASTE_END = "\x1b[201~";
const TERMINAL_BRACKETED_PASTE_MODE = 2004;
const TERMINAL_LINK_PATTERN = /(?:https?:\/\/[^\s<>"'`]+|(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s<>"'`]*)?)/gi;
const TERMINAL_MOUSE_TRACKING_EVENT_MODES = new Set([1000, 1002, 1003]);
type TerminalImagePasteMode = "native-shortcut" | "runtime-attachment";
const runtimeCache = new Map<string, CachedRuntime>();
const ptyDataRuntimesByPtyId = new Map<string, Set<CachedRuntime>>();
const ptyExitRuntimesByPtyId = new Map<string, Set<CachedRuntime>>();
let sharedPtyDataUnsub: (() => void) | null = null;
let sharedPtyExitUnsub: (() => void) | null = null;
let ptyDataSubscriptionSignature: string | null = null;

function terminalRuntimeKey(args: {
  sessionId: string;
  ptyId?: string | null;
  projectRoot?: string | null;
}): string {
  return `${args.projectRoot ?? "<no-project>"}::${args.sessionId}::${args.ptyId ?? "<no-pty>"}`;
}
let parkedRoot: HTMLDivElement | null = null;

const terminalThemes: Record<"light" | "dark", XtermTheme> = {
  light: {
    background: "#F2F0ED",
    foreground: "#1C1917",
    cursor: "#C22323",
    cursorAccent: "#FDFBF7",
    selectionBackground: "rgba(194, 35, 35, 0.16)"
  },
  dark: {
    background: "#0c0e16",
    foreground: "#EDEDED",
    cursor: "#F59E0B",
    cursorAccent: "#0c0e16",
    selectionBackground: "rgba(245, 158, 11, 0.26)"
  }
};

function isDarkTheme(theme: ThemeId): boolean {
  return theme === "dark";
}

function terminalWebglRendererEnabled(): boolean {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(TERMINAL_RENDERER_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened/browser-like environments; still
    // honor the Linux renderer fallback below.
  }
  if (stored === "dom") return false;
  if (stored === "webgl") return true;
  const platform = window.navigator?.platform?.toLowerCase() ?? "";
  const userAgent = window.navigator?.userAgent?.toLowerCase() ?? "";
  if (platform.includes("linux") || userAgent.includes("linux")) return false;
  return true;
}

function cloneHealth(health: TerminalHealthCounters): TerminalHealthCounters {
  return {
    fitFailures: health.fitFailures,
    zeroDimFits: health.zeroDimFits,
    rendererFallbacks: health.rendererFallbacks,
    droppedChunks: health.droppedChunks,
    fitRecoveries: health.fitRecoveries
  };
}

function cleanTerminalLinkText(raw: string): string {
  return raw.replace(/[),.;:!?]+$/g, "");
}

function createTerminalLinkProvider(term: Terminal): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const lineIndex = Math.max(0, bufferLineNumber - 1);
      const line = term.buffer.active.getLine(lineIndex);
      if (!line) {
        callback(undefined);
        return;
      }
      const lineText = line.translateToString(false);
      TERMINAL_LINK_PATTERN.lastIndex = 0;
      const links: ILink[] = [];
      let match: RegExpExecArray | null;
      while ((match = TERMINAL_LINK_PATTERN.exec(lineText))) {
        const text = cleanTerminalLinkText(match[0]);
        if (!text.length) continue;
        const startX = match.index + 1;
        const endX = startX + text.length;
        links.push({
          text,
          range: {
            start: { x: startX, y: lineIndex + 1 },
            end: { x: endX, y: lineIndex + 1 },
          },
          decorations: { underline: true, pointerCursor: true },
          activate(event: MouseEvent) {
            event.preventDefault();
            openUrlInAdeBrowser(text);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}

type HostMeasurement = {
  width: number;
  height: number;
  visible: boolean;
};

type TerminalDims = {
  cols: number;
  rows: number;
};

type InitialHydrationData = {
  source: "snapshot" | "transcript" | "replay" | "empty";
  text: string;
};

type PreviewHydrationOptions = {
  snapshotOnly?: boolean;
};

type HydrationBackfillOptions = PreviewHydrationOptions & {
  delayMs?: number;
  replaceExistingTimer?: boolean;
};

function computeSuffixPrefixOverlap(left: string, right: string, maxChars = 12_000): number {
  if (!left.length || !right.length) return 0;
  const cap = Math.min(maxChars, left.length, right.length);
  for (let size = cap; size > 0; size -= 1) {
    if (left.slice(left.length - size) === right.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

function trimToLikelyTerminalFrameBoundary(raw: string): string {
  if (!raw.length) return raw;
  const markers = ["\x1b[H\x1b[2J", "\x1b[2J", "\x1b[3J", "\x1bc", "\x1b[?1049h", "\x1b[?1049l"];
  let idx = -1;
  for (const marker of markers) {
    const markerIdx = raw.lastIndexOf(marker);
    if (markerIdx > idx) idx = markerIdx;
  }
  if (idx <= 0) return raw;
  if (raw.length - idx < 16) return raw;
  return raw.slice(idx);
}

// Flatten a transcript that contains repeated TUI redraws into a linear stream
// the user can scroll through. We strip the alt-screen enter/leave toggles and
// the "clear screen" sequences so each redraw of a Codex/Claude chat surface
// appends to the main buffer's scrollback instead of clobbering it. Ordinary
// SGR (color), cursor-position, and OSC sequences are preserved verbatim so
// the ANSI colors and text layout match the live render.
export function stripFullScreenRedrawSequences(raw: string): string {
  if (!raw.length) return raw;
  return raw
    // Alt-screen enter/leave (1049 + the older 47 variant). Removing these
    // forces xterm to stay in the main buffer for the whole replay so the
    // scrollback captures every redraw.
    .replace(/\x1b\[\?(?:1049|47)[hl]/g, "")
    // Hard resets and full-screen erases that would otherwise wipe the buffer
    // mid-replay.
    .replace(/\x1b\[H\x1b\[2J/g, "")
    .replace(/\x1b\[[23]J/g, "")
    .replace(/\x1bc/g, "");
}

function hasRenderableTerminalText(data: string): boolean {
  if (!data.length) return false;
  const withoutControlSequences = data
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return /\S/.test(withoutControlSequences);
}

function terminalDomHasRenderableText(runtime: CachedRuntime): boolean {
  const rows = runtime.term.element?.querySelector<HTMLElement>(".xterm-rows")
    ?? runtime.host.querySelector<HTMLElement>(".xterm-rows");
  return Boolean(rows?.innerText?.trim() || rows?.textContent?.trim());
}

function needsHydrationBackfill(runtime: CachedRuntime): boolean {
  if (runtime.disposed || runtime.exitCode != null) return false;
  if (!runtime.hasAppliedTerminalContent && !runtime.displayedLiveDataBeforeHydration) return true;
  return Boolean(runtime.visible && runtime.active && !terminalDomHasRenderableText(runtime));
}

function ansiRgbParts(value: number | null | undefined): [number, number, number] | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const safe = Math.max(0, Math.min(0xffffff, Math.floor(value)));
  return [(safe >> 16) & 0xff, (safe >> 8) & 0xff, safe & 0xff];
}

function sgrCodesForSnapshotCell(cell: TerminalSnapshotCell): string[] {
  const codes = ["0"];
  if (cell.bold) codes.push("1");
  if (cell.dim) codes.push("2");
  if (cell.italic) codes.push("3");
  if (cell.underline) codes.push("4");
  if (cell.inverse) codes.push("7");
  if (cell.strikethrough) codes.push("9");

  if (cell.fgMode === "rgb") {
    const rgb = ansiRgbParts(cell.fg);
    if (rgb) codes.push("38", "2", String(rgb[0]), String(rgb[1]), String(rgb[2]));
  } else if (cell.fgMode === "palette" && typeof cell.fg === "number" && Number.isFinite(cell.fg)) {
    codes.push("38", "5", String(Math.max(0, Math.min(255, Math.floor(cell.fg)))));
  }

  if (cell.bgMode === "rgb") {
    const rgb = ansiRgbParts(cell.bg);
    if (rgb) codes.push("48", "2", String(rgb[0]), String(rgb[1]), String(rgb[2]));
  } else if (cell.bgMode === "palette" && typeof cell.bg === "number" && Number.isFinite(cell.bg)) {
    codes.push("48", "5", String(Math.max(0, Math.min(255, Math.floor(cell.bg)))));
  }

  return codes;
}

function snapshotCellStyleKey(cell: TerminalSnapshotCell): string {
  return [
    cell.fgMode,
    cell.fg ?? "",
    cell.bgMode,
    cell.bg ?? "",
    cell.bold ? "b" : "",
    cell.dim ? "d" : "",
    cell.italic ? "i" : "",
    cell.underline ? "u" : "",
    cell.inverse ? "v" : "",
    cell.strikethrough ? "s" : "",
  ].join("|");
}

function isTrimmedSnapshotBlank(cell: TerminalSnapshotCell | undefined): boolean {
  return Boolean(
    cell
    && (cell.text || " ") === " "
    && cell.bgMode === "default"
    && !cell.inverse,
  );
}

function trimmedSnapshotCells(row: TerminalSnapshotRow): TerminalSnapshotCell[] {
  let end = row.cells.length;
  while (end > 0 && isTrimmedSnapshotBlank(row.cells[end - 1])) end -= 1;
  return row.cells.slice(0, end);
}

function serializeSnapshotVisibleRows(snapshot: TerminalSerializedSnapshot): string | null {
  const rows = snapshot.visibleRows.slice(0, Math.max(0, snapshot.rows));
  if (rows.length === 0) return null;

  const parts: string[] = [];
  if (snapshot.bufferType === "alternate") parts.push("\x1b[?1049h");
  else parts.push("\x1b[?1049l");
  parts.push("\x1b[?25l", "\x1b[?7l", "\x1b[0m", "\x1b[H", "\x1b[J");

  rows.forEach((row, y) => {
    const cells = trimmedSnapshotCells(row);
    if (cells.length === 0) return;
    parts.push(`\x1b[${y + 1};1H`);
    let lastStyleKey = "";
    for (const cell of cells) {
      const styleKey = snapshotCellStyleKey(cell);
      if (styleKey !== lastStyleKey) {
        parts.push(`\x1b[${sgrCodesForSnapshotCell(cell).join(";")}m`);
        lastStyleKey = styleKey;
      }
      parts.push(cell.text || " ");
    }
    parts.push("\x1b[0m");
  });

  const cursorY = Math.max(0, Math.min(Math.max(0, snapshot.rows - 1), snapshot.cursorY));
  const cursorX = Math.max(0, Math.min(Math.max(0, snapshot.cols - 1), snapshot.cursorX));
  parts.push(`\x1b[${cursorY + 1};${cursorX + 1}H`, "\x1b[?7h", "\x1b[?25h");
  return parts.join("");
}

function configureParkedRoot(root: HTMLDivElement): void {
  root.setAttribute("data-ade-terminal-parking", "true");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("inert", "");
  root.tabIndex = -1;
  root.style.position = "fixed";
  root.style.width = "0";
  root.style.height = "0";
  root.style.overflow = "hidden";
  root.style.opacity = "0";
  root.style.pointerEvents = "none";
  root.style.left = "0";
  root.style.top = "0";
  root.style.visibility = "hidden";
  root.style.contain = "strict";
}

function ensureParkedRoot(): HTMLDivElement {
  const existing = parkedRoot && parkedRoot.isConnected
    ? parkedRoot
    : document.querySelector<HTMLDivElement>("[data-ade-terminal-parking='true']");
  if (existing) {
    for (const duplicate of document.querySelectorAll<HTMLDivElement>("[data-ade-terminal-parking='true']")) {
      if (duplicate === existing) continue;
      while (duplicate.firstChild) existing.appendChild(duplicate.firstChild);
      duplicate.remove();
    }
    configureParkedRoot(existing);
    parkedRoot = existing;
    return existing;
  }

  const next = document.createElement("div");
  configureParkedRoot(next);
  document.body.appendChild(next);
  parkedRoot = next;
  return next;
}

function measureHost(host: HTMLDivElement): HostMeasurement {
  const rect = host.getBoundingClientRect();
  const width = Math.max(rect.width, host.clientWidth, host.offsetWidth, 0);
  const height = Math.max(rect.height, host.clientHeight, host.offsetHeight, 0);
  return {
    width,
    height,
    visible: host.isConnected && width >= MIN_HOST_WIDTH_PX && height >= MIN_HOST_HEIGHT_PX
  };
}

function hasValidDims(dims: TerminalDims | null | undefined): dims is TerminalDims {
  return Boolean(
    dims
    && Number.isFinite(dims.cols)
    && Number.isFinite(dims.rows)
    && dims.cols >= MIN_VALID_COLS
    && dims.rows >= MIN_VALID_ROWS
  );
}

function sameDims(left: TerminalDims | null | undefined, right: TerminalDims | null | undefined): boolean {
  return Boolean(left && right && left.cols === right.cols && left.rows === right.rows);
}

function flushQueuedPtyResize(runtime: CachedRuntime): void {
  if (runtime.disposed || runtime.ptyResizeInFlight) return;
  const next = runtime.queuedPtyResizeDims;
  runtime.queuedPtyResizeDims = null;
  if (!next || sameDims(runtime.lastPtyResizeDims, next)) return;
  sendPtyResize(runtime, next);
}

function sendPtyResize(runtime: CachedRuntime, dims: TerminalDims): void {
  if (runtime.disposed) return;
  runtime.ptyResizeInFlight = true;
  runtime.inFlightPtyResizeDims = dims;
  window.ade.pty.resize({ ptyId: runtime.ptyId, cols: dims.cols, rows: dims.rows })
    .then(
      () => {
        runtime.lastPtyResizeDims = dims;
      },
      () => {
        if (sameDims(runtime.lastPtyResizeDims, dims)) {
          runtime.lastPtyResizeDims = null;
        }
      },
    )
    .finally(() => {
      runtime.ptyResizeInFlight = false;
      runtime.inFlightPtyResizeDims = null;
      flushQueuedPtyResize(runtime);
    });
}

function requestPtyResize(runtime: CachedRuntime, dims: TerminalDims, force = false): void {
  if (runtime.disposed) return;
  if (!force && sameDims(runtime.lastPtyResizeDims, dims) && !runtime.ptyResizeInFlight) return;
  if (runtime.ptyResizeInFlight) {
    if (force || !sameDims(runtime.inFlightPtyResizeDims, dims)) {
      runtime.queuedPtyResizeDims = dims;
    }
    return;
  }
  sendPtyResize(runtime, dims);
}

function clearTextureAtlas(runtime: CachedRuntime) {
  try {
    runtime.term.clearTextureAtlas();
  } catch {
    // ignore when the active renderer doesn't support the texture atlas API
  }
}

function applyRuntimeVisualOptions(
  runtime: CachedRuntime,
  args: {
    theme: XtermTheme;
    preferences: TerminalRenderPreferences;
  },
) {
  try {
    runtime.term.options.theme = args.theme ? { ...args.theme } : undefined;
    runtime.term.options.fontFamily = args.preferences.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
    // Integer cell metrics — see the ctor note: fractional sizes crowd glyphs and
    // dash box-drawing strokes in the WebGL renderer.
    runtime.term.options.fontSize = Math.round(args.preferences.fontSize);
    runtime.term.options.lineHeight = args.preferences.lineHeight;
    // Replay mode owns its own scrollback budget so the flattened transcript
    // stays available; ordinary preference updates must not clobber it.
    runtime.term.options.scrollback = runtime.replayMode
      ? Math.max(args.preferences.scrollback, REPLAY_SCROLLBACK_LINES)
      : args.preferences.scrollback;
  } catch {
    // ignore updates after disposal
  }
}

function restoreTerminalDims(runtime: CachedRuntime, dims: TerminalDims) {
  try {
    runtime.term.resize(dims.cols, dims.rows);
  } catch {
    // ignore restore failures after disposal
  }
}

function scheduleInvalidFitRetry(runtime: CachedRuntime) {
  if (runtime.disposed || runtime.invalidFitRetryTimer) return;
  runtime.invalidFitRetryTimer = setTimeout(() => {
    runtime.invalidFitRetryTimer = null;
    if (runtime.disposed) return;
    scheduleFit(runtime);
  }, INVALID_FIT_RETRY_MS);
}

function warnInvalidFitOnce(runtime: CachedRuntime, args: {
  measurement: HostMeasurement;
  nextDims: TerminalDims;
  previousDims: TerminalDims | null;
}) {
  if (runtime.fitWarningLogged) return;
  runtime.fitWarningLogged = true;
  console.warn("[TerminalView] rejected implausible fit result", {
    sessionId: runtime.sessionId,
    ptyId: runtime.ptyId,
    measurement: args.measurement,
    nextDims: args.nextDims,
    previousDims: args.previousDims
  });
}

function notifyRuntime(runtime: CachedRuntime) {
  const snapshot: RuntimeSnapshot = {
    exitCode: runtime.exitCode,
    renderer: runtime.renderer,
    health: cloneHealth(runtime.health)
  };
  for (const listener of runtime.listeners) {
    try {
      listener(snapshot);
    } catch {
      // ignore listener errors
    }
  }
}

function incrementHealth(runtime: CachedRuntime, key: keyof TerminalHealthCounters) {
  runtime.health[key] += 1;
  notifyRuntime(runtime);
}

function clearDisposeTimer(runtime: CachedRuntime) {
  if (!runtime.disposeTimer) return;
  clearTimeout(runtime.disposeTimer);
  runtime.disposeTimer = null;
}

function parkRuntime(runtime: CachedRuntime) {
  setRuntimeInteractionState(runtime, false);
  const parking = ensureParkedRoot();
  if (runtime.host.parentElement !== parking) {
    parking.appendChild(runtime.host);
  }
}

function disposeStaleRuntimes(activeProjectRoot: string | null, activeProjectRevision: number) {
  for (const runtime of runtimeCache.values()) {
    const isLiveRuntime = runtime.exitCode == null;
    if (activeProjectRoot == null) {
      if (runtime.projectRoot != null && !isLiveRuntime && runtime.refs === 0) {
        teardownRuntime(runtime);
      }
      continue;
    }

    if (!isLiveRuntime && runtime.refs === 0 && runtime.projectRoot === activeProjectRoot && runtime.projectRevision !== activeProjectRevision) {
      scheduleRuntimeDispose(runtime, EXITED_RUNTIME_KEEPALIVE_MS);
    }
  }
}

export function disposeTerminalRuntimesForProjectChange(
  activeProjectRoot: string | null,
  activeProjectRevision: number,
): void {
  disposeStaleRuntimes(activeProjectRoot, activeProjectRevision);
}

function setRuntimeInteractionState(runtime: CachedRuntime, active: boolean) {
  runtime.active = active;
  runtime.inputEnabled = active;
  try {
    runtime.host.tabIndex = active ? 0 : -1;
  } catch {
    // ignore
  }
  try {
    if (active) {
      runtime.host.removeAttribute("aria-hidden");
    } else {
      runtime.host.setAttribute("aria-hidden", "true");
    }
  } catch {
    // ignore
  }
  try {
    if (active) {
      runtime.host.removeAttribute("inert");
    } else {
      runtime.host.setAttribute("inert", "");
    }
  } catch {
    // ignore
  }
}

function shouldRuntimeReceivePtyData(runtime: CachedRuntime): boolean {
  return !runtime.disposed && runtime.refs > 0 && runtime.visible;
}

function updatePtyDataSubscriptions(): void {
  const ptyIds = new Set<string>();
  for (const [ptyId, runtimes] of ptyDataRuntimesByPtyId) {
    for (const runtime of runtimes) {
      if (shouldRuntimeReceivePtyData(runtime)) {
        ptyIds.add(ptyId);
        break;
      }
    }
  }

  const next = [...ptyIds].sort();
  const signature = next.join("\0");
  if (signature === ptyDataSubscriptionSignature) return;
  ptyDataSubscriptionSignature = signature;

  const setDataSubscriptions = window.ade.pty.setDataSubscriptions;
  if (typeof setDataSubscriptions !== "function") return;
  setDataSubscriptions({ ptyIds: next }).catch(() => {});
}

function clearRuntimeHydrationTimers(runtime: CachedRuntime): void {
  if (runtime.hydrateTimer) {
    clearTimeout(runtime.hydrateTimer);
    runtime.hydrateTimer = null;
  }
  if (runtime.hydrateRetryTimer) {
    clearTimeout(runtime.hydrateRetryTimer);
    runtime.hydrateRetryTimer = null;
  }
  if (runtime.hydrationBackfillTimer) {
    clearTimeout(runtime.hydrationBackfillTimer);
    runtime.hydrationBackfillTimer = null;
  }
}

function pauseRuntimePtyStream(runtime: CachedRuntime): void {
  if (runtime.liveStreamPaused) return;
  runtime.liveStreamPaused = true;
  runtime.pendingHydrationChunks.length = 0;
  runtime.pendingHydrationBytes = 0;
  discardScheduledFrameWrites(runtime);
}

function resumeRuntimePtyStream(runtime: CachedRuntime): void {
  if (!runtime.liveStreamPaused || !shouldRuntimeReceivePtyData(runtime)) return;
  runtime.liveStreamPaused = false;
  runtime.displayedLiveDataBeforeHydration = false;
  runtime.hydrationStarted = false;
  runtime.hydrationCompleted = false;
  runtime.hydrationBackfillAttempts = 0;
  runtime.pendingHydrationChunks.length = 0;
  runtime.pendingHydrationBytes = 0;
  clearRuntimeHydrationTimers(runtime);
  discardScheduledFrameWrites(runtime);
  startHydration(runtime);
}

function syncRuntimePtyDataStreaming(runtime: CachedRuntime, wasReceiving: boolean): void {
  const isReceiving = shouldRuntimeReceivePtyData(runtime);
  if (wasReceiving && !isReceiving) {
    pauseRuntimePtyStream(runtime);
  } else if (!wasReceiving && isReceiving) {
    resumeRuntimePtyStream(runtime);
  }
  updatePtyDataSubscriptions();
}

function setRuntimeVisibilityState(runtime: CachedRuntime, visible: boolean) {
  const wasReceiving = shouldRuntimeReceivePtyData(runtime);
  runtime.visible = visible;
  syncRuntimePtyDataStreaming(runtime, wasReceiving);
}

function clearPtyInputFlushTimer(runtime: CachedRuntime): void {
  if (runtime.inputFlushTimer) {
    clearTimeout(runtime.inputFlushTimer);
    runtime.inputFlushTimer = null;
  }
}

function writePtyInputNow(runtime: CachedRuntime, data: string) {
  if (!data || runtime.disposed) return;
  window.ade.pty.write({ ptyId: runtime.ptyId, data }).catch(() => {});
}

function consumePendingPtyInput(runtime: CachedRuntime): string {
  clearPtyInputFlushTimer(runtime);
  if (!runtime.inputWriteChunks.length || runtime.disposed) return "";
  const data = runtime.inputWriteChunks.join("");
  runtime.inputWriteChunks.length = 0;
  runtime.inputWriteBytes = 0;
  return data;
}

function flushPendingPtyInput(runtime: CachedRuntime): void {
  const data = consumePendingPtyInput(runtime);
  if (!data) return;
  writePtyInputNow(runtime, data);
}

function writePtyInput(runtime: CachedRuntime, data: string) {
  if (!data || runtime.disposed) return;
  writePtyInputNow(runtime, `${consumePendingPtyInput(runtime)}${data}`);
}

function formatTextPasteForTerminal(runtime: CachedRuntime, text: string): string {
  const prepared = text.replace(/\r?\n/g, "\r");
  if (!runtime.bracketedPasteMode) return prepared;
  const sanitized = prepared.replace(/\x1b/g, "\u241b");
  return `${TERMINAL_BRACKETED_PASTE_START}${sanitized}${TERMINAL_BRACKETED_PASTE_END}`;
}

function shouldFlushPtyInputImmediately(data: string): boolean {
  return /[\x00-\x1f\x7f]|\x1b/.test(data);
}

function schedulePtyInputFlush(runtime: CachedRuntime): void {
  clearPtyInputFlushTimer(runtime);
  runtime.inputFlushTimer = setTimeout(() => {
    runtime.inputFlushTimer = null;
    flushPendingPtyInput(runtime);
  }, PTY_INPUT_BATCH_MS);
}

function enqueuePtyInput(runtime: CachedRuntime, data: string) {
  if (!data || runtime.disposed) return;
  runtime.inputWriteChunks.push(data);
  runtime.inputWriteBytes += data.length;
  if (shouldFlushPtyInputImmediately(data) || runtime.inputWriteBytes >= MAX_PTY_INPUT_BATCH_BYTES) {
    flushPendingPtyInput(runtime);
    return;
  }
  schedulePtyInputFlush(runtime);
}

function updateTerminalInputModes(runtime: CachedRuntime, data: string): void {
  for (const match of data.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
    const action = match[2];
    for (const rawParam of match[1].split(";")) {
      const mode = Number(rawParam);
      if (mode === TERMINAL_BRACKETED_PASTE_MODE) {
        runtime.bracketedPasteMode = action === "h";
        continue;
      }
      if (!TERMINAL_MOUSE_TRACKING_EVENT_MODES.has(mode)) continue;
      if (action === "h") {
        runtime.mouseTrackingModes.add(mode);
      } else {
        runtime.mouseTrackingModes.delete(mode);
      }
    }
  }
}

function isTerminalMouseTrackingActive(runtime: CachedRuntime): boolean {
  const xtermMode = runtime.term.modes?.mouseTrackingMode;
  return runtime.mouseTrackingModes.size > 0 || (xtermMode != null && xtermMode !== "none");
}

async function pasteNativeClipboardImageShortcut(runtime: CachedRuntime): Promise<boolean> {
  if (runtime.disposed) return false;
  try {
    const hasImage = await window.ade.app.hasClipboardImage();
    if (!hasImage || runtime.disposed) return false;
    writePtyInput(runtime, TERMINAL_CTRL_V);
    return true;
  } catch {
    return false;
  }
}

function bracketedPaste(text: string): string {
  return `${TERMINAL_BRACKETED_PASTE_START}${text.trimEnd()}\n${TERMINAL_BRACKETED_PASTE_END}`;
}

function formatClipboardImageForPty(path: string, mimeType: string): string {
  return [
    "ADE clipboard image attached.",
    `Path: ${path}`,
    `Type: ${mimeType || "image/png"}`,
    "",
  ].join("\n");
}

async function pasteRuntimeClipboardImageAttachment(runtime: CachedRuntime): Promise<boolean> {
  if (runtime.disposed) return false;
  try {
    const image = await window.ade.app.readClipboardImage();
    if (!image || runtime.disposed) return false;
    const saved = await window.ade.agentChat.saveTempAttachment({
      data: image.data,
      filename: image.filename || "clipboard.png",
    });
    if (runtime.disposed) return false;
    writePtyInput(runtime, bracketedPaste(formatClipboardImageForPty(saved.path, image.mimeType)));
    return true;
  } catch {
    return false;
  }
}

function pasteClipboardImageShortcut(runtime: CachedRuntime, mode: TerminalImagePasteMode): Promise<boolean> {
  return mode === "runtime-attachment"
    ? pasteRuntimeClipboardImageAttachment(runtime)
    : pasteNativeClipboardImageShortcut(runtime);
}

async function writeTerminalSelectionToClipboard(text: string): Promise<void> {
  try {
    const appBridge = window.ade?.app;
    const writeClipboardText = appBridge?.writeClipboardText;
    if (typeof writeClipboardText === "function") {
      const result: unknown = await writeClipboardText.call(appBridge, text);
      if (result !== false) return;
    }
  } catch {
    // Browser-preview/test fallback below covers missing or partial bridges.
  }
  const writeText = navigator.clipboard?.writeText;
  if (typeof writeText !== "function") return;
  try {
    await writeText.call(navigator.clipboard, text);
  } catch {
    // Ignore clipboard permission failures; there is no useful terminal-side
    // recovery once the copy key has been handled.
  }
}

function teardownRuntime(runtime: CachedRuntime) {
  flushPendingPtyInput(runtime);
  runtime.disposed = true;
  clearDisposeTimer(runtime);
  if (runtime.fitRafId != null) cancelAnimationFrame(runtime.fitRafId);
  if (runtime.flushRafId != null) cancelAnimationFrame(runtime.flushRafId);
  if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
  clearPtyInputFlushTimer(runtime);
  if (runtime.settleTimer1) clearTimeout(runtime.settleTimer1);
  if (runtime.settleTimer2) clearTimeout(runtime.settleTimer2);
  if (runtime.hydrateTimer) clearTimeout(runtime.hydrateTimer);
  if (runtime.hydrateRetryTimer) clearTimeout(runtime.hydrateRetryTimer);
  if (runtime.hydrationBackfillTimer) clearTimeout(runtime.hydrationBackfillTimer);
  if (runtime.invalidFitRetryTimer) clearTimeout(runtime.invalidFitRetryTimer);

  try {
    runtime.ptyDataUnsub?.();
  } catch {
    // ignore
  }
  try {
    runtime.ptyExitUnsub?.();
  } catch {
    // ignore
  }
  try {
    runtime.termDataSub?.dispose();
  } catch {
    // ignore
  }
  try {
    runtime.linkProviderSub?.dispose();
  } catch {
    // ignore
  }
  try {
    runtime.rendererAddon?.dispose();
  } catch {
    // ignore
  }
  try {
    runtime.term.dispose();
  } catch {
    // ignore
  }
  try {
    runtime.host.remove();
  } catch {
    // ignore
  }

  runtimeCache.delete(runtime.key);
}

function scheduleRuntimeDispose(runtime: CachedRuntime, delayMs: number) {
  clearDisposeTimer(runtime);
  runtime.disposeTimer = setTimeout(() => {
    if (runtime.refs > 0) return;
    teardownRuntime(runtime);
  }, delayMs);
}

function ensureOpen(runtime: CachedRuntime): boolean {
  if (runtime.disposed) return false;
  if (runtime.term.element) return true;
  if (!runtime.visible) return false;
  if (!measureHost(runtime.host).visible) return false;
  try {
    runtime.term.open(runtime.host);
    runtime.opened = true;
  } catch {
    return false;
  }
  return true;
}

function doFit(runtime: CachedRuntime, forcePtyResize = false) {
  if (runtime.disposed) return;
  if (!runtime.visible && runtime.hasFittedOnce) return;
  if (!ensureOpen(runtime)) return;
  const measurement = measureHost(runtime.host);
  if (!measurement.visible) return;
  const previousDims = hasValidDims(runtime.lastDims)
    ? runtime.lastDims
    : hasValidDims({ cols: runtime.term.cols, rows: runtime.term.rows })
      ? { cols: runtime.term.cols, rows: runtime.term.rows }
      : null;

  // Hide cursor before fit to prevent ghost cursor artifact at stale position
  const cursorLayer = runtime.host.querySelector<HTMLElement>(".xterm-cursor-layer");
  if (cursorLayer) cursorLayer.style.visibility = "hidden";
  clearTextureAtlas(runtime);

  try {
    runtime.fit.fit();
  } catch {
    if (cursorLayer) cursorLayer.style.visibility = "";
    incrementHealth(runtime, "fitFailures");
    return;
  }

  const next = { cols: runtime.term.cols, rows: runtime.term.rows };
  const zeroDimFit =
    !Number.isFinite(next.cols) || !Number.isFinite(next.rows) || next.cols <= 0 || next.rows <= 0;
  const implausibleFit = zeroDimFit || next.cols < MIN_VALID_COLS || next.rows < MIN_VALID_ROWS;
  if (implausibleFit) {
    if (zeroDimFit) incrementHealth(runtime, "zeroDimFits");
    incrementHealth(runtime, "fitRecoveries");
    if (previousDims) restoreTerminalDims(runtime, previousDims);
    warnInvalidFitOnce(runtime, { measurement, nextDims: next, previousDims });
    scheduleInvalidFitRetry(runtime);
    try {
      runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
    } catch {
      // ignore refresh failures after dispose
    }
    if (cursorLayer) {
      requestAnimationFrame(() => {
        cursorLayer.style.visibility = "";
      });
    }
    return;
  }

  runtime.hasFittedOnce = true;
  const prev = previousDims;
  if (!prev || prev.cols !== next.cols || prev.rows !== next.rows || forcePtyResize) {
    runtime.lastDims = next;
    requestPtyResize(runtime, next, forcePtyResize);
  }

  // Safety pass for right-edge clipping and stale col counts.
  const viewport = runtime.host.querySelector<HTMLElement>(".xterm-viewport");
  const screen = runtime.host.querySelector<HTMLElement>(".xterm-screen");
  if (viewport && screen) {
    const slack = viewport.clientWidth - screen.clientWidth;
    if (slack > 2 && Date.now() - runtime.lastFitSafetyAt > 120) {
      runtime.lastFitSafetyAt = Date.now();
      runtime.pendingForceResize = true;
      if (runtime.fitRafId == null) {
        runtime.fitRafId = requestAnimationFrame(() => {
          runtime.fitRafId = null;
          const force = runtime.pendingForceResize;
          runtime.pendingForceResize = false;
          doFit(runtime, force);
        });
      }
    }
  }

  try {
    runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
  } catch {
    // ignore refresh failures after dispose
  }

  // Restore cursor visibility after refresh completes on next frame
  if (cursorLayer) {
    requestAnimationFrame(() => {
      cursorLayer.style.visibility = "";
    });
  }
}

function scheduleFit(runtime: CachedRuntime, forcePtyResize = false) {
  if (runtime.disposed) return;
  if (!runtime.visible && runtime.hasFittedOnce) return;
  if (forcePtyResize && !runtime.visible) return;
  runtime.pendingForceResize = runtime.pendingForceResize || forcePtyResize;
  if (runtime.fitRafId != null) return;
  runtime.fitRafId = requestAnimationFrame(() => {
    runtime.fitRafId = null;
    const shouldForce = runtime.pendingForceResize;
    runtime.pendingForceResize = false;
    doFit(runtime, shouldForce);
  });
}

function flushFrameWriteChunksSync(runtime: CachedRuntime) {
  if (runtime.disposed) return;
  if (runtime.frameWriteChunks.length === 0) return;
  const merged = runtime.frameWriteChunks.join("");
  runtime.frameWriteChunks.length = 0;
  runtime.frameWriteBytes = 0;
  const followOutput = shouldFollowTerminalOutput(runtime);
  try {
    runtime.term.write(merged);
    if (hasRenderableTerminalText(merged)) {
      runtime.hasAppliedTerminalContent = true;
    }
    scheduleVisibleFrameRefresh(runtime, { scrollToBottom: followOutput });
  } catch {
    // ignore write errors after disposal
  }
}

function shouldFollowTerminalOutput(runtime: CachedRuntime): boolean {
  try {
    const buffer = runtime.term.buffer.active;
    return buffer.viewportY >= buffer.baseY - 1;
  } catch {
    return true;
  }
}

function scheduleVisibleFrameRefresh(runtime: CachedRuntime, options: { scrollToBottom: boolean }) {
  if (runtime.disposed || runtime.refs === 0 || !runtime.visible || !runtime.active) return;
  if (document.visibilityState !== "visible") return;
  requestAnimationFrame(() => {
    if (runtime.disposed || runtime.refs === 0 || !runtime.visible || !runtime.active) return;
    if (document.visibilityState !== "visible") return;
    try {
      if (options.scrollToBottom) {
        runtime.term.scrollToBottom();
      }
      runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
    } catch {
      // ignore refresh failures after disposal
    }
  });
}

function clearFrameWriteSchedule(runtime: CachedRuntime) {
  if (runtime.flushRafId != null) {
    cancelAnimationFrame(runtime.flushRafId);
    runtime.flushRafId = null;
  }
  if (runtime.flushTimer) {
    clearTimeout(runtime.flushTimer);
    runtime.flushTimer = null;
  }
}

function discardScheduledFrameWrites(runtime: CachedRuntime) {
  clearFrameWriteSchedule(runtime);
  runtime.frameWriteChunks.length = 0;
  runtime.frameWriteBytes = 0;
}

function flushPendingFrameWrites(runtime: CachedRuntime) {
  clearFrameWriteSchedule(runtime);
  flushFrameWriteChunksSync(runtime);
}

function enqueueFrameWrite(runtime: CachedRuntime, chunk: string) {
  if (!chunk) return;
  runtime.frameWriteChunks.push(chunk);
  runtime.frameWriteBytes += chunk.length;
  while (runtime.frameWriteBytes > MAX_FRAME_WRITE_BYTES && runtime.frameWriteChunks.length > 1) {
    const dropped = runtime.frameWriteChunks.shift();
    runtime.frameWriteBytes -= dropped?.length ?? 0;
    incrementHealth(runtime, "droppedChunks");
  }
  scheduleFrameWriteFlush(runtime);
}

function scheduleFrameWriteFlush(runtime: CachedRuntime) {
  if (runtime.flushRafId != null || runtime.flushTimer) return;
  const flush = () => {
    runtime.flushRafId = null;
    runtime.flushTimer = null;
    flushFrameWriteChunksSync(runtime);
  };
  if (runtime.refs === 0 || !runtime.visible || document.visibilityState !== "visible") {
    // Hidden or parked terminals can stream heavily while the user is looking
    // elsewhere. Keep only the bounded pending tail and write it when the
    // terminal is revealed; that avoids doing xterm layout/buffer work for
    // invisible CLI sessions.
    return;
  }
  runtime.flushRafId = requestAnimationFrame(flush);
}

function shouldDeliverPtyEvent(runtime: CachedRuntime, projectRoot: string | undefined): boolean {
  if (runtime.disposed) return false;
  return !(projectRoot && runtime.projectRoot && projectRoot !== runtime.projectRoot);
}

function handleRuntimePtyData(runtime: CachedRuntime, ev: PtyDataEvent) {
  if (!shouldDeliverPtyEvent(runtime, ev.projectRoot)) return;
  if (!shouldRuntimeReceivePtyData(runtime)) {
    pauseRuntimePtyStream(runtime);
    return;
  }
  updateTerminalInputModes(runtime, ev.data);

  if (!runtime.hydrationCompleted) {
    runtime.pendingHydrationChunks.push(ev.data);
    runtime.pendingHydrationBytes += ev.data.length;
    while (runtime.pendingHydrationBytes > MAX_PENDING_HYDRATION_BYTES && runtime.pendingHydrationChunks.length > 1) {
      const dropped = runtime.pendingHydrationChunks.shift();
      runtime.pendingHydrationBytes -= dropped?.length ?? 0;
      incrementHealth(runtime, "droppedChunks");
    }
    if (hasRenderableTerminalText(ev.data)) {
      runtime.displayedLiveDataBeforeHydration = true;
      if (runtime.visible && runtime.active && !terminalDomHasRenderableText(runtime)) {
        scheduleHydrationBackfill(runtime, {
          delayMs: HYDRATION_VISIBLE_BLANK_BACKFILL_RETRY_MS,
          replaceExistingTimer: true,
          snapshotOnly: true,
        });
      }
    }
    enqueueFrameWrite(runtime, ev.data);
    return;
  }

  enqueueFrameWrite(runtime, ev.data);
}

function handleRuntimePtyExit(runtime: CachedRuntime, ev: PtyExitEvent) {
  if (!shouldDeliverPtyEvent(runtime, ev.projectRoot)) return;
  runtime.exitCode = ev.exitCode ?? 0;
  notifyRuntime(runtime);
  if (runtime.refs === 0) {
    scheduleRuntimeDispose(runtime, EXITED_RUNTIME_KEEPALIVE_MS);
  }
}

function removeRuntimePtySubscription(
  map: Map<string, Set<CachedRuntime>>,
  runtime: CachedRuntime,
) {
  const runtimes = map.get(runtime.ptyId);
  if (!runtimes) return;
  runtimes.delete(runtime);
  if (runtimes.size === 0) map.delete(runtime.ptyId);
}

function subscribeRuntimePtyData(runtime: CachedRuntime): () => void {
  let runtimes = ptyDataRuntimesByPtyId.get(runtime.ptyId);
  if (!runtimes) {
    runtimes = new Set();
    ptyDataRuntimesByPtyId.set(runtime.ptyId, runtimes);
  }
  runtimes.add(runtime);
  updatePtyDataSubscriptions();
  if (!sharedPtyDataUnsub) {
    sharedPtyDataUnsub = window.ade.pty.onData((ev) => {
      const targets = ptyDataRuntimesByPtyId.get(ev.ptyId);
      if (!targets) return;
      for (const target of [...targets]) handleRuntimePtyData(target, ev);
    });
  }
  return () => {
    removeRuntimePtySubscription(ptyDataRuntimesByPtyId, runtime);
    updatePtyDataSubscriptions();
    if (ptyDataRuntimesByPtyId.size === 0 && sharedPtyDataUnsub) {
      ptyDataSubscriptionSignature = null;
      sharedPtyDataUnsub();
      sharedPtyDataUnsub = null;
    }
  };
}

function subscribeRuntimePtyExit(runtime: CachedRuntime): () => void {
  let runtimes = ptyExitRuntimesByPtyId.get(runtime.ptyId);
  if (!runtimes) {
    runtimes = new Set();
    ptyExitRuntimesByPtyId.set(runtime.ptyId, runtimes);
  }
  runtimes.add(runtime);
  if (!sharedPtyExitUnsub) {
    sharedPtyExitUnsub = window.ade.pty.onExit((ev) => {
      const targets = ptyExitRuntimesByPtyId.get(ev.ptyId);
      if (!targets) return;
      for (const target of [...targets]) handleRuntimePtyExit(target, ev);
    });
  }
  return () => {
    removeRuntimePtySubscription(ptyExitRuntimesByPtyId, runtime);
    if (ptyExitRuntimesByPtyId.size === 0 && sharedPtyExitUnsub) {
      sharedPtyExitUnsub();
      sharedPtyExitUnsub = null;
    }
  };
}

function flushHydrationData(
  runtime: CachedRuntime,
  tail: string,
  options: { appendPending?: boolean; replay?: boolean } = {},
) {
  // Replay mode already stripped alt-screen/clear-screen sequences before this
  // point, so the entire transcript should be written verbatim. Trimming to a
  // frame boundary here would discard everything before the last redraw.
  const stabilizedTail = options.replay ? tail : trimToLikelyTerminalFrameBoundary(tail);
  const shouldAppendPending = options.appendPending ?? true;
  const pending = shouldAppendPending ? runtime.pendingHydrationChunks.join("") : "";
  runtime.pendingHydrationChunks.length = 0;
  runtime.pendingHydrationBytes = 0;

  const overlap = computeSuffixPrefixOverlap(stabilizedTail, pending);
  let appendPending = shouldAppendPending;
  if (shouldAppendPending && pending.length >= 8_000 && overlap < 64) {
    const probe = pending.slice(0, Math.min(512, pending.length));
    if (probe.length >= 64 && stabilizedTail.lastIndexOf(probe) !== -1) {
      appendPending = false;
    }
  }

  const merged = appendPending ? `${stabilizedTail}${pending.slice(overlap)}` : stabilizedTail;
  if (merged.length) {
    updateTerminalInputModes(runtime, merged);
    try {
      runtime.term.write(merged);
      if (hasRenderableTerminalText(merged)) {
        runtime.hasAppliedTerminalContent = true;
      }
      requestAnimationFrame(() => {
        try {
          runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
          runtime.term.scrollToBottom();
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }
}

async function readPreviewHydrationData(
  runtime: CachedRuntime,
  options: PreviewHydrationOptions = {},
): Promise<InitialHydrationData> {
  const preview = await window.ade.terminal.preview({
    terminalId: runtime.sessionId,
    maxBytes: HYDRATE_TAIL_BYTES,
  });
  if (preview?.snapshot) {
    const visibleRows = serializeSnapshotVisibleRows(preview.snapshot);
    if (visibleRows) return { source: "snapshot", text: visibleRows };
    if (preview.snapshot.serialized) return { source: "snapshot", text: preview.snapshot.serialized };
  }
  if (options.snapshotOnly) return { source: "empty", text: "" };
  if (preview?.transcript) return { source: "transcript", text: preview.transcript };
  return { source: "empty", text: "" };
}

async function readReplayHydrationData(runtime: CachedRuntime): Promise<InitialHydrationData> {
  // Use sessions.readTranscriptTail (not terminal.read) so this works for chat-CLI
  // tool types — terminal.read/preview throws for isPersistedChatToolType sessions.
  const data = await window.ade.sessions.readTranscriptTail({
    sessionId: runtime.sessionId,
    maxBytes: REPLAY_TRANSCRIPT_MAX_BYTES,
    raw: true,
  });
  if (!data) return { source: "empty", text: "" };
  return { source: "replay", text: stripFullScreenRedrawSequences(data) };
}

async function tryReadReplay(
  runtime: CachedRuntime,
  exitCodeHint: number | null,
): Promise<InitialHydrationData | null> {
  try {
    const replay = await readReplayHydrationData(runtime);
    if (replay.text) {
      runtime.replayMode = true;
      if (runtime.exitCode == null) {
        runtime.exitCode = exitCodeHint ?? 0;
      }
      return replay;
    }
  } catch {
    // Fall through; caller will try other paths.
  }
  return null;
}

async function readInitialHydrationData(runtime: CachedRuntime): Promise<InitialHydrationData> {
  // Determine disposed-ness via sessions.get so we work for chat-CLI sessions
  // too (terminal.preview rejects isPersistedChatToolType records and would
  // otherwise force us into the snapshot/transcript fallback).
  let sessionStatus: TerminalSessionStatus | null = null;
  let sessionExitCode: number | null = null;
  try {
    const detail = await window.ade.sessions.get(runtime.sessionId);
    sessionStatus = detail?.status ?? null;
    sessionExitCode = detail?.exitCode ?? null;
  } catch {
    // Best-effort; non-fatal.
  }
  const sessionDisposed = sessionStatus !== null && sessionStatus !== "running";

  // Prefer replay for disposed sessions BEFORE attempting terminal.preview —
  // preview throws for chat-CLI tool types and the throw would swallow the
  // replay opportunity.
  if (sessionDisposed && !runtime.displayedLiveDataBeforeHydration) {
    const replay = await tryReadReplay(runtime, sessionExitCode);
    if (replay) return replay;
  }

  try {
    const preview = await window.ade.terminal.preview({
      terminalId: runtime.sessionId,
      maxBytes: HYDRATE_TAIL_BYTES,
    });
    const previewSessionStatus = preview?.session?.status ?? sessionStatus;
    const previewSessionExitCode = preview?.session?.exitCode ?? sessionExitCode;

    // Some surfaces hit this path without a prior sessions.get hit (e.g. when
    // the renderer can't reach sessions.get but terminal.preview succeeds).
    // Retry the replay opportunity from the preview-derived status.
    if (
      !sessionDisposed
      && previewSessionStatus
      && previewSessionStatus !== "running"
      && !runtime.displayedLiveDataBeforeHydration
    ) {
      const replay = await tryReadReplay(runtime, previewSessionExitCode);
      if (replay) return replay;
    }

    if (preview?.snapshot) {
      const visibleRows = serializeSnapshotVisibleRows(preview.snapshot);
      if (visibleRows) return { source: "snapshot", text: visibleRows };
      if (preview.snapshot.serialized) {
        return { source: "snapshot", text: preview.snapshot.serialized };
      }
    }
    if (preview?.transcript) return { source: "transcript", text: preview.transcript };
  } catch {
    // Fall back to the transcript tail below.
  }

  const transcript = await window.ade.sessions.readTranscriptTail({
    sessionId: runtime.sessionId,
    maxBytes: HYDRATE_TAIL_BYTES,
    raw: true,
  });
  return transcript
    ? { source: "transcript", text: transcript }
    : { source: "empty", text: "" };
}

function scheduleHydrationBackfill(runtime: CachedRuntime, options: HydrationBackfillOptions = {}) {
  if (!needsHydrationBackfill(runtime)) return;
  if (runtime.hydrationBackfillAttempts >= HYDRATION_BACKFILL_MAX_ATTEMPTS) return;
  if (runtime.hydrationBackfillTimer) {
    if (!options.replaceExistingTimer) return;
    clearTimeout(runtime.hydrationBackfillTimer);
    runtime.hydrationBackfillTimer = null;
  }

  const delayMs = options.delayMs
    ?? (runtime.visible && runtime.active ? HYDRATION_VISIBLE_BLANK_BACKFILL_RETRY_MS : HYDRATION_BACKFILL_RETRY_MS);
  const snapshotOnly = options.snapshotOnly ?? runtime.displayedLiveDataBeforeHydration;
  runtime.hydrationBackfillTimer = setTimeout(() => {
    runtime.hydrationBackfillTimer = null;
    if (!needsHydrationBackfill(runtime)) return;
    runtime.hydrationBackfillAttempts += 1;
    if (runtime.hydrationBackfillAttempts > HYDRATION_BACKFILL_MAX_ATTEMPTS) return;

    readPreviewHydrationData(runtime, { snapshotOnly })
      .then((data) => {
        if (!needsHydrationBackfill(runtime)) return;
        if (data.text.length > 0) {
          discardScheduledFrameWrites(runtime);
          flushHydrationData(runtime, data.text, { appendPending: data.source !== "snapshot" });
          scheduleFit(runtime, true);
          return;
        }
        scheduleHydrationBackfill(runtime, { snapshotOnly });
      })
      .catch(() => {
        if (runtime.disposed || runtime.exitCode != null) return;
        scheduleHydrationBackfill(runtime, { snapshotOnly });
      });
  }, delayMs);
}

function startHydration(runtime: CachedRuntime) {
  if (runtime.hydrationStarted || runtime.disposed) return;
  runtime.hydrationStarted = true;

  const finalizeHydration = (data: InitialHydrationData) => {
    if (runtime.disposed) return;
    if (data.source === "replay") {
      // Replay mode: enlarge scrollback so the full transcript stays
      // scrollable, then write the stripped bytes in one pass. There is no
      // live PTY by definition, so pending live chunks (if any) are dropped.
      runtime.replayMode = true;
      runtime.pendingHydrationChunks.length = 0;
      runtime.pendingHydrationBytes = 0;
      discardScheduledFrameWrites(runtime);
      try {
        runtime.term.options.scrollback = REPLAY_SCROLLBACK_LINES;
      } catch {
        // ignore options assignment failures after disposal
      }
      flushHydrationData(runtime, data.text, { appendPending: false, replay: true });
      runtime.hydrationCompleted = true;
      // Surface the exited badge for disposed sessions that never fire
      // pty.onExit (the PTY is already gone before this view mounted).
      // readInitialHydrationData already pre-populated runtime.exitCode from
      // the session record when entering replay mode; notify listeners so the
      // local "exited N" state catches up.
      notifyRuntime(runtime);
      scheduleFit(runtime, true);
      // Disposed sessions never receive live PTY data, so no backfill polling.
      return;
    }
    const preferLivePending = runtime.displayedLiveDataBeforeHydration && data.source !== "snapshot";
    if (preferLivePending) {
      runtime.pendingHydrationChunks.length = 0;
      runtime.pendingHydrationBytes = 0;
      flushPendingFrameWrites(runtime);
    } else {
      discardScheduledFrameWrites(runtime);
      flushHydrationData(runtime, data.text, { appendPending: data.source !== "snapshot" });
    }
    runtime.hydrationCompleted = true;
    scheduleFit(runtime, true);
    scheduleHydrationBackfill(runtime, { snapshotOnly: runtime.displayedLiveDataBeforeHydration });
  };

  const hydrateTranscript = () => {
    readInitialHydrationData(runtime)
      .then(finalizeHydration)
      .catch(() => finalizeHydration({ source: "empty", text: "" }));
  };

  const waitForFitThenHydrate = (attempt: number) => {
    if (runtime.disposed) return;
    if (runtime.hasFittedOnce || attempt >= 20) {
      hydrateTranscript();
      return;
    }
    runtime.hydrateRetryTimer = setTimeout(() => {
      runtime.hydrateRetryTimer = null;
      waitForFitThenHydrate(attempt + 1);
    }, 60);
  };

  runtime.hydrateTimer = setTimeout(() => {
    runtime.hydrateTimer = null;
    waitForFitThenHydrate(0);
  }, 120);
}

async function loadAddonCtor(moduleName: string, exportName: string): Promise<any | null> {
  try {
    const mod = await import(/* @vite-ignore */ moduleName);
    return (mod as any)?.[exportName] ?? null;
  } catch {
    return null;
  }
}

async function setRenderer(runtime: CachedRuntime, mode: TerminalRendererMode): Promise<boolean> {
  if (runtime.disposed) return false;

  if (mode === "dom") {
    try {
      runtime.rendererAddon?.dispose();
    } catch {
      // ignore
    }
    runtime.rendererAddon = null;
    runtime.renderer = "dom";
    notifyRuntime(runtime);
    return true;
  }

  const Ctor = await loadAddonCtor("@xterm/addon-webgl", "WebglAddon");
  if (!Ctor) return false;

  try {
    const addon = new Ctor();
    runtime.term.loadAddon(addon);
    try {
      runtime.rendererAddon?.dispose();
    } catch {
      // ignore
    }
    runtime.rendererAddon = addon as { dispose: () => void };
    runtime.renderer = mode;

    if (mode === "webgl") {
      const maybeOnContextLoss = (addon as { onContextLoss?: (cb: () => void) => void }).onContextLoss;
      if (typeof maybeOnContextLoss === "function") {
        maybeOnContextLoss(() => {
          clearTextureAtlas(runtime);
          incrementHealth(runtime, "rendererFallbacks");
          void setRenderer(runtime, "dom").finally(() => {
            scheduleFit(runtime, runtime.active);
          });
        });
      }
    }

    notifyRuntime(runtime);
    return true;
  } catch {
    return false;
  }
}

async function initRendererChain(runtime: CachedRuntime) {
  if (runtime.rendererInitStarted || runtime.disposed) return;
  runtime.rendererInitStarted = true;

  if (!terminalWebglRendererEnabled()) {
    await setRenderer(runtime, "dom");
    return;
  }

  const webgl = await setRenderer(runtime, "webgl");
  if (webgl) return;
  incrementHealth(runtime, "rendererFallbacks");
  await setRenderer(runtime, "dom");
}

function resetWebglRenderer(runtime: CachedRuntime, afterReset: () => void): boolean {
  if (runtime.disposed || runtime.renderer !== "webgl" || runtime.rendererResetInFlight) return false;
  const now = Date.now();
  if (
    runtime.lastRendererResetAt > 0
    && now - runtime.lastRendererResetAt < RENDERER_RESET_COOLDOWN_MS
  ) return false;

  runtime.rendererResetInFlight = true;
  runtime.lastRendererResetAt = now;

  void setRenderer(runtime, "dom")
    .then(async () => {
      if (runtime.disposed) return;
      // Visibility may have flipped to false while we were swapping to DOM.
      // Defer the webgl restore until the runtime becomes visible again
      // instead of dropping it permanently — `runtime.renderer === "dom"`
      // here so a subsequent caller would not retry without this flag.
      if (!runtime.visible) {
        runtime.pendingWebGLRestore = true;
        return;
      }
      const restored = await setRenderer(runtime, "webgl");
      if (!restored && !runtime.disposed) {
        incrementHealth(runtime, "rendererFallbacks");
      }
    })
    .catch(() => {
      if (!runtime.disposed) {
        incrementHealth(runtime, "rendererFallbacks");
      }
    })
    .finally(() => {
      runtime.rendererResetInFlight = false;
      if (runtime.disposed || !runtime.visible) return;
      clearTextureAtlas(runtime);
      afterReset();
    });

  return true;
}

function flushPendingWebGLRestore(runtime: CachedRuntime): void {
  if (!runtime.pendingWebGLRestore || runtime.disposed || !runtime.visible) return;
  if (runtime.renderer === "webgl") {
    runtime.pendingWebGLRestore = false;
    return;
  }
  runtime.pendingWebGLRestore = false;
  void setRenderer(runtime, "webgl").then((restored) => {
    if (!restored && !runtime.disposed) {
      incrementHealth(runtime, "rendererFallbacks");
    }
  });
}

function createRuntime(args: {
  ptyId: string;
  sessionId: string;
  projectRoot: string | null;
  projectRevision: number;
  theme: XtermTheme;
  preferences: TerminalRenderPreferences;
  imagePasteMode: TerminalImagePasteMode;
}): CachedRuntime {
  const host = document.createElement("div");
  host.className = "h-full w-full m-0 p-0 border-0 overflow-hidden";

  const term = new Terminal({
    allowProposedApi: true,
    convertEol: true,
    cursorBlink: true,
    cursorInactiveStyle: "none",
    documentOverride: document,
    scrollback: args.preferences.scrollback,
    fontFamily: args.preferences.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
    // Round to an integer so device cell metrics aren't fractional. Fractional
    // font sizes give the WebGL renderer fractional cell widths, which crowds
    // glyphs (inter-word spaces visually collapse) and breaks pixel alignment of
    // box-drawing strokes (│ ─ render "dashed"). This is what makes TUI clients
    // like `ade code` look low-res / jammed inside the terminal pane.
    fontSize: Math.round(args.preferences.fontSize),
    lineHeight: args.preferences.lineHeight,
    // Lift only near-invisible glyphs to a visible contrast floor so the dim
    // box-drawing borders survive WebGL anti-aliasing without washing out the
    // intended dim/comment palette.
    minimumContrastRatio: 1.1,
    theme: args.theme
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  const linkProviderSub = typeof term.registerLinkProvider === "function"
    ? term.registerLinkProvider(createTerminalLinkProvider(term))
    : null;

  const runtime: CachedRuntime = {
    key: terminalRuntimeKey(args),
    ptyId: args.ptyId,
    sessionId: args.sessionId,
    projectRoot: args.projectRoot,
    projectRevision: args.projectRevision,
    term,
    fit,
    host,
    opened: false,
    disposed: false,
    refs: 0,
    listeners: new Set(),
    exitCode: null,
    renderer: "dom",
    rendererAddon: null,
    rendererResetInFlight: false,
    lastRendererResetAt: 0,
    health: { fitFailures: 0, zeroDimFits: 0, rendererFallbacks: 0, droppedChunks: 0, fitRecoveries: 0 },
    lastDims: null,
    lastPtyResizeDims: null,
    ptyResizeInFlight: false,
    inFlightPtyResizeDims: null,
    queuedPtyResizeDims: null,
    pendingForceResize: false,
    fitRafId: null,
    settleTimer1: null,
    settleTimer2: null,
    hydrateTimer: null,
    hydrateRetryTimer: null,
    hydrationBackfillTimer: null,
    hydrationBackfillAttempts: 0,
    hasFittedOnce: false,
    hydrationStarted: false,
    hydrationCompleted: false,
    hasAppliedTerminalContent: false,
    displayedLiveDataBeforeHydration: false,
    pendingHydrationChunks: [],
    pendingHydrationBytes: 0,
    frameWriteChunks: [],
    frameWriteBytes: 0,
    inputWriteChunks: [],
    inputWriteBytes: 0,
    inputFlushTimer: null,
    liveStreamPaused: false,
    flushRafId: null,
    flushTimer: null,
    disposeTimer: null,
    lastFitSafetyAt: 0,
    ptyDataUnsub: null,
    ptyExitUnsub: null,
    termDataSub: null,
    linkProviderSub,
    rendererInitStarted: false,
    inputEnabled: true,
    active: true,
    visible: true,
    imagePasteMode: args.imagePasteMode,
    bracketedPasteMode: false,
    mouseTrackingModes: new Set(),
    pendingWebGLRestore: false,
    invalidFitRetryTimer: null,
    fitWarningLogged: false,
    replayMode: false
  };

  // Capture-phase paste listener on host: intercepts ALL paste sources (Cmd+V,
  // Electron default-menu Edit→Paste, right-click, middle-click) before xterm
  // can split the text into individual onData events.
  let lastPasteEventAt = 0;
  host.addEventListener("paste", (ev: ClipboardEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    lastPasteEventAt = Date.now();
    const text = ev.clipboardData?.getData("text/plain") ?? ev.clipboardData?.getData("text");
    if (text && !runtime.disposed) {
      writePtyInput(runtime, formatTextPasteForTerminal(runtime, text));
      return;
    }
    void pasteClipboardImageShortcut(runtime, runtime.imagePasteMode);
  }, true);

  term.attachCustomKeyEventHandler((ev) => {
    if (!runtime.inputEnabled) return false;
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    const key = ev.key.toLowerCase();

    if (ev.type !== "keydown") return true;

    if (mod && key === "v") {
      // Primary paste is handled by the capture-phase paste listener above.
      // Don't preventDefault — let the browser fire the paste event so the
      // listener can read clipboardData synchronously.
      // Fallback: if no paste event fires within 120ms (e.g. browser security
      // restrictions), read the clipboard asynchronously.
      const before = lastPasteEventAt;
      setTimeout(() => {
        if (lastPasteEventAt !== before || runtime.disposed) return;
        const readText = navigator.clipboard?.readText;
        if (typeof readText !== "function") {
          void pasteClipboardImageShortcut(runtime, runtime.imagePasteMode);
          return;
        }
        readText.call(navigator.clipboard).then((text) => {
          if (text && !runtime.disposed) {
            writePtyInput(runtime, formatTextPasteForTerminal(runtime, text));
            return;
          }
          void pasteClipboardImageShortcut(runtime, runtime.imagePasteMode);
        }).catch(() => {
          void pasteClipboardImageShortcut(runtime, runtime.imagePasteMode);
        });
      }, 120);
      return false;
    }

    if (mod && key === "c") {
      const selection = term.getSelection();
      if (selection) {
        ev.preventDefault();
        void writeTerminalSelectionToClipboard(selection);
        return false;
      }
      if (isMac && ev.metaKey) {
        ev.preventDefault();
        writePtyInput(runtime, "\x03");
        return false;
      }
      return true;
    }

    // Shift+Enter should insert a newline in tools like Claude/Codex prompts.
    if (ev.shiftKey && ev.key === "Enter") {
      ev.preventDefault();
      writePtyInput(runtime, runtime.bracketedPasteMode
        ? `${TERMINAL_BRACKETED_PASTE_START}\n${TERMINAL_BRACKETED_PASTE_END}`
        : "\n");
      return false;
    }

    if (isMac && ev.altKey && ev.key === "Backspace") {
      ev.preventDefault();
      writePtyInput(runtime, "\x1b\x7f");
      return false;
    }

    if (isMac && ev.metaKey && ev.key === "Backspace") {
      ev.preventDefault();
      // Ctrl+U: kill to beginning of line
      writePtyInput(runtime, "\x15");
      return false;
    }

    // Ctrl+Backspace: delete word backward (same as Ctrl+W)
    if (ev.ctrlKey && ev.key === "Backspace") {
      ev.preventDefault();
      writePtyInput(runtime, "\x17");
      return false;
    }

    return true;
  });

  // Debounce rapid terminal input into fewer PTY writes. Remote runtimes pay a
  // full RPC round trip per write, so per-character bursts make typing feel
  // much slower than a local shell.
  runtime.termDataSub = term.onData((data) => {
    enqueuePtyInput(runtime, data);
  });

  runtime.ptyDataUnsub = subscribeRuntimePtyData(runtime);
  runtime.ptyExitUnsub = subscribeRuntimePtyExit(runtime);

  void initRendererChain(runtime);

  return runtime;
}

function ensureRuntime(args: {
  ptyId: string;
  sessionId: string;
  projectRoot: string | null;
  projectRevision: number;
  theme: XtermTheme;
  preferences: TerminalRenderPreferences;
  imagePasteMode: TerminalImagePasteMode;
}): CachedRuntime {
  const key = terminalRuntimeKey(args);
  const existing = runtimeCache.get(key);
  if (existing && !existing.disposed) {
    if (
      existing.ptyId === args.ptyId
      && existing.projectRoot === args.projectRoot
    ) {
      clearDisposeTimer(existing);
      existing.projectRevision = args.projectRevision;
      existing.imagePasteMode = args.imagePasteMode;
      applyRuntimeVisualOptions(existing, {
        theme: args.theme,
        preferences: args.preferences,
      });
      return existing;
    }
    teardownRuntime(existing);
  }

  const runtime = createRuntime(args);
  runtimeCache.set(key, runtime);
  return runtime;
}

export function getTerminalRuntimeSnapshot(sessionId: string): RuntimeSnapshot | null {
  const runtime = Array.from(runtimeCache.values()).find((entry) => entry.sessionId === sessionId);
  if (!runtime || runtime.disposed) return null;
  return {
    exitCode: runtime.exitCode,
    renderer: runtime.renderer,
    health: cloneHealth(runtime.health)
  };
}

export function getTerminalRuntimeHealth(sessionId: string): TerminalHealthCounters | null {
  return getTerminalRuntimeSnapshot(sessionId)?.health ?? null;
}

export function __resetTerminalRuntimesForTests(): void {
  for (const runtime of Array.from(runtimeCache.values())) {
    teardownRuntime(runtime);
  }
  runtimeCache.clear();
  ptyDataSubscriptionSignature = null;
}

export function TerminalView({
  ptyId,
  sessionId,
  className,
  isActive,
  isVisible = isActive,
  imagePasteMode = "native-shortcut",
}: {
  ptyId: string;
  sessionId: string;
  className?: string;
  isActive: boolean;
  isVisible?: boolean;
  imagePasteMode?: TerminalImagePasteMode;
}) {
  const appTheme = useAppStore((s) => s.theme);
  const terminalPreferences = useAppStore((s) => s.terminalPreferences);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const projectRevision = useAppStore((s) => s.projectRevision);
  const runtimeProjectScopeRef = useRef<{
    sessionId: string;
    projectRoot: string | null;
    projectRevision: number;
  } | null>(null);
  if (
    !runtimeProjectScopeRef.current
    || runtimeProjectScopeRef.current.sessionId !== sessionId
    || (runtimeProjectScopeRef.current.projectRoot == null && projectRoot != null)
  ) {
    runtimeProjectScopeRef.current = {
      sessionId,
      projectRoot,
      projectRevision,
    };
  }
  const runtimeProjectRoot = runtimeProjectScopeRef.current.projectRoot;
  const runtimeProjectRevision = runtimeProjectScopeRef.current.projectRevision;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<CachedRuntime | null>(null);
  const [exited, setExited] = useState<number | null>(null);

  const termTheme = useMemo(() => terminalThemes[isDarkTheme(appTheme) ? "dark" : "light"], [appTheme]);
  const resolvedPreferences = useMemo<TerminalRenderPreferences>(() => ({
    fontFamily: terminalPreferences?.fontFamily ?? DEFAULT_TERMINAL_PREFERENCES.fontFamily,
    fontSize: terminalPreferences?.fontSize ?? DEFAULT_TERMINAL_PREFERENCES.fontSize,
    lineHeight: terminalPreferences?.lineHeight ?? DEFAULT_TERMINAL_PREFERENCES.lineHeight,
    scrollback: terminalPreferences?.scrollback ?? DEFAULT_TERMINAL_PREFERENCES.scrollback,
  }), [terminalPreferences]);
  const currentMountConfig = { isActive, isVisible, theme: termTheme, preferences: resolvedPreferences };
  const mountConfigRef = useRef(currentMountConfig);
  mountConfigRef.current = currentMountConfig;

  useEffect(() => {
    disposeTerminalRuntimesForProjectChange(projectRoot, projectRevision);
  }, [projectRoot, projectRevision]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const mountConfig = mountConfigRef.current;
    const runtime = ensureRuntime({
      ptyId,
      sessionId,
      projectRoot: runtimeProjectRoot,
      projectRevision: runtimeProjectRevision,
      theme: mountConfig.theme,
      preferences: mountConfig.preferences,
      imagePasteMode,
    });
    runtimeRef.current = runtime;
    const wasReceivingBeforeRef = shouldRuntimeReceivePtyData(runtime);
    runtime.refs += 1;
    syncRuntimePtyDataStreaming(runtime, wasReceivingBeforeRef);
    clearDisposeTimer(runtime);
    setRuntimeInteractionState(runtime, mountConfig.isActive);
    setRuntimeVisibilityState(runtime, mountConfig.isVisible);

    const onRuntimeSnapshot: RuntimeListener = (snapshot) => {
      setExited(snapshot.exitCode);
    };
    runtime.listeners.add(onRuntimeSnapshot);
    setExited(runtime.exitCode);

    if (runtime.host.parentElement !== el) {
      el.replaceChildren(runtime.host);
    }
    // Drain any buffered output synchronously on remount so the user sees the
    // latest terminal state immediately when they switch back, even if a
    // previously-scheduled flush RAF got throttled while the host was parked.
    flushPendingFrameWrites(runtime);
    if (runtime.term.rows > 0) {
      try {
        runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
      } catch {
        // ignore refresh failures after disposal
      }
    }

    const schedule = (forceResize = false) => scheduleFit(runtime, forceResize);

    schedule(mountConfig.isVisible);
    runtime.settleTimer1 = setTimeout(() => {
      runtime.settleTimer1 = null;
      schedule(mountConfig.isVisible);
    }, 120);
    runtime.settleTimer2 = setTimeout(() => {
      runtime.settleTimer2 = null;
      schedule(mountConfig.isVisible);
    }, 320);

    startHydration(runtime);

    const obs = new ResizeObserver(() => {
      clearTextureAtlas(runtime);
      schedule();
    });
    obs.observe(el);

    const onWheel = (ev: WheelEvent) => {
      if (runtime.disposed) return;
      if (!(ev.target instanceof Node)) return;
      if (!runtime.term.element || !runtime.term.element.contains(ev.target)) return;
      const viewport = runtime.term.element.querySelector<HTMLElement>(".xterm-viewport");
      if (!viewport) return;
      const viewportScrollable = viewport.scrollHeight > viewport.clientHeight + 1;
      const hasScrollback = runtime.term.buffer.active.baseY > 0;
      const mouseTrackingActive = isTerminalMouseTrackingActive(runtime);
      if (!hasScrollback || (viewportScrollable && !mouseTrackingActive)) return;
      const direction = ev.deltaY > 0 ? 1 : -1;
      const magnitude = Math.max(1, Math.min(12, Math.round(Math.abs(ev.deltaY) / 32)));
      try {
        runtime.term.scrollLines(direction * magnitude);
        ev.preventDefault();
        ev.stopPropagation();
      } catch {
        // ignore
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });

    const intObs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          requestAnimationFrame(() => schedule(true));
        }
      }
    });
    intObs.observe(el);

    const onVisibilityChange = () => {
      if (document.hidden) return;
      clearTextureAtlas(runtime);
      requestAnimationFrame(() => schedule(true));
    };
    const onWindowFocus = () => {
      requestAnimationFrame(() => schedule(true));
    };
    const onWindowResize = () => {
      requestAnimationFrame(() => schedule(true));
    };
    const onWorkSurfaceRevealed = () => {
      if (!mountConfigRef.current.isVisible) return;
      const redraw = () => {
        requestAnimationFrame(() => {
          schedule(true);
          try {
            runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
            if (mountConfigRef.current.isActive) {
              runtime.term.focus();
              runtime.term.scrollToBottom();
            }
          } catch {
            // ignore redraw failures after disposal
          }
        });
      };
      clearTextureAtlas(runtime);
      flushPendingFrameWrites(runtime);
      resetWebglRenderer(runtime, redraw);
      redraw();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener(WORK_SURFACE_REVEALED_EVENT, onWorkSurfaceRevealed);
    window.visualViewport?.addEventListener("resize", onWindowResize);

    const setupDprListener = () => {
      let cleanup: (() => void) | null = null;
      const query = `(resolution: ${window.devicePixelRatio}dppx)`;
      const media = window.matchMedia(query);
      const onDprChange = () => {
        if (cleanup) cleanup();
        clearTextureAtlas(runtime);
        requestAnimationFrame(() => schedule(true));
      };

      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", onDprChange);
        cleanup = () => media.removeEventListener("change", onDprChange);
      } else {
        const legacy = media as MediaQueryList & {
          addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
          removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
        };
        legacy.addListener?.(onDprChange);
        cleanup = () => legacy.removeListener?.(onDprChange);
      }
      return cleanup;
    };
    const teardownDpr = setupDprListener();

    const fontsReady = document.fonts?.ready;
    if (fontsReady) {
      fontsReady
        .then(() => {
          requestAnimationFrame(() => schedule(true));
        })
        .catch(() => {});
    }

    return () => {
      runtime.listeners.delete(onRuntimeSnapshot);

      try {
        obs.disconnect();
      } catch {
        // ignore
      }
      try {
        intObs.disconnect();
      } catch {
        // ignore
      }
      try {
        teardownDpr?.();
      } catch {
        // ignore
      }

      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener(WORK_SURFACE_REVEALED_EVENT, onWorkSurfaceRevealed);
      window.visualViewport?.removeEventListener("resize", onWindowResize);
      el.removeEventListener("wheel", onWheel, { capture: true });

      if (runtime.host.parentElement === el) {
        flushPendingFrameWrites(runtime);
        try {
          runtime.term.blur();
        } catch {
          // ignore
        }
        try {
          runtime.host.blur();
        } catch {
          // ignore
        }
        parkRuntime(runtime);
      }

      const wasReceivingBeforeUnref = shouldRuntimeReceivePtyData(runtime);
      setRuntimeVisibilityState(runtime, false);
      runtime.refs = Math.max(0, runtime.refs - 1);
      syncRuntimePtyDataStreaming(runtime, wasReceivingBeforeUnref);
      // Keep live runtimes parked until the PTY exits so switching away from a
      // running terminal does not discard in-memory TUI state.
      if (runtime.refs === 0 && runtime.exitCode != null) {
        scheduleRuntimeDispose(runtime, EXITED_RUNTIME_KEEPALIVE_MS);
      }
    };
  }, [imagePasteMode, runtimeProjectRevision, runtimeProjectRoot, ptyId, sessionId]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.disposed) return;

    const wrapper = wrapperRef.current;
    setRuntimeInteractionState(runtime, isActive);
    setRuntimeVisibilityState(runtime, isVisible);

    if (wrapper) {
      wrapper.tabIndex = -1;
      if (isVisible) {
        wrapper.removeAttribute("aria-hidden");
        wrapper.removeAttribute("inert");
      } else {
        wrapper.setAttribute("aria-hidden", "true");
        wrapper.setAttribute("inert", "");
      }
    }

    if (isVisible) {
      const redraw = () => {
        requestAnimationFrame(() => {
          scheduleFit(runtime, false);
          try {
            runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
          } catch {
            // ignore redraw failures after disposal
          }
        });
      };
      clearTextureAtlas(runtime);
      flushPendingFrameWrites(runtime);
      if (runtime.active && runtime.displayedLiveDataBeforeHydration && !terminalDomHasRenderableText(runtime)) {
        scheduleHydrationBackfill(runtime, {
          delayMs: HYDRATION_VISIBLE_BLANK_BACKFILL_RETRY_MS,
          replaceExistingTimer: true,
          snapshotOnly: true,
        });
      }
      // Replay a webgl restore that was deferred when the runtime turned
      // invisible mid-fallback. Without this, runtime.renderer stays "dom"
      // and resetWebglRenderer's webgl-only guard would silently skip retry.
      flushPendingWebGLRestore(runtime);
      resetWebglRenderer(runtime, redraw);
      redraw();
    }

    if (!isActive) {
      try {
        runtime.term.blur();
      } catch {
        // ignore
      }
      try {
        runtime.host.blur();
      } catch {
        // ignore
      }
    }
  }, [isActive, isVisible, runtimeProjectRoot, sessionId]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.disposed) return;
    const id = requestAnimationFrame(() => {
      applyRuntimeVisualOptions(runtime, {
        theme: termTheme,
        preferences: resolvedPreferences,
      });
      clearTextureAtlas(runtime);
      scheduleFit(runtime, true);
    });
    return () => cancelAnimationFrame(id);
  }, [runtimeProjectRoot, resolvedPreferences, sessionId, termTheme]);

  // When this terminal becomes the active tab, force fit + focus + scroll
  useEffect(() => {
    if (!isActive) return;
    const runtime = runtimeRef.current;
    if (!runtime || runtime.disposed) return;

    const raf = requestAnimationFrame(() => {
      clearTextureAtlas(runtime);
      doFit(runtime, true);
      if (isVisible) {
        try {
          runtime.term.focus();
          runtime.term.scrollToBottom();
        } catch {
          // ignore
        }
      }
    });

    // Second settle pass after CSS transitions complete
    const timer = setTimeout(() => {
      if (runtime.disposed) return;
      clearTextureAtlas(runtime);
      doFit(runtime, true);
      if (isVisible) {
        try {
          runtime.term.focus();
        } catch {
          // ignore
        }
      }
    }, 100);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [isActive, isVisible, runtimeProjectRoot, sessionId]);

  return (
    <div
      ref={wrapperRef}
      data-ade-terminal-visible={isVisible ? "true" : "false"}
      data-ade-terminal-active={isActive ? "true" : "false"}
      data-ade-terminal-session-id={sessionId}
      className={cn(
        "relative h-full min-h-0 min-w-0 w-full overflow-hidden rounded-xl bg-surface-recessed",
        exited == null && "ade-terminal-active-glow shadow-[0_0_12px_-4px_rgba(34,197,94,0.2)]",
        exited != null && "shadow-card",
        className
      )}
    >
      <div ref={containerRef} className="ade-terminal-host h-full w-full m-0 p-0 border-0 overflow-hidden" />
      {exited != null ? (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded-lg border border-border/15 bg-card backdrop-blur-sm shadow-card px-2 py-1 text-[11px] text-muted-fg">
          exited {exited}
        </div>
      ) : null}
    </div>
  );
}
