import { beforeEach, describe, expect, it, vi } from "vitest";

const windows = vi.hoisted(() => [] as Array<{
  webContents: { id: number; send: (channel: string, payload: unknown) => void };
}>);

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => windows },
}));

import { IPC } from "../../../shared/ipc";
import {
  CTO_VOICE_AUDIO_POLL_INTERVAL_MS,
  CTO_VOICE_INITIAL_STATE,
  type CtoVoiceState,
} from "../../../shared/types/ctoVoice";
import type { AppContext } from "../ipc/registerIpc";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { registerCtoVoiceIpc } from "./ctoVoiceWiring";

type Handler = (event: { sender: Electron.WebContents }, arg?: unknown) => unknown;

/** Enough of a WebContents for the owner watchers the router attaches. */
function createSender(id: number): Electron.WebContents {
  return { id, on: () => {}, once: () => {}, off: () => {} } as unknown as Electron.WebContents;
}

function createIpcMain() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Handler>();
  return {
    ipcMain: {
      handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); },
      on: (channel: string, handler: Handler) => { listeners.set(channel, handler); },
    } as never,
    invoke: (channel: string, arg?: unknown, senderId = 7) =>
      handlers.get(channel)!({ sender: createSender(senderId) }, arg),
    emit: (channel: string, arg?: unknown, senderId = 7) =>
      listeners.get(channel)!({ sender: createSender(senderId) }, arg),
  };
}

function liveState(): CtoVoiceState {
  return { ...CTO_VOICE_INITIAL_STATE, phase: "listening", callId: "call-1" };
}

beforeEach(() => {
  windows.length = 0;
  windows.push({ webContents: { id: 7, send: vi.fn() } });
  windows.push({ webContents: { id: 9, send: vi.fn() } });
});

