/**
 * The built-in browser's per-tab capability surface, one module out of
 * `builtInBrowserService`.
 *
 * Device emulation, zoom, find-in-page, DevTools, the full network log and its
 * HAR export, the extra page actions (hover / drag / select / upload), the live
 * preview stream, and screen recording. What they have in common is the reason
 * they are here: none of them touch the service's window/tab/collection
 * machinery. They reach it only through the narrow {@link
 * BuiltInBrowserTabCapabilityDeps} seam — resolve a tab, run it under a trace
 * entry, hold the debugger, emit — which is the same shape
 * `appControlAgentActions.ts` uses next door for the same reason.
 *
 * This is pure code motion. Every function below ran inside
 * `createBuiltInBrowserWindowService`'s closure and behaves identically; the
 * only change is that its five or six free variables are now named parameters
 * instead of ambient ones. `builtInBrowserTabCapabilities.test.ts` — which was
 * written for this module before it existed — is its coverage.
 *
 * @module builtInBrowser/builtInBrowserTabCapabilities
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import electronModule, { app, session, type BrowserWindow, type WebContents } from "electron";

import type {
  BuiltInBrowserAgentActionArgs,
  BuiltInBrowserAgentActionResult,
  BuiltInBrowserClickArgs,
  BuiltInBrowserDevToolsMode,
  BuiltInBrowserDevToolsResult,
  BuiltInBrowserDragArgs,
  BuiltInBrowserElementSnapshot,
  BuiltInBrowserEmulationResult,
  BuiltInBrowserEmulationState,
  BuiltInBrowserEventPayload,
  BuiltInBrowserExportHarArgs,
  BuiltInBrowserExportHarResult,
  BuiltInBrowserFindInPageArgs,
  BuiltInBrowserFindInPageResult,
  BuiltInBrowserHoverArgs,
  BuiltInBrowserNetworkLogArgs,
  BuiltInBrowserNetworkLogEntry,
  BuiltInBrowserNetworkLogResult,
  BuiltInBrowserNetworkLoggingResult,
  BuiltInBrowserPreviewStreamResult,
  BuiltInBrowserRecordingEndedBy,
  BuiltInBrowserSelectOptionArgs,
  BuiltInBrowserSetDevToolsArgs,
  BuiltInBrowserSetEmulationArgs,
  BuiltInBrowserSetNetworkLoggingArgs,
  BuiltInBrowserSetZoomArgs,
  BuiltInBrowserStartPreviewStreamArgs,
  BuiltInBrowserStartRecordingArgs,
  BuiltInBrowserStartRecordingResult,
  BuiltInBrowserStatus,
  BuiltInBrowserStopFindInPageArgs,
  BuiltInBrowserStopFindInPageResult,
  BuiltInBrowserStopPreviewStreamArgs,
  BuiltInBrowserStopRecordingArgs,
  BuiltInBrowserStopRecordingResult,
  BuiltInBrowserTabTargetArgs,
  BuiltInBrowserUploadFileArgs,
  BuiltInBrowserZoomResult,
} from "../../../shared/types";
import { BUILT_IN_BROWSER_PREVIEW_JPEG_QUALITY } from "../../../shared/types";
import {
  agentHasElementTarget as hasElementTarget,
  isRecord,
  optionalFiniteNumber,
  stringOrNull,
} from "../../../shared/agentObservationNormalizers";
import { sanitizeObservationPathSegment } from "../../../shared/agentObservation";
import type { Logger } from "../logging/logger";
import {
  emptyToNull,
  errorMessage,
  normalizeDimension,
} from "./builtInBrowserConstants";
import {
  BUILT_IN_BROWSER_DEFAULT_ZOOM_FACTOR,
  BUILT_IN_BROWSER_MAX_RECORDING_MS,
  buildBuiltInBrowserHar,
  builtInBrowserUploadRoots,
  clampBuiltInBrowserEmulationViewScale,
  clampBuiltInBrowserZoomFactor,
  filterBuiltInBrowserNetworkLog,
  normalizeBuiltInBrowserHeaders,
  normalizeBuiltInBrowserRecordingFps,
  normalizeNetworkLogLimit,
  redactBuiltInBrowserUrl,
  resolveBuiltInBrowserUploadPaths,
} from "./builtInBrowserCapabilities";
import {
  BUILT_IN_BROWSER_EMULATION_PRESETS,
  builtInBrowserEmulationMetrics,
  builtInBrowserEmulationUserAgentMetadata,
  resolveBuiltInBrowserEmulation,
} from "../../../shared/builtInBrowserEmulation";
import { awaitFoundInPage } from "./builtInBrowserFind";
import { createBuiltInBrowserPreviewStreams } from "./builtInBrowserPreviewStream";
import {
  createBuiltInBrowserRecordingSession,
  createDisplayMediaRecorderFactory,
  type BuiltInBrowserRecorderFactory,
  type BuiltInBrowserRecordingSession,
  type CaptureWindowLike,
} from "./builtInBrowserRecording";
import type {
  BrowserDebuggerHoldOwner,
  BrowserTabState,
  BuiltInBrowserElementTargetInput,
} from "./builtInBrowserService";
import { evaluateInTab } from "./builtInBrowserCdp";

const DEFAULT_FIND_IN_PAGE_TIMEOUT_MS = 5_000;
const MAX_FIND_IN_PAGE_TIMEOUT_MS = 30_000;
const MAX_DRAG_STEPS = 50;
const DEFAULT_DRAG_STEPS = 8;
const MAX_UPLOAD_FILE_COUNT = 20;
const RECORDING_CACHE_DIR = "recordings";
const BROWSER_RECORDER_PARTITION = "ade-browser-recorder";
const DISPLAY_MEDIA_ARM_TTL_MS = 10_000;

/**
 * The tab's current document title, or `null` once its WebContents is gone.
 *
 * Exported because the two emitters of an automatically-ended `recording` event
 * live on opposite sides of the service/capability seam — the max-duration
 * timer here and `startHandoff` in `builtInBrowserService.ts` — and they are one
 * contract: an automatic ending names the tab it ended, because the person who
 * gets the toast is not the one who started it.
 */
export function builtInBrowserTabTitle(tab: BrowserTabState): string | null {
  return tab.webContents.isDestroyed() ? null : emptyToNull(tab.webContents.getTitle());
}

