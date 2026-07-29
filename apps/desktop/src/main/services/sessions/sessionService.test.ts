import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
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
  it("reads terminal scrollback transparently from a compressed log", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-gzip-");
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });
    const transcriptPath = path.join(projectRoot, "terminal.log");
    fs.writeFileSync(`${transcriptPath}.gz`, gzipSync("old terminal output\nlatest line\n"));

    await expect(service.readTranscriptTail(transcriptPath, 1_024, { raw: true }))
      .resolves.toBe("old terminal output\nlatest line\n");
  });

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

  it("projects tracked CLI spawn lineage from resume metadata without assigning a chat owner", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-lineage-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });

    service.create({
      sessionId: "session-lineage",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Codex CLI child",
      startedAt: "2026-07-18T04:10:54.789Z",
      transcriptPath: "/tmp/session-lineage.log",
      toolType: "codex",
      resumeMetadata: {
        provider: "codex",
        targetKind: "thread",
        targetId: null,
        launch: { permissionMode: "default" },
        orchestrationParentSessionId: "parent-session-1",
        spawnKind: "subagent",
      },
    });

    expect(service.list({ laneId: "lane-1" })).toEqual([
      expect.objectContaining({
        id: "session-lineage",
        chatSessionId: null,
        orchestrationParentSessionId: "parent-session-1",
        spawnKind: "subagent",
      }),
    ]);

    service.setResumeCommand("session-lineage", "codex resume thread-1");
    expect(service.get("session-lineage")).toEqual(expect.objectContaining({
      chatSessionId: null,
      orchestrationParentSessionId: "parent-session-1",
      spawnKind: "subagent",
      resumeMetadata: expect.objectContaining({
        targetId: "thread-1",
        orchestrationParentSessionId: "parent-session-1",
        spawnKind: "subagent",
      }),
    }));
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
          fastMode: true,
          codexApprovalPolicy: "untrusted",
          codexSandbox: "workspace-write",
          codexConfigSource: "flags",
        },
      },
    });

    const created = service.get("session-2");
    expect(created?.resumeCommand).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"medium\\\"\" -c \"service_tier=\\\"fast\\\"\" -c features.fast_mode=true --sandbox workspace-write --ask-for-approval untrusted resume",
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
        fastMode: true,
        codexApprovalPolicy: "untrusted",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      },
    });
    expect(resumed?.resumeCommand).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"medium\\\"\" -c \"service_tier=\\\"fast\\\"\" -c features.fast_mode=true --sandbox workspace-write --ask-for-approval untrusted resume thread-1",
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
    expect(resumed?.resumeCommand).toBe(
      "codex --no-alt-screen --sandbox danger-full-access --ask-for-approval never resume thread-full-auto",
    );

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
      "OPENCODE_CONFIG_CONTENT=\"{\\\"permission\\\":\\\"allow\\\"}\" opencode --session ses_legacy",
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

  it("settles idempotently, records an outcome, clears attention, and unsets", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-settle-");
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });
    service.create({
      sessionId: "session-settle",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Settle me",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-settle.log",
      toolType: "codex-chat",
    });

    service.requestAttention("session-settle", "Need a decision");
    expect(service.get("session-settle")).toEqual(expect.objectContaining({
      attentionMessage: "Need a decision",
      attentionSource: "agent_explicit",
    }));
    service.settleSession("session-settle", {
      outcome: "  Shipped the fix  ",
      settledAt: "2026-03-17T01:00:00.000Z",
    });
    service.settleSession("session-settle", {
      outcome: "   ",
      settledAt: "2026-03-17T02:00:00.000Z",
    });

    expect(service.get("session-settle")).toEqual(expect.objectContaining({
      settledAt: "2026-03-17T01:00:00.000Z",
      statusNote: "Shipped the fix",
      settleSource: "user",
      attentionRequestedAt: null,
      attentionMessage: null,
      attentionSource: null,
    }));

    service.unsettleSession("session-settle");
    expect(service.get("session-settle")?.settledAt).toBeNull();
    expect(service.get("session-settle")?.settleSource).toBeNull();
  });

  it("bulk settles only rows that were not already settled", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-settle-many-");
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });
    for (const sessionId of ["session-settled", "session-new", "session-other"]) {
      service.create({
        sessionId,
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: sessionId,
        startedAt: "2026-03-17T00:10:00.000Z",
        transcriptPath: `/tmp/${sessionId}.log`,
        toolType: "shell",
      });
    }
    service.settleSession("session-settled", { settledAt: "2026-03-17T01:00:00.000Z" });

    expect(service.settleSessions([
      "session-settled",
      "session-new",
      "session-new",
      "missing-session",
    ])).toEqual(["session-new"]);
    expect(service.get("session-settled")?.settledAt).toBe("2026-03-17T01:00:00.000Z");
    expect(service.get("session-new")?.settledAt).not.toBeNull();
    expect(service.get("session-other")?.settledAt).toBeNull();

    expect(service.settleSessionsWithOutcome(
      ["session-settled", "session-other"],
      "PR #841 merged",
      "2026-03-17T03:00:00.000Z",
      "pr_merge",
    )).toEqual(["session-other"]);
    expect(service.get("session-settled")).toEqual(expect.objectContaining({
      settledAt: "2026-03-17T01:00:00.000Z",
      statusNote: null,
    }));
    expect(service.get("session-other")).toEqual(expect.objectContaining({
      settledAt: "2026-03-17T03:00:00.000Z",
      settleSource: "pr_merge",
      statusNote: "PR #841 merged",
    }));
  });

  it("normalizes status and attention text and clears turn-start markers", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-markers-");
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });
    service.create({
      sessionId: "session-markers",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Marker session",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-markers.log",
      toolType: "claude-chat",
    });

    service.setStatusNote("session-markers", `  ${"n".repeat(210)}  `);
    expect(service.get("session-markers")?.statusNote).toBe("n".repeat(200));
    service.setStatusNote("session-markers", "   ");
    expect(service.get("session-markers")?.statusNote).toBeNull();

    service.settleSession("session-markers", { settledAt: "2026-03-17T01:00:00.000Z" });
    service.requestAttention("session-markers", `  ${"a".repeat(510)}  `);
    expect(service.get("session-markers")).toEqual(expect.objectContaining({
      settledAt: null,
      attentionMessage: "a".repeat(500),
    }));

    db.run(
      `
        update terminal_sessions
        set settled_at = ?,
            attention_requested_at = ?,
            attention_message = ?,
            last_turn_failed_at = ?
        where id = ?
      `,
      [
        "2026-03-17T01:00:00.000Z",
        "2026-03-17T01:01:00.000Z",
        "Need help",
        "2026-03-17T01:02:00.000Z",
        "session-markers",
      ],
    );
    service.clearTurnStartMarkers("session-markers");
    expect(service.get("session-markers")).toEqual(expect.objectContaining({
      settledAt: null,
      attentionRequestedAt: null,
      attentionMessage: null,
      lastTurnFailedAt: null,
    }));
  });

  it("lets PTY callers preserve agent settlement while ordinary output clears it", async () => {
    const projectRoot = makeProjectRoot("ade-session-service-output-");
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });
    service.create({
      sessionId: "session-output",
      laneId: "lane-1",
      ptyId: "pty-output",
      tracked: true,
      title: "Output session",
      startedAt: "2026-03-17T00:10:00.000Z",
      transcriptPath: "/tmp/session-output.log",
      toolType: "codex",
    });

    // Chat preview writes (no clearSettled) must PRESERVE a declared settle —
    // an agent's own final assistant text would otherwise undo its
    // `ade chat settle`. Only PTY-layer activity un-settles.
    service.settleSession("session-output", { settledAt: "2026-03-17T00:30:00.000Z" });
    service.setLastOutputPreview("session-output", "final assistant text");
    expect(service.get("session-output")?.settledAt).toBe("2026-03-17T00:30:00.000Z");

    service.setLastOutputPreview("session-output", "working", { clearSettled: true });
    expect(service.get("session-output")?.settledAt).toBeNull();

    service.settleSession("session-output", { settledAt: "2026-03-17T02:00:00.000Z" });
    service.touchSessionActivity("session-output", "2026-03-17T02:01:00.000Z");
    expect(service.get("session-output")?.settledAt).toBeNull();

    // A tracked agent CLI may emit its settle command and final answer through
    // the same PTY after declaring completion. That output refreshes activity
    // without reopening the thread; the next user turn clears it explicitly.
    service.settleSession("session-output", { settledAt: "2026-03-17T02:30:00.000Z" });
    service.touchSessionActivity(
      "session-output",
      "2026-03-17T02:31:00.000Z",
      { clearSettled: false },
    );
    expect(service.get("session-output")?.settledAt).toBe("2026-03-17T02:30:00.000Z");

    // A turn failure un-settles: the declared outcome is in doubt, and keeping
    // the markers mutually exclusive lets every surface agree on precedence.
    service.settleSession("session-output", { settledAt: "2026-03-17T03:00:00.000Z" });
    service.markLastTurnFailed("session-output", "2026-03-17T03:05:00.000Z");
    expect(service.get("session-output")?.settledAt).toBeNull();
    expect(service.get("session-output")?.lastTurnFailedAt).toBe("2026-03-17T03:05:00.000Z");
  });
});

