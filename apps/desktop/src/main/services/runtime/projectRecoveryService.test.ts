import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoJargon } from "../../../test/jargonGuard";
import type { AdeLastFailureReport, AdeRecoveryErrorCode } from "../../../shared/types/recovery";
import type { Logger } from "../logging/logger";
import {
  createProjectRecoveryService,
  type ProjectRecoveryConnectionPool,
  type ProjectRecoveryServiceDeps,
} from "./projectRecoveryService";

const GIB = 1024 * 1024 * 1024;
const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-recovery-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".ade"), { recursive: true });
  return root;
}

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function status(overrides: Partial<ReturnType<ProjectRecoveryConnectionPool["getStatus"]>> = {}) {
  return {
    connectionState: "idle" as const,
    runtimeMode: "primary" as const,
    versionSkew: {
      state: "none" as const,
      appVersion: null,
      runtimeVersion: null,
      message: null,
      updatedAt: null,
    },
    serviceInstall: {
      state: "not_attempted" as const,
      attempted: false,
      path: null,
      message: null,
      exitCode: null,
      updatedAt: null,
    },
    serviceHealth: {
      state: "unknown" as const,
      installed: null,
      running: null,
      path: null,
      message: null,
      checkedAt: null,
    },
    ...overrides,
  };
}

function pool(statusValue = status()): ProjectRecoveryConnectionPool {
  return {
    getStatus: vi.fn(() => statusValue),
    installServiceBestEffort: vi.fn(async () => {}),
    callSync: vi.fn(async () => ({ pong: true })) as unknown as ProjectRecoveryConnectionPool["callSync"],
    ensureProject: vi.fn(async () => ({ projectId: "project-1" } as any)),
    callActionForRoot: vi.fn(async () => ({ result: [] } as any)),
  };
}

function failure(code: AdeRecoveryErrorCode, count = 1): AdeLastFailureReport {
  return {
    version: 1,
    code,
    message: `recorded ${code}`,
    at: "2026-07-12T12:00:00.000Z",
    component: "brain_startup",
    count,
    firstAt: "2026-07-12T11:59:00.000Z",
  };
}