// Resolved lazily (and defensively) rather than as a named import: unit-test
// `electron` mocks omit BrowserWindow, and only the recording path needs it.
function electronBrowserWindowCtor(): (new (options: Record<string, unknown>) => unknown) | null {
  try {
    return (electronModule as unknown as {
      BrowserWindow?: new (options: Record<string, unknown>) => unknown;
    }).BrowserWindow ?? null;
  } catch {
    return null;
  }
}


type CdpRuntimeEvaluateObjectResponse = {
  result?: {
    objectId?: string;
  };
  exceptionDetails?: unknown;
};

/**
 * Resolves the element the page actually has focused, descending through open
 * shadow roots and same-origin iframes so `focusElementTarget` results inside
 * a frame or web component still resolve to the real control.
 */
const DEEP_ACTIVE_ELEMENT_FUNCTION = String.raw`
function deepActiveElement() {
  let element = document.activeElement;
  for (let depth = 0; depth < 20 && element; depth += 1) {
    if (element.shadowRoot && element.shadowRoot.activeElement) {
      element = element.shadowRoot.activeElement;
      continue;
    }
    if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
      let inner = null;
      try {
        inner = element.contentDocument ? element.contentDocument.activeElement : null;
      } catch (error) {
        inner = null;
      }
      if (!inner || inner === element) break;
      element = inner;
      continue;
    }
    break;
  }
  return element;
}
`;

const SELECT_OPTION_FUNCTION = String.raw`
function selectBrowserOption(element, payload) {
  if (!element) return { error: "No focused browser element to select an option on." };
  if (element.tagName !== "SELECT") {
    return { error: "Browser selectOption target is not a <select> element." };
  }
  if (element.disabled) return { error: "Matching browser element is disabled." };
  const options = Array.prototype.slice.call(element.options || []);
  let match = null;
  if (payload.value != null) {
    match = options.find(function (option) { return option.value === payload.value; }) || null;
  }
  if (!match && payload.label != null) {
    const wanted = String(payload.label).trim().toLowerCase();
    match = options.find(function (option) {
      return (option.label || option.textContent || "").trim().toLowerCase() === wanted;
    }) || null;
  }
  if (!match && payload.index != null) {
    match = options[payload.index] || null;
  }
  if (!match) return { error: "No matching <option> was found for the requested value/label/index." };
  if (match.disabled) return { error: "Matching <option> is disabled." };
  element.value = match.value;
  match.selected = true;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    ok: true,
    value: match.value,
    label: (match.label || match.textContent || "").trim(),
    index: match.index,
  };
}
`;

/**
 * Everything the capability surface needs from the window service, and nothing
 * else. Deliberately narrow and deliberately explicit: a new capability that
 * needs a sixth kind of access has to add it here, where the coupling is
 * reviewable, rather than reaching into an ambient closure.
 */
export type BuiltInBrowserTabCapabilityDeps = {
  logger: () => Logger | null;
  emit: (payload: BuiltInBrowserEventPayload) => void;
  emitStatus: () => void;
  /**
   * The collection's status, scoped to what this caller is allowed to see.
   *
   * One member rather than the `getStatus` / `scopeStatusForInput` pair every
   * call site used to compose by hand: the pairing is the operation, and a
   * caller that got it wrong (returning an unscoped status to an agent) would
   * still type-check. NOT the service's `getStatusForInput`, which additionally
   * calls `prepareAgentReadTab` — no capability here does that.
   */
  statusForInput: (input: unknown) => BuiltInBrowserStatus;
  /** The tab this window is showing, for capabilities that default to it. */
  getActiveTabId: () => string | null;
  /** The window the pane lives in, or `null` before it is attached. */
  getWindow: () => BrowserWindow | null;
  /** How far the pane had to shrink an emulated device to fit. */
  getEmulationViewScale: () => number;
  /** The project this collection belongs to; an upload root. */
  getCollectionProjectRoot: () => string | null;
  /**
   * A tab gained or lost its last preview subscriber.
   *
   * The service decides what that means for the view — a watched tab has to stay
   * attached to the window to keep a compositor surface — so it re-runs its own
   * attach pass rather than this module reaching into the view.
   */
  onPreviewWatchersChanged?: (tabId: string) => void;
  tabById: (tabId: string | null | undefined) => BrowserTabState | null;
  targetTabFromInput: (
    input: BuiltInBrowserTabTargetArgs | undefined,
    emptyMessage: string,
  ) => BrowserTabState;
  prepareTabCapability: (
    input: BuiltInBrowserTabTargetArgs,
    options: { emptyMessage: string; consentReason: string },
  ) => Promise<BrowserTabState>;
  runTracedTabCapability: <T>(
    tab: BrowserTabState,
    action: string,
    input: BuiltInBrowserTabTargetArgs,
    fn: () => Promise<T>,
  ) => Promise<T>;
  runTracedAgentAction: (
    tab: BrowserTabState,
    action: string,
    input: BuiltInBrowserAgentActionArgs,
    fn: () => Promise<BuiltInBrowserAgentActionResult>,
  ) => Promise<BuiltInBrowserAgentActionResult>;
  actionResult: (
    tab: BrowserTabState,
    input: BuiltInBrowserAgentActionArgs,
  ) => Promise<BuiltInBrowserAgentActionResult>;
  acquireDebuggerHold: (tab: BrowserTabState, owner: BrowserDebuggerHoldOwner) => Promise<void>;
  releaseDebuggerHold: (tab: BrowserTabState, owner: BrowserDebuggerHoldOwner) => void;
  sendDebuggerCommand: <T = unknown>(
    wc: WebContents,
    command: string,
    params?: Record<string, unknown>,
  ) => Promise<T>;
  withTemporaryDebugger: <T>(wc: WebContents, fn: () => Promise<T>) => Promise<T>;
  resolveClickTarget: (
    tab: BrowserTabState,
    input: BuiltInBrowserClickArgs,
  ) => Promise<{ x: number; y: number; element: BuiltInBrowserElementSnapshot | null }>;
  focusElementTarget: (
    tab: BrowserTabState,
    input: BuiltInBrowserElementTargetInput,
    options?: { select?: boolean; clear?: boolean },
  ) => Promise<BuiltInBrowserElementSnapshot>;
  observationDirectory: (tab: BrowserTabState) => string;
  observationRootPath: string | null;
  observationRelativeBasePath: string | null;
  traceAutoEndedRecording: (
    tab: BrowserTabState,
    endedBy: BuiltInBrowserRecordingEndedBy,
    extra?: { durationMs?: number | null; frameCount?: number | null },
  ) => void;
  /** Injected for tests; production builds an off-screen capture window. */
  createRecordingWindow: (() => CaptureWindowLike | null) | null;
  /** Injected for tests; production records through `getDisplayMedia`. */
  createTabRecorder: BuiltInBrowserRecorderFactory | null;
};

