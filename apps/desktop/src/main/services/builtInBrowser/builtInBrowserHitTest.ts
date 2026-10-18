import type { WebContents } from "electron";
import type { BuiltInBrowserFrame } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import {
  composeFrameTransforms,
  frameToParentPoint,
  frameToParentRect,
  frameTransformFromBox,
  IDENTITY_FRAME_TRANSFORM,
  parentToFramePoint,
  type CdpBoxModelResponse,
  type FrameTransform,
} from "../shared/cdpFrameTransform";

/**
 * Hit-testing a point in an ADE browser tab, and the inspect overlay's reach
 * into iframes.
 *
 * Every point here is in the tab's viewport pixels (what `clientX/clientY`
 * reports in the top document). Chromium's `DOM.getNodeForLocation` wants
 * document pixels, so the scroll offset is added; iframes measure in their own
 * viewport, so points and boxes are mapped through the frame's drawn transform
 * (`cdpFrameTransform`). Cross-site iframes run in another renderer and are reached through
 * flattened child debugger sessions.
 */

export type BrowserViewportPoint = {
  x: number;
  y: number;
};

export type SendDebuggerCommand = <T = unknown>(
  wc: WebContents,
  command: string,
  params?: Record<string, unknown>,
  /** A flattened child session (a cross-process iframe) instead of the tab's own. */
  sessionId?: string,
) => Promise<T>;

/** The part of the page metadata script's answer that depends on which frame measured it. */
export type FrameMeasuredMetadata = {
  frame: BuiltInBrowserFrame;
  viewport: BuiltInBrowserFrame;
  url: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
};

type CdpLayoutMetricsResponse = {
  cssLayoutViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
};

type CdpGetNodeForLocationResponse = {
  backendNodeId?: number;
  frameId?: string;
};

type CdpFrameTreeNode = {
  frame?: { id?: string };
  childFrames?: CdpFrameTreeNode[];
};

type CdpFrameTreeResponse = {
  frameTree?: CdpFrameTreeNode;
};

type CdpDescribeNodeResponse = {
  node?: { frameId?: string; contentDocument?: unknown };
};

type CdpAttachToTargetResponse = {
  sessionId?: string;
};

type CdpEvaluateObjectResponse = {
  result?: { objectId?: string };
  exceptionDetails?: unknown;
};

type CdpCreateIsolatedWorldResponse = {
  executionContextId?: number;
};

const MAX_FRAME_DEPTH = 4;
// Iframes get the inspect overlay in an isolated world of their own, so the
// page's scripts never see it; their binding is exposed only to that world.
export const INSPECT_FRAME_BINDING_NAME = "__adeBuiltInBrowserInspectFrameSelect";
const INSPECT_FRAME_WORLD_NAME = "__adeBuiltInBrowserInspect";
/** Root-session key: the tab's own debugger session has no id. */
const ROOT_SESSION = "";

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function roundedPoint(point: BrowserViewportPoint): BrowserViewportPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function childFrameIds(node: CdpFrameTreeNode | undefined, depth = 0): string[] {
  if (!node || depth > MAX_FRAME_DEPTH * 2) return [];
  const ids: string[] = [];
  for (const child of node.childFrames ?? []) {
    if (child.frame?.id) ids.push(child.frame.id);
    ids.push(...childFrameIds(child, depth + 1));
  }
  return ids;
}

/**
 * Move metadata measured inside an iframe out into the tab's viewport through
 * the frame's full (composed) transform. The item belongs to the tab's page;
 * the frame's own address rides along under `metadata.iframe`.
 */
export function moveFrameMetadataOut<T extends FrameMeasuredMetadata>(
  measured: T,
  transform: FrameTransform,
  frameId: string,
  viewport: BuiltInBrowserFrame,
): T {
  return {
    ...measured,
    frame: frameToParentRect(measured.frame, transform),
    viewport,
    url: null,
    title: null,
    metadata: {
      ...measured.metadata,
      iframe: {
        frameId,
        url: measured.url,
        title: measured.title,
        // Where the frame's top-left corner sits in the tab's viewport.
        origin: roundedPoint(frameToParentPoint({ x: 0, y: 0 }, transform)),
      },
    },
  };
}

/** A hit, still in the measuring frame's pixels, and how that frame maps into the caller's viewport. */
type Located<T> = {
  measured: T;
  transform: FrameTransform;
  /** The innermost iframe the node lives in; null for the top document. */
  frameId: string | null;
};

