import { vi } from "vitest";

import type { BufferedEvent } from "../../../../../ade-cli/src/eventBuffer";
import type { CtoVoiceState } from "../../../shared/types/ctoVoice";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import type { CtoVoiceSocket } from "./ctoVoiceCallService";
import type { CtoVoiceRuntimeHost } from "./ctoVoiceRuntimeService";

/**
 * The two doubles every voice test needs, in one place.
 *
 * One socket and one host, typed against the real `CtoVoiceRuntimeHost` rather
 * than `any`: a change to what the service needs breaks these once, here, and
 * every suite that can drive an event can drive all of them.
 */

export type FakeVoiceSocket = ReturnType<typeof createFakeSocket>;

/** A socket the test drives: records what was sent, replays what the API says. */
export function createFakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const handlers: Record<string, Array<(payload?: unknown) => void>> = {};
  const socket: CtoVoiceSocket = {
    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => {},
    on: (event, handler) => { (handlers[event] = handlers[event] ?? []).push(handler); },
  };
  return {
    socket,
    sent,
    open: () => handlers.open?.forEach((h) => h()),
    /** The 401 path: an HTTP response arrived instead of an upgrade. */
    rejectUpgrade: (statusCode: number) =>
      handlers["unexpected-response"]?.forEach((h) => h({ statusCode })),
    /** An error with no close behind it: the call is failed but not torn down. */
    fail: (error: unknown) => handlers.error?.forEach((h) => h(error)),
    receive: (event: unknown) => handlers.message?.forEach((h) => h(JSON.stringify(event))),
    typesSent: () => sent.map((message) => String(message.type)),
    lastOfType: (type: string) => [...sent].reverse().find((message) => message.type === type),
  };
}

/** Every event a host's buffer saw, keyed by the host that owns it. */
const hostEvents = new WeakMap<CtoVoiceRuntimeHost, BufferedEvent[]>();

/** Every phase the host's event buffer saw, in order. */
export function pushedPhases(host: CtoVoiceRuntimeHost): string[] {
  return hostEvents.get(host)?.map((event) =>
    String((event.payload as { state?: { phase?: unknown } }).state?.phase)) ?? [];
}

/** Every state the host's event buffer saw, in order. */
export function pushedStates(host: CtoVoiceRuntimeHost): Array<Record<string, unknown>> {
  return hostEvents.get(host)?.map((event) =>
    (event.payload as { state: Record<string, unknown> }).state) ?? [];
}

/**
 * A runtime host wired to answer, not to assert.
 *
 * Every service it carries is the smallest thing that lets a call run; override
 * exactly the one a test is about.
 */
export function createVoiceRuntimeHost(overrides: Partial<CtoVoiceRuntimeHost> = {}): {
  host: CtoVoiceRuntimeHost;
  pushed: BufferedEvent[];
} {
  const pushed: BufferedEvent[] = [];
  const identity = { name: "Ada", voiceBackchannels: true, voiceName: "marin" };
  const host: CtoVoiceRuntimeHost = {
    projectRoot: "/tmp/ade-voice-project",
    logger: { info: () => {}, warn: () => {} },
    laneService: {
      ensurePrimaryLane: async () => undefined,
      list: async () => [{ id: "lane-1", laneType: "primary" }],
    } as never,
    ctoStateService: { getIdentity: () => identity } as never,
    agentChatService: {
      ensureIdentitySession: async () => ({ id: "session-1" }),
      updateSession: async () => undefined,
      approveToolUse: vi.fn(async () => undefined),
      subscribeToEvents: () => () => {},
      // The real `runSessionTurn` answers with the turn's own terminal status;
      // the call only speaks a `completed` one.
      runSessionTurn: async () => ({ outputText: "Three merged yesterday.", status: "completed" }),
      getSessionTurnHealth: () => ({
        sessionId: "session-1",
        canTakeTurn: true,
        blockedReason: null,
        lastTurnFailure: null,
        context: null,
        rotationAdvised: false,
      }),
      interrupt: async () => undefined,
    } as never,
    ctoMemoryService: { writeCallTranscript: vi.fn(async () => undefined) } as never,
    eventBuffer: { push: (event) => { pushed.push({ id: pushed.length + 1, ...event }); } },
    ...overrides,
  };
  hostEvents.set(host, pushed);
  return { host, pushed };
}

/**
 * The runtime connection pool, as the voice router uses it.
 *
 * Typed against the real `LocalRuntimeConnectionPool` in ONE place. The router
 * touches two of its methods, and every test that exercises the runtime path
 * used to hand-roll both and cast the result with `as unknown as` — nineteen
 * casts, each one a place where a change to the pool's shape goes unnoticed
 * because the cast says it is fine.
 *
 * `onAction` decides one action's `result`; the envelope around it is the
 * pool's business, not the test's. Whatever it throws reaches the caller, which
 * is how a runtime that has gone away is spelled.
 */
export function createFakeRuntimePool(options: {
  onAction?: (request: {
    action: string;
    args: Record<string, unknown>;
  }) => unknown;
  /** Called when the router subscribes; whatever it returns is the release. */
  onSubscribe?: () => (() => void) | void;
} = {}) {
  /** Every action the router asked for, in order. */
  const actions: string[] = [];
  let onEvent: ((event: { payload: Record<string, unknown> }) => void) | null = null;
  let onEnded: (() => void) | null = null;

  const callActionForRoot = vi.fn(async (
    _root: string,
    request: { domain: string; action: string; args?: unknown },
  ) => {
    actions.push(request.action);
    const args = (request.args ?? {}) as Record<string, unknown>;
    const result = options.onAction
      ? await options.onAction({ action: request.action, args })
      // The two defaults a call needs to come up: every action succeeds, and
      // the audio drain hands back nothing.
      : request.action === "pullAudio"
        ? { ok: true, chunks: [], dropped: 0 }
        : { ok: true };
    return { domain: request.domain, action: request.action, result, statusHints: {} };
  });

  const subscribeEventsForRoot = vi.fn(async (
    _root: string,
    _request: unknown,
    handler: (event: { payload: Record<string, unknown> }) => void,
    ended?: () => void,
  ) => {
    onEvent = handler;
    onEnded = ended ?? null;
    return options.onSubscribe?.() ?? (() => {});
  });

  return {
    pool: { callActionForRoot, subscribeEventsForRoot } as unknown as LocalRuntimeConnectionPool,
    callActionForRoot,
    subscribeEventsForRoot,
    actions,
    /** One event from the runtime's `cto_voice` category. */
    emit: (payload: Record<string, unknown>) => { onEvent?.({ payload }); },
    /** The shape every voice event has. */
    emitState: (state: CtoVoiceState) => {
      onEvent?.({ payload: { type: "cto_voice_state", state } });
    },
    /** The event stream itself ended: the brain recycled or died. */
    endStream: () => { onEnded?.(); },
    /** True once the router has subscribed. */
    isSubscribed: () => onEvent !== null,
  };
}
