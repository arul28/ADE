/**
 * `<AdeChat>` over the real Electron bridge, end to end, without Electron.
 *
 * WHY THIS EXISTS. Three packages have to agree for an Electron embedder to see
 * a single word of streamed text: `@ade-dev/sdk/electron` on the main side,
 * `@ade-dev/sdk/electron/renderer` on the other, and `adaptSdkClient` on top of
 * that. Each is unit-tested against its own fakes, and each passed while the
 * seam between them was broken — a capability field typed `unknown` on the
 * proxy is enough to stop the whole chain compiling, and a channel demux on the
 * wrong side is enough to stop it rendering. Nothing but an assembled run
 * catches that.
 *
 * WHAT IS FAKE AND WHAT IS REAL. The fakes are the two ends: an `ipcMain` and a
 * `webContents` on one side, an `ipcRenderer` on the other, and an SDK client
 * that scripts a turn. Everything between them is the shipped code, imported
 * through the package's own `exports` map so the built artifact is what runs.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { registerAdeIpc } from "@ade-dev/sdk/electron";
import type { AdeChatClient as SdkChatClient } from "@ade-dev/sdk";
import { createAdeIpcClient } from "@ade-dev/sdk/electron/renderer";
import type { AdeBridge } from "@ade-dev/sdk/electron/renderer";

import { AdeChat } from "../src/AdeChat";
import { adaptSdkClient, type SdkLikeChatClient } from "../src/adapters/sdkClient";
import type { AgentChatEventEnvelope } from "../src/sdkTypes";

/* -------------------------------------------------------------------------- */
/* The two ends                                                                */
/* -------------------------------------------------------------------------- */

type EventListener = (event: unknown, payload: unknown) => void;

/** A `webContents` that records the listeners main attaches to it. */
class FakeWebContents {
  readonly id = 1;
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  readonly rendererListeners = new Set<EventListener>();

