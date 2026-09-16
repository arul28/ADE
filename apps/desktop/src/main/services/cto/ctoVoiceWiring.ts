import { randomUUID } from "node:crypto";

import { BrowserWindow, type IpcMain } from "electron";

import { IPC } from "../../../shared/ipc";
import {
  CTO_VOICE_AUDIO_POLL_INTERVAL_MS,
  CTO_VOICE_INITIAL_STATE,
  ctoVoiceMicrophoneUnavailableMessage,
  isVoiceCallLive,
  type CtoVoiceState,
} from "../../../shared/types/ctoVoice";
// Type-only, so it is erased at compile time and no import cycle exists at
// runtime even though `registerIpc` imports this module.
import type { AppContext } from "../ipc/registerIpc";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import type {
  CtoVoiceAction,
  CtoVoiceActionResult,
  CtoVoicePullAudioResult,
  CtoVoiceRuntimeEvent,
} from "./ctoVoiceRuntimeService";

/**
 * The desktop end of a CTO voice call: a router, and nothing more.
 *
 * The call brain itself lives in the project's RUNTIME
 * (`ctoVoiceRuntimeService`), because it needs the chat service, the CTO
 * identity and durable memory — and in every real build those are the runtime's
 * instances, not the desktop's. Reaching for `ctx.agentChatService` here is what
 * made Talk answer "chat + cto-state service not ready for this project": that
 * field is null outside `NODE_ENV=test`.
 *
 * What stays here is what only the desktop can own:
 *
 * - the window holding the microphone and the speaker (`isCallOwner`), because
 *   every window mounts the HUD and two capturing windows would interleave two
 *   PCM streams into one socket;
 * - the audio pump, because audio must not travel on the runtime event buffer —
 *   that buffer is bounded and replayable, and PCM would evict every real event;
 * - the watchers that hang a call up when its window closes or reloads.
 */

/** What the voice router needs from the app around it. */
export type CtoVoiceHost = {
  /** A getter, not a value: the project changes under a running app. */
  getCtx: () => AppContext;
  /**
   * The machine's local runtime pool, or null when this desktop IS the project
   * runtime (`shouldUseInProcessProjectRuntime()`). The two are mutually
   * exclusive by construction in `main.ts`.
   */
  getLocalRuntimePool: () => LocalRuntimeConnectionPool | null;
  /**
   * How the window asking is bound to its project, when the caller can say.
   *
   * A remote-bound window is genuinely connected — just not to a runtime on
   * this machine — so it needs its own sentence rather than the local pool's.
   * A call would have to carry PCM over the remote transport in both
   * directions, which is the one thing that transport is worst at, so remote
   * runtimes are a deliberate exclusion rather than a missing wire.
   */
  getBindingKind?: (senderId: number) => "local" | "remote" | null;
  /**
   * Typed to the runtime `Logger`'s own meta so the call sites need no cast.
   * `info` is optional: it carries the call-lifecycle trace, which tests that
   * do not read it need not supply.
   */
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    info?: (msg: string, meta?: Record<string, unknown>) => void;
  };
};

/**
 * Why the ROUTER ended a call. Distinct from the runtime's own reasons: this
 * names the desktop-side decision, and the two lines together say whether a
 * call was refused by OpenAI or hung up by ADE.
 */
export type CtoVoiceRouterEndReason =
  | "pump_push"
  | "pump_pull"
  | "stream_ended"
  | "owner_navigated"
  | "owner_destroyed"
  | "runtime_terminal"
  | "start_rejected"
  | "user_end"
  | "replaced";

/**
 * One call's worth of transport, whichever side of the socket the brain is on.
 *
 * Both paths speak the same nine actions, so the handlers below have no idea
 * which one they are on — the only difference is whether an action is a method
 * call or an `ade` action over the project's runtime socket.
 */
type CtoVoiceTransport = {
  kind: "runtime" | "in-process";
  call: <T>(action: CtoVoiceAction, args: Record<string, unknown>) => Promise<T>;
  subscribeState: (
    onState: (state: CtoVoiceState) => void,
    onEnded: () => void,
  ) => Promise<() => void>;
};

