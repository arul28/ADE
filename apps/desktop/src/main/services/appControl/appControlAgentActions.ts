import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AppControlActionTraceEntry,
  AppControlAgentActionArgs,
  AppControlAgentActionResult,
  AppControlAgentClearArgs,
  AppControlAgentClickArgs,
  AppControlAgentFillArgs,
  AppControlAgentHoverArgs,
  AppControlAgentPressArgs,
  AppControlAgentScrollArgs,
  AppControlAgentTypeArgs,
  AppControlAgentWaitArgs,
  AppControlCoordinateSpace,
  AppControlDiagnostics,
  AppControlDomSnapshot,
  AppControlElementSnapshot,
  AppControlElementTargetArgs,
  AppControlObservation,
  AppControlObservationElementMap,
  AppControlObservationArgs,
  AppControlScreencastFrame,
  AppControlScreenshot,
  AppControlSession,
  AppControlSessionTargetArgs,
  AppControlTraceArgs,
  AppControlTraceResult,
} from "../../../shared/types";
import {
  AGENT_DOM_COLLECTOR_FUNCTION,
  AGENT_ELEMENT_MAP_OVERLAY_FUNCTION,
  keyEventForAgentInput,
  parseObservationElementHandle,
  sanitizeObservationPathSegment,
} from "../../../shared/agentObservation";
// Aliased at the import, not re-exported through `appControlObservations`, so
// the shared origin is visible at the use site — same idiom the browser service
// uses for the same three symbols.
import {
  agentHasElementTarget as hasElementTarget,
  applyAgentObservationHandles as applyObservationHandles,
  resolveAgentElementLocatePayload,
} from "../../../shared/agentObservationNormalizers";
import {
  pruneAgentObservationCacheRoot as pruneObservationCacheRoot,
  pruneAgentObservationDirectory as pruneObservationDirectory,
} from "../shared/agentObservationCache";
import {
  APP_CONTROL_OBSERVATION_CACHE_DIR,
  APP_CONTROL_OBSERVATION_MAX_AGE_MS,
  MAX_APP_CONTROL_TRACE_ENTRIES,
  MAX_ELEMENT_MAP_ELEMENTS,
  actionTargetForTrace,
  decodeObservationDataUrl,
  finiteNumber,
  isRecord,
  normalizeActionObserveDelayMs,
  normalizeDomSnapshot,
  normalizeElementSnapshot,
  normalizeNetworkIdleMs,
  normalizeObservationKeepCount,
  normalizeObservationMaxElements,
  normalizePositiveInteger,
  normalizeTraceLimit,
  normalizeWaitTimeoutMs,
  observationDirectory,
  optionalFiniteNumber,
  stringOrNull,
} from "./appControlObservations";
import type { Logger } from "../logging/logger";
import { nowIso } from "../shared/utils";

/**
 * App Control's agent action model.
 *
 * Mirrors the built-in browser: `observe` returns a screenshot plus a bounded
 * element list carrying stable `obs-…:e:N` handles, and every action resolves
 * its target, scrolls it into view, focuses it, refuses disabled targets,
 * records a bounded per-session trace entry, and answers with a fresh
 * post-action observation.
 *
 * The legacy `click` / `typeText` / `scroll` / `dispatchKey` primitives stay in
 * `appControlService` for the renderer's live-frame input; these are the agent
 * surface. It lives in its own module because it is one coherent
 * responsibility that talks to the session machinery through the narrow
 * {@link AppControlAgentActionDeps} seam — the same split the directory already
 * uses for `appControlLaunchCommand` and `appControlObservations`, and the one
 * `appControlAgentActions.test.ts` was already named after.
 */

/** The slice of the service's CDP client this surface uses. */
export type AppControlAgentCdpClient = {
  send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
};

type CdpRuntimeEvaluateResponse<T> = {
  result?: { type?: string; value?: T; description?: string };
  exceptionDetails?: unknown;
};

type CdpScreenshotResponse = { data: string };

