import { describe, expect, it, vi } from "vitest";
import {
  adaptSdkClient,
  modelDescriptorsFromSdk,
  providerStatusesFromSdk,
  threadStatusFromEnvelope,
  threadUsageFromEnvelope,
  type SdkLikeChatClient,
  type SdkLikeThread,
  type SdkProviderStatus,
} from "../src/adapters/sdkClient";
import type { AdeChatClient } from "@ade-dev/sdk";
import type { AgentChatEventEnvelope, Unsubscribe } from "../src/sdkTypes";

/**
 * The envelopes below are copied from a real ADE transcript
 * (`<home>/personal-chats/state/.ade/transcripts/*.chat.jsonl`) produced by a
 * live Claude turn, not invented — the field names are the contract.
 */
function envelope(event: Record<string, unknown>): AgentChatEventEnvelope {
  return {
    sessionId: "s1",
    timestamp: "2026-08-31T04:20:47.102Z",
    event: event as AgentChatEventEnvelope["event"],
  };
}

const sdkStatuses: Record<string, SdkProviderStatus> = {
  claude: {
    provider: "claude",
    displayName: "Claude",
    authenticated: true,
    available: true,
    requiresConfiguration: false,
    modelCount: 6,
    stale: false,
  },
  codex: {
    provider: "codex",
    displayName: "Codex",
    authenticated: false,
    available: false,
    requiresConfiguration: true,
    modelCount: 4,
    stale: false,
  },
  droid: {
    provider: "droid",
    displayName: "Droid",
    authenticated: false,
    available: false,
    requiresConfiguration: false,
    modelCount: 0,
    stale: false,
  },
};

describe("threadStatusFromEnvelope", () => {
  it("maps the turn lifecycle", () => {
    expect(threadStatusFromEnvelope(envelope({ type: "status", turnStatus: "started", turnId: "t1" })))
      .toEqual({ state: "running", turnId: "t1" });
    expect(threadStatusFromEnvelope(envelope({ type: "status", turnStatus: "completed" })))
      .toEqual({ state: "idle", turnId: null });
    expect(threadStatusFromEnvelope(envelope({ type: "status", turnStatus: "interrupted" })))
      .toEqual({ state: "idle", turnId: null });
    expect(threadStatusFromEnvelope(envelope({ type: "done" }))).toEqual({ state: "idle", turnId: null });
  });

  it("carries an error message through", () => {
    expect(threadStatusFromEnvelope(envelope({ type: "error", message: "rate limited" }))).toEqual({
      state: "error",
      turnId: null,
      message: "rate limited",
    });
  });

  it("returns null for envelopes that say nothing about the running state", () => {
    // Dropping the composer out of "running" on an unrelated event would
    // re-enable Send in the middle of a turn.
    expect(threadStatusFromEnvelope(envelope({ type: "activity", activity: "working" }))).toBeNull();
    expect(threadStatusFromEnvelope(envelope({ type: "status", turnStatus: "who-knows" }))).toBeNull();
    expect(threadStatusFromEnvelope(envelope({ type: "text", text: "hi" }))).toBeNull();
  });
});

describe("threadUsageFromEnvelope", () => {
  it("reads the nested context_usage shape", () => {
    const usage = threadUsageFromEnvelope(
      envelope({
        type: "context_usage",
        usage: { totalTokens: 35276, maxTokens: 200000, categories: [] },
      }),
    );
    expect(usage).toEqual({ totalTokens: 35276, contextWindow: 200000 });
  });

  it("reads flat token events and derives the total", () => {
    expect(threadUsageFromEnvelope(envelope({ type: "tokens", inputTokens: 10, outputTokens: 4 })))
      .toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  });

  it("accepts snake_case from providers that emit it", () => {
    expect(
      threadUsageFromEnvelope(envelope({ type: "codex_token_usage", input_tokens: 3, output_tokens: 5 })),
    ).toEqual({ inputTokens: 3, outputTokens: 5, totalTokens: 8 });
  });

  it("returns null when there are no numbers", () => {
    expect(threadUsageFromEnvelope(envelope({ type: "context_usage", usage: {} }))).toBeNull();
    expect(threadUsageFromEnvelope(envelope({ type: "text", text: "hi" }))).toBeNull();
  });
});

describe("providerStatusesFromSdk", () => {
  it("keys off modelCount for installed, never off authenticated", () => {
    const [claude, codex, droid] = providerStatusesFromSdk(sdkStatuses);
    expect(claude).toMatchObject({ id: "claude", installed: true, authenticated: true });
    expect(claude?.detail).toBeUndefined();
    // Signed out but known: still "installed", so the card offers login rather
    // than an install command.
    expect(codex).toMatchObject({ id: "codex", installed: true, authenticated: false, detail: "Not signed in." });
    expect(droid).toMatchObject({ id: "droid", installed: false });
  });

  it("applies command hints and the provider filter order", () => {
    const statuses = providerStatusesFromSdk(sdkStatuses, {
      providerFilter: ["codex", "claude"],
      commandHints: { codex: { loginCommand: "codex login" } },
    });
    expect(statuses.map((entry) => entry.id)).toEqual(["codex", "claude"]);
    expect(statuses[0]?.loginCommand).toBe("codex login");
    expect(statuses[1]?.loginCommand).toBeUndefined();
  });
});