/**
 * A transport, or the sentence explaining why there isn't one.
 *
 * Returned rather than stashed in a module global: "unavailable" with no reason
 * sent the user back to a button that says nothing, and a global made the
 * reason a second source of truth that a concurrent call could overwrite
 * between the refusal and the reading of it. Every sentence names something the
 * user can act on — never "service not ready".
 */
type CtoVoiceTransportResult =
  | { transport: CtoVoiceTransport }
  | { unavailable: string };

/** True only for the sentence `ctoVoiceMicrophoneUnavailableMessage` produces. */
function isMicrophoneUnavailableMessage(reason: string): boolean {
  return reason === ctoVoiceMicrophoneUnavailableMessage("darwin")
    || reason === ctoVoiceMicrophoneUnavailableMessage("win32");
}

function readState(value: unknown): CtoVoiceState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<CtoVoiceState>;
  return typeof record.phase === "string" ? (value as CtoVoiceState) : null;
}

/**
 * Resolve the transport for this project, or say why there isn't one.
 *
 * The RUNTIME wins whenever there is one. A local pool exists exactly when this
 * desktop is not itself the project runtime, and in that case the daemon owns
 * the project's call — so reaching for an in-process service instead would open
 * a second call brain for a project that already has one.
 *
 * The check is "is there a pool", not "has the pool already registered this
 * root": `ensureProject` registers on demand, so a cached-roots test would send
 * the very first call of a session to the wrong side and only agree with itself
 * afterwards.
 *
 * In-process is therefore the fallback, not the preference, and it is reached
 * only when there is no pool at all — which today means
 * `shouldUseInProcessProjectRuntime()`, the one mode where `main.ts` both builds
 * the service and passes a null pool.
 */
function resolveTransport(host: CtoVoiceHost, senderId: number): CtoVoiceTransportResult {
  const ctx = host.getCtx();
  const rootPath = ctx.project?.rootPath ?? "";

  // First, because it outranks every other reason: with no project there is no
  // CTO to call, and a remote-bound window with nothing open should read "no
  // project is open" rather than be told about runtimes it has not chosen yet.
  if (!rootPath) return { unavailable: "no project is open" };

  if (host.getBindingKind?.(senderId) === "remote") {
    return { unavailable: "a voice call runs on the machine that hosts the project, not over a remote runtime" };
  }

  const pool = host.getLocalRuntimePool();
  if (pool) {
    return {
      transport: {
        kind: "runtime",
        call: async <T,>(action: CtoVoiceAction, args: Record<string, unknown>): Promise<T> => {
          const response = await pool.callActionForRoot(rootPath, {
            domain: "cto_voice",
            action,
            args,
          });
          return response.result as T;
        },
        subscribeState: async (onState, onEnded) =>
          await pool.subscribeEventsForRoot(
            rootPath,
            // `replay: false`: a call's state is only meaningful live, and
            // replaying a finished call's phases would put a dead HUD back on
            // screen.
            { category: "cto_voice", replay: false },
            (event) => {
              const payload = event.payload as Partial<CtoVoiceRuntimeEvent> | undefined;
              if (payload?.type !== "cto_voice_state") return;
              const state = readState(payload.state);
              if (state) onState(state);
            },
            onEnded,
          ),
      },
    };
  }

  const inProcess = ctx.ctoVoiceCallService ?? null;
  if (!inProcess) {
    host.logger?.warn("cto_voice.no_runtime_pool", { project: rootPath });
    return { unavailable: "not connected to this project's runtime" };
  }

  // An explicit table, not string indexing. The runtime service exposes more
  // than the bus does — `subscribeState` and `dispose` are in-process only —
  // and a lookup by name would happily hand either one to a caller's action
  // name.
  const dispatch: Record<CtoVoiceAction, (args: Record<string, unknown>) => unknown> = {
    getState: () => inProcess.getState(),
    hasKey: () => inProcess.hasKey(),
    start: (args) => inProcess.start(args),
    end: (args) => inProcess.end(args),
    setMuted: (args) => inProcess.setMuted(args),
    pushAudio: (args) => inProcess.pushAudio(args),
    pullAudio: (args) => inProcess.pullAudio(args),
    resolveApproval: (args) => inProcess.resolveApproval(args),
    sendCapture: (args) => inProcess.sendCapture(args),
  };
  return {
    transport: {
      kind: "in-process",
      call: async <T,>(action: CtoVoiceAction, args: Record<string, unknown>): Promise<T> =>
        await dispatch[action](args) as T,
      subscribeState: async (onState) => inProcess.subscribeState(onState),
    },
  };
}

