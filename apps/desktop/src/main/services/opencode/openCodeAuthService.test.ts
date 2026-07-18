import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import type { OpenCodeOAuthStatusEvent } from "../../../shared/types/config";
import {
  __getActiveOAuthProviderIdsForTests,
  __isAllowedOAuthExternalUrlForTests,
  __resetOpenCodeAuthServiceForTests,
  __setOpenCodeAuthHooksForTests,
  addOpenCodeOAuthStatusListener,
  cancelOAuth,
  clearProviderKey,
  listAuthMethods,
  setProviderKey,
  startOAuth,
  type OpenCodeAuthDeps,
} from "./openCodeAuthService";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const deps: OpenCodeAuthDeps = {
  projectRoot: "/repo",
  projectConfig: {} as OpenCodeAuthDeps["projectConfig"],
  logger,
};

function collectEvents(): OpenCodeOAuthStatusEvent[] {
  const events: OpenCodeOAuthStatusEvent[] = [];
  addOpenCodeOAuthStatusListener((event) => events.push(event));
  return events;
}

beforeEach(() => {
  __resetOpenCodeAuthServiceForTests();
});

afterEach(() => {
  __resetOpenCodeAuthServiceForTests();
  vi.useRealTimers();
});

describe("openCodeAuthService", () => {
  it("lists auth methods from GET /provider/auth", async () => {
    const release = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async (url) => {
        expect(url).toBe("http://127.0.0.1:4200/provider/auth");
        return { ok: true, status: 200, body: { openai: [{ type: "oauth", label: "ChatGPT" }] } };
      },
    });

    const result = await listAuthMethods(deps);
    expect(result.methods.openai?.[0]?.label).toBe("ChatGPT");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("runs an auto OAuth flow: authorize, return the URL, poll to connected, refresh inventory", async () => {
    vi.useFakeTimers();
    const events = collectEvents();
    const release = vi.fn();
    const probeInventory = vi.fn(async () => {});
    let connected: string[] = [];
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async (url) => {
        expect(url).toContain("/provider/github-copilot/oauth/authorize");
        return {
          ok: true,
          status: 200,
          body: { url: "https://github.com/login/device", method: "auto", instructions: "Enter code: ABCD-1234" },
        };
      },
      listConnectedProviders: async () => connected,
      probeInventory,
    });

    const result = await startOAuth(deps, { providerId: "github-copilot", methodIndex: 0 });
    expect(result).toEqual({
      url: "https://github.com/login/device",
      method: "auto",
      instructions: "Enter code: ABCD-1234",
    });
    expect(events).toEqual([{ providerId: "github-copilot", state: "pending" }]);
    expect(__getActiveOAuthProviderIdsForTests()).toEqual(["github-copilot"]);

    // First poll: still not connected.
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.at(-1)?.state).toBe("pending");

    // Provider connects; next poll completes the flow.
    connected = ["github-copilot"];
    await vi.advanceTimersByTimeAsync(2000);

    expect(events.at(-1)).toEqual({ providerId: "github-copilot", state: "connected" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(probeInventory).toHaveBeenCalledTimes(1);
    expect(__getActiveOAuthProviderIdsForTests()).toEqual([]);
  });

  it("serializes OAuth polls and aborts a stalled provider-list request", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const listConnectedProviders = vi.fn(
      async (_baseUrl: string, _directory: string, signal?: AbortSignal): Promise<string[]> => {
        signals.push(signal!);
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        return await new Promise<string[]>((_, reject) => {
          signal?.addEventListener("abort", () => {
            activeRequests -= 1;
            reject(signal.reason);
          }, { once: true });
        });
      },
    );
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release: vi.fn() }),
      httpJson: async () => ({ ok: true, status: 200, body: { url: "https://x", method: "auto", instructions: "" } }),
      listConnectedProviders,
      probeInventory: async () => {},
    });

    await startOAuth(deps, { providerId: "openai", methodIndex: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listConnectedProviders).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(listConnectedProviders).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(listConnectedProviders).toHaveBeenCalledTimes(2);
    expect(maxActiveRequests).toBe(1);
  });

  it("allows HTTPS and loopback HTTP OAuth URLs only", () => {
    expect(__isAllowedOAuthExternalUrlForTests("https://example.com/oauth")).toBe(true);
    expect(__isAllowedOAuthExternalUrlForTests("http://localhost:3000/callback")).toBe(true);
    expect(__isAllowedOAuthExternalUrlForTests("http://127.0.0.2/callback")).toBe(true);
    expect(__isAllowedOAuthExternalUrlForTests("http://[::1]/callback")).toBe(true);
    expect(__isAllowedOAuthExternalUrlForTests("http://example.com/oauth")).toBe(false);
    expect(__isAllowedOAuthExternalUrlForTests("file:///tmp/token")).toBe(false);
    expect(__isAllowedOAuthExternalUrlForTests("custom-protocol://oauth")).toBe(false);
  });

  it("rejects an unsafe OAuth URL before starting a flow", async () => {
    const events = collectEvents();
    const release = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async () => ({
        ok: true,
        status: 200,
        body: { url: "http://example.com/oauth", method: "auto", instructions: "" },
      }),
    });

    await expect(startOAuth(deps, { providerId: "openai", methodIndex: 0 })).rejects.toThrow(
      "OpenCode returned an unsafe OAuth URL.",
    );
    expect(events).toEqual([{
      providerId: "openai",
      state: "failed",
      error: "OpenCode returned an unsafe OAuth URL.",
    }]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(__getActiveOAuthProviderIdsForTests()).toEqual([]);
  });

  it("emits timeout and releases the lease when the provider never connects", async () => {
    vi.useFakeTimers();
    const events = collectEvents();
    const release = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async () => ({ ok: true, status: 200, body: { url: "https://x", method: "auto", instructions: "" } }),
      listConnectedProviders: async () => [],
      probeInventory: async () => {},
    });

    await startOAuth(deps, { providerId: "openai", methodIndex: 0 });
    // Advance past the 5 minute timeout.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2000);

    expect(events.at(-1)?.state).toBe("timeout");
    expect(release).toHaveBeenCalledTimes(1);
    expect(__getActiveOAuthProviderIdsForTests()).toEqual([]);
  });

  it("cancel stops the poller, releases the lease, and emits cancelled", async () => {
    vi.useFakeTimers();
    const events = collectEvents();
    const release = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async () => ({ ok: true, status: 200, body: { url: "https://x", method: "auto", instructions: "" } }),
      listConnectedProviders: async () => [],
      probeInventory: async () => {},
    });

    await startOAuth(deps, { providerId: "openai", methodIndex: 0 });
    cancelOAuth({ providerId: "openai" });

    expect(events.at(-1)).toEqual({ providerId: "openai", state: "cancelled" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(__getActiveOAuthProviderIdsForTests()).toEqual([]);
  });

  it("starting a new flow for the same provider cancels the prior one", async () => {
    vi.useFakeTimers();
    const events = collectEvents();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release: vi.fn() }),
      httpJson: async () => ({ ok: true, status: 200, body: { url: "https://x", method: "auto", instructions: "" } }),
      listConnectedProviders: async () => [],
      probeInventory: async () => {},
    });

    await startOAuth(deps, { providerId: "openai", methodIndex: 0 });
    await startOAuth(deps, { providerId: "openai", methodIndex: 1 });

    expect(events.some((e) => e.state === "cancelled")).toBe(true);
    expect(__getActiveOAuthProviderIdsForTests()).toEqual(["openai"]);
  });

  it("setProviderKey PUTs the key and mirrors it into the ADE key store", async () => {
    const release = vi.fn();
    const storeApiKey = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async (url, init) => {
        expect(url).toBe("http://127.0.0.1:4200/auth/moonshotai");
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({ type: "api", key: "sk-test" });
        return { ok: true, status: 200, body: true };
      },
      storeApiKey,
    });

    const result = await setProviderKey(deps, { providerId: "moonshotai", key: "sk-test" });
    expect(result).toEqual({ ok: true });
    expect(storeApiKey).toHaveBeenCalledWith("moonshotai", "sk-test");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("setProviderKey returns an error without mirroring when the PUT fails", async () => {
    const storeApiKey = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release: vi.fn() }),
      httpJson: async () => ({ ok: false, status: 400, body: null }),
      storeApiKey,
    });

    const result = await setProviderKey(deps, { providerId: "moonshotai", key: "bad" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("400");
    expect(storeApiKey).not.toHaveBeenCalled();
  });

  it("setProviderKey reports durable key-store failures", async () => {
    const release = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async () => ({ ok: true, status: 200, body: true }),
      storeApiKey: () => {
        throw new Error("keychain unavailable");
      },
    });

    const result = await setProviderKey(deps, { providerId: "moonshotai", key: "sk-test" });
    expect(result).toEqual({
      ok: false,
      error: "OpenCode accepted the key, but ADE could not store it durably: keychain unavailable",
    });
    expect(logger.warn).toHaveBeenCalledWith("opencode.oauth_key_mirror_failed", {
      providerId: "moonshotai",
      error: "keychain unavailable",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("setProviderKey rejects empty inputs before acquiring a lease", async () => {
    const acquireLease = vi.fn();
    __setOpenCodeAuthHooksForTests({ acquireLease });

    await expect(setProviderKey(deps, { providerId: " ", key: "sk-test" })).resolves.toEqual({
      ok: false,
      error: "Provider ID is required.",
    });
    await expect(setProviderKey(deps, { providerId: "openai", key: " " })).resolves.toEqual({
      ok: false,
      error: "Provider key is required.",
    });
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("clearProviderKey DELETEs the managed OpenCode credential", async () => {
    const release = vi.fn();
    const deleteApiKey = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async (url, init) => {
        expect(url).toBe("http://127.0.0.1:4200/auth/github-copilot");
        expect(init?.method).toBe("DELETE");
        return { ok: true, status: 204, body: null };
      },
      deleteApiKey,
    });

    await expect(clearProviderKey(deps, { providerId: " github-copilot " })).resolves.toEqual({ ok: true });
    expect(deleteApiKey).toHaveBeenCalledWith("github-copilot");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("clearProviderKey reports server failures and releases the lease", async () => {
    const release = vi.fn();
    const deleteApiKey = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async () => ({ ok: false, status: 405, body: null }),
      deleteApiKey,
    });

    await expect(clearProviderKey(deps, { providerId: "openai" })).resolves.toEqual({
      ok: false,
      error: "OpenCode DELETE /auth failed (405).",
    });
    expect(deleteApiKey).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("clearProviderKey reports durable key-store deletion failures", async () => {
    const release = vi.fn();
    __setOpenCodeAuthHooksForTests({
      acquireLease: async () => ({ url: "http://127.0.0.1:4200", release }),
      httpJson: async () => ({ ok: true, status: 204, body: null }),
      deleteApiKey: () => {
        throw new Error("keychain unavailable");
      },
    });

    await expect(clearProviderKey(deps, { providerId: "openai" })).resolves.toEqual({
      ok: false,
      error: "OpenCode removed the key, but ADE could not delete its durable copy: keychain unavailable",
    });
    expect(logger.warn).toHaveBeenCalledWith("opencode.oauth_key_delete_failed", {
      providerId: "openai",
      error: "keychain unavailable",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
