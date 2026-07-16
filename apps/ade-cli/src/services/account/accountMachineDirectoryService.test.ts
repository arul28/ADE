import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import type { DesktopPairedMachineCredentials } from "../../../../desktop/src/shared/types/pairedRuntime";
import { DEFAULT_ADE_ACCOUNT_DIRECTORY_URL } from "../../../../desktop/src/shared/accountDirectory";
import {
  AccountMachineDirectoryService,
  reconcileAccountOwnedMachineTrust,
} from "./accountMachineDirectoryService";
import {
  ACCOUNT_MACHINE_HEARTBEAT_MS,
  type AccountMachineRegistrationSnapshot,
  buildAccountMachineRegistration,
  createAccountMachinePublisherService,
} from "./accountMachinePublisherService";

function machine(overrides: Partial<AdeAccountMachine> = {}): AdeAccountMachine {
  return {
    machineKey: "mk-studio",
    deviceId: "device-studio",
    name: "Studio",
    platform: "macOS",
    deviceType: "desktop",
    reachableEndpoints: [{ kind: "relay", url: "wss://relay.example/connect/mk-studio" }],
    lastSeenAt: Date.now(),
    online: true,
    ...overrides,
  };
}

function directoryFetch(machines: AdeAccountMachine[], status = 200): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
    status === 200 ? JSON.stringify({ machines }) : null,
    { status, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
}

