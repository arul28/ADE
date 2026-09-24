import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyCreateArgs } from "../../../shared/types";
import { qwenProjectSlugForCwd } from "./discoverQwen";
import { createExternalSessionsService } from "./externalSessionsService";

let root: string;
let homeDir: string;
let laneCwd: string;
let previousAdeHome: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-acp-import-")));
  homeDir = path.join(root, "home");
  laneCwd = path.join(root, "repo", ".ade", "worktrees", "lane-1");
  fs.mkdirSync(laneCwd, { recursive: true });
  // The durable import log lives under the ADE home; keep it inside the test.
  previousAdeHome = process.env.ADE_HOME;
  process.env.ADE_HOME = path.join(root, "ade-home");
});

afterEach(() => {
  if (previousAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = previousAdeHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

type PtyCreate = Parameters<typeof createExternalSessionsService>[0]["ptyService"]["create"];

function makeService(create: PtyCreate) {
  return createExternalSessionsService({
    projectRoot: path.join(root, "repo"),
    homeDir,
    // An empty env keeps a developer's own QWEN_HOME / GROK_HOME out of the test.
    env: {},
    laneService: { getLaneWorktreePath: () => laneCwd },
    sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
    ptyService: { create },
    logger: { warn: vi.fn(), info: vi.fn() },
    inspectLiveSessions: () => ({ availability: { available: true, method: "lsof" }, byKey: new Map() }),
  });
}

function writeQwenSession(cwd: string, id: string): void {
  const base = { parentUuid: null, sessionId: id, cwd, version: "0.22.3" };
  writeJsonl(path.join(homeDir, ".qwen", "projects", qwenProjectSlugForCwd(cwd), "chats", `${id}.jsonl`), [
    { ...base, uuid: "u1", timestamp: "2026-09-01T10:00:00.000Z", type: "user", provenance: "real_user", message: { role: "user", parts: [{ text: "hi" }] } },
    { ...base, uuid: "s1", timestamp: "2026-09-01T10:00:00.100Z", type: "system", subtype: "attribution_snapshot", provenance: "system", systemPayload: {} },
  ]);
}

function writeGrokSession(cwd: string, id: string): void {
  const dir = path.join(homeDir, ".grok", "sessions", encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ info: { id, cwd }, created_at: "2026-09-01T10:00:00Z" }));
  writeJsonl(path.join(dir, "chat_history.jsonl"), [
    { type: "user", content: [{ type: "text", text: "<user_query>\nhi\n</user_query>" }], prompt_index: 0 },
  ]);
}

describe("ACP provider CLI copies", () => {
  it("copies a Qwen session in its own folder with --resume <id> --fork-session", async () => {
    const id = "d497b997-c316-41f0-8b2b-2a5807c1473b";
    writeQwenSession(laneCwd, id);
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal-qwen", ptyId: "pty-qwen", pid: 1 }));

    await expect(makeService(create).importExternalSession({
      provider: "qwen", sessionId: id, laneId: "lane-1", target: "cli", mode: "fork",
    })).resolves.toMatchObject({ kind: "cli", sessionId: "terminal-qwen" });
    const ptyArgs = create.mock.calls[0]![0];
    expect(ptyArgs.startupCommand).toBe(`qwen --resume ${id} --fork-session`);
    expect(ptyArgs.cwd).toBe(laneCwd);
    // The copy's new id is unknown until the CLI mints it, so none is recorded.
    expect(ptyArgs.resumeMetadata).toMatchObject({ provider: "qwen", targetId: null });
  });

  it("copies a Grok session with -r <id> --fork-session under Grok's supervision env", async () => {
    const id = "01a0599e-d5f9-7ee0-b0a7-9611a779ee63";
    writeGrokSession(laneCwd, id);
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal-grok", ptyId: "pty-grok", pid: 2 }));

    await makeService(create).importExternalSession({
      provider: "grok", sessionId: id, laneId: "lane-1", target: "cli", mode: "fork",
    });
    const ptyArgs = create.mock.calls[0]![0];
    expect(ptyArgs.startupCommand).toBe(`_GROK_CLAUDE_MARKER_OVERRIDE=1 grok --no-alt-screen -r ${id} --fork-session`);
    expect(ptyArgs.resumeMetadata).toMatchObject({ provider: "grok", targetId: null });
  });

  it("refuses to copy a Qwen session into a lane other than its own", async () => {
    const otherCwd = path.join(root, "repo", ".ade", "worktrees", "lane-2");
    fs.mkdirSync(otherCwd, { recursive: true });
    const id = "c04c33c1-71ca-4eb8-b6c1-ac3f0a5034b7";
    writeQwenSession(otherCwd, id);
    const create = vi.fn();
    const service = createExternalSessionsService({
      projectRoot: path.join(root, "repo"),
      homeDir,
      env: {},
      laneService: {
        getLaneWorktreePath: (laneId: string) => (laneId === "lane-2" ? otherCwd : laneCwd),
        list: () => [
          { id: "lane-1", name: "Lane one", branchRef: "refs/heads/one", color: null, laneType: "worktree", worktreePath: laneCwd },
          { id: "lane-2", name: "Lane two", branchRef: "refs/heads/two", color: null, laneType: "worktree", worktreePath: otherCwd },
        ],
      },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: { warn: vi.fn(), info: vi.fn() },
      inspectLiveSessions: () => ({ availability: { available: true, method: "lsof" }, byKey: new Map() }),
    });

    await expect(service.importExternalSession({
      provider: "qwen", sessionId: id, laneId: "lane-1", target: "cli", mode: "fork",
    })).rejects.toThrow(/can only do that in Lane two/);
    expect(create).not.toHaveBeenCalled();
  });

  it("copies a Qwen session from a removed lane in its own folder", async () => {
    const removedCwd = path.join(root, "repo", ".ade", "worktrees", "gone-lane");
    fs.mkdirSync(removedCwd, { recursive: true });
    const id = "d04c33c1-71ca-4eb8-b6c1-ac3f0a5034b7";
    writeQwenSession(removedCwd, id);
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal", ptyId: "pty", pid: 3 }));

    await makeService(create).importExternalSession({
      provider: "qwen", sessionId: id, laneId: "lane-1", target: "cli", mode: "fork",
    });
    const ptyArgs = create.mock.calls[0]![0];
    expect(ptyArgs.cwd).toBe(removedCwd);
    expect(ptyArgs.allowExternalCwd).toBe(true);
    expect(ptyArgs.startupCommand).toContain("--fork-session");
  });

  it.each([
    ["kimi", "01K5ZQ4Y3N8W2V7T6R5P4M3K2J"],
    ["copilot", "9e80f413-ab88-4f92-af30-a8a384e1d6b9"],
  ] as const)("never launches a CLI copy for %s", async (provider, id) => {
    if (provider === "kimi") {
      const dir = path.join(homeDir, ".kimi-code", "sessions", "wd_lane_000000000000", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ workDir: laneCwd }));
      writeJsonl(path.join(dir, "agents", "main", "wire.jsonl"), [
        { type: "context.append_message", time: 1788205417, message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      ]);
    } else {
      const dir = path.join(homeDir, ".copilot", "session-state", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "workspace.yaml"), `id: ${id}\ncwd: ${laneCwd}\n`);
      writeJsonl(path.join(dir, "events.jsonl"), [
        { type: "user.message", data: { content: "hi", source: "user" }, id: "e1", timestamp: "2026-09-01T10:00:00Z" },
      ]);
    }
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal", ptyId: "pty", pid: 3 }));
    const service = makeService(create);

    await expect(service.importExternalSession({
      provider, sessionId: id, laneId: "lane-1", target: "cli", mode: "fork",
    })).rejects.toThrow(/can't be copied|cannot be copied/);
    expect(create).not.toHaveBeenCalled();

    // Continue still works, with the provider's own resume selector.
    await service.importExternalSession({ provider, sessionId: id, laneId: "lane-1", target: "cli", mode: "resume" });
    expect(create.mock.calls[0]![0].startupCommand).toBe(
      provider === "kimi" ? `kimi -S ${id}` : `copilot --resume=${id}`,
    );
  });
});
