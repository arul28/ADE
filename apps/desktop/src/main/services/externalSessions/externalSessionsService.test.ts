import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyCreateArgs, TerminalSessionSummary } from "../../../shared/types";
import { createExternalSessionsService } from "./externalSessionsService";
import { transplantClaudeSession } from "./claudeSessionTransplant";
import { claudeProjectSlugForCwd } from "./discoveryUtils";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

const execFileMock = vi.mocked(execFile);
let root: string;

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

beforeEach(() => {
  execFileMock.mockReset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-external-service-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("externalSessionsService", () => {
  it("lists sessions with imported flags, active flags, capabilities, and lane cwd matching", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "55555555-5555-4555-8555-555555555555";
    const filePath = path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd), `${id}.jsonl`);
    writeJsonl(filePath, [
      {
        type: "message",
        sessionId: id,
        cwd: laneCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: "import me" },
      },
    ]);
    fs.utimesSync(filePath, new Date(), new Date());

    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: {
        list: () => [
          {
            id: "ade-session",
            resumeMetadata: { provider: "claude", targetKind: "session", targetId: id, launch: {} },
          } as TerminalSessionSummary,
        ],
        listClaudeSessionPointers: () => [],
      },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    const sessions = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 5 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "claude",
      id,
      cwd: laneCwd,
      alreadyImported: true,
      possiblyActive: true,
      cwdMatchesRequestedLane: true,
      capabilities: {
        resumeInPlace: true,
        resumeInDifferentCwd: false,
        fork: true,
        forkIntoDifferentCwd: true,
        importToChat: true,
      },
    });
  });

  it("reports droid fork disabled while the probe is pending and honors the override", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "droid-session-1";
    writeJsonl(path.join(homeDir, ".factory", "sessions", "repo", `${id}.jsonl`), [
      {
        type: "session_start",
        id,
        cwd: laneCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
      },
    ]);
    execFileMock.mockImplementation(() => ({ pid: 123 }) as ReturnType<typeof execFile>);

    const service = createExternalSessionsService({
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    const sessions = await service.list({ providers: ["droid"], laneId: "lane-1", scope: "project", limit: 5 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.capabilities).toMatchObject({ fork: false, forkIntoDifferentCwd: false });
    expect(execFileMock).toHaveBeenCalledTimes(1);

    execFileMock.mockClear();
    const overrideService = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    const overrideSessions = await overrideService.list({ providers: ["droid"], laneId: "lane-1", scope: "project", limit: 5 });

    expect(overrideSessions).toHaveLength(1);
    expect(overrideSessions[0]!.capabilities).toMatchObject({ fork: true, forkIntoDifferentCwd: true });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("awaits the droid fork probe before launching fork imports", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "droid-session-2";
    writeJsonl(path.join(homeDir, ".factory", "sessions", "repo", `${id}.jsonl`), [
      {
        type: "session_start",
        id,
        cwd: laneCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
      },
    ]);
    execFileMock.mockImplementation((...callArgs: any[]) => {
      const callback = callArgs[3] as (error: Error | null, stdout: string, stderr: string) => void;
      setTimeout(() => callback(null, "usage: droid --resume --fork", ""), 0);
      return { pid: 123 } as ReturnType<typeof execFile>;
    });
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal-droid", ptyId: "pty-droid", pid: 789 }));
    const service = createExternalSessionsService({
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
    });

    const result = await service.importExternalSession({
      provider: "droid",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    });

    expect(result).toEqual({ kind: "cli", sessionId: "terminal-droid", ptyId: "pty-droid", laneId: "lane-1" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].startupCommand).toBe(`droid --fork ${id}`);
  });

  it("rejects droid fork imports when the resolved probe is unsupported", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "droid-session-3";
    writeJsonl(path.join(homeDir, ".factory", "sessions", "repo", `${id}.jsonl`), [
      {
        type: "session_start",
        id,
        cwd: laneCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
      },
    ]);
    execFileMock.mockImplementation((...callArgs: any[]) => {
      const callback = callArgs[3] as (error: Error | null, stdout: string, stderr: string) => void;
      setTimeout(() => callback(null, "usage: droid --resume", ""), 0);
      return { pid: 123 } as ReturnType<typeof execFile>;
    });
    const create = vi.fn();
    const service = createExternalSessionsService({
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
    });

    await expect(service.importExternalSession({
      provider: "droid",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    })).rejects.toThrow(/installed droid CLI does not support forking/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("imports a portable Codex session as a tracked CLI PTY in the target lane", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "66666666-6666-4666-8666-666666666666";
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-2026-07-06T10-00-00-${id}.jsonl`), [
      {
        timestamp: "2026-07-06T10:00:00.000Z",
        type: "session_meta",
        payload: { id, cwd: path.join(root, "elsewhere"), timestamp: "2026-07-06T10:00:00.000Z" },
      },
    ]);
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal-1", ptyId: "pty-1", pid: 123 }));
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
    });

    const result = await service.importExternalSession({
      provider: "codex",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      permissionMode: "edit",
    });

    expect(result).toEqual({ kind: "cli", sessionId: "terminal-1", ptyId: "pty-1", laneId: "lane-1" });
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]![0];
    expect(args.cwd).toBe(fs.realpathSync(laneCwd));
    expect(args.allowExternalCwd).toBe(false);
    expect(args.startupCommand).toContain("codex --no-alt-screen");
    expect(args.startupCommand).toContain(`resume ${id}`);
    expect(args.resumeMetadata).toMatchObject({
      provider: "codex",
      targetKind: "thread",
      targetId: id,
      importedFrom: { provider: "codex", targetId: id, mode: "resume" },
    });
  });

  it("forks a same-cwd Claude session with the original id in the launch command", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd), `${id}.jsonl`), [
      {
        type: "message",
        sessionId: id,
        cwd: laneCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: "branch this session" },
      },
    ]);
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal-2", ptyId: "pty-2", pid: 456 }));
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
    });

    const result = await service.importExternalSession({
      provider: "claude",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    });

    expect(result).toEqual({ kind: "cli", sessionId: "terminal-2", ptyId: "pty-2", laneId: "lane-1" });
    const args = create.mock.calls[0]![0];
    expect(args.cwd).toBe(laneCwd);
    expect(args.allowExternalCwd).toBe(false);
    expect(args.startupCommand).toContain(`--resume ${id}`);
    expect(args.startupCommand).toContain("--fork-session");
    expect(args.resumeMetadata).toMatchObject({
      provider: "claude",
      targetKind: "session",
      targetId: null,
      importedFrom: { provider: "claude", targetId: id, mode: "fork" },
    });
  });

  it("throws a clear error when chat import is not wired", async () => {
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir: path.join(root, "home"),
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    await expect(service.importExternalSession({
      provider: "claude",
      sessionId: "77777777-7777-4777-8777-777777777777",
      laneId: "lane-1",
      target: "chat",
      mode: "resume",
    })).rejects.toThrow(/chat import unavailable/i);
  });

  it("enforces lane-scoped chat import source cwd before invoking the chat importer", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    const outsideCwd = path.join(root, "outside-project");
    fs.mkdirSync(laneCwd, { recursive: true });
    fs.mkdirSync(outsideCwd, { recursive: true });
    const insideId = "11111111-1111-4111-8111-111111111111";
    const outsideId = "22222222-2222-4222-8222-222222222222";
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd), `${insideId}.jsonl`), [
      { type: "message", sessionId: insideId, cwd: laneCwd, message: { role: "user", content: "inside" } },
    ]);
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(outsideCwd), `${outsideId}.jsonl`), [
      { type: "message", sessionId: outsideId, cwd: outsideCwd, message: { role: "user", content: "outside" } },
    ]);
    const chatImporter = {
      importExternalChatSession: vi.fn(async () => ({ chatSessionId: "chat-import" })),
    };
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
      chatImporter,
    });

    await expect(service.importExternalSession({
      provider: "claude",
      sessionId: outsideId,
      laneId: "lane-1",
      target: "chat",
      mode: "resume",
      enforceLaneScopeCwd: laneCwd,
    })).rejects.toThrow(/not permitted/i);
    expect(chatImporter.importExternalChatSession).not.toHaveBeenCalled();

    await expect(service.importExternalSession({
      provider: "claude",
      sessionId: insideId,
      laneId: "lane-1",
      target: "chat",
      mode: "resume",
      enforceLaneScopeCwd: laneCwd,
    })).resolves.toEqual({ kind: "chat", chatSessionId: "chat-import", laneId: "lane-1" });
    expect(chatImporter.importExternalChatSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      externalSessionId: insideId,
      laneId: "lane-1",
      cwd: laneCwd,
      fork: false,
    }));
  });

  it("rejects invalid external session ids before import", async () => {
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const create = vi.fn();
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir: path.join(root, "home"),
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
    });

    await expect(service.importExternalSession({
      provider: "codex",
      sessionId: "--help",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
    })).rejects.toThrow(/codex external session id is invalid/i);
    await expect(service.importExternalSession({
      provider: "droid",
      sessionId: "--help",
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    })).rejects.toThrow(/droid external session id is invalid/i);
    await expect(service.importExternalSession({
      provider: "opencode",
      sessionId: "ab",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
    })).rejects.toThrow(/opencode external session id is invalid/i);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("transplantClaudeSession", () => {
  it("forks a Claude JSONL into the target cwd under a fresh session id", async () => {
    const configDir = path.join(root, "claude");
    const sourceCwd = path.join(root, "source");
    const targetCwd = path.join(root, "target");
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const sourcePath = path.join(configDir, "projects", claudeProjectSlugForCwd(sourceCwd), `${sessionId}.jsonl`);
    writeJsonl(sourcePath, [
      { type: "message", sessionId, keep: { nested: true } },
      { type: "summary", sessionId, text: "hello" },
    ]);

    const result = await transplantClaudeSession({ sessionId, sourceCwd, targetCwd, fork: true, configDir });

    expect(result.newSessionId).not.toBe(sessionId);
    expect(fs.existsSync(sourcePath)).toBe(true);
    const lines = fs.readFileSync(result.targetPath, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { type: "message", sessionId: result.newSessionId, keep: { nested: true } },
      { type: "summary", sessionId: result.newSessionId, text: "hello" },
    ]);
  });

  it("rejects and removes the temp file when the Claude fork rewrite stream fails", async () => {
    const configDir = path.join(root, "claude");
    const sourceCwd = path.join(root, "source");
    const targetCwd = path.join(root, "target");
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const sourcePath = path.join(configDir, "projects", claudeProjectSlugForCwd(sourceCwd), `${sessionId}.jsonl`);
    writeJsonl(sourcePath, [
      { type: "message", sessionId, text: "source stays intact" },
    ]);
    const sourceBefore = fs.readFileSync(sourcePath, "utf8");
    let tempPath: string | null = null;
    const writeFailure = new Error("mock Claude rewrite stream failure");
    const createWriteStream = vi.spyOn(fs, "createWriteStream").mockImplementation((filePath) => {
      tempPath = String(filePath);
      fs.mkdirSync(path.dirname(tempPath), { recursive: true });
      fs.writeFileSync(tempPath, "partial temp", "utf8");
      return new Writable({
        write(_chunk, _encoding, callback) {
          callback(writeFailure);
        },
      }) as fs.WriteStream;
    });

    try {
      await expect(transplantClaudeSession({ sessionId, sourceCwd, targetCwd, fork: true, configDir }))
        .rejects.toThrow("mock Claude rewrite stream failure");
    } finally {
      createWriteStream.mockRestore();
    }

    expect(tempPath).toBeTruthy();
    expect(fs.existsSync(tempPath!)).toBe(false);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBefore);
    const targetDir = path.join(configDir, "projects", claudeProjectSlugForCwd(targetCwd));
    const targetFiles = fs.existsSync(targetDir) ? fs.readdirSync(targetDir) : [];
    expect(targetFiles.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(targetFiles.filter((name) => name.endsWith(".jsonl"))).toEqual([]);
  });

  it("adopt-moves a Claude JSONL without changing its id", async () => {
    const configDir = path.join(root, "claude");
    const sourceCwd = path.join(root, "source");
    const targetCwd = path.join(root, "target");
    const sessionId = "99999999-9999-4999-8999-999999999999";
    const sourcePath = path.join(configDir, "projects", claudeProjectSlugForCwd(sourceCwd), `${sessionId}.jsonl`);
    writeJsonl(sourcePath, [{ type: "message", sessionId }]);

    const result = await transplantClaudeSession({ sessionId, sourceCwd, targetCwd, fork: false, configDir });

    expect(result.newSessionId).toBe(sessionId);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(result.targetPath)).toBe(true);
    expect(result.targetPath).toContain(claudeProjectSlugForCwd(targetCwd));
  });

  it("rejects adopt-moving onto an existing Claude target without clobbering it", async () => {
    const configDir = path.join(root, "claude");
    const sourceCwd = path.join(root, "source");
    const targetCwd = path.join(root, "target");
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const sourcePath = path.join(configDir, "projects", claudeProjectSlugForCwd(sourceCwd), `${sessionId}.jsonl`);
    const targetPath = path.join(configDir, "projects", claudeProjectSlugForCwd(targetCwd), `${sessionId}.jsonl`);
    writeJsonl(sourcePath, [{ type: "message", sessionId, text: "source transcript" }]);
    writeJsonl(targetPath, [{ type: "message", sessionId, text: "existing transcript" }]);
    const sourceBefore = fs.readFileSync(sourcePath, "utf8");
    const targetBefore = fs.readFileSync(targetPath, "utf8");

    await expect(transplantClaudeSession({ sessionId, sourceCwd, targetCwd, fork: false, configDir }))
      .rejects.toThrow(`Claude target session already exists at ${targetPath}.`);

    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBefore);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(targetBefore);
  });
});
