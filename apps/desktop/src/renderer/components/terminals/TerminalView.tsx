import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cn } from "../ui/cn";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_PREFERENCES,
  selectActiveProjectRoot,
  selectActiveProjectStateKey,
  useAppStore,
  type TerminalPreferences,
  type ThemeId,
} from "../../state/appStore";
import { WORK_SURFACE_REVEALED_EVENT } from "./workSurfaceVisibility";
import { installMacShiftSelectionBridge } from "./terminalMacShiftSelection";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { isWebClientMode } from "../../lib/webClientMode";
import { peekPendingSessionAnchor, takePendingSessionAnchor } from "./pendingSessionAnchors";
import {
  MIN_VALID_COLS,
  inferTerminalModesFromTranscript,
  inferTranscriptColumns,
  normalizeTranscriptToGrid,
} from "./terminalTranscriptNormalize";
import { installPtySizeOwnershipTracking, windowOwnsPtySize } from "./ptySizeOwnership";
import type {
  OpenProjectBinding,
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

type DeferredInputDuringPasteWrite =
  | { kind: "input"; data: string }
  | { kind: "paste"; text: string };

type CachedRuntime = {
  key: string;
  ptyId: string;
  sessionId: string;
  // Runtime routing belongs to this cached session, not to the window. Keeping
  // the pin on the runtime prevents simultaneously parked terminals from
  // different machines from borrowing whichever project the window opened last.
  runtimePin: OpenProjectBinding | null;
  projectKey: string | null;
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
  /** Full-snapshot bytes held until the first successful fit; see `replaceRuntimeTerminalData`. */
  pendingReplaceData: string | null;
  replaceFitRetryTimer: ReturnType<typeof setTimeout> | null;
  replaceFitRetryAttempts: number;
  hydrationBackfillTimer: ReturnType<typeof setTimeout> | null;
  hydrationBackfillAttempts: number;
  /** Compounded CSS zoom last compensated for; see `applyZoomCompensation`. */
  lastZoomFactor: number;
  /** Base (UNZOOMED) font size last requested by preferences. */
  baseFontSize: number;
  /** Whether the last hydration payload went through grid normalization. */
  lastHydrationNormalized: boolean;
  /**
   * Hydration wrote while the terminal was still at its 80x24 constructor size
   * (the fit budget expired on a pane that could not be measured). The bytes on
   * screen are wrapped to the wrong width and overflow into scrollback; the
   * first real fit re-runs hydration to replace them. See `rehydrateAfterFit`.
   */
  hydratedWhileUnfitted: boolean;
  /**
   * Column count the current hydration content was RENDERED at. xterm does not
   * reflow a buffer it already committed, so once the pane settles at a
   * different width that content is wrong until it is written again.
   */
  hydratedAtCols: number | null;
  rehydrateDimsTimer: ReturnType<typeof setTimeout> | null;
  hasFittedOnce: boolean;
  hydrationStarted: boolean;
  hydrationCompleted: boolean;
  hydrationGeneration: number;
  hasAppliedTerminalContent: boolean;
  displayedLiveDataBeforeHydration: boolean;
  pendingHydrationChunks: string[];
  pendingHydrationBytes: number;
  frameWriteChunks: string[];
  frameWriteBytes: number;
  inputWriteChunks: string[];
  inputWriteBytes: number;
  inputFlushTimer: ReturnType<typeof setTimeout> | null;
  pasteWriteInFlight: boolean;
  deferredInputDuringPasteWrite: DeferredInputDuringPasteWrite[];
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
  macShiftSelectionCleanup: (() => void) | null;
  // Set when a webgl→dom fallback is in flight and the runtime turned
  // invisible before the webgl restore could run. Persists across renderer
  // changes so the restore can be retried on the next visibility-true.
  pendingWebGLRestore: boolean;
  invalidFitRetryTimer: ReturnType<typeof setTimeout> | null;
  fitWarningLogged: boolean;
  replayMode: boolean;
  replayLoadedBytes: number | null;
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
/**
 * Whether webfonts have finished loading, so a cell measurement can be trusted.
 *
 * The hosted client fetches its terminal fonts over HTTP with `font-display:
 * swap` (webclient/main.tsx), and "JetBrains Mono" is a selectable terminal font
 * (settings/terminalOptions.ts). During the swap window the browser paints a
 * FALLBACK face, so a cell measured then has the fallback's advance width —
 * which fits to the wrong column count for the whole session. Desktop loads the
 * same faces off disk fast enough that the window effectively does not exist,
 * which is why this is web-only and why a warm cache makes it come and go.
 *
 * Resolved (not pending) in any environment without `document.fonts`, notably
 * jsdom: there is nothing to wait for and nothing to re-measure.
 */
let documentFontsSettled = typeof document === "undefined" || !document.fonts?.ready;
if (typeof document !== "undefined" && document.fonts?.ready) {
  const settle = () => {
    documentFontsSettled = true;
  };
  document.fonts.ready.then(settle).catch(settle);
}

// Long enough to sit out a window drag or a tiling animation, short enough that
// a revealed pane corrects itself before the user reads it as broken.
const REHYDRATE_DIMS_DEBOUNCE_MS = 250;
// The shared wait-for-a-trustworthy-grid budget (20 × 60ms), used by both
// `waitForFitThenHydrate` and `applyPendingReplaceWhenFitted`: long enough for a
// remount to measure its host, short enough that an unmeasurable pane still gets
// its recovery snapshot rather than staying blank.
const REPLACE_FIT_RETRY_MS = 60;
const REPLACE_FIT_MAX_ATTEMPTS = 20;
const MAX_PENDING_HYDRATION_BYTES = 2_000_000;
const MAX_FRAME_WRITE_BYTES = 1_000_000;
const MAX_PTY_INPUT_BATCH_BYTES = 16_384;
const PTY_INPUT_BATCH_MS = 16;
const PASTE_MODE_REFRESH_TIMEOUT_MS = 500;
const EXITED_RUNTIME_KEEPALIVE_MS = 8_000;
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
const pinnedPtyDataUnsubs = new Map<string, () => void>();
const pinnedPtyExitUnsubs = new Map<string, () => void>();
let pinnedPtyRuntimeCount = 0;
let ptyDataSubscriptionSignature: string | null = null;
const pinnedPtyDataSubscriptionSignatures = new Map<string, string>();

function terminalRuntimeKey(args: {
  sessionId: string;
  ptyId?: string | null;
  projectKey?: string | null;
  runtimePin?: OpenProjectBinding | null;
}): string {
  const projectRuntimeKey = `${args.projectKey ?? "<no-project>"}::${args.sessionId}::${args.ptyId ?? "<no-pty>"}`;
  // Preserve the exact local/unpinned cache key while making an explicitly
  // pinned session distinct from an otherwise identical active-project view.
  return args.runtimePin
    ? `pin:${args.runtimePin.kind}:${args.runtimePin.key}::${projectRuntimeKey}`
    : projectRuntimeKey;
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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function takePendingTerminalOffsetAnchor(sessionId: string): number | null {
  const anchor = peekPendingSessionAnchor(sessionId);
  if (anchor?.offset == null) return null;
  const consumed = takePendingSessionAnchor(sessionId);
  return consumed?.offset ?? null;
}

function canMapReplayOffset(tailLoadedBytes: number | null): tailLoadedBytes is number {
  // readTranscriptTail returns only text, not total file size. If the replay hit
  // the cap, the tail's start byte is unknown, so leave replay at its default.
  return typeof tailLoadedBytes === "number"
    && tailLoadedBytes > 0
    && tailLoadedBytes < REPLAY_TRANSCRIPT_MAX_BYTES;
}

function replayOffsetTargetLine(args: {
  offset: number;
  tailLoadedBytes: number;
  bufferLength: number;
  rows: number;
}): number {
  const tailStartByte = 0;
  const fraction = clamp01((args.offset - tailStartByte) / args.tailLoadedBytes);
  return Math.round(fraction * Math.max(0, args.bufferLength - args.rows));
}

function scheduleReplayOffsetScroll(runtime: CachedRuntime, offset: number): void {
  const tailLoadedBytes = runtime.replayLoadedBytes;
  if (!canMapReplayOffset(tailLoadedBytes)) return;
  requestAnimationFrame(() => {
    if (runtime.disposed) return;
    try {
      const targetLine = replayOffsetTargetLine({
        offset,
        tailLoadedBytes,
        bufferLength: runtime.term.buffer.active.length,
        rows: runtime.term.rows,
      });
      runtime.term.scrollToLine(targetLine);
      runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
    } catch {
      // Best-effort positioning only; replay remains usable if xterm rejects it.
    }
  });
}

function consumePendingTerminalOffsetAnchor(runtime: CachedRuntime): void {
  const offset = takePendingTerminalOffsetAnchor(runtime.sessionId);
  if (offset == null || !runtime.replayMode) return;
  scheduleReplayOffsetScroll(runtime, offset);
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

function serializeSnapshotForHydration(snapshot: TerminalSerializedSnapshot): string | null {
  // Alternate-screen TUIs own a viewport, not a scrollback transcript. Repaint
  // their structured visible rows first so replaying an older serialized main
  // buffer cannot corrupt Codex/Claude's full-screen state.
  if (snapshot.bufferType === "alternate") {
    return serializeSnapshotVisibleRows(snapshot) || snapshot.serialized || null;
  }

  // Normal/main-buffer snapshots include the persisted scrollback (bounded by
  // the main process). Prefer it over the viewport-only repaint so attaching to
  // a running shell starts with scrollable history; retain the structured rows
  // as the fallback for legacy/empty serialized snapshots.
  return snapshot.serialized || serializeSnapshotVisibleRows(snapshot);
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

/**
 * One-line dimension report, for diagnosing "the text is jumbled" reports.
 *
 * A terminal only renders correctly while three widths agree: the grid xterm
 * holds, the size the PTY was last told, and the size whatever bytes we are
 * writing were produced at. When they disagree the symptom is always the same
 * garbled output, and the three are otherwise invisible from a screenshot — so
 * print them together, and make a disagreement loud.
 */
function describeTerminalDims(
  runtime: CachedRuntime,
  extra: {
    reason: string;
    sentResize?: TerminalDims | null;
    snapshot?: TerminalDims | null;
    note?: string;
  },
): string {
  const measurement = measureHost(runtime.host);
  const fmt = (dims: TerminalDims | null | undefined) =>
    dims ? `${dims.cols}x${dims.rows}` : "-";
  return [
    "[ade-term]",
    `reason=${extra.reason}`,
    `session=${runtime.sessionId}`,
    `xterm=${runtime.term.cols}x${runtime.term.rows}`,
    `snapshot=${fmt(extra.snapshot)}`,
    `sentResize=${fmt(extra.sentResize)}`,
    `lastSent=${fmt(runtime.lastPtyResizeDims)}`,
    // baseY is the scrollback depth, and it decides which surface the wheel
    // acts on: at 0 the wheel is forwarded to the TUI, above 0 the local
    // scrollback branch takes it. One number, and the scroll behaviour is no
    // longer guesswork from a screenshot.
    `baseY=${(() => { try { return runtime.term.buffer.active.baseY; } catch { return "?"; } })()}`,
    `fitted=${runtime.hasFittedOnce}`,
    `fonts=${documentFontsSettled}`,
    `owns=${windowOwnsPtySize()}`,
    `host=${Math.round(measurement.width)}x${Math.round(measurement.height)}px`,
    ...(extra.note ? [extra.note] : []),
  ].join(" ");
}

/**
 * Single sink for the `[ade-term]` diagnostics.
 *
 * Severity is the whole point of the split: a mismatch, a declined
 * normalization or a failed resize is a bug worth a warning, while the
 * once-per-hydration "this is what happened" line is routine and must not make
 * a healthy session look broken in the console. `console.debug` keeps the
 * routine lines available (verbose level) without the yellow triangle.
 */
function logTerminalDiag(level: "debug" | "warn", line: string): void {
  if (level === "warn") console.warn(line);
  else console.debug(line);
}

/**
 * Always-on mismatch reporting. A disagreement is a bug every time, is cheap to
 * detect, and is the single fact that turns a "looks jumbled" screenshot into a
 * diagnosis — so it warns unconditionally rather than hiding behind a flag.
 */
function reportTerminalDimsMismatch(
  runtime: CachedRuntime,
  extra: { reason: string; sentResize?: TerminalDims | null; snapshot?: TerminalDims | null },
): void {
  // COLUMNS only. Rows disagreeing is normal and harmless — a snapshot carries
  // as many rows as it had content for, and a viewport taller than the capture
  // just leaves blank space. Columns are what decide where every line wraps, so
  // a column disagreement is the one that garbles text.
  const cols = runtime.term.cols;
  const mismatched =
    (extra.snapshot != null && extra.snapshot.cols !== cols)
    || (extra.sentResize != null && extra.sentResize.cols !== cols);
  if (!mismatched) return;
  logTerminalDiag("warn", describeTerminalDims(runtime, extra));
}

function sendPtyResize(runtime: CachedRuntime, dims: TerminalDims): void {
  if (runtime.disposed) return;
  runtime.ptyResizeInFlight = true;
  runtime.inFlightPtyResizeDims = dims;
  reportTerminalDimsMismatch(runtime, { reason: "pty-resize-send", sentResize: dims });
  const resize = runtime.runtimePin
    ? window.ade.pty.resize(
        { ptyId: runtime.ptyId, cols: dims.cols, rows: dims.rows },
        runtime.runtimePin,
      )
    : window.ade.pty.resize({ ptyId: runtime.ptyId, cols: dims.cols, rows: dims.rows });
  resize
    .then(
      () => {
        runtime.lastPtyResizeDims = dims;
        // The round trip is not instant, and the PTY repaints at the size it
        // was given. If the grid moved while this was in flight, the repaint
        // now landing was produced for a width xterm no longer has — the
        // resize/repaint race, and the one ordering bug a screenshot cannot
        // show.
        reportTerminalDimsMismatch(runtime, { reason: "pty-resize-acked", sentResize: dims });
      },
      () => {
        if (sameDims(runtime.lastPtyResizeDims, dims)) {
          runtime.lastPtyResizeDims = null;
        }
        logTerminalDiag("warn", describeTerminalDims(runtime, { reason: "pty-resize-failed", sentResize: dims }));
      },
    )
    .finally(() => {
      runtime.ptyResizeInFlight = false;
      runtime.inFlightPtyResizeDims = null;
      flushQueuedPtyResize(runtime);
    });
}

/**
 * Sends a resize, coalescing against whatever is already in flight.
 *
 * `force` means "send even though the dims look unchanged" — nothing more. Size
 * OWNERSHIP is a policy decision and lives with the caller (`doFit`), because
 * force must NOT be able to override it: a background mirror that forces its
 * width onto a focused window is the resize war this arbitration exists to
 * prevent.
 */
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

/**
 * Whether xterm's current column count can be trusted to write width-sensitive
 * bytes at.
 *
 * A fit is only as trustworthy as the cell it measured, so a settled fit against
 * a fallback font face is still the wrong width for a snapshot or a transcript
 * grid. Both conditions, one predicate — and the `fonts.ready` handler re-drives
 * the waiters the moment the second one flips.
 */
function terminalWidthTrustworthy(runtime: CachedRuntime): boolean {
  return runtime.hasFittedOnce && documentFontsSettled;
}

function clearTextureAtlas(runtime: CachedRuntime) {
  try {
    runtime.term.clearTextureAtlas();
  } catch {
    // ignore when the active renderer doesn't support the texture atlas API
  }
}

/**
 * Forces xterm to re-measure its cell size against the fonts loaded NOW.
 *
 * xterm measures the cell once during `open()` and afterwards only when
 * `fontFamily` or `fontSize` CHANGES — its options setter fires nothing when the
 * assigned value equals the current one, and `resize()` re-measures only if the
 * existing measurement is invalid. So a terminal opened before its webfont
 * arrived keeps the fallback's cell width forever, and refitting cannot help:
 * FitAddon divides the element by that stale width, so it just recomputes the
 * same wrong column count.
 *
 * There is no public "re-measure" API, so drive the one trigger there is. The
 * sentinel is the same font stack with a trailing space: a different STRING (so
 * the setter fires) that CSS resolves identically (so nothing repaints
 * differently), and assigning the real value back fires a second measure that
 * lands on the loaded face.
 */
function remeasureTerminalFont(runtime: CachedRuntime): void {
  try {
    const family = runtime.term.options.fontFamily;
    if (!family) return;
    runtime.term.options.fontFamily = `${family} `;
    runtime.term.options.fontFamily = family;
  } catch {
    // ignore option writes after disposal
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
    // Scaled by the zoom the host element cancels, so the terminal still renders
    // at the size the zoom level asked for. See `applyZoomCompensation`.
    runtime.baseFontSize = args.preferences.fontSize;
    runtime.term.options.fontSize = Math.round(args.preferences.fontSize * runtime.lastZoomFactor);
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
  // A parked runtime is unmounted from any visible surface — hide its host from
  // the interactive + AT tree (the parking root is also inert, but keep the host
  // attribute explicit so it is hidden the instant it is parked).
  setRuntimeHostHidden(runtime, true);
  const parking = ensureParkedRoot();
  if (runtime.host.parentElement !== parking) {
    parking.appendChild(runtime.host);
  }
}

function disposeStaleRuntimes(activeProjectKey: string | null, activeProjectRevision: number) {
  for (const runtime of runtimeCache.values()) {
    const isLiveRuntime = runtime.exitCode == null;
    if (activeProjectKey == null) {
      if (runtime.projectKey != null && !isLiveRuntime && runtime.refs === 0) {
        teardownRuntime(runtime);
      }
      continue;
    }

    if (!isLiveRuntime && runtime.refs === 0 && runtime.projectKey === activeProjectKey && runtime.projectRevision !== activeProjectRevision) {
      scheduleRuntimeDispose(runtime, EXITED_RUNTIME_KEEPALIVE_MS);
    }
  }
}

export function disposeTerminalRuntimesForProjectChange(
  activeProjectKey: string | null,
  activeProjectRevision: number,
): void {
  disposeStaleRuntimes(activeProjectKey, activeProjectRevision);
}

function setRuntimeInteractionState(runtime: CachedRuntime, active: boolean) {
  // Active ownership gates keyboard input and tab-focusability only. It must NOT
  // gate `inert`/`aria-hidden`: a visible-but-inactive grid tile has to stay
  // clickable (so a pointer-down can transfer focus and activate it) and remain
  // readable by assistive tech. Hiding from the interactive/AT tree is a
  // visibility concern, handled by setRuntimeHostHidden.
  runtime.active = active;
  runtime.inputEnabled = active;
  try {
    // tabIndex stays active-gated: an inactive tile stays out of the Tab order
    // while remaining click/programmatically focusable.
    runtime.host.tabIndex = active ? 0 : -1;
  } catch {
    // ignore
  }
}

/**
 * Visibility-gated hiding of a terminal host from the interactive + AT tree.
 * A hidden host (parked or on an inactive/offscreen surface) is `inert` +
 * `aria-hidden`; a visible host is fully interactive even when it is not the
 * active grid member.
 */
function setRuntimeHostHidden(runtime: CachedRuntime, hidden: boolean) {
  try {
    if (hidden) {
      runtime.host.setAttribute("aria-hidden", "true");
      runtime.host.setAttribute("inert", "");
    } else {
      runtime.host.removeAttribute("aria-hidden");
      runtime.host.removeAttribute("inert");
    }
  } catch {
    // ignore
  }
}

function shouldRuntimeReceivePtyData(runtime: CachedRuntime): boolean {
  return !runtime.disposed && runtime.refs > 0 && runtime.visible;
}

function runtimePinSubscriptionKey(pin: OpenProjectBinding): string {
  return `${pin.kind}:${pin.key}`;
}

function updatePtyDataSubscriptions(removedRuntime?: CachedRuntime): void {
  if (
    pinnedPtyRuntimeCount === 0
    && pinnedPtyDataSubscriptionSignatures.size === 0
    && !removedRuntime?.runtimePin
  ) {
    // Preserve the original unpinned subscription path: one Set, one sorted
    // array, the existing signature check, and the one-argument preload call.
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
    return;
  }

  const unpinnedPtyIds = new Set<string>();
  const pinnedGroups = new Map<string, {
    pin: OpenProjectBinding;
    ptyIds: Set<string>;
  }>();
  let hasUnpinnedRuntime = false;

  for (const [ptyId, runtimes] of ptyDataRuntimesByPtyId) {
    for (const runtime of runtimes) {
      if (runtime.runtimePin) {
        const key = runtimePinSubscriptionKey(runtime.runtimePin);
        let group = pinnedGroups.get(key);
        if (!group) {
          group = { pin: runtime.runtimePin, ptyIds: new Set() };
          pinnedGroups.set(key, group);
        }
        if (shouldRuntimeReceivePtyData(runtime)) group.ptyIds.add(ptyId);
        continue;
      }

      hasUnpinnedRuntime = true;
      if (shouldRuntimeReceivePtyData(runtime)) {
        unpinnedPtyIds.add(ptyId);
      }
    }
  }

  const setDataSubscriptions = window.ade.pty.setDataSubscriptions;
  if (hasUnpinnedRuntime || ptyDataSubscriptionSignature != null) {
    const next = [...unpinnedPtyIds].sort();
    const signature = next.join("\0");
    if (signature !== ptyDataSubscriptionSignature) {
      ptyDataSubscriptionSignature = signature;
      if (typeof setDataSubscriptions === "function") {
        // The overwhelmingly common local path intentionally retains the
        // original one-argument call shape and allocation count.
        setDataSubscriptions({ ptyIds: next }).catch(() => {});
      }
    }
  }

  for (const [key, group] of pinnedGroups) {
    const next = [...group.ptyIds].sort();
    const signature = next.join("\0");
    if (signature === pinnedPtyDataSubscriptionSignatures.get(key)) continue;
    pinnedPtyDataSubscriptionSignatures.set(key, signature);
    if (typeof setDataSubscriptions === "function") {
      setDataSubscriptions({ ptyIds: next }, group.pin).catch(() => {});
    }
  }

  // A removed runtime is the authoritative source for its pin even after the
  // runtime leaves the shared PTY map. Clear that machine's subscription
  // without retaining a module-global binding that another session could reuse.
  if (removedRuntime?.runtimePin) {
    const key = runtimePinSubscriptionKey(removedRuntime.runtimePin);
    if (
      !pinnedGroups.has(key)
      && pinnedPtyDataSubscriptionSignatures.has(key)
    ) {
      pinnedPtyDataSubscriptionSignatures.delete(key);
      if (typeof setDataSubscriptions === "function") {
        setDataSubscriptions({ ptyIds: [] }, removedRuntime.runtimePin).catch(() => {});
      }
    }
  }
}

function clearRuntimeHydrationTimers(runtime: CachedRuntime): void {
  if (runtime.rehydrateDimsTimer) {
    clearTimeout(runtime.rehydrateDimsTimer);
    runtime.rehydrateDimsTimer = null;
  }
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
  if (runtime.replaceFitRetryTimer) {
    clearTimeout(runtime.replaceFitRetryTimer);
    runtime.replaceFitRetryTimer = null;
  }
  runtime.pendingReplaceData = null;
  runtime.replaceFitRetryAttempts = 0;
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
  runtime.hydrationGeneration += 1;
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
  if (runtime.runtimePin) {
    window.ade.pty.write({ ptyId: runtime.ptyId, data }, runtime.runtimePin).catch(() => {});
    return;
  }
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
  if (runtime.pasteWriteInFlight) return;
  const data = consumePendingPtyInput(runtime);
  if (!data) return;
  writePtyInputNow(runtime, data);
}

function writePtyInput(runtime: CachedRuntime, data: string) {
  if (!data || runtime.disposed) return;
  if (runtime.pasteWriteInFlight) {
    runtime.deferredInputDuringPasteWrite.push({ kind: "input", data });
    return;
  }
  writePtyInputNow(runtime, `${consumePendingPtyInput(runtime)}${data}`);
}

function formatTextPasteForTerminal(runtime: CachedRuntime, text: string): string {
  const prepared = text.replace(/\r?\n/g, "\r");
  if (!runtime.bracketedPasteMode) return prepared;
  const sanitized = prepared.replace(/\x1b/g, "\u241b");
  return `${TERMINAL_BRACKETED_PASTE_START}${sanitized}${TERMINAL_BRACKETED_PASTE_END}`;
}

function syncTerminalInputModesFromXterm(runtime: CachedRuntime): void {
  if (runtime.term.modes?.bracketedPasteMode === true) {
    runtime.bracketedPasteMode = true;
  }
}

async function refreshTerminalInputModesForPaste(runtime: CachedRuntime): Promise<void> {
  syncTerminalInputModesFromXterm(runtime);
  if (runtime.hydrationCompleted && !runtime.liveStreamPaused) return;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve(""), PASTE_MODE_REFRESH_TIMEOUT_MS);
    });
    const data = await Promise.race([
      readTerminalInputModeRefreshData(runtime),
      timeoutPromise,
    ]);
    if (!runtime.disposed && data) {
      updateTerminalInputModes(runtime, data);
    }
  } catch {
    // Best effort only; a stale cache should not block paste entirely.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function consumeDeferredInputDuringPasteWrite(runtime: CachedRuntime): string {
  if (!runtime.deferredInputDuringPasteWrite.length) return "";
  const data = runtime.deferredInputDuringPasteWrite
    .map((entry) => (
      entry.kind === "paste" ? formatTextPasteForTerminal(runtime, entry.text) : entry.data
    ))
    .join("");
  runtime.deferredInputDuringPasteWrite.length = 0;
  return data;
}

async function writeTextPasteForTerminal(runtime: CachedRuntime, text: string): Promise<void> {
  if (!text || runtime.disposed) return;
  if (runtime.pasteWriteInFlight) {
    runtime.deferredInputDuringPasteWrite.push({ kind: "paste", text });
    return;
  }

  runtime.pasteWriteInFlight = true;
  let committed = false;
  try {
    await refreshTerminalInputModesForPaste(runtime);
    if (runtime.disposed) return;
    const deferredInput = consumeDeferredInputDuringPasteWrite(runtime);
    runtime.pasteWriteInFlight = false;
    committed = true;
    writePtyInput(runtime, `${formatTextPasteForTerminal(runtime, text)}${deferredInput}`);
  } finally {
    if (!committed) {
      const deferredInput = consumeDeferredInputDuringPasteWrite(runtime);
      runtime.pasteWriteInFlight = false;
      if (!runtime.disposed && deferredInput) {
        writePtyInput(runtime, deferredInput);
      }
    }
  }
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
  if (runtime.pasteWriteInFlight) {
    runtime.deferredInputDuringPasteWrite.push({ kind: "input", data });
    return;
  }
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

function hasTerminalPrivateModeSequence(data: string, targetMode: number): boolean {
  for (const match of data.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
    for (const rawParam of match[1].split(";")) {
      if (Number(rawParam) === targetMode) return true;
    }
  }
  return false;
}

function isTerminalMouseTrackingActive(runtime: CachedRuntime): boolean {
  const xtermMode = runtime.term.modes?.mouseTrackingMode;
  return runtime.mouseTrackingModes.size > 0 || (xtermMode != null && xtermMode !== "none");
}

/**
 * Keeps `scrollOnUserInput` from turning mouse motion into a scroll-to-bottom.
 *
 * xterm's `scrollOnUserInput` (default true, and what we want for typing —
 * pressing a key should snap you back to the prompt) scrolls the viewport to
 * the bottom whenever the terminal forwards user input to the application. Under
 * mouse tracking a TUI enables (modes 1002/1003, "report motion"), a bare
 * mousemove IS forwarded input, so simply moving the pointer over a terminal the
 * user has scrolled back in yanks them to the bottom before they can read
 * anything.
 *
 * So the option is not constant: it is off while the pointer is over a
 * scrolled-back terminal that is reporting motion, and restored the moment the
 * user types or returns to the bottom. Keyboard input keeps its snap; the mouse
 * loses one it should never have had.
 */
function syncScrollOnUserInput(runtime: CachedRuntime, args: { pointerOver: boolean }): void {
  const suppress = args.pointerOver
    && isTerminalMouseTrackingActive(runtime)
    && !shouldFollowTerminalOutput(runtime);
  try {
    if (runtime.term.options.scrollOnUserInput === !suppress) return;
    runtime.term.options.scrollOnUserInput = !suppress;
  } catch {
    // ignore option writes after disposal
  }
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

type TerminalClipboardImage = { data: string; filename: string; mimeType: string };

// Both attachment sinks decode `data` as bare base64: the desktop IPC handler
// (Buffer.from(data, "base64")) and the sync host (which rejects anything
// outside the base64 alphabet). The web adapter's readClipboardImage answers
// with a full data URL, so strip the prefix rather than shipping bytes that
// decode to garbage on one side and throw on the other.
function base64FromImageData(value: string): string {
  if (!value.startsWith("data:")) return value;
  const comma = value.indexOf(",");
  return comma >= 0 ? value.slice(comma + 1) : "";
}

async function attachClipboardImageToRuntime(
  runtime: CachedRuntime,
  image: TerminalClipboardImage,
): Promise<boolean> {
  if (runtime.disposed) return false;
  try {
    const data = base64FromImageData(image.data);
    if (!data) return false;
    const attachmentArgs = {
      data,
      filename: image.filename || "clipboard.png",
    };
    const saved = runtime.runtimePin
      ? await window.ade.agentChat.saveTempAttachment(attachmentArgs, runtime.runtimePin)
      : await window.ade.agentChat.saveTempAttachment(attachmentArgs);
    if (runtime.disposed) return false;
    writePtyInput(runtime, bracketedPaste(formatClipboardImageForPty(saved.path, image.mimeType)));
    return true;
  } catch {
    return false;
  }
}

async function pasteRuntimeClipboardImageAttachment(runtime: CachedRuntime): Promise<boolean> {
  if (runtime.disposed) return false;
  let image: TerminalClipboardImage | null = null;
  try {
    image = await window.ade.app.readClipboardImage();
  } catch {
    return false;
  }
  if (!image || runtime.disposed) return false;
  return await attachClipboardImageToRuntime(runtime, image);
}

// A paste event carries the image bytes of the device the user is actually
// typing on, synchronously and without a permission prompt. On web,
// navigator.clipboard.read() (the readClipboardImage path) is permission-gated
// and, when the browser is remote, reads the wrong machine's clipboard — so
// prefer the event's own items whenever the paste arrives as a real event.
function clipboardImageBlobFromEvent(data: DataTransfer | null | undefined): Blob | null {
  if (!data) return null;
  const files = data.files as ArrayLike<File> | undefined;
  for (let index = 0; index < (files?.length ?? 0); index += 1) {
    const file = files?.[index];
    if (file && typeof file.type === "string" && file.type.startsWith("image/")) return file;
  }
  const items = data.items as ArrayLike<DataTransferItem> | undefined;
  for (let index = 0; index < (items?.length ?? 0); index += 1) {
    const item = items?.[index];
    if (!item || item.kind !== "file" || !item.type?.startsWith("image/")) continue;
    // getAsFile must run inside the event handler; DataTransferItems are
    // neutered once it returns.
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

// The attachment sink infers the stored file's type from the filename
// extension (it renames the file to a uuid anyway), so name the paste after its
// own mime instead of trusting a pasted File's name — a .png name carrying webp
// bytes is rejected as a mime mismatch.
const CLIPBOARD_IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "image/svg+xml": ".svg",
};

async function pasteClipboardImageBlob(runtime: CachedRuntime, blob: Blob): Promise<boolean> {
  if (runtime.disposed) return false;
  const mimeType = blob.type?.toLowerCase() || "image/png";
  const extension = CLIPBOARD_IMAGE_EXTENSION_BY_MIME[mimeType];
  if (!extension) return false;
  let dataUrl: string;
  try {
    dataUrl = await blobToDataUrl(blob);
  } catch {
    return false;
  }
  if (!dataUrl || runtime.disposed) return false;
  return await attachClipboardImageToRuntime(runtime, {
    data: dataUrl,
    filename: `clipboard-image${extension}`,
    mimeType,
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read the pasted image."));
    reader.readAsDataURL(blob);
  });
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
  // Covers hydrate/hydrateRetry/backfill plus the two the hand-written list
  // here kept missing: replaceFitRetryTimer and rehydrateDimsTimer.
  clearRuntimeHydrationTimers(runtime);
  if (runtime.invalidFitRetryTimer) clearTimeout(runtime.invalidFitRetryTimer);
  runtime.macShiftSelectionCleanup?.();

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

/**
 * The compounded CSS `zoom` the terminal would otherwise inherit.
 *
 * The hosted client scales its whole UI with `body { zoom: <factor> }`
 * (webclient/adapter/misc.ts), which defaults to 1.1 at the "100%" setting.
 */
function webZoomFactor(): number {
  if (typeof document === "undefined") return 1;
  const raw = document.documentElement?.style?.getPropertyValue("--ade-web-zoom-factor");
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Cancels ancestor CSS zoom over the terminal, trading it for a scaled font.
 *
 * xterm converts a pointer position to a cell with
 * `Math.ceil((clientY - rect.top) / cellHeight)` (getCoordsRelativeToElement /
 * getCoords in the bundle). Under an ancestor `zoom`, the numerator is in the
 * ZOOMED coordinate space while `cellHeight` comes from `charSizeService`
 * measuring a DOM node in UNZOOMED CSS px. The quotient is therefore inflated by
 * the zoom factor, and the error grows with distance from the top of the grid —
 * which is exactly "I highlight a line and get the one below it", worse further
 * down the pane.
 *
 * xterm has no notion of zoom, so rather than patch its arithmetic (fragile, and
 * engine-specific — Safari and Chrome disagree about rect semantics under zoom)
 * we make the arithmetic true again: give the host the reciprocal zoom so the
 * COMPOUNDED factor at the terminal is exactly 1, then scale `fontSize` by the
 * factor so it still renders at the size the zoom level asked for. As a bonus
 * the canvas stops being a zoom-rasterized bitmap and renders at native
 * resolution.
 */
function applyZoomCompensation(runtime: CachedRuntime): boolean {
  const factor = webZoomFactor();
  if (factor === runtime.lastZoomFactor) return false;
  runtime.lastZoomFactor = factor;
  try {
    const hostStyle = runtime.host.style as CSSStyleDeclaration & { zoom?: string };
    hostStyle.zoom = factor === 1 ? "" : String(1 / factor);
    runtime.term.options.fontSize = Math.round(runtime.baseFontSize * factor);
  } catch {
    // ignore style/option writes after disposal
  }
  clearTextureAtlas(runtime);
  return true;
}

function doFit(runtime: CachedRuntime, forcePtyResize = false) {
  if (runtime.disposed) return;
  if (!runtime.visible && runtime.hasFittedOnce) return;
  if (!ensureOpen(runtime)) return;
  // Before measuring anything: a zoom change alters both the host box and the
  // cell size, so compensating first means this fit measures the final state.
  applyZoomCompensation(runtime);
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

  const firstFit = !runtime.hasFittedOnce;
  runtime.hasFittedOnce = true;
  // A fit is "valid" at anything above MIN_VALID_COLS, so a pane measured
  // mid-layout or while collapsed can legitimately fit to ~20 columns and stick
  // (observed in the wild: an .xterm-screen 182px wide rendering a 155-column
  // session). Keying the correction on the FIRST fit would fire at that bogus
  // width and never again, so it keys on the width CHANGING instead — which is
  // also what makes a keep-alive pane correct itself when it is finally
  // revealed at its real size.
  scheduleRehydrateForDimsChange(runtime, next.cols);
  // The width watch keys on the width CHANGING, which silently misses the case
  // that armed it: content hydrated at xterm's 80-column constructor default
  // that then fits to exactly 80 columns. `hydratedAtCols === cols` there, so
  // the watch never fires and the 80-column wrapping (and its scrollback) is
  // permanent. The first real fit is the moment the flag means what it says, so
  // honour it directly.
  if (firstFit && runtime.hydratedWhileUnfitted) rehydrateAfterFit(runtime);
  const prev = previousDims;
  if (!prev || prev.cols !== next.cols || prev.rows !== next.rows || forcePtyResize) {
    if (windowOwnsPtySize()) {
      runtime.lastDims = next;
      requestPtyResize(runtime, next, forcePtyResize);
    } else {
      // Suppressed, not discarded. `lastDims` deliberately does NOT advance —
      // recording dims that were never sent would make the next fit look like a
      // no-op and strand the PTY at the other viewer's width — and the pending
      // force flag is what the focus/force path (and the safety-pass raf) uses
      // to push these dims the moment this window becomes the owner.
      runtime.pendingForceResize = true;
    }
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

function replaceRuntimeTerminalData(runtime: CachedRuntime, data: string) {
  // Recovery snapshots are authoritative. Invalidate every pending hydration
  // read before clearing xterm so an older preview/transcript promise cannot
  // replay stale output over the recovered state.
  runtime.hydrationGeneration += 1;
  clearRuntimeHydrationTimers(runtime);
  discardScheduledFrameWrites(runtime);
  runtime.pendingHydrationChunks.length = 0;
  runtime.pendingHydrationBytes = 0;
  runtime.hydrationStarted = true;
  runtime.hydrationCompleted = true;
  runtime.hydrationBackfillAttempts = 0;
  runtime.displayedLiveDataBeforeHydration = false;
  runtime.hasAppliedTerminalContent = false;
  runtime.replayMode = false;
  runtime.replayLoadedBytes = null;
  runtime.bracketedPasteMode = false;
  runtime.mouseTrackingModes.clear();
  void takePendingTerminalOffsetAnchor(runtime.sessionId);

  runtime.pendingReplaceData = data;
  runtime.replaceFitRetryAttempts = 0;
  applyPendingReplaceWhenFitted(runtime);
}

/**
 * Writes a recovery snapshot only once the terminal has been measured.
 *
 * A snapshot is a stream of cursor-positioning sequences and hard-wrapped rows
 * that only mean what they meant on the machine that produced them if the
 * receiving terminal has the same column count. xterm does NOT reflow a buffer
 * on resize, so bytes written at the constructor default (80 cols) and then fit
 * to the real viewport keep the wrapping they were parsed with — which renders
 * as a diagonal "staircase" of fragments through the scrollback, one fragment
 * per line at a rising column offset.
 *
 * `startHydration` already waits for the first fit for exactly this reason
 * (`waitForFitThenHydrate`). The `replace: true` path did not, and on the web
 * client it is the common path: a remount re-attaches the mirror and the host
 * answers with a full snapshot, routinely before the host element has been
 * measured. Same wait, same attempt budget.
 */
function applyPendingReplaceWhenFitted(
  runtime: CachedRuntime,
  // Captured at the ENTRY that owns this payload and threaded through every
  // retry tick. Re-reading `runtime.hydrationGeneration` on each tick would
  // re-adopt whatever bumped it in the meantime, so a superseded retry would
  // pass its own staleness check and write over the newer snapshot.
  entryGeneration?: number,
): void {
  if (runtime.disposed || runtime.pendingReplaceData == null) return;
  // Normalization awaits, and a newer snapshot may land in that window.
  // `replaceRuntimeTerminalData` bumps this, so it is the token that says
  // "the payload I was asked to write is still the current one".
  const generation = entryGeneration ?? runtime.hydrationGeneration;
  if (runtime.hydrationGeneration !== generation) return;
  if (runtime.replaceFitRetryTimer) {
    clearTimeout(runtime.replaceFitRetryTimer);
    runtime.replaceFitRetryTimer = null;
  }

  if (!runtime.hasFittedOnce) {
    // Drive the measurement rather than only waiting on it: the snapshot can
    // land before any scheduled fit has run, and a terminal that is genuinely
    // unmeasurable (hidden pane) must still fall through below rather than
    // stall the recovery forever.
    doFit(runtime, true);
    // That first fit can re-enter this function: it triggers `rehydrateAfterFit`
    // for content hydrated while unmeasured, which re-arms the queued snapshot
    // and drives it through a fresh generation. If it did, the payload has
    // already been handled and this frame is stale — writing again would
    // duplicate it and fight the newer generation's retry timer.
    if (runtime.pendingReplaceData == null || runtime.hydrationGeneration !== generation) return;
  }
  const ready = terminalWidthTrustworthy(runtime);
  if (!ready && runtime.replaceFitRetryAttempts < REPLACE_FIT_MAX_ATTEMPTS) {
    runtime.replaceFitRetryAttempts += 1;
    runtime.replaceFitRetryTimer = setTimeout(() => {
      runtime.replaceFitRetryTimer = null;
      applyPendingReplaceWhenFitted(runtime, generation);
    }, REPLACE_FIT_RETRY_MS);
    return;
  }

  if (!ready) {
    // Budget spent without a trustworthy grid. Writing is still the right call
    // — a blank pane is worse than a possibly-rewrapped one, and live output
    // plus the next fit will correct it — but xterm is very likely still at its
    // 80x24 constructor size here, so say so out loud instead of leaving a
    // silently rewrapped screen to be reported as "jumbled" later.
    logTerminalDiag("warn", describeTerminalDims(runtime, { reason: "replace-write-unfitted" }));
    // Same correction as the hydration fall-through: the first real fit re-runs
    // hydration rather than leaving 80-column wrapping and its scrollback.
    runtime.hydratedWhileUnfitted = true;
  }

  const data = runtime.pendingReplaceData;
  runtime.pendingReplaceData = null;
  runtime.replaceFitRetryAttempts = 0;

  // A live-subscribe snapshot is the SAME raw transcript the preview path
  // serves — up to LIVE_TERMINAL_SUBSCRIBE_MAX_BYTES (2 MB) of positioned TUI
  // repaints — it just arrives as a `replace: true` PtyDataEvent instead of a
  // hydration read. Writing it verbatim refills the buffer with bulk bytes:
  // scrollback balloons, `baseY` goes large, and the wheel handler's local
  // scrollback branch wins over forwarding to the TUI. Normalize it exactly as
  // hydration does, then write.
  const writeReplace = (text: string | null) => {
    if (runtime.disposed || runtime.hydrationGeneration !== generation) return;
    try {
      runtime.term.reset();
    } catch {
      // A renderer can disappear during recovery; keep the stream usable.
    }
    if (text) {
      updateTerminalInputModes(runtime, text);
      try {
        runtime.term.write(text);
        runtime.hasAppliedTerminalContent = hasRenderableTerminalText(text);
      } catch {
        // ignore write errors after disposal
      }
    }
    runtime.hydratedAtCols = recordHydratedCols(runtime, text ?? "");
    scheduleVisibleFrameRefresh(runtime, { scrollToBottom: true });
    scheduleFit(runtime, true);
    // `replaceRuntimeTerminalData` marks hydration complete without ever going
    // through `finalizeHydration`, so this is the only place the replace path
    // can report. Without it a live web session — which hydrates ONLY from the
    // subscribe backlog — produces total console silence, indistinguishable
    // from instrumentation that never ran.
    reportHydrationComplete(runtime, "replace");
  };

  if (data) {
    void normalizeTranscriptToGrid(trimToLikelyTerminalFrameBoundary(data), {
      maxRows: hydrationGridMaxRows(runtime),
    })
      .then((grid) => {
        runtime.lastHydrationNormalized = Boolean(grid);
        writeReplace(grid ? `${grid}${inferTerminalModesFromTranscript(data)}` : data);
      })
      .catch(() => {
        runtime.lastHydrationNormalized = false;
        writeReplace(data);
      });
    return;
  }
  writeReplace(null);
}

function handleRuntimePtyData(runtime: CachedRuntime, ev: PtyDataEvent) {
  if (!shouldDeliverPtyEvent(runtime, ev.projectRoot)) return;
  if (!shouldRuntimeReceivePtyData(runtime)) {
    // A parked terminal already skips every xterm write. What it did NOT skip
    // was this mode scan — a regex sweep over every chunk of every backgrounded
    // session, which under keep-alive is N full TUI streams being parsed for
    // nobody. Scan once on the way into the paused state (so the modes captured
    // at park time are the last known good ones), then stop: `resume` runs a
    // fresh hydration, and hydration now restores modes itself via
    // `inferTerminalModesFromTranscript`, so nothing depends on tracking them
    // while parked.
    if (!runtime.liveStreamPaused) updateTerminalInputModes(runtime, ev.data);
    pauseRuntimePtyStream(runtime);
    return;
  }

  if (ev.replace === true) {
    replaceRuntimeTerminalData(runtime, ev.data);
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

function hasRuntimeForSubscriptionKey(
  map: Map<string, Set<CachedRuntime>>,
  subscriptionKey: string | null,
): boolean {
  for (const runtimes of map.values()) {
    for (const runtime of runtimes) {
      const runtimeKey = runtime.runtimePin
        ? runtimePinSubscriptionKey(runtime.runtimePin)
        : null;
      if (runtimeKey === subscriptionKey) return true;
    }
  }
  return false;
}

function dispatchPtyDataEvent(ev: PtyDataEvent, subscriptionKey: string | null): void {
  const targets = ptyDataRuntimesByPtyId.get(ev.ptyId);
  if (!targets) return;
  for (const target of [...targets]) {
    const targetKey = target.runtimePin
      ? runtimePinSubscriptionKey(target.runtimePin)
      : null;
    if (targetKey === subscriptionKey) handleRuntimePtyData(target, ev);
  }
}

function dispatchPtyExitEvent(ev: PtyExitEvent, subscriptionKey: string | null): void {
  const targets = ptyExitRuntimesByPtyId.get(ev.ptyId);
  if (!targets) return;
  for (const target of [...targets]) {
    const targetKey = target.runtimePin
      ? runtimePinSubscriptionKey(target.runtimePin)
      : null;
    if (targetKey === subscriptionKey) handleRuntimePtyExit(target, ev);
  }
}

function subscribeRuntimePtyData(runtime: CachedRuntime): () => void {
  let runtimes = ptyDataRuntimesByPtyId.get(runtime.ptyId);
  if (!runtimes) {
    runtimes = new Set();
    ptyDataRuntimesByPtyId.set(runtime.ptyId, runtimes);
  }
  runtimes.add(runtime);
  if (runtime.runtimePin) pinnedPtyRuntimeCount += 1;
  updatePtyDataSubscriptions();
  const runtimePin = runtime.runtimePin;
  const subscriptionKey = runtimePin
    ? runtimePinSubscriptionKey(runtimePin)
    : null;
  if (runtimePin) {
    const pinnedSubscriptionKey = runtimePinSubscriptionKey(runtimePin);
    if (!pinnedPtyDataUnsubs.has(pinnedSubscriptionKey)) {
      pinnedPtyDataUnsubs.set(
        pinnedSubscriptionKey,
        window.ade.pty.onData(
          (ev) => dispatchPtyDataEvent(ev, pinnedSubscriptionKey),
          runtimePin,
        ),
      );
    }
  } else if (!sharedPtyDataUnsub) {
    // Keep the original active-project listener and call arity untouched.
    sharedPtyDataUnsub = window.ade.pty.onData((ev) => dispatchPtyDataEvent(ev, null));
  }
  return () => {
    removeRuntimePtySubscription(ptyDataRuntimesByPtyId, runtime);
    if (runtime.runtimePin) pinnedPtyRuntimeCount = Math.max(0, pinnedPtyRuntimeCount - 1);
    updatePtyDataSubscriptions(runtime);
    if (subscriptionKey && !hasRuntimeForSubscriptionKey(ptyDataRuntimesByPtyId, subscriptionKey)) {
      pinnedPtyDataUnsubs.get(subscriptionKey)?.();
      pinnedPtyDataUnsubs.delete(subscriptionKey);
    } else if (!subscriptionKey && !hasRuntimeForSubscriptionKey(ptyDataRuntimesByPtyId, null) && sharedPtyDataUnsub) {
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
  const runtimePin = runtime.runtimePin;
  const subscriptionKey = runtimePin
    ? runtimePinSubscriptionKey(runtimePin)
    : null;
  if (runtimePin) {
    const pinnedSubscriptionKey = runtimePinSubscriptionKey(runtimePin);
    if (!pinnedPtyExitUnsubs.has(pinnedSubscriptionKey)) {
      pinnedPtyExitUnsubs.set(
        pinnedSubscriptionKey,
        window.ade.pty.onExit(
          (ev) => dispatchPtyExitEvent(ev, pinnedSubscriptionKey),
          runtimePin,
        ),
      );
    }
  } else if (!sharedPtyExitUnsub) {
    // Keep the original active-project listener and call arity untouched.
    sharedPtyExitUnsub = window.ade.pty.onExit((ev) => dispatchPtyExitEvent(ev, null));
  }
  return () => {
    removeRuntimePtySubscription(ptyExitRuntimesByPtyId, runtime);
    if (subscriptionKey && !hasRuntimeForSubscriptionKey(ptyExitRuntimesByPtyId, subscriptionKey)) {
      pinnedPtyExitUnsubs.get(subscriptionKey)?.();
      pinnedPtyExitUnsubs.delete(subscriptionKey);
    } else if (!subscriptionKey && !hasRuntimeForSubscriptionKey(ptyExitRuntimesByPtyId, null) && sharedPtyExitUnsub) {
      sharedPtyExitUnsub();
      sharedPtyExitUnsub = null;
    }
  };
}

function flushHydrationData(
  runtime: CachedRuntime,
  tail: string,
  options: { appendPending?: boolean; replay?: boolean; scrollToBottom?: boolean } = {},
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
          if (options.scrollToBottom ?? true) {
            runtime.term.scrollToBottom();
          }
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
  const preview = runtime.runtimePin
    ? await window.ade.terminal.preview({
        terminalId: runtime.sessionId,
        maxBytes: HYDRATE_TAIL_BYTES,
      }, runtime.runtimePin)
    : await window.ade.terminal.preview({
        terminalId: runtime.sessionId,
        maxBytes: HYDRATE_TAIL_BYTES,
      });
  if (preview?.snapshot) {
    reportTerminalDimsMismatch(runtime, {
      reason: "snapshot-hydrate",
      snapshot: { cols: preview.snapshot.cols, rows: preview.snapshot.rows },
    });
    const snapshot = serializeSnapshotForHydration(preview.snapshot);
    if (snapshot) return { source: "snapshot", text: snapshot };
  }
  if (options.snapshotOnly) return { source: "empty", text: "" };
  if (preview?.transcript) return { source: "transcript", text: preview.transcript };
  return { source: "empty", text: "" };
}

async function readTerminalInputModeRefreshData(runtime: CachedRuntime): Promise<string> {
  let transcript = "";
  try {
    const args = {
      sessionId: runtime.sessionId,
      maxBytes: HYDRATE_TAIL_BYTES,
      raw: true,
    };
    transcript = (runtime.runtimePin
      ? await window.ade.sessions.readTranscriptTail(args, runtime.runtimePin)
      : await window.ade.sessions.readTranscriptTail(args)) || "";
    if (hasTerminalPrivateModeSequence(transcript, TERMINAL_BRACKETED_PASTE_MODE)) {
      return transcript;
    }
  } catch {
    transcript = "";
  }

  try {
    const preview = runtime.runtimePin
      ? await window.ade.terminal.preview({
          terminalId: runtime.sessionId,
          maxBytes: HYDRATE_TAIL_BYTES,
        }, runtime.runtimePin)
      : await window.ade.terminal.preview({
          terminalId: runtime.sessionId,
          maxBytes: HYDRATE_TAIL_BYTES,
        });
    const snapshot = preview?.snapshot?.serialized ?? "";
    const previewTranscript = preview?.transcript ?? "";
    return `${snapshot}${previewTranscript}${transcript}`;
  } catch {
    return transcript;
  }
}

async function readReplayHydrationData(runtime: CachedRuntime): Promise<InitialHydrationData> {
  // Use sessions.readTranscriptTail (not terminal.read) so this works for chat-CLI
  // tool types — terminal.read/preview throws for isPersistedChatToolType sessions.
  const args = {
    sessionId: runtime.sessionId,
    maxBytes: REPLAY_TRANSCRIPT_MAX_BYTES,
    raw: true,
  };
  const data = runtime.runtimePin
    ? await window.ade.sessions.readTranscriptTail(args, runtime.runtimePin)
    : await window.ade.sessions.readTranscriptTail(args);
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
    const detail = runtime.runtimePin
      ? await window.ade.sessions.get(runtime.sessionId, runtime.runtimePin)
      : await window.ade.sessions.get(runtime.sessionId);
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
    const preview = runtime.runtimePin
      ? await window.ade.terminal.preview({
          terminalId: runtime.sessionId,
          maxBytes: HYDRATE_TAIL_BYTES,
        }, runtime.runtimePin)
      : await window.ade.terminal.preview({
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
      reportTerminalDimsMismatch(runtime, {
        reason: "snapshot-hydrate",
        snapshot: { cols: preview.snapshot.cols, rows: preview.snapshot.rows },
      });
      const snapshot = serializeSnapshotForHydration(preview.snapshot);
      if (snapshot) return { source: "snapshot", text: snapshot };
    }
    if (preview?.transcript) return { source: "transcript", text: preview.transcript };
  } catch {
    // Fall back to the transcript tail below.
  }

  const transcriptArgs = {
    sessionId: runtime.sessionId,
    maxBytes: HYDRATE_TAIL_BYTES,
    raw: true,
  };
  const transcript = runtime.runtimePin
    ? await window.ade.sessions.readTranscriptTail(transcriptArgs, runtime.runtimePin)
    : await window.ade.sessions.readTranscriptTail(transcriptArgs);
  return transcript
    ? { source: "transcript", text: transcript }
    : { source: "empty", text: "" };
}

/**
 * The one line that ALWAYS prints, once per hydration.
 *
 * Every other `[ade-term]` line is conditional on a mismatch, which means a
 * healthy-looking run produces total silence — and silence is indistinguishable
 * from "the instrumentation never ran". This makes that impossible: after every
 * hydration, exactly one line states which byte path was taken, whether it was
 * normalized, and the resulting `baseY` (0 means the wheel reaches the TUI;
 * anything larger means bulk bytes refilled the buffer and local scrollback
 * will capture the wheel instead).
 */
function reportHydrationComplete(
  runtime: CachedRuntime,
  // "replace" is not an `InitialHydrationData` source: a live-subscribe backlog
  // never travels through `readInitialHydrationData`. It is still a hydration —
  // it is the ONLY hydration a live web session gets — so it reports like one.
  source: InitialHydrationData["source"] | "replace",
): void {
  logTerminalDiag(
    "debug",
    describeTerminalDims(runtime, {
      reason: "hydrate-complete",
      note: `source=${source} normalized=${runtime.lastHydrationNormalized ? "yes" : "no"}`,
    }),
  );
}

/**
 * How many grid rows this runtime can absorb without creating scrollback.
 *
 * Only a MEASURED terminal knows: before the first fit xterm still reports its
 * 80x24 constructor size, and clamping a 65-row screen to 24 would throw away
 * content that the pane can actually show. Unfitted returns undefined, which
 * leaves the pre-existing "write the whole grid" behaviour — the later fit and
 * live output correct it, exactly as `replace-write-unfitted` already warns.
 */
function hydrationGridMaxRows(runtime: CachedRuntime): number | undefined {
  if (!runtime.hasFittedOnce) return undefined;
  try {
    const rows = runtime.term.rows;
    return rows >= MIN_VALID_ROWS ? rows : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Width-normalizes transcript-sourced hydration before it reaches the terminal.
 *
 * Only `transcript` needs it. A `snapshot` is already a rendered grid, `replay`
 * deliberately keeps every redraw as its scrollback, and `empty` has nothing to
 * normalize. Falls through to the original text whenever normalization declines
 * (no absolute positioning) or fails, so this can only improve the result.
 */
async function normalizeHydrationData(
  runtime: CachedRuntime,
  data: InitialHydrationData,
): Promise<InitialHydrationData> {
  if (data.source !== "transcript" || !data.text) return data;
  const grid = await normalizeTranscriptToGrid(trimToLikelyTerminalFrameBoundary(data.text), {
    maxRows: hydrationGridMaxRows(runtime),
  });
  runtime.lastHydrationNormalized = Boolean(grid);
  if (!grid) {
    // `normalized=no` means the RAW bytes get written — positioned repaints at
    // the recording's width, i.e. the staircase this whole path exists to
    // prevent. Silence about WHY costs an investigation round every time, so
    // the decline states its reason: below the column floor (nothing to gain,
    // benign) versus a mirror that produced no rows (a real failure).
    const trimmed = trimToLikelyTerminalFrameBoundary(data.text);
    const cols = inferTranscriptColumns(trimmed);
    logTerminalDiag("warn", describeTerminalDims(runtime, {
      reason: "hydrate-normalize-declined",
      note: `bytes=${data.text.length} trimmed=${trimmed.length} inferredCols=${cols} `
        + `cause=${cols < MIN_VALID_COLS ? "below-col-floor" : "empty-grid-or-throw"}`,
    }));
    return data;
  }
  // Modes are read from the RAW text, never the trimmed/normalized grid, which
  // has every escape sequence stripped by construction.
  const modes = inferTerminalModesFromTranscript(data.text);
  if (!modes) {
    logTerminalDiag("warn", describeTerminalDims(runtime, { reason: "hydrate-no-modes-recovered" }));
  }
  return { ...data, text: `${grid}${modes}` };
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
    const hydrationGeneration = runtime.hydrationGeneration;

    readPreviewHydrationData(runtime, { snapshotOnly })
      .then((data) => normalizeHydrationData(runtime, data))
      .then((data) => {
        if (runtime.hydrationGeneration !== hydrationGeneration) return;
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
        if (runtime.hydrationGeneration !== hydrationGeneration) return;
        if (runtime.disposed || runtime.exitCode != null) return;
        scheduleHydrationBackfill(runtime, { snapshotOnly });
      });
  }, delayMs);
}

/**
 * The width hydration content was rendered at, or null when there is nothing
 * width-sensitive on screen. Empty hydrations must NOT arm the width watch:
 * they have no committed rows to invalidate, and arming on them would make
 * every later resize re-fetch a transcript for a blank pane.
 */
function recordHydratedCols(runtime: CachedRuntime, text: string): number | null {
  if (!hasRenderableTerminalText(text)) return null;
  try {
    return runtime.term.cols;
  } catch {
    return null;
  }
}

/**
 * Re-runs hydration when the pane settles at a different width than the content
 * was written at.
 *
 * Debounced, because a window drag walks through dozens of widths and each
 * hydration is a relay round-trip. The trailing edge is the one that matters:
 * the width the pane actually came to rest at.
 */
function scheduleRehydrateForDimsChange(runtime: CachedRuntime, cols: number): void {
  if (runtime.disposed || runtime.replayMode) return;
  if (runtime.hydratedAtCols == null || runtime.hydratedAtCols === cols) return;
  if (runtime.rehydrateDimsTimer) clearTimeout(runtime.rehydrateDimsTimer);
  runtime.rehydrateDimsTimer = setTimeout(() => {
    runtime.rehydrateDimsTimer = null;
    if (runtime.disposed || runtime.replayMode) return;
    let settled = cols;
    try {
      settled = runtime.term.cols;
    } catch {
      // a disposed terminal keeps the width we were called with
    }
    if (runtime.hydratedAtCols === settled) return;
    runtime.hydratedWhileUnfitted = true;
    rehydrateAfterFit(runtime);
  }, REHYDRATE_DIMS_DEBOUNCE_MS);
}

/**
 * Replaces a hydration that was written before the pane could be measured.
 *
 * `waitForFitThenHydrate` gives up after its budget and hydrates anyway — a
 * blank pane is worse than a mis-wrapped one — but xterm is then still at its
 * 80x24 constructor size, so the grid is wrapped to 80 columns and every row
 * past the 24th is pushed into scrollback. Resizing afterwards does NOT undo
 * either: xterm re-wraps what it can, but the rows it already committed stay
 * broken and the scrollback stays (measured: 30 wrapped rows and baseY 60 at
 * write, still 1 wrapped row and baseY 1 after the fit — a visible scrollbar
 * over garbled text, which is exactly the reported symptom).
 *
 * The first real fit is the moment the correct size is finally known, so
 * hydration is re-run from scratch against it. The generation bump makes any
 * in-flight normalization from the unfitted pass land as a no-op.
 */
function rehydrateAfterFit(runtime: CachedRuntime): void {
  if (!runtime.hydratedWhileUnfitted || runtime.disposed) return;
  runtime.hydratedWhileUnfitted = false;
  // Replay owns its scrollback deliberately (the transcript IS the product) and
  // is written once for a disposed session; re-running it would fight the
  // offset anchor for no gain.
  if (runtime.replayMode) return;
  logTerminalDiag("warn", describeTerminalDims(runtime, { reason: "rehydrate-after-fit" }));
  runtime.hydrationGeneration += 1;
  runtime.hydrationStarted = false;
  runtime.hydrationCompleted = false;
  // The re-run writes a FULL hydration payload, and the non-replay branch of
  // `finalizeHydration` only appends — it never resets. Without clearing here,
  // every width change stacks another copy of the transcript into the buffer.
  // (`writeReplace` resets for the same reason; this is the other entry point.)
  //
  // `clearRuntimeHydrationTimers` also drops `pendingReplaceData`, so rescue a
  // queued snapshot across it: a recovery snapshot is authoritative and, on the
  // web client, is the ONLY content the session ever gets — losing it to a
  // transcript re-read leaves a blank pane.
  const queuedReplace = runtime.pendingReplaceData;
  clearRuntimeHydrationTimers(runtime);
  try {
    runtime.term.reset();
  } catch {
    // a disposed renderer keeps whatever it has; the stream stays usable
  }
  runtime.hasAppliedTerminalContent = false;
  // The buffer is empty again, so the "live output beat hydration to the
  // screen" bookkeeping is no longer true — and it is sticky. Left set, the
  // `preferLivePending` branch of `finalizeHydration` DISCARDS the payload this
  // re-run just fetched in favour of pending chunks that the reset already
  // erased, which is a blank pane on every width change after live output once
  // arrived mid-hydration. Same clearing `resumeRuntimePtyStream` does.
  runtime.displayedLiveDataBeforeHydration = false;
  runtime.pendingHydrationChunks.length = 0;
  runtime.pendingHydrationBytes = 0;

  if (queuedReplace != null) {
    // An authoritative snapshot supersedes a re-read: re-arm it instead of
    // starting a transcript hydration that would race it.
    //
    // Take the same "hydration is settled" stance `replaceRuntimeTerminalData`
    // does. This branch never reaches `startHydration`, so leaving the flags
    // false above would strand the runtime mid-hydration forever: live chunks
    // would accumulate in `pendingHydrationChunks` instead of being written,
    // and everything else keyed on a completed hydration (paste round-trips,
    // the offset anchor) would never run.
    runtime.hydrationStarted = true;
    runtime.hydrationCompleted = true;
    runtime.pendingReplaceData = queuedReplace;
    runtime.replaceFitRetryAttempts = 0;
    applyPendingReplaceWhenFitted(runtime);
    return;
  }
  startHydration(runtime);
}

function startHydration(runtime: CachedRuntime) {
  if (runtime.hydrationStarted || runtime.disposed) return;
  runtime.hydrationStarted = true;
  const hydrationGeneration = runtime.hydrationGeneration;

  const finalizeHydration = (data: InitialHydrationData) => {
    if (runtime.disposed || runtime.hydrationGeneration !== hydrationGeneration) return;
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
      runtime.replayLoadedBytes = utf8ByteLength(data.text);
      const offsetAnchor = takePendingTerminalOffsetAnchor(runtime.sessionId);
      const shouldApplyOffsetAnchor = offsetAnchor != null && canMapReplayOffset(runtime.replayLoadedBytes);
      flushHydrationData(runtime, data.text, {
        appendPending: false,
        replay: true,
        scrollToBottom: !shouldApplyOffsetAnchor,
      });
      if (shouldApplyOffsetAnchor) scheduleReplayOffsetScroll(runtime, offsetAnchor);
      runtime.hydrationCompleted = true;
      // Surface the exited badge for disposed sessions that never fire
      // pty.onExit (the PTY is already gone before this view mounted).
      // readInitialHydrationData already pre-populated runtime.exitCode from
      // the session record when entering replay mode; notify listeners so the
      // local "exited N" state catches up.
      notifyRuntime(runtime);
      scheduleFit(runtime, true);
      reportHydrationComplete(runtime, data.source);
      // Disposed sessions never receive live PTY data, so no backfill polling.
      return;
    }
    runtime.replayLoadedBytes = null;
    void takePendingTerminalOffsetAnchor(runtime.sessionId);
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
    // Arm the re-hydration: these bytes were wrapped to 80 columns and spilled
    // into scrollback, and only the first real fit can correct them.
    runtime.hydratedWhileUnfitted = !runtime.hasFittedOnce && hasRenderableTerminalText(data.text);
    runtime.hydratedAtCols = recordHydratedCols(runtime, data.text);
    scheduleFit(runtime, true);
    reportHydrationComplete(runtime, data.source);
    scheduleHydrationBackfill(runtime, { snapshotOnly: runtime.displayedLiveDataBeforeHydration });
  };

  const hydrateTranscript = () => {
    readInitialHydrationData(runtime)
      .then((data) => normalizeHydrationData(runtime, data))
      .then(finalizeHydration)
      .catch(() => finalizeHydration({ source: "empty", text: "" }));
  };

  const waitForFitThenHydrate = (attempt: number) => {
    if (runtime.disposed || runtime.hydrationGeneration !== hydrationGeneration) return;
    if (terminalWidthTrustworthy(runtime) || attempt >= REPLACE_FIT_MAX_ATTEMPTS) {
      hydrateTranscript();
      return;
    }
    runtime.hydrateRetryTimer = setTimeout(() => {
      runtime.hydrateRetryTimer = null;
      waitForFitThenHydrate(attempt + 1);
    }, REPLACE_FIT_RETRY_MS);
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
  runtimePin: OpenProjectBinding | null;
  projectKey: string | null;
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
    macOptionClickForcesSelection: true,
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
    runtimePin: args.runtimePin,
    projectKey: args.projectKey,
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
    pendingReplaceData: null,
    replaceFitRetryTimer: null,
    replaceFitRetryAttempts: 0,
    hydrationBackfillTimer: null,
    hydrationBackfillAttempts: 0,
    lastZoomFactor: 1,
    baseFontSize: args.preferences.fontSize,
    lastHydrationNormalized: false,
    hydratedWhileUnfitted: false,
    hydratedAtCols: null,
    rehydrateDimsTimer: null,
    hasFittedOnce: false,
    hydrationStarted: false,
    hydrationCompleted: false,
    hydrationGeneration: 0,
    hasAppliedTerminalContent: false,
    displayedLiveDataBeforeHydration: false,
    pendingHydrationChunks: [],
    pendingHydrationBytes: 0,
    frameWriteChunks: [],
    frameWriteBytes: 0,
    inputWriteChunks: [],
    inputWriteBytes: 0,
    inputFlushTimer: null,
    pasteWriteInFlight: false,
    deferredInputDuringPasteWrite: [],
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
    macShiftSelectionCleanup: null,
    pendingWebGLRestore: false,
    invalidFitRetryTimer: null,
    fitWarningLogged: false,
    replayMode: false,
    replayLoadedBytes: null
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
      void writeTextPasteForTerminal(runtime, text);
      return;
    }
    // native-shortcut mode deliberately hands ^V to the CLI so it reads the
    // machine's own clipboard; only the attachment mode uploads bytes.
    const imageBlob = runtime.imagePasteMode === "runtime-attachment" && !runtime.disposed
      ? clipboardImageBlobFromEvent(ev.clipboardData)
      : null;
    if (imageBlob) {
      // A blob whose mime is not in the extension table (or that fails to read)
      // answers false, and dropping the paste there is silent — the user sees a
      // paste that did nothing at all. Fall through to the shortcut path, which
      // reads the clipboard itself and can still handle it.
      void pasteClipboardImageBlob(runtime, imageBlob).then((handled) => {
        if (handled || runtime.disposed) return;
        void pasteClipboardImageShortcut(runtime, runtime.imagePasteMode);
      });
      return;
    }
    void pasteClipboardImageShortcut(runtime, runtime.imagePasteMode);
  }, true);
  runtime.macShiftSelectionCleanup = installMacShiftSelectionBridge({
    host,
    isDisposed: () => runtime.disposed,
    isMouseTrackingActive: () => isTerminalMouseTrackingActive(runtime),
  });

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
      //
      // Never in the browser. A timer 120ms after keydown has lost the user
      // activation the Clipboard API requires, so Safari answers the read with
      // a "Paste" permission callout instead — and the fallback is not needed
      // there, because a real browser always fires the paste event this waits
      // for. It exists for Electron/xterm paths that sometimes do not.
      if (isWebClientMode()) return false;
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
            void writeTextPasteForTerminal(runtime, text);
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

/**
 * Restore the one-runtime-per-(session, pty) invariant after a cache-key move.
 *
 * The runtime key embeds the runtime pin and the project key, so either one
 * changing relocates a mounted session to a NEW key. The guaranteed case is a
 * cross-machine session whose pin resolves as `null` on first render and as a
 * real binding once the lane index loads. The mount effect's cleanup parks a
 * live runtime instead of disposing it (deliberate: switching tabs must not
 * discard in-memory TUI state), and `ensureRuntime` only reclaims a stale
 * runtime found at the SAME key — so the runtime left behind at the old key is
 * unreachable garbage that still holds its PTY data/exit subscriptions. That
 * keeps `hasRuntimeForSubscriptionKey` true forever, so the preload pinned pump
 * for that pin never stops, `pinnedPtyRuntimeCount` stays elevated (forcing
 * every local terminal off the fast subscription path), and a second xterm is
 * built for the same PTY.
 *
 * Disposing the old runtime rather than re-keying it in place is deliberate: it
 * hydrated through the old binding's transport, so its buffer can describe the
 * wrong machine entirely. A fresh runtime re-hydrates against the pin the
 * session actually lives on. Fixing this here rather than by dropping the pin
 * out of the key also keeps the reuse check below authoritative — the key stays
 * the identity, and every key component (pin, project) is swept the same way.
 *
 * Runtimes another mounted view still references (`refs > 0`) are left alone:
 * they are not garbage, and that view's own key change sweeps them once it
 * drops the last ref.
 */
function teardownRelocatedRuntimes(key: string, sessionId: string, ptyId: string): void {
  for (const runtime of runtimeCache.values()) {
    if (runtime.key === key || runtime.disposed) continue;
    if (runtime.sessionId !== sessionId || runtime.ptyId !== ptyId) continue;
    if (runtime.refs > 0) continue;
    // teardownRuntime handles a parked host (it removes the host from the
    // parking root) and clears any pending dispose timer.
    teardownRuntime(runtime);
  }
}

function ensureRuntime(args: {
  ptyId: string;
  sessionId: string;
  runtimePin: OpenProjectBinding | null;
  projectKey: string | null;
  projectRoot: string | null;
  projectRevision: number;
  theme: XtermTheme;
  preferences: TerminalRenderPreferences;
  imagePasteMode: TerminalImagePasteMode;
}): CachedRuntime {
  const key = terminalRuntimeKey(args);
  // Only walks the handful of cached runtimes, and only from the mount effect
  // (not per render). Runs on the reuse path too so a runtime stranded while a
  // second view still held it gets swept once that view lets go.
  teardownRelocatedRuntimes(key, args.sessionId, args.ptyId);
  const existing = runtimeCache.get(key);
  if (existing && !existing.disposed) {
    if (
      existing.ptyId === args.ptyId
      && existing.runtimePin?.kind === args.runtimePin?.kind
      && existing.runtimePin?.key === args.runtimePin?.key
      && existing.projectKey === args.projectKey
      && existing.projectRoot === args.projectRoot
    ) {
      clearDisposeTimer(existing);
      // Refresh same-session binding metadata without moving the pin outside
      // the runtime record; callers may rebuild an equivalent binding object.
      existing.runtimePin = args.runtimePin;
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
  pinnedPtyRuntimeCount = 0;
  ptyDataSubscriptionSignature = null;
  pinnedPtyDataSubscriptionSignatures.clear();
}

export function TerminalView({
  ptyId,
  sessionId,
  runtimePin,
  className,
  isActive,
  isVisible = isActive,
  imagePasteMode = "native-shortcut",
}: {
  ptyId: string;
  sessionId: string;
  runtimePin?: OpenProjectBinding | null;
  className?: string;
  isActive: boolean;
  isVisible?: boolean;
  imagePasteMode?: TerminalImagePasteMode;
}) {
  const appTheme = useAppStore((s) => s.theme);
  const terminalPreferences = useAppStore((s) => s.terminalPreferences);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const projectKey = useAppStore(selectActiveProjectStateKey);
  const projectRevision = useAppStore((s) => s.projectRevision);
  const runtimePinIdentity = runtimePin
    ? runtimePinSubscriptionKey(runtimePin)
    : null;
  const runtimeProjectScopeRef = useRef<{
    sessionId: string;
    runtimePinIdentity: string | null;
    runtimePin: OpenProjectBinding | null;
    projectKey: string | null;
    projectRoot: string | null;
    projectRevision: number;
  } | null>(null);
  if (
    !runtimeProjectScopeRef.current
    || runtimeProjectScopeRef.current.sessionId !== sessionId
    || runtimeProjectScopeRef.current.runtimePinIdentity !== runtimePinIdentity
    || (runtimeProjectScopeRef.current.projectKey == null && projectKey != null)
  ) {
    runtimeProjectScopeRef.current = {
      sessionId,
      runtimePinIdentity,
      runtimePin: runtimePin ?? null,
      projectKey: runtimePin?.key ?? projectKey,
      projectRoot: runtimePin?.rootPath ?? projectRoot,
      projectRevision,
    };
  }
  const runtimeRuntimePin = runtimeProjectScopeRef.current.runtimePin;
  const runtimeProjectKey = runtimeProjectScopeRef.current.projectKey;
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
    disposeTerminalRuntimesForProjectChange(projectKey, projectRevision);
  }, [projectKey, projectRevision]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    installPtySizeOwnershipTracking();

    const mountConfig = mountConfigRef.current;
    const runtime = ensureRuntime({
      ptyId,
      sessionId,
      runtimePin: runtimeRuntimePin,
      projectKey: runtimeProjectKey,
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
    setRuntimeHostHidden(runtime, !mountConfig.isVisible);

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
    if (runtime.hydrationCompleted) consumePendingTerminalOffsetAnchor(runtime);

    const obs = new ResizeObserver(() => {
      clearTextureAtlas(runtime);
      schedule();
    });
    obs.observe(el);

    // Wheel routing, matching what every real terminal emulator does
    // (iTerm2, kitty, VS Code's terminal):
    //
    //   mouse tracking ON,  no Shift -> the APP gets the wheel as mouse reports
    //   mouse tracking ON,  Shift    -> local scrollback, reporting bypassed
    //   mouse tracking OFF           -> local scrollback (ordinary shells)
    //
    // The old rule preferred local scrollback whenever ANY scrollback existed,
    // which is wrong the moment a full-screen TUI is running: the TUI scrolls
    // its own pane and the emulator must stay out of the way. It also decayed
    // badly in practice — every stray line of accrued scrollback made the
    // hijack permanent, so the wheel stopped reaching the TUI while the
    // keyboard (fn+PageUp/Down, which xterm routes to the app) kept working.
    // That split between wheel and keys is the tell that this was a routing
    // policy bug, not a scroll bug.
    const scrollLocally = (ev: WheelEvent): void => {
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
    const onWheel = (ev: WheelEvent) => {
      if (runtime.disposed) return;
      if (!(ev.target instanceof Node)) return;
      if (!runtime.term.element || !runtime.term.element.contains(ev.target)) return;
      const viewport = runtime.term.element.querySelector<HTMLElement>(".xterm-viewport");
      if (!viewport) return;

      if (isTerminalMouseTrackingActive(runtime)) {
        // Returning is the forwarding path: xterm's own mouse binding turns the
        // wheel into a report for the application. Intercepting it here is
        // exactly what stopped the TUI from ever seeing a scroll.
        if (!ev.shiftKey) return;
        scrollLocally(ev);
        return;
      }

      const viewportScrollable = viewport.scrollHeight > viewport.clientHeight + 1;
      const hasScrollback = runtime.term.buffer.active.baseY > 0;
      if (!hasScrollback || viewportScrollable) return;
      scrollLocally(ev);
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });

    // See `syncScrollOnUserInput`. Motion re-evaluates the suppression (the user
    // may have scrolled back since the last move); leaving the pane or pressing
    // a key hands the snap straight back to the keyboard.
    const onPointerMove = () => {
      if (runtime.disposed) return;
      syncScrollOnUserInput(runtime, { pointerOver: true });
    };
    const onPointerLeave = () => {
      if (runtime.disposed) return;
      syncScrollOnUserInput(runtime, { pointerOver: false });
    };
    el.addEventListener("mousemove", onPointerMove, { passive: true, capture: true });
    el.addEventListener("mouseleave", onPointerLeave, { passive: true, capture: true });
    el.addEventListener("keydown", onPointerLeave, { capture: true });

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
          if (runtime.disposed) return;
          // Re-measure BEFORE refitting. A bare refit here divides the element
          // by the cell width measured against the fallback face and lands on
          // the same wrong column count — see `remeasureTerminalFont`.
          remeasureTerminalFont(runtime);
          clearTextureAtlas(runtime);
          // Force the PTY resize even if cols/rows happen to come out equal:
          // the host may already hold the fallback-derived size from the first
          // fit, and doFit only pushes a resize when the dims changed.
          requestAnimationFrame(() => {
            if (runtime.disposed) return;
            doFit(runtime, true);
            applyPendingReplaceWhenFitted(runtime);
          });
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
      el.removeEventListener("mousemove", onPointerMove, { capture: true });
      el.removeEventListener("mouseleave", onPointerLeave, { capture: true });
      el.removeEventListener("keydown", onPointerLeave, { capture: true });

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
  }, [imagePasteMode, runtimePinIdentity, runtimeProjectRevision, runtimeProjectRoot, ptyId, sessionId]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.disposed || !runtime.hydrationCompleted) return;
    consumePendingTerminalOffsetAnchor(runtime);
  });

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.disposed) return;

    const wrapper = wrapperRef.current;
    setRuntimeInteractionState(runtime, isActive);
    setRuntimeVisibilityState(runtime, isVisible);
    // Host hidden state follows visibility, not active ownership, so a visible
    // inactive grid tile stays interactive/clickable and AT-readable.
    setRuntimeHostHidden(runtime, !isVisible);

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
