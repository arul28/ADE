import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createSessionService } from "./sessionService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeProjectRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
  return root;
}

function insertProjectGraph(db: Awaited<ReturnType<typeof openKvDb>>) {
  const now = "2026-03-17T00:00:00.000Z";
  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["project-1", "/repo/ade", "ADE", "main", now, now],
  );
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
      is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "lane-1",
      "project-1",
      "Lane 1",
      null,
      "worktree",
      "main",
      "feature/lane-1",
      "/repo/ade/.ade/worktrees/lane-1",
      null,
      0,
      null,
      null,
      null,
      null,
      null,
      "active",
      now,
      null,
    ],
  );
}

const activeDisposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose) await dispose();
  }
});

describe("sessionService resume metadata", () => {
  it("derives permission-aware resume commands from stored metadata", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-1",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Claude CLI",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-1.log",
      toolType: "claude",
      resumeMetadata: {
        provider: "claude",
        targetKind: "session",
        targetId: null,
        launch: { permissionMode: "default" },
      },
    });

    const created = service.get("session-1");
    expect(created?.resumeMetadata).toEqual({
      provider: "claude",
      targetKind: "session",
      targetId: null,
      permissionMode: "default",
      launch: { permissionMode: "default" },
    });
    expect(created?.resumeCommand).toBe("claude --permission-mode default --resume");

    service.setResumeCommand("session-1", "claude --resume abc123");
    const resumed = service.get("session-1");
    expect(resumed?.resumeMetadata).toEqual({
      provider: "claude",
      targetKind: "session",
      targetId: "abc123",
      permissionMode: "default",
      launch: { permissionMode: "default" },
    });
    expect(resumed?.resumeCommand).toBe("claude --permission-mode default --resume abc123");

    activeDisposers.push(async () => db.close());
  });

  it("preserves Codex approval and sandbox settings when rebuilding the resume command", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-2",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Codex CLI",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-2.log",
      toolType: "codex",
      resumeMetadata: {
        provider: "codex",
        targetKind: "thread",
        targetId: null,
        launch: {
          permissionMode: "edit",
          codexApprovalPolicy: "on-failure",
          codexSandbox: "workspace-write",
          codexConfigSource: "flags",
        },
      },
    });

    const created = service.get("session-2");
    expect(created?.resumeCommand).toBe(
      "codex --no-alt-screen -c approval_policy=on-failure -c sandbox_mode=workspace-write resume",
    );

    service.setResumeCommand("session-2", "codex resume thread-1");
    const resumed = service.get("session-2");
    expect(resumed?.resumeMetadata).toEqual({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-1",
      permissionMode: "edit",
      launch: {
        permissionMode: "edit",
        codexApprovalPolicy: "on-failure",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      },
    });
    expect(resumed?.resumeCommand).toBe(
      "codex --no-alt-screen -c approval_policy=on-failure -c sandbox_mode=workspace-write resume thread-1",
    );

    activeDisposers.push(async () => db.close());
  });

  it("round-trips Codex full-auto resume commands without dropping the thread id", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-2b",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Codex CLI",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-2b.log",
      toolType: "codex",
      resumeMetadata: {
        provider: "codex",
        targetKind: "thread",
        targetId: "thread-seed",
        launch: {
          permissionMode: "full-auto",
          codexApprovalPolicy: "never",
          codexSandbox: "danger-full-access",
          codexConfigSource: "flags",
        },
      },
    });

    service.setResumeCommand("session-2b", "codex --no-alt-screen --full-auto resume thread-full-auto");
    const resumed = service.get("session-2b");
    expect(resumed?.resumeMetadata).toEqual({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-full-auto",
      permissionMode: "full-auto",
      launch: {
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      },
    });
    expect(resumed?.resumeCommand).toBe("codex --no-alt-screen --full-auto resume thread-full-auto");

    activeDisposers.push(async () => db.close());
  });

  it("reattaches an existing tracked session to a new PTY without changing its identity", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-3",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Codex CLI",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-3.log",
      toolType: "codex",
      resumeMetadata: {
        provider: "codex",
        targetKind: "thread",
        targetId: "thread-3",
        launch: { permissionMode: "edit" },
      },
    });
    service.end({
      sessionId: "session-3",
      endedAt: "2026-03-17T00:20:00.000Z",
      exitCode: 0,
      status: "completed",
    });

    const reattached = service.reattach({
      sessionId: "session-3",
      ptyId: "pty-3b",
      startedAt: "2026-03-17T00:30:00.000Z",
    });
    expect(reattached).toEqual(expect.objectContaining({
      id: "session-3",
      ptyId: "pty-3b",
      status: "running",
      endedAt: null,
      exitCode: null,
      startedAt: "2026-03-17T00:30:00.000Z",
      title: "Codex CLI",
      summary: null,
    }));

    activeDisposers.push(async () => db.close());
  });
});
