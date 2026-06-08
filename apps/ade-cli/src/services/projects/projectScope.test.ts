import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRegistry } from "./projectRegistry";
import { ProjectScopeRegistry } from "./projectScope";

const createAdeRuntimeMock = vi.fn();

vi.mock("../../bootstrap", () => ({
  createAdeRuntime: createAdeRuntimeMock,
}));

function createRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-scope-"));
  const projectsRoot = path.join(root, "projects");
  const firstProjectRoot = path.join(projectsRoot, "first");
  const secondProjectRoot = path.join(projectsRoot, "second");
  fs.mkdirSync(firstProjectRoot, { recursive: true });
  fs.mkdirSync(secondProjectRoot, { recursive: true });

  const registry = new ProjectRegistry({
    adeDir: path.join(root, "home"),
    projectsPath: path.join(root, "home", "projects.json"),
    secretsDir: path.join(root, "home", "secrets"),
    sockDir: path.join(root, "home", "sock"),
    socketPath: path.join(root, "home", "sock", "ade.sock"),
    desktopBridgeSocketPath: path.join(root, "home", "sock", "desktop-bridge.sock"),
    binDir: path.join(root, "home", "bin"),
    runtimeDir: path.join(root, "home", "runtime"),
  });

  return {
    registry,
    first: registry.add(firstProjectRoot),
    second: registry.add(secondProjectRoot),
  };
}

