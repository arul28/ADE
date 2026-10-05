/**
 * The observation and input half of the Mac Desktop service.
 *
 * Owns the one path a frame is captured on, how a target becomes a driver
 * payload, who a call claims to be for the lease check, and the eight acting
 * commands built on top of that — observe, click, type, press, scroll, drag,
 * move, wait and screenshot.
 *
 * Split out of `macDesktopService.ts` as pure code motion, with the same deps
 * shape `macDesktopStreaming.ts` uses: the service passes its registries and its
 * gates in, and keeps the API surface.
 */

import type { DemoTrackEventKind } from "../../../shared/demoVideo/demoContract";
import { demoTrackRegistry } from "../demoVideo/demoTrackRegistry";
import { demoTypedLabelForField } from "../demoVideo/demoTrackTargets";
import { macDesktopNextStep, macDesktopRefusedNextStep } from "./macDesktopNextStep";
import { macDesktopDemoKey } from "./macDesktopRecording";
import { MAC_DESKTOP_ANONYMOUS_HOLDER_ID } from "./macDesktopLeaseFlow";
import {
  MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
  MAC_DESKTOP_OBSERVATION_ELEMENT_LIMIT,
  WINDOWS_DESKTOP_MAX_TYPED_CHARS,
  desktopSeatKind,
  windowsDesktopTypeTimeoutMs,
  type DesktopSeatKind,
  type DesktopSeatProvider,
  type MacDesktopClickArgs,
  type MacDesktopDisplay,
  type MacDesktopDragArgs,
  type MacDesktopElement,
  type MacDesktopEventPayload,
  type MacDesktopInputMode,
  type MacDesktopInputResult,
  type MacDesktopMoveArgs,
  type MacDesktopObservation,
  type MacDesktopObserveArgs,
  type MacDesktopRealInputCommand,
  type MacDesktopPressArgs,
  type MacDesktopReleaseInputArgs,
  type MacDesktopScreenshotArgs,
  type MacDesktopScreenshotResult,
  type MacDesktopScrollArgs,
  type MacDesktopTarget,
  type MacDesktopTypeArgs,
  type MacDesktopWaitArgs,
  type MacDesktopWaitResult,
} from "../../../shared/types/macDesktop";
import {
  agentEffectElementKey,
  compareAgentEffectFingerprints,
  type AgentEffectFingerprint,
} from "../../../shared/agentObservation";
import type { ComputerUseActionEffect } from "../../../shared/types/agentObservation";
import { sleep } from "../shared/utils";
import { MAC_DESKTOP_GESTURE_IN_FLIGHT_CODE } from "./macDesktopDriverClient";
import type { MacDesktopLeaseRegistry } from "./macDesktopLease";
import type { MacDesktopObservations } from "./macDesktopObservations";
import type { MacDesktopOwnershipRegistry } from "./macDesktopOwnership";
import { asNullableString, asNumber, asRecord, asWalkStop, asWindows } from "./macDesktopSeatProvider";

/** An observation asking for more than this is clamped. */
const MAX_OBSERVATION_LIMIT = MAC_DESKTOP_OBSERVATION_ELEMENT_LIMIT;

/** How long a refused `wait` sits out a real gesture before asking again. */
const GESTURE_RETRY_DELAY_MS = 250;

/**
 * The driver's "not while the mouse button is down" refusal for `wait`.
 *
 * Matched on the code rather than the message: it is the one driver failure
 * that is worth retrying instead of surfacing, because the gesture that caused
 * it ends on its own.
 */
const isGestureInFlight = (error: unknown): boolean =>
  asRecord(error).code === MAC_DESKTOP_GESTURE_IN_FLIGHT_CODE;

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

/** The driver client's "did not answer in time", as opposed to a refusal. */
const isDriverRequestTimeout = (error: unknown): boolean =>
  error instanceof Error && /did not answer .* in \d+ms/.test(error.message);