/**
 * Send the call state to every window, telling exactly one of them it owns the
 * microphone.
 *
 * Every window mounts the HUD, so a call stays visible wherever the user is
 * working. Audio is different: two windows capturing means two PCM streams
 * interleaved into one socket, and two copies of the CTO's voice played back.
 */
function broadcastState(state: CtoVoiceState, ownerWebContentsId: number | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC.ctoVoiceState, {
        ...state,
        isCallOwner: win.webContents.id === ownerWebContentsId,
      });
    } catch {
      // A window closing mid-broadcast is not a call failure.
    }
  }
}

/** Output audio goes to the owning window only; nobody else may play it. */
function sendToOwner(channel: string, payload: unknown, ownerWebContentsId: number | null): void {
  if (ownerWebContentsId == null) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id !== ownerWebContentsId) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // The owning window closed; the owner watcher tears the call down.
    }
    return;
  }
}

/** Microphone frames held between flushes: ~2 s at the renderer's frame size. */
const MIC_BATCH_LIMIT = 200;

/**
 * Everything that belongs to ONE call, in one object.
 *
 * The invariant: a slot outlives its own teardown. Late state keeps flowing
 * through it until `detached`, because the state the user is waiting for — the
 * one that says why the call failed — usually arrives while the call is already
 * being retired. Nothing here may be read as "is this the active call": that
 * question is `call === slot`, and it is deliberately NOT what the state
 * handler asks.
 */
type CallSlot = {
  readonly token: string;
  readonly transport: CtoVoiceTransport;
  readonly ownerWebContentsId: number;
  releaseOwner: (() => void) | null;
  releaseState: (() => void) | null;
  /**
   * The runtime's id for THIS call, learned from the first live state.
   *
   * The subscription is opened before `start` is called — it has to be, or the
   * `connecting` phase is missed — so the first states down the wire can belong
   * to a call that is already over. The runtime clears a dead service on its way
   * into a new call, and that teardown's `ended` reached the brand-new slot,
   * which dutifully hung up a call that was 120 ms old and still connecting.
   * Nothing is published or acted on until a live state claims the slot.
   */
  callId: string | null;
  claimed: boolean;
  /** The newest state the runtime published for this call. */
  lastState: CtoVoiceState;
  /** True once a non-live phase has been broadcast. Exactly once, ever. */
  terminalDelivered: boolean;
  /** True from the first line of teardown, so nothing tears down twice. */
  closing: boolean;
  /**
   * True once the state subscription has been let go.
   *
   * The handler is deliberately not guarded on "is this the active call" — a
   * state arriving mid-teardown is the one the user is waiting for — so this is
   * what stops an event that outlives the subscription from broadcasting a live
   * phase and putting the HUD back on screen for a call that is over.
   */
  detached: boolean;
};