describe("sessionService snooze overlay", () => {
  async function makeService(prefix: string) {
    const projectRoot = makeProjectRoot(prefix);
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });
    service.create({
      sessionId: "session-snooze",
      laneId: "lane-1",
      ptyId: "pty-snooze",
      tracked: true,
      title: "Snoozed session",
      startedAt: "2026-03-17T00:00:00.000Z",
      transcriptPath: "/tmp/session-snooze.log",
      toolType: "claude-chat",
    });
    return { db, service };
  }

  it("persists snoozedUntil/snoozedAt and clears a stale woke marker", async () => {
    const { service } = await makeService("ade-session-service-snooze-");

    expect(service.snoozeSession("session-snooze", "2026-03-17T04:00:00.000Z", {
      snoozedAt: "2026-03-17T01:00:00.000Z",
    })).toBe(true);
    expect(service.get("session-snooze")).toEqual(expect.objectContaining({
      snoozedUntil: "2026-03-17T04:00:00.000Z",
      snoozedAt: "2026-03-17T01:00:00.000Z",
      wokeAt: null,
      wokeReason: null,
    }));

    // Snooze is an overlay: it must not touch a single lifecycle column.
    expect(service.get("session-snooze")?.settledAt).toBeNull();
    expect(service.get("session-snooze")?.status).toBe("running");

    expect(service.wakeSession("session-snooze")).toBe(true);
    expect(service.get("session-snooze")).toEqual(expect.objectContaining({
      snoozedUntil: null,
      snoozedAt: null,
      wokeReason: "manual",
    }));
    expect(service.get("session-snooze")?.wokeAt).toBeTruthy();

    // A second wake is a no-op — there is nothing left asleep.
    expect(service.wakeSession("session-snooze")).toBe(false);

    // Re-snoozing clears the previous woke marker so the UI does not show a
    // stale "woke because…" chip on a row that is asleep again.
    service.snoozeSession("session-snooze", "2026-03-17T05:00:00.000Z");
    expect(service.get("session-snooze")).toEqual(expect.objectContaining({
      wokeAt: null,
      wokeReason: null,
    }));

    expect(service.clearWokeMarker("session-snooze")).toBe(true);
    expect(service.snoozeSession("session-snooze", "not-a-date")).toBe(false);
    expect(service.snoozeSession("missing-session", "2026-03-17T05:00:00.000Z")).toBe(false);
  });

  it("does NOT early-wake on the error the snooze was taken on top of", async () => {
    const { service } = await makeService("ade-session-service-snooze-error-");

    // The load-bearing case: snooze AFTER a failure, then let the same (or an
    // older) failure timestamp be re-stamped. Without the newer-than
    // comparison the row re-wakes instantly and snooze does nothing.
    service.markLastTurnFailed("session-snooze", "2026-03-17T01:00:00.000Z");
    service.snoozeSession("session-snooze", "2026-03-17T06:00:00.000Z", {
      snoozedAt: "2026-03-17T02:00:00.000Z",
    });

    service.markLastTurnFailed("session-snooze", "2026-03-17T01:30:00.000Z");
    expect(service.get("session-snooze")).toEqual(expect.objectContaining({
      snoozedUntil: "2026-03-17T06:00:00.000Z",
      wokeReason: null,
    }));

    // Exactly at snoozed_at is still the error being snoozed.
    service.markLastTurnFailed("session-snooze", "2026-03-17T02:00:00.000Z");
    expect(service.get("session-snooze")?.snoozedUntil).toBe("2026-03-17T06:00:00.000Z");

    // Strictly newer wakes it, and records why.
    service.markLastTurnFailed("session-snooze", "2026-03-17T02:00:00.001Z");
    expect(service.get("session-snooze")).toEqual(expect.objectContaining({
      snoozedUntil: null,
      snoozedAt: null,
      wokeReason: "error",
    }));
  });

  it("early-wakes on a pending input request and on turn completion", async () => {
    const { service } = await makeService("ade-session-service-snooze-handraise-");

    service.snoozeSession("session-snooze", "2026-03-17T06:00:00.000Z", {
      snoozedAt: "2026-03-17T02:00:00.000Z",
    });
    service.requestAttention("session-snooze", "Approve this?");
    expect(service.get("session-snooze")).toEqual(expect.objectContaining({
      snoozedUntil: null,
      wokeReason: "needs_you",
    }));

    service.snoozeSession("session-snooze", "2026-03-17T07:00:00.000Z", {
      snoozedAt: "2026-03-17T03:00:00.000Z",
    });
    // `clearLastTurnFailed` is the "a running turn completed" write site.
    service.clearLastTurnFailed("session-snooze");
    expect(service.get("session-snooze")).toEqual(expect.objectContaining({
      snoozedUntil: null,
      wokeReason: "turn_complete",
    }));

    // An un-snoozed row never records a wake reason from a hand-raise.
    service.clearWokeMarker("session-snooze");
    service.clearLastTurnFailed("session-snooze");
    expect(service.get("session-snooze")?.wokeReason).toBeNull();
    expect(service.wakeSessionIfSnoozed("session-snooze", "turn_complete")).toBeNull();
  });

  it("supports the bulk snooze/wake variants", async () => {
    const { service } = await makeService("ade-session-service-snooze-bulk-");
    service.create({
      sessionId: "session-snooze-2",
      laneId: "lane-1",
      ptyId: "pty-snooze-2",
      tracked: true,
      title: "Second session",
      startedAt: "2026-03-17T00:00:00.000Z",
      transcriptPath: "/tmp/session-snooze-2.log",
      toolType: "codex",
    });

    expect(service.snoozeSessions(
      ["session-snooze", " session-snooze-2 ", "session-snooze", "missing"],
      "2026-03-17T08:00:00.000Z",
    )).toEqual(["session-snooze", "session-snooze-2"]);
    expect(service.get("session-snooze-2")?.snoozedUntil).toBe("2026-03-17T08:00:00.000Z");

    expect(service.wakeSessions(["session-snooze", "session-snooze-2", "missing"]))
      .toEqual(["session-snooze", "session-snooze-2"]);
    expect(service.get("session-snooze")?.snoozedUntil).toBeNull();
    expect(service.get("session-snooze-2")?.wokeReason).toBe("manual");

    expect(service.snoozeSessions([], "2026-03-17T08:00:00.000Z")).toEqual([]);
    expect(service.snoozeSessions(["session-snooze"], "nope")).toEqual([]);
  });

  // Regression: the hand-raise contract ("a snoozed session comes back when it
  // errors") was wired ONLY through chat paths — `markLastTurnFailed`. A tracked
  // CLI session that DIED stayed hidden, with no persisted woke marker, until
  // its deadline, which "Until I'm asked" puts ~100 years out.
  it("early-wakes a snoozed CLI session that ends with a non-zero exit code", async () => {
    const { service } = await makeService("ade-session-service-snooze-exit-");
    service.create({
      sessionId: "session-cli",
      laneId: "lane-1",
      ptyId: "pty-cli",
      tracked: true,
      title: "Tracked CLI",
      startedAt: "2026-03-17T00:00:00.000Z",
      transcriptPath: "/tmp/session-cli.log",
      toolType: "claude",
    });

    service.snoozeSession("session-cli", "2026-03-17T06:00:00.000Z", {
      snoozedAt: "2026-03-17T02:00:00.000Z",
    });
    service.end({
      sessionId: "session-cli",
      endedAt: "2026-03-17T03:00:00.000Z",
      exitCode: 1,
      status: "failed",
    });

    expect(service.get("session-cli")).toEqual(expect.objectContaining({
      snoozedUntil: null,
      snoozedAt: null,
      wokeReason: "error",
      exitCode: 1,
    }));
    expect(service.get("session-cli")?.wokeAt).toBeTruthy();
  });

  it("does NOT wake a snoozed session on a clean exit 0", async () => {
    const { service } = await makeService("ade-session-service-snooze-exit-zero-");
    service.create({
      sessionId: "session-cli-clean",
      laneId: "lane-1",
      ptyId: "pty-cli-clean",
      tracked: true,
      title: "Tracked CLI",
      startedAt: "2026-03-17T00:00:00.000Z",
      transcriptPath: "/tmp/session-cli-clean.log",
      toolType: "claude",
    });

    service.snoozeSession("session-cli-clean", "2026-03-17T06:00:00.000Z", {
      snoozedAt: "2026-03-17T02:00:00.000Z",
    });
    service.end({
      sessionId: "session-cli-clean",
      endedAt: "2026-03-17T03:00:00.000Z",
      exitCode: 0,
      status: "completed",
    });

    expect(service.get("session-cli-clean")).toEqual(expect.objectContaining({
      snoozedUntil: "2026-03-17T06:00:00.000Z",
      snoozedAt: "2026-03-17T02:00:00.000Z",
      wokeAt: null,
      wokeReason: null,
    }));

    // A user/system stop is not a hand-raise either.
    service.end({
      sessionId: "session-cli-clean",
      endedAt: "2026-03-17T03:30:00.000Z",
      exitCode: null,
      status: "disposed",
    });
    expect(service.get("session-cli-clean")?.snoozedUntil).toBe("2026-03-17T06:00:00.000Z");
  });

  it("keeps a session snoozed when it dies on the failure it was snoozed on top of", async () => {
    const { service } = await makeService("ade-session-service-snooze-exit-older-");
    service.create({
      sessionId: "session-cli-old",
      laneId: "lane-1",
      ptyId: "pty-cli-old",
      tracked: true,
      title: "Tracked CLI",
      startedAt: "2026-03-17T00:00:00.000Z",
      transcriptPath: "/tmp/session-cli-old.log",
      toolType: "claude",
    });

    service.snoozeSession("session-cli-old", "2026-03-17T06:00:00.000Z", {
      snoozedAt: "2026-03-17T02:00:00.000Z",
    });
    // An end stamped at/older than `snoozed_at` is the death being snoozed.
    service.end({
      sessionId: "session-cli-old",
      endedAt: "2026-03-17T02:00:00.000Z",
      exitCode: 137,
      status: "failed",
    });
    expect(service.get("session-cli-old")).toEqual(expect.objectContaining({
      snoozedUntil: "2026-03-17T06:00:00.000Z",
      wokeReason: null,
    }));
  });
});

