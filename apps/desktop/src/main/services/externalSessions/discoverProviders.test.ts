import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearOpenCodeBinaryCache } from "../opencode/openCodeBinaryManager";
import { discoverClaudeSessions } from "./discoverClaude";
import { discoverCodexSessions } from "./discoverCodex";
import { discoverCursorSessions } from "./discoverCursor";
import { discoverDroidSessions } from "./discoverDroid";
import { discoverOpenCodeSessions } from "./discoverOpenCode";
import { claudeProjectSlugForCwd, slashEscapedCwd } from "./discoveryUtils";

let root: string;
let previousHome: string | undefined;
let previousPath: string | undefined;
let previousDisableBundledOpenCode: string | undefined;

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-external-discovery-"));
  previousHome = process.env.HOME;
  previousPath = process.env.PATH;
  previousDisableBundledOpenCode = process.env.ADE_DISABLE_BUNDLED_OPENCODE;
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
  clearOpenCodeBinaryCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("external session provider discovery", () => {
  it("discovers Claude sessions, recovers cwd, and uses the first user message as preview", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const id = "11111111-1111-4111-8111-111111111111";
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(cwd), `${id}.jsonl`), [
      { type: "mode", sessionId: id },
      {
        type: "message",
        sessionId: id,
        cwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "ADE session guidance.\n\nUser request: Fix login redirect" }] },
      },
    ]);

    const sessions = await discoverClaudeSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "claude",
      id,
      cwd,
      title: null,
      preview: "Fix login redirect",
      createdAt: Date.parse("2026-07-06T10:00:00.000Z"),
    });
    expect(sessions[0]?.messageCount).toBe(2);
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
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-2026-07-06T10-00-00-${id}.jsonl`), [
      {
        timestamp: "2026-07-06T10:00:00.000Z",
        type: "session_meta",
        payload: { id, session_id: id, cwd, timestamp: "2026-07-06T10:00:00.000Z" },
      },
      { timestamp: "2026-07-06T10:01:00.000Z", type: "event_msg", payload: { type: "message", role: "user", message: { content: "please fix flakes" } } },
    ]);

    const sessions = await discoverCodexSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "codex",
      id,
      cwd,
      title: "Investigate flaky test",
      preview: "please fix flakes",
      updatedAt: Date.parse("2026-07-06T11:00:00.000Z"),
    });
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

  it("discovers Droid sessions from Factory storage", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "droid-repo");
    const id = "44444444-4444-4444-8444-444444444444";
    writeJsonl(path.join(homeDir, ".factory", "sessions", slashEscapedCwd(cwd), `${id}.jsonl`), [
      { type: "session_start", id, title: "New Session", cwd },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Factory task title" }] } },
    ]);

    const sessions = await discoverDroidSessions({ homeDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "droid",
      id,
      cwd,
      title: null,
      preview: "Factory task title",
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
      `#!/bin/sh\nprintf '%s\\n' '[{"id":"open-1","directory":"${cwd}","title":"OpenCode task","summary":"Use OpenCode to map the issue","created":1783332000000,"updated":1783332060000,"messageCount":3},{"id":"open-2","directory":"${cwd}","title":"New session - 2026-05-01T17:02:11.923Z","preview":"Placeholder title should not win","created":1783331000000,"updated":1783331060000,"messageCount":1}]'\n`,
      "utf8",
    );
    fs.chmodSync(scriptPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    clearOpenCodeBinaryCache();

    const sessions = await discoverOpenCodeSessions({ homeDir, cwd, limit: 10 });

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      provider: "opencode",
      id: "open-1",
      cwd,
      title: "OpenCode task",
      preview: "Use OpenCode to map the issue",
      messageCount: 3,
    });
    expect(sessions[1]).toMatchObject({
      provider: "opencode",
      id: "open-2",
      cwd,
      title: null,
      preview: "Placeholder title should not win",
      messageCount: 1,
    });
  });
});
