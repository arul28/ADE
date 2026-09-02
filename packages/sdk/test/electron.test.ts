/**
 * Electron bridge tests.
 *
 * NO ELECTRON HERE, ON PURPOSE. The bridge is defined against structural
 * interfaces, so the fakes below are the whole environment: a fake `ipcMain`, a
 * fake `WebContents` that records its own listeners, and a fake SDK client
 * whose threads count their subscribers. That is what makes the leak assertions
 * possible — a real `WebContents` will not tell you how many listeners main
 * left attached after fifty reloads.
 */

import { describe, expect, it, vi } from "vitest";

import { AdeError } from "../src/errors.js";
import {
  navigationEndsRendererWorld,
  registerAdeIpc,
  type RegisterAdeIpcOptions,
} from "../src/electron/main.js";
import { createAdeIpcClient } from "../src/electron/renderer.js";
import { exposeAdeBridge } from "../src/electron/preload.js";
import {
  compareEnvelopes,
  envelopeDedupeKey,
  mergeHistoryWithBuffer,
  type AdeBridge,
  type AdeIpcEventPayload,
  type AdeIpcInvokeResponse,
} from "../src/electron/protocol.js";
import type { AgentChatEventEnvelope } from "../src/types.js";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

class FakeWebContents {
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  readonly sent: unknown[] = [];
  /**
   * The renderer world's `ipcRenderer` listeners. A reload replaces the world,
   * so the harness clears this set rather than layering a second one on top.
   */
  rendererListeners = new Set<(event: unknown, payload: AdeIpcEventPayload) => void>();
  destroyed = false;

  constructor(readonly id: number) {}

  send(_channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error("send after destroy");
    this.sent.push(payload);
    for (const listener of [...this.rendererListeners]) {
      listener(null, payload as AdeIpcEventPayload);
    }
  }

