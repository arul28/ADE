import { describe, expect, it } from "vitest";
import type { AdeAccountMachine } from "../../../shared/types/account";
import {
  accountMachinePairedSyncEndpoints,
  accountMachineSecureSyncEndpoints,
  DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  DEFAULT_ADE_CLERK_ISSUER,
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
  DEVELOPMENT_ADE_CLERK_ISSUER,
  fetchAccountMachines,
  MAX_ACCOUNT_DIRECTORY_RESPONSE_BYTES,
  officialAccountDirectoryUrlForIssuer,
  parseAccountMachinesPayload,
  resolveTrustedAccountDirectoryBaseUrl,
  resolveAccountHelloPairing,
  selectAccountMachine,
} from "../../../shared/accountDirectory";
import { parseTrustedDirectoryBaseUrl } from "./accountBridge";

function machine(overrides: Partial<AdeAccountMachine> = {}): AdeAccountMachine {
  return {
    machineKey: "mk-studio",
    deviceId: "device-studio",
    name: "Studio",
    platform: "macOS",
    deviceType: "desktop",
    reachableEndpoints: [],
    lastSeenAt: 1,
    online: true,
    ...overrides,
  };
}

// The bearer sent to the directory is the machine's account token, so the only
// security-relevant unit is where that token is allowed to go: an https origin,
// or http on a loopback host for local dev. Everything else must be rejected.
describe("parseTrustedDirectoryBaseUrl", () => {
  it("uses the hosted directory for absent or blank machine overrides", () => {
    expect(resolveTrustedAccountDirectoryBaseUrl(null)).toBe(
      DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
    );
    expect(resolveTrustedAccountDirectoryBaseUrl("   ")).toBe(
      DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
    );
  });

  it("maps only ADE's development issuer to the isolated development directory", () => {
    expect(officialAccountDirectoryUrlForIssuer(DEVELOPMENT_ADE_CLERK_ISSUER)).toBe(
      DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
    );
    expect(officialAccountDirectoryUrlForIssuer(DEFAULT_ADE_CLERK_ISSUER)).toBe(
      DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
    );
    expect(officialAccountDirectoryUrlForIssuer("https://attacker.example")).toBe(
      DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
    );
  });

  it("accepts an https URL and normalizes trailing slashes", () => {
    expect(parseTrustedDirectoryBaseUrl("https://directory.ade.dev/")).toBe(
      "https://directory.ade.dev",
    );
    expect(parseTrustedDirectoryBaseUrl("https://h/base/")).toBe("https://h/base");
    expect(parseTrustedDirectoryBaseUrl("https://h/")).toBe("https://h");
    expect(
      parseTrustedDirectoryBaseUrl("https://directory.ade.dev/account//"),
    ).toBe("https://directory.ade.dev/account");
  });

  it("accepts http on loopback hosts for local dev", () => {
    expect(parseTrustedDirectoryBaseUrl("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(parseTrustedDirectoryBaseUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(parseTrustedDirectoryBaseUrl("http://[::1]:8787")).toBe(
      "http://[::1]:8787",
    );
  });

  it("rejects http to a remote host", () => {
    expect(parseTrustedDirectoryBaseUrl("http://evil.example.com")).toBeNull();
    expect(
      parseTrustedDirectoryBaseUrl("http://directory.ade.dev/account"),
    ).toBeNull();
  });

  it("rejects bare, relative, or non-URL strings", () => {
    expect(parseTrustedDirectoryBaseUrl("directory.ade.dev")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("/account/machines")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("not a url")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("   ")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl(null)).toBeNull();
    expect(parseTrustedDirectoryBaseUrl(undefined)).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(parseTrustedDirectoryBaseUrl("ftp://directory.ade.dev")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("ws://localhost:8787")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects credentials, query strings, and fragments", () => {
    expect(parseTrustedDirectoryBaseUrl("https://h?x=1")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("https://h#f")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("https://user:pass@h")).toBeNull();
  });
});

describe("shared account directory trust boundary", () => {
  it("uses only verified WSS relay routes for the account bearer, then admits direct routes for the paired secret", () => {
    const value = machine({
      reachableEndpoints: [
        { kind: "relay", url: "ws://relay.example/connect/mk-studio" },
        { kind: "relay", url: "wss://relay.example/connect/mk-studio?token=evil" },
        { kind: "relay", url: "wss://user:pass@relay.example/connect/mk-studio" },
        { kind: "lan", url: "wss://arbitrary.example/sync" },
        { kind: "lan", host: "10.0.0.8", port: 8787 },
        { kind: "tailnet", url: "ws://100.64.0.8:8787" },
        { kind: "relay", url: "wss://arbitrary-relay.example/connect/mk-studio" },
        { kind: "relay", url: "wss://relay.example/connect/wrong-machine" },
        { kind: "relay", url: "wss://relay.example/connect/mk-studio" },
      ],
    });

    expect(accountMachineSecureSyncEndpoints(value, ["https://relay.example"])).toEqual([
      "wss://relay.example/connect/mk-studio",
    ]);
    expect(accountMachinePairedSyncEndpoints(value, ["https://relay.example"])).toEqual([
      "ws://10.0.0.8:8787/",
      "ws://100.64.0.8:8787/",
      "wss://relay.example/connect/mk-studio",
    ]);
  });

  it("selects stable ids first and fails ambiguous display names with choices", () => {
    const machines = [
      machine({ machineKey: "mk-a", deviceId: "dev-a" }),
      machine({ machineKey: "mk-b", deviceId: "dev-b" }),
    ];
    expect(selectAccountMachine(machines, "dev-b").machineKey).toBe("mk-b");
    expect(() => selectAccountMachine(machines, "Studio"))
      .toThrow(/ambiguous.*mk-a.*mk-b/i);

    const collidingStableIds = [
      machine({ machineKey: "shared", deviceId: "dev-a", name: "First" }),
      machine({ machineKey: "mk-b", deviceId: "shared", name: "shared" }),
    ];
    expect(() => selectAccountMachine(collidingStableIds, "shared"))
      .toThrow(/identifier.*ambiguous.*shared.*mk-b/i);
  });

  it("never mixes a partial account pairing response with stored credentials", () => {
    const existingPairing = { deviceId: "browser-1", secret: "stored-secret" };
    expect(resolveAccountHelloPairing({
      accountPairing: undefined,
      existingPairing,
      expectedDeviceId: "browser-1",
    })).toEqual(existingPairing);
    expect(resolveAccountHelloPairing({
      accountPairing: { deviceId: "browser-1", secret: "" },
      existingPairing,
      expectedDeviceId: "browser-1",
    })).toBeNull();
  });

  it("bounds hostile directory payloads and reports auth expiry without leaking the bearer", async () => {
    const payload = parseAccountMachinesPayload({
      machines: [
        { ...machine(), machineKey: "x".repeat(513) },
        { ...machine(), reachableEndpoints: [{ kind: "relay", url: "javascript:alert(1)" }] },
        { ...machine(), machineKey: "duplicate" },
        { ...machine(), machineKey: "duplicate", name: "attacker overwrite" },
      ],
    });
    expect(payload).toHaveLength(2);
    expect(payload.find((entry) => entry.machineKey === "duplicate")?.name).toBe("Studio");

    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const result = await fetchAccountMachines({
      baseUrl: "https://directory.example",
      accessToken: "top-secret-bearer",
      fetchImpl: async (input, init) => {
        calls.push({ input: String(input), init });
        return new Response(null, { status: 401 });
      },
    });
    expect(result.state).toBe("auth_expired");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://directory.example/account/machines");
    expect(calls[0]?.input).not.toContain("top-secret-bearer");
    expect(calls[0]?.init).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer top-secret-bearer");
  });

  it("rejects a streamed directory response before it can grow without bound", async () => {
    const chunkBytes = 1024 * 1024;
    let emittedBytes = 0;
    const result = await fetchAccountMachines({
      baseUrl: "https://directory.example",
      accessToken: "top-secret-bearer",
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          emittedBytes += chunkBytes;
          controller.enqueue(new Uint8Array(chunkBytes));
          if (emittedBytes > MAX_ACCOUNT_DIRECTORY_RESPONSE_BYTES) controller.close();
        },
      }), { status: 200 }),
    });

    expect(result).toMatchObject({ state: "unavailable", machines: [] });
    expect(emittedBytes).toBeLessThanOrEqual(MAX_ACCOUNT_DIRECTORY_RESPONSE_BYTES + chunkBytes);
  });

  it("distinguishes caller cancellation from the directory's own timeout", async () => {
    const abortingFetch = async (_input: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    const caller = new AbortController();
    const cancelled = fetchAccountMachines({
      baseUrl: "https://directory.example",
      accessToken: "account-token",
      fetchImpl: abortingFetch,
      signal: caller.signal,
      timeoutMs: 5_000,
    });
    caller.abort(new Error("cancel machine lookup"));
    await expect(cancelled).resolves.toMatchObject({
      state: "cancelled",
      message: "Machine directory request was cancelled.",
    });

    await expect(fetchAccountMachines({
      baseUrl: "https://directory.example",
      accessToken: "account-token",
      fetchImpl: abortingFetch,
      timeoutMs: 1,
    })).resolves.toMatchObject({
      state: "unavailable",
      message: "Machine directory timed out.",
    });
  });
});
