/**
 * The observation and input half of the Mac Desktop service.
 *
 * Owns the one path a frame is captured on, how a target becomes a driver
 * payload, who a call claims to be for the lease check, and the eight acting
 * commands built on top of that — observe, click, type, press, scroll, drag,
 * wait and screenshot.
 *
 * Split out of `macDesktopService.ts` as pure code motion, with the same deps
 * shape `macDesktopStreaming.ts` uses: the service passes its registries and its
 * gates in, and keeps the API surface.
 */

import {
  MAC_DESKTOP_OBSERVATION_ELEMENT_LIMIT,
  type DesktopSeatProvider,
  type MacDesktopActionResult,
  type MacDesktopClickArgs,
  type MacDesktopDisplay,
  type MacDesktopDragArgs,
  type MacDesktopElement,
  type MacDesktopEventPayload,
  type MacDesktopInputMode,
  type MacDesktopObservation,
  type MacDesktopObserveArgs,
  type MacDesktopPressArgs,
  type MacDesktopScreenshotArgs,
  type MacDesktopScreenshotResult,
  type MacDesktopScrollArgs,
  type MacDesktopTarget,
  type MacDesktopTypeArgs,
  type MacDesktopWaitArgs,
  type MacDesktopWaitResult,
} from "../../../shared/types/macDesktop";
import type { MacDesktopLeaseRegistry } from "./macDesktopLease";
import type { MacDesktopObservations } from "./macDesktopObservations";
import type { MacDesktopOwnershipRegistry } from "./macDesktopOwnership";
import { asWindows } from "./macDesktopSeatProvider";

/** An observation asking for more than this is clamped. */
const MAX_OBSERVATION_LIMIT = MAC_DESKTOP_OBSERVATION_ELEMENT_LIMIT;

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 120_000;

