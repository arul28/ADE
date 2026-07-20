import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_MACHINE_HEARTBEAT_MS,
  ACCOUNT_MACHINE_RELAY_STATE_POLL_MS,
  type AccountMachineRegistrationSnapshot,
  buildAccountMachineRegistration,
  createAccountMachinePublisherService,
} from "./accountMachinePublisherService";

function snapshot(
  overrides: Partial<AccountMachineRegistrationSnapshot> = {},
): AccountMachineRegistrationSnapshot {
  return {
    role: "brain",
    runtimeRole: "host",
    runtimeName: "Studio",
    pairingConnectInfo: {
      hostIdentity: {
        deviceId: "device-studio",
        siteId: "site-studio",
        name: "Studio",
        platform: "macOS",
        deviceType: "desktop",
      },
      port: 8787,
      addressCandidates: [{ kind: "lan", host: "192.168.1.20" }],
    },
    routeHealth: {
      listener: {
        listenerBound: true,
        loopbackAdeValidated: true,
        port: 8787,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: "2026-07-16T00:00:00.000Z",
      },
      tailscale: {
        enabled: false,
        tailscalePublished: false,
        tailscaleReachable: false,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: null,
      },
      relay: {
        enabled: false,
        relayControlConnected: false,
        relayBridgeValidated: false,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: null,
      },
    },
    ...overrides,
  };
}