  send(_channel: string, payload: unknown): void {
    for (const listener of [...this.rendererListeners]) listener(null, payload);
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
    return false;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
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
}

/* -------------------------------------------------------------------------- */
/* The SDK client main owns                                                    */
/* -------------------------------------------------------------------------- */

const providerRecord = {
  claude: {
    provider: "claude",
    displayName: "Claude",
    installed: true,
    binaryPath: "/usr/local/bin/claude",
    version: "2.0.0",
    authenticated: true,
    authMethod: "subscription",
    installCommand: "npm i -g @anthropic-ai/claude-code",
    loginCommand: "claude login",
    docsUrl: "https://example.test/claude",
    available: true,
    requiresConfiguration: false,
    modelCount: 1,
    stale: false,
    source: "probed",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
};

const catalog = [
  {
    id: "claude/haiku",
    displayName: "Haiku",
    provider: "claude",
    runtimeModelId: "claude-haiku-4-5",
    isDefault: true,
    isAvailable: true,
    connected: true,
    requiresConfiguration: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    description: null,
  },
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An SDK-shaped thread that scripts one streamed turn. */
class FakeSdkThread {
  readonly id = "session-1";
  readonly mcpCapability = null;
  readonly instructionsCapability = null;
  readonly settingSourcesCapability = null;
  readonly permissionCapability = null;
  private readonly listeners = new Set<(envelope: AgentChatEventEnvelope) => void>();
  private sequence = 0;
  /** Set to hold the reply open so a test can observe the running state. */
  gate: Promise<void> | null = null;
  seeded: AgentChatEventEnvelope[] = [];

  constructor(readonly key: string) {}

  on(_channel: string, cb: (envelope: AgentChatEventEnvelope) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(event: Record<string, unknown>): void {
    this.sequence += 1;
    const envelope: AgentChatEventEnvelope = {
      sessionId: this.id,
      timestamp: new Date(1_700_000_000_000 + this.sequence * 1000).toISOString(),
      sequence: this.sequence,
      event: event as AgentChatEventEnvelope["event"],
    };
    for (const cb of [...this.listeners]) cb(envelope);
  }

  async send(text: string): Promise<void> {
    const turnId = "turn-1";
    this.emit({ type: "user_message", text });
    this.emit({ type: "status", turnStatus: "started", turnId });
    if (this.gate) await this.gate;
    for (const chunk of ["Here is ", "what I found: ", "3 matches."]) {
      this.emit({ type: "text", text: chunk, messageId: "msg-1", turnId });
      await tick();
    }
    this.emit({ type: "status", turnStatus: "completed", turnId });
  }

  async steer(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async setModel(modelId: string): Promise<unknown> {
    return { modelId, provider: "claude", model: modelId };
  }
  async history(): Promise<AgentChatEventEnvelope[]> {
    return this.seeded;
  }
  async pendingApprovals(): Promise<unknown[]> {
    return [];
  }
}

/**
 * Assemble main, the bridge and a renderer client over one in-memory channel.
 *
 * `invoke` calls the real `ipcMain` handler and `send` pushes back to the real
 * renderer half, so every hop below is production code.
 */
function createBridgedClient() {
  const ipcMain = new FakeIpcMain();
  const webContents = new FakeWebContents();
  const thread = new FakeSdkThread("main");

  const sdkClient = {
    providers: {
      status: async () => providerRecord,
      refresh: async () => providerRecord,
      onChange: () => () => {},
    },
    models: { list: async () => catalog },
    threads: { open: async () => thread },
  } as unknown as SdkChatClient;

  const dispose = registerAdeIpc(ipcMain as never, sdkClient);

  const bridge: AdeBridge = {
    invoke: async (method, args) => {
      const handler = ipcMain.handlers.get("ade:invoke");
      if (!handler) throw new Error("registerAdeIpc attached no handler");
      return (await handler({ sender: webContents }, { method, args })) as never;
    },
    onEvent: (listener) => {
      const wrapped: EventListener = (_event, payload) => listener(payload as never);
      webContents.rendererListeners.add(wrapped);
      return () => {
        webContents.rendererListeners.delete(wrapped);
      };
    },
  };

  // No cast: the bridge's client is the shape `adaptSdkClient` consumes.
  const bridged: SdkLikeChatClient = createAdeIpcClient(bridge);
  const client = adaptSdkClient(bridged, { providerFilter: ["claude"] });
  return { client, thread, webContents, dispose };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("<AdeChat> over the Electron IPC bridge", () => {
  it("resolves the provider and model through the bridge before opening a thread", async () => {
    const { client } = createBridgedClient();
    render(<AdeChat client={client} threadKey="main" />);

    // The rail label proves the whole read path: providers.status and
    // models.list crossed the bridge and the model came back selectable.
    await waitFor(() => expect(screen.getByRole("button", { name: "Haiku" })).toBeTruthy());
  });

  it("renders a full streamed turn and returns the composer to idle", async () => {
    const { client } = createBridgedClient();
    render(<AdeChat client={client} threadKey="main" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Haiku" })).toBeTruthy());

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "find the matches" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The user message came back off the event stream, not from local echo.
    await waitFor(() => expect(screen.getByText("find the matches")).toBeTruthy());
    // Three chunks sharing one messageId fold into one row.
    await waitFor(() => expect(screen.getByText(/Here is what I found: 3 matches\./)).toBeTruthy());
    // `status` with turnStatus "completed" put the composer back to idle.
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
  });

  it("shows the turn as running until the completion event crosses the bridge", async () => {
    const { client, thread } = createBridgedClient();
    let release: (() => void) | null = null;
    thread.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(<AdeChat client={client} threadKey="main" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Haiku" })).toBeTruthy());

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "wait for me" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Running: the composer offers Steer, not Send.
    await waitFor(() => expect(screen.getByRole("button", { name: "Steer" })).toBeTruthy());

    await act(async () => {
      release?.();
      await tick();
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
  });

  it("replays history the bridge returns before any live event arrives", async () => {
    const { client, thread } = createBridgedClient();
    thread.seeded = [
      {
        sessionId: "session-1",
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        event: { type: "user_message", text: "an earlier question" },
      },
      {
        sessionId: "session-1",
        sequence: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        event: { type: "text", text: "an earlier answer", messageId: "old-1" },
      },
    ];

    const { container } = render(<AdeChat client={client} threadKey="main" />);
    await waitFor(() => expect(screen.getByText("an earlier question")).toBeTruthy());
    expect(screen.getByText("an earlier answer")).toBeTruthy();
    expect(container.textContent).toContain("an earlier answer");
  });

  it("drops every main-side subscription when the renderer goes away", async () => {
    const { client, webContents } = createBridgedClient();
    render(<AdeChat client={client} threadKey="main" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Haiku" })).toBeTruthy());
    await waitFor(() => expect(webContents.listenerCount()).toBeGreaterThan(0));

    webContents.emit("destroyed");

    expect(webContents.listenerCount()).toBe(0);
  });
});