describe("ProjectScopeRegistry", () => {
  beforeEach(() => {
    createAdeRuntimeMock.mockReset();
    createAdeRuntimeMock.mockImplementation(async () => ({
      dispose: vi.fn(),
    }));
  });

  it("does not elect a sync host while opening ordinary daemon project scopes", async () => {
    const { registry, first, second } = createRegistry();
    const scopeRegistry = new ProjectScopeRegistry(registry, {
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: true,
        hostDiscoveryEnabled: true,
        forceHostRole: false,
        runtimeKind: "daemon",
        appVersion: "test",
        localDeviceIdPath: "/tmp/ade-sync-device",
        phonePairingStateDir: "/tmp/ade-phone-pairing",
      },
    });

    await scopeRegistry.get(first.projectId);
    await scopeRegistry.get(second.projectId);

    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(2);
    expect(createAdeRuntimeMock.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: first.rootPath,
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: false,
        hostDiscoveryEnabled: false,
        initializeInBackground: true,
        runtimeKind: "daemon",
      },
    });
    expect(createAdeRuntimeMock.mock.calls[1]?.[0]).toMatchObject({
      projectRoot: second.rootPath,
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: false,
        hostDiscoveryEnabled: false,
        initializeInBackground: true,
        runtimeKind: "daemon",
      },
    });

    await scopeRegistry.disposeAll();
  });

  it("does not pass sync runtime options when machine sync is disabled", async () => {
    const { registry, first } = createRegistry();
    const scopeRegistry = new ProjectScopeRegistry(registry, {
      syncRuntime: { enabled: false },
    });

    await scopeRegistry.get(first.projectId);

    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(1);
    expect(createAdeRuntimeMock.mock.calls[0]?.[0]).not.toHaveProperty("syncRuntime");

    await scopeRegistry.disposeAll();
  });

  it("warms the most recently opened project as the sync host", async () => {
    const { registry, first, second } = createRegistry();
    const file = JSON.parse(fs.readFileSync(registry.path, "utf8")) as {
      projects: Array<{ projectId: string; lastOpenedAt: number; addedAt: number }>;
    };
    file.projects = file.projects.map((project) => ({
      ...project,
      lastOpenedAt: project.projectId === first.projectId ? 2_000 : 1_000,
      addedAt: project.projectId === first.projectId ? 2_000 : 1_000,
    }));
    fs.writeFileSync(registry.path, JSON.stringify(file, null, 2));

    const scopeRegistry = new ProjectScopeRegistry(registry, {
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: true,
        hostDiscoveryEnabled: true,
        forceHostRole: false,
        runtimeKind: "daemon",
      },
    });

    const scope = await scopeRegistry.ensureSyncHost();

    expect(scope?.registryProjectId).toBe(first.projectId);
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(1);
    expect(createAdeRuntimeMock.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: first.rootPath,
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: true,
        hostDiscoveryEnabled: true,
        initializeInBackground: true,
      },
    });

    await scopeRegistry.disposeAll();
  });

  it("switches the daemon sync host without disposing active project scopes", async () => {
    const { registry, first, second } = createRegistry();
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const onDisposeProject = vi.fn();
    const firstSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    const secondSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    createAdeRuntimeMock
      .mockResolvedValueOnce({ dispose: firstDispose, syncService: firstSyncService })
      .mockResolvedValueOnce({ dispose: secondDispose, syncService: secondSyncService });
    const scopeRegistry = new ProjectScopeRegistry(registry, {
      onDisposeProject,
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: true,
        hostDiscoveryEnabled: true,
        forceHostRole: false,
        runtimeKind: "daemon",
      },
    });

    await scopeRegistry.ensureSyncHost(first.projectId);
    await scopeRegistry.ensureSyncHost(second.projectId);

    expect(firstDispose).not.toHaveBeenCalled();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(onDisposeProject).not.toHaveBeenCalled();
    expect(firstSyncService.setHostDiscoveryEnabled).toHaveBeenCalledWith(false);
    expect(firstSyncService.setHostStartupEnabled).toHaveBeenCalledWith(false);
    expect(secondSyncService.setHostDiscoveryEnabled).toHaveBeenCalledWith(true);
    expect(secondSyncService.setHostStartupEnabled).toHaveBeenCalledWith(true);
    expect(secondSyncService.initialize).toHaveBeenCalled();
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(2);
    expect(createAdeRuntimeMock.mock.calls[1]?.[0]).toMatchObject({
      projectRoot: second.rootPath,
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: true,
        hostDiscoveryEnabled: true,
        initializeInBackground: true,
      },
    });

    await scopeRegistry.disposeAll();
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  it("can prepare a new phone sync host before retiring the previous host", async () => {
    const { registry, first, second } = createRegistry();
    const firstSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    const secondSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    createAdeRuntimeMock
      .mockResolvedValueOnce({ dispose: vi.fn(), syncService: firstSyncService })
      .mockResolvedValueOnce({ dispose: vi.fn(), syncService: secondSyncService });
    const scopeRegistry = new ProjectScopeRegistry(registry, {
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: true,
        hostDiscoveryEnabled: true,
        forceHostRole: false,
        runtimeKind: "daemon",
      },
    });

    await scopeRegistry.switchSyncHost(first.projectId);
    await scopeRegistry.switchSyncHost(second.projectId, {
      deactivatePreviousHost: false,
    });

    expect(firstSyncService.setHostDiscoveryEnabled).not.toHaveBeenCalledWith(false);
    expect(firstSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(false);
    expect(secondSyncService.setHostDiscoveryEnabled).toHaveBeenCalledWith(true);
    expect(secondSyncService.setHostStartupEnabled).toHaveBeenCalledWith(true);
    expect(secondSyncService.initialize).toHaveBeenCalled();

    await scopeRegistry.deactivateInactiveSyncHosts(second.projectId);

    expect(firstSyncService.setHostDiscoveryEnabled).toHaveBeenCalledWith(false);
    expect(firstSyncService.setHostStartupEnabled).toHaveBeenCalledWith(false);

    await scopeRegistry.disposeAll();
  });

  it("promotes an existing warm project when selecting the default sync host", async () => {
    const { registry, first, second } = createRegistry();
    const firstSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    const secondSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    createAdeRuntimeMock
      .mockResolvedValueOnce({ dispose: vi.fn(), syncService: firstSyncService })
      .mockResolvedValueOnce({ dispose: vi.fn(), syncService: secondSyncService });
    const scopeRegistry = new ProjectScopeRegistry(registry, {
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: true,
        hostDiscoveryEnabled: true,
        forceHostRole: false,
        runtimeKind: "daemon",
      },
    });

    await scopeRegistry.ensureSyncHost(first.projectId);
    await scopeRegistry.get(second.projectId);
    const file = JSON.parse(fs.readFileSync(registry.path, "utf8")) as {
      projects: Array<{ projectId: string; lastOpenedAt: number; addedAt: number }>;
    };
    file.projects = file.projects.map((project) => ({
      ...project,
      lastOpenedAt: project.projectId === second.projectId ? 2_000 : 1_000,
      addedAt: project.projectId === second.projectId ? 2_000 : 1_000,
    }));
    fs.writeFileSync(registry.path, JSON.stringify(file, null, 2));
    await scopeRegistry.dispose(first.projectId);
    const promoted = await scopeRegistry.ensureSyncHost();

    expect(promoted?.registryProjectId).toBe(second.projectId);
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(2);
    expect(secondSyncService.setHostDiscoveryEnabled).toHaveBeenCalledWith(true);
    expect(secondSyncService.setHostStartupEnabled).toHaveBeenCalledWith(true);
    expect(secondSyncService.initialize).toHaveBeenCalled();

    await scopeRegistry.disposeAll();
  });

});