function routeSnapshot(
  overrides: Partial<AccountMachineRegistrationSnapshot> = {},
): AccountMachineRegistrationSnapshot {
  const value = snapshot({
    runtimeName: "Arul's Mac Studio",
    ...overrides,
  });
  if (value.pairingConnectInfo) {
    value.pairingConnectInfo.addressCandidates = [
      { kind: "lan", host: "192.168.1.20" },
      { kind: "tailscale", host: "studio.tailnet.ts.net" },
      { kind: "loopback", host: "127.0.0.1" },
      { kind: "relay", host: "wss://relay.example/connect/machine-studio" },
    ];
  }
  value.routeHealth.tailscale = {
    enabled: true,
    tailscalePublished: true,
    tailscaleReachable: true,
    lastFailureAt: null,
    reason: null,
    lastSuccessAt: "2026-07-16T00:00:00.000Z",
  };
  value.routeHealth.relay = {
    enabled: true,
    relayControlConnected: true,
    relayBridgeValidated: true,
    lastFailureAt: null,
    reason: null,
    lastSuccessAt: "2026-07-16T00:00:00.000Z",
  };
  return value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("account machine publisher health", () => {
  it("records a successful publication with its endpoint count and timestamps", async () => {
    let clock = 100;
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example/path/",
      fetchImpl: vi.fn(async () => {
        clock = 125;
        return new Response(null, { status: 204 });
      }),
      now: () => clock,
    });

    await service.publishNow();

    expect(service.getPublisherHealth()).toEqual({
      state: "published",
      skipReason: null,
      directoryOrigin: "https://directory.example",
      lastAttemptAt: 100,
      lastSuccessAt: 125,
      lastHttpStatus: 204,
      lastHttpReason: null,
      reachableEndpointCount: 1,
    });
  });

  it.each([
    {
      name: "sync disabled",
      expected: "sync_disabled",
      options: { isSyncEnabled: () => false },
    },
    {
      name: "no active scope",
      expected: "no_active_sync_scope",
      options: { getSnapshot: async () => null },
    },
    {
      name: "snapshot failure",
      expected: "snapshot_failed",
      options: { getSnapshot: async () => { throw new Error("snapshot"); } },
    },
    {
      name: "missing machine key",
      expected: "machine_key_unavailable",
      options: { getMachineKey: () => "" },
    },
    {
      name: "missing pairing info",
      expected: "missing_pairing_connect_info",
      options: { getSnapshot: async () => snapshot({ pairingConnectInfo: null }) },
    },
    {
      name: "viewer runtime",
      expected: "not_host",
      options: { getSnapshot: async () => snapshot({ runtimeRole: "viewer" }) },
    },
    {
      name: "signed out account",
      expected: "account_signed_out",
      options: { getAccountStatus: () => ({ signedIn: false, sessionReadState: "missing" as const }) },
    },
    {
      name: "unreadable session",
      expected: "token_unreadable",
      options: { getAccountStatus: () => ({ signedIn: false, sessionReadState: "unreadable" as const }) },
    },
    {
      name: "failed token refresh",
      expected: "token_unreadable",
      options: { getAccessToken: async () => null },
    },
    {
      name: "invalid directory URL",
      expected: "invalid_directory_url",
      options: { directoryBaseUrl: () => "http://directory.example" },
    },
  ])("records $name", async ({ expected, options }) => {
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
      now: () => 250,
      ...options,
    });

    await service.publishNow();

    expect(service.getPublisherHealth()).toMatchObject({
      state: expected,
      lastAttemptAt: 250,
    });
  });

  it("distinguishes HTTP, timeout, and transport failures", async () => {
    const baseOptions = {
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
    };
    const http = createAccountMachinePublisherService({
      ...baseOptions,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: "invalid audience" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })),
    });
    await http.publishNow();
    expect(http.getPublisherHealth()).toMatchObject({
      state: "http_error",
      skipReason: "The account directory returned HTTP 401: invalid audience",
      lastHttpStatus: 401,
      lastHttpReason: "invalid audience",
      reachableEndpointCount: 1,
    });

    const transport = createAccountMachinePublisherService({
      ...baseOptions,
      fetchImpl: vi.fn(async () => { throw new TypeError("offline"); }),
    });
    await transport.publishNow();
    expect(transport.getPublisherHealth()).toMatchObject({
      state: "transport_error",
      lastHttpStatus: null,
    });

    vi.useFakeTimers();
    const timeout = createAccountMachinePublisherService({
      ...baseOptions,
      requestTimeoutMs: 250,
      fetchImpl: vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
    });
    const publishing = timeout.publishNow();
    await vi.advanceTimersByTimeAsync(250);
    await publishing;
    expect(timeout.getPublisherHealth()).toMatchObject({
      state: "timeout",
      lastHttpStatus: null,
    });
  });

  it("publishes immediately on sign-in and still discovers a late token on heartbeat", async () => {
    vi.useFakeTimers();
    let signedIn = false;
    let token: string | null = null;
    let signInListener: (() => void) | null = null;
    const emitSignIn = () => signInListener?.();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => token,
      getAccountStatus: () => ({
        signedIn,
        sessionReadState: signedIn ? "available" : "missing",
      }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
      subscribeToSignIn: (listener) => {
        signInListener = listener;
        return () => { signInListener = null; };
      },
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getPublisherHealth().state).toBe("account_signed_out");

    signedIn = true;
    token = "late-token";
    emitSignIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getPublisherHealth().state).toBe("published");

    token = "heartbeat-token";
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_HEARTBEAT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("coalesces relay readiness changes into a publish and resets the heartbeat", async () => {
    vi.useFakeTimers();
    const current = routeSnapshot();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    current.routeHealth.relay.relayControlConnected = false;
    current.routeHealth.relay.relayBridgeValidated = false;
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_HEARTBEAT_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it("publishes at the first relay poll when the startup snapshot was unavailable", async () => {
    vi.useFakeTimers();
    let ready = false;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => ready ? routeSnapshot() : null,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getPublisherHealth().state).toBe("no_active_sync_scope");
    expect(fetchImpl).not.toHaveBeenCalled();

    ready = true;
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getPublisherHealth().state).toBe("published");
    service.dispose();
  });

  it("publishes when the reachable endpoint set changes", async () => {
    vi.useFakeTimers();
    const current = snapshot();
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    current.pairingConnectInfo!.addressCandidates.push({
      kind: "lan",
      host: "192.168.1.21",
    });
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const registration = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(registration.reachableEndpoints).toEqual([
      { kind: "lan", host: "192.168.1.20", port: 8787 },
      { kind: "lan", host: "192.168.1.21", port: 8787 },
    ]);
    expect(service.getPublisherHealth().reachableEndpointCount).toBe(2);
    service.dispose();
  });

  it("does not publish relay transitions while signed out", async () => {
    vi.useFakeTimers();
    const current = routeSnapshot();
    const getAccessToken = vi.fn(async () => "account-token");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken,
      getAccountStatus: () => ({ signedIn: false, sessionReadState: "missing" as const }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    current.routeHealth.relay.relayBridgeValidated = false;
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS * 2);

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.getPublisherHealth().state).toBe("account_signed_out");
    service.dispose();
  });
});

