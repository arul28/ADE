import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  created: [] as Array<{ close: ReturnType<typeof vi.fn>; url: string }>,
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeServer: vi.fn(async ({ port }: { port: number }) => {
    const close = vi.fn();
    const entry = {
      close,
      url: `http://127.0.0.1:${port}`,
    };
    mockState.created.push(entry);
    return entry;
  }),
}));

import {
  __resetOpenCodeServerManagerForTests,
  acquireDedicatedOpenCodeServer,
  acquireSharedOpenCodeServer,
  getOpenCodeRuntimeDiagnostics,
} from "./openCodeServerManager";

describe("openCodeServerManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.created.length = 0;
    __resetOpenCodeServerManagerForTests();
  });

  afterEach(() => {
    __resetOpenCodeServerManagerForTests();
    vi.useRealTimers();
  });

  it("reuses shared servers until the idle TTL expires", async () => {
    const config = { share: "disabled", autoupdate: false, snapshot: false } as const;
    const leaseA = await acquireSharedOpenCodeServer({
      config,
      key: "shared:test",
      ownerKind: "inventory",
      idleTtlMs: 1_000,
    });
    const leaseB = await acquireSharedOpenCodeServer({
      config,
      key: "shared:test",
      ownerKind: "inventory",
      idleTtlMs: 1_000,
    });

    expect(mockState.created).toHaveLength(1);
    expect(leaseA.url).toBe(leaseB.url);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(1);

    leaseA.release("handle_close");
    leaseB.release("handle_close");
    expect(mockState.created[0]?.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockState.created[0]?.close).toHaveBeenCalledTimes(1);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(0);
  });

  it("treats semantically identical shared configs as the same runtime even when key order differs", async () => {
    const configA = {
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      provider: {
        zed: { options: { apiKey: "one", baseURL: "https://example.test" } },
        alpha: { options: { apiKey: "two" } },
      },
    } as const;
    const configB = {
      snapshot: false,
      provider: {
        alpha: { options: { apiKey: "two" } },
        zed: { options: { baseURL: "https://example.test", apiKey: "one" } },
      },
      autoupdate: false,
      share: "disabled",
    } as const;

    const leaseA = await acquireSharedOpenCodeServer({
      config: configA,
      ownerKind: "chat",
      ownerId: "chat-a",
      idleTtlMs: 1_000,
    });
    const leaseB = await acquireSharedOpenCodeServer({
      config: configB,
      ownerKind: "chat",
      ownerId: "chat-b",
      idleTtlMs: 1_000,
    });

    expect(mockState.created).toHaveLength(1);
    expect(leaseA.url).toBe(leaseB.url);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(1);

    leaseA.release("handle_close");
    leaseB.release("handle_close");
  });

  it("rejects a config change while the existing server is still leased, then allows it after release", async () => {
    const configA = { share: "disabled", autoupdate: false, snapshot: false } as const;
    const configB = {
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      provider: {
        openai: { options: { apiKey: "new-key" } },
      },
    } as const;

    const leaseA = await acquireSharedOpenCodeServer({
      config: configA,
      key: "shared:config-change",
      ownerKind: "inventory",
      idleTtlMs: 1_000,
    });

    // Config change is rejected while leaseA is still held
    await expect(
      acquireSharedOpenCodeServer({
        config: configB,
        key: "shared:config-change",
        ownerKind: "inventory",
        idleTtlMs: 1_000,
      }),
    ).rejects.toThrow(/still in use/);

    // Release the old lease and the old server shuts down on idle
    leaseA.release("handle_close");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockState.created[0]?.close).toHaveBeenCalledTimes(1);

    // Now the config change succeeds — a new server is created
    const leaseB = await acquireSharedOpenCodeServer({
      config: configB,
      key: "shared:config-change",
      ownerKind: "inventory",
      idleTtlMs: 1_000,
    });

    expect(mockState.created).toHaveLength(2);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(1);
    expect(getOpenCodeRuntimeDiagnostics().entries[0]?.configFingerprint).toMatch(/^[a-f0-9]{64}$/);

    leaseB.release("handle_close");
  });

  it("shuts down a shared server immediately when its last lease closes with an error", async () => {
    const config = { share: "disabled", autoupdate: false, snapshot: false } as const;
    const lease = await acquireSharedOpenCodeServer({
      config,
      key: "shared:error",
      ownerKind: "chat",
      idleTtlMs: 60_000,
    });

    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(1);

    lease.close("error");

    expect(mockState.created[0]?.close).toHaveBeenCalledTimes(1);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(0);
  });

  it("refuses to reclaim leased dedicated servers when the budget is exceeded", async () => {
    const baseConfig = { share: "disabled", autoupdate: false, snapshot: false } as const;

    for (let index = 0; index < 6; index += 1) {
      const lease = await acquireDedicatedOpenCodeServer({
        ownerKey: `chat:${index}`,
        ownerKind: "chat",
        ownerId: `chat-${index}`,
        config: {
          ...baseConfig,
          agent: {
            [`role-${index}`]: {
              permission: {
                edit: "ask",
                bash: "ask",
                webfetch: "allow",
                doom_loop: "ask",
                external_directory: "ask",
              },
            },
          },
        } as const,
      });
      lease.setBusy(false);
      lease.setEvictionHandler(vi.fn());
    }

    await expect(
      acquireDedicatedOpenCodeServer({
        ownerKey: "chat:blocked",
        ownerKind: "chat",
        ownerId: "chat-blocked",
        config: {
          ...baseConfig,
          agent: {
            blocked: {
              permission: {
                edit: "ask",
                bash: "ask",
                webfetch: "allow",
                doom_loop: "ask",
                external_directory: "ask",
              },
            },
          },
        } as const,
      }),
    ).rejects.toThrow(/OpenCode runtime limit reached/);
    expect(mockState.created).toHaveLength(6);
    expect(mockState.created.every((entry) => entry.close.mock.calls.length === 0)).toBe(true);
  });
});
