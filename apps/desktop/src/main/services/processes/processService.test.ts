import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createProcessService } from "./processService";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function makeMinimalConfig(processes: Array<{
  id: string;
  command: string[];
  cwd?: string;
  restart?: "never" | "on-failure" | "always" | "on_crash";
  dependsOn?: string[];
  readiness?: { type: "none" } | { type: "port"; port: number } | { type: "logRegex"; pattern: string };
}>, options: {
  stackButtons?: Array<{ id: string; name: string; processIds: string[]; startOrder: "parallel" | "dependency" }>;
} = {}) {
  const defs = processes.map((p) => ({
    id: p.id,
    name: p.id,
    command: p.command,
    cwd: p.cwd ?? ".",
    env: {},
    groupIds: [],
    autostart: false,
    restart: p.restart ?? "never" as const,
    gracefulShutdownMs: 1000,
    dependsOn: p.dependsOn ?? [],
    readiness: p.readiness ?? { type: "none" as const },
  }));
  return {
    effective: {
      processes: defs,
      stackButtons: options.stackButtons ?? [],
      processGroups: [],
      laneOverlayPolicies: [],
    },
    local: {},
  };
}

function makeLaneSummary(tmpDir: string, laneId: string) {
  return {
    id: laneId,
    name: laneId,
    description: null,
    laneType: "worktree",
    branchRef: "feature/test",
    baseRef: "main",
    worktreePath: tmpDir,
    attachedRootPath: null,
    isEditProtected: false,
    parentLaneId: null,
    color: null,
    icon: null,
    tags: [],
    status: { dirty: false, ahead: 0, behind: 0, conflict: "unknown", tests: "unknown", pr: "none" },
    stackDepth: 0,
    createdAt: "2026-03-24T12:00:00.000Z",
    archivedAt: null,
  };
}

function createPtyHarness(tmpDir: string, options: { deferDisposeExit?: boolean } = {}) {
  const sessionStore = new Map<string, { id: string; laneId: string; ptyId: string | null; transcriptPath: string }>();
  const dataListeners = new Set<(event: { laneId: string; ptyId: string; sessionId: string; data: string }) => void>();
  const exitListeners = new Set<(event: { laneId: string; ptyId: string; sessionId: string; exitCode: number | null }) => void>();

  const sessionService = {
    get: vi.fn((sessionId: string) => sessionStore.get(sessionId) ?? null),
  } as any;

  const ptyService = {
    create: vi.fn(async (args: any) => {
      const transcriptPath = path.join(tmpDir, ".ade", "transcripts", `${args.sessionId}.log`);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, "", "utf8");
      const ptyId = `pty-${args.sessionId}`;
      sessionStore.set(args.sessionId, {
        id: args.sessionId,
        laneId: args.laneId,
        ptyId,
        transcriptPath,
      });
      return {
        ptyId,
        sessionId: args.sessionId,
        pid: 4321,
      };
    }),
    dispose: vi.fn((args: { ptyId: string; sessionId?: string }) => {
      const sessionId = args.sessionId ?? Array.from(sessionStore.values()).find((session) => session.ptyId === args.ptyId)?.id;
      if (!sessionId) return;
      const session = sessionStore.get(sessionId);
      if (!session) return;
      if (options.deferDisposeExit) return;
      for (const listener of exitListeners) {
        listener({
          laneId: session.laneId,
          ptyId: args.ptyId,
          sessionId,
          exitCode: null,
        });
      }
      session.ptyId = null;
    }),
    onData: vi.fn((listener: (event: { laneId: string; ptyId: string; sessionId: string; data: string }) => void) => {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    }),
    onExit: vi.fn((listener: (event: { laneId: string; ptyId: string; sessionId: string; exitCode: number | null }) => void) => {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    }),
  } as any;

  const emitData = (sessionId: string, data: string) => {
    const session = sessionStore.get(sessionId);
    if (!session?.ptyId) throw new Error(`No live PTY for session ${sessionId}`);
    fs.appendFileSync(session.transcriptPath, data, "utf8");
    for (const listener of dataListeners) {
      listener({
        laneId: session.laneId,
        ptyId: session.ptyId,
        sessionId,
        data,
      });
    }
  };

  const emitExit = (sessionId: string, exitCode: number | null) => {
    const session = sessionStore.get(sessionId);
    if (!session?.ptyId) throw new Error(`No live PTY for session ${sessionId}`);
    for (const listener of exitListeners) {
      listener({
        laneId: session.laneId,
        ptyId: session.ptyId,
        sessionId,
        exitCode,
      });
    }
    session.ptyId = null;
  };

  return { sessionService, ptyService, emitData, emitExit };
}

