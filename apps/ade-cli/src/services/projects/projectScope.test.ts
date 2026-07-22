import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markActiveHostProjectOpen } from "./projectCatalog";
import { ProjectRegistry } from "./projectRegistry";
import { ProjectScopeRegistry } from "./projectScope";

const createAdeRuntimeMock = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

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

  it("keeps inactive recent projects cold after starting an explicit system host", async () => {
    const { registry, first, second } = createRegistry();
    const projectsRoot = path.dirname(first.rootPath);
    const thirdProjectRoot = path.join(projectsRoot, "third");
    const healthProbeRoot = path.join(projectsRoot, "health-probe");
    fs.mkdirSync(thirdProjectRoot, { recursive: true });
    fs.mkdirSync(healthProbeRoot, { recursive: true });

    const recentSecond = registry.add(second.rootPath, {
      catalogVisibility: "recent",
      registrationSource: "desktop",
    });
    const recentThird = registry.add(thirdProjectRoot, {
      catalogVisibility: "recent",
      registrationSource: "desktop",
    });
    const healthProbe = registry.add(healthProbeRoot);
    const file = JSON.parse(fs.readFileSync(registry.path, "utf8")) as {
      projects: Array<{ projectId: string; lastOpenedAt: number; addedAt: number }>;
    };
    const recency = new Map([
      [first.projectId, 4_000],
      [healthProbe.projectId, 3_000],
      [recentSecond.projectId, 2_000],
      [recentThird.projectId, 1_000],
    ]);
    file.projects = file.projects.map((project) => ({
      ...project,
      lastOpenedAt: recency.get(project.projectId) ?? 0,
      addedAt: recency.get(project.projectId) ?? 0,
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

    await scopeRegistry.ensureSyncHost(first.projectId);
    await new Promise((resolve) => setImmediate(resolve));

    expect(createAdeRuntimeMock.mock.calls.map(([args]) => args.projectRoot)).toEqual([
      first.rootPath,
    ]);
    expect(scopeRegistry.getIfBooted(recentSecond.projectId)).toBeNull();
    expect(scopeRegistry.getIfBooted(recentThird.projectId)).toBeNull();
    expect(createAdeRuntimeMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: healthProbe.rootPath }),
    );

    await scopeRegistry.disposeAll();
  });

  it("warms the most recently opened project as the sync host", async () => {
    const { registry, first } = createRegistry();
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
        hostStartupEnabled: false,
        hostDiscoveryEnabled: false,
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
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
    await scopeRegistry.ensureSyncHost(second.projectId);
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(second.projectId);

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
        hostStartupEnabled: false,
        hostDiscoveryEnabled: false,
        initializeInBackground: true,
      },
    });

    await scopeRegistry.disposeAll();
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous host active past parked-peer grace throughout a slow target boot", async () => {
    vi.useFakeTimers();
    try {
      const { registry, first, second } = createRegistry();
      const targetRuntime = deferred<any>();
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
        .mockImplementationOnce(() => targetRuntime.promise);
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
      firstSyncService.setHostDiscoveryEnabled.mockClear();
      firstSyncService.setHostStartupEnabled.mockClear();

      const switching = scopeRegistry.switchSyncHost(second.projectId);
      await vi.advanceTimersByTimeAsync(30_001);

      // Parked peers are closed after 30s. The previous listener must still own
      // them even when cold target setup outlives that entire grace period.
      expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
      expect(firstSyncService.setHostDiscoveryEnabled).not.toHaveBeenCalledWith(false);
      expect(firstSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(false);
      targetRuntime.resolve({ dispose: vi.fn(), syncService: secondSyncService });
      await switching;
      expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(second.projectId);
      expect(firstSyncService.setHostDiscoveryEnabled).toHaveBeenCalledWith(false);
      expect(secondSyncService.setHostDiscoveryEnabled).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the previous host when target activation fails", async () => {
    const { registry, first, second } = createRegistry();
    const firstSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    const secondSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async (enabled: boolean) => {
        if (enabled) throw new Error("target activation failed");
      }),
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
    firstSyncService.setHostDiscoveryEnabled.mockClear();
    firstSyncService.setHostStartupEnabled.mockClear();

    await expect(scopeRegistry.switchSyncHost(second.projectId)).rejects.toThrow("target activation failed");

    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
    expect(firstSyncService.setHostStartupEnabled).toHaveBeenNthCalledWith(1, false);
    expect(firstSyncService.setHostStartupEnabled).toHaveBeenNthCalledWith(2, true);
    expect(secondSyncService.setHostStartupEnabled).toHaveBeenCalledWith(false);
  });

  it("coalesces a queued A -> B -> C selection before booting the superseded target", async () => {
    const { registry, first, second } = createRegistry();
    const thirdRoot = path.join(path.dirname(first.rootPath), "third-concurrent");
    fs.mkdirSync(thirdRoot, { recursive: true });
    const third = registry.add(thirdRoot);
    const thirdRuntime = deferred<any>();
    const makeSyncService = () => ({
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    });
    const firstSyncService = makeSyncService();
    const secondSyncService = makeSyncService();
    const thirdSyncService = makeSyncService();
    createAdeRuntimeMock
      .mockResolvedValueOnce({ dispose: vi.fn(), syncService: firstSyncService })
      .mockImplementationOnce(() => thirdRuntime.promise);
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
    firstSyncService.setHostStartupEnabled.mockClear();

    const switchToSecond = scopeRegistry.switchSyncHost(second.projectId);
    const switchToThird = scopeRegistry.switchSyncHost(third.projectId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(createAdeRuntimeMock.mock.calls.map(([args]) => args.projectRoot)).toEqual([
      first.rootPath,
      third.rootPath,
    ]);
    thirdRuntime.resolve({ dispose: vi.fn(), syncService: thirdSyncService });
    const [secondResult, thirdResult] = await Promise.all([switchToSecond, switchToThird]);

    expect(secondResult).toBeNull();
    expect(thirdResult?.registryProjectId).toBe(third.projectId);
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(third.projectId);
    expect(secondSyncService.initialize).not.toHaveBeenCalled();
    expect(secondSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(true);
    expect(thirdSyncService.setHostStartupEnabled).toHaveBeenCalledWith(true);
    expect(firstSyncService.setHostStartupEnabled).toHaveBeenCalledTimes(1);
    expect(firstSyncService.setHostStartupEnabled).toHaveBeenCalledWith(false);
  });

  it("does not let a never-resolving obsolete cold boot delay the newest host", async () => {
    vi.useFakeTimers();
    try {
      const { registry, first, second } = createRegistry();
      const thirdRoot = path.join(path.dirname(first.rootPath), "third-after-stuck-boot");
      fs.mkdirSync(thirdRoot, { recursive: true });
      const third = registry.add(thirdRoot);
      const stuckSecondRuntime = deferred<any>();
      const makeSyncService = () => ({
        initialize: vi.fn(async () => undefined),
        setHostDiscoveryEnabled: vi.fn(),
        setHostStartupEnabled: vi.fn(async () => undefined),
      });
      const firstSyncService = makeSyncService();
      const thirdSyncService = makeSyncService();
      createAdeRuntimeMock
        .mockResolvedValueOnce({ dispose: vi.fn(), syncService: firstSyncService })
        .mockImplementationOnce(() => stuckSecondRuntime.promise)
        .mockResolvedValueOnce({ dispose: vi.fn(), syncService: thirdSyncService });
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
      firstSyncService.setHostStartupEnabled.mockClear();

      const switchToSecond = scopeRegistry.switchSyncHost(second.projectId);
      const secondRejection = expect(switchToSecond).rejects.toThrow(
        `Sync host cold boot for ${second.projectId} timed out`,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(createAdeRuntimeMock).toHaveBeenCalledTimes(2);

      const switchedToThird = await scopeRegistry.switchSyncHost(third.projectId);
      expect(switchedToThird?.registryProjectId).toBe(third.projectId);
      expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(third.projectId);
      expect(firstSyncService.setHostStartupEnabled).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_001);
      await secondRejection;
      expect(scopeRegistry.getIfBooted(second.projectId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes a late cold-boot completion without deleting a successful retry", async () => {
    vi.useFakeTimers();
    try {
      const { registry, first, second } = createRegistry();
      const staleRuntime = deferred<any>();
      const staleDispose = vi.fn();
      const makeSyncService = () => ({
        initialize: vi.fn(async () => undefined),
        setHostDiscoveryEnabled: vi.fn(),
        setHostStartupEnabled: vi.fn(async () => undefined),
      });
      const firstSyncService = makeSyncService();
      const staleSyncService = makeSyncService();
      const retrySyncService = makeSyncService();
      createAdeRuntimeMock
        .mockResolvedValueOnce({ dispose: vi.fn(), syncService: firstSyncService })
        .mockImplementationOnce(() => staleRuntime.promise)
        .mockResolvedValueOnce({ dispose: vi.fn(), syncService: retrySyncService });
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

      const firstAttempt = scopeRegistry.switchSyncHost(second.projectId);
      const rejection = expect(firstAttempt).rejects.toThrow(
        `Sync host cold boot for ${second.projectId} timed out`,
      );
      await vi.advanceTimersByTimeAsync(60_001);
      await rejection;

      const retryScope = await scopeRegistry.switchSyncHost(second.projectId);
      expect(retryScope?.runtime.syncService).toBe(retrySyncService);
      expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(second.projectId);

      staleRuntime.resolve({ dispose: staleDispose, syncService: staleSyncService });
      await vi.advanceTimersByTimeAsync(0);
      expect(staleDispose).toHaveBeenCalledTimes(1);
      await expect(scopeRegistry.getIfBooted(second.projectId)).resolves.toBe(retryScope);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a never-resolving target initialization without disabling the old host", async () => {
    vi.useFakeTimers();
    try {
      const { registry, first, second } = createRegistry();
      const stuckInitialization = deferred<void>();
      const firstSyncService = {
        initialize: vi.fn(async () => undefined),
        setHostDiscoveryEnabled: vi.fn(),
        setHostStartupEnabled: vi.fn(async () => undefined),
      };
      const secondSyncService = {
        initialize: vi.fn(() => stuckInitialization.promise),
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
      firstSyncService.setHostDiscoveryEnabled.mockClear();
      firstSyncService.setHostStartupEnabled.mockClear();

      const switching = scopeRegistry.switchSyncHost(second.projectId);
      const rejection = expect(switching).rejects.toThrow(
        `Sync host initialization for ${second.projectId} timed out`,
      );
      await vi.advanceTimersByTimeAsync(30_001);
      await rejection;

      expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
      expect(firstSyncService.setHostDiscoveryEnabled).not.toHaveBeenCalledWith(false);
      expect(firstSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(false);
      expect(secondSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(true);
      expect(scopeRegistry.getIfBooted(second.projectId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stuck activation, rolls back, and releases the mutation tail", async () => {
    vi.useFakeTimers();
    try {
      const { registry, first, second } = createRegistry();
      const thirdRoot = path.join(path.dirname(first.rootPath), "third-after-stuck-activation");
      fs.mkdirSync(thirdRoot, { recursive: true });
      const third = registry.add(thirdRoot);
      const stuckActivation = deferred<void>();
      const firstSyncService = {
        initialize: vi.fn(async () => undefined),
        setHostDiscoveryEnabled: vi.fn(),
        setHostStartupEnabled: vi.fn(async () => undefined),
      };
      const secondSyncService = {
        initialize: vi.fn(async () => undefined),
        setHostDiscoveryEnabled: vi.fn(),
        setHostStartupEnabled: vi.fn((enabled: boolean) => (
          enabled ? stuckActivation.promise : Promise.resolve()
        )),
      };
      const thirdSyncService = {
        initialize: vi.fn(async () => undefined),
        setHostDiscoveryEnabled: vi.fn(),
        setHostStartupEnabled: vi.fn(async () => undefined),
      };
      createAdeRuntimeMock
        .mockResolvedValueOnce({ dispose: vi.fn(), syncService: firstSyncService })
        .mockResolvedValueOnce({ dispose: vi.fn(), syncService: secondSyncService })
        .mockResolvedValueOnce({ dispose: vi.fn(), syncService: thirdSyncService });
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
      firstSyncService.setHostStartupEnabled.mockClear();

      const switching = scopeRegistry.switchSyncHost(second.projectId);
      const rejection = expect(switching).rejects.toThrow(
        `Sync host activation for ${second.projectId} timed out`,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
      expect(firstSyncService.setHostStartupEnabled).toHaveBeenCalledWith(false);
      expect(secondSyncService.setHostStartupEnabled).toHaveBeenCalledWith(true);

      await vi.advanceTimersByTimeAsync(10_001);
      await rejection;
      expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
      expect(secondSyncService.setHostStartupEnabled).toHaveBeenCalledWith(false);
      expect(firstSyncService.setHostStartupEnabled).toHaveBeenLastCalledWith(true);

      const switchedToThird = await scopeRegistry.switchSyncHost(third.projectId);
      expect(switchedToThird?.registryProjectId).toBe(third.projectId);
      expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(third.projectId);
    } finally {
      vi.useRealTimers();
    }
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

describe("markActiveHostProjectOpen", () => {
  it("marks the current sync host open even when a stale project is first", () => {
    const catalog = [
      { id: "project_stale_mru", displayName: "Stale MRU", isOpen: false },
      { id: "project_active", displayName: "Active host", isOpen: false },
    ];

    const updated = markActiveHostProjectOpen(catalog, "project_active");

    expect(updated).toEqual([
      { id: "project_stale_mru", displayName: "Stale MRU", isOpen: false },
      { id: "project_active", displayName: "Active host", isOpen: true },
    ]);
    expect(updated.find((project) => project.isOpen)?.id).toBe("project_active");
  });

  it("moves the open marker when the active sync host changes", () => {
    const catalog = [
      { id: "project_previous", isOpen: true },
      { id: "project_current", isOpen: false },
    ];

    expect(markActiveHostProjectOpen(catalog, "project_current")).toEqual([
      { id: "project_previous", isOpen: false },
      { id: "project_current", isOpen: true },
    ]);
  });
});
