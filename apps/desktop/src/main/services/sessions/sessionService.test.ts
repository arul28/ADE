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
  it("stores a create-time goal on the terminal session row", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-goal",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Codex chat",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-goal.log",
      toolType: "codex-chat",
      goal: "Run quality, tests, ship, merge, and release.",
    });

    expect(service.get("session-goal")?.goal).toBe("Run quality, tests, ship, merge, and release.");
  });

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
          model: "gpt-5.4",
          reasoningEffort: "medium",
          codexApprovalPolicy: "untrusted",
          codexSandbox: "workspace-write",
          codexConfigSource: "flags",
        },
      },
    });

    const created = service.get("session-2");
    expect(created?.resumeCommand).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c 'model_reasoning_effort=\"medium\"' --sandbox workspace-write --ask-for-approval untrusted resume",
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
        model: "gpt-5.4",
        reasoningEffort: "medium",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      },
    });
    expect(resumed?.resumeCommand).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c 'model_reasoning_effort=\"medium\"' --sandbox workspace-write --ask-for-approval untrusted resume thread-1",
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

    service.setResumeCommand("session-2b", "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume thread-full-auto");
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
    expect(resumed?.resumeCommand).toBe("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume thread-full-auto");

    activeDisposers.push(async () => db.close());
  });

  it("recovers launch permissions from a detected resume command when metadata is missing", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-opencode-legacy",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "OpenCode CLI",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-opencode-legacy.log",
      toolType: "opencode",
    });

    service.setResumeCommand(
      "session-opencode-legacy",
      "OPENCODE_CONFIG_CONTENT='{\"permission\":\"allow\"}' opencode --session ses_legacy",
    );

    const resumed = service.get("session-opencode-legacy");
    expect(resumed?.resumeMetadata).toEqual({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_legacy",
      permissionMode: "full-auto",
      launch: { permissionMode: "full-auto" },
    });
    expect(resumed?.resumeCommand).toBe(
      "OPENCODE_CONFIG_CONTENT='{\"permission\":\"allow\"}' opencode --session ses_legacy",
    );

    activeDisposers.push(async () => db.close());
  });

  it("hard deletes a stored session row", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-delete",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Disposable chat",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-delete.log",
      toolType: "opencode-chat",
    });

    expect(service.get("session-delete")?.id).toBe("session-delete");
    expect(service.deleteSession("session-delete")).toBe(true);
    expect(service.get("session-delete")).toBeNull();
    expect(service.deleteSession("session-delete")).toBe(false);

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

  it("emits a change event when metadata is updated", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });
    const events: string[] = [];

    service.create({
      sessionId: "session-4",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Claude Chat",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-4.log",
      toolType: "claude-chat",
    });

    const unsubscribe = service.onChanged((event) => {
      events.push(`${event.reason}:${event.sessionId}`);
    });

    service.updateMeta({
      sessionId: "session-4",
      title: "Investigate flaky auth tests",
      manuallyNamed: false,
    });

    unsubscribe();

    expect(events).toEqual(["meta-updated:session-4"]);

    activeDisposers.push(async () => db.close());
  });

  it("preserves droid chat sessions as droid-chat instead of coercing them to other", async () => {
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
      title: "Droid chat",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: path.join(projectRoot, "session-3.chat.jsonl"),
      toolType: "droid-chat",
      resumeCommand: "chat:droid:session-3",
    });

    const session = service.get("session-3");
    expect(session?.toolType).toBe("droid-chat");
    expect(session?.resumeCommand).toBe("chat:droid:session-3");

    const listed = service.list({ laneId: "lane-1" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.toolType).toBe("droid-chat");
    expect(listed[0]?.resumeCommand).toBe("chat:droid:session-3");

    activeDisposers.push(async () => db.close());
  });

  it("allows internal callers to opt out of the default session list limit", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    for (let i = 0; i < 205; i++) {
      service.create({
        sessionId: `session-${i}`,
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: `Session ${i}`,
        startedAt: new Date(Date.UTC(2026, 2, 17, 0, 0, i)).toISOString(),
        transcriptPath: `/tmp/session-${i}.log`,
        toolType: "codex-chat",
      });
    }

    expect(service.list({ laneId: "lane-1" })).toHaveLength(200);
    expect(service.list({ laneId: "lane-1", limit: null })).toHaveLength(205);

    activeDisposers.push(async () => db.close());
  });

  it("applies tool type filters before the session list limit", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "chat-session",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Older chat",
      startedAt: "2026-03-17T00:00:00.000Z",
      transcriptPath: path.join(projectRoot, "chat-session.chat.jsonl"),
      toolType: "codex-chat",
    });

    for (let i = 0; i < 505; i++) {
      service.create({
        sessionId: `shell-session-${i}`,
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: `Shell ${i}`,
        startedAt: new Date(Date.UTC(2026, 2, 17, 0, 10, i)).toISOString(),
        transcriptPath: `/tmp/shell-session-${i}.log`,
        toolType: "shell",
      });
    }

    const listed = service.list({ laneId: "lane-1", limit: 10, toolTypes: ["codex-chat"] });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("chat-session");

    activeDisposers.push(async () => db.close());
  });

  it("repairs legacy droid chat rows from their resume command", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    db.run(
      `
        insert into terminal_sessions(
          id, lane_id, pty_id, tracked, goal, tool_type, pinned, title, started_at, ended_at,
          exit_code, transcript_path, head_sha_start, head_sha_end, status, last_output_preview,
          last_output_at, summary, resume_command
        ) values (?, ?, null, 1, null, 'other', 0, ?, ?, null, null, ?, null, null, 'running', null, null, null, ?)
      `,
      [
        "session-legacy",
        "lane-1",
        "Droid chat",
        "2026-03-17T00:10:00.000Z",
        path.join(projectRoot, "session-legacy.chat.jsonl"),
        "chat:droid:session-legacy",
      ],
    );

    const session = service.get("session-legacy");
    expect(session?.toolType).toBe("droid-chat");
    expect(session?.resumeCommand).toBe("chat:droid:session-legacy");
    service.create({
      sessionId: "session-shell",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Shell",
      startedAt: "2026-03-17T00:11:00.000Z",
      transcriptPath: path.join(projectRoot, "session-shell.log"),
      toolType: "shell",
    });
    const listed = service.list({ laneId: "lane-1", toolTypes: ["droid-chat"] });
    expect(listed.map((row) => row.id)).toEqual(["session-legacy"]);

    activeDisposers.push(async () => db.close());
  });

  it("reconciles stale running chat sessions when no exclusions are provided", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-chat-stale",
      laneId: "lane-1",
      ptyId: "pty-chat-stale",
      tracked: true,
      title: "Claude chat",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-chat-stale.log",
      toolType: "claude-chat",
    });

    const reconciled = service.reconcileStaleRunningSessions({
      endedAt: "2026-03-17T00:20:00.000Z",
      status: "detached",
    });

    expect(reconciled).toBe(1);
    expect(service.get("session-chat-stale")).toEqual(expect.objectContaining({
      id: "session-chat-stale",
      ptyId: null,
      status: "detached",
      endedAt: "2026-03-17T00:20:00.000Z",
    }));

    activeDisposers.push(async () => db.close());
  });

  it("persists ownerPid on create and returns it from get", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-owned",
      laneId: "lane-1",
      ptyId: "pty-owned",
      tracked: true,
      title: "Claude Code",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-owned.log",
      toolType: "claude",
      ownerPid: 12_345,
    });

    expect(service.get("session-owned")).toEqual(expect.objectContaining({
      id: "session-owned",
      ownerPid: 12_345,
    }));

    activeDisposers.push(async () => db.close());
  });

  it("reconciles only running sessions without a live owner pid", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });
    const events: string[] = [];
    service.onChanged((event) => events.push(`${event.reason}:${event.sessionId}`));

    service.create({
      sessionId: "session-live-owner",
      laneId: "lane-1",
      ptyId: "pty-live-owner",
      tracked: true,
      title: "Claude Code",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-live-owner.log",
      toolType: "claude",
      ownerPid: 12_345,
    });
    service.create({
      sessionId: "session-dead-owner",
      laneId: "lane-1",
      ptyId: "pty-dead-owner",
      tracked: true,
      title: "Codex CLI",
      startedAt: "2026-03-17T00:11:00.000Z",
      transcriptPath: "/tmp/session-dead-owner.log",
      toolType: "codex",
      ownerPid: 99_999,
    });
    service.create({
      sessionId: "session-legacy-owner",
      laneId: "lane-1",
      ptyId: "pty-legacy-owner",
      tracked: true,
      title: "Legacy CLI",
      startedAt: "2026-03-17T00:12:00.000Z",
      transcriptPath: "/tmp/session-legacy-owner.log",
      toolType: "claude",
    });

    const reconciled = service.reconcileStaleRunningSessions({
      endedAt: "2026-03-17T00:20:00.000Z",
      status: "detached",
      liveOwnerPids: new Set([12_345]),
    });

    expect(reconciled).toBe(2);
    expect(service.get("session-live-owner")).toEqual(expect.objectContaining({
      id: "session-live-owner",
      status: "running",
      ptyId: "pty-live-owner",
      ownerPid: 12_345,
    }));
    expect(service.get("session-dead-owner")).toEqual(expect.objectContaining({
      id: "session-dead-owner",
      status: "detached",
      ptyId: null,
      ownerPid: 99_999,
      endedAt: "2026-03-17T00:20:00.000Z",
    }));
    expect(service.get("session-legacy-owner")).toEqual(expect.objectContaining({
      id: "session-legacy-owner",
      status: "detached",
      ptyId: null,
    }));
    expect(events).toEqual(expect.arrayContaining([
      "meta-updated:session-dead-owner",
      "meta-updated:session-legacy-owner",
    ]));

    activeDisposers.push(async () => db.close());
  });

  it("requires owner process identity to preserve peer-owned running sessions", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-live-identity",
      laneId: "lane-1",
      ptyId: "pty-live-identity",
      tracked: true,
      title: "Live owner",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-live-identity.log",
      toolType: "claude",
      ownerPid: 12_345,
      ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
    });
    service.create({
      sessionId: "session-reused-pid",
      laneId: "lane-1",
      ptyId: "pty-reused-pid",
      tracked: true,
      title: "Reused PID",
      startedAt: "2026-03-17T00:11:00.000Z",
      transcriptPath: "/tmp/session-reused-pid.log",
      toolType: "codex",
      ownerPid: 12_345,
      ownerProcessStartedAt: "2026-03-16T23:59:00.000Z",
    });

    const reconciled = service.reconcileStaleRunningSessions({
      endedAt: "2026-03-17T00:20:00.000Z",
      status: "detached",
      liveOwnerPids: new Set([12_345]),
      liveOwnerIdentities: [{ pid: 12_345, startedAt: "2026-03-17T00:00:00.000Z" }],
    });

    expect(reconciled).toBe(1);
    expect(service.get("session-live-identity")).toEqual(expect.objectContaining({
      status: "running",
      ownerPid: 12_345,
      ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
    }));
    expect(service.get("session-reused-pid")).toEqual(expect.objectContaining({
      status: "detached",
      ptyId: null,
      ownerPid: 12_345,
      ownerProcessStartedAt: "2026-03-16T23:59:00.000Z",
    }));

    activeDisposers.push(async () => db.close());
  });

  it("does not reconcile sessions owned by unknown synced machines when known owners are scoped locally", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-local-stale",
      laneId: "lane-1",
      ptyId: "pty-local-stale",
      tracked: true,
      title: "Local stale",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-local-stale.log",
      toolType: "codex",
      ownerPid: 99_999,
      ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
    });
    service.create({
      sessionId: "session-remote-owner",
      laneId: "lane-1",
      ptyId: "pty-remote-owner",
      tracked: true,
      title: "Remote owner",
      startedAt: "2026-03-17T00:11:00.000Z",
      transcriptPath: "/tmp/session-remote-owner.log",
      toolType: "codex",
      ownerPid: 88_888,
      ownerProcessStartedAt: "2026-03-17T00:02:00.000Z",
    });
    service.create({
      sessionId: "session-local-reused-pid",
      laneId: "lane-1",
      ptyId: "pty-local-reused-pid",
      tracked: true,
      title: "Local reused pid",
      startedAt: "2026-03-17T00:11:30.000Z",
      transcriptPath: "/tmp/session-local-reused-pid.log",
      toolType: "codex",
      ownerPid: 12_345,
      ownerProcessStartedAt: "2026-03-17T00:04:00.000Z",
    });
    service.create({
      sessionId: "session-legacy-ownerless",
      laneId: "lane-1",
      ptyId: "pty-legacy-ownerless",
      tracked: true,
      title: "Legacy",
      startedAt: "2026-03-17T00:12:00.000Z",
      transcriptPath: "/tmp/session-legacy-ownerless.log",
      toolType: "claude",
    });

    const reconciled = service.reconcileStaleRunningSessions({
      endedAt: "2026-03-17T00:20:00.000Z",
      status: "detached",
      liveOwnerPids: new Set([12_345]),
      liveOwnerIdentities: [{ pid: 12_345, startedAt: "2026-03-17T00:05:00.000Z" }],
      knownOwnerPids: new Set([12_345, 99_999]),
      knownOwnerIdentities: [
        { pid: 12_345, startedAt: "2026-03-17T00:05:00.000Z" },
        { pid: 12_345, startedAt: "2026-03-17T00:04:00.000Z" },
        { pid: 99_999, startedAt: "2026-03-17T00:00:00.000Z" },
      ],
    });

    expect(reconciled).toBe(3);
    expect(service.get("session-local-stale")).toEqual(expect.objectContaining({
      status: "detached",
      ptyId: null,
    }));
    expect(service.get("session-local-reused-pid")).toEqual(expect.objectContaining({
      status: "detached",
      ptyId: null,
    }));
    expect(service.get("session-legacy-ownerless")).toEqual(expect.objectContaining({
      status: "detached",
      ptyId: null,
    }));
    expect(service.get("session-remote-owner")).toEqual(expect.objectContaining({
      status: "running",
      ptyId: "pty-remote-owner",
      ownerPid: 88_888,
    }));

    activeDisposers.push(async () => db.close());
  });

  it("does not reconcile running sessions with fresh startup or output", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-stale-owner",
      laneId: "lane-1",
      ptyId: "pty-stale-owner",
      tracked: true,
      title: "Stale owner",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-stale-owner.log",
      toolType: "codex",
      ownerPid: 99_999,
      ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
    });
    service.create({
      sessionId: "session-fresh-start",
      laneId: "lane-1",
      ptyId: "pty-fresh-start",
      tracked: true,
      title: "Fresh start",
      startedAt: "2026-03-17T00:19:30.000Z",
      transcriptPath: "/tmp/session-fresh-start.log",
      toolType: "codex",
      ownerPid: 99_999,
      ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
    });
    service.create({
      sessionId: "session-fresh-output",
      laneId: "lane-1",
      ptyId: "pty-fresh-output",
      tracked: true,
      title: "Fresh output",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-fresh-output.log",
      toolType: "claude",
      ownerPid: 99_999,
      ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
    });
    db.run(
      "update terminal_sessions set last_output_at = ? where id = ?",
      ["2026-03-17T00:19:50.000Z", "session-fresh-output"],
    );

    const reconciled = service.reconcileStaleRunningSessions({
      endedAt: "2026-03-17T00:20:00.000Z",
      status: "detached",
      liveOwnerPids: new Set([12_345]),
      liveOwnerIdentities: [{ pid: 12_345, startedAt: "2026-03-17T00:00:00.000Z" }],
      freshActivityGraceMs: 60_000,
    });

    expect(reconciled).toBe(1);
    expect(service.get("session-stale-owner")).toEqual(expect.objectContaining({
      status: "detached",
      ptyId: null,
    }));
    expect(service.get("session-fresh-start")).toEqual(expect.objectContaining({
      status: "running",
      ptyId: "pty-fresh-start",
    }));
    expect(service.get("session-fresh-output")).toEqual(expect.objectContaining({
      status: "running",
      ptyId: "pty-fresh-output",
    }));

    const reconciledAfterGrace = service.reconcileStaleRunningSessions({
      endedAt: "2026-03-17T00:21:01.000Z",
      status: "detached",
      liveOwnerPids: new Set([12_345]),
      liveOwnerIdentities: [{ pid: 12_345, startedAt: "2026-03-17T00:00:00.000Z" }],
      freshActivityGraceMs: 60_000,
    });

    expect(reconciledAfterGrace).toBe(2);
    expect(service.get("session-fresh-start")).toEqual(expect.objectContaining({
      status: "detached",
      ptyId: null,
    }));
    expect(service.get("session-fresh-output")).toEqual(expect.objectContaining({
      status: "detached",
      ptyId: null,
    }));

    activeDisposers.push(async () => db.close());
  });

  it("preserves fresh activity for every terminal-backed CLI tool type", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });
    const freshToolTypes = [
      "claude",
      "codex",
      "cursor-cli",
      "droid",
      "opencode",
      "claude-orchestrated",
      "codex-orchestrated",
      "opencode-orchestrated",
      "shell",
      "run-shell",
      "aider",
      "continue",
      "other",
    ] as const;

    service.create({
      sessionId: "session-stale-owner-all-tools",
      laneId: "lane-1",
      ptyId: "pty-stale-owner-all-tools",
      tracked: true,
      title: "Stale owner",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-stale-owner-all-tools.log",
      toolType: "codex",
      ownerPid: 99_999,
      ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
    });

    freshToolTypes.forEach((toolType, index) => {
      const sessionId = `session-fresh-${index}`;
      service.create({
        sessionId,
        laneId: "lane-1",
        ptyId: `pty-fresh-${index}`,
        tracked: true,
        title: `Fresh ${toolType}`,
        startedAt: "2026-03-17T00:10:00.000Z",
        transcriptPath: `/tmp/${sessionId}.log`,
        toolType,
        ownerPid: 99_999,
        ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
      });
      db.run(
        "update terminal_sessions set last_output_at = ? where id = ?",
        ["2026-03-17T00:19:50.000Z", sessionId],
      );
    });

    const reconciled = service.reconcileStaleRunningSessions({
      endedAt: "2026-03-17T00:20:00.000Z",
      status: "detached",
      liveOwnerPids: new Set([12_345]),
      liveOwnerIdentities: [{ pid: 12_345, startedAt: "2026-03-17T00:00:00.000Z" }],
      freshActivityGraceMs: 60_000,
    });

    expect(reconciled).toBe(1);
    expect(service.get("session-stale-owner-all-tools")).toEqual(expect.objectContaining({
      status: "detached",
      ptyId: null,
    }));
    freshToolTypes.forEach((_, index) => {
      expect(service.get(`session-fresh-${index}`)).toEqual(expect.objectContaining({
        status: "running",
        ptyId: `pty-fresh-${index}`,
      }));
    });

    activeDisposers.push(async () => db.close());
  });

  it("omitted live owner set only reconciles legacy ownerless sessions", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-owned-unknown",
      laneId: "lane-1",
      ptyId: "pty-owned-unknown",
      tracked: true,
      title: "Owned",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-owned-unknown.log",
      toolType: "claude",
      ownerPid: 12_345,
    });
    service.create({
      sessionId: "session-legacy-unknown",
      laneId: "lane-1",
      ptyId: "pty-legacy-unknown",
      tracked: true,
      title: "Legacy",
      startedAt: "2026-03-17T00:11:00.000Z",
      transcriptPath: "/tmp/session-legacy-unknown.log",
      toolType: "claude",
    });

    expect(service.reconcileStaleRunningSessions({
      endedAt: "2026-03-17T00:20:00.000Z",
      status: "detached",
    })).toBe(1);

    expect(service.get("session-owned-unknown")).toEqual(expect.objectContaining({
      status: "running",
      ownerPid: 12_345,
    }));
    expect(service.get("session-legacy-unknown")).toEqual(expect.objectContaining({
      status: "detached",
      ptyId: null,
    }));

    activeDisposers.push(async () => db.close());
  });

  it("updates ownerPid on reattach", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-reattach-owner",
      laneId: "lane-1",
      ptyId: "pty-old",
      tracked: true,
      title: "Claude Code",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-reattach-owner.log",
      toolType: "claude",
      ownerPid: 12_345,
    });

    const reattached = service.reattach({
      sessionId: "session-reattach-owner",
      ptyId: "pty-new",
      startedAt: "2026-03-17T00:30:00.000Z",
      ownerPid: 22_222,
    });

    expect(reattached).toEqual(expect.objectContaining({
      id: "session-reattach-owner",
      ptyId: "pty-new",
      ownerPid: 22_222,
      status: "running",
      endedAt: null,
    }));

    activeDisposers.push(async () => db.close());
  });

  it("mirrors Claude SDK session pointers by lane and owning chat", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "chat-1",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Claude chat",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/chat-1.log",
      toolType: "claude-chat",
    });

    const created = service.upsertClaudeSessionPointer({
      sessionId: "sdk-1",
      laneId: "lane-1",
      chatSessionId: "chat-1",
      title: "Claude chat",
      tags: ["review", "review", "ade-31"],
      createdAt: "2026-03-17T00:11:00.000Z",
      updatedAt: "2026-03-17T00:12:00.000Z",
    });

    expect(created).toEqual(expect.objectContaining({
      sessionId: "sdk-1",
      laneId: "lane-1",
      laneName: "Lane 1",
      chatSessionId: "chat-1",
      title: "Claude chat",
      tags: ["review", "ade-31"],
      createdAt: "2026-03-17T00:11:00.000Z",
      updatedAt: "2026-03-17T00:12:00.000Z",
    }));
    expect(service.getClaudeSessionPointerByChatSessionId("chat-1")?.sessionId).toBe("sdk-1");
    expect(service.listClaudeSessionPointers({ laneId: "lane-1" }).map((row) => row.sessionId)).toEqual(["sdk-1"]);

    const updated = service.updateClaudeSessionPointerMeta({
      sessionId: "sdk-1",
      title: "Renamed Claude chat",
      tags: ["done"],
      updatedAt: "2026-03-17T00:13:00.000Z",
    });

    expect(updated).toEqual(expect.objectContaining({
      title: "Renamed Claude chat",
      tags: ["done"],
      updatedAt: "2026-03-17T00:13:00.000Z",
    }));

    activeDisposers.push(async () => db.close());
  });

  it("keeps a chat bound to only one Claude SDK session pointer", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "chat-reused",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Claude chat",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/chat-reused.log",
      toolType: "claude-chat",
    });

    service.upsertClaudeSessionPointer({
      sessionId: "sdk-old",
      laneId: "lane-1",
      chatSessionId: "chat-reused",
      updatedAt: "2026-03-17T00:11:00.000Z",
    });
    service.upsertClaudeSessionPointer({
      sessionId: "sdk-new",
      laneId: "lane-1",
      chatSessionId: "chat-reused",
      updatedAt: "2026-03-17T00:12:00.000Z",
    });

    expect(service.getClaudeSessionPointerByChatSessionId("chat-reused")?.sessionId).toBe("sdk-new");
    expect(service.getClaudeSessionPointer("sdk-old")?.chatSessionId).toBeNull();

    activeDisposers.push(async () => db.close());
  });

  it("touchSessionActivity refreshes only the activity timestamp", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-touch",
      laneId: "lane-1",
      ptyId: "pty-touch",
      tracked: true,
      title: "Spinner shell",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: path.join(projectRoot, "session-touch.log"),
      toolType: "shell",
    });
    // No output yet → no recorded activity.
    expect(service.get("session-touch")?.lastActivityAt ?? null).toBeNull();

    service.touchSessionActivity("session-touch", "2026-03-18T08:00:00.000Z");

    const touched = service.get("session-touch");
    // Activity timestamp advances even though the preview text never changed —
    // this is what keeps steady-output sessions from being flagged idle.
    expect(touched?.lastActivityAt).toBe("2026-03-18T08:00:00.000Z");
    expect(touched?.lastOutputPreview).toBeNull();

    activeDisposers.push(async () => db.close());
  });
});
