import { describe, expect, it, vi } from "vitest";
import type { AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import type { DesktopPairedMachineCredentials } from "../../../../desktop/src/shared/types/pairedRuntime";
import {
  DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
} from "../../../../desktop/src/shared/accountDirectory";
import {
  AccountMachineDirectoryService,
  reconcileAccountOwnedMachineTrust,
} from "./accountMachineDirectoryService";

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

  it("ignores the raw development directory environment fallback when packaged", async () => {
    vi.stubEnv("ADE_RUNTIME_PACKAGED", "1");
    vi.stubEnv("ADE_ALLOW_DEVELOPMENT_CLERK", "");
    vi.stubEnv("ADE_ACCOUNT_DIRECTORY_URL", `${DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL}/tenant`);
    try {
      const fetchImpl = directoryFetch([]);
      const service = new AccountMachineDirectoryService({
        getStatus: () => ({ signedIn: true, userId: "user", email: null, name: null, expiresAt: null }),
        getAccessToken: async () => "account-token",
      }, { fetchImpl });

      await expect(service.listMachines()).resolves.toMatchObject({ state: "ok" });
      await expect(service.deleteMachine("mk-studio")).resolves.toEqual({
        ok: true,
        machineKey: "mk-studio",
      });
      expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => input)).toEqual([
        `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/account/machines`,
        `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/account/machines/mk-studio`,
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ignores an explicit development directory callback when packaged", async () => {
    vi.stubEnv("ADE_RUNTIME_PACKAGED", "1");
    vi.stubEnv("ADE_ALLOW_DEVELOPMENT_CLERK", "");
    try {
      const fetchImpl = directoryFetch([]);
      const service = new AccountMachineDirectoryService({
        getStatus: () => ({ signedIn: true, userId: "user", email: null, name: null, expiresAt: null }),
        getAccessToken: async () => "account-token",
      }, {
        directoryBaseUrl: () => `${DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL}/tenant`,
        fetchImpl,
      });

      await expect(service.listMachines()).resolves.toMatchObject({ state: "ok" });
      await expect(service.deleteMachine("mk-studio")).resolves.toEqual({
        ok: true,
        machineKey: "mk-studio",
      });
      expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => input)).toEqual([
        `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/account/machines`,
        `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/account/machines/mk-studio`,
      ]);
    } finally {
      vi.unstubAllEnvs();
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
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ message: "invalid issuer" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });
    await expect(expired.listMachines()).resolves.toMatchObject({
      state: "auth_expired",
      message: expect.stringContaining("Reason: invalid issuer"),
    });
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
