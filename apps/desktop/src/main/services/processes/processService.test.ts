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
    readiness: { type: "immediate" as const },
    restart: { policy: "never" as const },
    dependsOn: [],
    healthCheck: null,
    icon: null,
    color: null,
    description: null,
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

/** Wait for a process to fully exit by polling its runtime status. */
async function waitForExit(
  service: ReturnType<typeof createProcessService>,
  laneId: string,
  processId: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runtimes = service.listRuntime(laneId);
    const rt = runtimes.find((r) => r.processId === processId);
    if (rt && (rt.status === "stopped" || rt.status === "crashed")) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("processService start logging", () => {
  it("includes envPath and envShell in the process.start log entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-startlog-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const logsDir = path.join(tmpDir, "logs");
    const projectId = "proj-startlog";
    const logger = createLogger();

    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
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
      processLogsDir: logsDir,
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
      broadcastEvent: () => {},
    });

    try {
      const runtime = await service.start({ laneId: "lane-ok", processId: "echo-proc" });
      expect(runtime.status).toMatch(/starting|running|stopped/);

      // Wait for echo to complete before asserting / closing db
      await waitForExit(service, "lane-ok", "echo-proc");

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

  it("transitions to crashed status when the spawned process exits with non-zero code", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-error-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const logsDir = path.join(tmpDir, "logs");
    const projectId = "proj-crash";
    const logger = createLogger();
    const events: any[] = [];

    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
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
      processLogsDir: logsDir,
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
      broadcastEvent: (ev: any) => events.push(ev),
    });

    try {
      await service.start({ laneId: "lane-err", processId: "fail-proc" });

      // Wait for the process to exit
      await waitForExit(service, "lane-err", "fail-proc");

      const runtimes = service.listRuntime("lane-err");
      const current = runtimes.find((r) => r.processId === "fail-proc");
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
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects process cwd values that escape the lane workspace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-cwd-"));
    const dbPath = path.join(tmpDir, "kv.sqlite");
    const logsDir = path.join(tmpDir, "logs");
    const projectId = "proj-cwd";
    const logger = createLogger();

    const db = await openKvDb(dbPath, createLogger());
    const now = "2026-03-24T12:00:00.000Z";
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
      processLogsDir: logsDir,
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
      broadcastEvent: () => {},
    });

    try {
      await expect(service.start({ laneId: "lane-cwd", processId: "escape-proc" })).rejects.toThrow(
        /cwd escapes lane workspace/,
      );
    } finally {
      service.disposeAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
