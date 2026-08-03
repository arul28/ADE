import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearOpenCodeBinaryCache } from "../opencode/openCodeBinaryManager";
import { discoverClaudeSessions } from "./discoverClaude";
import { discoverCodexSessions } from "./discoverCodex";
import { discoverCursorSessions } from "./discoverCursor";
import { discoverDroidSessions } from "./discoverDroid";
import { discoverOpenCodeSessions } from "./discoverOpenCode";
import { claudeProjectSlugForCwd, slashEscapedCwd } from "./discoveryUtils";
import { createExternalSessionsService } from "./externalSessionsService";

type DatabaseSyncConstructor = new (dbPath: string) => DatabaseSyncType;
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

let root: string;
let previousHome: string | undefined;
let previousPath: string | undefined;
let previousDisableBundledOpenCode: string | undefined;
let previousCodexHome: string | undefined;

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function touch(filePath: string, epochMs: number): void {
  const seconds = epochMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
}

function writeCursorStore(storePath: string, meta: Record<string, unknown>, padBytes = 0): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const db = new DatabaseSync(storePath);
  try {
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)")
      .run(Buffer.from(JSON.stringify(meta), "utf8").toString("hex"));
    if (padBytes > 0) {
      db.exec("CREATE TABLE pad (value TEXT)");
      db.prepare("INSERT INTO pad (value) VALUES (?)").run("x".repeat(padBytes));
    }
  } finally {
    db.close();
  }
}

function writeCursorChatMeta(sessionDir: string, meta: Record<string, unknown>): void {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify({ schemaVersion: 1, ...meta }), "utf8");
}

function cursorTranscriptPath(homeDir: string, projectSlug: string, id: string): string {
  return path.join(homeDir, ".cursor", "projects", projectSlug, "agent-transcripts", id, `${id}.jsonl`);
}

function cursorStoreDir(homeDir: string, cwd: string, id: string): string {
  return path.join(homeDir, ".cursor", "chats", createHash("md5").update(cwd).digest("hex"), id);
}

function codexRolloutPath(homeDir: string, id: string, day = "08"): string {
  return path.join(homeDir, ".codex", "sessions", "2026", "07", day, `rollout-2026-07-${day}T10-00-00-${id}.jsonl`);
}

function writeCodexRollout(filePath: string, meta: Record<string, unknown>, rows: unknown[] = []): void {
  writeJsonl(filePath, [{ type: "session_meta", payload: { source: "cli", originator: "codex-tui", ...meta } }, ...rows]);
}

function codexUserRow(message: string): unknown {
  return { type: "event_msg", payload: { type: "user_message", message } };
}

type CodexThreadFixture = {
  id: string;
  rolloutPath: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  source?: string;
  archived?: number;
  agentRole?: string | null;
  name?: string | null;
  title?: string;
  preview?: string;
  firstUserMessage?: string;
};

/** Mirrors the columns `discoverCodex` reads from a real `~/.codex/state_5.sqlite`. */
function writeCodexStateDb(
  homeDir: string,
  threads: CodexThreadFixture[],
  spawnEdges: Array<{ parent: string; child: string }> = [],
): void {
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        agent_role TEXT,
        name TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        preview TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    const insertThread = db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, cwd, title, archived,
        agent_role, name, created_at_ms, updated_at_ms, preview, first_user_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const thread of threads) {
      insertThread.run(
        thread.id,
        thread.rolloutPath,
        Math.floor(thread.createdAtMs / 1000),
        Math.floor(thread.updatedAtMs / 1000),
        thread.source ?? "cli",
        thread.cwd,
        thread.title ?? "",
        thread.archived ?? 0,
        thread.agentRole ?? null,
        thread.name ?? null,
        thread.createdAtMs,
        thread.updatedAtMs,
        thread.preview ?? "",
        thread.firstUserMessage ?? "",
      );
    }
    const insertEdge = db.prepare(
      "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)",
    );
    for (const edge of spawnEdges) insertEdge.run(edge.parent, edge.child, "closed");
  } finally {
    db.close();
  }
}

