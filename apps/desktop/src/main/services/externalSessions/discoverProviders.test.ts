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
      createdAt: Date.parse("2026-07-06T10:00:00.000Z"),
    });
    expect(sessions[0]?.messageCount).toBe(2);
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
      updatedAt: Date.parse("2026-07-06T11:00:00.000Z"),
      messageCount: 1,
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

  it("uses the OpenCode CLI list command and skips cleanly when unavailable", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "opencode-repo");
    fs.mkdirSync(cwd, { recursive: true });
    process.env.ADE_DISABLE_BUNDLED_OPENCODE = "1";
    process.env.HOME = homeDir;
    process.env.PATH = path.join(root, "missing-bin");
    clearOpenCodeBinaryCache();
    await expect(discoverOpenCodeSessions({ homeDir, cwd, limit: 10 })).resolves.toEqual([]);

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