  on(event: string, listener: (...args: any[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    return this.on(event, listener);
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeIpcMain {
  readonly handlers = new Map<string, (event: any, ...args: any[]) => unknown>();

  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, sender: FakeWebContents, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({ sender }, payload);
  }
}

let nextSessionId = 0;

class FakeThread {
  readonly id = `session-${++nextSessionId}`;
  readonly listeners = new Set<(envelope: AgentChatEventEnvelope) => void>();
  readonly sends: { text: string; opts?: unknown }[] = [];
  readonly approvals: unknown[][] = [];
  historyPage: AgentChatEventEnvelope[] = [];
  historyGate: Promise<void> | null = null;
  sendError: unknown = null;
  mcpCapability: unknown = { level: "enforced", mechanism: "test", residual: null };
  instructionsCapability: unknown = { level: "applied", mode: "append", detail: null };
  settingSourcesCapability: unknown = { level: "applied", value: "none", detail: null };
  permissionCapability: unknown = { level: "enforced", mechanism: "test", residual: null };

  constructor(readonly key: string) {}

  on(_channel: string, cb: (envelope: AgentChatEventEnvelope) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(envelope: AgentChatEventEnvelope): void {
    for (const cb of [...this.listeners]) cb(envelope);
  }

  async send(text: string, opts?: unknown): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sends.push({ text, opts });
  }

  async steer(_text: string): Promise<void> {}
  async interrupt(): Promise<void> {}
  async setModel(modelId: string): Promise<unknown> {
    return { modelId, provider: "claude", model: modelId };
  }
  async history(): Promise<AgentChatEventEnvelope[]> {
    if (this.historyGate) await this.historyGate;
    return this.historyPage;
  }
  async approve(...args: unknown[]): Promise<void> {
    this.approvals.push(args);
  }
  async pendingApprovals(): Promise<unknown[]> {
    return [{ itemId: "item-1", kind: "command", description: "ls", provider: "claude" }];
  }
}

class FakeClient {
  readonly threads_ = new Map<string, FakeThread>();
  readonly providerListeners = new Set<(statuses: Record<string, unknown>) => void>();
  readonly openCalls: { key: string; opts: unknown }[] = [];
  openGate: Promise<void> | null = null;
  statusRecord: Record<string, unknown> = {
    claude: { provider: "claude", displayName: "Claude", authenticated: true },
  };
  refreshed = 0;

  providers = {
    status: async () => this.statusRecord,
    refresh: async () => {
      this.refreshed += 1;
      return this.statusRecord;
    },
    onChange: (cb: (statuses: Record<string, unknown>) => void) => {
      this.providerListeners.add(cb);
      return () => {
        this.providerListeners.delete(cb);
      };
    },
  };

  models = { list: async () => [{ id: "m", displayName: "M", provider: "claude" }] };

  threads = {
    open: async (key: string, opts?: unknown) => {
      this.openCalls.push({ key, opts });
      if (this.openGate) await this.openGate;
      const existing = this.threads_.get(key);
      if (existing) return existing;
      const thread = new FakeThread(key);
      this.threads_.set(key, thread);
      return thread;
    },
  };

  threadListenerCount(): number {
    let total = 0;
    for (const thread of this.threads_.values()) total += thread.listeners.size;
    return total;
  }

  emitProviders(statuses: Record<string, unknown>): void {
    for (const cb of [...this.providerListeners]) cb(statuses);
  }
}

/** Wire a fake renderer to a fake main process through the real preload code. */
function createHarness(opts: RegisterAdeIpcOptions = {}) {
  const ipcMain = new FakeIpcMain();
  const client = new FakeClient();
  const dispose = registerAdeIpc(ipcMain as any, client as any, opts);
  const prefix = opts.channelPrefix?.trim() || "ade";

  /**
   * Build a renderer world on a `webContents`, through the real preload code.
   *
   * Calling it a second time on the same `webContents` is a RELOAD: the old
   * world's listeners are dropped and a fresh bridge and client are built, which
   * is exactly the situation the leak tests are about.
   */
  function attachRenderer(webContents: FakeWebContents) {
    webContents.rendererListeners = new Set();
    const ipcRenderer = {
      invoke: (channel: string, payload: unknown) =>
        ipcMain.invoke(channel, webContents, payload) as Promise<AdeIpcInvokeResponse>,
      on: (_channel: string, listener: (event: unknown, payload: AdeIpcEventPayload) => void) => {
        webContents.rendererListeners.add(listener);
      },
      removeListener: (
        _channel: string,
        listener: (event: unknown, payload: AdeIpcEventPayload) => void,
      ) => {
        webContents.rendererListeners.delete(listener);
      },
    };

    let bridge: AdeBridge | null = null;
    const contextBridge = {
      exposeInMainWorld: (_key: string, api: unknown) => {
        bridge = api as AdeBridge;
      },
    };
    exposeAdeBridge(contextBridge, ipcRenderer as any, { channelPrefix: prefix });
    if (!bridge) throw new Error("preload exposed nothing");
    return { webContents, bridge: bridge as AdeBridge, client: createAdeIpcClient(bridge) };
  }

  function attachWindow(id: number) {
    return attachRenderer(new FakeWebContents(id));
  }

  return { ipcMain, client, dispose, attachWindow, attachRenderer };
}

function envelope(
  sessionId: string,
  sequence: number,
  type = "text",
  extra: Record<string, unknown> = {},
): AgentChatEventEnvelope {
  return {
    sessionId,
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
    event: { type, ...extra },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* -------------------------------------------------------------------------- */
/* Registry lifetime                                                           */
/* -------------------------------------------------------------------------- */

describe("main registry lifetime", () => {
  it("disposes every subscription and releases both threads when the webContents is destroyed", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);

    const first = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const second = await window.client.threads.open("b", { provider: "claude", model: "m" });
    first.on("event", () => {});
    second.on("event", () => {});
    window.client.providers.onChange(() => {});
    await flush();

    expect(harness.client.threadListenerCount()).toBe(2);
    expect(harness.client.providerListeners.size).toBe(1);
    expect(window.webContents.listenerCount()).toBeGreaterThan(0);

    window.webContents.destroy();

    expect(harness.client.threadListenerCount()).toBe(0);
    expect(harness.client.providerListeners.size).toBe(0);
    expect(window.webContents.listenerCount()).toBe(0);
  });

  it("releases subscriptions on a cross-document navigation and keeps the SDK thread alive", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    thread.on("event", () => {});
    await flush();
    expect(harness.client.threadListenerCount()).toBe(1);

    window.webContents.emit("did-navigate", {}, "https://example.test/next");

    expect(harness.client.threadListenerCount()).toBe(0);
    // The conversation itself survives: the bridge dropped listeners, not the
    // SDK's session.
    expect(harness.client.threads_.get("a")).toBeDefined();
  });

  it("ignores a same-document navigation, which does not replace the renderer's world", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    thread.on("event", () => {});
    await flush();

    window.webContents.emit("did-start-navigation", {
      url: "https://example.test/#tab",
      isSameDocument: true,
      isMainFrame: true,
    });

    expect(harness.client.threadListenerCount()).toBe(1);
  });

  it("reads both the modern details object and the legacy positional navigation arguments", () => {
    expect(navigationEndsRendererWorld([{ isSameDocument: false, isMainFrame: true }])).toBe(true);
    expect(navigationEndsRendererWorld([{ isSameDocument: true, isMainFrame: true }])).toBe(false);
    expect(navigationEndsRendererWorld([{ isSameDocument: false, isMainFrame: false }])).toBe(false);
    expect(navigationEndsRendererWorld([{}, "https://a.test", false, true])).toBe(true);
    expect(navigationEndsRendererWorld([{}, "https://a.test", true, true])).toBe(false);
    expect(navigationEndsRendererWorld([{}, "https://a.test", false, false])).toBe(false);
  });

  it("leaves the main-side listener count flat across 50 renderer reloads", async () => {
    const harness = createHarness();
    const webContents = new FakeWebContents(1);

    for (let i = 0; i < 50; i += 1) {
      // A reload keeps the `webContents` and replaces the JavaScript world, so
      // the renderer's own unsubscribes never run. Main has to clean up alone.
      const window = harness.attachRenderer(webContents);
      const thread = await window.client.threads.open("main", { provider: "claude", model: "m" });
      thread.on("event", () => {});
      thread.on("status", () => {});
      window.client.providers.onChange(() => {});
      await flush();

      expect(harness.client.threadListenerCount()).toBe(1);
      expect(harness.client.providerListeners.size).toBe(1);

      webContents.emit("did-start-navigation", {
        url: `https://example.test/${i}`,
        isSameDocument: false,
        isMainFrame: true,
      });
      await flush();

      expect(harness.client.threadListenerCount()).toBe(0);
      expect(harness.client.providerListeners.size).toBe(0);
      expect(webContents.listenerCount()).toBe(0);
    }
  });

  it("keeps one main-side listener per key however many renderer listeners attach", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });

    const stops = [thread.on("event", () => {}), thread.on("status", () => {}), thread.on("usage", () => {})];
    await flush();
    expect(harness.client.threads_.get("a")!.listeners.size).toBe(1);

    stops[0]!();
    stops[1]!();
    await flush();
    expect(harness.client.threads_.get("a")!.listeners.size).toBe(1);

    stops[2]!();
    await flush();
    expect(harness.client.threads_.get("a")!.listeners.size).toBe(0);
  });

  it("collapses concurrent opens of one key into a single SDK open", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    let release: (() => void) | null = null;
    harness.client.openGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const both = Promise.all([
      window.client.threads.open("a", { provider: "claude", model: "m" }),
      window.client.threads.open("a", { provider: "claude", model: "m" }),
    ]);
    release!();
    const [first, second] = await both;

    expect(harness.client.openCalls).toHaveLength(1);
    expect(first.id).toBe(second.id);
  });

  it("removes the handler and every renderer on dispose", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    thread.on("event", () => {});
    await flush();

    harness.dispose();

    expect(harness.ipcMain.handlers.size).toBe(0);
    expect(harness.client.threadListenerCount()).toBe(0);
    expect(window.webContents.listenerCount()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

describe("error propagation", () => {
  it("keeps AdeError.code intact across the boundary", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    harness.client.threads_.get("a")!.sendError = new AdeError(
      "invalid_option",
      "send() needs text or at least one attachment.",
    );

    await expect(thread.send("hi")).rejects.toMatchObject({
      name: "AdeError",
      code: "invalid_option",
      message: "send() needs text or at least one attachment.",
    });
  });

  it("flattens a plain Error to rpc_error rather than losing its message", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    harness.client.threads_.get("a")!.sendError = new Error("provider exploded");

    await expect(thread.send("hi")).rejects.toMatchObject({
      code: "rpc_error",
      message: "provider exploded",
    });
  });

  it("rejects an unknown method instead of reaching a prototype member", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const response = (await window.bridge.invoke("constructor", [])) as AdeIpcInvokeResponse;
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error.code).toBe("invalid_option");
  });

  it("refuses a thread method for a key this renderer never opened", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const response = (await window.bridge.invoke("thread.send", [
      "never-opened",
      "hi",
    ])) as AdeIpcInvokeResponse;
    expect(response.ok === false && response.error.code).toBe("thread_not_found");
  });
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