/** Where a same-renderer iframe sits, and at what scale, in its session's viewport. */
async function readFrameOwnerTransform(
  sendDebuggerCommand: SendDebuggerCommand,
  wc: WebContents,
  frameId: string,
  sessionId?: string,
): Promise<FrameTransform> {
  const owner = await sendDebuggerCommand<{ backendNodeId?: number }>(wc, "DOM.getFrameOwner", { frameId }, sessionId);
  if (typeof owner.backendNodeId !== "number") throw new Error("Unable to find the iframe.");
  const box = await sendDebuggerCommand<CdpBoxModelResponse>(wc, "DOM.getBoxModel", {
    backendNodeId: owner.backendNodeId,
  }, sessionId);
  return frameTransformFromBox(box);
}

export type BrowserHitTestDeps<T extends FrameMeasuredMetadata> = {
  sendDebuggerCommand: SendDebuggerCommand;
  /** Runs the page metadata script on a node; `point` is in that node's frame viewport. */
  readNodeMetadata: (wc: WebContents, backendNodeId: number, point: BrowserViewportPoint, sessionId?: string) => Promise<T>;
  readObjectMetadata: (wc: WebContents, objectId: string, point: BrowserViewportPoint) => Promise<T>;
  logger: () => Logger | null;
};

export function createBrowserHitTester<T extends FrameMeasuredMetadata>(deps: BrowserHitTestDeps<T>) {
  const { sendDebuggerCommand, readNodeMetadata, readObjectMetadata, logger } = deps;

  /**
   * Hit-test one session's viewport. Same-renderer iframes are hit-tested
   * through; a cross-site iframe answers as its <iframe> element, so attach to
   * it and look inside. The answer stays in the measuring frame's own pixels,
   * with the transform that maps that frame into this session's viewport, so
   * nested frames compose transforms rather than boxes.
   */
  const locate = async (
    wc: WebContents,
    point: BrowserViewportPoint,
    sessionId: string | undefined,
    depth: number,
  ): Promise<Located<T> | null> => {
    if (sessionId) await sendDebuggerCommand(wc, "DOM.enable", {}, sessionId);
    const metrics = await sendDebuggerCommand<CdpLayoutMetricsResponse>(wc, "Page.getLayoutMetrics", {}, sessionId);
    const result = await sendDebuggerCommand<CdpGetNodeForLocationResponse>(wc, "DOM.getNodeForLocation", {
      x: Math.round(point.x + finiteOrZero(metrics.cssLayoutViewport?.pageX)),
      y: Math.round(point.y + finiteOrZero(metrics.cssLayoutViewport?.pageY)),
      includeUserAgentShadowDOM: true,
      // Match what the pointer sees: the picker outline (and any other
      // pointer-events:none layer) must not win the hit test.
      ignorePointerEventsNone: false,
    }, sessionId);
    const backendNodeId = result.backendNodeId;
    if (!backendNodeId) return null;

    if (depth < MAX_FRAME_DEPTH) {
      const described = await sendDebuggerCommand<CdpDescribeNodeResponse>(wc, "DOM.describeNode", { backendNodeId }, sessionId)
        .catch(() => null);
      const owner = described?.node;
      if (owner?.frameId && !owner.contentDocument) {
        const inner = await locateInCrossSiteFrame(wc, point, sessionId, backendNodeId, owner.frameId, depth)
          .catch((error) => {
            logger()?.warn("built_in_browser.cross_site_frame_hit_test_failed", { err: errorMessage(error) });
            return null;
          });
        if (inner) return inner;
      }
    }

    const rootFrameId = result.frameId
      ? (await sendDebuggerCommand<CdpFrameTreeResponse>(wc, "Page.getFrameTree", {}, sessionId)).frameTree?.frame?.id ?? null
      : null;
    if (!result.frameId || result.frameId === rootFrameId) {
      const measured = await readNodeMetadata(wc, backendNodeId, point, sessionId);
      return { measured, transform: IDENTITY_FRAME_TRANSFORM, frameId: null };
    }
    // A same-renderer iframe: the metadata script measures in that frame's
    // viewport, so hand it a frame-local point.
    const transform = await readFrameOwnerTransform(sendDebuggerCommand, wc, result.frameId, sessionId);
    const measured = await readNodeMetadata(wc, backendNodeId, roundedPoint(parentToFramePoint(point, transform)), sessionId);
    return { measured, transform, frameId: result.frameId };
  };

  const locateInCrossSiteFrame = async (
    wc: WebContents,
    point: BrowserViewportPoint,
    sessionId: string | undefined,
    ownerBackendNodeId: number,
    frameId: string,
    depth: number,
  ): Promise<Located<T> | null> => {
    const box = await sendDebuggerCommand<CdpBoxModelResponse>(wc, "DOM.getBoxModel", {
      backendNodeId: ownerBackendNodeId,
    }, sessionId);
    const transform = frameTransformFromBox(box);
    const attached = await sendDebuggerCommand<CdpAttachToTargetResponse>(wc, "Target.attachToTarget", {
      targetId: frameId,
      flatten: true,
    });
    const childSessionId = attached.sessionId;
    if (!childSessionId) return null;
    try {
      const inner = await locate(wc, roundedPoint(parentToFramePoint(point, transform)), childSessionId, depth + 1);
      if (!inner) return null;
      return {
        measured: inner.measured,
        transform: composeFrameTransforms(transform, inner.transform),
        frameId: inner.frameId ?? frameId,
      };
    } finally {
      await sendDebuggerCommand(wc, "Target.detachFromTarget", { sessionId: childSessionId }).catch(() => {});
    }
  };

  /**
   * The element under a viewport point, for the picker, drag-capture and
   * `ade browser select`. When the CDP hit test finds nothing, ask the page
   * itself, which works in viewport pixels natively.
   */
  const readNodeMetadataAtViewportPoint = async (wc: WebContents, point: BrowserViewportPoint): Promise<T | null> => {
    const metrics = await sendDebuggerCommand<CdpLayoutMetricsResponse>(wc, "Page.getLayoutMetrics").catch(() => null);
    const viewport = metrics?.cssLayoutViewport;
    if (viewport?.clientWidth === 0 && viewport.clientHeight === 0) {
      // A hidden tab restored without bounds has no viewport: no point can hit anything.
      throw new Error(
        "This browser tab has no visible viewport yet. Show the tab, or give it a size with `ade browser emulate --width <w> --height <h>`, then select again.",
      );
    }
    const tabViewport = {
      x: 0,
      y: 0,
      width: finiteOrZero(viewport?.clientWidth),
      height: finiteOrZero(viewport?.clientHeight),
    };
    try {
      const located = await locate(wc, point, undefined, 0);
      if (located) {
        return located.frameId
          ? moveFrameMetadataOut(located.measured, located.transform, located.frameId, tabViewport)
          : located.measured;
      }
    } catch (error) {
      logger()?.warn("built_in_browser.point_hit_test_fell_back", { err: errorMessage(error) });
    }
    const evaluated = await sendDebuggerCommand<CdpEvaluateObjectResponse>(wc, "Runtime.evaluate", {
      expression: `document.elementFromPoint(${point.x}, ${point.y})`,
      returnByValue: false,
      silent: true,
    });
    const objectId = evaluated.exceptionDetails ? null : evaluated.result?.objectId;
    if (!objectId) return null;
    return readObjectMetadata(wc, objectId, point);
  };

  return { readNodeMetadataAtViewportPoint };
}