function publisherSnapshot(
  overrides: Partial<AccountMachineRegistrationSnapshot> = {},
): AccountMachineRegistrationSnapshot {
  return {
    role: "brain",
    runtimeRole: "host",
    runtimeName: "Arul's Mac Studio",
    pairingConnectInfo: {
      hostIdentity: {
        deviceId: "device-studio",
        siteId: "site-studio",
        name: "Mac Studio",
        platform: "macOS",
        deviceType: "desktop",
      },
      port: 8787,
      addressCandidates: [
        { kind: "lan", host: "192.168.1.20" },
        { kind: "tailscale", host: "studio.tailnet.ts.net" },
        { kind: "loopback", host: "127.0.0.1" },
        { kind: "relay", host: "wss://relay.example/connect/machine-studio" },
      ],
    },
    routeHealth: {
      listener: {
        listenerBound: true,
        loopbackAdeValidated: true,
        port: 8787,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: "2026-07-15T12:00:00.000Z",
      },
      tailscale: {
        enabled: true,
        tailscalePublished: true,
        tailscaleReachable: true,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: "2026-07-15T12:00:00.000Z",
      },
      relay: {
        enabled: true,
        relayControlConnected: true,
        relayBridgeValidated: true,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: "2026-07-15T12:00:00.000Z",
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AccountMachineDirectoryService", () => {
  it("removes account-owned client trust together and preserves direct pairings", () => {
    const removedCredential = {
      hostIdentity: { deviceId: "account-host" },
      machineKey: "account-key",
    } as DesktopPairedMachineCredentials;
    const directTarget = {
      id: "direct-target",
      pairedMachine: { hostIdentity: "direct-host", machineKey: null },
    } as RemoteRuntimeTarget;
    const orphanedHistoricalTarget = {
      id: "orphaned-target",
      pairedMachine: { hostIdentity: "account-host", machineKey: "account-key" },
    } as RemoteRuntimeTarget;
    const remove = vi.fn((id: string) => id === orphanedHistoricalTarget.id);
    const result = reconcileAccountOwnedMachineTrust(null, {
      pairedStore: {
        pruneAccountOwned: vi.fn(() => [removedCredential]),
      },
      targetRegistry: {
        pruneAccountOwned: vi.fn(() => [{ id: "owned-target" } as RemoteRuntimeTarget]),
        list: vi.fn(() => [directTarget, orphanedHistoricalTarget]),
        remove,
      },
    });

    expect(result).toEqual({
      removedTargetIds: ["owned-target", "orphaned-target"],
      removedCredentialHostIds: ["account-host"],
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("orphaned-target");
    expect(remove).not.toHaveBeenCalledWith("direct-target");
  });

  it("keeps signed-out use local-first and does not call the directory", async () => {
    const fetchImpl = directoryFetch([]);
    const service = new AccountMachineDirectoryService({
      getStatus: () => ({ signedIn: false, userId: null, email: null, name: null, expiresAt: null }),
      getAccessToken: vi.fn(async () => "should-not-be-read"),
    }, { directoryBaseUrl: () => "https://directory.example", fetchImpl });

    await expect(service.listMachines()).resolves.toEqual({
      state: "signed_out",
      machines: [],
      message: null,
    });
    await expect(service.pairMachine("mk-studio")).rejects.toThrow(/ade login.*local/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes a provisioned account token before listing machines", async () => {
    const getAccessToken = vi.fn(async () => "refreshed-account-token");
    const fetchImpl = directoryFetch([machine()]);
    const service = new AccountMachineDirectoryService({
      getStatus: () => ({
        signedIn: false,
        userId: null,
        email: null,
        name: null,
        expiresAt: null,
        source: "env-token",
      }),
      getAccessToken,
    }, { directoryBaseUrl: () => "https://directory.example", fetchImpl });

    await expect(service.listMachines()).resolves.toMatchObject({
      state: "ok",
      machines: [{ machineKey: "mk-studio" }],
    });
    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(new Headers((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers)
      .get("authorization")).toBe("Bearer refreshed-account-token");
  });

  it("deletes a machine through the authenticated account directory route", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, machineKey: "mk/studio" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const service = new AccountMachineDirectoryService({
      getStatus: () => ({
        signedIn: true,
        userId: "user",
        email: null,
        name: null,
        expiresAt: null,
      }),
      getAccessToken: async () => "account-token",
    }, {
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await expect(service.deleteMachine("  mk/studio  ")).resolves.toEqual({
      ok: true,
      machineKey: "mk/studio",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(input).toBe("https://directory.example/account/machines/mk%2Fstudio");
    expect(String(input)).not.toContain("account-token");
    expect(init).toMatchObject({
      method: "DELETE",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer account-token");
  });

  it("uses the hosted directory when the machine override is blank", async () => {
    const prior = process.env.ADE_ACCOUNT_DIRECTORY_URL;
    process.env.ADE_ACCOUNT_DIRECTORY_URL = "   ";
    try {
      const fetchImpl = directoryFetch([]);
      const service = new AccountMachineDirectoryService({
        getStatus: () => ({ signedIn: true, userId: "user", email: null, name: null, expiresAt: null }),
        getAccessToken: async () => "account-token",
      }, { fetchImpl });

      await expect(service.listMachines()).resolves.toMatchObject({ state: "ok" });
      expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
        `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/account/machines`,
      );
    } finally {
      if (prior == null) delete process.env.ADE_ACCOUNT_DIRECTORY_URL;
      else process.env.ADE_ACCOUNT_DIRECTORY_URL = prior;
    }
  });

  it("keeps offline machines visible but rejects connecting to them", async () => {
    const offline = machine({ online: false, lastSeenAt: 1 });
    const service = new AccountMachineDirectoryService({
      getStatus: () => ({ signedIn: true, userId: "user", email: null, name: null, expiresAt: null }),
      getAccessToken: async () => "account-token",
    }, {
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: directoryFetch([offline]),
    });

    await expect(service.listMachines()).resolves.toMatchObject({
      state: "ok",
      machines: [{ machineKey: "mk-studio", online: false, lastSeenAt: 1 }],
    });
    await expect(service.pairMachine("mk-studio")).rejects.toThrow(/offline/i);
  });

  it("fails ambiguous names with stable choices and reports directory auth expiry", async () => {
    const account = {
      getStatus: () => ({ signedIn: true, userId: "user", email: null, name: null, expiresAt: null }),
      getAccessToken: async () => "account-token",
    };
    const ambiguous = new AccountMachineDirectoryService(account, {
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: directoryFetch([
        machine({ machineKey: "mk-a", deviceId: "dev-a" }),
        machine({ machineKey: "mk-b", deviceId: "dev-b" }),
      ]),
    });
    await expect(ambiguous.pairMachine("Studio")).rejects.toThrow(/ambiguous.*mk-a.*mk-b/i);

    const expired = new AccountMachineDirectoryService(account, {
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: directoryFetch([], 401),
    });
    await expect(expired.listMachines()).resolves.toMatchObject({ state: "auth_expired" });
  });

  it("pairs through the account relay and saves a paired target for ADE Code", async () => {
    const pairWithAccountMachine = vi.fn(async (): Promise<Pick<
      DesktopPairedMachineCredentials,
      "hostIdentity" | "endpoints"
    >> => ({
      hostIdentity: {
        deviceId: "device-studio",
        siteId: "host-site",
        name: "Studio",
        platform: "macOS",
        deviceType: "desktop",
      },
      endpoints: ["wss://relay.example/connect/mk-studio", "ws://10.0.0.8:8787/"],
    }));
    const savedTarget: RemoteRuntimeTarget = {
      id: "target-account-studio",
      name: "Studio",
      hostname: "10.0.0.8",
      transport: "paired",
      pairedMachine: { hostIdentity: "device-studio", machineKey: "mk-studio" },
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: [],
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    const save = vi.fn(() => savedTarget);
    const service = new AccountMachineDirectoryService({
      getStatus: () => ({ signedIn: true, userId: "user", email: null, name: null, expiresAt: null }),
      getAccessToken: async () => "account-token",
    }, {
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: directoryFetch([machine()]),
      deviceName: () => "ADE Code test",
      pairedStore: { pairWithAccountMachine },
      targetRegistry: { save },
      appVersion: "1.2.3",
      relayBaseUrls: ["https://relay.example"],
    });

    await expect(service.pairMachine("mk-studio")).resolves.toEqual({
      targetId: "target-account-studio",
      machineKey: "mk-studio",
      deviceId: "device-studio",
      name: "Studio",
    });
    expect(pairWithAccountMachine).toHaveBeenCalledWith(
      expect.objectContaining({ machineKey: "mk-studio" }),
      "account-token",
      "ADE Code test",
      {
        appVersion: "1.2.3",
        relayBaseUrls: ["https://relay.example"],
        accountOwnerUserId: "user",
        authorizeAccountCommit: expect.any(Function),
      },
    );
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      transport: "paired",
      pairedMachine: { hostIdentity: "device-studio", machineKey: "mk-studio" },
      routes: [],
    }));
  });

  it.each([
    { name: "sign-out", nextUserId: null, nextToken: null },
    { name: "account switch", nextUserId: "user-b", nextToken: "token-b" },
  ])("does not save a machine when $name wins a deferred account hello", async ({
    nextUserId,
    nextToken,
  }) => {
    let userId: string | null = "user-a";
    let token: string | null = "token-a";
    let finishPairing: ((value: DesktopPairedMachineCredentials) => void) | null = null;
    let markPairingStarted: (() => void) | null = null;
    const pairingStarted = new Promise<void>((resolve) => {
      markPairingStarted = resolve;
    });
    let stored: DesktopPairedMachineCredentials | null = null;
    const pairWithAccountMachine = vi.fn(async () => {
      markPairingStarted?.();
      const credentials = await new Promise<DesktopPairedMachineCredentials>((resolve) => {
        finishPairing = resolve;
      });
      // Model a pairer that committed immediately before its promise resolved.
      stored = credentials;
      return credentials;
    });
    const saveTarget = vi.fn();
    const service = new AccountMachineDirectoryService({
      getStatus: () => ({
        signedIn: userId != null,
        userId,
        email: null,
        name: null,
        expiresAt: null,
      }),
      getAccessToken: async () => {
        if (!token) throw new Error("Signed out");
        return token;
      },
    }, {
      pairedStore: {
        pairWithAccountMachine,
        get: () => stored,
        save: (credentials) => {
          stored = credentials;
          return credentials;
        },
        remove: () => {
          stored = null;
          return true;
        },
      },
      targetRegistry: { save: saveTarget },
    });

    const pairing = service.pairListedMachine(machine());
    await pairingStarted;
    userId = nextUserId;
    token = nextToken;
    finishPairing!({
      version: 1,
      hostIdentity: {
        deviceId: "device-studio",
        siteId: "host-site",
        name: "Studio",
        platform: "macOS",
        deviceType: "desktop",
      },
      machineKey: "mk-studio",
      accountOwnerUserId: "user-a",
      deviceId: "client-a",
      siteId: "client-site-a",
      deviceName: "ADE Code",
      secret: "paired-secret",
      dpopPrivateKey: "private-key",
      dpopPublicKey: "public-key",
      endpoints: ["wss://relay.example/connect/mk-studio"],
      relayUrl: "wss://relay.example/connect/mk-studio",
      endpointStates: [],
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });

    await expect(pairing).rejects.toThrow(/account changed/i);
    expect(stored).toBeNull();
    expect(saveTarget).not.toHaveBeenCalled();
  });
});

describe("account machine registration publisher", () => {
  it("publishes health-validated routes without honoring the legacy relay toggle bit", () => {
    const snapshot = publisherSnapshot();
    snapshot.routeHealth.relay.enabled = false;
    expect(buildAccountMachineRegistration({
      machineKey: "machine-studio",
      snapshot,
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
      snapshot: publisherSnapshot({ runtimeRole: "viewer" }),
    })).toBeNull();

    const host = publisherSnapshot();
    host.routeHealth.listener.loopbackAdeValidated = false;
    host.routeHealth.tailscale.tailscaleReachable = false;
    host.routeHealth.relay.relayBridgeValidated = true;
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
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response("{}", { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => publisherSnapshot(),
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
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response("no", { status: 503 }));
    const warn = vi.fn();
    const invalid = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => publisherSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "http://directory.example",
      fetchImpl,
      logger: { warn },
    });
    await invalid.publishNow();
    expect(fetchImpl).not.toHaveBeenCalled();

    const failing = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => publisherSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
      logger: { warn },
    });
    await failing.publishNow();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("account-secret-token");
  });

  it("contains synchronous machine-state failures instead of rejecting the brain loop", async () => {
    const warn = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => publisherSnapshot(),
      getMachineKey: () => {
        throw new Error("machine identity unavailable");
      },
      fetchImpl: vi.fn(),
      logger: { warn },
    });

    await expect(service.publishNow()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("account.machine_publish_failed", {
      code: "publisher_error",
      errorKind: "Error",
    });
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
    resolveSnapshot!(publisherSnapshot());
    await publishing;

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("coalesces overlapping heartbeats and keeps publishing on the bounded interval", async () => {
    vi.useFakeTimers();
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "token",
      getSnapshot: async () => publisherSnapshot(),
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