describe("authorization gates", () => {
  it("rejects with unauthorized and never calls the SDK when authorize returns false", async () => {
    const authorize = vi.fn(async () => false);
    const harness = createHarness({ authorize });
    const window = harness.attachWindow(1);

    await expect(
      window.client.threads.open("a", { provider: "claude", model: "m" }),
    ).rejects.toMatchObject({ name: "AdeError", code: "unauthorized" });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(harness.client.openCalls).toHaveLength(0);
  });

  it("rejects a thread key the host disallows", async () => {
    const harness = createHarness({ allowThreadKey: (key) => key === "allowed" });
    const window = harness.attachWindow(1);

    await expect(
      window.client.threads.open("blocked", { provider: "claude", model: "m" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(harness.client.openCalls).toHaveLength(0);

    const ok = await window.client.threads.open("allowed", { provider: "claude", model: "m" });
    expect(ok.key).toBe("allowed");
  });

  it("does not gate provider or model calls on allowThreadKey", async () => {
    const harness = createHarness({ allowThreadKey: () => false });
    const window = harness.attachWindow(1);
    await expect(window.client.providers.status()).resolves.toBeTruthy();
    await expect(window.client.models.list()).resolves.toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

describe("history and live interleave", () => {
  it("delivers every envelope exactly once, in envelope order, when live events beat history", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const fake = harness.client.threads_.get("a")!;
    const sessionId = fake.id;

    const live: AgentChatEventEnvelope[] = [];
    thread.on("event", (received) => live.push(received));
    await flush();

    fake.historyPage = [envelope(sessionId, 1), envelope(sessionId, 2)];
    let releaseHistory: (() => void) | null = null;
    fake.historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = thread.history();
    await flush();
    // Three live envelopes land while history is still in flight.
    fake.emit(envelope(sessionId, 3));
    fake.emit(envelope(sessionId, 4));
    fake.emit(envelope(sessionId, 5));
    releaseHistory!();
    const page = await pending;

    // The subscriber saw all three, and history did not repeat them.
    expect(live.map((row) => row.sequence)).toEqual([3, 4, 5]);
    expect(page.map((row) => row.sequence)).toEqual([1, 2]);

    const combined = [...page, ...live];
    const keys = combined.map(envelopeDedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...combined].sort(compareEnvelopes).map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("compareEnvelopes", () => {
  function row(
    sequence: number | undefined,
    timestamp: string,
  ): AgentChatEventEnvelope {
    return {
      sessionId: "s",
      sequence,
      timestamp,
      event: { type: "text" },
    };
  }

  it("orders a mixed page by sequence first, matching chat-ui", () => {
    // The intransitive case: A < B by sequence, B < C by timestamp, C < A by
    // timestamp, unless numbered envelopes come first unconditionally.
    const a = row(1, "2026-01-01T00:00:03.000Z");
    const b = row(2, "2026-01-01T00:00:01.000Z");
    const c = row(undefined, "2026-01-01T00:00:02.000Z");
    expect([c, b, a].sort(compareEnvelopes)).toEqual([a, b, c]);
    expect([a, c, b].sort(compareEnvelopes)).toEqual([a, b, c]);
  });

  it("keeps arrival order when two numbered envelopes share a sequence", () => {
    const first = row(1, "2026-01-01T00:00:02.000Z");
    const second = row(1, "2026-01-01T00:00:01.000Z");
    expect([first, second].sort(compareEnvelopes)).toEqual([first, second]);
  });
});

describe("history and live merge", () => {
  it("folds live envelopes into the page when no subscriber was listening", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const fake = harness.client.threads_.get("a")!;
    const sessionId = fake.id;

    fake.historyPage = [envelope(sessionId, 1)];
    let releaseHistory: (() => void) | null = null;
    fake.historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = thread.history();
    await flush();
    fake.emit(envelope(sessionId, 2));
    releaseHistory!();

    expect((await pending).map((row) => row.sequence)).toEqual([1, 2]);
  });

  it("folds a usage envelope into the page when only a usage meter was listening", async () => {
    // The ordinary mount order: a usage meter is attached, and the transcript
    // calls history() to seed itself BEFORE attaching its own "event"
    // listener. One delivered-flag per envelope counted the meter's delivery
    // as everyone's, so the transcript never saw the envelope at all.
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const fake = harness.client.threads_.get("a")!;
    const sessionId = fake.id;

    const usage: number[] = [];
    thread.on("usage", (row) => usage.push(row.sequence!));
    await flush();

    fake.historyPage = [envelope(sessionId, 1)];
    let releaseHistory: (() => void) | null = null;
    fake.historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = thread.history();
    await flush();
    fake.emit(envelope(sessionId, 2, "tokens"));
    releaseHistory!();

    expect(usage).toEqual([2]);
    expect((await pending).map((row) => row.sequence)).toEqual([1, 2]);
  });

  it("does not repeat an envelope the event channel already delivered", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const fake = harness.client.threads_.get("a")!;
    const sessionId = fake.id;

    const live: number[] = [];
    thread.on("event", (row) => live.push(row.sequence!));
    thread.on("usage", () => {});
    await flush();

    fake.historyPage = [envelope(sessionId, 1)];
    let releaseHistory: (() => void) | null = null;
    fake.historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = thread.history();
    await flush();
    fake.emit(envelope(sessionId, 2, "tokens"));
    releaseHistory!();

    expect(live).toEqual([2]);
    expect((await pending).map((row) => row.sequence)).toEqual([1]);
  });

  it("splits channels the way the SDK does, from one main-side subscription", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const fake = harness.client.threads_.get("a")!;

    const all: string[] = [];
    const status: string[] = [];
    const usage: string[] = [];
    thread.on("event", (row) => all.push(row.event.type));
    thread.on("status", (row) => status.push(row.event.type));
    thread.on("usage", (row) => usage.push(row.event.type));
    await flush();

    fake.emit(envelope(fake.id, 1, "text"));
    fake.emit(envelope(fake.id, 2, "done"));
    fake.emit(envelope(fake.id, 3, "tokens"));

    expect(all).toEqual(["text", "done", "tokens"]);
    expect(status).toEqual(["done"]);
    expect(usage).toEqual(["tokens"]);
  });

  it("passes an unknown event type through untouched", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const fake = harness.client.threads_.get("a")!;

    const seen: AgentChatEventEnvelope[] = [];
    thread.on("event", (row) => seen.push(row));
    await flush();

    fake.emit(envelope(fake.id, 1, "versic_waveform_ready", { payload: { bars: [1, 2, 3] } }));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toEqual({
      type: "versic_waveform_ready",
      payload: { bars: [1, 2, 3] },
    });
  });

  it("merges and orders on the documented dedupe key", () => {
    const a = envelope("s", 2);
    const b = envelope("s", 1);
    expect(mergeHistoryWithBuffer([a, b], [a]).map((row) => row.sequence)).toEqual([1, 2]);
    expect(envelopeDedupeKey(a)).toBe(`s:2:${a.timestamp}:text`);
  });
});

/* -------------------------------------------------------------------------- */
/* Window isolation                                                            */
/* -------------------------------------------------------------------------- */

describe("two windows", () => {
  it("delivers each window's events only to that window", async () => {
    const harness = createHarness();
    const one = harness.attachWindow(1);
    const two = harness.attachWindow(2);

    const threadOne = await one.client.threads.open("a", { provider: "claude", model: "m" });
    const threadTwo = await two.client.threads.open("b", { provider: "claude", model: "m" });
    const seenOne: number[] = [];
    const seenTwo: number[] = [];
    threadOne.on("event", (row) => seenOne.push(row.sequence!));
    threadTwo.on("event", (row) => seenTwo.push(row.sequence!));
    await flush();

    harness.client.threads_.get("a")!.emit(envelope("session-a", 1));
    harness.client.threads_.get("b")!.emit(envelope("session-b", 2));

    expect(seenOne).toEqual([1]);
    expect(seenTwo).toEqual([2]);
    expect(one.webContents.sent).toHaveLength(1);
    expect(two.webContents.sent).toHaveLength(1);
  });

  it("destroying one window leaves the other's subscription intact", async () => {
    const harness = createHarness();
    const one = harness.attachWindow(1);
    const two = harness.attachWindow(2);
    (await one.client.threads.open("a", { provider: "claude", model: "m" })).on("event", () => {});
    (await two.client.threads.open("b", { provider: "claude", model: "m" })).on("event", () => {});
    await flush();

    one.webContents.destroy();

    expect(harness.client.threads_.get("a")!.listeners.size).toBe(0);
    expect(harness.client.threads_.get("b")!.listeners.size).toBe(1);
  });

  it("gives each window its own provider subscription", async () => {
    const harness = createHarness();
    const one = harness.attachWindow(1);
    const two = harness.attachWindow(2);
    const seenOne: unknown[] = [];
    const seenTwo: unknown[] = [];
    one.client.providers.onChange((statuses) => seenOne.push(statuses));
    two.client.providers.onChange((statuses) => seenTwo.push(statuses));
    await flush();

    harness.client.emitProviders({ claude: { provider: "claude" } as never });

    expect(seenOne).toHaveLength(1);
    expect(seenTwo).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Forwarded surface                                                           */
/* -------------------------------------------------------------------------- */

describe("forwarded surface", () => {
  it("returns the capability snapshot from threads.open", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });

    expect(thread.key).toBe("a");
    expect(thread.id).toBe(harness.client.threads_.get("a")!.id);
    expect(thread.mcpCapability).toMatchObject({ level: "enforced" });
    expect(thread.instructionsCapability).toMatchObject({ mode: "append" });
    expect(thread.settingSourcesCapability).toMatchObject({ value: "none" });
    expect(thread.permissionCapability).toMatchObject({ level: "enforced" });
  });

  it("forwards send options, setModel, approve and pendingApprovals", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const fake = harness.client.threads_.get("a")!;

    await thread.send("hello", { attachments: [{ path: "/tmp/a.wav", name: "a.wav" }] });
    expect(fake.sends[0]).toMatchObject({
      text: "hello",
      opts: { attachments: [{ path: "/tmp/a.wav", name: "a.wav" }] },
    });

    await expect(thread.setModel("m2")).resolves.toMatchObject({ modelId: "m2" });
    await thread.approve("item-1", "accept");
    expect(fake.approvals[0]).toEqual(["item-1", "accept", undefined]);
    await expect(thread.pendingApprovals()).resolves.toHaveLength(1);
  });

  it("refuses a decision that is not one of the three, at the bridge", async () => {
    // The bridge narrows `decision` itself rather than forwarding an arbitrary
    // string into a parameter declared as a three-member union. A compromised
    // renderer cannot reach `thread.approve` with anything else.
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const fake = harness.client.threads_.get("a")!;

    await expect(
      thread.approve("item-1", "approve-everything-forever" as never),
    ).rejects.toMatchObject({ code: "invalid_option" });
    expect(fake.approvals).toHaveLength(0);
  });

  it("forwards providers.refresh to the client", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    await window.client.providers.refresh();
    expect(harness.client.refreshed).toBe(1);
  });

  it("releases the provider subscription when the last listener leaves", async () => {
    const harness = createHarness();
    const window = harness.attachWindow(1);
    const stopA = window.client.providers.onChange(() => {});
    const stopB = window.client.providers.onChange(() => {});
    await flush();
    expect(harness.client.providerListeners.size).toBe(1);

    stopA();
    await flush();
    expect(harness.client.providerListeners.size).toBe(1);

    stopB();
    await flush();
    expect(harness.client.providerListeners.size).toBe(0);
  });

  it("honours a custom channel prefix end to end", async () => {
    const harness = createHarness({ channelPrefix: "versic-ade" });
    expect(harness.ipcMain.handlers.has("versic-ade:invoke")).toBe(true);
    const window = harness.attachWindow(1);
    const thread = await window.client.threads.open("a", { provider: "claude", model: "m" });
    const seen: AgentChatEventEnvelope[] = [];
    thread.on("event", (row) => seen.push(row));
    await flush();
    harness.client.threads_.get("a")!.emit(envelope("s", 1));
    expect(seen).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Serialization                                                               */
/* -------------------------------------------------------------------------- */

describe("structuredClone round trips", () => {
  it("carries ThreadOpenOptions with http and stdio MCP servers", () => {
    const options = {
      provider: "claude",
      model: "claude-sonnet-4-5",
      title: "Session",
      reasoningEffort: "medium",
      loadUserMcpServers: false,
      settingSources: "project",
      cwd: "/Users/x/Projects/demo",
      instructions: { mode: "append", text: "Answer briefly." },
      permissions: {
        allowedTools: ["Bash", "mcp:notes:*"],
        deniedTools: ["Write"],
        autoApproveMcpServers: ["notes"],
        sandboxRoot: "/Users/x/Projects/demo",
        fallback: "ask",
      },
      mcpServers: {
        notes: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "t" } },
        local: { type: "stdio", command: "node", args: ["server.mjs"], env: { A: "1" } },
      },
    };
    expect(structuredClone(options)).toEqual(options);
  });

  it("carries SendOptions with attachments", () => {
    const options = {
      attachments: [{ path: "/tmp/take-1.wav", name: "take-1.wav", mimeType: "audio/wav", bytes: 12 }],
      displayText: "the take",
      reasoningEffort: null,
    };
    expect(structuredClone(options)).toEqual(options);
  });

  it("carries an envelope with an unknown event type", () => {
    const unknown = envelope("s", 9, "some_future_kind", {
      nested: { list: [1, "two", null], flag: true },
    });
    expect(structuredClone(unknown)).toEqual(unknown);
  });

  it("carries the flattened AdeError payload", () => {
    const payload = {
      __adeError: true as const,
      name: "AdeError" as const,
      code: "unauthorized",
      message: "The host refused threads.open for this renderer.",
    };
    expect(structuredClone(payload)).toEqual(payload);
  });

  it("cannot carry an AdeError instance, which is why the payload exists", () => {
    const error = new AdeError("invalid_option", "nope");
    const cloned = structuredClone({ code: error.code, message: error.message });
    expect(cloned.code).toBe("invalid_option");
    // The class itself does not survive: only the shape above does.
    expect(structuredClone(error as unknown as Record<string, unknown>)).not.toBeInstanceOf(
      AdeError,
    );
  });
});