describe("the CTO voice router's transport choice", () => {
  it("routes through the project's runtime when the in-process services are null", async () => {
    const callActionForRoot = vi.fn(async () => ({
      domain: "cto_voice",
      action: "start",
      result: { ok: true },
      statusHints: {},
    }));
    const subscribeEventsForRoot = vi.fn(async () => () => {});
    const pool = { callActionForRoot, subscribeEventsForRoot } as unknown as LocalRuntimeConnectionPool;
    // The shape of a runtime-backed desktop context: every in-process service
    // the old wiring reached for is null, which is what made Talk refuse.
    const ctx = {
      project: { rootPath: "/repo" },
      agentChatService: null,
      ctoStateService: null,
      ctoVoiceCallService: null,
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => ctx, getLocalRuntimePool: () => pool });

    const result = await ipc.invoke(IPC.ctoVoiceStart);

    expect(result).toEqual({ ok: true });
    expect(subscribeEventsForRoot).toHaveBeenCalledWith(
      "/repo",
      { category: "cto_voice", replay: false },
      expect.any(Function),
      expect.any(Function),
    );
    const [root, request] = callActionForRoot.mock.calls[0] as unknown as [string, {
      domain: string; action: string; args: { ownerToken?: string };
    }];
    expect(root).toBe("/repo");
    expect(request.domain).toBe("cto_voice");
    expect(request.action).toBe("start");
    expect(request.args.ownerToken).toBeTruthy();
  });

  it("prefers the runtime even when an in-process call service also exists", async () => {
    // `ensureProjectContextForMobileSync` builds a full project context in
    // production for any project a phone touches, and a later window open
    // reuses it. Preferring the in-process service whenever one exists would
    // give such a project a second call brain in desktop main while the daemon
    // owns the real one — two sockets, two confirm-first holds, two transcripts.
    const start = vi.fn(async () => ({ ok: true }));
    const callActionForRoot = vi.fn(async () => ({
      domain: "cto_voice", action: "start", result: { ok: true }, statusHints: {},
    }));
    const pool = {
      callActionForRoot,
      subscribeEventsForRoot: vi.fn(async () => () => {}),
    } as unknown as LocalRuntimeConnectionPool;
    const ctx = {
      project: { rootPath: "/repo" },
      ctoVoiceCallService: { start, subscribeState: vi.fn(() => () => {}) },
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => ctx, getLocalRuntimePool: () => pool });

    expect(await ipc.invoke(IPC.ctoVoiceStart)).toEqual({ ok: true });
    expect(callActionForRoot).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("uses the in-process call service when this desktop IS the runtime", async () => {
    const start = vi.fn(async () => ({ ok: true }));
    const subscribeState = vi.fn(() => () => {});
    const ctx = {
      project: { rootPath: "/repo" },
      ctoVoiceCallService: { start, subscribeState },
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const ipc = createIpcMain();
    // No pool is what "this desktop IS the runtime" looks like from here.
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => ctx, getLocalRuntimePool: () => null });

    expect(await ipc.invoke(IPC.ctoVoiceStart)).toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ ownerToken: expect.any(String) }));
  });

  it("says what is actually missing instead of 'service not ready'", async () => {
    const ctx = {
      project: { rootPath: "/repo" },
      ctoVoiceCallService: null,
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => ctx, getLocalRuntimePool: () => null });

    const result = await ipc.invoke(IPC.ctoVoiceStart) as { ok: boolean; detail?: string };

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("not connected to this project's runtime");
  });

  it("says a remote-bound window is connected, just not to a machine that can host a call", async () => {
    const pool = {
      callActionForRoot: vi.fn(),
      subscribeEventsForRoot: vi.fn(),
    } as unknown as LocalRuntimeConnectionPool;
    const ctx = {
      project: { rootPath: "/remote/repo" },
      ctoVoiceCallService: null,
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, {
      getCtx: () => ctx,
      getLocalRuntimePool: () => pool,
      getBindingKind: () => "remote",
    });

    const result = await ipc.invoke(IPC.ctoVoiceStart) as { ok: boolean; detail?: string };

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not over a remote runtime");
    // A deliberate exclusion, not a wire that was forgotten: the machine's own
    // pool must not be handed a remote project's root.
    expect(pool.callActionForRoot).not.toHaveBeenCalled();
  });

  it("names the missing project rather than blaming a service", async () => {
    const ctx = {
      project: null,
      ctoVoiceCallService: null,
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => ctx, getLocalRuntimePool: () => null });

    const result = await ipc.invoke(IPC.ctoVoiceStart) as { detail?: string };
    expect(result.detail).toBe("no project is open");
  });

  it("carries the runtime's own refusal back to the button", async () => {
    const pool = {
      callActionForRoot: vi.fn(async () => ({
        domain: "cto_voice",
        action: "start",
        result: { ok: false, error: "missing-key", detail: "no OpenAI key on this machine" },
        statusHints: {},
      })),
      subscribeEventsForRoot: vi.fn(async () => () => {}),
    } as unknown as LocalRuntimeConnectionPool;
    const ctx = {
      project: { rootPath: "/repo" },
      ctoVoiceCallService: null,
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => ctx, getLocalRuntimePool: () => pool });

    expect(await ipc.invoke(IPC.ctoVoiceStart)).toEqual({
      ok: false,
      error: "missing-key",
      detail: "no OpenAI key on this machine",
    });
  });
});

describe("what the router keeps for itself", () => {
  it("tells exactly one window it owns the microphone", async () => {
    const emitter: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const pool = {
      callActionForRoot: vi.fn(async () => ({
        domain: "cto_voice", action: "start", result: { ok: true }, statusHints: {},
      })),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        emitter.fn = onEvent as typeof emitter.fn;
        return () => {};
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ctx = {
      project: { rootPath: "/repo" },
      ctoVoiceCallService: null,
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => ctx, getLocalRuntimePool: () => pool });
    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);

    emitter.fn?.({ payload: { type: "cto_voice_state", state: liveState() } });

    const owner = windows.find((w) => w.webContents.id === 7)!.webContents.send as ReturnType<typeof vi.fn>;
    const other = windows.find((w) => w.webContents.id === 9)!.webContents.send as ReturnType<typeof vi.fn>;
    expect(owner).toHaveBeenCalledWith(IPC.ctoVoiceState, expect.objectContaining({ isCallOwner: true }));
    expect(other).toHaveBeenCalledWith(IPC.ctoVoiceState, expect.objectContaining({ isCallOwner: false }));
  });

  it("ignores microphone frames from a window that does not hold the call", async () => {
    const pool = {
      callActionForRoot: vi.fn(async () => ({
        domain: "cto_voice", action: "start", result: { ok: true }, statusHints: {},
      })),
      subscribeEventsForRoot: vi.fn(async () => () => {}),
    } as unknown as LocalRuntimeConnectionPool;
    const ctx = {
      project: { rootPath: "/repo" },
      ctoVoiceCallService: null,
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => ctx, getLocalRuntimePool: () => pool });
    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    const callsBefore = (pool.callActionForRoot as ReturnType<typeof vi.fn>).mock.calls.length;

    ipc.emit(IPC.ctoVoicePushAudio, { audio: "AAAA", level: 0.2 }, 9);
    await Promise.resolve();

    // Not batched, not sent: the frame never reaches the brain at all.
    expect((pool.callActionForRoot as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });
});

