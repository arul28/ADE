/**
 * A fully typed in-memory `AdeChatClient`.
 *
 * Used by `examples/basic.tsx` and by the package's tests, so the same stub
 * proves the components and documents the contract `@ade-dev/sdk` must satisfy.
 * Nothing here talks to a network or a process.
 */

import type {
  AdeChatClient,
  AdeThread,
  AgentChatEvent,
  AgentChatEventEnvelope,
  ModelDescriptor,
  ProviderStatus,
  SendInput,
  ThreadStatus,
  ThreadUsage,
  Unsubscribe,
} from "../src/sdkTypes";

export const fakeProviders: ProviderStatus[] = [
  {
    id: "claude",
    displayName: "Claude",
    installed: true,
    authenticated: true,
    loginCommand: "claude login",
  },
  {
    id: "codex",
    displayName: "Codex",
    installed: true,
    authenticated: false,
    loginCommand: "codex login",
    detail: "Session expired 2 days ago.",
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    installed: false,
    authenticated: false,
    installCommand: "npm i -g opencode",
    loginCommand: "opencode auth login",
  },
];

export const fakeModels: ModelDescriptor[] = [
  { id: "claude-opus", providerId: "claude", displayName: "Opus", shortName: "opus" },
  { id: "claude-sonnet", providerId: "claude", displayName: "Sonnet", shortName: "sonnet" },
  { id: "codex-gpt", providerId: "codex", displayName: "GPT-5 Codex", aliases: ["gpt5"] },
  { id: "opencode-mix", providerId: "opencode", displayName: "Mixed", available: false },
];

type Listener<T> = (value: T) => void;

class FakeThread implements AdeThread {
  readonly key: string;
  private readonly events: AgentChatEventEnvelope[] = [];
  private readonly eventListeners = new Set<Listener<AgentChatEventEnvelope>>();
  private readonly statusListeners = new Set<Listener<ThreadStatus>>();
  private readonly usageListeners = new Set<Listener<ThreadUsage>>();
  private sequence = 0;
  private running = false;

  constructor(key: string, seed: AgentChatEvent[] = []) {
    this.key = key;
    for (const event of seed) this.emit(event);
  }

  /** Append an event and notify subscribers. Public so demos can script turns. */
  emit(event: AgentChatEvent): AgentChatEventEnvelope {
    const envelope: AgentChatEventEnvelope = {
      sessionId: this.key,
      timestamp: new Date().toISOString(),
      sequence: this.sequence,
      event,
    };
    this.sequence += 1;
    this.events.push(envelope);
    for (const listener of this.eventListeners) listener(envelope);
    return envelope;
  }

  setStatus(status: ThreadStatus): void {
    this.running = status.state === "running";
    for (const listener of this.statusListeners) listener(status);
  }

  setUsage(usage: ThreadUsage): void {
    for (const listener of this.usageListeners) listener(usage);
  }

  async history(): Promise<AgentChatEventEnvelope[]> {
    return [...this.events];
  }

  async send(input: SendInput | string): Promise<void> {
    const text = typeof input === "string" ? input : input.text;
    this.emit({ type: "user_message", text, turnId: `turn-${this.sequence}` });
    this.setStatus({ state: "running", turnId: `turn-${this.sequence}` });
    await this.scriptedReply(text);
  }

  async steer(input: SendInput | string): Promise<void> {
    const text = typeof input === "string" ? input : input.text;
    // A steer is a user message delivered into the turn already in flight; it
    // does not start a new one, so the status is left alone.
    this.emit({ type: "user_message", text });
  }

  async interrupt(): Promise<void> {
    if (!this.running) return;
    this.emit({ type: "status", turnStatus: "interrupted" });
    this.setStatus({ state: "idle" });
  }

  on(type: "event", cb: Listener<AgentChatEventEnvelope>): Unsubscribe;
  on(type: "usage", cb: Listener<ThreadUsage>): Unsubscribe;
  on(type: "status", cb: Listener<ThreadStatus>): Unsubscribe;
  on(type: "event" | "usage" | "status", cb: Listener<never>): Unsubscribe {
    if (type === "event") {
      const listener = cb as unknown as Listener<AgentChatEventEnvelope>;
      this.eventListeners.add(listener);
      return () => this.eventListeners.delete(listener);
    }
    if (type === "status") {
      const listener = cb as unknown as Listener<ThreadStatus>;
      this.statusListeners.add(listener);
      return () => this.statusListeners.delete(listener);
    }
    const listener = cb as unknown as Listener<ThreadUsage>;
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  /** A canned turn: reasoning, a tool round-trip, then streamed text. */
  private async scriptedReply(prompt: string): Promise<void> {
    const turnId = `turn-${this.sequence}`;
    const itemId = `item-${this.sequence}`;
    this.emit({ type: "reasoning", text: "Deciding which records to read.", turnId, itemId });
    this.emit({ type: "tool_call", tool: "server.tool", args: { query: prompt }, itemId, turnId });
    await tick();
    this.emit({
      type: "tool_result",
      tool: "server.tool",
      result: { matches: 3 },
      itemId,
      turnId,
      status: "completed",
    });
    const messageId = `msg-${this.sequence}`;
    for (const chunk of ["Here is ", "what I found: ", "**3 matches**."]) {
      this.emit({ type: "text", text: chunk, messageId, turnId });
      await tick();
    }
    this.emit({ type: "status", turnStatus: "completed", turnId });
    this.setUsage({ inputTokens: 120, outputTokens: 48, totalTokens: 168 });
    this.setStatus({ state: "idle" });
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

export type FakeClientOptions = {
  providers?: ProviderStatus[];
  models?: ModelDescriptor[];
  seed?: AgentChatEvent[];
};

export type FakeClient = AdeChatClient & {
  /** Threads opened so far, keyed by thread key. */
  readonly threads_: Map<string, FakeThread>;
  /** Push a new provider status list to every subscriber. */
  setProviders(next: ProviderStatus[]): void;
};

export function createFakeClient(options: FakeClientOptions = {}): FakeClient {
  let providers = options.providers ?? fakeProviders;
  const models = options.models ?? fakeModels;
  const threads = new Map<string, FakeThread>();
  const providerListeners = new Set<Listener<ProviderStatus[]>>();

  return {
    threads_: threads,
    setProviders(next) {
      providers = next;
      for (const listener of providerListeners) listener(next);
    },
    providers: {
      async status() {
        return providers;
      },
      onChange(cb) {
        providerListeners.add(cb);
        return () => providerListeners.delete(cb);
      },
    },
    models: {
      async list() {
        return models;
      },
    },
    threads: {
      async open(key) {
        const existing = threads.get(key);
        if (existing) return existing;
        const thread = new FakeThread(key, options.seed ?? []);
        threads.set(key, thread);
        return thread;
      },
    },
  };
}

export type { FakeThread };