const asNumber = (value: unknown, fallback: number): number =>
  (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const asNullableString = (value: unknown): string | null =>
  (typeof value === "string" && value.trim().length ? value.trim() : null);

const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

export type MacDesktopInputDeps = {
  now: () => number;
  emit: (payload: MacDesktopEventPayload) => void;
  /** Starts the backend if needed. Throws the same errors the service does. */
  ensureProvider: () => Promise<DesktopSeatProvider>;
  /** Throws `MAC_DESKTOP_NO_DISPLAY`; the display is what sizes a fallback. */
  requireDisplay: (laneId: string) => MacDesktopDisplay;
  assertPermission: (which: "screenRecording" | "accessibility") => void;
  observations: MacDesktopObservations;
  ownership: MacDesktopOwnershipRegistry;
  leases: MacDesktopLeaseRegistry;
  /** `streamServer.noteActivity`: a driven display is a watched display. */
  noteStreamActivity: (laneId: string) => void;
  /** `recording.noteTurnActivity`: the turn clip only runs while acts arrive. */
  noteTurnActivity: (laneId: string, chatSessionId: string | null | undefined) => void;
  /** Maps a driver/ownership/observation error onto the service's error type. */
  toServiceError: (error: unknown) => Error;
  /** Mints the service's own error, so this module owns no error class. */
  serviceError: (code: string, message: string) => Error;
};

export function createMacDesktopInput(deps: MacDesktopInputDeps) {
  const { observations, ownership, leases } = deps;
  const now = deps.now;

  async function observeInternal(
    args: MacDesktopObserveArgs & { caption?: string | null },
  ): Promise<MacDesktopObservation> {
    const laneId = args.laneId.trim();
    const display = deps.requireDisplay(laneId);
    const seat = await deps.ensureProvider();
    deps.assertPermission("screenRecording");
    const limit = Math.max(1, Math.min(MAX_OBSERVATION_LIMIT, Math.round(args.limit ?? MAX_OBSERVATION_LIMIT)));
    // Frames go to the one root `workToolsStateService.readObservationPreview`
    // will serve from, per lane, with the sidecar that binds the frame to its
    // lane — a frame written anywhere else is a frame the phone cannot show.
    const stem = `${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const screenshotPath = observations.observationPath(laneId, stem, "png");
    const mapPath = args.map ? observations.observationPath(laneId, `${stem}-map`, "png") : null;
    const reply = await seat.observe({
      laneId,
      windowId: args.windowId ?? null,
      limit,
      map: Boolean(args.map),
      screenshotPath,
      ...(mapPath ? { mapPath } : {}),
      ...(args.caption ? { caption: args.caption } : {}),
    });
    const elements = Array.isArray(reply.elements) ? reply.elements as MacDesktopElement[] : [];
    const observation: MacDesktopObservation = {
      id: asNullableString(reply.id) ?? `obs-${Math.random().toString(36).slice(2, 10)}`,
      laneId,
      capturedAt: asNullableString(reply.capturedAt) ?? new Date(now()).toISOString(),
      screenshotPath: asNullableString(reply.screenshotPath) ?? screenshotPath,
      mapPath: asNullableString(reply.mapPath),
      display: {
        width: asNumber(asRecord(reply.display).width, display.width),
        height: asNumber(asRecord(reply.display).height, display.height),
        scale: asNumber(asRecord(reply.display).scale, display.scale),
      },
      windows: asWindows(reply.windows),
      elements,
      elementCount: asNumber(reply.elementCount, elements.length),
      truncated: reply.truncated === true || asNumber(reply.elementCount, elements.length) > elements.length,
      caption: asNullableString(reply.caption) ?? args.caption?.trim() ?? null,
    };
    observations.writeObservationSidecar({
      imagePath: observation.screenshotPath,
      laneId,
      capturedAt: observation.capturedAt,
      caption: observation.caption,
    });
    if (observation.mapPath) {
      observations.writeObservationSidecar({
        imagePath: observation.mapPath,
        laneId,
        capturedAt: observation.capturedAt,
        caption: observation.caption,
      });
    }
    observations.remember(observation);
    ownership.touchDisplay(laneId);
    ownership.reconcileWindows(laneId, observation.windows);
    deps.emit({ type: "observation", laneId, observation });
    return observation;
  }

  /**
   * Turns a target into a driver payload.
   *
   * `handle` resolves locally, because only this process knows which
   * observation a handle belongs to and a stale one must be refused before the
   * driver is asked to click anything.
   */
  const resolveTarget = (laneId: string, target: MacDesktopTarget): {
    payload: Record<string, unknown>;
    element: MacDesktopElement | null;
    needsReal: boolean;
  } => {
    const handle = target.handle?.trim();
    if (handle) {
      const { element } = observations.resolveHandle(laneId, handle);
      return {
        payload: { handle, index: element.index, windowId: element.windowId, pid: element.pid },
        element,
        needsReal: false,
      };
    }
    const text = target.text?.trim();
    if (text) {
      return {
        payload: { text, ...(target.windowId != null ? { windowId: target.windowId } : {}) },
        element: null,
        needsReal: false,
      };
    }
    if (typeof target.x === "number" && typeof target.y === "number") {
      return {
        payload: { x: target.x, y: target.y, ...(target.windowId != null ? { windowId: target.windowId } : {}) },
        element: null,
        // A bare point has no element to act on, so it can only be delivered as
        // a real pointer event.
        needsReal: true,
      };
    }
    if (target.windowId != null) {
      return { payload: { windowId: target.windowId }, element: null, needsReal: false };
    }
    return { payload: {}, element: null, needsReal: false };
  };

  const leaseHolderId = (chatSessionId: string | null | undefined): string =>
    chatSessionId?.trim() || "anonymous-agent";

  /**
   * Who this call claims to be, for the lease check.
   *
   * A human takeover holds the lease under the controller id the viewing client
   * minted (`ade-window:<uuid>`), never under a chat session id — so a panel
   * that sent only its `chatSessionId` was refused with
   * `MAC_DESKTOP_USER_HAS_CONTROL` for the very input the user had taken
   * control to perform. `controllerId` authorizes nothing by itself: an id that
   * does not hold the lease is refused exactly as before, and the RPC scope
   * strips the field entirely from an agent's call so a holder id it read out of
   * `getStatus` is not a holder id it can wear.
   */
  const inputHolderId = (args: { controllerId?: string | null; chatSessionId?: string | null }): string =>
    args.controllerId?.trim() || leaseHolderId(args.chatSessionId);

  const assertRealInputAllowed = (laneId: string, holderId: string): void => {
    const decision = leases.checkRealInput({ laneId, holderId });
    if (decision.ok) return;
    throw deps.serviceError(decision.code, decision.message);
  };

  const runAction = async (args: {
    laneId: string;
    action: string;
    command: string;
    mode: MacDesktopInputMode;
    payload: Record<string, unknown>;
    resolved: MacDesktopElement | null;
    chatSessionId?: string | null;
    controllerId?: string | null;
    caption: string;
    target: Record<string, unknown> | null;
  }): Promise<MacDesktopActionResult> => {
    const laneId = args.laneId;
    deps.requireDisplay(laneId);
    const seat = await deps.ensureProvider();
    // Both modes drive the accessibility API: `real` posts a `CGEvent` at a
    // point this process resolved through that same tree.
    deps.assertPermission("accessibility");
    const holderId = inputHolderId(args);
    if (args.mode === "real") assertRealInputAllowed(laneId, holderId);
    const startedAt = new Date(now()).toISOString();
    const startedMs = now();
    let resolvedIndex: number | null = null;
    let failure: Error | null = null;
    try {
      const reply = await seat.input({
        laneId,
        command: args.command,
        mode: args.mode,
        payload: args.payload,
        // The helper keeps its own lease and refuses a `CGEvent` post rather
        // than trusting its caller. Telling it which holder this process just
        // authorized is what lets the two agree instead of racing.
        ...(args.mode === "real" ? { lease: { holderId } } : {}),
      });
      resolvedIndex = typeof reply.resolvedIndex === "number" ? reply.resolvedIndex : null;
    } catch (error) {
      failure = deps.toServiceError(error);
    }
    deps.noteStreamActivity(laneId);
    ownership.touchDisplay(laneId);
    deps.noteTurnActivity(laneId, args.chatSessionId);
    if (failure) throw failure;
    const observation = await observeInternal({
      laneId,
      chatSessionId: args.chatSessionId ?? null,
      caption: args.caption,
    });
    const endedAt = new Date(now()).toISOString();
    const resolved = args.resolved
      ?? (resolvedIndex != null
        ? observation.elements.find((element) => element.index === resolvedIndex) ?? null
        : null);
    return {
      ok: true,
      action: args.action,
      mode: args.mode,
      resolved,
      observation,
      trace: {
        id: `${observation.id}:${args.action}`,
        sessionId: args.chatSessionId?.trim() || null,
        action: args.action,
        status: "ok",
        startedAt,
        endedAt,
        durationMs: Math.max(0, now() - startedMs),
        before: { url: null, title: null },
        after: { url: null, title: null },
        target: args.target,
        observationId: observation.id,
        error: null,
      },
    };
  };

  const resolveMode = (
    requested: MacDesktopInputMode | null | undefined,
    needsReal: boolean,
  ): MacDesktopInputMode => (needsReal ? "real" : requested ?? "accessibility");

  return {
    /** The one capture path. The service's `observe` is this plus the gate. */
    observe: observeInternal,

    async click(args: MacDesktopClickArgs): Promise<MacDesktopActionResult> {
      const laneId = args.laneId.trim();
      const target = resolveTarget(laneId, args);
      const mode = resolveMode(args.mode, target.needsReal);
      const label = target.element?.title ?? target.element?.label ?? args.text ?? "point";
      return await runAction({
        laneId,
        action: "click",
        command: "click",
        mode,
        payload: {
          ...target.payload,
          button: args.button ?? "left",
          count: Math.max(1, Math.min(3, Math.round(args.count ?? 1))),
        },
        resolved: target.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: `click · ${label}`,
        target: { ...target.payload },
      });
    },

    async type(args: MacDesktopTypeArgs): Promise<MacDesktopActionResult> {
      const laneId = args.laneId.trim();
      const target = args.target ? resolveTarget(laneId, args.target) : { payload: {}, element: null, needsReal: false };
      const mode = resolveMode(args.mode, target.needsReal);
      return await runAction({
        laneId,
        action: "type",
        command: "type",
        mode,
        payload: { ...target.payload, text: args.text, clear: args.clear === true },
        resolved: target.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: `type · ${args.text.slice(0, 40)}`,
        target: { ...target.payload },
      });
    },

    async press(args: MacDesktopPressArgs): Promise<MacDesktopActionResult> {
      const laneId = args.laneId.trim();
      return await runAction({
        laneId,
        action: "press",
        command: "press",
        mode: args.mode ?? "accessibility",
        payload: { key: args.key, modifiers: args.modifiers ?? [] },
        resolved: null,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: `press · ${[...(args.modifiers ?? []), args.key].join("+")}`,
        target: { key: args.key, modifiers: args.modifiers ?? [] },
      });
    },

    async scroll(args: MacDesktopScrollArgs): Promise<MacDesktopActionResult> {
      const laneId = args.laneId.trim();
      const target = resolveTarget(laneId, args);
      const mode = resolveMode(args.mode, target.needsReal);
      return await runAction({
        laneId,
        action: "scroll",
        command: "scroll",
        mode,
        payload: {
          ...target.payload,
          direction: args.direction,
          amount: Math.max(1, Math.min(50, Math.round(args.amount ?? 3))),
        },
        resolved: target.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: `scroll · ${args.direction}`,
        target: { ...target.payload, direction: args.direction },
      });
    },

    async drag(args: MacDesktopDragArgs): Promise<MacDesktopActionResult> {
      const laneId = args.laneId.trim();
      const from = resolveTarget(laneId, args.from);
      const to = resolveTarget(laneId, args.to);
      // A drag has no accessibility action anywhere in AppKit, so it is always
      // a real pointer sequence and always behind the lease.
      return await runAction({
        laneId,
        action: "drag",
        command: "drag",
        mode: "real",
        payload: {
          from: from.payload,
          to: to.payload,
          durationMs: Math.max(0, Math.min(10_000, Math.round(args.durationMs ?? 500))),
        },
        resolved: from.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: "drag",
        target: { from: from.payload, to: to.payload },
      });
    },

    async wait(args: MacDesktopWaitArgs): Promise<MacDesktopWaitResult> {
      const laneId = args.laneId.trim();
      deps.requireDisplay(laneId);
      const seat = await deps.ensureProvider();
      const timeoutMs = Math.max(0, Math.min(MAX_WAIT_TIMEOUT_MS, Math.round(args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)));
      const startedMs = now();
      const reply = await seat.input({
        laneId,
        command: "wait",
        mode: "accessibility",
        payload: {
          text: args.text ?? null,
          gone: args.gone ?? null,
          windowTitle: args.windowTitle ?? null,
          timeoutMs,
        },
        timeoutMs: timeoutMs + 5_000,
      });
      const observation = await observeInternal({
        laneId,
        chatSessionId: args.chatSessionId ?? null,
        caption: "wait",
      });
      const matchedIndex = typeof reply.resolvedIndex === "number" ? reply.resolvedIndex : null;
      return {
        // The driver answers `ok` itself: a `gone` or `windowTitle` wait
        // succeeds with no element, so an index is evidence of a match rather
        // than the definition of success.
        ok: reply.ok === true,
        waitedMs: Math.max(0, now() - startedMs),
        matched: matchedIndex != null
          ? observation.elements.find((element) => element.index === matchedIndex) ?? null
          : null,
        observation,
      };
    },

    async screenshot(args: MacDesktopScreenshotArgs): Promise<MacDesktopScreenshotResult> {
      const laneId = args.laneId.trim();
      const display = deps.requireDisplay(laneId);
      const seat = await deps.ensureProvider();
      deps.assertPermission("screenRecording");
      const filePath = args.out
        ? await observations.resolveOutPath({ laneId, out: args.out })
        : observations.scratchPath(`mac-desktop-${laneId}`, "png");
      const reply = await seat.screenshot({
        laneId,
        windowId: args.windowId ?? null,
        path: filePath,
      });
      ownership.touchDisplay(laneId);
      return {
        laneId,
        filePath: asNullableString(reply.filePath) ?? filePath,
        width: asNumber(reply.width, display.width),
        height: asNumber(reply.height, display.height),
        capturedAt: asNullableString(reply.capturedAt) ?? new Date(now()).toISOString(),
      };
    },
  };
}

export type MacDesktopInput = ReturnType<typeof createMacDesktopInput>;
