import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSessionSummary, PtyCreateArgs, TerminalSessionSummary } from "../../../shared/types";
import { clearOpenCodeBinaryCache } from "../opencode/openCodeBinaryManager";
import { createExternalSessionsService } from "./externalSessionsService";
import { transplantClaudeSession } from "./claudeSessionTransplant";
import { claudeProjectSlugForCwd } from "./discoveryUtils";

const computerUseMocks = vi.hoisted(() => ({
  resolveCodexComputerUseMcpConfig: vi.fn(async () => null),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

vi.mock("../../utils/codexComputerUse", () => ({
  resolveCodexComputerUseMcpConfig: computerUseMocks.resolveCodexComputerUseMcpConfig,
}));

const execFileMock = vi.mocked(execFile);
let root: string;

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

function makeImportedChatSummary(sessionId: string): AgentChatSessionSummary {
  return {
    sessionId,
    laneId: "lane-1",
    provider: "claude",
    model: "sonnet",
    status: "idle",
    startedAt: "2026-07-06T10:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-07-06T10:00:00.000Z",
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
  };
}

beforeEach(() => {
  execFileMock.mockReset();
  computerUseMocks.resolveCodexComputerUseMcpConfig.mockReset();
  computerUseMocks.resolveCodexComputerUseMcpConfig.mockResolvedValue(null);
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
      importedSessionRef: { kind: "cli", sessionId: "ade-session" },
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

  it("checks a repeated session cwd only once per list call", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    for (const id of [
      "51515151-5151-4515-8515-515151515151",
      "52525252-5252-4525-8525-525252525252",
    ]) {
      writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd), `${id}.jsonl`), [
        { type: "message", sessionId: id, cwd: laneCwd, message: { role: "user", content: id } },
      ]);
    }
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });
    const statSync = vi.spyOn(fs, "statSync");
    try {
      await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 5 });
      expect(statSync.mock.calls.filter(([filePath]) => path.resolve(String(filePath)) === path.resolve(laneCwd)))
        .toHaveLength(1);
    } finally {
      statSync.mockRestore();
    }
  });

  it("returns the existing ADE session ref and prefers Claude chat pointers over CLI rows", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "11111111-1111-4111-8111-111111111111";
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd), `${id}.jsonl`), [
      {
        type: "message",
        sessionId: id,
        cwd: laneCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: "already imported" },
      },
    ]);

    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: {
        list: () => [
          {
            id: "cli-session",
            toolType: "claude",
            resumeMetadata: { provider: "claude", targetKind: "session", targetId: id, launch: {} },
          } as TerminalSessionSummary,
        ],
        listClaudeSessionPointers: () => [{ sessionId: id, chatSessionId: "chat-session" }],
      },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    const sessions = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 5 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      alreadyImported: true,
      importedSessionRef: { kind: "chat", sessionId: "chat-session" },
    });
  });

  it("marks chat-imported external sessions as already imported and prefers the chat ref", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "22222222-2222-4222-8222-222222222222";
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd), `${id}.jsonl`), [
      {
        type: "message",
        sessionId: id,
        cwd: laneCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: "imported as chat" },
      },
    ]);

    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: {
        list: () => [
          {
            id: "cli-session",
            toolType: "claude",
            resumeMetadata: { provider: "claude", targetKind: "session", targetId: id, launch: {} },
          } as TerminalSessionSummary,
        ],
        listClaudeSessionPointers: () => [],
      },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
      chatImportedRefsProvider: () => [
        { provider: "claude", externalId: id, chatSessionId: "chat-import-session" },
      ],
    });

    const sessions = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 5 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      alreadyImported: true,
      importedSessionRef: { kind: "chat", sessionId: "chat-import-session" },
    });
  });

  it("fills project-scoped Claude results from in-project sessions beyond the old global cap", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    const otherCwd = path.join(root, "other-repo");
    fs.mkdirSync(laneCwd, { recursive: true });
    fs.mkdirSync(otherCwd, { recursive: true });

    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    const writeSession = (cwd: string, id: string, prompt: string, mtime: Date) => {
      const filePath = path.join(claudeProjectsDir, claudeProjectSlugForCwd(cwd), `${id}.jsonl`);
      writeJsonl(filePath, [
        {
          type: "message",
          sessionId: id,
          cwd,
          timestamp: mtime.toISOString(),
          message: { role: "user", content: prompt },
        },
      ]);
      fs.utimesSync(filePath, mtime, mtime);
    };

    for (let index = 0; index < 225; index += 1) {
      writeSession(
        otherCwd,
        `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        `outside ${index}`,
        new Date(Date.UTC(2026, 6, 7, 12, 0, index)),
      );
    }
    const projectIds = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003",
    ];
    projectIds.forEach((id, index) => {
      writeSession(
        laneCwd,
        id,
        `inside ${index}`,
        new Date(Date.UTC(2026, 6, 7, 11, 0, index)),
      );
    });

    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    const sessions = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 5 });

    expect(sessions.map((session) => session.id)).toEqual(projectIds.slice().reverse());
    expect(sessions.every((session) => session.cwd === laneCwd)).toBe(true);
  });

  it("fills project-scoped Codex results by filtering session metadata before the old global cap", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    const otherCwd = path.join(root, "other-repo");
    fs.mkdirSync(laneCwd, { recursive: true });
    fs.mkdirSync(otherCwd, { recursive: true });

    const writeCodexSession = (cwd: string, id: string, prompt: string, mtime: Date) => {
      const stamp = mtime.toISOString().replace(/[:.]/gu, "-");
      const filePath = path.join(homeDir, ".codex", "sessions", "2026", "07", "07", `rollout-${stamp}-${id}.jsonl`);
      writeJsonl(filePath, [
        {
          timestamp: mtime.toISOString(),
          type: "session_meta",
          payload: { id, session_id: id, cwd, timestamp: mtime.toISOString() },
        },
        {
          timestamp: mtime.toISOString(),
          type: "event_msg",
          payload: { type: "message", role: "user", message: { content: prompt } },
        },
      ]);
      fs.utimesSync(filePath, mtime, mtime);
    };

    for (let index = 0; index < 225; index += 1) {
      writeCodexSession(
        otherCwd,
        `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        `outside codex ${index}`,
        new Date(Date.UTC(2026, 6, 7, 12, 0, index)),
      );
    }
    const projectIds = [
      "40000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000002",
      "40000000-0000-4000-8000-000000000003",
    ];
    projectIds.forEach((id, index) => {
      writeCodexSession(
        laneCwd,
        id,
        `inside codex ${index}`,
        new Date(Date.UTC(2026, 6, 7, 11, 0, index)),
      );
    });

    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    const sessions = await service.list({ providers: ["codex"], laneId: "lane-1", scope: "project", limit: 5 });

    expect(sessions.map((session) => session.id)).toEqual(projectIds.slice().reverse());
    expect(sessions.every((session) => session.cwd === laneCwd)).toBe(true);
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

  it("keeps Droid fork available when the source cwd is unknown and runs it in the lane", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "droid-no-source-cwd";
    writeJsonl(path.join(homeDir, ".factory", "sessions", "unknown", `${id}.jsonl`), [
      { type: "session_start", id, timestamp: "2026-07-06T10:00:00.000Z" },
      { type: "message", message: { role: "user", content: "fork me into the lane" } },
    ]);
    const create = vi.fn(async (_args: PtyCreateArgs) => ({
      sessionId: "terminal-droid-no-cwd",
      ptyId: "pty-droid-no-cwd",
      pid: 123,
    }));
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
    });

    const [summary] = await service.list({ providers: ["droid"], scope: "all", limit: 5 });
    expect(summary).toMatchObject({
      id,
      cwd: null,
      capabilities: {
        resumeInPlace: false,
        resumeInDifferentCwd: false,
        fork: true,
        forkIntoDifferentCwd: true,
      },
    });

    await expect(service.importExternalSession({
      provider: "droid",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    })).resolves.toMatchObject({ kind: "cli", sessionId: "terminal-droid-no-cwd" });
    expect(create.mock.calls[0]![0]).toMatchObject({
      cwd: fs.realpathSync(laneCwd),
      startupCommand: `droid --fork ${id}`,
    });
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

  it("resolves an exact import id without building the broad external-session list", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const targetId = "67676767-6767-4676-8676-676767676767";
    const projectDir = path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd));
    writeJsonl(path.join(projectDir, `${targetId}.jsonl`), [
      { type: "message", sessionId: targetId, cwd: laneCwd, message: { role: "user", content: "target" } },
    ]);
    for (let index = 0; index < 25; index += 1) {
      const id = `68000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      writeJsonl(path.join(projectDir, `${id}.jsonl`), [
        { type: "message", sessionId: id, cwd: laneCwd, message: { role: "user", content: "decoy" } },
      ]);
    }
    const list = vi.fn(() => []);
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal-exact", ptyId: "pty-exact", pid: 123 }));
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list, listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
    });

    await expect(service.importExternalSession({
      provider: "claude",
      sessionId: targetId,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    })).resolves.toMatchObject({ kind: "cli", sessionId: "terminal-exact" });
    expect(list).not.toHaveBeenCalled();
    expect(create.mock.calls[0]![0].startupCommand).toContain(`--resume ${targetId}`);
  });

  it("uses the destination lane scope when an exact OpenCode row omits its cwd", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    const binDir = path.join(root, "bin");
    const openCodePath = path.join(binDir, "opencode");
    const id = "open-missing-cwd";
    fs.mkdirSync(laneCwd, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(openCodePath, "#!/bin/sh\n", "utf8");
    fs.chmodSync(openCodePath, 0o755);

    const previousPath = process.env.PATH;
    const previousDisableBundled = process.env.ADE_DISABLE_BUNDLED_OPENCODE;
    process.env.PATH = binDir;
    process.env.ADE_DISABLE_BUNDLED_OPENCODE = "1";
    clearOpenCodeBinaryCache();
    try {
      execFileMock.mockImplementation((...callArgs: any[]) => {
        const callback = callArgs.at(-1) as (error: Error | null, stdout: unknown, stderr: string) => void;
        callback(null, {
          stdout: JSON.stringify([{ id, title: "OpenCode without cwd" }]),
          stderr: "",
        }, "");
        return { pid: 123 } as ReturnType<typeof execFile>;
      });
      const create = vi.fn(async (_args: PtyCreateArgs) => ({
        sessionId: "terminal-opencode",
        ptyId: "pty-opencode",
        pid: 456,
      }));
      const service = createExternalSessionsService({
        droidForkSupported: true,
        projectRoot,
        homeDir,
        laneService: { getLaneWorktreePath: () => laneCwd },
        sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
        ptyService: { create },
        logger: makeLogger(),
      });

      await expect(service.importExternalSession({
        provider: "opencode",
        sessionId: id,
        laneId: "lane-1",
        target: "cli",
        mode: "resume",
      })).resolves.toEqual({
        kind: "cli",
        sessionId: "terminal-opencode",
        ptyId: "pty-opencode",
        laneId: "lane-1",
      });

      expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({ cwd: fs.realpathSync(laneCwd) });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        cwd: fs.realpathSync(laneCwd),
        allowExternalCwd: false,
        startupCommand: `opencode --session ${id}`,
      }));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousDisableBundled === undefined) delete process.env.ADE_DISABLE_BUNDLED_OPENCODE;
      else process.env.ADE_DISABLE_BUNDLED_OPENCODE = previousDisableBundled;
      clearOpenCodeBinaryCache();
    }
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

  it("honors CLAUDE_CONFIG_DIR when discovering and transplanting cross-cwd Claude CLI forks", async () => {
    const homeDir = path.join(root, "home");
    const claudeConfigDir = path.join(root, "custom-claude");
    const projectRoot = path.join(root, "repo");
    const sourceCwd = path.join(projectRoot, "source");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(sourceCwd, { recursive: true });
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    writeJsonl(path.join(claudeConfigDir, "projects", claudeProjectSlugForCwd(sourceCwd), `${id}.jsonl`), [
      {
        type: "message",
        sessionId: id,
        cwd: sourceCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: "fork from custom config" },
      },
    ]);
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal-custom-claude", ptyId: "pty-custom-claude", pid: 456 }));
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
    });

    await expect(service.importExternalSession({
      provider: "claude",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    })).resolves.toEqual({ kind: "cli", sessionId: "terminal-custom-claude", ptyId: "pty-custom-claude", laneId: "lane-1" });

    const targetDir = path.join(claudeConfigDir, "projects", claudeProjectSlugForCwd(fs.realpathSync(laneCwd)));
    const targetFiles = fs.readdirSync(targetDir).filter((name) => name.endsWith(".jsonl"));
    expect(targetFiles).toHaveLength(1);
    expect(fs.existsSync(path.join(homeDir, ".claude"))).toBe(false);
    expect(create.mock.calls[0]![0].startupCommand).toContain("--resume");
    expect(create.mock.calls[0]![0].startupCommand).not.toContain(id);
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

  it("enforces lane-scoped import source cwd before invoking any import branch", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    const outsideCwd = path.join(root, "outside-project");
    fs.mkdirSync(laneCwd, { recursive: true });
    fs.mkdirSync(outsideCwd, { recursive: true });
    const insideClaudeId = "11111111-1111-4111-8111-111111111111";
    const outsideClaudeId = "22222222-2222-4222-8222-222222222222";
    const insideCodexId = "33333333-3333-4333-8333-333333333333";
    const outsideCodexId = "44444444-4444-4444-8444-444444444444";
    const missingCodexId = "55555555-5555-4555-8555-555555555555";
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd), `${insideClaudeId}.jsonl`), [
      { type: "message", sessionId: insideClaudeId, cwd: laneCwd, message: { role: "user", content: "inside" } },
    ]);
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(outsideCwd), `${outsideClaudeId}.jsonl`), [
      { type: "message", sessionId: outsideClaudeId, cwd: outsideCwd, message: { role: "user", content: "outside" } },
    ]);
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-2026-07-06T10-00-00-${insideCodexId}.jsonl`), [
      {
        timestamp: "2026-07-06T10:00:00.000Z",
        type: "session_meta",
        payload: { id: insideCodexId, cwd: laneCwd, timestamp: "2026-07-06T10:00:00.000Z" },
      },
    ]);
    writeJsonl(path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-2026-07-06T10-01-00-${outsideCodexId}.jsonl`), [
      {
        timestamp: "2026-07-06T10:01:00.000Z",
        type: "session_meta",
        payload: { id: outsideCodexId, cwd: outsideCwd, timestamp: "2026-07-06T10:01:00.000Z" },
      },
    ]);
    const chatImporter = {
      importExternalChatSession: vi.fn(async () => ({
        chatSessionId: "chat-import",
        chatSummary: makeImportedChatSummary("chat-import"),
      })),
    };
    const create = vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal-import", ptyId: "pty-import", pid: 456 }));
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
      chatImporter,
    });

    await expect(service.importExternalSession({
      provider: "codex",
      sessionId: missingCodexId,
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      enforceLaneScopeCwd: laneCwd,
    })).rejects.toThrow(/not found or is not resumable/i);
    await expect(service.importExternalSession({
      provider: "codex",
      sessionId: outsideCodexId,
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      enforceLaneScopeCwd: laneCwd,
    })).rejects.toThrow(/not permitted/i);
    await expect(service.importExternalSession({
      provider: "claude",
      sessionId: outsideClaudeId,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
      enforceLaneScopeCwd: laneCwd,
    })).rejects.toThrow(/not permitted/i);
    await expect(service.importExternalSession({
      provider: "claude",
      sessionId: outsideClaudeId,
      laneId: "lane-1",
      target: "chat",
      mode: "resume",
      enforceLaneScopeCwd: laneCwd,
    })).rejects.toThrow(/not permitted/i);
    expect(create).not.toHaveBeenCalled();
    expect(chatImporter.importExternalChatSession).not.toHaveBeenCalled();

    await expect(service.importExternalSession({
      provider: "codex",
      sessionId: insideCodexId,
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      enforceLaneScopeCwd: laneCwd,
    })).resolves.toEqual({ kind: "cli", sessionId: "terminal-import", ptyId: "pty-import", laneId: "lane-1" });
    await expect(service.importExternalSession({
      provider: "claude",
      sessionId: insideClaudeId,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
      enforceLaneScopeCwd: laneCwd,
    })).resolves.toEqual({ kind: "cli", sessionId: "terminal-import", ptyId: "pty-import", laneId: "lane-1" });
    await expect(service.importExternalSession({
      provider: "claude",
      sessionId: insideClaudeId,
      laneId: "lane-1",
      target: "chat",
      mode: "resume",
      enforceLaneScopeCwd: laneCwd,
    })).resolves.toEqual({
      kind: "chat",
      chatSessionId: "chat-import",
      laneId: "lane-1",
      chatSummary: makeImportedChatSummary("chat-import"),
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(chatImporter.importExternalChatSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      externalSessionId: insideClaudeId,
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
    await expect(service.importExternalSession({
      provider: "cursor",
      sessionId: "agent-77777777-7777-4777-8777-777777777777",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
    })).rejects.toThrow(/not resumable/i);
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