export type BuiltInBrowserTabCapabilities = ReturnType<typeof createBuiltInBrowserTabCapabilities>;

export function createBuiltInBrowserTabCapabilities(deps: BuiltInBrowserTabCapabilityDeps) {
  const {
    acquireDebuggerHold,
    actionResult,
    emit,
    emitStatus,
    focusElementTarget,
    logger,
    observationDirectory,
    observationRelativeBasePath,
    observationRootPath,
    prepareTabCapability,
    releaseDebuggerHold,
    resolveClickTarget,
    runTracedAgentAction,
    runTracedTabCapability,
    sendDebuggerCommand,
    statusForInput,
    tabById,
    targetTabFromInput,
    traceAutoEndedRecording,
    withTemporaryDebugger,
  } = deps;
  // Read through the deps rather than destructured: these change over the
  // window service's life (the window is attached later, the active tab and the
  // emulation fit factor change on every switch and every pane drag).
  /**
   * Recording plumbing, owned here because `armDisplayMediaCapture` below is the
   * only reader and the only writer. It used to be allocated by the window
   * service and handed back through the deps bag, which read as if the service
   * had its own `setDisplayMediaRequestHandler` wiring to keep in step — it does
   * not; the handler is installed in this module.
   */
  const armedDisplayMediaFrames = new Map<number, { target: WebContents; expiresAt: number }>();
  const configuredDisplayMediaSessions = new WeakSet<Electron.Session>();

  const win = (): BrowserWindow | null => deps.getWindow();
  const activeTabId = (): string | null => deps.getActiveTabId();
  const emulationViewScale = (): number => deps.getEmulationViewScale();

  /* ── Device emulation ──────────────────────────────────────────────────── */

  /**
   * Sends the CDP commands that make a device preset visible.
   *
   * `setDeviceMetricsOverride` alone is not enough: without `screenWidth` /
   * `screenHeight` the page still reads the host window's `screen.*`, and
   * without touch emulation and the mobile user-agent metadata a responsive
   * site keeps serving its desktop breakpoint. All five commands together are
   * what "iPhone 17" means.
   */
  const sendEmulationCommands = async (
    wc: WebContents,
    next: BuiltInBrowserEmulationState | null,
  ): Promise<void> => {
    const hasTouch = next?.hasTouch ?? false;
    await sendDebuggerCommand(wc, "Emulation.setTouchEmulationEnabled", {
      enabled: hasTouch,
      maxTouchPoints: hasTouch ? 5 : 1,
    }).catch(() => {});
    // Without this a trackpad click never produces a touch event, so mobile
    // sites that only bind touch handlers look dead under the preset.
    await sendDebuggerCommand(wc, "Emulation.setEmitTouchEventsForMouse", {
      enabled: hasTouch,
      configuration: next?.mobile ? "mobile" : "desktop",
    }).catch(() => {});
    if (!next) {
      await sendDebuggerCommand(wc, "Emulation.clearDeviceMetricsOverride");
      // CDP has no "clear UA override"; an empty string is Chromium's reset.
      await sendDebuggerCommand(wc, "Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
      return;
    }
    const metrics = builtInBrowserEmulationMetrics(next);
    await sendDebuggerCommand(wc, "Emulation.setDeviceMetricsOverride", {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: metrics.deviceScaleFactor,
      mobile: metrics.mobile,
      // Without `scale`, a device wider than the pane lays out at its own
      // width and is CROPPED by the narrower native view. With it the page
      // still reports the device's width and Chromium draws it smaller, which
      // is what the pane's letterbox already assumed.
      scale: clampBuiltInBrowserEmulationViewScale(emulationViewScale()),
      screenWidth: metrics.width,
      screenHeight: metrics.height,
      positionX: 0,
      positionY: 0,
      screenOrientation: metrics.width > metrics.height
        ? { type: "landscapePrimary", angle: 90 }
        : { type: "portraitPrimary", angle: 0 },
    });
    if (next.userAgent) {
      const userAgentMetadata = builtInBrowserEmulationUserAgentMetadata(next);
      await sendDebuggerCommand(wc, "Emulation.setUserAgentOverride", {
        userAgent: next.userAgent,
        ...(userAgentMetadata ? { userAgentMetadata } : {}),
      }).catch(() => {});
    }
  };

  /**
   * Re-applies the tab's override after a navigation.
   *
   * The debugger hold normally keeps Chromium's override alive across
   * navigations, but a cross-process swap can still drop it; re-sending is
   * idempotent and costs one CDP round trip on a tab that is already emulating.
   */
  const reapplyTabEmulation = (tab: BrowserTabState): void => {
    if (!tab.emulation) return;
    const wc = tab.webContents;
    if (wc.isDestroyed() || !wc.debugger.isAttached()) return;
    void sendEmulationCommands(wc, tab.emulation).catch((error) => {
      logger()?.debug("built_in_browser.emulation_reapply_failed", {
        tabId: tab.id,
        err: errorMessage(error),
      });
    });
  };

  async function setEmulation(
    input: BuiltInBrowserSetEmulationArgs,
  ): Promise<BuiltInBrowserEmulationResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before setting device emulation.",
      consentReason: "The agent requested device emulation for this browser tab.",
    });
    const next = resolveBuiltInBrowserEmulation(input);
    const wc = tab.webContents;
    await runTracedTabCapability(tab, "setEmulation", input, async () => {
      if (next) {
        // Chromium reverts every Emulation.* override when the CDP session that
        // set it detaches, so an override has to own a debugger hold for as long
        // as it is in force. This is the whole reason presets used to relabel
        // the toolbar without ever re-laying-out the page.
        await acquireDebuggerHold(tab, "emulation");
        try {
          await sendEmulationCommands(wc, next);
        } catch (error) {
          releaseDebuggerHold(tab, "emulation");
          throw error;
        }
      } else if (tab.debuggerHolds.has("emulation")) {
        try {
          await sendEmulationCommands(wc, null);
        } finally {
          releaseDebuggerHold(tab, "emulation");
        }
      } else {
        await withTemporaryDebugger(wc, () => sendEmulationCommands(wc, null));
      }
      tab.emulation = next;
    });
    emitStatus();
    return {
      tabId: tab.id,
      emulation: next,
      presets: [...BUILT_IN_BROWSER_EMULATION_PRESETS],
      status: statusForInput(input),
    };
  }

  /* ── Zoom ──────────────────────────────────────────────────────────────── */

  async function setZoom(input: BuiltInBrowserSetZoomArgs): Promise<BuiltInBrowserZoomResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before zooming.",
      consentReason: "The agent requested a zoom change for this browser tab.",
    });
    const factor = input.reset === true
      ? BUILT_IN_BROWSER_DEFAULT_ZOOM_FACTOR
      : clampBuiltInBrowserZoomFactor(input.factor);
    await runTracedTabCapability(tab, "setZoom", input, async () => {
      applyTabZoom(tab, factor);
      tab.zoomFactor = factor;
    });
    emitStatus();
    return {
      tabId: tab.id,
      zoomFactor: factor,
      status: statusForInput(input),
    };
  }

  const applyTabZoom = (tab: BrowserTabState, factor: number): void => {
    const wc = tab.webContents;
    if (wc.isDestroyed()) return;
    try {
      wc.setZoomFactor(factor);
    } catch (error) {
      logger()?.debug("built_in_browser.set_zoom_failed", {
        tabId: tab.id,
        err: errorMessage(error),
      });
    }
  };

  /* ── Find in page ──────────────────────────────────────────────────────── */

  async function findInPage(
    input: BuiltInBrowserFindInPageArgs,
  ): Promise<BuiltInBrowserFindInPageResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before searching it.",
      consentReason: "The agent requested an in-page text search.",
    });
    const text = stringOrNull(input.text);
    if (!text) throw new Error("Find text is required.");
    const wc = tab.webContents;
    const timeoutMs = Math.min(
      MAX_FIND_IN_PAGE_TIMEOUT_MS,
      Math.max(250, optionalFiniteNumber(input.timeoutMs) ?? DEFAULT_FIND_IN_PAGE_TIMEOUT_MS),
    );
    return runTracedTabCapability(tab, "findInPage", input, async () => {
      const result = await awaitFoundInPage(wc, tab.findWaiters, {
        text,
        forward: input.forward !== false,
        matchCase: input.matchCase === true,
        findNext: input.findNext === true,
        timeoutMs,
      });
      tab.findRequestId = result.requestId;
      return {
        tabId: tab.id,
        text,
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal ?? null,
        matches: result.matches ?? null,
        finalUpdate: Boolean(result.finalUpdate),
        status: statusForInput(input),
      };
    });
  }

  async function stopFindInPage(
    input: BuiltInBrowserStopFindInPageArgs = {},
  ): Promise<BuiltInBrowserStopFindInPageResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before stopping a find.",
      consentReason: "The agent requested to stop an in-page text search.",
    });
    const action = input.action === "keepSelection" || input.action === "activateSelection"
      ? input.action
      : "clearSelection";
    await runTracedTabCapability(tab, "stopFindInPage", input, async () => {
      try {
        tab.webContents.stopFindInPage(action);
      } catch (error) {
        logger()?.debug("built_in_browser.stop_find_failed", { err: errorMessage(error) });
      }
      tab.findRequestId = null;
    });
    return {
      tabId: tab.id,
      stopped: true,
      status: statusForInput(input),
    };
  }

  /* ── DevTools ──────────────────────────────────────────────────────────── */

  async function setDevTools(
    input: BuiltInBrowserSetDevToolsArgs,
  ): Promise<BuiltInBrowserDevToolsResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before toggling DevTools.",
      consentReason: "The agent requested DevTools for this browser tab.",
    });
    const wc = tab.webContents;
    const mode: BuiltInBrowserDevToolsMode = input.mode === "bottom" || input.mode === "detach"
      ? input.mode
      : "right";
    await runTracedTabCapability(tab, "setDevTools", input, async () => {
      if (input.open) {
        // DevTools and the CDP debugger cannot own the same target, so opening
        // DevTools would silently kill an in-flight network log. Recording is
        // unaffected: it captures through getDisplayMedia, not the debugger.
        if (tab.debuggerHolds.size > 0) {
          const owner = tab.debuggerHolds.has("network") ? "network" : "emulation";
          const fix = owner === "network"
            ? "Run `setNetworkLogging { enabled: false }` before opening DevTools."
            : "Run `setEmulation { preset: \"off\" }` before opening DevTools.";
          throw new Error(
            `Browser tab ${tab.id} is ${owner === "network" ? "network logging" : "emulating a device"}, which owns the debugger. ${fix}`,
          );
        }
        wc.openDevTools({ mode });
        tab.devToolsMode = mode;
      } else {
        wc.closeDevTools();
        tab.devToolsMode = null;
      }
    });
    // DevTools is a human affordance; leave a breadcrumb whenever it is driven
    // from an agent-bound call so the audit trail shows who opened it.
    logger()?.info("built_in_browser.devtools_toggled", {
      tabId: tab.id,
      open: Boolean(input.open),
      mode: input.open ? mode : null,
      laneId: stringOrNull((input as { laneId?: string | null }).laneId),
      chatSessionId: stringOrNull((input as { chatSessionId?: string | null }).chatSessionId),
    });
    emitStatus();
    return {
      tabId: tab.id,
      devToolsOpen: tab.devToolsMode !== null,
      mode: tab.devToolsMode,
      status: statusForInput(input),
    };
  }

  /* ── Full network log ──────────────────────────────────────────────────── */

  // CDP `Network.*` is used rather than Electron's `webRequest` API because it
  // is the only source that carries request/response headers, protocol,
  // per-phase timings, mime type, cache hits and encoded sizes — everything HAR
  // 1.2 needs. `webRequest` is also session-global (it already backs the
  // always-on failure list), so building the opt-in per-tab log on top of it
  // would mean filtering a shared firehose and still missing headers/timings.
  const handleNetworkCdpEvent = (
    tab: BrowserTabState,
    method: string,
    params: unknown,
  ): void => {
    if (!tab.networkLoggingEnabled || !isRecord(params)) return;
    const requestId = stringOrNull(params.requestId);
    if (!requestId) return;
    const nowMs = Date.now();
    if (method === "Network.requestWillBeSent") {
      const request = isRecord(params.request) ? params.request : {};
      const entry: BuiltInBrowserNetworkLogEntry = {
        id: requestId,
        method: stringOrNull(request.method),
        // Redacted at the point of capture, not at read time: the log is read
        // back through `getNetworkLog`, `exportHar`, and any observation the
        // proof drawer promotes, and a miss on one of those leaks the token.
        url: redactBuiltInBrowserUrl(stringOrNull(request.url) ?? "about:blank"),
        status: null,
        statusText: null,
        mimeType: null,
        resourceType: stringOrNull(params.type),
        protocol: null,
        fromCache: false,
        requestHeaders: normalizeBuiltInBrowserHeaders(request.headers),
        responseHeaders: [],
        requestBodySize: typeof request.postData === "string" ? request.postData.length : null,
        responseBodySize: null,
        responseHeaderSize: null,
        timings: {
          startedAt: new Date(nowMs).toISOString(),
          endedAt: null,
          durationMs: null,
          waitMs: null,
          receiveMs: null,
        },
        error: null,
      };
      tab.networkLogPending.set(requestId, entry);
      tab.networkLog.upsert(entry);
      return;
    }
    const existing = tab.networkLogPending.get(requestId) ?? tab.networkLog.find(requestId);
    if (!existing) return;
    if (method === "Network.responseReceived") {
      const response = isRecord(params.response) ? params.response : {};
      const startedAtMs = Date.parse(existing.timings.startedAt);
      const next: BuiltInBrowserNetworkLogEntry = {
        ...existing,
        status: optionalFiniteNumber(response.status),
        statusText: stringOrNull(response.statusText),
        mimeType: stringOrNull(response.mimeType),
        protocol: stringOrNull(response.protocol),
        fromCache: response.fromDiskCache === true || response.fromPrefetchCache === true,
        responseHeaders: normalizeBuiltInBrowserHeaders(response.headers),
        responseHeaderSize: optionalFiniteNumber(response.encodedDataLength),
        resourceType: stringOrNull(params.type) ?? existing.resourceType,
        timings: {
          ...existing.timings,
          waitMs: Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : null,
        },
      };
      tab.networkLogPending.set(requestId, next);
      tab.networkLog.upsert(next);
      return;
    }
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const startedAtMs = Date.parse(existing.timings.startedAt);
      const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : null;
      const waitMs = existing.timings.waitMs;
      const next: BuiltInBrowserNetworkLogEntry = {
        ...existing,
        responseBodySize: method === "Network.loadingFinished"
          ? optionalFiniteNumber(params.encodedDataLength) ?? existing.responseBodySize
          : existing.responseBodySize,
        error: method === "Network.loadingFailed"
          ? stringOrNull(params.errorText) ?? "request failed"
          : existing.error,
        timings: {
          ...existing.timings,
          endedAt: new Date(nowMs).toISOString(),
          durationMs,
          receiveMs: durationMs != null && waitMs != null ? Math.max(0, durationMs - waitMs) : null,
        },
      };
      tab.networkLogPending.delete(requestId);
      tab.networkLog.upsert(next);
    }
  };

  async function setNetworkLogging(
    input: BuiltInBrowserSetNetworkLoggingArgs,
  ): Promise<BuiltInBrowserNetworkLoggingResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before changing network logging.",
      consentReason: "The agent requested network logging for this browser tab.",
    });
    const wc = tab.webContents;
    await runTracedTabCapability(tab, "setNetworkLogging", input, async () => {
      if (input.enabled) {
        if (input.clear !== false) {
          tab.networkLog.clear();
          tab.networkLogPending.clear();
        }
        await acquireDebuggerHold(tab, "network");
        try {
          await sendDebuggerCommand(wc, "Network.enable", {
            maxTotalBufferSize: 1_000_000,
            maxResourceBufferSize: 500_000,
          });
        } catch (error) {
          releaseDebuggerHold(tab, "network");
          throw error;
        }
        tab.networkLoggingEnabled = true;
        return;
      }
      if (tab.networkLoggingEnabled) {
        await sendDebuggerCommand(wc, "Network.disable").catch((error) => {
          logger()?.debug("built_in_browser.network_disable_failed", { err: errorMessage(error) });
        });
      }
      tab.networkLoggingEnabled = false;
      tab.networkLogPending.clear();
      releaseDebuggerHold(tab, "network");
    });
    emitStatus();
    return {
      tabId: tab.id,
      enabled: tab.networkLoggingEnabled,
      entryCount: tab.networkLog.size,
      status: statusForInput(input),
    };
  }

  async function getNetworkLog(
    input: BuiltInBrowserNetworkLogArgs = {},
  ): Promise<BuiltInBrowserNetworkLogResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before reading its network log.",
      consentReason: "The agent requested the network log for this browser tab.",
    });
    const all = tab.networkLog.list();
    const matched = filterBuiltInBrowserNetworkLog(all, input);
    const limit = normalizeNetworkLogLimit(input.limit);
    return {
      tabId: tab.id,
      enabled: tab.networkLoggingEnabled,
      recordedCount: all.length,
      droppedCount: tab.networkLog.droppedCount,
      matchedCount: matched.length,
      entries: matched.slice(-limit),
    };
  }

  async function exportHar(
    input: BuiltInBrowserExportHarArgs = {},
  ): Promise<BuiltInBrowserExportHarResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before exporting a HAR.",
      consentReason: "The agent requested a HAR export for this browser tab.",
    });
    if (!observationRelativeBasePath) {
      throw new Error("Browser HAR export is unavailable because no scratch root is configured.");
    }
    const entries = filterBuiltInBrowserNetworkLog(tab.networkLog.list(), input);
    if (entries.length === 0 && !tab.networkLoggingEnabled) {
      throw new Error(
        `Browser tab ${tab.id} has no recorded requests. Run network logging first (\`setNetworkLogging { enabled: true }\`).`,
      );
    }
    const exportedAt = new Date().toISOString();
    const scratchRoot = observationRelativeBasePath;
    return runTracedTabCapability(tab, "exportHar", input, async () => {
      const har = buildBuiltInBrowserHar({
        entries,
        pageUrl: tab.webContents.isDestroyed() ? null : emptyToNull(tab.webContents.getURL()),
        pageTitle: tab.webContents.isDestroyed() ? null : emptyToNull(tab.webContents.getTitle()),
        creatorVersion: app.getVersion?.() ?? "0.0.0",
        exportedAt,
      });
      const dir = observationDirectory(tab);
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `network-${Date.now()}.har`);
      await fs.writeFile(filePath, `${JSON.stringify(har, null, 2)}\n`, "utf8");
      return {
        tabId: tab.id,
        filePath,
        relativePath: path.relative(scratchRoot, filePath),
        entryCount: entries.length,
        exportedAt,
      };
    });
  }

  /* ── Extra page actions ────────────────────────────────────────────────── */

  async function hover(input: BuiltInBrowserHoverArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before hovering.");
    return runTracedAgentAction(tab, "hover", input, async () => {
      const wc = tab.webContents;
      const { x, y } = await resolveClickTarget(tab, input as BuiltInBrowserClickArgs);
      await withTemporaryDebugger(wc, async () => {
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: "none",
        });
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function drag(input: BuiltInBrowserDragArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before dragging.");
    return runTracedAgentAction(tab, "drag", input, async () => {
      const wc = tab.webContents;
      const from = await resolveClickTarget(tab, input as BuiltInBrowserClickArgs);
      const to = await resolveDragDestination(tab, input);
      const steps = Math.min(
        MAX_DRAG_STEPS,
        Math.max(1, Math.floor(optionalFiniteNumber(input.steps) ?? DEFAULT_DRAG_STEPS)),
      );
      await withTemporaryDebugger(wc, async () => {
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: from.x,
          y: from.y,
          button: "none",
        });
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: from.x,
          y: from.y,
          button: "left",
          clickCount: 1,
        });
        for (let step = 1; step <= steps; step += 1) {
          const ratio = step / steps;
          await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: Math.round(from.x + (to.x - from.x) * ratio),
            y: Math.round(from.y + (to.y - from.y) * ratio),
            button: "left",
            buttons: 1,
          });
        }
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: to.x,
          y: to.y,
          button: "left",
          clickCount: 1,
        });
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  const resolveDragDestination = async (
    tab: BrowserTabState,
    input: BuiltInBrowserDragArgs,
  ): Promise<{ x: number; y: number }> => {
    const toX = optionalFiniteNumber(input.toX);
    const toY = optionalFiniteNumber(input.toY);
    if (toX != null || toY != null) {
      if (toX == null || toY == null) {
        throw new Error("Browser drag requires both --to-x and --to-y when using coordinates.");
      }
      return { x: normalizeDimension(toX), y: normalizeDimension(toY) };
    }
    const destinationTarget: BuiltInBrowserClickArgs = {
      ...input,
      x: null,
      y: null,
      selector: input.toSelector ?? null,
      text: input.toText ?? null,
      testId: input.toTestId ?? null,
      elementIndex: input.toElementIndex ?? null,
      handle: input.toHandle ?? null,
    };
    if (!hasElementTarget(destinationTarget)) {
      throw new Error(
        "Browser drag requires a destination: --to-x/--to-y, --to-selector, --to-text-match, --to-test-id, --to-element, or --to-handle.",
      );
    }
    const resolved = await resolveClickTarget(tab, destinationTarget);
    return { x: resolved.x, y: resolved.y };
  };

  async function selectOption(
    input: BuiltInBrowserSelectOptionArgs,
  ): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before selecting an option.");
    return runTracedAgentAction(tab, "selectOption", input, async () => {
      const value = typeof input.value === "string" ? input.value : null;
      const label = typeof input.label === "string" ? input.label : null;
      const index = optionalFiniteNumber(input.index);
      if (value == null && label == null && index == null) {
        throw new Error("Browser selectOption requires --value, --label, or --index.");
      }
      await focusElementTarget(tab, input, { select: false });
      const result = await evaluateFocusedElementScript(tab.webContents, SELECT_OPTION_FUNCTION, {
        value,
        label,
        index,
      });
      const record = isRecord(result) ? result : {};
      const error = stringOrNull(record.error);
      if (error) throw new Error(error);
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function uploadFile(
    input: BuiltInBrowserUploadFileArgs,
  ): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before uploading a file.");
    return runTracedAgentAction(tab, "uploadFile", input, async () => {
      const roots = builtInBrowserUploadRoots({
        projectRoot: deps.getCollectionProjectRoot(),
        observationRoot: observationRootPath,
        tmpDir: os.tmpdir(),
      });
      const paths = resolveBuiltInBrowserUploadPaths(input.paths as readonly unknown[], roots);
      if (paths.length > MAX_UPLOAD_FILE_COUNT) {
        throw new Error(`Browser upload accepts at most ${MAX_UPLOAD_FILE_COUNT} files.`);
      }
      for (const filePath of paths) {
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat?.isFile()) throw new Error(`Browser upload path is not a readable file: ${filePath}`);
      }
      await focusElementTarget(tab, input, { select: false });
      const wc = tab.webContents;
      await withTemporaryDebugger(wc, async () => {
        await sendDebuggerCommand(wc, "DOM.enable");
        await sendDebuggerCommand(wc, "Runtime.enable");
        const objectId = await focusedElementObjectId(wc);
        try {
          await sendDebuggerCommand(wc, "DOM.setFileInputFiles", { files: paths, objectId });
        } finally {
          await sendDebuggerCommand(wc, "Runtime.releaseObject", { objectId }).catch(() => {});
        }
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  const focusedElementObjectId = async (wc: WebContents): Promise<string> => {
    const response = await sendDebuggerCommand<CdpRuntimeEvaluateObjectResponse>(wc, "Runtime.evaluate", {
      expression: `(${DEEP_ACTIVE_ELEMENT_FUNCTION})()`,
      returnByValue: false,
      silent: true,
    });
    const objectId = response.result?.objectId;
    if (!objectId) throw new Error("Could not resolve the focused browser element.");
    return objectId;
  };

  const evaluateFocusedElementScript = (
    wc: WebContents,
    functionSource: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> =>
    evaluateInTab(
      { sendDebuggerCommand, withTemporaryDebugger },
      wc,
      `(${functionSource})((${DEEP_ACTIVE_ELEMENT_FUNCTION})(), ${JSON.stringify(payload)})`,
      "Browser element script evaluation failed.",
    );

  /* ── Live preview stream ───────────────────────────────────────────────── */

  /**
   * Refcounted `capturePage()` loops, one per watched tab.
   *
   * Only ever running while a surface has asked for it — the Work tab's corner
   * card is the one caller today — and paused whenever the hosting window is
   * hidden or minimised, so an ADE in the background pays nothing for a page it
   * cannot show anybody.
   */
  const previewStreams = createBuiltInBrowserPreviewStreams({
    capture: async (tabId, maxWidth) => {
      const tab = tabById(tabId);
      if (!tab || tab.webContents.isDestroyed()) return null;
      // `stayHidden` is deliberately FALSE, and it is the whole reason the card
      // paints at all.
      //
      // Parking a view off-screen keeps a surface Chromium already has; it does
      // not create one. A tab the panel has never shown — an agent's freshly
      // opened tab, a tab switched to while the pane was on Terminal, the very
      // case the corner card exists for — therefore has no compositor frame,
      // and `capturePage({ stayHidden: true })` resolves an EMPTY image against
      // it forever. Silently: `isEmpty()` is not an error, so the loop kept
      // ticking and the card stayed black with a live dot on it.
      //
      // Omitting the flag makes Electron raise the capturer count and treat the
      // page as visible for the duration of the capture, which is what forces
      // the frame to exist. The page being "visible" while somebody is watching
      // a live preview of it is also the honest answer for `visibilitychange`.
      const image = await tab.webContents.capturePage();
      if (image.isEmpty()) return null;
      const size = image.getSize();
      // Downscale in main, not in the renderer: shipping a full-resolution
      // bitmap over IPC 12 times a second is the expensive part, and the card
      // is ~260px wide.
      const scaled = size.width > maxWidth ? image.resize({ width: maxWidth, quality: "good" }) : image;
      const scaledSize = scaled.getSize();
      return {
        dataUrl: `data:image/jpeg;base64,${scaled.toJPEG(BUILT_IN_BROWSER_PREVIEW_JPEG_QUALITY).toString("base64")}`,
        width: scaledSize.width,
        height: scaledSize.height,
      };
    },
    emit: (frame) => {
      emit({
        type: "preview-frame",
        tabId: frame.tabId,
        dataUrl: frame.dataUrl,
        width: frame.width,
        height: frame.height,
        capturedAt: frame.capturedAt,
      });
    },
    isTabAlive: (tabId) => {
      const tab = tabById(tabId);
      return Boolean(tab && !tab.webContents.isDestroyed());
    },
    // Not `visible` (the panel's own bounds flag): the card wants frames from a
    // tab the panel is NOT showing. What matters is whether this ADE window is
    // on screen at all.
    isVisible: () => {
      const hostWindow = win();
      return Boolean(
        hostWindow
        && !hostWindow.isDestroyed()
        && hostWindow.isVisible()
        && !hostWindow.isMinimized(),
      );
    },
    onError: (tabId, error) => {
      logger()?.debug("built_in_browser.preview_frame_failed", {
        tabId,
        err: error instanceof Error ? error.message : String(error),
      });
    },
  });

  function startPreviewStream(
    input: BuiltInBrowserStartPreviewStreamArgs = {},
    owner?: string | null,
  ): BuiltInBrowserPreviewStreamResult {
    const tab = targetTabFromInput(input, "No active browser tab to preview.");
    const result = previewStreams.start(tab.id, {
      fps: input.fps,
      maxWidth: input.maxWidth,
      // Main-derived (the requesting `webContents` id), never renderer-supplied:
      // it is what lets a crash release this renderer's subscriptions and only
      // this renderer's.
      owner,
    });
    // Before the first tick, not after: the service parks the view so the very
    // first capture has a surface to read.
    if (result.subscribers === 1) deps.onPreviewWatchersChanged?.(tab.id);
    return result;
  }

  function stopPreviewStream(
    input: BuiltInBrowserStopPreviewStreamArgs = {},
    owner?: string | null,
  ): BuiltInBrowserPreviewStreamResult {
    // Deliberately tolerant: a card unmounting after its tab closed must not
    // throw on the way out, so an unknown tab id just reports zero subscribers.
    const tabId = stringOrNull(input.tabId) ?? activeTabId();
    if (!tabId) {
      return { tabId: "", fps: 0, maxWidth: 0, subscribers: 0 };
    }
    const { hadStream, ...result } = previewStreams.stop(tabId, owner);
    // Only the last one out unparks the view; a second watcher is still
    // looking, and an unpaired stop was never watching anything at all.
    if (hadStream && result.subscribers === 0) deps.onPreviewWatchersChanged?.(tabId);
    return result;
  }

  /* ── Recording ─────────────────────────────────────────────────────────── */

  const recordingDirectory = (tab: BrowserTabState, recordingId: string): string =>
    path.join(observationDirectory(tab), RECORDING_CACHE_DIR, sanitizeObservationPathSegment(recordingId));

  async function startRecording(
    input: BuiltInBrowserStartRecordingArgs,
  ): Promise<BuiltInBrowserStartRecordingResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before recording.",
      consentReason: "The agent requested a screen recording of this browser tab.",
    });
    if (tab.recording) {
      throw new Error(`Browser tab ${tab.id} is already recording. Stop the current recording first.`);
    }
    const fps = normalizeBuiltInBrowserRecordingFps(input.fps);
    const caption = stringOrNull(input.caption);
    const recordingId = `rec-${Date.now()}-${randomUUID()}`;
    const directory = recordingDirectory(tab, recordingId);
    const session: BuiltInBrowserRecordingSession = await runTracedTabCapability(
      tab,
      "startRecording",
      input,
      () => createBuiltInBrowserRecordingSession({
        id: recordingId,
        directory,
        fps,
        caption,
        createRecorder: tabRecorderFactory(tab),
        logger: logger(),
        // The cap is the session's own, not the caller's: an agent that forgets
        // `stopRecording` (or dies mid-run) must not capture until the app quits.
        maxDurationMs: BUILT_IN_BROWSER_MAX_RECORDING_MS,
        onMaxDurationReached: () => {
          void finishRecording(tab, session, "max_duration").catch((error) => {
            logger()?.warn("built_in_browser.recording_max_duration_stop_failed", {
              tabId: tab.id,
              err: errorMessage(error),
            });
          });
        },
      }),
    );
    tab.recording = session;
    const status: { startedAt: string; fps: number } = { startedAt: session.startedAt, fps };
    emit({
      type: "recording",
      tabId: tab.id,
      recording: status,
      frameCount: 0,
      updatedAt: new Date().toISOString(),
    });
    emitStatus();
    return {
      tabId: tab.id,
      recording: status,
      status: statusForInput(input),
    };
  }

  async function stopRecording(
    input: BuiltInBrowserStopRecordingArgs = {},
  ): Promise<BuiltInBrowserStopRecordingResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before stopping a recording.",
      consentReason: "The agent requested to stop a browser screen recording.",
    });
    const session = tab.recording;
    if (!session) throw new Error(`Browser tab ${tab.id} is not recording.`);
    const result = await runTracedTabCapability(tab, "stopRecording", input, () =>
      finishRecording(tab, session, null));
    return { ...result, status: statusForInput(input) };
  }

  /**
   * Finalize a recording and publish it. Shared by the agent's `stopRecording`
   * and by the session's own max-duration timer, so an auto-stopped recording
   * lands the same file and the same event — with `endedBy` naming what ended it.
   */
  const finishRecording = async (
    tab: BrowserTabState,
    session: BuiltInBrowserRecordingSession,
    endedBy: Extract<BuiltInBrowserRecordingEndedBy, "max_duration"> | null,
  ): Promise<Omit<BuiltInBrowserStopRecordingResult, "status">> => {
    if (tab.recording === session) tab.recording = null;
    const result = await session.stop();
    emit({
      type: "recording",
      tabId: tab.id,
      recording: null,
      frameCount: result.frameCount,
      // Only on an automatic ending: an explicit `stopRecording` raises no
      // toast, and the tab's own pane already says which tab it was.
      ...(endedBy ? { endedBy, tabTitle: builtInBrowserTabTitle(tab) } : {}),
      updatedAt: new Date().toISOString(),
    });
    emitStatus();
    if (endedBy) {
      logger()?.info("built_in_browser.recording_auto_stopped", {
        tabId: tab.id,
        endedBy,
        durationMs: result.durationMs,
      });
      // The agent never called `stopRecording`, so `runTracedTabCapability`
      // wrote nothing — put the ending in the trace it is told to read.
      traceAutoEndedRecording(tab, endedBy, {
        durationMs: result.durationMs,
        frameCount: result.frameCount,
      });
    }
    return {
      tabId: tab.id,
      path: result.filePath,
      relativePath: observationRelativeBasePath
        ? path.relative(observationRelativeBasePath, result.filePath)
        : null,
      durationMs: result.durationMs,
      fps: session.fps,
      frameCount: result.frameCount,
      format: result.format,
      mimeType: result.mimeType,
      caption: session.caption,
      manifestPath: result.manifestPath,
    };
  };

  const tabRecorderFactory = (tab: BrowserTabState): BuiltInBrowserRecorderFactory => {
    if (deps.createTabRecorder) return deps.createTabRecorder;
    const createCaptureWindow = deps.createRecordingWindow ?? defaultCaptureWindowFactory;
    return createDisplayMediaRecorderFactory({
      createCaptureWindow: () => {
        const captureWindow = createCaptureWindow();
        if (!captureWindow) {
          throw new Error("ADE browser recording needs a desktop window; none is available.");
        }
        return captureWindow;
      },
      armDisplayMedia: (frameTreeNodeId) => armDisplayMediaCapture(frameTreeNodeId, tab.webContents),
      logger: logger(),
    });
  };

  /**
   * Grants exactly one `getDisplayMedia` answer, for one capture frame, for a
   * short window. Everything else — including a site in the browser partition
   * trying to capture its own tab — is denied.
   */
  const armDisplayMediaCapture = (
    frameTreeNodeId: number,
    target: WebContents,
    ttlMs = DISPLAY_MEDIA_ARM_TTL_MS,
  ): (() => void) => {
    const captureSession = session.fromPartition(BROWSER_RECORDER_PARTITION);
    if (!configuredDisplayMediaSessions.has(captureSession)) {
      configuredDisplayMediaSessions.add(captureSession);
      captureSession.setDisplayMediaRequestHandler?.((request, callback) => {
        const nodeId = (request as { frame?: { frameTreeNodeId?: number } }).frame?.frameTreeNodeId;
        const armed = typeof nodeId === "number" ? armedDisplayMediaFrames.get(nodeId) ?? null : null;
        if (!armed || armed.expiresAt < Date.now() || armed.target.isDestroyed()) {
          callback({});
          return;
        }
        callback({ video: armed.target.mainFrame });
      });
    }
    armedDisplayMediaFrames.set(frameTreeNodeId, {
      target,
      expiresAt: Date.now() + ttlMs,
    });
    return () => {
      armedDisplayMediaFrames.delete(frameTreeNodeId);
    };
  };

  const defaultCaptureWindowFactory = (): CaptureWindowLike => {
    const BrowserWindowCtor = electronBrowserWindowCtor();
    if (typeof BrowserWindowCtor !== "function") {
      throw new Error("ADE browser recording is unavailable without an Electron window.");
    }
    return new BrowserWindowCtor({
      show: false,
      width: 16,
      height: 16,
      webPreferences: {
        // Throwaway in-memory partition: the capture page never touches the
        // authenticated global browser profile.
        partition: BROWSER_RECORDER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    }) as unknown as CaptureWindowLike;
  };

  return {
    setEmulation,
    reapplyTabEmulation,
    setZoom,
    applyTabZoom,
    findInPage,
    stopFindInPage,
    setDevTools,
    setNetworkLogging,
    getNetworkLog,
    handleNetworkCdpEvent,
    exportHar,
    hover,
    drag,
    selectOption,
    uploadFile,
    startPreviewStream,
    stopPreviewStream,
    startRecording,
    stopRecording,
    /** Drops any preview stream watching a tab the service just closed. */
    stopPreviewStreamsForTab: (tabId: string): void => {
      previewStreams.stopTab(tabId);
    },
    /**
     * Drops every preview subscription one renderer holds, and reports the tabs
     * whose last watcher that was.
     *
     * Owner-scoped rather than a sweep: a crashed renderer must not take down a
     * card another, healthy renderer is still watching.
     */
    stopPreviewStreamsForOwner: (owner: string): string[] =>
      previewStreams.stopOwner(owner).filter((entry) => entry.ended).map((entry) => entry.tabId),
    /**
     * Whether a preview stream is watching this tab.
     *
     * The service asks before it detaches a tab's view: a watched tab has to
     * stay attached to keep a compositor surface, or every capture comes back
     * empty.
     */
    hasPreviewWatchers: (tabId: string): boolean => previewStreams.hasWatchers(tabId),
    /**
     * Teardown for everything this module owns, called when the window service
     * disposes. Two named methods rather than handing the service the whole
     * `previewStreams` object: a sub-collaborator on a seam's public surface is
     * an invitation to reach through it for the next thing.
     */
    dispose: (): void => {
      previewStreams.dispose();
    },
  };
}