const MAX_WAIT_TIMEOUT_MS = 120_000;

/**
 * An observation as an action-effect fingerprint: the parked windows, the
 * focused element, and every listed element's role, name, value and rounded
 * frame. Handles and indexes are left out — they are new in every observation.
 */
export function macDesktopEffectFingerprint(observation: MacDesktopObservation): AgentEffectFingerprint {
  const focused = observation.elements.find((element) => element.focused) ?? null;
  return {
    windows: observation.windows
      .map((window) => `${window.id}:${window.title ?? ""}:${window.minimized ? "min" : ""}`)
      .sort()
      .join("|"),
    focus: focused
      ? [focused.role, focused.title ?? "", focused.label ?? "", focused.identifier ?? "", focused.windowId ?? ""].join("|")
      : null,
    elementCount: observation.elementCount,
    elements: observation.elements.map((element) =>
      agentEffectElementKey({
        role: element.subrole ? `${element.role}/${element.subrole}` : element.role,
        label: element.title ?? element.label,
        value: element.value,
        text: element.identifier,
        disabled: !element.enabled,
        frame: element.frame,
      })),
    truncated: observation.truncated,
  };
}

/**
 * Did the action change the accessibility tree?
 *
 * The comparison is against the observation the target was resolved against,
 * which is the newest one this process holds for the lane. That is the right
 * "before" for an agent that observes, then acts. It is not a fresh read, so a
 * lane with no observation yet answers `not_checked` instead of guessing.
 */
export function macDesktopActionEffect(
  before: MacDesktopObservation | null,
  after: MacDesktopObservation,
): ComputerUseActionEffect {
  return compareAgentEffectFingerprints(
    before ? macDesktopEffectFingerprint(before) : null,
    macDesktopEffectFingerprint(after),
    { missingReason: "there was no earlier observation of this lane to compare with" },
  );
}

