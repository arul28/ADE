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
}>) {
  const defs = processes.map((p) => ({
    id: p.id,
    name: p.id,
    command: p.command,
    cwd: p.cwd ?? ".",
    env: {},
    autostart: false,
    restart: "never" as const,
    gracefulShutdownMs: 1000,
    dependsOn: [],
    readiness: { type: "none" as const },
  }));
  return {
    effective: {
      processes: defs,
      stackButtons: [],
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

function createPtyHarness(tmpDir: string) {
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
        allowNewSessionId: true,
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

  it("allows a managed process to use an explicit absolute cwd outside the lane worktree", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-absolute-cwd-"));
    const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-absolute");
    fs.mkdirSync(laneRoot, { recursive: true });
    const dbPath = path.join(projectRoot, "kv.sqlite");
    const projectId = "proj-absolute-cwd";
    const logger = createLogger();
    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
    const { ptyService, sessionService } = createPtyHarness(projectRoot);

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, projectRoot, "test", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-absolute", projectId, "Lane Absolute", null, "worktree", "main", "feature/absolute", laneRoot, null, 0, null, null, null, null, "active", now, null],
    );

    const config = makeMinimalConfig([
      { id: "absolute-proc", command: ["scripts/dogfood.sh", "code-review"], cwd: projectRoot },
    ]);

    const service = createProcessService({
      db,
      projectId,
      logger,
      laneService: {
        getLaneWorktreePath: () => laneRoot,
        list: async () => [makeLaneSummary(laneRoot, "lane-absolute")],
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
      const resolvedProjectRoot = fs.realpathSync(projectRoot);
      await service.start({ laneId: "lane-absolute", processId: "absolute-proc" });
      expect(ptyService.create).toHaveBeenCalledWith(expect.objectContaining({
        allowExternalCwd: true,
        cwd: resolvedProjectRoot,
      }));
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
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
