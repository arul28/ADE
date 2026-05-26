import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  statSync: vi.fn(),
  realpathSync: vi.fn(),
  resolvePathWithinRoot: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    statSync: mocks.statSync,
    realpathSync: mocks.realpathSync,
  },
  statSync: mocks.statSync,
  realpathSync: mocks.realpathSync,
}));

vi.mock("../shared/utils", () => ({
  resolvePathWithinRoot: mocks.resolvePathWithinRoot,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import {
  invalidateVmLaneLaunchCache,
  refreshVmLaneLaunchCache,
  resolveLaneLaunchContext,
  setMacosVmLaunchProvider,
  syncMacosVmLaunchCacheFromEvent,
  VmNotReadyError,
  type MacosVmLaunchProvider,
} from "./laneLaunchContext";
import type { MacosVmStatus } from "../../../shared/types/macosVm";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLaneService(worktreePath: string, runtimePlacement: "local" | "macos-vm" = "local") {
  return {
    getLaneBaseAndBranch: vi.fn(() => ({
      baseRef: "main",
      branchRef: "feature/test",
      worktreePath,
      laneType: "standard" as const,
      runtimePlacement,
    })),
  } as unknown as Parameters<typeof resolveLaneLaunchContext>[0]["laneService"];
}

function setupDirectoryExists(realPath: string) {
  mocks.statSync.mockReturnValue({ isDirectory: () => true });
  mocks.realpathSync.mockReturnValue(realPath);
}

function makeVmStatus(args: {
  laneId: string;
  readinessState?: string;
  ipAddress?: string | null;
  vmName?: string;
  phase?: number | null;
}): MacosVmStatus {
  const vmRecord = {
    id: "vm-1",
    provider: "lume" as const,
    name: args.vmName ?? "ade-vm",
    laneId: args.laneId,
    laneName: "lane",
    laneRoot: "/lane",
    state: "running" as const,
    cpuCores: 4,
    memory: "8gb",
    diskSize: "64gb",
    display: "1920x1080",
    guestSharedPath: "/Volumes/My Shared Files",
    sharedDirectory: "/lane",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastStartedAt: null,
    lastStoppedAt: null,
    ipAddress: args.ipAddress ?? "192.168.64.11",
    sshCommand: null,
    vncUrl: null,
    lastError: null,
    guestReadiness: {
      state: (args.readinessState ?? "runtime_ready") as "runtime_ready",
      canControlGui: true,
      canRunCode: true,
      sshAvailable: true,
      setupAssistantLikely: false,
      detail: "",
      nextAction: "",
    },
    currentPhase: (args.phase ?? 10) as 10,
    metadata: {},
  };
  return {
    platform: "darwin" as const,
    arch: "arm64",
    supported: true,
    checkedAt: "2026-01-01T00:00:00.000Z",
    activeProvider: { kind: "lume", available: true, version: "1.0", detail: "", docsUrl: "" },
    tools: [],
    laneVm: vmRecord,
    vms: [vmRecord],
    globalLease: null,
    docs: { appleVirtualization: "", appleSharedDirectories: "", lume: "" },
  };
}

function makeVmProvider(args: {
  status: MacosVmStatus;
  username?: string | null;
  hasPassword?: boolean;
}): MacosVmLaunchProvider {
  return {
    getStatus: vi.fn(async () => args.status),
    getCredentials: vi.fn(async () => ({
      vmName: args.status.vms[0]?.name ?? "ade-vm",
      username: args.username !== undefined ? args.username : "ade",
      hasPassword: args.hasPassword !== undefined ? args.hasPassword : true,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveLaneLaunchContext", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateVmLaneLaunchCache();
    setMacosVmLaunchProvider(null);
  });

  afterEach(() => {
    invalidateVmLaneLaunchCache();
    setMacosVmLaunchProvider(null);
  });

  describe("happy path: no custom cwd", () => {
    it("returns lane root as both laneWorktreePath and cwd with local execStrategy", () => {
      setupDirectoryExists("/real/lane/root");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/lane/root",
        execStrategy: "local",
      });
    });

    it("treats null requestedCwd the same as no cwd", () => {
      setupDirectoryExists("/real/lane/root");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        requestedCwd: null,
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/lane/root",
        execStrategy: "local",
      });
    });

    it("treats empty-string requestedCwd the same as no cwd", () => {
      setupDirectoryExists("/real/lane/root");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        requestedCwd: "  ",
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/lane/root",
        execStrategy: "local",
      });
    });
  });

  describe("happy path: valid relative cwd inside worktree", () => {
    it("resolves relative cwd within lane root", () => {
      mocks.statSync.mockReturnValue({ isDirectory: () => true });
      mocks.realpathSync
        .mockReturnValueOnce("/real/lane/root")       // first ensureDirectoryExists (lane root)
        .mockReturnValueOnce("/real/lane/root/src");   // second ensureDirectoryExists (cwd)
      mocks.resolvePathWithinRoot.mockReturnValue("/real/lane/root/src");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        requestedCwd: "src",
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/lane/root/src",
        execStrategy: "local",
      });
      expect(mocks.resolvePathWithinRoot).toHaveBeenCalledOnce();
    });
  });

  describe("happy path: valid absolute cwd inside worktree", () => {
    it("resolves absolute cwd within lane root", () => {
      mocks.statSync.mockReturnValue({ isDirectory: () => true });
      mocks.realpathSync
        .mockReturnValueOnce("/real/lane/root")
        .mockReturnValueOnce("/real/lane/root/packages/core");
      mocks.resolvePathWithinRoot.mockReturnValue("/real/lane/root/packages/core");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        requestedCwd: "/real/lane/root/packages/core",
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/lane/root/packages/core",
        execStrategy: "local",
      });
      expect(mocks.resolvePathWithinRoot).toHaveBeenCalledWith(
        "/real/lane/root",
        "/real/lane/root/packages/core",
      );
    });
  });

  describe("happy path: explicit absolute cwd outside worktree", () => {
    it("allows an external absolute cwd when the caller opts in", () => {
      mocks.statSync.mockReturnValue({ isDirectory: () => true });
      mocks.realpathSync
        .mockReturnValueOnce("/real/lane/root")
        .mockReturnValueOnce("/real/project/root");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        requestedCwd: "/real/project/root",
        allowExternalCwd: true,
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/project/root",
        execStrategy: "local",
      });
      expect(mocks.resolvePathWithinRoot).not.toHaveBeenCalled();
    });
  });

  describe("error: lane has no worktree configured", () => {
    it("throws when worktreePath is empty string", () => {
      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService(""),
          laneId: "lane-orphan",
          purpose: "launch terminal",
        }),
      ).toThrow("Lane 'lane-orphan' has no worktree configured");
    });

    it("throws when worktreePath is whitespace-only", () => {
      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("   "),
          laneId: "lane-ws",
          purpose: "launch terminal",
        }),
      ).toThrow("Lane 'lane-ws' has no worktree configured");
    });

    it("includes the purpose in the error message", () => {
      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService(""),
          laneId: "lane-1",
          purpose: "run tests",
        }),
      ).toThrow("ADE cannot run tests outside the selected lane");
    });
  });

  describe("error: lane worktree directory doesn't exist", () => {
    it("throws when statSync fails (directory missing)", () => {
      mocks.statSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/gone/lane"),
          laneId: "lane-gone",
          purpose: "deploy",
        }),
      ).toThrow("worktree is unavailable");
    });

    it("throws when path is not a directory", () => {
      mocks.statSync.mockReturnValue({ isDirectory: () => false });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/some/file.txt"),
          laneId: "lane-file",
          purpose: "build",
        }),
      ).toThrow("worktree is unavailable");
    });

    it("throws when realpathSync fails after stat succeeds", () => {
      mocks.statSync.mockReturnValue({ isDirectory: () => true });
      mocks.realpathSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/broken/symlink"),
          laneId: "lane-broken",
          purpose: "launch agent",
        }),
      ).toThrow("worktree is unavailable");
    });
  });

  describe("error: requested cwd escapes lane root (path traversal)", () => {
    it("throws with descriptive message when resolvePathWithinRoot detects traversal", () => {
      setupDirectoryExists("/real/lane/root");
      mocks.resolvePathWithinRoot.mockImplementation(() => {
        throw new Error("Path escapes root");
      });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane"),
          laneId: "lane-1",
          requestedCwd: "../../etc/passwd",
          purpose: "start agent",
        }),
      ).toThrow("escapes lane 'lane-1'");
    });

    it("re-throws non-traversal errors from resolvePathWithinRoot", () => {
      setupDirectoryExists("/real/lane/root");
      mocks.resolvePathWithinRoot.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane"),
          laneId: "lane-1",
          requestedCwd: "src",
          purpose: "start agent",
        }),
      ).toThrow("Permission denied");
    });
  });

  describe("error: requested cwd doesn't exist inside worktree", () => {
    it("throws when cwd directory does not exist after path validation", () => {
      setupDirectoryExists("/real/lane/root");
      mocks.resolvePathWithinRoot.mockReturnValue("/real/lane/root/nonexistent");

      let callCount = 0;
      mocks.statSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return { isDirectory: () => true };
        }
        throw new Error("ENOENT");
      });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane"),
          laneId: "lane-1",
          requestedCwd: "nonexistent",
          purpose: "start agent",
        }),
      ).toThrow("is not an existing directory inside lane");
    });
  });

  describe("edge cases", () => {
    it("trims laneId whitespace", () => {
      setupDirectoryExists("/real/lane/root");

      const laneService = makeLaneService("/projects/my-lane");
      resolveLaneLaunchContext({
        laneService,
        laneId: "  lane-1  ",
        purpose: "test",
      });

      expect(laneService.getLaneBaseAndBranch).toHaveBeenCalledWith("lane-1");
    });

    it("uses 'launch work' as default purpose when purpose is empty", () => {
      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService(""),
          laneId: "lane-1",
          purpose: "",
        }),
      ).toThrow("ADE cannot launch work outside the selected lane");
    });
  });

  describe("VM lanes", () => {
    it("returns SSH context when VM is runtime_ready and credentials are saved", async () => {
      setupDirectoryExists("/real/lane/root");
      const provider = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-vm" }),
      });
      setMacosVmLaunchProvider(provider);
      const cache = await refreshVmLaneLaunchCache({ laneId: "lane-vm", provider });
      expect(cache.kind).toBe("ready");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane", "macos-vm"),
        laneId: "lane-vm",
        purpose: "start agent",
      });

      expect(result.execStrategy).toBe("ssh");
      expect(result.cwd).toBe("/Volumes/My Shared Files");
      expect(result.sshTarget).toEqual({ ip: "192.168.64.11", username: "ade", vmName: "ade-vm" });
    });

    it("keeps ready VM launch cache entries scoped by project root", async () => {
      setupDirectoryExists("/real/lane/root");
      const providerA = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-vm", ipAddress: "192.168.64.11", vmName: "ade-a" }),
      });
      const providerB = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-vm", ipAddress: "192.168.64.22", vmName: "ade-b" }),
      });
      setMacosVmLaunchProvider(providerA);
      await refreshVmLaneLaunchCache({ laneId: "lane-vm", projectRoot: "/projects/a", provider: providerA });
      await refreshVmLaneLaunchCache({ laneId: "lane-vm", projectRoot: "/projects/b", provider: providerB });

      const resultA = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane", "macos-vm"),
        laneId: "lane-vm",
        projectRoot: "/projects/a",
        purpose: "start agent",
      });
      const resultB = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane", "macos-vm"),
        laneId: "lane-vm",
        projectRoot: "/projects/b",
        purpose: "start agent",
      });

      expect(resultA.sshTarget).toEqual({ ip: "192.168.64.11", username: "ade", vmName: "ade-a" });
      expect(resultB.sshTarget).toEqual({ ip: "192.168.64.22", username: "ade", vmName: "ade-b" });
    });

    it("does not reuse a ready VM record from another lane", async () => {
      const status = makeVmStatus({ laneId: "lane-other", ipAddress: "192.168.64.44" });
      status.laneVm = null;
      const provider = makeVmProvider({ status });
      setMacosVmLaunchProvider(provider);
      const cache = await refreshVmLaneLaunchCache({ laneId: "lane-vm", provider });
      expect(cache.kind).toBe("not-ready");

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane", "macos-vm"),
          laneId: "lane-vm",
          purpose: "start agent",
        }),
      ).toThrow(VmNotReadyError);
    });

    it("throws VmNotReadyError with phase when VM is still in setup_required", async () => {
      const provider = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-vm", readinessState: "setup_required", phase: 6 }),
      });
      setMacosVmLaunchProvider(provider);
      await refreshVmLaneLaunchCache({ laneId: "lane-vm", provider });

      let caught: unknown = null;
      try {
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane", "macos-vm"),
          laneId: "lane-vm",
          purpose: "start agent",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(VmNotReadyError);
      const err = caught as VmNotReadyError;
      expect(err.code).toBe("macos-vm-not-ready");
      expect(err.phase).toBe(6);
      expect(err.readinessState).toBe("setup_required");
    });

    it("throws VmNotReadyError when credentials are missing", async () => {
      const provider = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-vm" }),
        hasPassword: false,
      });
      setMacosVmLaunchProvider(provider);
      await refreshVmLaneLaunchCache({ laneId: "lane-vm", provider });

      let caught: unknown = null;
      try {
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane", "macos-vm"),
          laneId: "lane-vm",
          purpose: "start agent",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(VmNotReadyError);
    });

    it("throws VmNotReadyError when provider is uninitialized", () => {
      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane", "macos-vm"),
          laneId: "lane-vm",
          purpose: "start agent",
        }),
      ).toThrow(VmNotReadyError);
    });

    it("local launch context is returned unchanged for non-VM lanes even when a VM provider is installed", async () => {
      setupDirectoryExists("/real/lane/root");
      const provider = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-other" }),
      });
      setMacosVmLaunchProvider(provider);

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane", "local"),
        laneId: "lane-local",
        purpose: "start agent",
      });

      expect(result.execStrategy).toBe("local");
      expect(result.sshTarget).toBeUndefined();
    });

    it("detached lane (now local) gets local context — no SSH routing", async () => {
      // Simulate a lane that was previously macos-vm but has been detached and
      // is now `local`. The launch context must reflect the new placement.
      setupDirectoryExists("/real/lane/root");
      const provider = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-detached" }),
      });
      setMacosVmLaunchProvider(provider);
      await refreshVmLaneLaunchCache({ laneId: "lane-detached", provider });
      // Caller invalidates the cache after a detach.
      invalidateVmLaneLaunchCache("lane-detached");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane", "local"),
        laneId: "lane-detached",
        purpose: "start agent",
      });

      expect(result.execStrategy).toBe("local");
      expect(result.sshTarget).toBeUndefined();
      expect(result.cwd).toBe("/real/lane/root");
    });
  });

  describe("syncMacosVmLaunchCacheFromEvent", () => {
    it("refreshes cache after vm-updated with a new IP", async () => {
      const provider = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-vm", ipAddress: "192.168.64.11" }),
      });
      setMacosVmLaunchProvider(provider);
      await refreshVmLaneLaunchCache({ laneId: "lane-vm", provider });

      const updatedStatus = makeVmStatus({ laneId: "lane-vm", ipAddress: "192.168.64.22" });
      provider.getStatus = vi.fn(async () => updatedStatus);
      syncMacosVmLaunchCacheFromEvent({
        type: "vm-updated",
        vm: updatedStatus.laneVm!,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane", "macos-vm"),
        laneId: "lane-vm",
        purpose: "start agent",
      });
      expect(result.sshTarget?.ip).toBe("192.168.64.22");
    });

    it("ignores unrelated macos VM operation events", async () => {
      const provider = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-vm", ipAddress: "192.168.64.11" }),
      });
      setMacosVmLaunchProvider(provider);
      await refreshVmLaneLaunchCache({ laneId: "lane-vm", provider });
      provider.getStatus = vi.fn(async () => {
        throw new Error("should not refresh");
      });

      syncMacosVmLaunchCacheFromEvent({
        type: "operation",
        operation: "screenshot",
        state: "completed",
        laneId: "lane-vm",
        vmName: "ade-vm",
        message: "done",
        occurredAt: new Date().toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane", "macos-vm"),
        laneId: "lane-vm",
        purpose: "start agent",
      });
      expect(result.sshTarget?.ip).toBe("192.168.64.11");
    });

    it("invalidates cached SSH target when a disruptive VM operation starts", async () => {
      const provider = makeVmProvider({
        status: makeVmStatus({ laneId: "lane-vm", ipAddress: "192.168.64.11" }),
      });
      setMacosVmLaunchProvider(provider);
      await refreshVmLaneLaunchCache({ laneId: "lane-vm", provider });

      syncMacosVmLaunchCacheFromEvent({
        type: "operation",
        operation: "restart",
        state: "started",
        laneId: "lane-vm",
        vmName: "ade-vm",
        message: "restarting",
        occurredAt: new Date().toISOString(),
      });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane", "macos-vm"),
          laneId: "lane-vm",
          purpose: "start agent",
        }),
      ).toThrow(VmNotReadyError);
    });
  });
});