describe("account machine registration publisher", () => {
  it("suffixes Beta and Alpha machine names but never stable names", () => {
    const registrationName = (packageChannel: string | null) =>
      buildAccountMachineRegistration({
        machineKey: "machine-studio",
        snapshot: routeSnapshot(),
        packageChannel,
      })?.name;

    expect(registrationName("beta")).toBe("Arul's Mac Studio · Beta");
    expect(registrationName(" ALPHA ")).toBe("Arul's Mac Studio · Alpha");
    expect(registrationName("stable")).toBe("Arul's Mac Studio");
    expect(registrationName(null)).toBe("Arul's Mac Studio");
  });

  it("publishes health-validated routes without honoring the legacy relay toggle bit", () => {
    const value = routeSnapshot();
    value.routeHealth.relay.enabled = false;
    expect(buildAccountMachineRegistration({
      machineKey: "machine-studio",
      snapshot: value,
    })).toEqual({
      machineKey: "machine-studio",
      deviceId: "device-studio",
      name: "Arul's Mac Studio",
      platform: "macOS",
      deviceType: "desktop",
      pubkey: null,
      reachableEndpoints: [
        { kind: "lan", host: "192.168.1.20", port: 8787 },
        { kind: "tailnet", host: "studio.tailnet.ts.net", port: 8787 },
        { kind: "relay", url: "wss://relay.example/connect/machine-studio" },
      ],
    });
  });

  it("fails closed for viewers and omits unhealthy or spoofed routes", () => {
    expect(buildAccountMachineRegistration({
      machineKey: "machine-studio",
      snapshot: routeSnapshot({ runtimeRole: "viewer" }),
    })).toBeNull();

    const host = routeSnapshot();
    host.routeHealth.listener.loopbackAdeValidated = false;
    host.routeHealth.tailscale.tailscaleReachable = false;
    host.routeHealth.relay.reason = "Relay route is unusable because loopback validation failed.";
    host.pairingConnectInfo!.addressCandidates = [
      { kind: "lan", host: "192.168.1.20" },
      { kind: "tailscale", host: "studio.tailnet.ts.net" },
      { kind: "relay", host: "wss://relay.example/connect/different-machine" },
    ];
    expect(buildAccountMachineRegistration({
      machineKey: "machine-studio",
      snapshot: host,
    })?.reachableEndpoints).toEqual([]);
  });

  it("sends the account bearer only to a trusted directory with a bounded registration body", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response("{}", { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://directory.example/account/machines/register");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer account-secret-token");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
    });
    expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
      machineKey: "machine-studio",
      deviceId: "device-studio",
    }));
  });

  it("never sends the bearer to an untrusted URL or logs it on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 503 }));
    const warn = vi.fn();
    const invalid = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "http://directory.example",
      fetchImpl,
      logger: { warn },
    });
    await invalid.publishNow();
    expect(fetchImpl).not.toHaveBeenCalled();

    const failing = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
      logger: { warn },
    });
    await failing.publishNow();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("account-secret-token");
  });

  it("contains synchronous machine-state failures and exposes the typed outcome", async () => {
    const warn = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => { throw new Error("machine identity unavailable"); },
      fetchImpl: vi.fn(),
      logger: { warn },
    });

    await expect(service.publishNow()).resolves.toBeUndefined();
    expect(service.getPublisherHealth()).toMatchObject({
      state: "machine_key_unavailable",
      skipReason: "The machine directory key is unavailable.",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not send a heartbeat when disposal wins an async state lookup", async () => {
    let resolveSnapshot: ((value: AccountMachineRegistrationSnapshot) => void) | null = null;
    let markSnapshotRequested: (() => void) | null = null;
    const snapshotRequested = new Promise<void>((resolve) => {
      markSnapshotRequested = resolve;
    });
    const fetchImpl = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: () => new Promise((resolve) => {
        resolveSnapshot = resolve;
        markSnapshotRequested?.();
      }),
      getMachineKey: () => "machine-studio",
      fetchImpl,
    });

    const publishing = service.publishNow();
    await snapshotRequested;
    service.dispose();
    resolveSnapshot!(routeSnapshot());
    await publishing;

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("coalesces overlapping heartbeats and keeps publishing on the bounded interval", async () => {
    vi.useFakeTimers();
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      fetchImpl,
    });

    const first = service.publishNow();
    const overlapping = service.publishNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch!(new Response("{}", { status: 200 }));
    await Promise.all([first, overlapping]);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resolveFetch!(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_HEARTBEAT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    resolveFetch!(new Response("{}", { status: 200 }));
    service.dispose();
  });
});