export type BrowserFrameInspectorDeps = {
  sendDebuggerCommand: SendDebuggerCommand;
  installScript: (bindingName: string) => string;
  cleanupScript: () => string;
  logger: () => Logger | null;
};

type InspectSession = {
  /** The session the <iframe> element lives in; null for the tab's own session. */
  parentSessionId: string | null;
  /** The frame the session was attached to; the main frame for the tab's own session. */
  rootFrameId: string | null;
};

type InspectFrameContext = {
  contextId: number;
  frameId: string;
  sessionId: string;
};

type CdpExecutionContextCreatedParams = {
  context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } };
};

type CdpAttachedToTargetParams = {
  sessionId?: string;
  targetInfo?: { targetId?: string; type?: string };
};

const AUTO_ATTACH_IFRAMES = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "iframe", exclude: false }],
};

/**
 * The inspect overlay in every iframe of a tab, for one inspect run. The top
 * document's overlay lives in the page's own world (the service installs it);
 * frames get theirs in an isolated world: same-renderer frames directly,
 * cross-site frames through auto-attached child sessions. New and navigated
 * frames get one as their document appears.
 */
export function createBrowserFrameInspector(deps: BrowserFrameInspectorDeps) {
  const { sendDebuggerCommand, installScript, cleanupScript, logger } = deps;
  let active = false;
  /** Bumped by every start and stop; an install that finishes in another run undoes itself. */
  let run = 0;
  let sessions = new Map<string, InspectSession>();
  let contexts = new Map<string, InspectFrameContext>();
  const contextKey = (sessionId: string, contextId: number) => `${sessionId}:${contextId}`;
  const sessionArg = (sessionId: string) => sessionId === ROOT_SESSION ? undefined : sessionId;

  const installInFrame = async (wc: WebContents, sessionId: string, frameId: string): Promise<void> => {
    const installRun = run;
    try {
      const world = await sendDebuggerCommand<CdpCreateIsolatedWorldResponse>(wc, "Page.createIsolatedWorld", {
        frameId,
        worldName: INSPECT_FRAME_WORLD_NAME,
      }, sessionArg(sessionId));
      const contextId = world.executionContextId;
      if (typeof contextId !== "number" || installRun !== run || !sessions.has(sessionId)) return;
      await sendDebuggerCommand(wc, "Runtime.evaluate", {
        expression: installScript(INSPECT_FRAME_BINDING_NAME),
        contextId,
        returnByValue: true,
        awaitPromise: false,
        silent: true,
      }, sessionArg(sessionId));
      if (installRun !== run) {
        // Inspect stopped while the overlay went in, after stop's cleanup pass.
        await removeOverlay(wc, { contextId, frameId, sessionId });
        return;
      }
      contexts.set(contextKey(sessionId, contextId), { contextId, frameId, sessionId });
    } catch (error) {
      logger()?.warn("built_in_browser.inspect_frame_install_failed", { err: errorMessage(error) });
    }
  };

  const removeOverlay = async (wc: WebContents, context: InspectFrameContext): Promise<void> => {
    await sendDebuggerCommand(wc, "Runtime.evaluate", {
      expression: cleanupScript(),
      contextId: context.contextId,
      returnByValue: true,
      awaitPromise: false,
      silent: true,
    }, sessionArg(context.sessionId)).catch((error) => {
      const message = errorMessage(error);
      // A frame that navigated or closed took its overlay with it.
      if (/context|session|target/i.test(message) && /not found|cannot find|closed|detached/i.test(message)) return;
      logger()?.warn("built_in_browser.inspect_frame_cleanup_failed", { err: message });
    });
  };

  const exposeBinding = async (wc: WebContents, sessionId: string): Promise<void> => {
    await sendDebuggerCommand(wc, "Runtime.removeBinding", { name: INSPECT_FRAME_BINDING_NAME }, sessionArg(sessionId))
      .catch(() => {});
    await sendDebuggerCommand(wc, "Runtime.addBinding", {
      name: INSPECT_FRAME_BINDING_NAME,
      executionContextName: INSPECT_FRAME_WORLD_NAME,
    }, sessionArg(sessionId));
  };

  const setUpCrossSiteSession = async (wc: WebContents, sessionId: string): Promise<void> => {
    try {
      await exposeBinding(wc, sessionId);
      // Runtime.enable reports the frame's existing documents as
      // executionContextCreated, which installs the overlay; bindingCalled is
      // also only reported from a session with Runtime on.
      await sendDebuggerCommand(wc, "Runtime.enable", {}, sessionId);
      await sendDebuggerCommand(wc, "Target.setAutoAttach", AUTO_ATTACH_IFRAMES, sessionId);
    } catch (error) {
      logger()?.warn("built_in_browser.inspect_cross_site_frame_failed", { err: errorMessage(error) });
    }
  };

  /** Install in every frame below the main document, now and as frames appear. */
  const start = async (wc: WebContents): Promise<void> => {
    run += 1;
    active = true;
    sessions = new Map();
    contexts = new Map();
    const tree = await sendDebuggerCommand<CdpFrameTreeResponse>(wc, "Page.getFrameTree");
    sessions.set(ROOT_SESSION, { parentSessionId: null, rootFrameId: tree.frameTree?.frame?.id ?? null });
    await exposeBinding(wc, ROOT_SESSION);
    for (const frameId of childFrameIds(tree.frameTree)) await installInFrame(wc, ROOT_SESSION, frameId);
    // Reports existing cross-site frames as attachedToTarget, then new ones.
    await sendDebuggerCommand(wc, "Target.setAutoAttach", AUTO_ATTACH_IFRAMES);
  };

  /** Route a debugger event that belongs to frame inspection. Safe to call with any event. */
  const handleDebuggerMessage = (wc: WebContents, method: string, params: unknown, eventSessionId: string | undefined): void => {
    const sessionId = eventSessionId || ROOT_SESSION;
    if (method === "Target.attachedToTarget") {
      const attached = params as CdpAttachedToTargetParams;
      const childSessionId = attached.sessionId;
      if (!childSessionId) return;
      if (!active || attached.targetInfo?.type !== "iframe" || !sessions.has(sessionId)) {
        void sendDebuggerCommand(wc, "Target.detachFromTarget", { sessionId: childSessionId }).catch(() => {});
        return;
      }
      sessions.set(childSessionId, { parentSessionId: sessionId, rootFrameId: attached.targetInfo.targetId ?? null });
      void setUpCrossSiteSession(wc, childSessionId);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const detachedId = (params as { sessionId?: string }).sessionId;
      if (!detachedId) return;
      sessions.delete(detachedId);
      for (const [key, context] of contexts) {
        if (context.sessionId === detachedId) contexts.delete(key);
      }
      return;
    }
    if (method === "Runtime.executionContextCreated") {
      if (!active || !sessions.has(sessionId)) return;
      const context = (params as CdpExecutionContextCreatedParams).context;
      const frameId = context?.auxData?.frameId;
      // A page's own document only: isolated worlds (ours included) are not default.
      if (!frameId || context?.auxData?.isDefault !== true) return;
      void installInFrame(wc, sessionId, frameId);
    }
  };

  /** How a frame's viewport maps into the tab's. */
  const frameTransformInTab = async (
    wc: WebContents,
    frameId: string,
    sessionId: string,
    depth = 0,
  ): Promise<FrameTransform> => {
    const session = sessions.get(sessionId);
    if (!session || depth > MAX_FRAME_DEPTH) throw new Error("The iframe is no longer being inspected.");
    // A cross-site session's root frame is drawn by an <iframe> in the parent session.
    const sessionTransform = session.parentSessionId !== null && session.rootFrameId
      ? await frameTransformInTab(wc, session.rootFrameId, session.parentSessionId, depth + 1)
      : IDENTITY_FRAME_TRANSFORM;
    if (frameId === session.rootFrameId) return sessionTransform;
    // Any other frame is drawn by an <iframe> inside this session.
    return composeFrameTransforms(
      sessionTransform,
      await readFrameOwnerTransform(sendDebuggerCommand, wc, frameId, sessionArg(sessionId)),
    );
  };

  /** A click from a frame overlay arrives in that frame's viewport; map it into the tab's. Null when it is not ours. */
  const viewportPointForBinding = async (
    wc: WebContents,
    call: BrowserViewportPoint & { executionContextId: number },
    eventSessionId: string | undefined,
  ): Promise<BrowserViewportPoint | null> => {
    const sessionId = eventSessionId || ROOT_SESSION;
    const context = contexts.get(contextKey(sessionId, call.executionContextId));
    if (!active || !context) return null;
    return roundedPoint(frameToParentPoint(call, await frameTransformInTab(wc, context.frameId, sessionId)));
  };

  /** Remove every frame overlay and child session. Each step runs even if another fails. */
  const stop = async (wc: WebContents): Promise<void> => {
    run += 1;
    active = false;
    const staleContexts = [...contexts.values()];
    const staleSessions = [...sessions.keys()].filter((id) => id !== ROOT_SESSION);
    contexts = new Map();
    sessions = new Map();
    await sendDebuggerCommand(wc, "Target.setAutoAttach", { ...AUTO_ATTACH_IFRAMES, autoAttach: false }).catch(() => {});
    for (const context of staleContexts) await removeOverlay(wc, context);
    await sendDebuggerCommand(wc, "Runtime.removeBinding", { name: INSPECT_FRAME_BINDING_NAME }).catch(() => {});
    for (const sessionId of staleSessions) {
      await sendDebuggerCommand(wc, "Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  };

  return { start, stop, handleDebuggerMessage, viewportPointForBinding };
}