function appendLargeCodexAgentMessage(filePath: string, messageBytes: number): void {
  const fd = fs.openSync(filePath, "a");
  const chunk = Buffer.alloc(1024 * 1024, 0x78);
  try {
    fs.writeSync(fd, '{"type":"event_msg","payload":{"type":"agent_message","message":"');
    let remaining = messageBytes;
    while (remaining > 0) {
      const bytesToWrite = Math.min(remaining, chunk.length);
      fs.writeSync(fd, chunk, 0, bytesToWrite);
      remaining -= bytesToWrite;
    }
    fs.writeSync(fd, '"}}\n');
  } finally {
    fs.closeSync(fd);
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-external-discovery-"));
  previousHome = process.env.HOME;
  previousPath = process.env.PATH;
  previousDisableBundledOpenCode = process.env.ADE_DISABLE_BUNDLED_OPENCODE;
  previousCodexHome = process.env.CODEX_HOME;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }
  if (previousDisableBundledOpenCode === undefined) {
    delete process.env.ADE_DISABLE_BUNDLED_OPENCODE;
  } else {
    process.env.ADE_DISABLE_BUNDLED_OPENCODE = previousDisableBundledOpenCode;
  }
  if (previousCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
  clearOpenCodeBinaryCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("external session provider discovery", () => {
  it("discovers Claude sessions without exposing local command wrappers", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const id = "11111111-1111-4111-8111-111111111111";
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(cwd), `${id}.jsonl`), [
      { type: "mode", sessionId: id, cwd, entrypoint: "cli" },
      {
        type: "user",
        sessionId: id,
        cwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        isMeta: true,
        message: { role: "user", content: [{ type: "text", text: "<local-command-caveat>Caveat: local commands are synthetic</local-command-caveat>" }] },
      },
      {
        type: "user",
        sessionId: id,
        cwd,
        isMeta: true,
        message: { role: "user", content: [{ type: "text", text: "<command-name>/model</command-name><command-args>opus</command-args>" }] },
      },
      {
        type: "user",
        sessionId: id,
        cwd,
        isMeta: true,
        message: { role: "user", content: [{ type: "text", text: "<local-command-stdout>Set model to opus</local-command-stdout>" }] },
      },
      {
        type: "user",
        sessionId: id,
        cwd,
        timestamp: "2026-07-06T10:01:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "this is a test message" }] },
      },
      { type: "assistant", sessionId: id, cwd, message: { role: "assistant", content: "Understood." } },
      {
        type: "user",
        sessionId: id,
        cwd,
        timestamp: "2026-07-06T10:02:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "this is a test message" }] },
      },
      { type: "ai-title", sessionId: id, aiTitle: "Test message" },
    ]);

    const sessions = await discoverClaudeSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "claude",
      id,
      cwd,
      title: "Test message",
      preview: "this is a test message",
      messages: [
        { role: "user", text: "/model", at: null },
        {
          role: "user",
          text: "this is a test message",
          at: Date.parse("2026-07-06T10:01:00.000Z"),
        },
        { role: "assistant", text: "Understood.", at: null },
        {
          role: "user",
          text: "this is a test message",
          at: Date.parse("2026-07-06T10:02:00.000Z"),
        },
      ],
      createdAt: Date.parse("2026-07-06T10:00:00.000Z"),
    });
    expect(sessions[0]?.messageCount).toBe(2);
  });

  it("never sources a Claude first prompt or preview from suffix-only records", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const id = "12121212-1212-4212-8212-121212121212";
    const rows = [
      { type: "system", sessionId: id, cwd, entrypoint: "cli" },
      ...Array.from({ length: 79 }, (_, index) => ({
        type: "user",
        sessionId: id,
        cwd,
        isMeta: true,
        message: { role: "user", content: `metadata ${index}` },
      })),
      {
        type: "user",
        sessionId: id,
        cwd,
        timestamp: "2026-07-06T10:01:00.000Z",
        message: { role: "user", content: "tail-only background completion" },
      },
    ];
    writeJsonl(
      path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(cwd), `${id}.jsonl`),
      rows,
    );

    const [session] = await discoverClaudeSessions({ homeDir, limit: 1 });

    expect(session).toMatchObject({
      id,
      preview: null,
      messages: [{
        role: "user",
        text: "tail-only background completion",
        at: Date.parse("2026-07-06T10:01:00.000Z"),
      }],
      messageCount: 1,
    });
  });

  it("keeps recoverable assistant context when the semantic prompt count is zero", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const id = "13131313-1313-4313-8313-131313131313";
    writeJsonl(
      path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(cwd), `${id}.jsonl`),
      [
        { type: "system", sessionId: id, cwd, entrypoint: "cli" },
        {
          type: "user",
          sessionId: id,
          cwd,
          message: {
            role: "user",
            content: "<command-name>/model</command-name><command-args>opus</command-args>",
          },
        },
        {
          type: "assistant",
          sessionId: id,
          cwd,
          timestamp: "2026-07-06T10:02:00.000Z",
          message: { role: "assistant", content: "The model is now Opus." },
        },
      ],
    );

    const [session] = await discoverClaudeSessions({ homeDir, limit: 1 });

    expect(session).toMatchObject({
      id,
      preview: null,
      messageCount: 0,
      messages: [
        { role: "user", text: "/model", at: null },
        {
          role: "assistant",
          text: "The model is now Opus.",
          at: Date.parse("2026-07-06T10:02:00.000Z"),
        },
      ],
    });
  });

  it("excludes Claude SDK sessions without starving older resumable CLI results", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const sdkId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cliId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const projectDir = path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(cwd));
    const sdkPath = path.join(projectDir, `${sdkId}.jsonl`);
    const cliPath = path.join(projectDir, `${cliId}.jsonl`);
    writeJsonl(sdkPath, [
      { type: "system", sessionId: sdkId, cwd, entrypoint: "sdk-ts" },
      { type: "user", sessionId: sdkId, cwd, message: { role: "user", content: "newer SDK row" } },
    ]);
    writeJsonl(cliPath, [
      { type: "system", sessionId: cliId, cwd, entrypoint: "cli" },
      { type: "user", sessionId: cliId, cwd, message: { role: "user", content: "older CLI row" } },
    ]);
    fs.utimesSync(cliPath, new Date("2026-07-05T10:00:00.000Z"), new Date("2026-07-05T10:00:00.000Z"));
    fs.utimesSync(sdkPath, new Date("2026-07-06T10:00:00.000Z"), new Date("2026-07-06T10:00:00.000Z"));

    const sessions = await discoverClaudeSessions({ homeDir, limit: 1 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: cliId, preview: "older CLI row" });
    expect(sessions.some((session) => session.id === sdkId)).toBe(false);
  });

  it("limits Claude content reads to the newest stat candidates", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const newerId = "11111111-1111-4111-8111-111111111111";
    const olderId = "22222222-2222-4222-8222-222222222222";
    const projectDir = path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(cwd));
    const newerPath = path.join(projectDir, `${newerId}.jsonl`);
    const olderPath = path.join(projectDir, `${olderId}.jsonl`);
    writeJsonl(newerPath, [
      { type: "message", sessionId: newerId, cwd, message: { role: "user", content: "newer request" } },
    ]);
    writeJsonl(olderPath, [
      { type: "message", sessionId: olderId, cwd, message: { role: "user", content: "older request" } },
    ]);
    fs.utimesSync(olderPath, new Date("2026-07-05T10:00:00.000Z"), new Date("2026-07-05T10:00:00.000Z"));
    fs.utimesSync(newerPath, new Date("2026-07-06T10:00:00.000Z"), new Date("2026-07-06T10:00:00.000Z"));

    const openSync = vi.spyOn(fs, "openSync");
    let openedPaths: string[] = [];
    try {
      const sessions = await discoverClaudeSessions({ homeDir, limit: 1 });
      expect(sessions.map((session) => session.id)).toEqual([newerId]);
      openedPaths = openSync.mock.calls.map((call) => String(call[0]));
    } finally {
      openSync.mockRestore();
    }

    expect(openedPaths).toContain(newerPath);
    expect(openedPaths).not.toContain(olderPath);
  });

  it("discovers Codex rollout files and enriches titles from session_index.jsonl", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const id = "22222222-2222-4222-8222-222222222222";
    fs.mkdirSync(cwd, { recursive: true });
    writeJsonl(path.join(homeDir, ".codex", "session_index.jsonl"), [
      { id, thread_name: "Investigate flaky test", updated_at: "2026-07-06T11:00:00.000Z" },
    ]);
    const rolloutPath = path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-2026-07-06T10-00-00-${id}.jsonl`);
    writeJsonl(rolloutPath, [
      {
        timestamp: "2026-07-06T10:00:00.000Z",
        type: "session_meta",
        payload: { id, session_id: id, cwd, timestamp: "2026-07-06T10:00:00.000Z", source: "cli", originator: "codex-tui" },
      },
      {
        timestamp: "2026-07-06T10:00:10.000Z",
        type: "turn_context",
        payload: {
          model: "gpt-5.6-sol",
          effort: "max",
          service_tier: "fast",
          approval_policy: "never",
          sandbox_policy: { type: "danger-full-access" },
        },
      },
      { timestamp: "2026-07-06T10:00:30.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>synthetic</environment_context>" }] } },
      { timestamp: "2026-07-06T10:01:00.000Z", type: "event_msg", payload: { type: "user_message", message: "please fix flakes" } },
    ]);
    fs.utimesSync(rolloutPath, new Date("2026-07-06T10:30:00.000Z"), new Date("2026-07-06T10:30:00.000Z"));

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "codex",
      id,
      cwd,
      title: "Investigate flaky test",
      preview: "please fix flakes",
      messages: [{
        role: "user",
        text: "please fix flakes",
        at: Date.parse("2026-07-06T10:01:00.000Z"),
      }],
      updatedAt: Date.parse("2026-07-06T11:00:00.000Z"),
      messageCount: 1,
      launch: {
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        fastMode: true,
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      },
    });
  });
  it("treats the Codex state DB as the top-level authority and falls back when it is unusable", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const parentId = "31000000-0000-4000-8000-000000000000";
    const childId = "31000000-0000-4000-8000-000000000001";
    const parentPath = codexRolloutPath(homeDir, parentId);
    const childPath = codexRolloutPath(homeDir, childId);
    // The spawned child's own session_meta carries no parent marker at all —
    // only `thread_spawn_edges` knows it is a subagent.
    writeCodexRollout(parentPath, { id: parentId, cwd }, [codexUserRow("parent request")]);
    writeCodexRollout(childPath, { id: childId, cwd }, [codexUserRow("worker request")]);
    const base = Date.parse("2026-07-08T10:00:00.000Z");
    writeCodexStateDb(homeDir, [
      { id: parentId, rolloutPath: parentPath, cwd, createdAtMs: base, updatedAtMs: base + 60_000 },
      { id: childId, rolloutPath: childPath, cwd, createdAtMs: base + 10_000, updatedAtMs: base + 20_000 },
    ], [{ parent: parentId, child: childId }]);

    await expect(discoverCodexSessions({ homeDir, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: parentId, cwd, preview: "parent request" }),
    ]);

    fs.writeFileSync(path.join(homeDir, ".codex", "state_5.sqlite"), "not a database", "utf8");
    const warn = vi.fn();
    const sessions = await discoverCodexSessions({ homeDir, limit: 10, logger: { warn } });

    // Without the DB the file scan cannot tell the two apart, which is exactly
    // the leak the state DB closes.
    expect(sessions.map((session) => session.id).sort()).toEqual([parentId, childId].sort());
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^external_sessions\.(sqlite_db_unavailable|codex_state_db_query_failed)$/u),
      expect.anything(),
    );
  });

  it("falls back to the rollout scan when the state DB exists but holds no threads", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = "38000000-0000-4000-8000-000000000000";
    writeCodexRollout(codexRolloutPath(homeDir, sessionId), { id: sessionId, cwd }, [
      codexUserRow("survived the migration"),
    ]);
    // A freshly-migrated or truncated state_5.sqlite knows about nothing; the
    // rollout tree is still the user's session history.
    writeCodexStateDb(homeDir, []);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([sessionId]);
  });

  it("hides a forked Codex parent that recorded no activity after the fork", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const parentId = "32000000-0000-4000-8000-000000000000";
    const forkId = "32000000-0000-4000-8000-000000000001";
    const parentPath = codexRolloutPath(homeDir, parentId);
    const forkPath = codexRolloutPath(homeDir, forkId);
    const base = Date.parse("2026-07-08T10:00:00.000Z");
    writeCodexRollout(parentPath, { id: parentId, cwd }, [codexUserRow("original request")]);
    // A fork replays the parent transcript, so the parent's own session_meta
    // reappears below line 1 and must not be mistaken for this rollout's.
    writeCodexRollout(forkPath, { id: forkId, cwd, forked_from_id: parentId }, [
      { type: "session_meta", payload: { id: parentId, cwd, source: "cli", originator: "codex-tui" } },
      codexUserRow("original request"),
      codexUserRow("continue from here"),
    ]);
    writeCodexStateDb(homeDir, [
      { id: parentId, rolloutPath: parentPath, cwd, createdAtMs: base, updatedAtMs: base + 60_000 },
      { id: forkId, rolloutPath: forkPath, cwd, createdAtMs: base + 60_000, updatedAtMs: base + 120_000 },
    ]);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([forkId]);
  });

  it("keeps a forked Codex parent that kept going after the fork", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const parentId = "33000000-0000-4000-8000-000000000000";
    const forkId = "33000000-0000-4000-8000-000000000001";
    const parentPath = codexRolloutPath(homeDir, parentId);
    const forkPath = codexRolloutPath(homeDir, forkId);
    const base = Date.parse("2026-07-08T10:00:00.000Z");
    writeCodexRollout(parentPath, { id: parentId, cwd }, [codexUserRow("original request")]);
    writeCodexRollout(forkPath, { id: forkId, cwd, forked_from_id: parentId }, [codexUserRow("branch request")]);
    writeCodexStateDb(homeDir, [
      { id: parentId, rolloutPath: parentPath, cwd, createdAtMs: base, updatedAtMs: base + 600_000 },
      { id: forkId, rolloutPath: forkPath, cwd, createdAtMs: base + 60_000, updatedAtMs: base + 120_000 },
    ]);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions.map((session) => session.id).sort()).toEqual([parentId, forkId].sort());
  });

  it("keeps a Codex parent whose only fork is itself filtered out of the list", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const parentId = "37000000-0000-4000-8000-000000000000";
    const forkId = "37000000-0000-4000-8000-000000000001";
    const parentPath = codexRolloutPath(homeDir, parentId);
    const forkPath = codexRolloutPath(homeDir, forkId);
    const base = Date.parse("2026-07-08T10:00:00.000Z");
    writeCodexRollout(parentPath, { id: parentId, cwd }, [codexUserRow("original request")]);
    // ADE's own chats fork Codex threads; that fork is never listed here, so
    // collapsing the parent into it would drop the conversation entirely.
    writeCodexRollout(forkPath, { id: forkId, cwd, source: "vscode", originator: "ade_desktop", forked_from_id: parentId }, [
      codexUserRow("continued inside ADE"),
    ]);
    writeCodexStateDb(homeDir, [
      { id: parentId, rolloutPath: parentPath, cwd, createdAtMs: base, updatedAtMs: base + 60_000 },
      { id: forkId, rolloutPath: forkPath, cwd, source: "vscode", createdAtMs: base + 60_000, updatedAtMs: base + 120_000 },
    ]);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([parentId]);
  });

  it("keeps a Codex parent whose only fork is originator-filtered", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const parentId = "3a000000-0000-4000-8000-000000000000";
    const forkId = "3a000000-0000-4000-8000-000000000001";
    const parentPath = codexRolloutPath(homeDir, parentId);
    const forkPath = codexRolloutPath(homeDir, forkId);
    const base = Date.parse("2026-07-08T10:00:00.000Z");
    writeCodexRollout(parentPath, { id: parentId, cwd }, [codexUserRow("original request")]);
    // Source `cli` passes every DB-level check, so this fork is only rejected
    // once its rollout's originator is read — after the point where a fork
    // registers its claim on the parent.
    writeCodexRollout(forkPath, { id: forkId, cwd, originator: "ade_desktop", forked_from_id: parentId }, [
      codexUserRow("continued inside ADE"),
    ]);
    writeCodexStateDb(homeDir, [
      { id: parentId, rolloutPath: parentPath, cwd, createdAtMs: base, updatedAtMs: base + 60_000 },
      { id: forkId, rolloutPath: forkPath, cwd, createdAtMs: base + 60_000, updatedAtMs: base + 120_000 },
    ]);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([parentId]);
  });

  it("carries a whole Codex fork chain onto the surviving thread", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const rootId = "3b000000-0000-4000-8000-000000000000";
    const middleId = "3b000000-0000-4000-8000-000000000001";
    const leafId = "3b000000-0000-4000-8000-000000000002";
    const rootPath = codexRolloutPath(homeDir, rootId);
    const middlePath = codexRolloutPath(homeDir, middleId);
    const leafPath = codexRolloutPath(homeDir, leafId);
    const base = Date.parse("2026-07-08T10:00:00.000Z");
    writeCodexRollout(rootPath, { id: rootId, cwd }, [codexUserRow("original request")]);
    writeCodexRollout(middlePath, { id: middleId, cwd, forked_from_id: rootId }, [codexUserRow("first branch")]);
    writeCodexRollout(leafPath, { id: leafId, cwd, forked_from_id: middleId }, [codexUserRow("second branch")]);
    writeCodexStateDb(homeDir, [
      { id: rootId, rolloutPath: rootPath, cwd, createdAtMs: base, updatedAtMs: base + 60_000 },
      { id: middleId, rolloutPath: middlePath, cwd, createdAtMs: base + 60_000, updatedAtMs: base + 120_000 },
      { id: leafId, rolloutPath: leafPath, cwd, createdAtMs: base + 120_000, updatedAtMs: base + 180_000 },
    ]);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    // Each fork stopped its parent, so one row survives — and it has to answer
    // for every id in the chain, or an import made against the original loses
    // its badge and the original can be hidden as an ADE-created artifact.
    expect(sessions.map((session) => session.id)).toEqual([leafId]);
    expect([...(sessions[0]?.lineageIds ?? [])].sort()).toEqual([middleId, rootId].sort());
  });

  it("scopes Codex discovery by state DB cwd without reading out-of-scope rollouts", async () => {
    const homeDir = path.join(root, "home");
    const projectCwd = path.join(root, "repo");
    const otherCwd = path.join(root, "other-repo");
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(otherCwd, { recursive: true });
    const insideId = "34000000-0000-4000-8000-000000000000";
    const outsideId = "34000000-0000-4000-8000-000000000001";
    const insidePath = codexRolloutPath(homeDir, insideId, "07");
    const outsidePath = codexRolloutPath(homeDir, outsideId, "08");
    writeCodexRollout(insidePath, { id: insideId, cwd: projectCwd }, [codexUserRow("inside project")]);
    writeCodexRollout(outsidePath, { id: outsideId, cwd: otherCwd }, [codexUserRow("outside project")]);
    const base = Date.parse("2026-07-08T10:00:00.000Z");
    writeCodexStateDb(homeDir, [
      { id: insideId, rolloutPath: insidePath, cwd: projectCwd, createdAtMs: base, updatedAtMs: base + 1_000 },
      { id: outsideId, rolloutPath: outsidePath, cwd: otherCwd, createdAtMs: base, updatedAtMs: base + 900_000 },
    ]);

    const openSync = vi.spyOn(fs, "openSync");
    let openedPaths: string[] = [];
    try {
      await expect(discoverCodexSessions({ homeDir, limit: 10, scopeRoots: [projectCwd] })).resolves.toEqual([
        expect.objectContaining({ id: insideId, cwd: projectCwd, preview: "inside project" }),
      ]);
      openedPaths = openSync.mock.calls.map((call) => String(call[0]));
    } finally {
      openSync.mockRestore();
    }
    expect(openedPaths).not.toContain(outsidePath);
  });

  it("lists Codex rollouts with an unrecognized source instead of dropping them", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const id = "35000000-0000-4000-8000-000000000000";
    const rolloutPath = codexRolloutPath(homeDir, id);
    writeCodexRollout(rolloutPath, { id, cwd, source: "wingman" }, [codexUserRow("new entrypoint")]);
    const base = Date.parse("2026-07-08T10:00:00.000Z");
    writeCodexStateDb(homeDir, [
      { id, rolloutPath, cwd, source: "wingman", createdAtMs: base, updatedAtMs: base + 1_000 },
    ]);
    const warn = vi.fn();

    await expect(discoverCodexSessions({ homeDir, limit: 10, logger: { warn } })).resolves.toEqual([
      expect.objectContaining({ id, preview: "new entrypoint" }),
    ]);
    expect(warn).toHaveBeenCalledWith("external_sessions.codex_unknown_source", { source: "wingman" });
  });

  it("lists Codex threads whose rollout file is compressed or missing", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const compressedId = "36000000-0000-4000-8000-000000000000";
    const danglingId = "36000000-0000-4000-8000-000000000001";
    const compressedPath = `${codexRolloutPath(homeDir, compressedId)}.zst`;
    const danglingPath = codexRolloutPath(homeDir, danglingId);
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(compressedPath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    const base = Date.parse("2026-07-08T10:00:00.000Z");
    fs.utimesSync(compressedPath, new Date(base + 200_000), new Date(base + 200_000));
    writeCodexStateDb(homeDir, [
      {
        id: compressedId,
        rolloutPath: compressedPath,
        cwd,
        createdAtMs: base,
        updatedAtMs: base + 200_000,
        preview: "archived to zstd",
      },
      {
        id: danglingId,
        rolloutPath: danglingPath,
        cwd,
        createdAtMs: base,
        updatedAtMs: base + 100_000,
        firstUserMessage: "rollout file is gone",
      },
    ]);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions).toEqual([
      expect.objectContaining({ id: compressedId, cwd, preview: "archived to zstd", updatedAt: base + 200_000 }),
      expect.objectContaining({ id: danglingId, cwd, preview: "rollout file is gone", updatedAt: base + 100_000 }),
    ]);
  });

  it("excludes Codex subagent rollouts with object-shaped source metadata", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const parentId = "27000000-0000-4000-8000-000000000000";
    const subagentId = "27000000-0000-4000-8000-000000000001";
    fs.mkdirSync(cwd, { recursive: true });
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "08", `rollout-${parentId}.jsonl`), [
      {
        type: "session_meta",
        payload: { id: parentId, cwd, source: "cli", originator: "codex-tui" },
      },
      { type: "event_msg", payload: { type: "user_message", message: "parent request" } },
    ]);
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "08", `rollout-${subagentId}.jsonl`), [
      {
        type: "session_meta",
        payload: {
          id: subagentId,
          cwd,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentId,
                depth: 1,
                agent_path: "/root/reviewer",
              },
            },
          },
          originator: "codex-tui",
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: "worker request" } },
    ]);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "codex",
      id: parentId,
      cwd,
      preview: "parent request",
    });
    expect(sessions.some((session) => session.id === subagentId)).toBe(false);
  });

  it("finds and merges the latest Codex turn context beyond a 2 MiB tail", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const id = "24242424-2424-4242-8242-242424242424";
    const prefixFiller = Array.from({ length: 90 }, (_, index) => ({
      type: "event_msg",
      payload: { type: "agent_message", message: `prefix-filler-${index}` },
    }));
    const filler = [{
      type: "event_msg",
      payload: { type: "agent_message", message: `oversized-filler-${"x".repeat(3 * 1024 * 1024)}` },
    }];
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-${id}.jsonl`), [
      {
        type: "session_meta",
        payload: { id, cwd, source: "cli", originator: "codex-tui" },
      },
      {
        type: "turn_context",
        payload: {
          model: "gpt-5.4",
          effort: "low",
          service_tier: "default",
          approval_policy: "on-request",
          sandbox_policy: { type: "read-only" },
        },
      },
      ...prefixFiller,
      {
        type: "turn_context",
        payload: {
          model: "gpt-5.6-sol",
          service_tier: "priority",
        },
      },
      ...filler,
    ]);

    const [broad] = await discoverCodexSessions({ homeDir, limit: 10 });
    expect(broad?.launch).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "low",
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
    });

    const [exact] = await discoverCodexSessions({ homeDir, sessionId: id, limit: 1 });
    expect(exact?.launch).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      fastMode: null,
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });
  });

  it("retains only non-security Codex preferences when a large final record truncates exact tail recovery", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const id = "25252525-2525-4252-8252-252525252525";
    const rolloutPath = path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-${id}.jsonl`);
    writeJsonl(rolloutPath, [
      {
        type: "session_meta",
        payload: { id, cwd, source: "cli", originator: "codex-tui" },
      },
      {
        type: "turn_context",
        payload: {
          model: "gpt-5.6-sol",
          effort: "high",
          service_tier: "fast",
          approval_policy: "never",
          sandbox_policy: { type: "danger-full-access" },
        },
      },
    ]);
    appendLargeCodexAgentMessage(rolloutPath, 65 * 1024 * 1024);
    const warn = vi.fn();

    const [exact] = await discoverCodexSessions({
      homeDir,
      sessionId: id,
      limit: 1,
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith("external_sessions.codex_launch_scan_truncated", expect.objectContaining({
      filePath: rolloutPath,
      bytesScanned: 64 * 1024 * 1024,
    }));
    expect(exact?.launch).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: true,
    });
  });

  it("prefers an explicit homeDir over process CODEX_HOME", async () => {
    const homeDir = path.join(root, "explicit-home");
    const cwd = path.join(root, "repo");
    const id = "23232323-2323-4232-8232-232323232323";
    process.env.CODEX_HOME = path.join(root, "ambient-codex-home");
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-${id}.jsonl`), [
      {
        timestamp: "2026-07-06T10:00:00.000Z",
        type: "session_meta",
        payload: { id, cwd, source: "cli", originator: "codex-tui" },
      },
      { type: "event_msg", payload: { type: "user_message", message: "use the explicit home" } },
    ]);

    await expect(discoverCodexSessions({ homeDir, sessionId: id, limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id, cwd, preview: "use the explicit home" }),
    ]);
  });

  it("does not derive Codex titles from the first user message", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const id = "55555555-5555-4555-8555-555555555555";
    fs.mkdirSync(cwd, { recursive: true });
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-2026-07-06T12-00-00-${id}.jsonl`), [
      {
        timestamp: "2026-07-06T12:00:00.000Z",
        type: "session_meta",
        payload: { id, session_id: id, cwd, timestamp: "2026-07-06T12:00:00.000Z" },
      },
      { timestamp: "2026-07-06T12:01:00.000Z", type: "event_msg", payload: { type: "message", role: "user", message: { content: "do not use this as a title" } } },
    ]);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "codex",
      id,
      title: null,
      preview: "do not use this as a title",
    });
  });

  it("does not fall back to synthetic Codex rows when canonical user rows are only notices", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const id = "77777777-7777-4777-8777-777777777777";
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-2026-07-06T13-00-00-${id}.jsonl`), [
      {
        timestamp: "2026-07-06T13:00:00.000Z",
        type: "session_meta",
        payload: { id, cwd, source: "cli", originator: "codex-tui" },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "synthetic environment" }] },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "<system-reminder>transport only</system-reminder>" },
      },
    ]);

    const [session] = await discoverCodexSessions({ homeDir, limit: 10 });
    expect(session).toMatchObject({ id, preview: null, messageCount: 0 });
  });

  it("discovers Cursor transcripts and resolves cwd from the project slug when possible", async () => {
    const homeDir = path.join(root, "home");
    // Cursor discovery de-slugs a project dir back to a real path via `/<slug with - → />`,
    // so the fixture cwd must actually exist AND be dash-free (a `-` would round-trip to `/`).
    // Use a writable temp dir (CI can't mkdir under /private/tmp) and derive the slug from it.
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adecursorcwd")));
    expect(cwd.includes("-"), "temp cwd must be dash-free for the cursor slug round-trip").toBe(false);
    const slug = cwd.replace(/^\/+/u, "").replace(/\//gu, "-");
    const agentId = "33333333-3333-4333-8333-333333333333";
    const sdkAgentId = "agent-44444444-4444-4444-8444-444444444444";
    writeJsonl(path.join(homeDir, ".cursor", "projects", slug, "agent-transcripts", agentId, `${agentId}.jsonl`), [
      { role: "user", message: { content: [{ type: "text", text: "Port this session into ADE" }] } },
    ]);
    writeJsonl(path.join(homeDir, ".cursor", "projects", slug, "agent-transcripts", sdkAgentId, `${sdkAgentId}.jsonl`), [
      { role: "user", message: { content: [{ type: "text", text: "SDK session should not be resumable" }] } },
    ]);

    const sessions = await discoverCursorSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "cursor",
      id: agentId,
      cwd,
      title: null,
      preview: "Port this session into ADE",
    });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("discovers current Cursor store.db sessions and merges legacy transcript details", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "cursor-project");
    const hash = createHash("md5").update(cwd).digest("hex");
    const agentId = "66666666-6666-4666-8666-666666666666";
    const projectDir = path.join(homeDir, ".cursor", "projects", "trusted-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".workspace-trusted"), JSON.stringify({ workspacePath: cwd }), "utf8");
    const storePath = path.join(homeDir, ".cursor", "chats", hash, agentId, "store.db");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const db = new DatabaseSync(storePath);
    try {
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const meta = Buffer.from(JSON.stringify({
        agentId,
        name: "Fix Cursor import",
        createdAt: "2026-07-06T10:00:00.000Z",
      }), "utf8").toString("hex");
      db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(meta);
    } finally {
      db.close();
    }
    writeJsonl(path.join(projectDir, "agent-transcripts", agentId, `${agentId}.jsonl`), [
      { role: "user", message: { content: [{ type: "text", text: "Preserve the transcript preview" }] } },
    ]);

    const sessions = await discoverCursorSessions({ homeDir, scopeRoots: [cwd], sessionId: agentId, limit: 1 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "cursor",
      id: agentId,
      cwd,
      title: "Fix Cursor import",
      preview: "Preserve the transcript preview",
      createdAt: Date.parse("2026-07-06T10:00:00.000Z"),
      messageCount: 1,
    });
  });

  it("discovers Droid sessions from Factory storage", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "droid-repo");
    const id = "44444444-4444-4444-8444-444444444444";
    writeJsonl(path.join(homeDir, ".factory", "sessions", slashEscapedCwd(cwd), `${id}.jsonl`), [
      { type: "session_start", id, title: "New Session", cwd },
      { type: "message", message: { role: "assistant", content: "untimestamped setup" } },
      { type: "message", timestamp: "2026-07-06T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Factory task title" }] } },
    ]);

    const sessions = await discoverDroidSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "droid",
      id,
      cwd,
      title: null,
      preview: "Factory task title",
      createdAt: Date.parse("2026-07-06T10:00:00.000Z"),
      messageCount: 1,
    });
  });

  it("keeps one Droid record when a session id appears under two escaped cwds", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "droid-dupe-repo");
    const nestedCwd = path.join(cwd, "apps");
    const id = "77777777-7777-4777-8777-777777777777";
    writeJsonl(path.join(homeDir, ".factory", "sessions", slashEscapedCwd(cwd), `${id}.jsonl`), [
      { type: "session_start", id, title: "Droid duplicate", cwd },
      { type: "message", timestamp: "2026-07-06T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "First prompt" }] } },
      { type: "message", timestamp: "2026-07-06T10:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "Second prompt" }] } },
    ]);
    writeJsonl(path.join(homeDir, ".factory", "sessions", slashEscapedCwd(nestedCwd), `${id}.jsonl`), [
      { type: "session_start", id, title: "Droid duplicate", cwd: nestedCwd },
    ]);

    const sessions = await discoverDroidSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id, cwd, messageCount: 2 });
  });

  it("scopes Droid session directories before the recent-session cut", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "droid-scoped-repo");
    const elsewhere = path.join(root, "droid-elsewhere");
    const inProjectId = "88888888-8888-4888-8888-888888888888";
    const inProjectPath = path.join(homeDir, ".factory", "sessions", slashEscapedCwd(cwd), `${inProjectId}.jsonl`);
    writeJsonl(inProjectPath, [
      { type: "session_start", id: inProjectId, title: "In project", cwd },
      { type: "message", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "In project prompt" }] } },
    ]);
    touch(inProjectPath, 1_780_000_000_000);
    // Newer sessions elsewhere: one batch under an escaped path that scope rules
    // out outright, one under a name that only the session's own cwd can place.
    for (let index = 0; index < 3; index += 1) {
      for (const directory of [slashEscapedCwd(elsewhere), "relative-elsewhere"]) {
        const id = `9999999${directory.length % 10}-9999-4999-8999-99999999999${index}`;
        const filePath = path.join(homeDir, ".factory", "sessions", directory, `${id}.jsonl`);
        writeJsonl(filePath, [
          { type: "session_start", id, title: "Elsewhere", cwd: elsewhere },
          { type: "message", timestamp: "2026-07-20T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: `Elsewhere prompt ${index}` }] } },
        ]);
        touch(filePath, 1_782_000_000_000 + index);
      }
    }

    const sessions = await discoverDroidSessions({ homeDir, scopeRoots: [cwd], limit: 1 });

    expect(sessions.map((session) => session.id)).toEqual([inProjectId]);
  });

  it("merges duplicate Cursor artifacts of one conversation instead of spending a session slot on each", async () => {
    const homeDir = path.join(root, "home");
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adecursordupe")));
    expect(cwd.includes("-"), "temp cwd must be dash-free for the cursor slug round-trip").toBe(false);
    const slug = cwd.replace(/^\/+/u, "").replace(/\//gu, "-");
    const olderId = "aaaaaaaa-1111-4111-8111-111111111111";
    const newerId = "bbbbbbbb-2222-4222-8222-222222222222";

    writeJsonl(cursorTranscriptPath(homeDir, slug, olderId), [
      { role: "user", message: { content: [{ type: "text", text: "Older conversation" }] } },
    ]);
    writeJsonl(cursorTranscriptPath(homeDir, slug, newerId), [
      { role: "user", message: { content: [{ type: "text", text: "Complete copy of the newer conversation" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "ack" }] } },
      { role: "user", message: { content: [{ type: "text", text: "second prompt" }] } },
    ]);
    // Cursor mirrors transcripts under `empty-window`, and that copy can be the
    // newer file while holding less of the conversation.
    writeJsonl(cursorTranscriptPath(homeDir, "empty-window", newerId), [
      { role: "user", message: { content: [{ type: "text", text: "Partial copy" }] } },
    ]);
    touch(cursorTranscriptPath(homeDir, slug, olderId), 1_780_000_000_000);
    touch(cursorTranscriptPath(homeDir, slug, newerId), 1_781_000_000_000);
    touch(cursorTranscriptPath(homeDir, "empty-window", newerId), 1_782_000_000_000);

    const sessions = await discoverCursorSessions({ homeDir, limit: 2 });

    expect(sessions.map((session) => session.id)).toEqual([newerId, olderId]);
    expect(sessions[0]).toMatchObject({
      cwd,
      preview: "Complete copy of the newer conversation",
      messageCount: 2,
    });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("picks the fullest Cursor store when one conversation spans two workspace buckets", async () => {
    const homeDir = path.join(root, "home");
    const primaryCwd = path.join(root, "cursor-primary");
    const resumedCwd = path.join(root, "cursor-resumed");
    const id = "cccccccc-3333-4333-8333-333333333333";
    const primaryDir = cursorStoreDir(homeDir, primaryCwd, id);
    const resumedDir = cursorStoreDir(homeDir, resumedCwd, id);

    writeCursorStore(path.join(primaryDir, "store.db"), { agentId: id, name: "Full conversation" }, 200 * 1024);
    writeCursorChatMeta(primaryDir, { cwd: primaryCwd });
    writeCursorStore(path.join(resumedDir, "store.db"), { agentId: id, name: "Empty resume stub" });
    writeCursorChatMeta(resumedDir, { cwd: resumedCwd });
    // Resuming elsewhere leaves the stub as the newer copy; only size tells them apart.
    for (const name of ["store.db", "meta.json"]) {
      touch(path.join(primaryDir, name), 1_781_000_000_000);
      touch(path.join(resumedDir, name), 1_782_000_000_000);
    }

    const sessions = await discoverCursorSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id, cwd: primaryCwd, title: "Full conversation" });
  });

  it("skips the Cursor session id that is reused across unrelated runs", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "cursor-sentinel");
    const sentinelId = "00000000-0000-4000-8000-000000000000";
    const realId = "dddddddd-4444-4444-8444-444444444444";
    for (const id of [sentinelId, realId]) {
      const sessionDir = cursorStoreDir(homeDir, cwd, id);
      writeCursorStore(path.join(sessionDir, "store.db"), { agentId: id, name: `Session ${id}` });
      writeCursorChatMeta(sessionDir, { cwd });
    }

    const sessions = await discoverCursorSessions({ homeDir, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([realId]);
  });

  it("discovers Cursor buckets whose cwd only meta.json records", async () => {
    const homeDir = path.join(root, "home");
    const repoRoot = path.join(root, "cursor-repo");
    const nestedCwd = path.join(repoRoot, "apps", "desktop");
    fs.mkdirSync(nestedCwd, { recursive: true });
    const id = "eeeeeeee-5555-4555-8555-555555555555";
    // Nothing under `.cursor/projects` names this cwd, so its md5 bucket cannot be
    // reversed; `meta.json` is the only record of where the session ran.
    const sessionDir = cursorStoreDir(homeDir, nestedCwd, id);
    writeCursorStore(path.join(sessionDir, "store.db"), { agentId: id, name: "Nested workspace session" });
    writeCursorChatMeta(sessionDir, { cwd: nestedCwd, title: "meta.json title" });

    const sessions = await discoverCursorSessions({ homeDir, scopeRoots: [repoRoot], limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id, cwd: nestedCwd, title: "Nested workspace session" });
  });

  it("reads in-project Cursor conversations before ones whose cwd nothing on disk confirms", async () => {
    const homeDir = path.join(root, "home");
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adecursorscope")));
    expect(repoRoot.includes("-"), "temp cwd must be dash-free for the cursor slug round-trip").toBe(false);
    const slug = repoRoot.replace(/^\/+/u, "").replace(/\//gu, "-");
    const inProjectId = "ffffffff-6666-4666-8666-666666666666";
    writeJsonl(cursorTranscriptPath(homeDir, slug, inProjectId), [
      { cwd: repoRoot, role: "user", message: { content: [{ type: "text", text: "In project prompt" }] } },
    ]);
    touch(cursorTranscriptPath(homeDir, slug, inProjectId), 1_780_000_000_000);
    // `empty-window` de-slugs to nothing, so scope can only be settled by opening
    // the transcript — which must never come at the cost of a confirmed match.
    for (let index = 0; index < 3; index += 1) {
      const id = `99999999-7777-4777-8777-77777777777${index}`;
      const filePath = cursorTranscriptPath(homeDir, "empty-window", id);
      writeJsonl(filePath, [
        { cwd: path.join(root, "cursor-elsewhere"), role: "user", message: { content: [{ type: "text", text: `Unresolvable ${index}` }] } },
      ]);
      touch(filePath, 1_782_000_000_000 + index);
    }

    const sessions = await discoverCursorSessions({ homeDir, scopeRoots: [repoRoot], limit: 1 });

    expect(sessions.map((session) => session.id)).toEqual([inProjectId]);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("uses the OpenCode CLI list command and reports an uninstalled CLI", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "opencode-repo");
    fs.mkdirSync(cwd, { recursive: true });
    process.env.ADE_DISABLE_BUNDLED_OPENCODE = "1";
    process.env.HOME = homeDir;
    process.env.PATH = path.join(root, "missing-bin");
    clearOpenCodeBinaryCache();
    // An empty list is what "no sessions yet" looks like, so a missing CLI has
    // to be distinguishable from it.
    await expect(discoverOpenCodeSessions({ homeDir, cwd, limit: 10 }))
      .rejects.toThrow(/OpenCode CLI not found/u);

    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const scriptPath = path.join(binDir, "opencode");
    fs.writeFileSync(
      scriptPath,
      `#!/bin/sh\nprintf '%s\\n' '[{"id":"open-1","directory":"${cwd}","title":"OpenCode task","created":1783332000000,"updated":1783332060000},{"id":"open-2","directory":"${cwd}","title":"New session - 2026-05-01T17:02:11.923Z","created":1783331000000,"updated":1783331060000},{"id":"open-3","title":"Missing cwd","created":1783330000000,"updated":1783330060000}]'\n`,
      "utf8",
    );
    fs.chmodSync(scriptPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    clearOpenCodeBinaryCache();

    const sessions = await discoverOpenCodeSessions({ homeDir, cwd, limit: 10 });

    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toMatchObject({
      provider: "opencode",
      id: "open-1",
      cwd,
      title: "OpenCode task",
      preview: null,
      messageCount: null,
    });
    expect(sessions[1]).toMatchObject({
      provider: "opencode",
      id: "open-2",
      cwd,
      title: null,
      preview: null,
      messageCount: null,
    });
    expect(sessions[2]).toMatchObject({
      provider: "opencode",
      id: "open-3",
      cwd: null,
      title: "Missing cwd",
    });
    await expect(discoverOpenCodeSessions({ homeDir, cwd, sessionId: "open-3", limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: "open-3", cwd: null, title: "Missing cwd" }),
    ]);
    await expect(discoverOpenCodeSessions({
      homeDir,
      cwd,
      scopeRoots: [cwd],
      sessionId: "open-3",
      limit: 1,
    })).resolves.toEqual([
      expect.objectContaining({ id: "open-3", cwd: path.resolve(cwd), title: "Missing cwd" }),
    ]);

    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot: cwd,
      homeDir,
      laneService: { getLaneWorktreePath: () => cwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const scopedSessions = await service.list({
      providers: ["opencode"],
      cwd,
      scope: "project",
      limit: 10,
    });
    expect(scopedSessions.find((session) => session.id === "open-3")).toMatchObject({
      cwd: fs.realpathSync(cwd),
      cwdMatchesRequestedLane: true,
      capabilities: {
        resumeInPlace: true,
        resumeInDifferentCwd: false,
        fork: true,
        forkIntoDifferentCwd: false,
        importToChat: false,
      },
    });

    const allSessions = await service.list({ providers: ["opencode"], scope: "all", limit: 10 });
    expect(allSessions.find((session) => session.id === "open-3")).toMatchObject({
      cwd: null,
      capabilities: {
        resumeInPlace: false,
        resumeInDifferentCwd: false,
        fork: false,
        forkIntoDifferentCwd: false,
        importToChat: false,
      },
    });

    fs.writeFileSync(scriptPath, "#!/bin/sh\nprintf '%s\\n' 'not-json'\n", "utf8");
    await expect(discoverOpenCodeSessions({ homeDir, cwd, limit: 10 }))
      .rejects.toThrow(/no JSON session list/i);
  });
});

// Claude chain-dedupe + classification suite (folded in from discoverClaude.test.ts
// during /test consolidation; fixtures are Claude-specific and scoped here).
describe("Claude session discovery", () => {
let claudeRoot: string;
let claudeHome: string;

type ClaudeRow = Record<string, unknown>;

function projectDirFor(cwd: string): string {
  return path.join(claudeHome, ".claude", "projects", claudeProjectSlugForCwd(cwd));
}

function writeSession(args: {
  cwd: string;
  id: string;
  rows: ClaudeRow[];
  mtime?: string;
}): string {
  const filePath = path.join(projectDirFor(args.cwd), `${args.id}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stamped = args.rows.map((row) => ({ ...row, sessionId: args.id }));
  fs.writeFileSync(filePath, stamped.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  if (args.mtime) fs.utimesSync(filePath, new Date(args.mtime), new Date(args.mtime));
  return filePath;
}

function userRow(args: {
  uuid: string;
  cwd: string;
  text: string;
  entrypoint?: string;
  ancestorSessionId?: string;
  padBytes?: number;
}): ClaudeRow {
  return {
    type: "user",
    uuid: args.uuid,
    cwd: args.cwd,
    entrypoint: args.entrypoint ?? "cli",
    ...(args.ancestorSessionId ? { session_id: args.ancestorSessionId } : {}),
    message: {
      role: "user",
      content: [{ type: "text", text: args.padBytes ? args.text + " " + "x".repeat(args.padBytes) : args.text }],
    },
  };
}

/** `<n>-1111-4111-8111-111111111111`-shaped ids keep fixtures readable. */
function uuidFor(prefix: string, index: number): string {
  return `${prefix.padEnd(8, "0")}-1111-4111-8111-${String(index).padStart(12, "0")}`;
}

function turns(args: { cwd: string; prefix: string; from: number; count: number; padBytes?: number }): ClaudeRow[] {
  return Array.from({ length: args.count }, (_, offset) => userRow({
    uuid: uuidFor(args.prefix, args.from + offset),
    cwd: args.cwd,
    text: `turn ${args.from + offset}`,
    padBytes: args.padBytes,
  }));
}

beforeEach(() => {
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-discover-claude-"));
  claudeHome = path.join(claudeRoot, "home");
});

afterEach(() => {
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe("Claude continuation-chain discovery", () => {
  it("collapses a continuation that was relocated to another project directory", async () => {
    const sourceCwd = path.join(claudeRoot, "repo");
    const movedCwd = path.join(claudeRoot, "moved");
    const ancestorId = uuidFor("aaaa", 1);
    const leafId = uuidFor("bbbb", 2);
    const shared = turns({ cwd: sourceCwd, prefix: "cccc", from: 0, count: 6 });

    writeSession({ cwd: sourceCwd, id: ancestorId, rows: shared, mtime: "2026-07-05T10:00:00.000Z" });
    writeSession({
      cwd: movedCwd,
      id: leafId,
      rows: [
        ...shared.map((row) => ({ ...row, cwd: movedCwd })),
        ...turns({ cwd: movedCwd, prefix: "dddd", from: 6, count: 4 }),
      ],
      mtime: "2026-07-06T10:00:00.000Z",
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([leafId]);
    expect(sessions[0]?.cwd).toBe(movedCwd);
  });

  it("reports the collapsed ancestor ids on the surviving leaf", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const ancestorId = uuidFor("aaaa", 1);
    const leafId = uuidFor("bbbb", 2);
    const shared = turns({ cwd, prefix: "cccc", from: 0, count: 6 });

    writeSession({ cwd, id: ancestorId, rows: shared, mtime: "2026-07-05T10:00:00.000Z" });
    writeSession({
      cwd,
      id: leafId,
      rows: [...shared, ...turns({ cwd, prefix: "dddd", from: 6, count: 4 })],
      mtime: "2026-07-06T10:00:00.000Z",
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    // A session imported under the ancestor id is this row; imported-marking
    // has no other way to know that once the ancestor stops being listed.
    expect(sessions.map((session) => session.id)).toEqual([leafId]);
    expect(sessions[0]?.lineageIds).toContain(ancestorId);
  });

  it("lists the leaf even when the ancestor file was touched more recently", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const ancestorId = uuidFor("aaaa", 1);
    const leafId = uuidFor("bbbb", 2);
    const shared = turns({ cwd, prefix: "cccc", from: 0, count: 6 });

    writeSession({ cwd, id: ancestorId, rows: shared, mtime: "2026-07-06T10:00:00.000Z" });
    writeSession({
      cwd,
      id: leafId,
      rows: [...shared, ...turns({ cwd, prefix: "dddd", from: 6, count: 4 })],
      mtime: "2026-07-05T10:00:00.000Z",
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([leafId]);
  });

  it("keeps both sides of a forked chain", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const originalId = uuidFor("aaaa", 1);
    const forkId = uuidFor("bbbb", 2);
    const shared = turns({ cwd, prefix: "cccc", from: 0, count: 5 });

    writeSession({
      cwd,
      id: originalId,
      rows: [...shared, ...turns({ cwd, prefix: "dddd", from: 5, count: 6 })],
      mtime: "2026-07-05T10:00:00.000Z",
    });
    writeSession({
      cwd,
      id: forkId,
      rows: [...shared, ...turns({ cwd, prefix: "eeee", from: 5, count: 3 })],
      mtime: "2026-07-06T10:00:00.000Z",
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    expect(sessions.map((session) => session.id).sort()).toEqual([originalId, forkId].sort());
  });

  it("keeps chain members that share only the final record", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const shorterId = uuidFor("aaaa", 1);
    const longerId = uuidFor("bbbb", 2);
    // Records are padded past the sampling windows so the middle of each file is
    // actually compared instead of both files fitting in one window.
    const head = turns({ cwd, prefix: "cccc", from: 0, count: 2, padBytes: 16 * 1024 });
    const sharedTail = userRow({ uuid: uuidFor("ffff", 99), cwd, text: "final turn", padBytes: 16 * 1024 });

    writeSession({
      cwd,
      id: shorterId,
      rows: [...head, ...turns({ cwd, prefix: "dddd", from: 2, count: 30, padBytes: 16 * 1024 }), sharedTail],
      mtime: "2026-07-05T10:00:00.000Z",
    });
    writeSession({
      cwd,
      id: longerId,
      rows: [...head, ...turns({ cwd, prefix: "eeee", from: 2, count: 40, padBytes: 16 * 1024 }), sharedTail],
      mtime: "2026-07-06T10:00:00.000Z",
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    expect(sessions.map((session) => session.id).sort()).toEqual([shorterId, longerId].sort());
  });

  it("does not treat an identical opening prompt as a shared chain", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const firstId = uuidFor("aaaa", 1);
    const secondId = uuidFor("bbbb", 2);
    const preamble = "You are running inside ADE. Follow the lane conventions.";

    writeSession({
      cwd,
      id: firstId,
      rows: [userRow({ uuid: uuidFor("cccc", 1), cwd, text: preamble })],
      mtime: "2026-07-05T10:00:00.000Z",
    });
    writeSession({
      cwd,
      id: secondId,
      rows: [userRow({ uuid: uuidFor("dddd", 1), cwd, text: preamble })],
      mtime: "2026-07-06T10:00:00.000Z",
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    expect(sessions.map((session) => session.id).sort()).toEqual([firstId, secondId].sort());
  });

  it("collapses a continuation linked only by a snake_case session_id pointer", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const ancestorId = uuidFor("aaaa", 1);
    const leafId = uuidFor("bbbb", 2);
    const shared = turns({ cwd, prefix: "cccc", from: 0, count: 4 });

    writeSession({ cwd, id: ancestorId, rows: shared, mtime: "2026-07-05T10:00:00.000Z" });
    writeSession({
      cwd,
      id: leafId,
      // A rewound continuation opens on a fresh record, so only the pointer links it.
      rows: [
        userRow({ uuid: uuidFor("eeee", 1), cwd, text: "resumed", ancestorSessionId: ancestorId }),
        ...shared,
        ...turns({ cwd, prefix: "dddd", from: 4, count: 3 }),
      ],
      mtime: "2026-07-06T10:00:00.000Z",
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([leafId]);
  });

  it("still resolves an ancestor by exact session id lookup", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const ancestorId = uuidFor("aaaa", 1);
    const leafId = uuidFor("bbbb", 2);
    const shared = turns({ cwd, prefix: "cccc", from: 0, count: 4 });

    writeSession({ cwd, id: ancestorId, rows: shared, mtime: "2026-07-05T10:00:00.000Z" });
    writeSession({
      cwd,
      id: leafId,
      rows: [...shared, ...turns({ cwd, prefix: "dddd", from: 4, count: 3 })],
      mtime: "2026-07-06T10:00:00.000Z",
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, sessionId: ancestorId, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([ancestorId]);
  });
});

describe("Claude transcript classification", () => {
  it("keeps a CLI session that picked up incidental SDK rows", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const id = uuidFor("aaaa", 1);

    writeSession({
      cwd,
      id,
      rows: [
        userRow({ uuid: uuidFor("cccc", 1), cwd, text: "started in the terminal" }),
        ...turns({ cwd, prefix: "dddd", from: 1, count: 4 }),
        userRow({ uuid: uuidFor("eeee", 1), cwd, text: "sdk driven turn", entrypoint: "sdk-ts" }),
      ],
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([id]);
  });

  it("excludes a wholly SDK-origin transcript", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const id = uuidFor("aaaa", 1);

    writeSession({
      cwd,
      id,
      rows: [
        { type: "queue-operation" },
        userRow({ uuid: uuidFor("cccc", 1), cwd, text: "ade chat turn", entrypoint: "sdk-ts" }),
        userRow({ uuid: uuidFor("dddd", 1), cwd, text: "ade chat reply", entrypoint: "sdk-ts" }),
      ],
    });

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    expect(sessions).toEqual([]);
  });

  it("ignores subagent transcripts nested under a session directory", async () => {
    const cwd = path.join(claudeRoot, "repo");
    const id = uuidFor("aaaa", 1);
    writeSession({ cwd, id, rows: turns({ cwd, prefix: "cccc", from: 0, count: 3 }) });

    const subagentDir = path.join(projectDirFor(cwd), id, "subagents");
    fs.mkdirSync(path.join(subagentDir, "workflows", "wf_6ba7d421-a8b"), { recursive: true });
    const subagentRows = [userRow({ uuid: uuidFor("dddd", 1), cwd, text: "subagent turn" })];
    for (const nested of [
      path.join(subagentDir, `agent-${uuidFor("eeee", 1)}.jsonl`),
      path.join(subagentDir, `${uuidFor("ffff", 1)}.jsonl`),
      path.join(subagentDir, "workflows", "wf_6ba7d421-a8b", `${uuidFor("ffff", 2)}.jsonl`),
    ]) {
      fs.writeFileSync(nested, subagentRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    }

    const sessions = await discoverClaudeSessions({ homeDir: claudeHome, limit: 10 });

    expect(sessions.map((session) => session.id)).toEqual([id]);
  });
});
});
