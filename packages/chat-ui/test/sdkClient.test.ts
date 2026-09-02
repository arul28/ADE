import { describe, expect, it, vi } from "vitest";
import {
  adaptSdkClient,
  modelDescriptorsFromSdk,
  providerStatusesFromSdk,
  threadStatusFromEnvelope,
  threadUsageFromEnvelope,
  type SdkLikeChatClient,
  type SdkLikeThread,
  type SdkProviderStatusRecord,
} from "../src/adapters/sdkClient";
import type { AdeChatClient } from "@ade-dev/sdk";
import type { AdeIpcClient } from "@ade-dev/sdk/electron/renderer";
import type { AgentChatEventEnvelope, ApprovalRequest, Unsubscribe } from "../src/sdkTypes";

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

/**
 * A 0.1.x-shaped record: no probe fields at all. The adapter still has to
 * produce a usable card from it, because a proxy or an older client sends
 * exactly this.
 */
const sdkStatuses: Record<string, SdkProviderStatusRecord> = {
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
  it("falls back to modelCount for installed, never to authenticated", () => {
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

  /**
   * The point of the 0.2 probe: a record that says where the binary is and what
   * version it is must reach the card intact, and `installed` must be the
   * runtime's answer rather than a count of catalog rows. A provider with a
   * binary but no models used to render as "not installed" and send the user to
   * an install command they had already run.
   */
  it("uses the probed fields when the runtime supplies them", () => {
    const [claude] = providerStatusesFromSdk({
      claude: {
        provider: "claude",
        displayName: "Claude Code",
        installed: true,
        binaryPath: "/opt/homebrew/bin/claude",
        version: "2.4.1 (Claude Code)",
        authenticated: true,
        installCommand: "npm i -g @anthropic-ai/claude-code",
        loginCommand: "claude setup-token",
        docsUrl: "https://docs.claude.com/claude-code",
        available: true,
        requiresConfiguration: false,
        // Zero catalog rows, and still installed: the old derivation would have
        // called this provider missing.
        modelCount: 0,
        stale: false,
        source: "probed",
        checkedAt: "2026-09-02T04:00:00.000Z",
      },
    });
    expect(claude).toMatchObject({
      id: "claude",
      installed: true,
      binaryPath: "/opt/homebrew/bin/claude",
      version: "2.4.1 (Claude Code)",
      source: "probed",
      checkedAt: "2026-09-02T04:00:00.000Z",
      installCommand: "npm i -g @anthropic-ai/claude-code",
      loginCommand: "claude setup-token",
      docsUrl: "https://docs.claude.com/claude-code",
    });
  });

  it("marks a record with no probe fields as derived", () => {
    const [claude] = providerStatusesFromSdk(sdkStatuses);
    // `source` is what lets the card say "Not detected" rather than claiming a
    // filesystem fact nobody established.
    expect(claude?.source).toBe("derived");
    expect(claude?.binaryPath).toBeUndefined();
    expect(claude?.version).toBeUndefined();
  });

  it("keeps a probed record's own detail over the generic ladder", () => {
    const [cursor] = providerStatusesFromSdk({
      cursor: {
        provider: "cursor",
        displayName: "Cursor",
        installed: false,
        binaryPath: null,
        version: null,
        authenticated: false,
        installCommand: null,
        loginCommand: null,
        docsUrl: null,
        available: false,
        requiresConfiguration: false,
        modelCount: 0,
        stale: false,
        source: "probed",
        checkedAt: "2026-09-02T04:00:00.000Z",
        detail: "cursor is a Node package, not a CLI.",
      },
    });
    expect(cursor?.detail).toBe("cursor is a Node package, not a CLI.");
  });

  /**
   * `commandHints` predates the probe and was the only source of these strings.
   * It now overrides a runtime that supplies its own, so a host that set them
   * in 0.1.x sees the exact copy it had rather than ADE's wording appearing
   * underneath it.
   */
  it("lets commandHints override what the runtime reported", () => {
    const probed: Record<string, SdkProviderStatusRecord> = {
      codex: {
        provider: "codex",
        displayName: "Codex",
        installed: true,
        binaryPath: "/usr/local/bin/codex",
        version: "0.55.0",
        authenticated: false,
        installCommand: "npm i -g @openai/codex",
        loginCommand: "codex login",
        docsUrl: "https://developers.openai.com/codex",
        available: false,
        requiresConfiguration: false,
        modelCount: 4,
        stale: false,
        source: "probed",
        checkedAt: "2026-09-02T04:00:00.000Z",
      },
    };
    const [withoutHints] = providerStatusesFromSdk(probed);
    expect(withoutHints?.loginCommand).toBe("codex login");

    const [withHints] = providerStatusesFromSdk(probed, {
      commandHints: { codex: { loginCommand: "myapp connect codex" } },
    });
    expect(withHints?.loginCommand).toBe("myapp connect codex");
    // Only the field the host overrode changes.
    expect(withHints?.installCommand).toBe("npm i -g @openai/codex");
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

  /**
   * The same guard for the Electron bridge, and the reason it is a separate
   * assertion: `createAdeIpcClient` does not return the SDK's own client. It
   * returns a proxy built from `window.ade`, and the promise this package makes
   * to an Electron embedder is that the proxy drops into `adaptSdkClient` with
   * NO cast. That promise is a type relationship, so nothing but `tsc` can hold
   * it, and it breaks silently the moment either side moves.
   *
   * This resolves `@ade-dev/sdk/electron/renderer` through the package's
   * `exports` map, so it also proves the subpath is declared and its types
   * ship. Build the SDK first: the check reads `dist`, not `src`.
   */
  it("still fits the Electron IPC bridge client", () => {
    const bridged = null as unknown as AdeIpcClient;
    const accepted: SdkLikeChatClient = bridged;
    // Compiled, never invoked. The assertion is that this call typechecks with
    // no cast; running it would only prove that a null stand-in has no members.
    const adapts = () => adaptSdkClient(bridged, { providerFilter: ["claude"] });
    expect(accepted).toBeNull();
    expect(typeof adapts).toBe("function");
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

  /**
   * The approval surface is optional on both sides. Forwarding it only when the
   * inner thread has it is what lets `canApprove` be honest: a card over a
   * client that cannot answer renders read-only instead of offering a button
   * that would throw.
   */
  it("forwards approve and pendingApprovals only when the SDK thread has them", async () => {
    const { sdk } = fakeSdk();
    const bare = await adaptSdkClient(sdk).threads.open("main");
    expect(bare.approve).toBeUndefined();
    expect(bare.pendingApprovals).toBeUndefined();

    const approve = vi.fn(async () => {});
    const request: ApprovalRequest = {
      itemId: "item-1",
      kind: "command",
      description: "Run a shell command",
    };
    const pendingApprovals = vi.fn(async () => [request]);
    const { sdk: capable } = fakeSdk();
    const opened = await adaptSdkClient({
      ...capable,
      threads: {
        open: async (key, opts) => ({
          ...(await capable.threads.open(key, opts)),
          approve,
          pendingApprovals,
        }),
      },
    }).threads.open("main");

    await opened.approve?.("item-1", "accept_always");
    expect(approve).toHaveBeenCalledWith("item-1", "accept_always");
    // The optional third argument is omitted rather than passed as undefined:
    // a proxy that counts arguments must not see one that was never given.
    expect(approve.mock.calls[0]).toHaveLength(2);

    await opened.approve?.("item-1", "reject", "not now");
    expect(approve).toHaveBeenLastCalledWith("item-1", "reject", "not now");

    expect(await opened.pendingApprovals?.()).toEqual([request]);
  });

  it("forwards providers.refresh only when the SDK client can re-probe", async () => {
    const { sdk } = fakeSdk();
    expect(adaptSdkClient(sdk).providers.refresh).toBeUndefined();

    const refresh = vi.fn(async () => sdkStatuses);
    const client = adaptSdkClient({ ...sdk, providers: { ...sdk.providers, refresh } });
    const statuses = await client.providers.refresh?.();
    expect(refresh).toHaveBeenCalledTimes(1);
    // The same mapping as `status()`, not the raw record.
    expect(statuses?.map((entry) => entry.id)).toEqual(["claude", "codex", "droid"]);
  });
});
