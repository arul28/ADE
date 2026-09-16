import { describe, expect, it } from "vitest";
import { AccountRefreshUnavailableError } from "./accountAuthService";
import {
  createCliRefreshBroker,
  type CliRefreshBrokerClient,
} from "./cliRefreshBroker";

function fakeClient(
  handle: (method: string, params?: unknown) => Promise<unknown>,
): CliRefreshBrokerClient & { closed: number } {
  return {
    closed: 0,
    request: (method: string, params?: unknown) =>
      handle(method, params) as Promise<never>,
    close() {
      this.closed += 1;
    },
  } as CliRefreshBrokerClient & { closed: number };
}

describe("createCliRefreshBroker", () => {
  it("returns the brain's token and never forwards forceRefresh", async () => {
    const calls: unknown[] = [];
    const broker = await createCliRefreshBroker({
      connect: async () =>
        fakeClient(async (method, params) => {
          calls.push({ method, params });
          return { domain: "account", action: "getToken", result: " brain-token " };
        }),
    });
    expect(broker).not.toBeNull();
    await expect(
      broker!.getAccessToken({ forceRefresh: true }),
    ).resolves.toBe("brain-token");
    // The probe connect plus the refresh connect; only the refresh call is RPC.
    expect(calls).toEqual([
      {
        method: "account.call",
        params: { action: "getToken", args: {} },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("forceRefresh");
  });

  it("returns null per request when no brain is reachable, so the service keeps its local exchange", async () => {
    const broker = await createCliRefreshBroker({ connect: async () => null });
    await expect(broker.getAccessToken({ forceRefresh: false })).resolves.toBeNull();

    const refusedBroker = await createCliRefreshBroker({
      connect: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    await expect(refusedBroker.getAccessToken({ forceRefresh: false })).resolves.toBeNull();
  });

  it("notices a brain that starts after broker installation", async () => {
    let listening = false;
    const broker = await createCliRefreshBroker({
      connect: async () => {
        if (!listening) return null;
        return fakeClient(async () => ({
          domain: "account",
          action: "getToken",
          result: "token-after-start",
        }));
      },
    });

    await expect(broker.getAccessToken({ forceRefresh: false })).resolves.toBeNull();
    listening = true;
    await expect(broker.getAccessToken({ forceRefresh: false })).resolves.toBe("token-after-start");
  });

  it("maps a brain-side failure to transient unavailability, not a dead session", async () => {
    const broker = await createCliRefreshBroker({
      connect: async () =>
        fakeClient(async () => {
          throw new Error("account.getToken failed: brain is busy");
        }),
    });
    const error = await broker!
      .getAccessToken({ forceRefresh: false })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountRefreshUnavailableError);
    expect((error as AccountRefreshUnavailableError).transient).toBe(true);
    expect(String((error as Error).message)).not.toContain("brain is busy");
  });

  it("treats an empty or unreadable brain answer as unavailable", async () => {
    const broker = await createCliRefreshBroker({
      connect: async () =>
        fakeClient(async () => ({ domain: "account", action: "getToken", result: "   " })),
    });
    await expect(broker!.getAccessToken({ forceRefresh: false })).rejects.toBeInstanceOf(
      AccountRefreshUnavailableError,
    );
  });

  it("reports unavailable — never a local exchange — when the brain goes away mid-session", async () => {
    let first = true;
    const broker = await createCliRefreshBroker({
      connect: async () => {
        if (first) {
          first = false;
          return fakeClient(async () => ({ result: "unused" }));
        }
        return null;
      },
    });
    expect(broker).not.toBeNull();
    await expect(broker!.getAccessToken({ forceRefresh: false })).rejects.toBeInstanceOf(
      AccountRefreshUnavailableError,
    );
  });

  it("closes every connection it opens", async () => {
    const opened: Array<CliRefreshBrokerClient & { closed: number }> = [];
    const broker = await createCliRefreshBroker({
      connect: async () => {
        const client = fakeClient(async () => ({
          domain: "account",
          action: "getToken",
          result: "token",
        }));
        opened.push(client);
        return client;
      },
    });
    await broker!.getAccessToken({ forceRefresh: false });
    expect(opened).toHaveLength(2);
    expect(opened.every((client) => client.closed === 1)).toBe(true);
  });
});

describe("cli refresh broker installation sites", () => {
  it("is not installed by the plans that host the brain", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../cli.ts", import.meta.url), "utf8"),
    );
    const install = source.indexOf("installCliRefreshBroker");
    expect(install).toBeGreaterThan(-1);
    const guard = source.slice(Math.max(0, install - 1200), install);
    expect(guard).toContain('plan.kind !== "serve"');
    expect(guard).toContain('plan.kind !== "runtime"');
    expect(guard).toContain('plan.kind !== "brain"');
    expect(guard).toContain("!parsed.options.headless");
  });
});