describe("modelDescriptorsFromSdk", () => {
  it("renames provider to providerId and only forwards an explicit false", () => {
    const models = modelDescriptorsFromSdk([
      { id: "a", displayName: "A", provider: "claude", isAvailable: true },
      { id: "b", displayName: "B", provider: "claude", isAvailable: false },
      { id: "c", displayName: "C", provider: "claude" },
      { id: "d", displayName: "D", provider: "codex" },
    ], { providerFilter: ["claude"] });
    expect(models.map((model) => model.id)).toEqual(["a", "b", "c"]);
    expect(models[0]?.providerId).toBe("claude");
    expect(models[0]?.available).toBeUndefined();
    expect(models[1]?.available).toBe(false);
    expect(models[2]?.available).toBeUndefined();
  });
});

describe("the shape adaptSdkClient accepts", () => {
  /**
   * A compile-time guard, not a runtime one. `SdkLikeChatClient` deliberately
   * relaxes parts of the SDK's own interface so proxies qualify, which means
   * nothing else would catch `@ade-dev/sdk` growing a required argument or renaming
   * a channel. This assignment fails `tsc` the moment a real client stops
   * fitting.
   */
  it("still fits a real @ade-dev/sdk client", () => {
    const real = null as unknown as AdeChatClient;
    const accepted: SdkLikeChatClient = real;
    expect(accepted).toBeNull();
  });
});

describe("adaptSdkClient", () => {
  function fakeSdk() {
    const listeners: Array<(envelope: AgentChatEventEnvelope) => void> = [];
    const thread: SdkLikeThread & { sent: Array<[string, unknown]> } = {
      id: "session-1",
      key: "main",
      sent: [] as Array<[string, unknown]>,
      async send(text, opts) {
        this.sent.push([text, opts]);
      },
      async steer() {},
      async interrupt() {},
      async history() {
        return [];
      },
      on(_channel, cb): Unsubscribe {
        listeners.push(cb);
        return () => {
          listeners.splice(listeners.indexOf(cb), 1);
        };
      },
    };
    const open = vi.fn(async (_key: string, _opts?: Record<string, unknown>) => thread);
    const sdk: SdkLikeChatClient = {
      providers: { status: async () => sdkStatuses, onChange: () => () => {} },
      models: {
        list: async () => [
          { id: "anthropic/claude-haiku-4-5", displayName: "Haiku", provider: "claude" },
          { id: "openai/gpt-5-codex", displayName: "GPT-5 Codex", provider: "codex" },
        ],
      },
      threads: { open },
    };
    return { sdk, thread, open, listeners };
  }

  it("merges host defaults into every open call", async () => {
    const { sdk, open } = fakeSdk();
    const client = adaptSdkClient(sdk, {
      defaults: {
        provider: "claude",
        model: "anthropic/claude-haiku-4-5",
        permissions: "always-allow",
        mcpServers: { demodata: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      },
    });
    await client.threads.open("main");
    expect(open).toHaveBeenCalledWith("main", expect.objectContaining({
      provider: "claude",
      model: "anthropic/claude-haiku-4-5",
      permissions: "always-allow",
      mcpServers: { demodata: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    }));
  });

  it("lets the catalog correct the provider when the picker changes model", async () => {
    const { sdk, open } = fakeSdk();
    const client = adaptSdkClient(sdk, { defaults: { provider: "claude", model: "anthropic/claude-haiku-4-5" } });
    await client.models.list();
    await client.threads.open("main", { modelId: "openai/gpt-5-codex" });
    expect(open.mock.calls[0]?.[1]).toMatchObject({ provider: "codex", model: "openai/gpt-5-codex" });
  });

  it("translates SendInput and attachments to the SDK's positional call", async () => {
    const { sdk, thread } = fakeSdk();
    const client = adaptSdkClient(sdk);
    const opened = await client.threads.open("main");
    await opened.send("plain");
    await opened.send({
      text: "with a file",
      attachments: [
        { id: "1", name: "a.pdf", uri: "/tmp/a.pdf", mimeType: "application/pdf", sizeBytes: 12 },
        { id: "2", name: "no-uri.pdf" },
      ],
    });
    expect(thread.sent[0]).toEqual(["plain", undefined]);
    // The attachment with no `uri` has no path to send and is dropped here
    // rather than failing inside the runtime.
    expect(thread.sent[1]).toEqual([
      "with a file",
      { attachments: [{ path: "/tmp/a.pdf", name: "a.pdf", mimeType: "application/pdf", bytes: 12 }] },
    ]);
  });

  it("only notifies status and usage subscribers for envelopes that map", async () => {
    const { sdk, listeners } = fakeSdk();
    const client = adaptSdkClient(sdk);
    const opened = await client.threads.open("main");
    const status = vi.fn();
    const usage = vi.fn();
    opened.on("status", status);
    opened.on("usage", usage);

    const push = (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(envelope(event));
    };
    push({ type: "status", turnStatus: "started", turnId: "t1" });
    push({ type: "activity", activity: "working" });
    push({ type: "context_usage", usage: { totalTokens: 12, maxTokens: 100 } });

    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith({ state: "running", turnId: "t1" });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith({ totalTokens: 12, contextWindow: 100 });
  });
});
