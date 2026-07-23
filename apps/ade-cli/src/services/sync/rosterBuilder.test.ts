import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  buildRosterSnapshot,
  createForeignChatTranscriptResolver,
  type RosterBootedScope,
  type RosterLiveSession,
  type RosterScopeRegistry,
} from "./rosterBuilder";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => DatabaseSyncType;
};

const PROJECT_ID = "project_test_roster";

let projectRoot: string;
let worktreeDir: string;

function seedDatabase(): void {
  const adeDir = path.join(projectRoot, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  worktreeDir = path.join(projectRoot, "worktree");
  fs.mkdirSync(worktreeDir, { recursive: true });

  const db = new DatabaseSync(path.join(adeDir, "ade.db"));
  db.exec(`
    create table lanes (
      id text primary key,
      name text not null,
      color text,
      icon text,
      lane_type text,
      branch_ref text,
      worktree_path text,
      attached_root_path text,
      status text,
      archived_at text,
      created_at text
    );
      create table terminal_sessions (
        id text primary key,
        lane_id text not null,
        chat_session_id text,
        tool_type text,
        title text,
        status text,
        last_output_preview text,
        last_output_at text,
        pinned integer,
        exit_code integer,
        started_at text,
        archived_at text,
        settled_at text,
        status_note text,
        attention_requested_at text,
        attention_message text,
        last_turn_failed_at text
      );
  `);

  const insertLane = db.prepare(
    `insert into lanes (id, name, color, icon, lane_type, branch_ref, worktree_path, attached_root_path, status, archived_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Primary lane (worktree == project root) — must sort first.
  insertLane.run("lane-primary", "main", "#fff", "star", "primary", "main", null, null, "active", null, "2026-01-01T00:00:00Z");
  // Worktree lane with an existing worktree dir.
  insertLane.run("lane-work", "feature", null, null, "worktree", "feat", worktreeDir, null, "active", null, "2026-01-02T00:00:00Z");
  // Archived lane — filtered out.
  insertLane.run("lane-arch", "old", null, null, "worktree", "old", worktreeDir, null, "archived", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  // Worktree lane whose path is gone — filtered out.
  insertLane.run("lane-gone", "ghost", null, null, "worktree", "ghost", path.join(projectRoot, "missing"), null, "active", null, "2026-01-01T00:00:00Z");

  const insertChat = db.prepare(
    `insert into terminal_sessions (id, lane_id, chat_session_id, tool_type, title, status, last_output_preview, last_output_at, pinned, exit_code, started_at, archived_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const longPreview = "x".repeat(130);
  // Chat in primary lane, DB says running but no live runtime → idle.
  insertChat.run("chat-run", "lane-primary", null, "claude-chat", "Running chat", "running", longPreview, "2026-01-02T00:00:00Z", 1, null, "2026-01-02T00:00:00Z", null);
  // Chat awaiting input (from sidecar) — attention.
  insertChat.run("chat-await", "lane-primary", null, "cursor", "Awaiting chat", "running", "needs input", "2026-01-03T00:00:00Z", 0, null, "2026-01-03T00:00:00Z", null);
  // Standalone CLI session without a parent chat — a real hub entry (failed).
  insertChat.run("cli-fail", "lane-work", null, "shell", "Build", "ended", "boom", "2026-01-01T12:00:00Z", 0, 1, "2026-01-01T00:00:00Z", null);
  // CLI session that exited cleanly → ended; owned by chat-run for child shell grouping.
  insertChat.run("cli-end", "lane-work", "chat-run", "shell", "Lint", "ended", "ok", "2026-01-01T06:00:00Z", 0, 0, "2026-01-01T00:00:00Z", null);
  // Standalone tracked CLI session (raw provider tool type, e.g. `codex`) —
  // a real hub entry, not a chat: toolType passes through so the phone routes
  // it to the terminal surface.
  insertChat.run("cli-codex", "lane-work", null, "codex", "Codex CLI", "running", "cli", "2026-01-04T00:00:00Z", 0, null, "2026-01-04T00:00:00Z", null);
  // Run-owned infrastructure session — never a hub entry.
  insertChat.run("run-owned", "lane-work", null, "run-shell", "Dev server", "ended", "exited", "2026-01-04T06:00:00Z", 0, 0, "2026-01-04T00:00:00Z", null);
  // Archived chat — filtered out.
  insertChat.run("chat-arch", "lane-primary", null, "claude-chat", "Old", "ended", null, "2026-01-01T00:00:00Z", 0, 0, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  // Chat whose lane was filtered out — orphan, dropped.
  insertChat.run("chat-orphan", "lane-gone", null, "claude-chat", "Orphan", "running", null, "2026-01-05T00:00:00Z", 0, null, "2026-01-05T00:00:00Z", null);

  db.prepare(
    `
      update terminal_sessions
      set settled_at = ?, status_note = ?
      where id = ?
    `,
  ).run("2026-01-02T00:01:00Z", "Index complete", "chat-run");
  db.prepare(
    `
      update terminal_sessions
      set attention_requested_at = ?, attention_message = ?
      where id = ?
    `,
  ).run("2026-01-03T00:01:00Z", "Choose a release target", "chat-await");
  db.prepare(
    "update terminal_sessions set last_turn_failed_at = ? where id = ?",
  ).run("2026-01-01T12:01:00Z", "cli-fail");

  db.close();

  // Sidecar: marks chat-await as awaiting + carries provider/model.
  const sidecarDir = path.join(adeDir, "cache", "chat-sessions");
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(
    path.join(sidecarDir, "chat-await.json"),
    JSON.stringify({ provider: "cursor", model: "gpt-5", awaitingInput: true }),
  );
}

const projectRegistry = {
  list: () => [
    {
      projectId: PROJECT_ID,
      rootPath: projectRoot,
      displayName: "Test",
      lastOpenedAt: 1_700_000_000_000,
      catalogVisibility: "recent" as const,
    },
  ],
};

const unbootedScopes: RosterScopeRegistry = { getIfBooted: () => null };

function bootedScopes(
  liveSessions: RosterLiveSession[],
  livePtySessionIds: string[] = [],
): RosterScopeRegistry {
  const livePtyIds = new Set(livePtySessionIds);
  const scope: RosterBootedScope = {
    runtime: {
      agentChatService: { listSessions: async () => liveSessions },
      ptyService: { hasLivePty: (sessionId) => livePtyIds.has(sessionId) },
    },
  };
  return { getIfBooted: (id) => (id === PROJECT_ID ? Promise.resolve(scope) : null) };
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-roster-"));
  seedDatabase();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("buildRosterSnapshot", () => {
  it("includes the system host but excludes other system projects", async () => {
    const hostProjectId = "project_system_host";
    const registry = {
      list: () => [
        ...projectRegistry.list(),
        {
          projectId: hostProjectId,
          rootPath: projectRoot,
          displayName: "System host",
          lastOpenedAt: 1_800_000_000_000,
          catalogVisibility: "system" as const,
        },
        {
          projectId: "project_system_other",
          rootPath: projectRoot,
          displayName: "Other system project",
          lastOpenedAt: 1_900_000_000_000,
          catalogVisibility: "system" as const,
        },
      ],
    };

    const projects = await buildRosterSnapshot({
      projectRegistry: registry,
      scopeRegistry: unbootedScopes,
      hostProjectId,
    });

    expect(projects.map((project) => project.projectId)).toEqual([
      hostProjectId,
      PROJECT_ID,
    ]);
  });

  it("maps lanes and chats from disk for an un-booted project", async () => {
    const projects = await buildRosterSnapshot({ projectRegistry, scopeRegistry: unbootedScopes });
    expect(projects).toHaveLength(1);
    const project = projects[0]!;

    expect(project.projectId).toBe(PROJECT_ID);
    expect(project.booted).toBe(false);
    expect(project.lastOpenedAt).toBe(new Date(1_700_000_000_000).toISOString());

    // Archived + worktree-gone lanes are filtered; primary sorts first.
    expect(project.lanes.map((lane) => lane.id)).toEqual(["lane-primary", "lane-work"]);

    // Orphan, archived, and run-owned rows are dropped. Chats, child shells
    // owned by a visible chat, AND standalone CLI sessions (running or ended)
    // are all real entries, freshest-activity first.
    expect(project.chats.map((chat) => chat.id)).toEqual([
      "cli-codex",
      "chat-await",
      "chat-run",
      "cli-fail",
      "cli-end",
    ]);
  });

  it("maps disk status truthfully (running→idle, awaiting, failed) when un-booted", async () => {
    const projects = await buildRosterSnapshot({ projectRegistry, scopeRegistry: unbootedScopes });
    const byId = new Map(projects[0]!.chats.map((chat) => [chat.id, chat]));

    expect(byId.get("chat-run")!.status).toBe("ended"); // declared settled
    expect(byId.get("chat-await")!.status).toBe("awaiting");
    expect(byId.get("chat-await")!.awaitingInput).toBe(true);
    expect(byId.get("cli-end")!.status).toBe("ended");
    expect(byId.get("cli-fail")!.status).toBe("failed"); // ended with exit code 1
    expect(byId.get("cli-codex")!.status).toBe("idle"); // DB running, no live runtime
    expect(byId.get("cli-codex")!.toolType).toBe("codex"); // raw CLI toolType passes through

    expect(projects[0]!.runningCount).toBe(0);
    // Failed standalone CLI rows show their per-row status but never count
    // toward attention (which drives attention-first project sorting).
    expect(projects[0]!.attentionCount).toBe(1); // awaiting chat only
  });

  it("projects settled lifecycle fields and exit codes into the mobile roster", async () => {
    const projects = await buildRosterSnapshot({ projectRegistry, scopeRegistry: unbootedScopes });
    const byId = new Map(projects[0]!.chats.map((chat) => [chat.id, chat]));

    expect(byId.get("chat-run")).toMatchObject({
      settledAt: "2026-01-02T00:01:00Z",
      statusNote: "Index complete",
      exitCode: null,
    });
    expect(byId.get("chat-await")).toMatchObject({
      attentionRequestedAt: "2026-01-03T00:01:00Z",
      attentionMessage: "Choose a release target",
      status: "awaiting",
      awaitingInput: true,
    });
    expect(byId.get("cli-fail")).toMatchObject({
      lastTurnFailedAt: "2026-01-01T12:01:00Z",
      exitCode: 1,
    });
    expect(byId.get("cli-end")!.exitCode).toBe(0);
  });

  it("tolerates legacy project databases that omit settled lifecycle columns", async () => {
    const db = new DatabaseSync(path.join(projectRoot, ".ade", "ade.db"));
    for (const column of [
      "settled_at",
      "status_note",
      "attention_requested_at",
      "attention_message",
      "last_turn_failed_at",
    ]) {
      db.exec(`alter table terminal_sessions drop column ${column}`);
    }
    db.close();

    const projects = await buildRosterSnapshot({ projectRegistry, scopeRegistry: unbootedScopes });
    const chat = projects[0]!.chats.find((row) => row.id === "chat-run")!;
    expect(chat.settledAt).toBeNull();
    expect(chat.statusNote).toBeNull();
    expect(chat.attentionRequestedAt).toBeNull();
    expect(chat.attentionMessage).toBeNull();
    expect(chat.lastTurnFailedAt).toBeNull();
  });

  it("hard-truncates the preview to ~120 chars and reads sidecar provider/model", async () => {
    const projects = await buildRosterSnapshot({ projectRegistry, scopeRegistry: unbootedScopes });
    const byId = new Map(projects[0]!.chats.map((chat) => [chat.id, chat]));

    const preview = byId.get("chat-run")!.preview!;
    expect(preview.length).toBe(120);
    expect(preview.endsWith("…")).toBe(true);

    expect(byId.get("chat-await")!.provider).toBe("cursor");
    expect(byId.get("chat-await")!.model).toBe("gpt-5");
    expect(byId.get("chat-await")!.toolType).toBe("cursor");
    expect(byId.get("cli-end")!.chatSessionId).toBe("chat-run");
  });

  it("overlays live running/awaiting fidelity for a booted scope", async () => {
    const scopeRegistry = bootedScopes([
      { sessionId: "chat-run", status: "active", awaitingInput: false, provider: "claude", model: "opus" },
    ]);
    const projects = await buildRosterSnapshot({ projectRegistry, scopeRegistry, hostProjectId: PROJECT_ID });
    const project = projects[0]!;
    const byId = new Map(project.chats.map((chat) => [chat.id, chat]));

    expect(project.booted).toBe(true);
    expect(byId.get("chat-run")!.status).toBe("running");
    expect(byId.get("chat-run")!.provider).toBe("claude");
    expect(project.runningCount).toBe(1);
  });

  it("marks a CLI session running via the booted scope's live PTY table", async () => {
    const scopeRegistry = bootedScopes([], ["cli-codex"]);
    const projects = await buildRosterSnapshot({ projectRegistry, scopeRegistry, hostProjectId: PROJECT_ID });
    const byId = new Map(projects[0]!.chats.map((chat) => [chat.id, chat]));

    // Live PTY → running; a CLI row with no live PTY keeps its disk status.
    expect(byId.get("cli-codex")!.status).toBe("running");
    expect(byId.get("cli-fail")!.status).toBe("failed");
    expect(projects[0]!.runningCount).toBe(1);
  });

  it("resolves a registered foreign chat transcript path and rejects unsafe input", () => {
    const resolver = createForeignChatTranscriptResolver({ projectRegistry });
    const expectedDir = path.join(projectRoot, ".ade", "transcripts", "chat");

    // Registered project + safe session id → path inside the transcripts dir.
    expect(resolver.resolveTranscriptPath({ projectId: PROJECT_ID, sessionId: "chat-run" }))
      .toBe(path.join(expectedDir, "chat-run.jsonl"));
    // Resolvable by rootPath too.
    expect(resolver.resolveTranscriptPath({ projectRootPath: projectRoot, sessionId: "chat-run" }))
      .toBe(path.join(expectedDir, "chat-run.jsonl"));

    // Unknown project → null (not registered).
    expect(resolver.resolveTranscriptPath({ projectId: "project_unknown", sessionId: "chat-run" })).toBeNull();
    // No project reference → null.
    expect(resolver.resolveTranscriptPath({ sessionId: "chat-run" })).toBeNull();
    // Path-traversal / unsafe session ids → null (never touches the filesystem).
    expect(resolver.resolveTranscriptPath({ projectId: PROJECT_ID, sessionId: "../../etc/passwd" })).toBeNull();
    expect(resolver.resolveTranscriptPath({ projectId: PROJECT_ID, sessionId: "a/b" })).toBeNull();
    expect(resolver.resolveTranscriptPath({ projectId: PROJECT_ID, sessionId: "" })).toBeNull();
  });

  it("tolerates a project with no ADE database (empty lanes/chats)", async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-roster-empty-"));
    try {
      const registry = {
        list: () => [{
          projectId: "project_empty",
          rootPath: emptyRoot,
          displayName: "Empty",
          lastOpenedAt: 0,
          catalogVisibility: "recent" as const,
        }],
      };
      const projects = await buildRosterSnapshot({ projectRegistry: registry, scopeRegistry: unbootedScopes });
      expect(projects).toHaveLength(1);
      expect(projects[0]!.lanes).toEqual([]);
      expect(projects[0]!.chats).toEqual([]);
      expect(projects[0]!.lastOpenedAt).toBeNull();
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
