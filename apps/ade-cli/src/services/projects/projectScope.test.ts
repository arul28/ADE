import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markActiveHostProjectOpen } from "./projectCatalog";
import { ProjectRegistry } from "./projectRegistry";
import { FAILED_SCOPE_BACKOFF_MAX_MS, ProjectScopeRegistry, SyncHostRoleBlockedError } from "./projectScope";

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

/** A clock the test advances by hand, so no test waits on real time. */
function fakeClock(startMs = 1_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
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

  it("passes over a recent project whose folder is gone, and hosts without one when none is left", async () => {
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
    // The newest project's folder went with a restart (a scratch project in /tmp).
    fs.rmSync(first.rootPath, { recursive: true, force: true });
    const syncRuntime = {
      enabled: true,
      hostStartupEnabled: true,
      hostDiscoveryEnabled: true,
      forceHostRole: false,
      runtimeKind: "daemon" as const,
    };

    const scopeRegistry = new ProjectScopeRegistry(registry, { syncRuntime });
    const skipped: string[] = [];
    const scope = await scopeRegistry.resolveActiveSyncHost((record) => skipped.push(record.projectId));

    expect(scope?.registryProjectId).toBe(second.projectId);
    expect(skipped).toEqual([first.projectId]);
    expect(createAdeRuntimeMock.mock.calls.map((call) => call[0]?.projectRoot)).toEqual([second.rootPath]);
    await scopeRegistry.disposeAll();

    // With every recent folder gone there is no project to host with: null, so
    // the caller hosts machine-level sync instead of retrying a missing folder.
    fs.rmSync(second.rootPath, { recursive: true, force: true });
    createAdeRuntimeMock.mockClear();
    const emptyRegistry = new ProjectScopeRegistry(registry, { syncRuntime });
    await expect(emptyRegistry.resolveActiveSyncHost()).resolves.toBeNull();
    expect(createAdeRuntimeMock).not.toHaveBeenCalled();
    await emptyRegistry.disposeAll();
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

  it("refuses a switch to a project that follows another machine before deactivating the current host", async () => {
    const { registry, first, second } = createRegistry();
    const blocker = {
      reason: "saved_connection" as const,
      host: "192.168.1.240",
      port: 8787,
    };
    const firstSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
      getHostBlocker: vi.fn(() => null),
    };
    const secondSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
      getHostBlocker: vi.fn(() => blocker),
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

    const failure = await scopeRegistry.switchSyncHost(second.projectId, {
      deactivatePreviousHost: true,
    }).catch((error: unknown) => error);

    // The caller gets a refusal naming the machine it would follow, and the
    // previous host keeps its lease: deactivation is checked but never run.
    expect(failure).toBeInstanceOf(SyncHostRoleBlockedError);
    expect(String((failure as Error).message)).toContain("192.168.1.240");
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
    expect(firstSyncService.setHostDiscoveryEnabled).not.toHaveBeenCalledWith(false);
    expect(firstSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(false);
    expect(secondSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(true);

    await expect(scopeRegistry.switchSyncHost(second.projectId, { purpose: "serve" }))
      .resolves.toMatchObject({ registryProjectId: second.projectId });
    expect(secondSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(true);
    await expect(scopeRegistry.switchSyncHost(second.projectId, { purpose: "serve" }))
      .resolves.toMatchObject({ registryProjectId: second.projectId });
    expect(secondSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(true);

    await scopeRegistry.disposeAll();
  });

  it("activates a switch to a project that does not follow another machine", async () => {
    const { registry, first, second } = createRegistry();
    const firstSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
      getHostBlocker: vi.fn(() => null),
    };
    const secondSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
      getHostBlocker: vi.fn(() => null),
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

    const switched = await scopeRegistry.switchSyncHost(second.projectId, {
      deactivatePreviousHost: true,
    });

    expect(switched?.registryProjectId).toBe(second.projectId);
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(second.projectId);
    expect(firstSyncService.setHostDiscoveryEnabled).toHaveBeenCalledWith(false);
    expect(firstSyncService.setHostStartupEnabled).toHaveBeenCalledWith(false);
    expect(secondSyncService.setHostStartupEnabled).toHaveBeenCalledWith(true);

    await scopeRegistry.disposeAll();
  });

  it("reports the blocker for a switch to a following project, without paying the activation drain", async () => {
    const { registry, first, second } = createRegistry();
    const firstSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
      getHostBlocker: vi.fn(() => null),
    };
    const secondSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
      getHostBlocker: vi.fn(() => ({ reason: "saved_connection" as const, host: "remote.invalid", port: 1 })),
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

    // The brain's startup loop is this caller: it asks for no host role, and
    // that is how a project following another machine used to reach the
    // activation drain. The drain dials that machine with no connect timeout,
    // so the attempt ran to the OS SYN timeout and was reported as the 10-second
    // activation budget instead of the reason. The switch must name the
    // blocker, and must not start the target's host to find that out.
    const failure = await scopeRegistry.switchSyncHost(second.projectId)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SyncHostRoleBlockedError);
    expect(String((failure as Error).message)).toContain("remote.invalid");
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
    expect(secondSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(true);
    expect(firstSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(false);

    await scopeRegistry.disposeAll();
  });

  it("serves a project that follows another machine to a reader, without starting a host for it", async () => {
    const { registry, second } = createRegistry();
    const viewerStatus = { role: "viewer", viewerReason: "saved_connection" };
    const secondSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
      getHostBlocker: vi.fn(() => ({
        reason: "saved_connection" as const,
        host: "192.168.1.240",
        port: 8787,
      })),
      getStatus: vi.fn(async () => viewerStatus),
    };
    createAdeRuntimeMock.mockResolvedValueOnce({
      dispose: vi.fn(),
      syncService: secondSyncService,
    });
    const scopeRegistry = new ProjectScopeRegistry(registry, {
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: true,
        hostDiscoveryEnabled: true,
        forceHostRole: false,
        runtimeKind: "daemon",
      },
    });
    const file = JSON.parse(fs.readFileSync(registry.path, "utf8")) as {
      projects: Array<{ projectId: string; lastOpenedAt: number; addedAt: number }>;
    };
    file.projects = file.projects.map((project) => ({
      ...project,
      lastOpenedAt: project.projectId === second.projectId ? 2_000 : 1_000,
      addedAt: project.projectId === second.projectId ? 2_000 : 1_000,
    }));
    fs.writeFileSync(registry.path, JSON.stringify(file, null, 2));

    // A cold `serve` lookup must be bounded too: the saved viewer peer may be
    // offline, and initialization is where the unbounded dial used to happen.
    const active = await scopeRegistry.resolveActiveSyncHost();

    expect(active?.registryProjectId).toBe(second.projectId);
    expect(await active?.runtime.syncService?.getStatus()).toEqual(viewerStatus);
    expect(secondSyncService.initialize).not.toHaveBeenCalled();
    // And no host is started for it: there is none here to start, and starting
    // one is what dials the other machine and blows the activation budget.
    expect(secondSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(true);

    await scopeRegistry.disposeAll();
  });

  it("keeps the current host hosting when a reader is served a project that follows another machine", async () => {
    const { registry, first, second } = createRegistry();
    const firstSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
      getHostBlocker: vi.fn(() => null),
    };
    const secondSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
      getHostBlocker: vi.fn(() => ({ reason: "saved_connection" as const, host: "remote.invalid", port: 1 })),
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

    // The brain's startup loop serves its preferred project this way while
    // another project hosts. A blocked reader is adopted read-only: the current
    // host keeps its lease and discovery, and the reader is not published over it.
    const served = await scopeRegistry.switchSyncHost(second.projectId, { purpose: "serve" });

    expect(served?.registryProjectId).toBe(second.projectId);
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
    expect(firstSyncService.setHostDiscoveryEnabled).not.toHaveBeenCalled();
    expect(firstSyncService.setHostStartupEnabled).not.toHaveBeenCalled();
    expect(secondSyncService.setHostStartupEnabled).not.toHaveBeenCalledWith(true);

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

describe("ProjectScopeRegistry stream release", () => {
  it("releases viewers on every booted project when a sync socket closes", async () => {
    createAdeRuntimeMock.mockReset();
    const { registry, first, second } = createRegistry();
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    let releaseSocket: ((connectionId: string) => void) | undefined;
    createAdeRuntimeMock.mockImplementation(async (args: {
      projectRoot: string;
      syncRuntime?: { remoteCommandExecutor?: { releaseStreamConnection?: (connectionId: string) => void } };
    }) => {
      releaseSocket = args.syncRuntime?.remoteCommandExecutor?.releaseStreamConnection;
      const releaseStreamConnection = vi.fn();
      releases.push(releaseStreamConnection);
      return {
        dispose: vi.fn(),
        syncService: { releaseStreamConnection },
        projectRoot: args.projectRoot,
      };
    });
    const scopeRegistry = new ProjectScopeRegistry(registry, {
      syncRuntime: { enabled: true },
    });

    await scopeRegistry.get(first.projectId);
    await scopeRegistry.get(second.projectId);
    expect(releaseSocket).toBeTypeOf("function");
    releaseSocket!("conn-9");
    await vi.waitFor(() => {
      expect(releases).toHaveLength(2);
      expect(releases[0]).toHaveBeenCalledWith("conn-9");
      expect(releases[1]).toHaveBeenCalledWith("conn-9");
    });

    await scopeRegistry.disposeAll();
  });
});

describe("ProjectScopeRegistry.adoptRequestedSyncHost", () => {
  beforeEach(() => {
    createAdeRuntimeMock.mockReset();
    createAdeRuntimeMock.mockImplementation(async () => ({ dispose: vi.fn() }));
  });

  /**
   * `get()` is stubbed throughout: opening a real scope boots a whole sync
   * runtime, and what is under test here is only the waiting policy.
   */
  const stubScopeFor = (scopes: ProjectScopeRegistry, projectId: string) => {
    const scope = { registryProjectId: projectId } as unknown as Awaited<
      ReturnType<ProjectScopeRegistry["get"]>
    >;
    vi.spyOn(scopes, "get").mockResolvedValue(scope);
    return scope;
  };

  it("adopts a sync host that lands while it is waiting", async () => {
    const { registry, first } = createRegistry();
    const scopes = new ProjectScopeRegistry(registry, { syncRuntime: { enabled: true } });
    stubScopeFor(scopes, first.projectId);
    let clock = 0;
    let elapsedWhenSet = -1;

    const adopted = await scopes.adoptRequestedSyncHost(30_000, {
      now: () => clock,
      pollMs: 250,
      sleep: () => {
        clock += 250;
        // A concurrent switch completes a second into our wait.
        if (clock >= 1_000 && elapsedWhenSet < 0) {
          elapsedWhenSet = clock;
          (scopes as unknown as { syncHostProjectId: string | null }).syncHostProjectId = first.projectId;
        }
        return Promise.resolve();
      },
    });

    expect(adopted?.registryProjectId).toBe(first.projectId);
    expect(elapsedWhenSet).toBe(1_000);
  });

  it("returns null when nothing lands inside the budget, so the caller retries", async () => {
    const { registry } = createRegistry();
    const scopes = new ProjectScopeRegistry(registry, { syncRuntime: { enabled: true } });
    let clock = 0;
    let polls = 0;

    const adopted = await scopes.adoptRequestedSyncHost(1_000, {
      now: () => clock,
      pollMs: 250,
      sleep: () => {
        polls += 1;
        clock += 250;
        return Promise.resolve();
      },
    });

    expect(adopted).toBeNull();
    expect(polls).toBe(4);
  });

  it("returns immediately when a host is already active", async () => {
    const { registry, first } = createRegistry();
    const scopes = new ProjectScopeRegistry(registry, { syncRuntime: { enabled: true } });
    stubScopeFor(scopes, first.projectId);
    (scopes as unknown as { syncHostProjectId: string | null }).syncHostProjectId = first.projectId;
    const sleep = vi.fn(() => Promise.resolve());

    const adopted = await scopes.adoptRequestedSyncHost(30_000, { sleep });

    expect(adopted?.registryProjectId).toBe(first.projectId);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not wait at all with a zero budget", async () => {
    const { registry } = createRegistry();
    const scopes = new ProjectScopeRegistry(registry, { syncRuntime: { enabled: true } });
    const sleep = vi.fn(() => Promise.resolve());

    expect(await scopes.adoptRequestedSyncHost(0, { sleep })).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
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

describe("ProjectScopeRegistry failed-boot backoff", () => {
  beforeEach(() => {
    createAdeRuntimeMock.mockReset();
  });

  it("serves the recorded failure instead of re-booting on every call", async () => {
    const { registry, first } = createRegistry();
    const clock = fakeClock();
    const bootFailure = Object.assign(new Error("ADE could not open the project data store."), {
      code: "storage_read_failed",
    });
    createAdeRuntimeMock.mockRejectedValue(bootFailure);
    const scopeRegistry = new ProjectScopeRegistry(registry, { now: clock.now });

    await expect(scopeRegistry.get(first.projectId)).rejects.toBe(bootFailure);
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(1);

    // Forty callers inside the backoff window cost no boots at all, and each
    // one still sees the coded error it knows how to handle.
    for (let call = 0; call < 40; call += 1) {
      clock.advance(20);
      await expect(scopeRegistry.get(first.projectId)).rejects.toBe(bootFailure);
    }
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("retries at the backoff cadence and lengthens it with each failure", async () => {
    const { registry, first } = createRegistry();
    const clock = fakeClock();
    createAdeRuntimeMock.mockRejectedValue(new Error("boot failed"));
    const scopeRegistry = new ProjectScopeRegistry(registry, { now: clock.now });

    await expect(scopeRegistry.get(first.projectId)).rejects.toThrow("boot failed");
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(1);

    // First window is 2s: 1.9s in, still cached; past 2s, one fresh boot.
    clock.advance(1_900);
    await expect(scopeRegistry.get(first.projectId)).rejects.toThrow("boot failed");
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(1);
    clock.advance(200);
    await expect(scopeRegistry.get(first.projectId)).rejects.toThrow("boot failed");
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(2);

    // Second failure doubles the window to 4s.
    clock.advance(3_900);
    await expect(scopeRegistry.get(first.projectId)).rejects.toThrow("boot failed");
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(2);
    clock.advance(200);
    await expect(scopeRegistry.get(first.projectId)).rejects.toThrow("boot failed");
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(3);
  });

  it("caps the backoff at thirty seconds", async () => {
    const { registry, first } = createRegistry();
    const clock = fakeClock();
    createAdeRuntimeMock.mockRejectedValue(new Error("boot failed"));
    const scopeRegistry = new ProjectScopeRegistry(registry, { now: clock.now });

    // Ten consecutive failures would be 2^10 seconds without the cap.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(scopeRegistry.get(first.projectId)).rejects.toThrow("boot failed");
      clock.advance(FAILED_SCOPE_BACKOFF_MAX_MS);
    }
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(10);
  });

  it("clears the backoff once a boot succeeds", async () => {
    const { registry, first } = createRegistry();
    const clock = fakeClock();
    createAdeRuntimeMock.mockRejectedValueOnce(new Error("boot failed"));
    createAdeRuntimeMock.mockImplementation(async () => ({ dispose: vi.fn() }));
    const scopeRegistry = new ProjectScopeRegistry(registry, { now: clock.now });

    await expect(scopeRegistry.get(first.projectId)).rejects.toThrow("boot failed");
    clock.advance(2_100);
    const scope = await scopeRegistry.get(first.projectId);
    expect(scope.registryProjectId).toBe(first.projectId);

    // A later failure starts from the short window again, not the long one.
    await scopeRegistry.dispose(first.projectId);
    createAdeRuntimeMock.mockRejectedValueOnce(new Error("boot failed again"));
    await expect(scopeRegistry.get(first.projectId)).rejects.toThrow("boot failed again");
    clock.advance(2_100);
    await scopeRegistry.get(first.projectId);
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(4);

    await scopeRegistry.disposeAll();
  });

  it("lets an explicit dispose force a fresh boot inside the backoff window", async () => {
    const { registry, first } = createRegistry();
    const clock = fakeClock();
    createAdeRuntimeMock.mockRejectedValueOnce(new Error("boot failed"));
    createAdeRuntimeMock.mockImplementation(async () => ({ dispose: vi.fn() }));
    const scopeRegistry = new ProjectScopeRegistry(registry, { now: clock.now });

    await expect(scopeRegistry.get(first.projectId)).rejects.toThrow("boot failed");

    // Repair path: dispose drops the backoff, so the very next call boots even
    // though no time has passed.
    await scopeRegistry.dispose(first.projectId);
    const scope = await scopeRegistry.get(first.projectId);

    expect(scope.registryProjectId).toBe(first.projectId);
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(2);

    await scopeRegistry.disposeAll();
  });

  it("does not let an abandoned boot's failure hold off a newer attempt", async () => {
    const { registry, first } = createRegistry();
    const clock = fakeClock();
    const abandoned = deferred<{ dispose: () => void }>();
    createAdeRuntimeMock.mockImplementationOnce(async () => await abandoned.promise);
    const scopeRegistry = new ProjectScopeRegistry(registry, { now: clock.now });

    const abandonedGet = scopeRegistry.get(first.projectId);
    // The cold-boot timeout path evicts the in-flight boot before it settles.
    const disposing = scopeRegistry.dispose(first.projectId);
    abandoned.reject(new Error("abandoned boot failed"));
    await expect(abandonedGet).rejects.toThrow("abandoned boot failed");
    await disposing;

    createAdeRuntimeMock.mockImplementation(async () => ({ dispose: vi.fn() }));
    const scope = await scopeRegistry.get(first.projectId);

    expect(scope.registryProjectId).toBe(first.projectId);

    await scopeRegistry.disposeAll();
  });
});

describe("ProjectScopeRegistry sync-host phase backoff", () => {
  beforeEach(() => {
    createAdeRuntimeMock.mockReset();
  });

  /**
   * A scope whose activation always fails, counting the attempts. Activation is
   * the phase that does the real work — and pays the ten-second budget — for
   * every caller that asks this project to host sync.
   */
  function createActivationProbe() {
    const counts = { activated: 0, deactivated: 0 };
    // Carries a `code`, the way a storage fault does: the phase wrapper has to
    // rethrow this very object, because the startup loop classifies a fault by
    // reading `code`/`errno` off the error it is handed.
    const failure = Object.assign(new Error("target activation failed"), { code: "EIO" });
    let failActivation = true;
    const syncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async (enabled: boolean) => {
        if (!enabled) {
          counts.deactivated += 1;
          return;
        }
        counts.activated += 1;
        if (failActivation) throw failure;
      }),
    };
    return {
      counts,
      failure,
      syncService,
      failActivation: (value: boolean) => {
        failActivation = value;
      },
    };
  }

  /** A registry wired for sync hosting, on a clock the test controls. */
  function createSyncHostRegistry(clock: { now: () => number }) {
    const { registry, first, second } = createRegistry();
    const scopeRegistry = new ProjectScopeRegistry(registry, {
      now: clock.now,
      syncRuntime: {
        enabled: true,
        hostStartupEnabled: true,
        hostDiscoveryEnabled: true,
        forceHostRole: false,
        runtimeKind: "daemon",
      },
    });
    return { scopeRegistry, first, second };
  }

  it("serves a failed activation instead of re-running it for every caller", async () => {
    const clock = fakeClock();
    const probe = createActivationProbe();
    createAdeRuntimeMock.mockResolvedValue({ dispose: vi.fn(), syncService: probe.syncService });
    const { scopeRegistry, first } = createSyncHostRegistry(clock);

    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toBe(probe.failure);
    expect(probe.counts.activated).toBe(1);
    expect(scopeRegistry.getMostRecentFailingSyncHostProjectId()).toBe(first.projectId);
    const booted = await scopeRegistry.resolveBootedSyncScope();
    expect(booted?.registryProjectId).toBe(first.projectId);
    expect(probe.counts.activated).toBe(1);

    // The shape of the 2026-10-16 storm: forty callers inside the backoff
    // window — the roster, lane list and phone-status pollers all reach
    // activation — must cost one activation, not forty, and every one of them
    // still gets the real failure, code and all, so the startup loop can still
    // classify it.
    for (let call = 0; call < 40; call += 1) {
      clock.advance(20);
      await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toBe(probe.failure);
    }
    expect(probe.counts.activated).toBe(1);
    // A replayed activation did no work, so it also did not need the rollback
    // that would have paid the same timeout a second time.
    expect(probe.counts.deactivated).toBe(1);

    // Past the window the real activation runs again, so sync still recovers.
    clock.advance(FAILED_SCOPE_BACKOFF_MAX_MS);
    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toThrow("target activation failed");
    expect(probe.counts.activated).toBe(2);

    await scopeRegistry.disposeAll();
  });

  it("serves a failed initialization from the backoff and keeps the booted scope", async () => {
    const clock = fakeClock();
    const initializeFailure = Object.assign(new Error("initialization failed"), { code: "EIO" });
    const syncService = {
      initialize: vi.fn(async () => {
        throw initializeFailure;
      }),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    createAdeRuntimeMock.mockResolvedValue({ dispose: vi.fn(), syncService });
    const { scopeRegistry, first } = createSyncHostRegistry(clock);

    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toBe(initializeFailure);
    expect(syncService.initialize).toHaveBeenCalledTimes(1);
    // The scope booted, so this switch failed on a live scope rather than a cold
    // one — which is the shape `initialization` earns its place in the backoff
    // set for. It awaits the same role-refresh drain `activation` does, so a
    // room full of pollers re-runs it the same way.
    expect(scopeRegistry.getIfBooted(first.projectId)).not.toBeNull();

    // A caller inside the window is served the recorded failure, code and all,
    // without paying for another `initialize`.
    clock.advance(20);
    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toBe(initializeFailure);
    expect(syncService.initialize).toHaveBeenCalledTimes(1);

    // A replay refuses the switch before `initialize` runs, and it is not a
    // phase timeout, so the scope this project just booted is kept rather than
    // abandoned: the next real attempt reuses it instead of booting a second
    // runtime.
    expect(scopeRegistry.getIfBooted(first.projectId)).not.toBeNull();
    clock.advance(FAILED_SCOPE_BACKOFF_MAX_MS);
    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toBe(initializeFailure);
    expect(syncService.initialize).toHaveBeenCalledTimes(2);
    expect(createAdeRuntimeMock).toHaveBeenCalledTimes(1);

    await scopeRegistry.disposeAll();
  });

  it("lets a deliberate start re-run an activation the backoff is still holding", async () => {
    const clock = fakeClock();
    const probe = createActivationProbe();
    createAdeRuntimeMock.mockResolvedValue({ dispose: vi.fn(), syncService: probe.syncService });
    const { scopeRegistry, first } = createSyncHostRegistry(clock);

    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toThrow("target activation failed");
    expect(probe.counts.activated).toBe(1);

    // "Fix connection", "Start sync" and "Reconnect this computer" all ask for
    // a real attempt through `startSyncHostOnce`, which calls exactly this.
    // None of them may be answered with the recorded failure.
    scopeRegistry.clearSyncHostPhaseBackoff();
    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toThrow("target activation failed");
    expect(probe.counts.activated).toBe(2);

    await scopeRegistry.disposeAll();
  });

  it("leaves the previous host alone while the target's activation is backed off", async () => {
    const clock = fakeClock();
    const probe = createActivationProbe();
    const firstSyncService = {
      initialize: vi.fn(async () => undefined),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    createAdeRuntimeMock
      .mockResolvedValueOnce({ dispose: vi.fn(), syncService: firstSyncService })
      .mockResolvedValue({ dispose: vi.fn(), syncService: probe.syncService });
    const { scopeRegistry, first, second } = createSyncHostRegistry(clock);

    await scopeRegistry.ensureSyncHost(first.projectId);
    await expect(scopeRegistry.ensureSyncHost(second.projectId)).rejects.toThrow("target activation failed");
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);
    firstSyncService.setHostStartupEnabled.mockClear();

    // Inside the backoff window the target cannot take over, so the replay must
    // cost nothing and change nothing: the previous host is never deactivated
    // for a switch that cannot land, so there is nothing to put back and no
    // window where this machine hosts nothing.
    await expect(scopeRegistry.ensureSyncHost(second.projectId)).rejects.toThrow("target activation failed");

    expect(firstSyncService.setHostStartupEnabled).not.toHaveBeenCalled();
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);

    await scopeRegistry.disposeAll();
  });

  it("reports a superseded initialization as superseded, not as a failure", async () => {
    const clock = fakeClock();
    const initializeEntered = deferred<void>();
    const stalledInitialize = deferred<void>();
    const { scopeRegistry, first, second } = createSyncHostRegistry(clock);
    const stalledSyncService = {
      initialize: vi.fn(async () => {
        initializeEntered.resolve();
        await stalledInitialize.promise;
      }),
      setHostDiscoveryEnabled: vi.fn(),
      setHostStartupEnabled: vi.fn(async () => undefined),
    };
    const probe = createActivationProbe();
    createAdeRuntimeMock.mockImplementation(async ({ projectRoot }: { projectRoot: string }) => ({
      dispose: vi.fn(),
      syncService: projectRoot === first.rootPath ? stalledSyncService : probe.syncService,
    }));

    // The first switch parks inside `initialize`; a second switch for another
    // project supersedes it while it waits, then that initialization fails. A
    // caller reads null as "superseded, adopt the winner" and a rejection as
    // "the switch failed", so a superseded switch has to answer null even when
    // the phase it was waiting on is the thing that failed.
    const supersededSwitch = scopeRegistry.switchSyncHost(first.projectId);
    await initializeEntered.promise;
    const winnerSwitch = scopeRegistry.switchSyncHost(second.projectId);
    stalledInitialize.reject(new Error("initialization failed"));

    await expect(supersededSwitch).resolves.toBeNull();
    await winnerSwitch.catch(() => null);

    await scopeRegistry.disposeAll();
  });

  it("starts the backoff window over after an activation succeeds", async () => {
    const clock = fakeClock();
    const probe = createActivationProbe();
    createAdeRuntimeMock.mockResolvedValue({ dispose: vi.fn(), syncService: probe.syncService });
    const { scopeRegistry, first } = createSyncHostRegistry(clock);

    // Two real failures, so the window has already doubled past its first step.
    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toThrow("target activation failed");
    clock.advance(2_100);
    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toThrow("target activation failed");
    expect(probe.counts.activated).toBe(2);

    clock.advance(4_100);
    probe.failActivation(false);
    await scopeRegistry.ensureSyncHost(first.projectId);
    expect(scopeRegistry.getActiveSyncHostProjectId()).toBe(first.projectId);

    // A success clears what this project's failures earned, so the next failure
    // waits the first two-second window again: at 2.1s it is a real attempt.
    probe.failActivation(true);
    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toThrow("target activation failed");
    expect(probe.counts.activated).toBe(4);
    clock.advance(2_100);
    await expect(scopeRegistry.ensureSyncHost(first.projectId)).rejects.toThrow("target activation failed");
    expect(probe.counts.activated).toBe(5);

    await scopeRegistry.disposeAll();
  });
});