function deps(overrides: Partial<ProjectRecoveryServiceDeps> = {}): ProjectRecoveryServiceDeps {
  const root = tempRoot();
  return {
    adeHome: root,
    logger: logger(),
    connectionPool: pool(),
    socketPath: path.join(root, "ade.sock"),
    statfs: vi.fn(async () => ({ bavail: 8 * GIB, bsize: 1 })),
    databaseSize: vi.fn(async () => 64 * 1024 * 1024),
    probeSocket: vi.fn(async () => false),
    pingEndpoint: vi.fn(async () => false),
    waitForSocketState: vi.fn(async (_socketPath, reachable) => reachable),
    quickCheck: vi.fn(async () => ({ healthy: true, detail: "ok" })),
    openDatabase: vi.fn(async () => ({ close: vi.fn() } as any)),
    readFailureReports: vi.fn(async () => ({ project: null, machine: null })),
    clearFailureReports: vi.fn(async () => {}),
    socketExists: vi.fn(() => false),
    now: () => Date.parse("2026-07-12T12:01:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ProjectRecoveryService.diagnose", () => {
  it.each([
    {
      name: "healthy",
      expected: "healthy",
      canAutoRepair: false,
      overrides: { probeSocket: vi.fn(async () => true), pingEndpoint: vi.fn(async () => true) },
    },
    {
      name: "disk full",
      expected: "disk_full",
      canAutoRepair: true,
      overrides: { statfs: vi.fn(async () => ({ bavail: GIB / 2, bsize: 1 })) },
    },
    {
      name: "insufficient headroom",
      expected: "insufficient_headroom",
      canAutoRepair: true,
      overrides: { readFailureReports: vi.fn(async () => ({ project: failure("insufficient_headroom"), machine: null })) },
    },
    {
      name: "database repair",
      expected: "db_repair_needed",
      canAutoRepair: true,
      overrides: { quickCheck: vi.fn(async () => ({ healthy: false, detail: "malformed" })) },
    },
    {
      name: "crash loop",
      expected: "brain_crash_looping",
      canAutoRepair: true,
      overrides: { readFailureReports: vi.fn(async () => ({ project: failure("brain_crash_looping", 3), machine: null })) },
    },
    {
      name: "not installed",
      expected: "brain_not_installed",
      canAutoRepair: true,
      overrides: {
        connectionPool: pool(status({
          serviceHealth: { state: "not_installed", installed: false, running: false, path: null, message: null, checkedAt: null },
        })),
      },
    },
    {
      name: "stale endpoint",
      expected: "socket_stale_no_owner",
      canAutoRepair: true,
      overrides: { socketExists: vi.fn(() => true) },
    },
    {
      name: "other owner",
      expected: "socket_owned_by_other",
      canAutoRepair: false,
      overrides: { probeSocket: vi.fn(async () => true), pingEndpoint: vi.fn(async () => false) },
    },
    {
      name: "unknown",
      expected: "unknown_failure",
      canAutoRepair: true,
      overrides: {},
    },
  ])("maps $name to plain-language diagnosis", async ({ expected, canAutoRepair, overrides }) => {
    const service = createProjectRecoveryService(deps(overrides));
    const diagnosis = await service.diagnose(tempRoot());

    expect(diagnosis.state).toBe(expected);
    expect(diagnosis.canAutoRepair).toBe(canAutoRepair);
    expectNoJargon(`${diagnosis.headline} ${diagnosis.body}`);
  });
});

describe("ProjectRecoveryService.repair", () => {
  it("runs every step in order, clears failure reports, and counts fixture chats", async () => {
    const projectRoot = tempRoot();
    const sessionsDir = path.join(projectRoot, ".ade", "cache", "chat-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(sessionsDir, `session-${index}.json`), JSON.stringify({
        id: `session-${index}`,
        ...(index < 2 ? { continuityRecovery: { state: "required" } } : {}),
      }));
    }
    const clearFailureReports = vi.fn(async () => {});
    const service = createProjectRecoveryService(deps({ clearFailureReports }));
    const onStep = vi.fn();

    const report = await service.repair(projectRoot, { onStep });

    expect(report).toMatchObject({
      ok: true,
      dbHealthy: true,
      chatsTotal: 5,
      chatsNeedingAttention: 2,
      filesRemoved: 0,
    });
    expect(report.steps.map((step) => step.id)).toEqual([
      "check_space",
      "stop_service",
      "validate_database",
      "resolve_migrations",
      "restart_service",
      "verify_endpoint",
      "verify_project_rpc",
      "reconcile_chats",
    ]);
    expect(report.steps.every((step) => step.status === "ok")).toBe(true);
    expect(onStep).toHaveBeenCalledTimes(8);
    expect(clearFailureReports).toHaveBeenCalledWith(projectRoot);
  });

  it("stops at storage when there is too little free space", async () => {
    const openDatabase = vi.fn(async () => ({ close: vi.fn() } as any));
    const service = createProjectRecoveryService(deps({
      statfs: vi.fn(async () => ({ bavail: 8 * 1024 * 1024, bsize: 1 })),
      openDatabase,
    }));

    const report = await service.repair(tempRoot());

    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({ id: "check_space", status: "failed" });
    expect(report.steps.slice(1).every((step) => step.status === "skipped")).toBe(true);
    expect(report.nextAction).toMatch(/\d+ GB/);
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("does not touch the database when exclusive ownership cannot be verified", async () => {
    const openDatabase = vi.fn(async () => ({ close: vi.fn() } as any));
    const service = createProjectRecoveryService(deps({
      probeSocket: vi.fn(async () => true),
      pingEndpoint: vi.fn(async () => true),
      waitForSocketState: vi.fn(async () => false),
      openDatabase,
    }));

    const report = await service.repair(tempRoot());

    expect(report.steps[1]).toMatchObject({ id: "stop_service", status: "failed" });
    expect(report.failureCode).toBe("socket_owned_by_other");
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("surfaces classified migration failures and skips later steps", async () => {
    const migrationError = Object.assign(new Error("unrecognized interrupted save"), {
      code: "migration_unknown_state",
    });
    const service = createProjectRecoveryService(deps({
      openDatabase: vi.fn(async () => { throw migrationError; }),
    }));

    const report = await service.repair(tempRoot());

    expect(report.failureCode).toBe("migration_unknown_state");
    expect(report.steps[3]).toMatchObject({ id: "resolve_migrations", status: "failed" });
    expect(report.steps.slice(4).every((step) => step.status === "skipped")).toBe(true);
    expect(report.nextAction).toContain("nothing has been deleted");
  });
});