export function registerCtoVoiceIpc(ipcMain: IpcMain, host: CtoVoiceHost): void {
  /** The call that is up right now; null between calls. */
  let call: CallSlot | null = null;
  /** The audio pump: mic out, speaker in, at one shared cadence. */
  let audioPump: NodeJS.Timeout | null = null;
  /** Mic frames since the last flush, and the newest level with them. */
  let micBatch: string[] = [];
  let micLevel: number | undefined;
  /** True while a drain is in flight, so a slow round trip cannot stack them. */
  let pullInFlight = false;

  /**
   * Serializes start and end.
   *
   * Tearing a call down is long — it hangs up the socket on the far side, gives
   * the CTO's confirm-first hold back and writes the transcript. Without this
   * chain the `if (call)` guard in the start handler is blind for the whole
   * teardown, so a second Talk press walks straight past it.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    // The chain must not break on a rejection, and must not report one twice.
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  /**
   * The live call, but only for the window that owns it.
   *
   * Mute, approve and deny DRIVE the call: they feed the socket and answer a
   * permission prompt on the user's behalf, so a second window must not reach
   * them any more than it may open the microphone. `end` is deliberately open
   * to any window — hanging up from wherever you happen to be is the intended
   * behaviour, and it can only ever stop a call, never start or steer one — and
   * `attachImage` is open by the same documented rule as the capture gesture:
   * the chord fires in whichever window is in front.
   */
  const ownedCall = (event: { sender: Electron.WebContents }): CallSlot | null => {
    const active = call;
    if (!active || event.sender.id !== active.ownerWebContentsId) return null;
    return active;
  };

  const stopAudioPump = (): void => {
    if (audioPump) {
      clearInterval(audioPump);
      audioPump = null;
    }
    micBatch = [];
    micLevel = undefined;
    pullInFlight = false;
  };

  /**
   * Publish a state for this call, and remember whether it was the last one.
   *
   * Every window mounts the HUD, so the phase the renderer sees is the phase the
   * runtime reported — the router never invents a live one. It invents exactly
   * one state, the terminal fallback below, and that one is `ended`.
   */
  const publishState = (slot: CallSlot, state: CtoVoiceState): void => {
    if (slot.detached) return;
    host.logger?.info?.("cto_voice.router_state", {
      phase: state.phase,
      callId: state.callId,
      slotCallId: slot.callId,
      ...(state.error ? { error: state.error } : {}),
    });
    slot.lastState = state;
    if (!isVoiceCallLive(state.phase)) slot.terminalDelivered = true;
    broadcastState(state, slot.ownerWebContentsId);
  };

  /**
   * Retire a call, and never leave the HUD counting a call that is over.
   *
   * The renderer learns a call ended from a pushed state and from nothing else:
   * there is no poll, and the pill's timer and cost tick locally between
   * pushes. So a teardown that does not deliver a terminal state leaves the HUD
   * counting time and money against a call the runtime hung up seconds ago —
   * which is exactly what a rejected key did, because the pump's failure ended
   * the call locally and unsubscribed before the runtime's `failed` arrived.
   *
   * Hence the order here: the subscription stays attached across the `end`
   * round trip, so the runtime's own terminal state still wins if it lands, and
   * only when it has not landed does the router synthesize one.
   */
  const endCall = async (
    slot: CallSlot,
    fallbackError: string | null,
    reason: CtoVoiceRouterEndReason,
  ): Promise<void> => {
    // Logged before the re-entry guard: "end was asked for twice" is a fact
    // worth having, and the first caller is the one that decided.
    host.logger?.info?.("cto_voice.router_end", {
      reason,
      callId: slot.callId,
      phase: slot.lastState.phase,
      closing: slot.closing,
    });
    if (slot.closing) return;
    slot.closing = true;
    if (call === slot) call = null;
    stopAudioPump();
    slot.releaseOwner?.();
    slot.releaseOwner = null;

    try {
      // The sentence is compared against OUR OWN constant, never parsed: the
      // renderer's copy is the only thing that can produce it, and what crosses
      // is the coarse kind, not the text.
      const endKind = fallbackError && isMicrophoneUnavailableMessage(fallbackError)
        ? "microphone_unavailable"
        : undefined;
      await slot.transport.call("end", {
        ownerToken: slot.token,
        ...(endKind ? { endKind } : {}),
      });
    } catch (error) {
      host.logger?.warn("cto_voice.end_failed", { error: String(error) });
    }

    if (!slot.terminalDelivered) {
      // Ask what went wrong before inventing an answer: the runtime knows the
      // sentence ("OpenAI rejected this key…") and the user needs that one, not
      // a generic one, whenever it can still be had.
      let error = slot.lastState.error;
      if (!error) {
        try {
          const state = await slot.transport.call<CtoVoiceState | null>("getState", {});
          if (state && typeof state.error === "string") error = state.error;
        } catch {
          // The runtime is unreachable, which the fallback sentence covers.
        }
      }
      if (!slot.terminalDelivered) {
        publishState(slot, {
          ...slot.lastState,
          // Named, so a HUD keyed on the call cannot read it as someone else's.
          callId: slot.callId ?? slot.lastState.callId,
          phase: "ended",
          pendingConfirmation: null,
          interrupted: false,
          inputLevel: 0,
          // No blanket default. Every teardown the user did not ask for passes
          // its own `fallbackError` at the call site; the ones they DID ask for
          // — the End button, a call replaced by a newer one — pass none, and
          // must end silently. A notice on a hang-up you performed is noise.
          error: error ?? fallbackError ?? null,
        });
      }
    }

    if (slot.terminalDelivered && slot.lastState.phase === "failed") {
      // `failed` is terminal but NOT finished: the HUD stays on screen for it,
      // by design, so the user can read what went wrong. The call still has to
      // end, and the runtime's `ended` can be lost — it was, for a whole
      // release — leaving the pill showing a failure forever with no way out
      // and the page notice, which only appears once the HUD unmounts, never
      // arriving. The error is carried over: the sentence is the point.
      publishState(slot, {
        ...slot.lastState,
        phase: "ended",
        pendingConfirmation: null,
        interrupted: false,
        inputLevel: 0,
      });
    } else if (slot.terminalDelivered && fallbackError && !slot.lastState.error) {
      // The runtime's own terminal state landed, and it had nothing to blame —
      // correctly, because the hang-up came from this side. But the caller knew
      // WHY, and without this that sentence is lost and the call ends in
      // silence, which is exactly how a microphone that would not open looked
      // like nothing happening at all.
      publishState(slot, { ...slot.lastState, error: fallbackError });
    }

    // Last, so everything above could still be delivered through it.
    slot.detached = true;
    slot.releaseState?.();
    slot.releaseState = null;
  };

  /**
   * The pump could not reach the runtime.
   *
   * Ending on this is deliberate. The alternative is a HUD counting time and
   * cost against a call nobody is feeding, forever, with no way back — and the
   * teardown now guarantees a terminal state, so ending is visible rather than
   * silent.
   */
  const failPump = (slot: CallSlot, reason: "pump_push" | "pump_pull", error: unknown): void => {
    host.logger?.warn(`cto_voice.${reason}_failed`, { error: String(error) });
    if (call !== slot) return;
    void serialize(() => endCall(slot, "The call ended.", reason));
  };

  /**
   * Mic out and speaker in, on one interval.
   *
   * Batched rather than a call per frame: a round trip per 20 ms of PCM would be
   * the busiest path in the app. Draining is also the call's heartbeat — the
   * runtime hangs up a call whose owner has gone quiet, which is what stops a
   * crashed window leaving a billed socket open inside the brain.
   */
  const startAudioPump = (slot: CallSlot): void => {
    stopAudioPump();
    audioPump = setInterval(() => {
      if (call !== slot) return;

      if (micBatch.length) {
        const chunks = micBatch;
        const level = micLevel;
        micBatch = [];
        micLevel = undefined;
        void slot.transport
          .call("pushAudio", {
            ownerToken: slot.token,
            chunks,
            ...(level !== undefined ? { level } : {}),
          })
          .catch((error) => failPump(slot, "pump_push", error));
      }

      // One drain at a time. A round trip slower than the interval would
      // otherwise stack calls against a queue only one of them can empty.
      if (pullInFlight) return;
      pullInFlight = true;
      void slot.transport
        .call<CtoVoicePullAudioResult>("pullAudio", { ownerToken: slot.token })
        .then((result) => {
          // A call that ended while this was in flight must not push audio at
          // the window that owns the NEXT one.
          if (call !== slot) return;
          if (result?.dropped) {
            host.logger?.warn("cto_voice.output_audio_dropped", { dropped: result.dropped });
          }
          for (const chunk of result?.chunks ?? []) {
            sendToOwner(IPC.ctoVoiceAudio, chunk, slot.ownerWebContentsId);
          }
        })
        .catch((error) => failPump(slot, "pump_pull", error))
        .finally(() => { pullInFlight = false; });
    }, CTO_VOICE_AUDIO_POLL_INTERVAL_MS);
    audioPump.unref?.();
  };

  /**
   * End the call if the window holding the microphone goes away.
   *
   * Closing or reloading that window destroys the renderer's audio graph, so
   * the call is already over in every way that matters — but the socket, the
   * keep-alive and the CTO's confirm-first hold all live in the brain and would
   * survive. A reloaded window cannot rescue it either: its store starts at
   * `idle` and only learns otherwise from a state push.
   */
  const watchOwner = (sender: Electron.WebContents, slot: CallSlot): (() => void) => {
    const finish = (reason: CtoVoiceRouterEndReason) => () => {
      void serialize(() => endCall(slot, "The call ended.", reason));
    };
    // `did-navigate` covers a reload; `destroyed` covers the window closing.
    // Named apart, because a dev renderer that navigates is a very different
    // diagnosis from a window that went away.
    const onNavigate = finish("owner_navigated");
    const onDestroyed = finish("owner_destroyed");
    sender.on("did-navigate", onNavigate);
    sender.once("destroyed", onDestroyed);
    return () => {
      try {
        sender.off("did-navigate", onNavigate);
        sender.off("destroyed", onDestroyed);
      } catch {
        // The sender is already gone, which is the case this exists for.
      }
    };
  };

  ipcMain.handle(IPC.ctoVoiceStart, async (event): Promise<CtoVoiceActionResult> => serialize(async () => {
    // One call at a time: the CTO is a single project-level thread, so a second
    // concurrent call would be a second CTO.
    if (call) {
      if (isVoiceCallLive(call.lastState.phase)) return { ok: true };
      // A call can end without the router being told — the socket closed, or
      // the stream ended — leaving the slot and its watchers behind.
      await endCall(call, null, "replaced");
    }

    const resolved = resolveTransport(host, event.sender.id);
    if ("unavailable" in resolved) {
      return { ok: false, error: "unavailable", detail: resolved.unavailable };
    }
    const next = resolved.transport;

    const slot: CallSlot = {
      token: randomUUID(),
      transport: next,
      ownerWebContentsId: event.sender.id,
      releaseOwner: null,
      releaseState: null,
      callId: null,
      claimed: false,
      lastState: { ...CTO_VOICE_INITIAL_STATE },
      terminalDelivered: false,
      closing: false,
      detached: false,
    };
    call = slot;
    slot.releaseOwner = watchOwner(event.sender, slot);

    try {
      // Subscribed BEFORE the call starts: the brain emits `connecting` inside
      // `start`, and a subscription opened afterwards would miss every phase up
      // to the first thing the user says.
      slot.releaseState = await next.subscribeState(
        (state) => {
          // Deliberately NOT guarded on `call === slot`: a state that arrives
          // during teardown is the one the user is waiting for. `publishState`
          // drops it only once the subscription itself has been let go.
          if (slot.detached) return;
          if (!slot.claimed) {
            // Only a LIVE state may claim the slot. Anything terminal arriving
            // before this call has said a word belongs to the one before it.
            if (!isVoiceCallLive(state.phase)) {
              host.logger?.info?.("cto_voice.router_state", {
                dropped: "unclaimed",
                phase: state.phase,
                callId: state.callId,
              });
              return;
            }
            slot.claimed = true;
            slot.callId = state.callId;
          } else if (slot.callId && state.callId && state.callId !== slot.callId) {
            // A different call on the same runtime. Not ours to show or end.
            host.logger?.info?.("cto_voice.router_state", {
              dropped: "other_call",
              phase: state.phase,
              callId: state.callId,
              slotCallId: slot.callId,
            });
            return;
          }
          publishState(slot, state);
          if (isVoiceCallLive(state.phase)) return;
          // The runtime ended it by itself — a rejected key, a socket error, or
          // the owner watchdog. Let go of the microphone and retire the slot so
          // Talk works again rather than refusing a call that no longer exists.
          stopAudioPump();
          // The runtime ended THIS call, with its own id on the state. A
          // foreign state never reaches here — it is dropped above — so this
          // reason names what it is rather than calling it stale.
          if (!slot.closing) void serialize(() => endCall(slot, null, "runtime_terminal"));
        },
        () => {
          // The runtime's event stream ended (the brain recycled or died), so
          // no terminal state is coming. The teardown has to invent one.
          void serialize(() => endCall(slot, "The call ended.", "stream_ended"));
        },
      );

      const result = await next.call<CtoVoiceActionResult>("start", { ownerToken: slot.token });
      if (!result?.ok) {
        await endCall(slot, result?.detail ?? null, "start_rejected");
        return {
          ok: false,
          error: result?.error ?? "unavailable",
          ...(result?.detail ? { detail: result.detail } : {}),
        };
      }
      startAudioPump(slot);
      return { ok: true };
    } catch (error) {
      await endCall(slot, null, "start_rejected");
      host.logger?.warn("cto_voice.start_failed", { error: String(error) });
      return {
        ok: false,
        error: "unavailable",
        detail:
          next.kind === "runtime"
            ? "this project's runtime could not start the call"
            : String(error),
      };
    }
  }));

  ipcMain.handle(IPC.ctoVoiceEnd, async (_event, arg: { reason?: unknown } = {}): Promise<void> => {
    // A reason only ever ADDS a sentence. The End button sends none, and a call
    // the user chose to end must stay `ended` with no error on it.
    const reason = typeof arg?.reason === "string" && arg.reason.trim().length
      ? arg.reason.trim()
      : null;
    // `call` is read INSIDE the queue, not before it. A hang-up that lands
    // while a start is still queued read a null slot and quietly did nothing,
    // leaving the call the user had just cancelled to come up anyway.
    await serialize(async () => {
      const ending = call;
      if (!ending) return;
      await endCall(ending, reason, "user_end");
    });
  });

  // Audio frames arrive continuously while a call runs. `on`, not `handle`:
  // a reply per frame would be pure overhead on the busiest channel in the app.
  // They are batched here and flushed by the pump, not sent one by one.
  ipcMain.on(IPC.ctoVoicePushAudio, (event, arg: { audio?: unknown; level?: unknown }) => {
    const active = call;
    // A window that does not own the call has no business feeding the socket.
    if (!active || event.sender.id !== active.ownerWebContentsId) return;
    const audio = typeof arg?.audio === "string" ? arg.audio : null;
    if (!audio) return;
    micBatch.push(audio);
    // Bounded, because the renderer keeps capturing between the moment a call
    // ends and the moment its store hears about it. Two seconds of frames is
    // plenty of slack for a slow flush and still cannot grow without end.
    if (micBatch.length > MIC_BATCH_LIMIT) micBatch.splice(0, micBatch.length - MIC_BATCH_LIMIT);
    if (typeof arg?.level === "number") micLevel = arg.level;
  });

  ipcMain.handle(IPC.ctoVoiceSetMuted, async (event, arg: { muted?: unknown }): Promise<void> => {
    const active = ownedCall(event);
    if (!active) return;
    await active.transport
      .call("setMuted", { ownerToken: active.token, muted: Boolean(arg?.muted) })
      .catch((error) => host.logger?.warn("cto_voice.set_muted_failed", { error: String(error) }));
  });

  ipcMain.handle(IPC.ctoVoiceApprove, async (event, arg: { id?: unknown }): Promise<void> => {
    const active = ownedCall(event);
    if (!active || typeof arg?.id !== "string") return;
    await active.transport
      .call("resolveApproval", { ownerToken: active.token, approvalId: arg.id, approved: true })
      .catch((error) => host.logger?.warn("cto_voice.approve_failed", { error: String(error) }));
  });

  ipcMain.handle(IPC.ctoVoiceDeny, async (event, arg: { id?: unknown }): Promise<void> => {
    const active = ownedCall(event);
    if (!active || typeof arg?.id !== "string") return;
    await active.transport
      .call("resolveApproval", { ownerToken: active.token, approvalId: arg.id, approved: false })
      .catch((error) => host.logger?.warn("cto_voice.deny_failed", { error: String(error) }));
  });

  ipcMain.handle(IPC.ctoVoiceAttachImage, async (_event, arg: { pngBase64?: unknown; note?: unknown }): Promise<void> => {
    const active = call;
    if (!active) return;
    const pngBase64 = typeof arg?.pngBase64 === "string" ? arg.pngBase64 : null;
    if (!pngBase64) return;
    await active.transport
      .call("sendCapture", {
        ownerToken: active.token,
        pngBase64,
        note: typeof arg?.note === "string" ? arg.note : "",
      })
      .catch((error) => host.logger?.warn("cto_voice.capture_failed", { error: String(error) }));
  });

  ipcMain.handle(IPC.ctoVoiceHasKey, async (event): Promise<boolean> => {
    // Resolved per call rather than reused from a live one: the answer decides
    // whether the Talk button opens the key sheet, and it is asked when no call
    // is running at all.
    if (call) return await call.transport.call<boolean>("hasKey", {}).catch(() => false);
    const resolved = resolveTransport(host, event.sender.id);
    if ("unavailable" in resolved) return false;
    return await resolved.transport.call<boolean>("hasKey", {}).catch(() => false);
  });
}
