import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipc";

type Invoke = ReturnType<typeof vi.fn>;

const remoteBinding = {
  kind: "remote",
  key: "remote:machine:project",
  targetId: "machine-1",
  runtimeName: "Mac Studio",
  projectId: "project-1",
  rootPath: "/remote/repo",
  displayName: "repo",
} as const;

function installElectronMock(invoke: Invoke): void {
  vi.doMock("electron", () => ({
    contextBridge: {
      exposeInMainWorld: vi.fn((_name: string, value: unknown) => {
        (globalThis as any).__adeBridge = value;
      }),
    },
    ipcRenderer: {
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    webFrame: {
      getZoomLevel: vi.fn(() => 0),
      setZoomLevel: vi.fn(),
      getZoomFactor: vi.fn(() => 1),
    },
  }));
}

async function loadBridge(invoke: Invoke): Promise<any> {
  installElectronMock(invoke);
  await import("./preload");
  return (globalThis as any).__adeBridge;
}

describe("preload provider runtime contracts", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as any).__adeBridge;
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("electron");
    delete (globalThis as any).__adeBridge;
  });

  it("normalizes every provider instance runtime wrapper to its IPC shape", async () => {
    const instance = { id: "codex:one", provider: "codex", label: "Work" };
    const renamedInstance = { ...instance, label: "Renamed" };
    const settings = { enabled: true, accountLabel: "Work" };
    const loginCommand = { command: "codex", args: ["login"] };
    const results: Record<string, unknown> = {
      list: { instances: [instance] },
      create: { instance, created: true },
      remove: { removed: true },
      rename: { instance: renamedInstance },
      setDefault: { instance },
      setAccent: { instance },
      getSettings: { settings },
      setSettings: { settings },
      loginCommand: { loginCommand },
      refresh: { instances: [instance] },
    };
    const invoke = vi.fn(async (channel: string, payload?: any) => {
      if (channel === IPC.appGetWindowSession) return { binding: remoteBinding };
      if (channel === IPC.remoteRuntimeCallAction) {
        return { result: results[payload.request.action] };
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const bridge = await loadBridge(invoke);

    await expect(bridge.providerInstances.list({ provider: "codex" })).resolves.toEqual([instance]);
    await expect(bridge.providerInstances.create({ provider: "codex", label: "Work" })).resolves.toEqual(results.create);
    await expect(bridge.providerInstances.remove({ id: instance.id })).resolves.toEqual(results.remove);
    await expect(bridge.providerInstances.rename({ id: instance.id, label: "Renamed" })).resolves.toEqual(renamedInstance);
    await expect(bridge.providerInstances.setDefault({ id: instance.id })).resolves.toEqual(instance);
    await expect(bridge.providerInstances.setAccent({ id: instance.id, accentColor: "#0000ff" })).resolves.toEqual(instance);
    await expect(bridge.providerInstances.getSettings({ provider: "codex" })).resolves.toEqual(settings);
    await expect(bridge.providerInstances.setSettings({ provider: "codex", settings })).resolves.toEqual(settings);
    await expect(bridge.providerInstances.loginCommand({ id: instance.id })).resolves.toEqual(loginCommand);
    await expect(bridge.providerInstances.refresh()).resolves.toEqual([instance]);

    const runtimeActions = invoke.mock.calls
      .filter(([channel]) => channel === IPC.remoteRuntimeCallAction)
      .map(([, payload]) => payload.request.action);
    expect(runtimeActions).toEqual([
      "list",
      "create",
      "remove",
      "rename",
      "setDefault",
      "setAccent",
      "getSettings",
      "setSettings",
      "loginCommand",
      "refresh",
    ]);
  });

  it("routes reset-credit spending through the project runtime with IPC fallback", async () => {
    const remoteInvoke = vi.fn(async (channel: string, payload?: any) => {
      if (channel === IPC.appGetWindowSession) return { binding: remoteBinding };
      if (channel === IPC.remoteRuntimeCallAction) {
        expect(payload.request).toEqual({
          domain: "usage",
          action: "consumeResetCredit",
          args: { accountId: "codex:one" },
        });
        return { result: { ok: true, status: "reset" } };
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const remoteBridge = await loadBridge(remoteInvoke);
    await expect(remoteBridge.usage.consumeResetCredit({ accountId: "codex:one" })).resolves.toEqual({
      ok: true,
      status: "reset",
    });
    expect(remoteInvoke).not.toHaveBeenCalledWith(IPC.usageConsumeResetCredit, expect.anything());

    vi.resetModules();
    delete (globalThis as any).__adeBridge;
    const fallbackResult = { ok: false, message: "offline" };
    const fallbackInvoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) return { binding: null };
      if (channel === IPC.usageConsumeResetCredit) return fallbackResult;
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const fallbackBridge = await loadBridge(fallbackInvoke);
    await expect(fallbackBridge.usage.consumeResetCredit({ accountId: "codex:one" })).resolves.toEqual(fallbackResult);
    expect(fallbackInvoke).toHaveBeenCalledWith(IPC.usageConsumeResetCredit, { accountId: "codex:one" });
  });

  it("keeps the This Mac inventory request on local main-process IPC", async () => {
    const inventory = { machineKey: "this-machine", items: [] };
    const invoke = vi.fn(async (channel: string, payload?: any) => {
      if (channel === IPC.accountGetLocalMachineIdentity) return { machineKey: "this-machine" };
      if (channel === IPC.accountGetMachineInventory) {
        expect(payload).toEqual({ machineKey: "this-machine" });
        return inventory;
      }
      if (channel === IPC.appGetWindowSession) {
        throw new Error("This Mac must not inspect the selected project runtime");
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const bridge = await loadBridge(invoke);

    await expect(bridge.account.getMachineInventory()).resolves.toEqual(inventory);
    expect(invoke).not.toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.localRuntimeCallAction, expect.anything());
  });
});