describe("processService PTY-backed run commands", () => {
  it("injects lane runtime env into PTY-backed run commands", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-env-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-env";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-env", projectId, "Lane Env", null, "worktree", "main", "feature/env", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "print-env", command: ["npx", "sst", "dev", "--mode=mono"] },
    ]);

    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-env")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      getLaneRuntimeEnv: async () => ({
        PORT: "3001",
        PORT_RANGE_START: "3001",
        PORT_RANGE_END: "3099",
        HOSTNAME: "lane-env.localhost",
        PROXY_HOSTNAME: "lane-env.localhost",
      }),
      broadcastEvent: () => {},
    });

    try {
      await service.start({ laneId: "lane-env", processId: "print-env" });
      expect(ptyService.create).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.objectContaining({
          PORT: "3001",
          PORT_RANGE_START: "3001",
          PORT_RANGE_END: "3099",
          HOSTNAME: "lane-env.localhost",
          PROXY_HOSTNAME: "lane-env.localhost",
        }),
      }));
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes envPath and envShell in the process.start log entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-startlog-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-startlog";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-ok", projectId, "Lane OK", null, "worktree", "main", "feature/ok", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "echo-proc", command: ["echo", "hello"] },
    ]);

    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-ok")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      const runtime = await service.start({ laneId: "lane-ok", processId: "echo-proc" });
      expect(runtime.status).toBe("running");

      const infoCalls = logger.info.mock.calls.filter(
        (call: any[]) => call[0] === "process.start",
      );
      expect(infoCalls.length).toBe(1);
      const logData = infoCalls[0][1];
      expect(logData).toHaveProperty("envPath");
      expect(logData).toHaveProperty("envShell");
      expect(logData.processId).toBe("echo-proc");
      expect(logData.laneId).toBe("lane-ok");
      expect(logData.runId).toBeTruthy();
      expect(logData.command).toEqual(["echo", "hello"]);
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("transitions to crashed status when the PTY-backed command exits with non-zero code", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-error-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-crash";
    const logger = createLogger();
    const events: any[] = [];
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService, emitExit } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-err", projectId, "Lane Error", null, "worktree", "main", "feature/err", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "fail-proc", command: ["sh", "-c", "exit 42"] },
    ]);

    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-err")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: (ev: any) => events.push(ev),
    });

    try {
      const runtime = await service.start({ laneId: "lane-err", processId: "fail-proc" });
      expect(runtime.sessionId).toBeTruthy();

      emitExit(String(runtime.sessionId), 42);

      const runtimes = service.listRuntime("lane-err");
      const current = runtimes.find((row) => row.processId === "fail-proc");
      expect(current).toBeTruthy();
      expect(current!.status).toBe("crashed");
      expect(current!.lastExitCode).toBe(42);

      const runRow = db.get<{ exit_code: number | null; termination_reason: string }>(
        "select exit_code, termination_reason from process_runs where project_id = ? and process_key = ?",
        [projectId, "fail-proc"],
      );
      expect(runRow).toBeTruthy();
      expect(runRow!.exit_code).toBe(42);
      expect(runRow!.termination_reason).toBe("crashed");
      expect(events.some((event) => event.type === "runtime" && event.runtime.status === "crashed")).toBe(true);
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows multiple concurrent runs for the same command and stops them together", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-multi-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-multi";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-multi", projectId, "Lane Multi", null, "worktree", "main", "feature/multi", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([{ id: "web", command: ["npm", "run", "dev"] }]);
    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-multi")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      const first = await service.start({ laneId: "lane-multi", processId: "web" });
      const second = await service.start({ laneId: "lane-multi", processId: "web" });

      expect(first.runId).not.toBe(second.runId);
      expect(first.sessionId).not.toBe(second.sessionId);

      const live = service.listRuntime("lane-multi").filter((runtime) => runtime.processId === "web");
      expect(live).toHaveLength(2);
      expect(live.every((runtime) => runtime.status === "running")).toBe(true);

      await service.stop({ laneId: "lane-multi", processId: "web" });

      const stopped = service.listRuntime("lane-multi").filter((runtime) => runtime.processId === "web");
      expect(stopped).toHaveLength(2);
      expect(stopped.every((runtime) => runtime.status === "exited")).toBe(true);
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stop({ runId }) targets only the specified run and leaves siblings running", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-stop-runid-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-stop-runid";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-stop", projectId, "Lane Stop", null, "worktree", "main", "feature/stop", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([{ id: "web", command: ["npm", "run", "dev"] }]);
    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-stop")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      const first = await service.start({ laneId: "lane-stop", processId: "web" });
      const second = await service.start({ laneId: "lane-stop", processId: "web" });
      expect(first.runId).not.toBe(second.runId);

      await service.stop({ laneId: "lane-stop", processId: "web", runId: first.runId });

      const afterFirstStop = service.listRuntime("lane-stop").filter((r) => r.processId === "web");
      const firstEntry = afterFirstStop.find((r) => r.runId === first.runId);
      const secondEntry = afterFirstStop.find((r) => r.runId === second.runId);
      expect(firstEntry).toBeTruthy();
      expect(secondEntry).toBeTruthy();
      expect(firstEntry!.status).toBe("exited");
      expect(secondEntry!.status).toBe("running");

      await service.stop({ laneId: "lane-stop", processId: "web", runId: second.runId });

      const afterSecondStop = service.listRuntime("lane-stop").filter((r) => r.processId === "web");
      expect(afterSecondStop.find((r) => r.runId === second.runId)!.status).toBe("exited");
      expect(afterSecondStop.every((r) => r.status === "exited")).toBe(true);
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stop returns null when there is no matching active run", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-stop-null-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-stop-null";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-null", projectId, "Lane Null", null, "worktree", "main", "feature/null", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([{ id: "web", command: ["npm", "run", "dev"] }]);
    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-null")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      const result = await service.stop({ laneId: "lane-null", processId: "web" });
      expect(result).toBeNull();

      await service.start({ laneId: "lane-null", processId: "web" });
      await service.stop({ laneId: "lane-null", processId: "web" });

      const secondResult = await service.stop({ laneId: "lane-null", processId: "web" });
      expect(secondResult).toBeNull();
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("listRuntime returns every run sorted most-recent first", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-listruntime-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-listruntime";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-order", projectId, "Lane Order", null, "worktree", "main", "feature/order", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "web", command: ["npm", "run", "web"] },
      { id: "api", command: ["npm", "run", "api"] },
    ]);
    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-order")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      const webFirst = await service.start({ laneId: "lane-order", processId: "web" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const apiRun = await service.start({ laneId: "lane-order", processId: "api" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const webLatest = await service.start({ laneId: "lane-order", processId: "web" });

      const runtimes = service.listRuntime("lane-order");
      expect(runtimes).toHaveLength(3);
      const orderedIds = runtimes.map((r) => r.runId);
      expect(orderedIds[0]).toBe(webLatest.runId);
      expect(orderedIds).toContain(webFirst.runId);
      expect(orderedIds).toContain(apiRun.runId);
      expect(orderedIds.indexOf(webLatest.runId)).toBeLessThan(orderedIds.indexOf(apiRun.runId));
      expect(orderedIds.indexOf(apiRun.runId)).toBeLessThan(orderedIds.indexOf(webFirst.runId));
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("restart issues a new runId and leaves the old run exited", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-restart-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-restart";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService, emitExit } = createPtyHarness(tmpDir, { deferDisposeExit: true });

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-restart", projectId, "Lane Restart", null, "worktree", "main", "feature/restart", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([{ id: "web", command: ["npm", "run", "dev"] }]);
    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-restart")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      const original = await service.start({ laneId: "lane-restart", processId: "web" });
      const restartPromise = service.restart({ laneId: "lane-restart", processId: "web" });
      await Promise.resolve();

      expect(ptyService.dispose).toHaveBeenCalledWith({
        ptyId: original.ptyId,
        sessionId: original.sessionId,
      });
      expect(ptyService.create).toHaveBeenCalledTimes(1);

      emitExit(String(original.sessionId), null);
      const restarted = await restartPromise;

      expect(restarted.runId).not.toBe(original.runId);
      expect(restarted.status).toBe("running");

      const runtimes = service.listRuntime("lane-restart").filter((r) => r.processId === "web");
      expect(runtimes).toHaveLength(2);
      const oldRuntime = runtimes.find((r) => r.runId === original.runId);
      const newRuntime = runtimes.find((r) => r.runId === restarted.runId);
      expect(oldRuntime).toBeTruthy();
      expect(newRuntime).toBeTruthy();
      expect(oldRuntime!.status).toBe("exited");
      expect(newRuntime!.status).toBe("running");
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("starts dependency-ordered stacks in dependency order and stops them in reverse", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-stack-order-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-stack-order";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-stack", projectId, "Lane Stack", null, "worktree", "main", "feature/stack", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "api", command: ["npm", "run", "api"], dependsOn: ["db"] },
      { id: "db", command: ["npm", "run", "db"] },
    ], {
      stackButtons: [{ id: "full", name: "Full", processIds: ["api", "db"], startOrder: "dependency" }],
    });
    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-stack")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      await service.startStack({ laneId: "lane-stack", stackId: "full" });

      expect(
        ptyService.create.mock.calls.map((call: any[]) => [call[0].command, ...call[0].args].join(" ")),
      ).toEqual(["npm run db", "npm run api"]);

      await service.stopStack({ laneId: "lane-stack", stackId: "full" });

      const disposedSessionIds = ptyService.dispose.mock.calls.map((call: any[]) => call[0].sessionId);
      const runtimes = service.listRuntime("lane-stack");
      const api = runtimes.find((runtime) => runtime.processId === "api");
      const dbRuntime = runtimes.find((runtime) => runtime.processId === "db");
      expect(disposedSessionIds).toEqual([api?.sessionId, dbRuntime?.sessionId]);
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps log-regex readiness in starting until matching output arrives", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-readiness-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-readiness";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService, emitData } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-ready", projectId, "Lane Ready", null, "worktree", "main", "feature/ready", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "web", command: ["npm", "run", "web"], readiness: { type: "logRegex", pattern: "ready on http" } },
    ]);
    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-ready")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      const started = await service.start({ laneId: "lane-ready", processId: "web" });
      expect(started.status).toBe("starting");
      expect(started.readiness).toBe("unknown");

      emitData(String(started.sessionId), "still booting\n");
      expect(service.listRuntime("lane-ready").find((runtime) => runtime.runId === started.runId)?.status).toBe("starting");

      emitData(String(started.sessionId), "ready on http://localhost:3000\n");
      const ready = service.listRuntime("lane-ready").find((runtime) => runtime.runId === started.runId);
      expect(ready?.status).toBe("running");
      expect(ready?.readiness).toBe("ready");
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-restarts failed processes when restart policy requests it", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-autorestart-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-autorestart";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService, emitExit } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-retry", projectId, "Lane Retry", null, "worktree", "main", "feature/retry", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "worker", command: ["npm", "run", "worker"], restart: "on-failure" },
    ]);
    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-retry")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      const failed = await service.start({ laneId: "lane-retry", processId: "worker" });
      emitExit(String(failed.sessionId), 1);
      expect(ptyService.create).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(400);

      expect(ptyService.create).toHaveBeenCalledTimes(2);
      const runtimes = service.listRuntime("lane-retry").filter((runtime) => runtime.processId === "worker");
      expect(runtimes.some((runtime) => runtime.runId === failed.runId && runtime.status === "crashed")).toBe(true);
      expect(runtimes.some((runtime) => runtime.runId !== failed.runId && runtime.status === "running")).toBe(true);
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("getLogTail({ runId }) returns only the specified run's transcript", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-logtail-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-logtail";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService, emitData } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-tail", projectId, "Lane Tail", null, "worktree", "main", "feature/tail", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "web", command: ["npm", "run", "dev"] },
      { id: "api", command: ["npm", "run", "api"] },
    ]);
    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-tail")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      const first = await service.start({ laneId: "lane-tail", processId: "web" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await service.start({ laneId: "lane-tail", processId: "web" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const api = await service.start({ laneId: "lane-tail", processId: "api" });

      emitData(String(first.sessionId), "first run log\n");
      emitData(String(second.sessionId), "second run log\n");
      emitData(String(api.sessionId), "api run log\n");

      const firstTail = service.getLogTail({
        laneId: "lane-tail",
        processId: "web",
        runId: first.runId,
      });
      const secondTail = service.getLogTail({
        laneId: "lane-tail",
        processId: "web",
        runId: second.runId,
      });

      expect(firstTail).toContain("first run log");
      expect(firstTail).not.toContain("second run log");
      expect(secondTail).toContain("second run log");
      expect(secondTail).not.toContain("first run log");

      const defaultTail = service.getLogTail({ laneId: "lane-tail", processId: "web" });
      expect(defaultTail).toContain("second run log");
      expect(defaultTail).not.toContain("first run log");

      const mismatchedRunTail = service.getLogTail({
        laneId: "lane-tail",
        processId: "web",
        runId: api.runId,
      });
      expect(mismatchedRunTail).toContain("second run log");
      expect(mismatchedRunTail).not.toContain("api run log");
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects process cwd values that escape the lane workspace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-cwd-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const projectId = "proj-cwd";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService } = createPtyHarness(tmpDir);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, tmpDir, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-cwd", projectId, "Lane Cwd", null, "worktree", "main", "feature/cwd", tmpDir, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "escape-proc", command: ["echo", "hello"], cwd: ".." },
    ]);

    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => tmpDir,
        list: async () => [makeLaneSummary(tmpDir, "lane-cwd")],
      } as any,
      projectConfigService: {
        get: () => config,
        getEffective: () => config.effective,
        getExecutableConfig: () => config.effective,
      } as any,
      sessionService,
      ptyService,
      broadcastEvent: () => {},
    });

    try {
      await expect(service.start({ laneId: "lane-cwd", processId: "escape-proc" })).rejects.toThrow(
        /cwd must stay within the lane workspace/,
      );
      expect(ptyService.create).not.toHaveBeenCalled();
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