describe("a call the router has to end on its own", () => {
  function runtimeCtx() {
    return {
      project: { rootPath: "/repo" },
      ctoVoiceCallService: null,
      logger: { warn: () => {} },
    } as unknown as AppContext;
  }

  function ownerSend() {
    return windows.find((w) => w.webContents.id === 7)!.webContents.send as ReturnType<typeof vi.fn>;
  }

  function statesSentToOwner(): CtoVoiceState[] {
    return ownerSend().mock.calls
      .filter(([channel]) => channel === IPC.ctoVoiceState)
      .map(([, payload]) => payload as CtoVoiceState);
  }

  it("ignores a dead call's last words that arrive before its own first", async () => {
    // The subscription has to open before `start` is called, or `connecting` is
    // missed — so the first states down the wire can belong to the call before
    // this one. The runtime clears a dead service on its way into a new call,
    // and that stale `ended` used to make a 120-ms-old connecting call hang
    // itself up, which is how a rejected key came back as "closed before the
    // connection was established".
    const em: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const rel: { fn: ((value: { ok: boolean }) => void) | null } = { fn: null };
    const actions: string[] = [];
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => {
        actions.push(request.action);
        if (request.action === "start") {
          // Held open, so the stale state lands in exactly the window the bug
          // lived in: subscribed, but not yet started.
          const result = await new Promise<{ ok: boolean }>((resolve) => { rel.fn = resolve; });
          return { domain: "cto_voice", action: "start", result, statusHints: {} };
        }
        return {
          domain: "cto_voice",
          action: request.action,
          result: { ok: true, chunks: [], dropped: 0 },
          statusHints: {},
        };
      }),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        em.fn = onEvent as typeof em.fn;
        return () => {};
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });

    const starting = ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    await new Promise((resolve) => setTimeout(resolve, 0));
    ownerSend().mockClear();

    // The previous call's teardown, with somebody else's id — and with none.
    em.fn?.({
      payload: {
        type: "cto_voice_state",
        state: { ...CTO_VOICE_INITIAL_STATE, callId: "older-call", phase: "ended", error: "gone" },
      },
    });
    em.fn?.({ payload: { type: "cto_voice_state", state: { ...CTO_VOICE_INITIAL_STATE, phase: "ended" } } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Not shown to anyone, and above all not acted on.
    expect(statesSentToOwner()).toEqual([]);
    expect(actions).not.toContain("end");

    rel.fn?.({ ok: true });
    expect(await starting).toEqual({ ok: true });

    // This call's own first state claims the slot and is published.
    em.fn?.({ payload: { type: "cto_voice_state", state: { ...liveState(), callId: "my-call" } } });
    expect(statesSentToOwner().at(-1)).toMatchObject({ callId: "my-call", phase: "listening" });

    // And the pump is alive: it reaches the runtime on its next tick. Real
    // timers, because the interval was armed before this point.
    await new Promise((resolve) => setTimeout(resolve, CTO_VOICE_AUDIO_POLL_INTERVAL_MS + 60));
    expect(actions).toContain("pullAudio");
    expect(actions).not.toContain("end");
  });

  it("drops a state belonging to a different call once the slot is claimed", async () => {
    const em: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const actions: string[] = [];
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => {
        actions.push(request.action);
        return {
          domain: "cto_voice",
          action: request.action,
          result: { ok: true, chunks: [], dropped: 0 },
          statusHints: {},
        };
      }),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        em.fn = onEvent as typeof em.fn;
        return () => {};
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });
    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);

    em.fn?.({ payload: { type: "cto_voice_state", state: { ...liveState(), callId: "mine" } } });
    ownerSend().mockClear();
    em.fn?.({
      payload: {
        type: "cto_voice_state",
        state: { ...CTO_VOICE_INITIAL_STATE, callId: "not-mine", phase: "ended" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(statesSentToOwner()).toEqual([]);
    expect(actions).not.toContain("end");
  });

  it("ends a call the runtime left sitting on failed", async () => {
    // Belt and braces for the rule above. If the runtime's `ended` is ever lost
    // again, the HUD must still come down — and it must come down carrying the
    // sentence that explains why, not a fresh generic one.
    const em: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => ({
        domain: "cto_voice",
        action: request.action,
        result: request.action === "start" ? { ok: true } : { ok: true, chunks: [], dropped: 0 },
        statusHints: {},
      })),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        em.fn = onEvent as typeof em.fn;
        return () => {};
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });

    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    em.fn?.({ payload: { type: "cto_voice_state", state: { ...liveState(), callId: "call-401" } } });
    ownerSend().mockClear();

    // The runtime says why, and then says nothing more.
    em.fn?.({
      payload: {
        type: "cto_voice_state",
        state: {
          ...CTO_VOICE_INITIAL_STATE,
          callId: "call-401",
          phase: "failed",
          error: "OpenAI rejected this key. Check it under CTO settings, Voice.",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent = statesSentToOwner();
    expect(sent.map((state) => state.phase)).toEqual(["failed", "ended"]);
    expect(sent.at(-1)?.error).toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    expect(sent.at(-1)?.callId).toBe("call-401");
  });

  it("carries the reason a hang-up came with into the call's last state", async () => {
    // A microphone that will not open ends the call from the renderer. The
    // runtime has nothing to blame — correctly, the hang-up came from this side
    // — so without the reason travelling with it the call ended in silence and
    // the user was told nothing at all.
    const info = vi.fn();
    const em: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => ({
        domain: "cto_voice",
        action: request.action,
        result: request.action === "start"
          ? { ok: true }
          : request.action === "getState"
            ? { ...CTO_VOICE_INITIAL_STATE, phase: "ended", error: null }
            : { ok: true, chunks: [], dropped: 0 },
        statusHints: {},
      })),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        em.fn = onEvent as typeof em.fn;
        return () => {};
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, {
      getCtx: () => runtimeCtx(),
      getLocalRuntimePool: () => pool,
      logger: { warn: () => {}, info },
    });

    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    em.fn?.({ payload: { type: "cto_voice_state", state: { ...liveState(), callId: "call-mic" } } });
    ownerSend().mockClear();

    const sentence = "ADE could not open the microphone. Allow microphone access for ADE in System Settings, Privacy & Security, Microphone.";
    await ipc.invoke(IPC.ctoVoiceEnd, { reason: sentence });

    const terminal = statesSentToOwner().at(-1);
    expect(terminal?.phase).toBe("ended");
    expect(terminal?.error).toBe(sentence);
    expect(info).toHaveBeenCalledWith(
      "cto_voice.router_end",
      expect.objectContaining({ reason: "user_end", callId: "call-mic" }),
    );
  });

  it("keeps a deliberate hang-up silent, because the user already knows", async () => {
    // The HUD's End button sends no reason, and a call the user chose to end
    // has nothing to explain. A notice here would be noise.
    const em: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => ({
        domain: "cto_voice",
        action: request.action,
        result: request.action === "start"
          ? { ok: true }
          : request.action === "getState"
            ? { ...CTO_VOICE_INITIAL_STATE, phase: "ended", error: null }
            : { ok: true, chunks: [], dropped: 0 },
        statusHints: {},
      })),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        em.fn = onEvent as typeof em.fn;
        return () => {};
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });

    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    em.fn?.({ payload: { type: "cto_voice_state", state: { ...liveState(), callId: "call-quiet" } } });
    ownerSend().mockClear();

    await ipc.invoke(IPC.ctoVoiceEnd);

    const terminal = statesSentToOwner().at(-1);
    expect(terminal?.phase).toBe("ended");
    expect(terminal?.error).toBeNull();
  });

  it("names who ended the call, and every state it published", async () => {
    // The diagnosis this exists for: a call that dies in 150 ms looks the same
    // whether OpenAI refused it or something in ADE hung up. These two lines
    // are the difference, so they are asserted rather than hoped for.
    const info = vi.fn();
    const em: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => ({
        domain: "cto_voice",
        action: request.action,
        result: request.action === "start" ? { ok: true } : { ok: true, chunks: [], dropped: 0 },
        statusHints: {},
      })),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        em.fn = onEvent as typeof em.fn;
        return () => {};
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, {
      getCtx: () => runtimeCtx(),
      getLocalRuntimePool: () => pool,
      logger: { warn: () => {}, info },
    });

    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    em.fn?.({ payload: { type: "cto_voice_state", state: { ...liveState(), callId: "call-9" } } });
    expect(info).toHaveBeenCalledWith(
      "cto_voice.router_state",
      expect.objectContaining({ phase: "listening", callId: "call-9" }),
    );

    // A stale terminal is dropped, and the drop is visible too.
    em.fn?.({
      payload: {
        type: "cto_voice_state",
        state: { ...CTO_VOICE_INITIAL_STATE, callId: "other", phase: "ended" },
      },
    });
    expect(info).toHaveBeenCalledWith(
      "cto_voice.router_state",
      expect.objectContaining({ dropped: "other_call", callId: "other" }),
    );

    await ipc.invoke(IPC.ctoVoiceEnd);
    expect(info).toHaveBeenCalledWith(
      "cto_voice.router_end",
      expect.objectContaining({ reason: "user_end", callId: "call-9" }),
    );
  });

  /**
   * The level the batch carries is what the transcript gate rules on, so the
   * batch has to be credited with the LOUDEST frame in it. Sending the newest
   * frame's level instead let a sentence that ended in a quiet syllable read as
   * silence, which the gate would then have thrown away.
   */
  it("sends the loudest level in a microphone batch, not the last one", async () => {
    const em: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const pushes: Array<Record<string, unknown>> = [];
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string; args?: unknown }) => {
        if (request.action === "pushAudio") pushes.push((request.args ?? {}) as Record<string, unknown>);
        return {
          domain: "cto_voice",
          action: request.action,
          result: request.action === "pullAudio" ? { ok: true, chunks: [], dropped: 0 } : { ok: true },
          statusHints: {},
        };
      }),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        em.fn = onEvent as typeof em.fn;
        return () => {};
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });

    vi.useFakeTimers();
    try {
      await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
      em.fn?.({ payload: { type: "cto_voice_state", state: liveState() } });
      ipc.emit(IPC.ctoVoicePushAudio, { audio: "AAAA", level: 0.03 }, 7);
      ipc.emit(IPC.ctoVoicePushAudio, { audio: "BBBB", level: 0.42 }, 7);
      ipc.emit(IPC.ctoVoicePushAudio, { audio: "CCCC", level: 0.04 }, 7);
      await vi.advanceTimersByTimeAsync(150);
    } finally {
      vi.useRealTimers();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.chunks).toEqual(["AAAA", "BBBB", "CCCC"]);
    expect(pushes[0]?.level).toBeCloseTo(0.42);
  });

  it("broadcasts a terminal state when the pump cannot reach the runtime", async () => {
    // Before this, the pump's failure branch ended the call locally and
    // unsubscribed, and the local end broadcast nothing — so the HUD went on
    // counting time and cost on a call that was already over.
    const em: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const released = vi.fn();
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => {
        if (request.action === "start") {
          return { domain: "cto_voice", action: "start", result: { ok: true }, statusHints: {} };
        }
        if (request.action === "getState") {
          return {
            domain: "cto_voice",
            action: "getState",
            result: { ...CTO_VOICE_INITIAL_STATE, phase: "failed", error: "OpenAI rejected this key." },
            statusHints: {},
          };
        }
        if (request.action === "end") {
          return { domain: "cto_voice", action: "end", result: { ok: true }, statusHints: {} };
        }
        throw new Error("Action 'cto_voice.pullAudio' is not callable.");
      }),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        em.fn = onEvent as typeof em.fn;
        return released;
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });

    vi.useFakeTimers();
    try {
      await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
      em.fn?.({ payload: { type: "cto_voice_state", state: liveState() } });
      ownerSend().mockClear();

      // One pump tick: the drain rejects, which is the failure the user's stuck
      // HUD was hiding.
      await vi.advanceTimersByTimeAsync(150);
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    // Let the serialized teardown finish on real timers.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const terminal = statesSentToOwner().at(-1);
    expect(terminal?.phase).toBe("ended");
    // The runtime's own sentence, fetched rather than invented.
    expect(terminal?.error).toBe("OpenAI rejected this key.");
    // Every window hears it, not only the owner.
    const other = windows.find((w) => w.webContents.id === 9)!.webContents.send as ReturnType<typeof vi.fn>;
    expect(other).toHaveBeenCalledWith(IPC.ctoVoiceState, expect.objectContaining({ phase: "ended" }));
  });

  it("falls back to a plain sentence when the runtime cannot say what went wrong", async () => {
    const en: { fn: (() => void) | null } = { fn: null };
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => {
        if (request.action === "start") {
          return { domain: "cto_voice", action: "start", result: { ok: true }, statusHints: {} };
        }
        throw new Error("connection closed");
      }),
      subscribeEventsForRoot: vi.fn(async (_root, _req, _onEvent, onEnded) => {
        en.fn = onEnded as typeof en.fn;
        return () => {};
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });

    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    ownerSend().mockClear();
    // The brain recycled: no terminal event is coming, so one has to be made.
    en.fn?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const terminal = statesSentToOwner().at(-1);
    expect(terminal?.phase).toBe("ended");
    expect(terminal?.error).toBe("The call ended.");
  });

  it("forwards a terminal state that lands during teardown, and does not resurrect the call", async () => {
    // The subscription is deliberately still attached across the `end` round
    // trip: the runtime's own failure is the sentence the user needs, and it
    // often arrives exactly in that window.
    const em: { fn: ((event: { payload: Record<string, unknown> }) => void) | null } = { fn: null };
    const rel: { fn: (() => void) | null } = { fn: null };
    const releaseState = vi.fn();
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => {
        if (request.action === "start") {
          return { domain: "cto_voice", action: "start", result: { ok: true }, statusHints: {} };
        }
        if (request.action === "end") {
          // Hold the teardown open so the runtime's event can land inside it.
          await new Promise<void>((resolve) => { rel.fn = resolve; });
          return { domain: "cto_voice", action: "end", result: { ok: true }, statusHints: {} };
        }
        return { domain: "cto_voice", action: request.action, result: { ok: true, chunks: [], dropped: 0 }, statusHints: {} };
      }),
      subscribeEventsForRoot: vi.fn(async (_root, _req, onEvent) => {
        em.fn = onEvent as typeof em.fn;
        return releaseState;
      }),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });

    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    em.fn?.({ payload: { type: "cto_voice_state", state: liveState() } });
    ownerSend().mockClear();

    const ending = ipc.invoke(IPC.ctoVoiceEnd);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Mid-teardown, the runtime says why it failed.
    em.fn?.({
      payload: {
        type: "cto_voice_state",
        state: { ...CTO_VOICE_INITIAL_STATE, phase: "failed", error: "OpenAI rejected this key." },
      },
    });
    // The subscription must still be live at this point.
    expect(releaseState).not.toHaveBeenCalled();
    rel.fn?.();
    await ending;

    const sent = statesSentToOwner();
    expect(sent.some((state) => state.phase === "failed" && state.error === "OpenAI rejected this key.")).toBe(true);
    // `failed` is terminal but not finished — the HUD stays up for it — so the
    // call still has to end, carrying the sentence that explains it. Exactly
    // one `ended`, and no live phase after it.
    expect(sent.at(-1)).toMatchObject({ phase: "ended", error: "OpenAI rejected this key." });
    expect(sent.filter((state) => state.phase === "ended")).toHaveLength(1);
    expect(releaseState).toHaveBeenCalled();

    // An event that outlives the subscription cannot bring the call back: a
    // live phase here would put the HUD on screen again, counting.
    ownerSend().mockClear();
    em.fn?.({ payload: { type: "cto_voice_state", state: liveState() } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statesSentToOwner()).toEqual([]);
    // And Talk works again, because the slot was retired rather than wedged.
    expect(await ipc.invoke(IPC.ctoVoiceStart, undefined, 7)).toEqual({ ok: true });
  });
});

