import { describe, expect, it, vi } from "vitest";
import type { AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import type { DesktopPairedMachineCredentials } from "../../../../desktop/src/shared/types/pairedRuntime";
import { AccountMachineDirectoryService } from "./accountMachineDirectoryService";

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
  return vi.fn(async () => new Response(
    status === 200 ? JSON.stringify({ machines }) : null,
    { status, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
}

describe("AccountMachineDirectoryService", () => {
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
      { appVersion: "1.2.3", relayBaseUrls: ["https://relay.example"] },
    );
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      transport: "paired",
      pairedMachine: { hostIdentity: "device-studio", machineKey: "mk-studio" },
      routes: [],
    }));
  });
});