describe("sessionService settle override", () => {
  async function makeService(prefix: string) {
    const projectRoot = makeProjectRoot(prefix);
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });
    service.create({
      sessionId: "session-override",
      laneId: "lane-1",
      ptyId: "pty-override",
      tracked: true,
      title: "Override session",
      startedAt: "2026-03-17T00:00:00.000Z",
      transcriptPath: "/tmp/session-override.log",
      toolType: "codex",
    });
    return { db, service };
  }

  it("round-trips the tri-state and rejects junk values", async () => {
    const { service } = await makeService("ade-session-service-override-");

    expect(service.get("session-override")?.settleOverride).toBeNull();
    expect(service.setSettleOverride("session-override", "active")).toBe(true);
    expect(service.get("session-override")?.settleOverride).toBe("active");
    expect(service.setSettleOverride("session-override", "settled")).toBe(true);
    expect(service.get("session-override")?.settleOverride).toBe("settled");
    expect(service.setSettleOverride("session-override", null)).toBe(true);
    expect(service.get("session-override")?.settleOverride).toBeNull();
    expect(service.setSettleOverride("missing-session", "active")).toBe(false);

    // Unknown persisted values normalize away rather than leaking to the UI.
    service.setSettleOverride("session-override", "bogus" as never);
    expect(service.get("session-override")?.settleOverride).toBeNull();
  });

  it("clears the override on real activity, exactly like settled_at", async () => {
    const { service } = await makeService("ade-session-service-override-activity-");

    service.setSettleOverride("session-override", "active");
    service.setLastOutputPreview("session-override", "final answer");
    // Preview writes that preserve settle must preserve the override too.
    expect(service.get("session-override")?.settleOverride).toBe("active");

    service.setLastOutputPreview("session-override", "working", { clearSettled: true });
    expect(service.get("session-override")?.settleOverride).toBeNull();

    service.setSettleOverride("session-override", "settled");
    service.touchSessionActivity("session-override", "2026-03-17T01:00:00.000Z", { clearSettled: false });
    expect(service.get("session-override")?.settleOverride).toBe("settled");
    service.touchSessionActivity("session-override", "2026-03-17T01:01:00.000Z");
    expect(service.get("session-override")?.settleOverride).toBeNull();

    service.setSettleOverride("session-override", "active");
    service.clearTurnStartMarkers("session-override");
    expect(service.get("session-override")?.settleOverride).toBeNull();

    service.setSettleOverride("session-override", "settled");
    service.markLastTurnFailed("session-override", "2026-03-17T02:00:00.000Z");
    expect(service.get("session-override")?.settleOverride).toBeNull();

    service.setSettleOverride("session-override", "settled");
    service.requestAttention("session-override", "Approve?");
    expect(service.get("session-override")?.settleOverride).toBeNull();
  });

  it("keeps settle and the keep-active pin from contradicting each other", async () => {
    const { service } = await makeService("ade-session-service-override-settle-");

    // An explicit settle drops a stale keep-active pin.
    service.setSettleOverride("session-override", "active");
    service.settleSession("session-override", { settledAt: "2026-03-17T03:00:00.000Z" });
    expect(service.get("session-override")).toEqual(expect.objectContaining({
      settledAt: "2026-03-17T03:00:00.000Z",
      settleOverride: null,
    }));

    // Unsettle drops a 'settled' override…
    service.setSettleOverride("session-override", "settled");
    service.unsettleSession("session-override");
    expect(service.get("session-override")).toEqual(expect.objectContaining({
      settledAt: null,
      settleOverride: null,
    }));

    // …but must not undo an explicit keep-active decision.
    service.setSettleOverride("session-override", "active");
    service.unsettleSession("session-override");
    expect(service.get("session-override")?.settleOverride).toBe("active");
  });

  it("preserves the declaration source while an active override temporarily hides settle", async () => {
    const { service } = await makeService("ade-session-service-override-source-");

    service.settleSession("session-override", {
      settledAt: "2026-03-17T03:00:00.000Z",
      source: "agent_explicit",
    });
    service.setSettleOverride("session-override", "active");
    expect(service.get("session-override")?.settleSource).toBe("agent_explicit");

    service.setSettleOverride("session-override", null);
    expect(service.get("session-override")).toEqual(expect.objectContaining({
      settledAt: "2026-03-17T03:00:00.000Z",
      settleOverride: null,
      settleSource: "agent_explicit",
    }));
  });

  it("supports the bulk override variant", async () => {
    const { service } = await makeService("ade-session-service-override-bulk-");
    service.create({
      sessionId: "session-override-2",
      laneId: "lane-1",
      ptyId: "pty-override-2",
      tracked: true,
      title: "Second override session",
      startedAt: "2026-03-17T00:00:00.000Z",
      transcriptPath: "/tmp/session-override-2.log",
      toolType: "codex",
    });

    expect(service.setSettleOverrides(["session-override", "session-override-2", "missing"], "active"))
      .toEqual(["session-override", "session-override-2"]);
    expect(service.get("session-override-2")?.settleOverride).toBe("active");
    service.settleSession("session-override", { source: "pr_merge" });
    service.setSettleOverrides(["session-override"], "active");
    expect(service.get("session-override")?.settleSource).toBe("pr_merge");
    service.setSettleOverrides(["session-override", "session-override-2"], null);
    expect(service.get("session-override")?.settleOverride).toBeNull();
    expect(service.setSettleOverrides([], "active")).toEqual([]);
  });

  it("bulk settle clears the pin and bulk unsettle preserves it", async () => {
    const { service } = await makeService("ade-session-service-override-bulk-settle-");

    service.setSettleOverride("session-override", "active");
    expect(service.settleSessions(["session-override"])).toEqual(["session-override"]);
    expect(service.get("session-override")?.settleOverride).toBeNull();

    service.setSettleOverride("session-override", "settled");
    service.unsettleSessions(["session-override"]);
    expect(service.get("session-override")?.settleOverride).toBeNull();

    service.setSettleOverride("session-override", "active");
    service.unsettleSessions(["session-override"]);
    expect(service.get("session-override")?.settleOverride).toBe("active");
  });

  it("bulk settle drops an active pin on an already-settled row without restamping it", async () => {
    const { service } = await makeService("ade-session-service-settled-then-pinned-");

    // Declared settle first, Keep-active pinned after: the row carries BOTH a
    // non-null settled_at and settle_override = 'active', and reads as NOT
    // settled because canonicalSessionState consults the override first.
    service.settleSession("session-override", { settledAt: "2026-03-17T01:00:00.000Z" });
    service.setSettleOverride("session-override", "active");
    expect(service.get("session-override")?.settledAt).toBe("2026-03-17T01:00:00.000Z");

    // Bulk settle must behave like the single-row path: drop the stale pin,
    // report the row as changed, and preserve the original settle timestamp.
    expect(service.settleSessions(["session-override"])).toEqual(["session-override"]);
    expect(service.get("session-override")?.settleOverride).toBeNull();
    expect(service.get("session-override")?.settledAt).toBe("2026-03-17T01:00:00.000Z");

    // Fully settled with no pin is still a no-op, so the return value keeps
    // meaning "rows this call actually changed".
    expect(service.settleSessions(["session-override"])).toEqual([]);
  });
});