describe("which window may drive a call", () => {
  function runtimeCtx() {
    return {
      project: { rootPath: "/repo" },
      ctoVoiceCallService: null,
      logger: { warn: () => {} },
    } as unknown as AppContext;
  }

  function poolRecording(actions: string[]) {
    return {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => {
        actions.push(request.action);
        return {
          domain: "cto_voice",
          action: request.action,
          result: request.action === "start" ? { ok: true } : { ok: true, chunks: [], dropped: 0 },
          statusHints: {},
        };
      }),
      subscribeEventsForRoot: vi.fn(async () => () => {}),
    } as unknown as LocalRuntimeConnectionPool;
  }

  it("lets only the window holding the microphone mute, approve or deny", async () => {
    // These three DRIVE the call: they feed the socket and answer a permission
    // prompt on the user's behalf. A second window reaching them is the same
    // problem as a second window opening the microphone.
    const actions: string[] = [];
    const pool = poolRecording(actions);
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });
    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    actions.length = 0;

    await ipc.invoke(IPC.ctoVoiceSetMuted, { muted: true }, 9);
    await ipc.invoke(IPC.ctoVoiceApprove, { id: "c1" }, 9);
    await ipc.invoke(IPC.ctoVoiceDeny, { id: "c1" }, 9);
    expect(actions).toEqual([]);

    await ipc.invoke(IPC.ctoVoiceSetMuted, { muted: true }, 7);
    await ipc.invoke(IPC.ctoVoiceApprove, { id: "c1" }, 7);
    expect(actions).toEqual(["setMuted", "resolveApproval"]);
  });

  it("lets any window hang up, because that can only ever stop a call", async () => {
    const actions: string[] = [];
    const pool = poolRecording(actions);
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });
    await ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    actions.length = 0;

    await ipc.invoke(IPC.ctoVoiceEnd, undefined, 9);
    expect(actions).toContain("end");
  });

  it("hangs up a call that is still queued behind its own start", async () => {
    // `call` used to be read BEFORE the queue, so an End that landed while a
    // Start was still in flight saw a null slot, did nothing, and let the call
    // the user had just cancelled come up anyway.
    const actions: string[] = [];
    const rel: { fn: ((value: { ok: boolean }) => void) | null } = { fn: null };
    const pool = {
      callActionForRoot: vi.fn(async (_root: string, request: { action: string }) => {
        actions.push(request.action);
        if (request.action === "start") {
          const result = await new Promise<{ ok: boolean }>((resolve) => { rel.fn = resolve; });
          return { domain: "cto_voice", action: "start", result, statusHints: {} };
        }
        return {
          domain: "cto_voice",
          action: request.action,
          result: { ok: true, chunks: [], dropped: 0 },
          statusHints: {},
        };
      }),
      subscribeEventsForRoot: vi.fn(async () => () => {}),
    } as unknown as LocalRuntimeConnectionPool;
    const ipc = createIpcMain();
    registerCtoVoiceIpc(ipc.ipcMain, { getCtx: () => runtimeCtx(), getLocalRuntimePool: () => pool });

    const starting = ipc.invoke(IPC.ctoVoiceStart, undefined, 7);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ending = ipc.invoke(IPC.ctoVoiceEnd, undefined, 7);
    rel.fn?.({ ok: true });
    await starting;
    await ending;

    expect(actions).toContain("end");
  });
});