/** Everything the agent surface needs from the session machinery around it. */
export type AppControlAgentActionDeps<TClient extends AppControlAgentCdpClient = AppControlAgentCdpClient> = {
  logger: Logger;
  /** The session's project root, falling back to the service's. */
  resolveProjectRoot: (sessionProjectRoot: string | null | undefined) => string;
  getActiveSession: () => AppControlSession | null;
  updateSession: (patch: Partial<AppControlSession>) => AppControlSession | null;
  /** Runs `fn` against a connected CDP client, reusing the screencast socket when it fits. */
  withCdp: <T>(fn: (client: TClient, session: AppControlSession) => Promise<T>) => Promise<T>;
  enablePageDomain: (client: TClient) => Promise<void>;
  normalizeViewportPoint: (
    client: TClient,
    point: { x: number; y: number; scale?: number | null; coordinateSpace?: AppControlCoordinateSpace | null },
  ) => Promise<{ x: number; y: number }>;
  /** Current console/network error tallies, snapshotted for an observation. */
  snapshotDiagnostics: () => AppControlDiagnostics;
  /** True when no request is in flight and none finished within `idleMs`. */
  isNetworkIdle: (idleMs: number) => boolean;
  /**
   * Most recent screencast frame, used only as a fallback when a full-fidelity
   * `Page.captureScreenshot` is unavailable. Owned by the service because the
   * live-frame pipeline writes it.
   */
  getLastScreencastFrame: () => AppControlScreencastFrame | null;
  imageDimensions: (buffer: Buffer) => { width: number; height: number } | null;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Two decimal places: CDP coordinates are floats and traces are read by humans. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createAppControlAgentActions<TClient extends AppControlAgentCdpClient>(
  deps: AppControlAgentActionDeps<TClient>,
) {
  // Bounded per-session ledger of what the agent did, read by `getTrace`, the
  // Work-tab corner card and `ade app-control proof`.
  let actionTrace: AppControlActionTraceEntry[] = [];
  // Last page identity an observation (or a wait) actually saw. The trace's
  // before/after pair is the only place these are read from.
  let lastObservedUrl: string | null = null;
  let lastObservedTitle: string | null = null;

  const agentSessionFor = (input: AppControlSessionTargetArgs = {}): AppControlSession => {
    const activeSession = deps.getActiveSession();
    if (!activeSession) throw new Error("No active App Control session. Launch or connect first.");
    const requested = stringOrNull(input.sessionId);
    if (requested && requested !== activeSession.id) {
      throw new Error(`App Control session '${requested}' is not the active session.`);
    }
    return activeSession;
  };

  const observationRootFor = (session: AppControlSession): string => {
    const projectRoot = deps.resolveProjectRoot(session.projectRoot);
    return path.join(projectRoot, APP_CONTROL_OBSERVATION_CACHE_DIR);
  };

  const evaluateAgentDom = async (
    client: TClient,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const expression = `(${AGENT_DOM_COLLECTOR_FUNCTION})(${JSON.stringify(payload)})`;
    const evaluated = await client.send<CdpRuntimeEvaluateResponse<unknown>>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    });
    if (evaluated.exceptionDetails) {
      throw new Error("App Control DOM evaluation failed in the controlled app.");
    }
    const value = evaluated.result?.value;
    return isRecord(value) ? value : {};
  };

  const evaluateElementMapOverlay = async (
    client: TClient,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const expression = `(${AGENT_ELEMENT_MAP_OVERLAY_FUNCTION})(${JSON.stringify(payload)})`;
    await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    });
  };

  const readAgentDomSnapshot = async (
    client: TClient,
    input: AppControlObservationArgs,
  ): Promise<AppControlDomSnapshot | null> => {
    const result = await evaluateAgentDom(client, {
      maxElements: normalizeObservationMaxElements(input.maxElements),
    });
    return normalizeDomSnapshot(result.snapshot);
  };

  const captureElementMapScreenshot = async (
    client: TClient,
    session: AppControlSession,
    dom: AppControlDomSnapshot,
  ): Promise<AppControlScreenshot | null> => {
    if (!dom.elements.length) return null;
    await evaluateElementMapOverlay(client, { elements: dom.elements.slice(0, MAX_ELEMENT_MAP_ELEMENTS) });
    try {
      return await capturePageScreenshotForObservation(client, session);
    } finally {
      await evaluateElementMapOverlay(client, { clear: true }).catch(() => {});
    }
  };

  /**
   * Observations always want a fresh full-fidelity paint, so this forces
   * `Page.captureScreenshot` rather than reusing the throttled screencast
   * frame; the cached frame is only a fallback when capture is unavailable.
   */
  const capturePageScreenshotForObservation = async (
    client: TClient,
    session: AppControlSession,
  ): Promise<AppControlScreenshot> => {
    await deps.enablePageDomain(client);
    const response = await client.send<CdpScreenshotResponse>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    const buffer = Buffer.from(response.data, "base64");
    const dimensions = deps.imageDimensions(buffer) ?? { width: 0, height: 0 };
    return {
      sessionId: session.id,
      cdpTargetId: session.cdpTargetId,
      capturedAt: nowIso(),
      width: dimensions.width,
      height: dimensions.height,
      dataUrl: `data:image/png;base64,${response.data}`,
    };
  };

  const snapshotAgentDiagnostics = (): AppControlDiagnostics => deps.snapshotDiagnostics();

  const writeObservation = async (
    session: AppControlSession,
    screenshot: AppControlScreenshot,
    input: AppControlObservationArgs,
    dom: AppControlDomSnapshot | null,
    elementMapScreenshot: AppControlScreenshot | null,
    diagnostics: AppControlDiagnostics | null,
  ): Promise<AppControlObservation> => {
    const projectRoot = deps.resolveProjectRoot(session.projectRoot);
    const rootPath = observationRootFor(session);
    const keepCount = normalizeObservationKeepCount(input.keepCount);
    const id = `obs-${Date.now()}-${randomUUID()}`;
    const dir = observationDirectory(rootPath, session.id);
    const filePath = path.join(dir, `${id}.png`);
    const elementMapPath = path.join(dir, `${id}.map.png`);
    const jsonPath = path.join(dir, `${id}.json`);
    const image = decodeObservationDataUrl(screenshot.dataUrl);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, image.buffer);
    const domWithHandles = dom ? applyObservationHandles(dom, id) : null;
    let elementMap: AppControlObservationElementMap | null = null;
    if (elementMapScreenshot) {
      const elementMapImage = decodeObservationDataUrl(elementMapScreenshot.dataUrl);
      await fs.promises.writeFile(elementMapPath, elementMapImage.buffer);
      elementMap = {
        filePath: elementMapPath,
        relativePath: path.relative(projectRoot, elementMapPath),
        width: elementMapScreenshot.width,
        height: elementMapScreenshot.height,
        mimeType: elementMapImage.mimeType,
        elementCount: domWithHandles?.elements.length ?? 0,
        ...(input.includeDataUrl ? { dataUrl: elementMapScreenshot.dataUrl } : {}),
      };
    }
    const observation: AppControlObservation = {
      id,
      sessionId: session.id,
      cdpTargetId: session.cdpTargetId,
      url: domWithHandles?.url ?? null,
      title: domWithHandles?.title ?? null,
      capturedAt: screenshot.capturedAt,
      width: screenshot.width,
      height: screenshot.height,
      mimeType: image.mimeType,
      filePath,
      relativePath: path.relative(projectRoot, filePath),
      ...(input.includeDataUrl ? { dataUrl: screenshot.dataUrl } : {}),
      ...(domWithHandles ? { dom: domWithHandles } : {}),
      ...(elementMap ? { elementMap } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      laneId: session.laneId,
      chatSessionId: session.chatSessionId,
      cleanup: { keepCount, keptCount: 1, deletedCount: 0 },
    };
    // Write once so the record (and its handles) exist before pruning counts
    // it, then rewrite with the final cleanup numbers.
    await fs.promises.writeFile(jsonPath, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
    observation.cleanup = await pruneObservationDirectory(dir, keepCount);
    void pruneObservationCacheRoot(rootPath, APP_CONTROL_OBSERVATION_MAX_AGE_MS).catch(() => {});
    await fs.promises.writeFile(jsonPath, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
    return observation;
  };

  const observeWithClient = async (
    client: TClient,
    session: AppControlSession,
    input: AppControlObservationArgs,
  ): Promise<AppControlObservation> => {
    let screenshot: AppControlScreenshot;
    try {
      screenshot = await capturePageScreenshotForObservation(client, session);
    } catch (error) {
      const cached = deps.getLastScreencastFrame();
      if (!cached || cached.sessionId !== session.id) throw error;
      screenshot = {
        sessionId: session.id,
        cdpTargetId: session.cdpTargetId,
        capturedAt: cached.capturedAt,
        width: cached.width,
        height: cached.height,
        dataUrl: `data:${cached.mimeType};base64,${cached.data}`,
      };
    }
    const dom = input.includeDom === false
      ? null
      : await readAgentDomSnapshot(client, input).catch((error) => {
          deps.logger.debug?.("app_control.observe_dom_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
    const elementMapScreenshot = input.includeElementMap && dom
      ? await captureElementMapScreenshot(client, session, dom).catch((error) => {
          deps.logger.debug?.("app_control.observe_element_map_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        })
      : null;
    const diagnostics = input.includeDiagnostics === false ? null : snapshotAgentDiagnostics();
    const observation = await writeObservation(session, screenshot, input, dom, elementMapScreenshot, diagnostics);
    if (observation.url) lastObservedUrl = observation.url;
    if (observation.title) lastObservedTitle = observation.title;
    deps.updateSession({ lastObservationId: observation.id });
    return observation;
  };

  const observe = async (input: AppControlObservationArgs = {}): Promise<AppControlObservation> => {
    agentSessionFor(input);
    return deps.withCdp((client, session) => observeWithClient(client, session, input));
  };

  const readObservationElementHandle = async (
    session: AppControlSession,
    handle: string,
  ): Promise<AppControlElementSnapshot> => {
    const parsed = parseObservationElementHandle(handle);
    if (!parsed) {
      throw new Error("App Control element handle must look like obs-...:e:<index>.");
    }
    const jsonPath = path.join(
      observationDirectory(observationRootFor(session), session.id),
      `${sanitizeObservationPathSegment(parsed.observationId)}.json`,
    );
    let parsedObservation: unknown;
    try {
      parsedObservation = JSON.parse(await fs.promises.readFile(jsonPath, "utf8"));
    } catch {
      throw new Error("App Control element handle expired or was pruned from scratch observations.");
    }
    const record = isRecord(parsedObservation) ? parsedObservation : {};
    if (stringOrNull(record.sessionId) !== session.id) {
      throw new Error("App Control element handle belongs to a different session.");
    }
    // Observations are stored per session, but `switchWindow` moves the session
    // to a different CDP target without changing its id — so the session check
    // alone lets a handle minted in window A resolve against window B's DOM and
    // click whatever `button.danger` matches there, silently, with an `ok`
    // trace entry. Both the docs and the skill promise the handle stops
    // resolving; this is that promise.
    if (stringOrNull(record.cdpTargetId) !== session.cdpTargetId) {
      throw new Error(
        "App Control element handle belongs to a different window. Observe again after switching windows.",
      );
    }
    const dom = isRecord(record.dom) ? record.dom : {};
    const elements = Array.isArray(dom.elements)
      ? dom.elements
          .map(normalizeElementSnapshot)
          .filter((entry): entry is AppControlElementSnapshot => Boolean(entry))
      : [];
    const element = elements.find((entry) => entry.index === parsed.index) ?? null;
    if (!element) {
      throw new Error("App Control element handle no longer points to a saved element.");
    }
    return element;
  };

  const elementLocatePayloadForInput = (
    session: AppControlSession,
    input: AppControlElementTargetArgs,
  ): Promise<Record<string, unknown>> =>
    resolveAgentElementLocatePayload(input, (handle) =>
      readObservationElementHandle(session, handle));

  const locateElementTarget = async (
    client: TClient,
    session: AppControlSession,
    input: AppControlElementTargetArgs & AppControlObservationArgs,
    options: { focus?: boolean; select?: boolean; clear?: boolean; editableRequired?: boolean } = {},
  ): Promise<AppControlElementSnapshot> => {
    if (!hasElementTarget(input)) {
      throw new Error("App Control element target requires selector, text, testId, elementIndex, or handle.");
    }
    const result = await evaluateAgentDom(client, {
      maxElements: normalizeObservationMaxElements(input.maxElements),
      ...(options.focus ? { focus: true } : {}),
      ...(options.select ? { select: true } : {}),
      ...(options.clear ? { clear: true } : {}),
      ...(options.editableRequired ? { editableRequired: true } : {}),
      locate: await elementLocatePayloadForInput(session, input),
    });
    const error = stringOrNull(result.error);
    if (error) throw new Error(error);
    const target = normalizeElementSnapshot(result.target);
    if (!target) throw new Error("No matching App Control element was found.");
    if (target.disabled) throw new Error("Matching App Control element is disabled.");
    return target;
  };

  const resolveAgentPoint = async (
    client: TClient,
    session: AppControlSession,
    input: AppControlAgentClickArgs | AppControlAgentHoverArgs,
  ): Promise<{ x: number; y: number; element: AppControlElementSnapshot | null }> => {
    const x = optionalFiniteNumber(input.x);
    const y = optionalFiniteNumber(input.y);
    if (x != null || y != null) {
      if (x == null || y == null) {
        throw new Error("App Control click requires both x and y when using coordinates.");
      }
      const point = await deps.normalizeViewportPoint(client, {
        x,
        y,
        scale: input.scale ?? null,
        coordinateSpace: input.coordinateSpace ?? null,
      });
      return { x: point.x, y: point.y, element: null };
    }
    const element = await locateElementTarget(client, session, input, { focus: true });
    return { x: round(element.center.x), y: round(element.center.y), element };
  };

  const beginActionTrace = (
    session: AppControlSession,
    action: string,
    input: Record<string, unknown>,
  ) => ({
    id: `trace-${Date.now()}-${randomUUID()}`,
    action,
    startedAt: nowIso(),
    startedAtMs: Date.now(),
    before: sessionSnapshotForTrace(),
    target: actionTargetForTrace(action, input),
    sessionId: session.id,
    cdpTargetId: session.cdpTargetId,
  });

  const sessionSnapshotForTrace = (): { url: string | null; title: string | null } => ({
    url: lastObservedUrl,
    title: lastObservedTitle,
  });

  const finishActionTrace = (
    draft: ReturnType<typeof beginActionTrace>,
    status: AppControlActionTraceEntry["status"],
    extra: { observationId?: string | null; error?: unknown } = {},
  ): AppControlActionTraceEntry => {
    const endedAtMs = Date.now();
    const entry: AppControlActionTraceEntry = {
      id: draft.id,
      sessionId: draft.sessionId,
      cdpTargetId: draft.cdpTargetId,
      action: draft.action,
      status,
      startedAt: draft.startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - draft.startedAtMs),
      before: draft.before,
      after: sessionSnapshotForTrace(),
      target: draft.target,
      observationId: extra.observationId ?? null,
      error: extra.error == null
        ? null
        : extra.error instanceof Error ? extra.error.message : String(extra.error),
    };
    actionTrace = [...actionTrace, entry].slice(-MAX_APP_CONTROL_TRACE_ENTRIES);
    deps.updateSession({ lastTraceEntryId: entry.id });
    return entry;
  };

  const agentActionResult = async (
    client: TClient,
    session: AppControlSession,
    input: AppControlAgentActionArgs,
  ): Promise<AppControlObservation | null> => {
    if (input.observe === false) return null;
    const waitMs = normalizeActionObserveDelayMs(input.waitAfterMs);
    if (waitMs > 0) await delay(waitMs);
    return observeWithClient(client, session, input);
  };

  const runAgentAction = async (
    action: string,
    input: AppControlAgentActionArgs,
    run: (client: TClient, session: AppControlSession) => Promise<void>,
  ): Promise<AppControlAgentActionResult> => {
    agentSessionFor(input);
    return deps.withCdp(async (client, session) => {
      const draft = beginActionTrace(session, action, input as Record<string, unknown>);
      try {
        await run(client, session);
        const observation = await agentActionResult(client, session, input);
        const trace = finishActionTrace(draft, "ok", { observationId: observation?.id ?? null });
        return { ok: true as const, observation, session: deps.getActiveSession(), trace };
      } catch (error) {
        finishActionTrace(draft, "error", { error });
        throw error;
      }
    });
  };

  const agentClick = async (input: AppControlAgentClickArgs): Promise<AppControlAgentActionResult> =>
    runAgentAction("click", input, async (client, session) => {
      const point = await resolveAgentPoint(client, session, input);
      const button = input.button === "middle" || input.button === "right" ? input.button : "left";
      const clickCount = Math.max(1, Math.min(3, normalizePositiveInteger(input.clickCount) ?? 1));
      await deps.enablePageDomain(client);
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
    });

  const agentHover = async (input: AppControlAgentHoverArgs): Promise<AppControlAgentActionResult> =>
    runAgentAction("hover", input, async (client, session) => {
      const point = await resolveAgentPoint(client, session, input);
      await deps.enablePageDomain(client);
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
      });
    });

  const agentFill = async (input: AppControlAgentFillArgs): Promise<AppControlAgentActionResult> =>
    runAgentAction("fill", input, async (client, session) => {
      // `text` doubles as an element-match term, so only an explicit `value`
      // is ever treated as the payload to type.
      const fillValue = typeof input.value === "string" ? input.value : null;
      if (fillValue == null) throw new Error("App Control fill requires a value.");
      await locateElementTarget(client, session, input, {
        focus: true,
        select: true,
        clear: true,
        editableRequired: true,
      });
      await deps.enablePageDomain(client);
      await client.send("Input.insertText", { text: fillValue });
    });

  const agentClear = async (input: AppControlAgentClearArgs): Promise<AppControlAgentActionResult> =>
    runAgentAction("clear", input, async (client, session) => {
      await locateElementTarget(client, session, input, {
        focus: true,
        select: true,
        clear: true,
        editableRequired: true,
      });
    });

  const agentType = async (input: AppControlAgentTypeArgs): Promise<AppControlAgentActionResult> =>
    runAgentAction("type", input, async (client) => {
      const text = typeof input.text === "string" ? input.text : "";
      if (!text.length) throw new Error("App Control type requires text.");
      await deps.enablePageDomain(client);
      await client.send("Input.insertText", { text });
    });

  const agentPress = async (input: AppControlAgentPressArgs): Promise<AppControlAgentActionResult> =>
    runAgentAction("press", input, async (client, session) => {
      const key = stringOrNull(input.key);
      if (!key) throw new Error("App Control press requires a key.");
      if (hasElementTarget(input)) {
        await locateElementTarget(client, session, input, { focus: true });
      }
      const event = keyEventForAgentInput(key);
      await deps.enablePageDomain(client);
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        ...event,
        text: undefined,
        unmodifiedText: undefined,
      });
    });

  const agentScroll = async (input: AppControlAgentScrollArgs): Promise<AppControlAgentActionResult> =>
    runAgentAction("scroll", input, async (client) => {
      const deltaX = finiteNumber(input.deltaX);
      const deltaY = finiteNumber(input.deltaY);
      if (deltaX === 0 && deltaY === 0) throw new Error("App Control scroll requires deltaX or deltaY.");
      const point = await deps.normalizeViewportPoint(client, {
        x: finiteNumber(input.x),
        y: finiteNumber(input.y),
        scale: input.scale ?? null,
        coordinateSpace: input.coordinateSpace ?? null,
      });
      await deps.enablePageDomain(client);
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX: Math.round(deltaX),
        deltaY: Math.round(deltaY),
        button: "none",
        modifiers: 0,
      });
    });

  const agentWaitConditionMatched = async (
    client: TClient,
    session: AppControlSession,
    input: AppControlAgentWaitArgs,
  ): Promise<boolean> => {
    const loadState = input.loadState ?? null;
    if (loadState != null && !["domcontentloaded", "load", "network-idle"].includes(loadState)) {
      throw new Error("App Control wait loadState must be domcontentloaded, load, or network-idle.");
    }
    const result = await evaluateAgentDom(client, {
      maxElements: normalizeObservationMaxElements(input.maxElements),
      ...(hasElementTarget(input) ? { locate: await elementLocatePayloadForInput(session, input) } : {}),
    });
    const snapshot = normalizeDomSnapshot(result.snapshot);
    if (snapshot?.url) lastObservedUrl = snapshot.url;
    if (snapshot?.title) lastObservedTitle = snapshot.title;

    const expectedUrl = stringOrNull(input.url);
    if (expectedUrl && !(snapshot?.url ?? "").includes(expectedUrl)) return false;

    if (loadState) {
      const readyState = stringOrNull(result.readyState);
      if (loadState === "network-idle") {
        if (!deps.isNetworkIdle(normalizeNetworkIdleMs(input.networkIdleMs))) return false;
      }
      if (loadState === "domcontentloaded" && readyState !== "interactive" && readyState !== "complete") return false;
      if ((loadState === "load" || loadState === "network-idle") && readyState !== "complete") return false;
    }

    if (hasElementTarget(input)) {
      const target = normalizeElementSnapshot(result.target);
      return Boolean(target && !target.disabled);
    }
    return true;
  };

  const agentWait = async (input: AppControlAgentWaitArgs): Promise<AppControlAgentActionResult> =>
    runAgentAction("wait", input, async (client, session) => {
      if (!hasElementTarget(input) && !stringOrNull(input.url) && !input.loadState) {
        throw new Error("App Control wait requires selector, text, testId, elementIndex, handle, url, or loadState.");
      }
      const timeoutMs = normalizeWaitTimeoutMs(input.timeoutMs);
      const deadline = Date.now() + timeoutMs;
      let lastError: string | null = null;
      for (;;) {
        try {
          if (await agentWaitConditionMatched(client, session, input)) return;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        if (Date.now() >= deadline) break;
        await delay(Math.min(250, Math.max(1, deadline - Date.now())));
      }
      throw new Error(lastError ?? `Timed out waiting for the App Control condition after ${timeoutMs}ms.`);
    });

  const getTrace = (input: AppControlTraceArgs = {}): AppControlTraceResult => {
    const session = agentSessionFor(input);
    const limit = normalizeTraceLimit(input.limit);
    return {
      sessionId: session.id,
      entries: actionTrace.filter((entry) => entry.sessionId === session.id).slice(-limit),
    };
  };


  return {
    agentSessionFor,
    observationRootFor,
    observe,
    agentClick,
    agentHover,
    agentFill,
    agentClear,
    agentType,
    agentPress,
    agentScroll,
    agentWait,
    getTrace,
    /**
     * Drop the ledger. `switchWindow` calls this: a different window is a
     * different document, so entries from the previous one would read as
     * current.
     */
    resetTrace: (): void => {
      actionTrace = [];
    },
  };
}

export type AppControlAgentActions = ReturnType<typeof createAppControlAgentActions>;