export type MacDesktopInputDeps = {
  now: () => number;
  /**
   * The seat's host. A Windows private seat is a separate session with its own
   * pointer and keyboard, so real input there needs no lease; a Mac display and
   * a Windows shared seat both share the one real pointer with the user.
   */
  platform?: NodeJS.Platform;
  /**
   * Windows shared seat: the user's consent to the shared seat covers real
   * input for this lane, so the acting chat takes the lane's lease here rather
   * than asking again. Refuses while another lane's shared seat is driving the
   * same main desktop. Called only for a Windows shared seat.
   */
  takeSharedSeatLease: (laneId: string, holderId: string) => Promise<void>;
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
  /**
   * An acting command succeeded for a caller that is not a human takeover.
   * No id: the service's analytics emitter is the only consumer.
   */
  onAgentActed?: (() => void) | null;
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
      truncatedReason: asWalkStop(reply.truncatedReason),
      stalledApps: Array.isArray(reply.stalledApps)
        ? reply.stalledApps.filter((app): app is string => typeof app === "string" && app.length > 0)
        : [],
      caption: asNullableString(reply.caption) ?? args.caption?.trim() ?? null,
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(display.seatMode ? { seatMode: display.seatMode } : {}),
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

  /** A bare `{x, y}` in a driver payload (a drag's `from`), global points. */
  const pointOf = (payload: Record<string, unknown>): { x: number; y: number } | null => {
    const source = (payload.from && typeof payload.from === "object" ? payload.from : payload) as Record<string, unknown>;
    return typeof source.x === "number" && typeof source.y === "number" ? { x: source.x, y: source.y } : null;
  };

  /**
   * A click's button and count, so the next-step advice reproduces the click.
   * Empty for every other action, whose payload carries neither field.
   */
  const clickShape = (payload: Record<string, unknown>): { button?: string; count?: number } => ({
    ...(typeof payload.button === "string" ? { button: payload.button } : {}),
    ...(typeof payload.count === "number" ? { count: payload.count } : {}),
  });

  /**
   * Notes one action on the lane's running recording, in the display's own
   * frame: element frames and points are global screen points, the recording
   * is the lane's display. A lane that is not recording notes nothing.
   */
  const noteDemoAction = (laneId: string, action: {
    kind: DemoTrackEventKind;
    label: string | null;
    element: MacDesktopElement | null;
    point: { x: number; y: number } | null;
    by: "agent" | "user";
  }): void => {
    const key = macDesktopDemoKey(laneId);
    if (!demoTrackRegistry.isRecording(key)) return;
    let display: MacDesktopDisplay;
    try {
      display = deps.requireDisplay(laneId);
    } catch {
      return;
    }
    if (display.width <= 0 || display.height <= 0) return;
    const nx = (x: number) => (x - display.origin.x) / display.width;
    const ny = (y: number) => (y - display.origin.y) / display.height;
    const frame = action.element?.frame ?? null;
    const center = action.element?.center ?? action.point;
    demoTrackRegistry.note(key, {
      kind: action.kind,
      by: action.by,
      ...(center ? { x: nx(center.x), y: ny(center.y) } : {}),
      ...(frame ? { rect: [nx(frame.x), ny(frame.y), frame.width / display.width, frame.height / display.height] } : {}),
      // A type event's label is the typed text itself (already filtered), never
      // the field's name: the caption reads `Type "<label>"`.
      label: action.kind === "type"
        ? action.label ?? undefined
        : action.label ?? action.element?.title ?? action.element?.label ?? undefined,
    });
  };

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
   *
   * After the chat comes `holderId`: the one stable holder a trusted caller
   * with no chat acts as (`MacDesktopTrustedHolderArgs`), which the RPC scope
   * also strips from every agent. With none of the three, the caller is the
   * anonymous holder, which no consent covers.
   */
  const inputHolderId = (args: { controllerId?: string | null; chatSessionId?: string | null; holderId?: string | null }): string =>
    args.controllerId?.trim() || args.chatSessionId?.trim() || args.holderId?.trim() || MAC_DESKTOP_ANONYMOUS_HOLDER_ID;

  /**
   * May this call skip its own observation?
   *
   * Only a human takeover may. `silent` is not honoured on its own, because it
   * arrives from the same argument object an agent controls: it takes
   * `mode: "real"` AND a `controllerId`, and a `controllerId` that does not hold
   * the lease is refused a line later by {@link assertRealInputAllowed}. So the
   * only caller that can be silent is the one holding the user's lease under a
   * controller id — which is what a takeover is and what an agent never has.
   */
  const isSilent = (
    args: { silent?: boolean | null; controllerId?: string | null },
    mode: MacDesktopInputMode,
  ): boolean => args.silent === true && mode === "real" && Boolean(args.controllerId?.trim());

  const assertRealInputAllowed = (laneId: string, holderId: string): void => {
    const decision = leases.checkRealInput({ laneId, holderId });
    if (decision.ok) return;
    throw deps.serviceError(decision.code, decision.message);
  };

  /** The lane's seat kind, or null when it has no screen. */
  const seatOf = (laneId: string, display?: MacDesktopDisplay): DesktopSeatKind | null => {
    let current = display ?? null;
    if (!current) {
      try {
        current = deps.requireDisplay(laneId);
      } catch {
        return null;
      }
    }
    return desktopSeatKind({ platform: deps.platform, display: current });
  };

  /**
   * The lease rule, per seat.
   *
   * - Mac: the lease, always. Real input moves the user's one pointer.
   * - Windows private: no lease. The seat is a separate Windows session with
   *   its own pointer and keyboard, so nothing of the user's moves. A person
   *   who took control from the pane, or another chat holding the lease, still
   *   wins: those refusals stand.
   * - Windows shared: the lease, taken for the acting chat on the strength of
   *   the user's shared-seat consent (only a consented lane has a shared seat).
   */
  const authorizeRealInput = async (
    laneId: string,
    display: MacDesktopDisplay,
    holderId: string,
    controllerId: string | null | undefined,
  ): Promise<void> => {
    const seat = seatOf(laneId, display);
    if (seat === "windows-private") {
      const decision = leases.checkRealInput({ laneId, holderId });
      if (decision.ok || decision.code === MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE) return;
      throw deps.serviceError(decision.code, decision.message);
    }
    if (seat === "windows-shared" && !controllerId?.trim()) {
      await deps.takeSharedSeatLease(laneId, holderId);
    }
    assertRealInputAllowed(laneId, holderId);
  };

  /**
   * Windows shared seat: an Accessibility (UIA) action takes the user's
   * foreground as surely as real input does, so it goes through the same
   * per-host lease. Two shared lanes then cannot fight over the one pointer
   * and foreground: the second is refused with MAC_DESKTOP_LEASE_HELD_BY_OTHER
   * naming the lane that holds it. A person who took control keeps it. No-op
   * on the Mac and on a private seat (its own session, its own foreground).
   */
  const claimSharedSeatForeground = async (
    laneId: string,
    args: { chatSessionId?: string | null; controllerId?: string | null; holderId?: string | null },
  ): Promise<void> => {
    if (args.controllerId?.trim() || seatOf(laneId) !== "windows-shared") return;
    const holderId = inputHolderId(args);
    await deps.takeSharedSeatLease(laneId, holderId);
    assertRealInputAllowed(laneId, holderId);
  };

  /** A Windows shared seat sends keys only as real input (the driver's rule). */
  const isSharedSeat = (laneId: string): boolean => seatOf(laneId) === "windows-shared";

  const runAction = async (args: {
    laneId: string;
    action: string;
    command: string;
    mode: MacDesktopInputMode;
    payload: Record<string, unknown>;
    resolved: MacDesktopElement | null;
    chatSessionId?: string | null;
    controllerId?: string | null;
    holderId?: string | null;
    caption: string;
    target: Record<string, unknown> | null;
    /** A human takeover: act, and do not look. */
    silent?: boolean;
    /** The first step of two: the second one observes, so this one does not. */
    skipObservation?: boolean;
    /** What a running recording's demo track notes about this action. */
    demo?: { kind: DemoTrackEventKind; label?: string | null } | null;
    /** The driver budget, when this action takes longer than a usual request. */
    timeoutMs?: number;
    /** The error to throw instead when that budget runs out. */
    timeoutError?: () => Error;
  }): Promise<MacDesktopInputResult> => {
    const laneId = args.laneId;
    const display = deps.requireDisplay(laneId);
    const seat = await deps.ensureProvider();
    // Both modes drive the accessibility API: `real` posts a `CGEvent` at a
    // point this process resolved through that same tree.
    deps.assertPermission("accessibility");
    const holderId = inputHolderId(args);
    if (args.mode === "real") {
      await authorizeRealInput(laneId, display, holderId, args.controllerId);
      // A synthetic event posted without Accessibility is dropped by macOS
      // with no error, which is how a takeover looked like a dead screen. Say
      // so instead, with the grant named.
      deps.assertPermission("accessibility");
    } else {
      await claimSharedSeatForeground(laneId, args);
    }
    const startedAt = new Date(now()).toISOString();
    const startedMs = now();
    // The driver resolves a text target against its newest observation, which
    // is this one. The index it answers with belongs to this tree, never to the
    // observation taken after the action: once a click closes a panel, that
    // index is gone from the new tree, or names a different element in it.
    const resolvedAgainst = observations.latest(laneId);
    let resolvedIndex: number | null = null;
    let failure: Error | null = null;
    try {
      // A silent takeover posts `CGEvent`s at virtual-display coordinates,
      // which teleports the one system cursor off ADE. The helper restores
      // it after the post so Electron keeps receiving pointer events. Agent
      // real-input leaves this off so the pointer stays where the action put
      // it. Gated on `controllerId` as well as `silent`: `move` is silent by
      // construction even for a caller that is not a takeover.
      const restoreCursor = Boolean(args.silent && args.controllerId?.trim());
      const reply = await seat.input({
        laneId,
        command: args.command,
        mode: args.mode,
        payload: restoreCursor ? { ...args.payload, restoreCursor: true } : args.payload,
        // The helper keeps its own lease and refuses a `CGEvent` post rather
        // than trusting its caller. Telling it which holder this process just
        // authorized is what lets the two agree instead of racing.
        ...(args.mode === "real" ? { lease: { holderId } } : {}),
        ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      });
      resolvedIndex = typeof reply.resolvedIndex === "number" ? reply.resolvedIndex : null;
    } catch (error) {
      failure = args.timeoutError && isDriverRequestTimeout(error)
        ? args.timeoutError()
        : deps.toServiceError(error);
    }
    deps.noteStreamActivity(laneId);
    ownership.touchDisplay(laneId);
    deps.noteTurnActivity(laneId, args.chatSessionId);
    if (failure) {
      const refused = macDesktopRefusedNextStep({
        action: args.action,
        mode: args.mode,
        message: failure.message,
        resolved: args.resolved,
        before: resolvedAgainst,
        ...clickShape(args.payload),
        lease: leases.checkRealInput({ laneId, holderId }),
      });
      if (!refused) throw failure;
      const code = (failure as { code?: unknown }).code;
      const message = `${failure.message.replace(/^[A-Za-z_]+: /, "")} Next: ${refused.reason}${refused.command ? ` — run: ${refused.command}` : ""}`;
      throw typeof code === "string" ? deps.serviceError(code, message) : new Error(message);
    }
    if (args.demo) {
      const element = args.resolved
        ?? (resolvedIndex != null ? resolvedAgainst?.elements.find((entry) => entry.index === resolvedIndex) ?? null : null);
      noteDemoAction(laneId, {
        kind: args.demo.kind,
        label: args.demo.label ?? null,
        element,
        point: pointOf(args.payload),
        by: args.controllerId?.trim() ? "user" : "agent",
      });
    }
    // A human takeover always carries a controller id; the action bus strips
    // that field from every agent-shaped caller. The fast path never reaches
    // here, so a person's pointer does not count as an agent driving.
    if (!args.controllerId?.trim()) deps.onAgentActed?.();
    // The one early return. Everything above it — the lease check, the driver
    // call, the activity notes — is identical; what a silent call skips is the
    // capture, the AX walk, the `observation` event and the caption that would
    // have narrated the user's own keystroke back at them.
    if (args.silent || args.skipObservation) {
      return { ok: true, action: args.action, mode: args.mode, silent: true, resolved: null, observation: null, trace: null };
    }
    const observation = await observeInternal({
      laneId,
      chatSessionId: args.chatSessionId ?? null,
      caption: args.caption,
    });
    const endedAt = new Date(now()).toISOString();
    const resolved = args.resolved
      ?? (resolvedIndex != null
        ? resolvedAgainst?.elements.find((element) => element.index === resolvedIndex) ?? null
        : null);
    const compared = macDesktopActionEffect(resolvedAgainst, observation);
    const next = macDesktopNextStep({
      action: args.action,
      mode: args.mode,
      effect: compared,
      resolved,
      before: resolvedAgainst,
      ...clickShape(args.payload),
      lease: leases.checkRealInput({ laneId, holderId }),
    });
    return {
      ok: true,
      action: args.action,
      mode: args.mode,
      resolved,
      observation,
      effect: next ? { ...compared, next } : compared,
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

  /**
   * The fast path for a human takeover.
   *
   * The ordinary path is renderer → IPC → main → brain RPC → this service →
   * driver stdin, which costs a full RPC round trip per pointer event and at
   * sixty moves a second never drains, so clicks queue behind moves. This is
   * the same call with the same gates — lease, Accessibility, display — but
   * reached over the stream server's loopback endpoint the panel already holds
   * a token for, so an event is one local HTTP request straight into the
   * driver. Silent by definition: nobody narrates their own mouse.
   */
  const postRealInput = async (args: {
    laneId: string;
    controllerId: string;
    chatSessionId?: string | null;
    command: MacDesktopRealInputCommand;
    payload: Record<string, unknown>;
  }): Promise<void> => {
    const laneId = args.laneId.trim();
    deps.requireDisplay(laneId);
    const seat = await deps.ensureProvider();
    deps.assertPermission("accessibility");
    const holderId = inputHolderId(args);
    assertRealInputAllowed(laneId, holderId);
    try {
      await seat.input({
        laneId,
        command: args.command,
        mode: "real",
        // The takeover decides what happens to the system cursor, not this
        // line: a viewer driving with a locked pointer sends `holdCursor` and
        // the driver keeps the cursor on the lane's display until the
        // `releaseCursor` that ends the session. Forcing a warp home after
        // every event here is what made a wheel turn arrive seconds late.
        payload: args.payload,
        lease: { holderId },
      });
    } catch (error) {
      throw deps.toServiceError(error);
    }
    deps.noteStreamActivity(laneId);
    ownership.touchDisplay(laneId);
    deps.noteTurnActivity(laneId, args.chatSessionId);
    // A person's own clicks on the live view count for the demo too; their
    // pointer moves do not (sixty a second, and the drawn pointer follows
    // actions, not motion).
    if (args.command === "click") {
      noteDemoAction(laneId, { kind: "click", label: null, element: null, point: pointOf(args.payload), by: "user" });
    }
  };

  return {
    postRealInput,
    claimSharedSeatForeground,
    /** The one capture path. The service's `observe` is this plus the gate. */
    observe: observeInternal,

    async click(args: MacDesktopClickArgs): Promise<MacDesktopInputResult> {
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
        holderId: args.holderId ?? null,
        silent: isSilent(args, mode),
        caption: `click · ${label}`,
        demo: { kind: "click", label: label === "point" ? null : label },
        target: { ...target.payload },
      });
    },

    async type(args: MacDesktopTypeArgs): Promise<MacDesktopInputResult> {
      const laneId = args.laneId.trim();
      const target = args.target ? resolveTarget(laneId, args.target) : { payload: {}, element: null, needsReal: false };
      // `--clear` on the Windows main desktop is a real Ctrl+A.
      const mode = resolveMode(args.mode, target.needsReal || (args.clear === true && args.mode == null && isSharedSeat(laneId)));
      // Windows sends keystrokes one character at a time with a pause after
      // each (real input, and every type on the private seat, which is its own
      // session), so that typing gets a budget that grows with the text and a
      // cap the driver refuses past. Accessibility typing on the shared seat
      // sets the value or posts the text at once.
      const perCharacter = deps.platform === "win32" && (mode === "real" || seatOf(laneId) === "windows-private");
      if (perCharacter && args.text.length > WINDOWS_DESKTOP_MAX_TYPED_CHARS) {
        throw new Error(
          `Windows Desktop types at most ${WINDOWS_DESKTOP_MAX_TYPED_CHARS} characters of real input in one call; this text has ${args.text.length}. Split it into several type calls.`,
        );
      }
      const typeTimeoutMs = perCharacter ? windowsDesktopTypeTimeoutMs(args.text.length) : undefined;
      const silent = isSilent(args, mode);
      const submit = args.submit === true;
      const caption = `type · ${args.text.slice(0, 40)}`;
      const typed = await runAction({
        laneId,
        action: "type",
        command: "type",
        mode,
        // The words ride `typeText`, so a text target's label in `text` is not
        // overwritten by them. The driver reads `text` as the words only when
        // `typeText` is absent (an older service), and then never as a label.
        payload: { ...target.payload, typeText: args.text, clear: args.clear === true },
        ...(typeTimeoutMs ? {
          timeoutMs: typeTimeoutMs,
          timeoutError: () => deps.serviceError(
            "MAC_DESKTOP_DRIVER_UNAVAILABLE",
            `Windows Desktop did not finish typing ${args.text.length} characters within ${Math.round(typeTimeoutMs / 1000)} s. It may still be typing: observe the screen before typing again.`,
          ),
        } : {}),
        resolved: target.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        holderId: args.holderId ?? null,
        silent,
        skipObservation: submit,
        caption,
        // Only for a named field that is not a secure (password) field: a demo
        // goes to a pull request, and text typed into whatever had focus may
        // be a password.
        demo: {
          kind: "type",
          label: target.element && target.element.subrole !== "AXSecureTextField" && target.element.role !== "AXSecureTextField"
            ? demoTypedLabelForField(args.text, [target.element.title, target.element.label, target.element.identifier, target.element.help])
            : null,
        },
        target: { ...target.payload },
      });
      if (!submit) return typed;
      // `submit` presses Return after the words, as `apple type --submit`
      // does: a newline is hard to write in a shell argument. The key goes to
      // the element that took the words — the named target, or else the
      // focused element of the newest observation, which is the one the
      // driver types into when no target is named.
      const focusedHandle = args.target
        ? null
        : observations.latest(laneId)?.elements.find((element) => element.focused)?.handle ?? null;
      return await runAction({
        laneId,
        action: "type",
        command: "press",
        mode,
        payload: {
          ...(args.target ? target.payload : focusedHandle ? { handle: focusedHandle } : {}),
          key: "return",
          modifiers: [],
        },
        resolved: target.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        holderId: args.holderId ?? null,
        silent,
        caption: `${caption} · return`,
        target: { ...target.payload, key: "return" },
      });
    },

    async press(args: MacDesktopPressArgs): Promise<MacDesktopInputResult> {
      const laneId = args.laneId.trim();
      if (deps.platform !== "win32" && (args.modifiers ?? []).includes("win")) {
        throw new Error("A Mac has no Windows key. Use --cmd, --ctrl, --alt or --shift.");
      }
      // The Windows main desktop takes keys only as real input; asking for
      // accessibility there was a refusal with no way forward.
      const mode = args.mode ?? (isSharedSeat(laneId) ? "real" : "accessibility");
      return await runAction({
        laneId,
        action: "press",
        command: "press",
        mode,
        payload: { key: args.key, modifiers: args.modifiers ?? [] },
        resolved: null,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        holderId: args.holderId ?? null,
        silent: isSilent(args, mode),
        caption: `press · ${[...(args.modifiers ?? []), args.key].join("+")}`,
        demo: { kind: "key", label: [...(args.modifiers ?? []), args.key].join("+") },
        target: { key: args.key, modifiers: args.modifiers ?? [] },
      });
    },

    async scroll(args: MacDesktopScrollArgs): Promise<MacDesktopInputResult> {
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
        holderId: args.holderId ?? null,
        silent: isSilent(args, mode),
        caption: `scroll · ${args.direction}`,
        demo: { kind: "scroll", label: null },
        target: { ...target.payload, direction: args.direction },
      });
    },

    async drag(args: MacDesktopDragArgs): Promise<MacDesktopInputResult> {
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
        holderId: args.holderId ?? null,
        silent: isSilent(args, "real"),
        caption: "drag",
        demo: { kind: "drag", label: null },
        target: { from: from.payload, to: to.payload },
      });
    },

    /**
     * The pointer, moved and nothing else.
     *
     * Real by construction and silent by construction: the only caller is a
     * human dragging their mouse across the live view, at up to sixty events a
     * second, and neither an accessibility "move" nor sixty observations exist.
     * The lease check is the same one every other real event goes through, so a
     * move with no lease is refused exactly like a click with no lease.
     */
    async move(args: MacDesktopMoveArgs): Promise<MacDesktopInputResult> {
      const laneId = args.laneId.trim();
      return await runAction({
        laneId,
        action: "move",
        command: "move",
        mode: "real",
        payload: { to: { x: args.x, y: args.y } },
        resolved: null,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        holderId: args.holderId ?? null,
        silent: args.silent !== false,
        caption: "move",
        target: { x: args.x, y: args.y },
      });
    },

    /**
     * The panic release behind Escape. See {@link MacDesktopReleaseInputArgs}.
     *
     * Deliberately not `runAction`: that path re-observes the screen and files
     * the result, and this call exists for the moment when the viewer's
     * transport is already misbehaving. It posts one command and returns.
     *
     * `home` is passed straight through without the display check every other
     * command gets. It is the only coordinate in this file that points AWAY
     * from the lane on purpose — it is the person's own pointer, on their own
     * screen, and clamping it to the lane's display would strand the cursor
     * exactly where Escape is trying to rescue it from.
     */
    async releaseInput(args: MacDesktopReleaseInputArgs): Promise<MacDesktopInputResult> {
      const laneId = args.laneId.trim();
      const button = args.button === "right" ? "right" : args.button === "left" ? "left" : null;
      const home = args.homeX == null || args.homeY == null
        ? null
        : { x: args.homeX, y: args.homeY };
      await postRealInput({
        laneId,
        command: "releaseInput",
        payload: {
          ...(button ? { button } : {}),
          ...(home ? { home } : {}),
        },
        // Required, not optional: the release is real input and is checked
        // against the lease like any other. A caller with no controller id
        // holds nothing, so it has nothing to release.
        controllerId: (args.controllerId ?? "").trim(),
        chatSessionId: args.chatSessionId ?? null,
      });
      return {
        ok: true,
        action: "releaseInput",
        mode: "real",
        silent: true,
        resolved: null,
        observation: null,
        trace: null,
      };
    },

    async wait(args: MacDesktopWaitArgs): Promise<MacDesktopWaitResult> {
      const laneId = args.laneId.trim();
      deps.requireDisplay(laneId);
      const seat = await deps.ensureProvider();
      const timeoutMs = Math.max(0, Math.min(MAX_WAIT_TIMEOUT_MS, Math.round(args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)));
      const startedMs = now();
      const deadlineMs = startedMs + timeoutMs;
      // The driver refuses a `wait` outright while a real gesture holds the
      // mouse button: the request would be handled on the main thread nested
      // inside the drag's own run-loop pump, so polling there would keep the
      // button down for the whole timeout. A gesture is a bounded, human-scale
      // thing, so the right answer is to come back — but only until this wait's
      // own deadline, which is the one clock the caller agreed to.
      let reply: Awaited<ReturnType<typeof seat.input>> = { ok: false };
      while (true) {
        const remainingMs = Math.max(0, deadlineMs - now());
        try {
          reply = await seat.input({
            laneId,
            command: "wait",
            mode: "accessibility",
            payload: {
              text: args.text ?? null,
              gone: args.gone ?? null,
              windowTitle: args.windowTitle ?? null,
              timeoutMs: remainingMs,
            },
            timeoutMs: remainingMs + 5_000,
          });
          break;
        } catch (error) {
          if (!isGestureInFlight(error)) throw error;
          const untilDeadlineMs = deadlineMs - now();
          if (untilDeadlineMs <= 0) {
            // Out of time while the gesture was still running. This is the same
            // answer an unmatched poll gives, because it is the same fact: the
            // condition did not become true inside the window the caller asked
            // for.
            reply = { ok: false };
            break;
          }
          await sleep(Math.min(GESTURE_RETRY_DELAY_MS, untilDeadlineMs));
        }
      }
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
