import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChatSessionSummary,
  ExternalSessionListArgs,
  PtyCreateArgs,
  TerminalSessionSummary,
} from "../../../shared/types";
import { clearOpenCodeBinaryCache } from "../opencode/openCodeBinaryManager";
import { droidProjectSlugForCwd } from "./discoverDroid";
import { createExternalSessionsService } from "./externalSessionsService";
import { createImportedSessionStore, importedSessionsPath } from "./importedSessionStore";
import { transplantClaudeSession } from "./claudeSessionTransplant";
import { claudeProjectSlugForCwd } from "./discoveryUtils";
import { qwenProjectSlugForCwd } from "./discoverQwen";
import { EXTERNAL_SESSION_PROVIDERS } from "../../../shared/types/externalSessions";

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

vi.mock("./providerSessionHandles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providerSessionHandles")>();
  return {
    ...actual,
    inspectLiveProviderSessions: vi.fn(() => ({
      availability: { available: true as const, method: "lsof" as const },
      byKey: new Map(),
    })),
  };
});

const execFileMock = vi.mocked(execFile);
let root: string;

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

/** Droid names a session directory after its slash-escaped cwd. */
function droidSessionDir(cwd: string): string {
  // Must match what the droid CLI actually writes. A forward-slash-only swap
  // leaves a Windows path intact, so the fixture tries to mkdir a name
  // containing "C:" and NTFS rejects it.
  return droidProjectSlugForCwd(cwd);
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

let previousAdeHome: string | undefined;

beforeEach(() => {
  execFileMock.mockReset();
  computerUseMocks.resolveCodexComputerUseMcpConfig.mockReset();
  computerUseMocks.resolveCodexComputerUseMcpConfig.mockResolvedValue(null);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-external-service-"));
  // The durable import log lives under the ADE home; pin it so a developer's
  // real one can never be written to by a test that spreads `process.env`.
  previousAdeHome = process.env.ADE_HOME;
  process.env.ADE_HOME = path.join(root, "ade-home");
});

afterEach(() => {
  if (previousAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = previousAdeHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("externalSessionsService", () => {
  it("rejects unsafe exact lookup ids before provider path resolution", async () => {
    const service = createExternalSessionsService({
      projectRoot: path.join(root, "repo"),
      homeDir: path.join(root, "home"),
      laneService: {},
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });
    const statSync = vi.spyOn(fs, "statSync");
    try {
      await expect(service.list({ providers: ["cursor", "droid"], scope: "all", sessionId: "../../outside" }))
        .resolves.toEqual([]);
      await expect(service.list({ providers: ["codex"], scope: "all", sessionId: "not-a-uuid" }))
        .resolves.toEqual([]);
      expect(statSync).not.toHaveBeenCalled();
    } finally {
      statSync.mockRestore();
    }
  });

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
    expect(sessions).toEqual([]);

    const lookedUp = await service.list({
      providers: ["claude"],
      laneId: "lane-1",
      scope: "project",
      sessionId: id,
    });
    expect(lookedUp).toHaveLength(1);
    expect(lookedUp[0]).toMatchObject({
      provider: "claude",
      id,
      cwd: laneCwd,
      preview: "import me",
      messages: [{ role: "user", text: "import me", at: Date.parse("2026-07-06T10:00:00.000Z") }],
      alreadyImported: true,
      importedSessionRef: { kind: "cli", sessionId: "ade-session" },
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

  it("reads a session's detail from the service's own home", async () => {
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    const id = "66666666-6666-4666-8666-666666666666";
    const filePath = path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(cwd), `${id}.jsonl`);
    writeJsonl(filePath, [
      {
        type: "user",
        sessionId: id,
        cwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: "detail from this home" },
      },
    ]);
    const service = createExternalSessionsService({
      projectRoot: cwd,
      homeDir,
      laneService: {},
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    const detail = await service.getDetail({ provider: "claude", sessionId: id });
    expect(detail.sourcePath).toBe(filePath);
    expect(detail.messages.at(-1)?.text).toBe("detail from this home");
  });

  it("copies optional preview fields through both summary construction paths", () => {
    // The exact-lookup summary is private and the fields are optional, so a
    // structural assertion pins both DTO boundaries without widening the API.
    const source = fs.readFileSync(
      path.join(__dirname, "externalSessionsService.ts"),
      "utf8",
    );

    expect(source.match(/messages: session\.messages/gu)).toHaveLength(2);
    expect(source.match(/preview: session\.preview/gu)).toHaveLength(2);
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
          { id: "chat-session", toolType: "claude-chat" } as TerminalSessionSummary,
        ],
        listClaudeSessionPointers: () => [{ sessionId: id, chatSessionId: "chat-session" }],
      },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    const sessions = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 5 });
    expect(sessions).toEqual([]);

    const lookedUp = await service.list({
      providers: ["claude"],
      laneId: "lane-1",
      scope: "project",
      sessionId: id,
    });
    expect(lookedUp).toHaveLength(1);
    expect(lookedUp[0]).toMatchObject({
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
    expect(sessions).toEqual([]);

    const lookedUp = await service.list({
      providers: ["claude"],
      laneId: "lane-1",
      scope: "project",
      sessionId: id,
    });
    expect(lookedUp).toHaveLength(1);
    expect(lookedUp[0]).toMatchObject({
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
    writeJsonl(path.join(homeDir, ".factory", "sessions", droidSessionDir(laneCwd), `${id}.jsonl`), [
      {
        type: "session_start",
        id,
        cwd: laneCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
      },
      { type: "message", message: { role: "user", content: "droid prompt" } },
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
    writeJsonl(path.join(homeDir, ".factory", "sessions", droidSessionDir(laneCwd), `${id}.jsonl`), [
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
    const onImportOutcome = vi.fn();
    const service = createExternalSessionsService({
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
      onImportOutcome,
    });

    const result = await service.importExternalSession({
      provider: "droid",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    });

    expect(result).toEqual({ kind: "cli", sessionId: "terminal-droid", ptyId: "pty-droid", laneId: "lane-1" });
    expect(onImportOutcome.mock.calls).toEqual([[{ provider: "droid", target: "cli", mode: "fork", outcome: "completed" }]]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].startupCommand).toBe(`droid --fork ${id}`);
  });

  it("rejects droid fork imports when the resolved probe is unsupported", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "droid-session-3";
    writeJsonl(path.join(homeDir, ".factory", "sessions", droidSessionDir(laneCwd), `${id}.jsonl`), [
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
    const onImportOutcome = vi.fn();
    const service = createExternalSessionsService({
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
      onImportOutcome,
    });

    await expect(service.importExternalSession({
      provider: "droid",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    })).rejects.toThrow(/installed droid CLI does not support forking/i);
    expect(create).not.toHaveBeenCalled();
    expect(onImportOutcome.mock.calls).toEqual([[{ provider: "droid", target: "cli", mode: "fork", outcome: "failed" }]]);
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
      {
        type: "turn_context",
        payload: {
          model: "gpt-5.6-sol",
          effort: "max",
          service_tier: "fast",
          approval_policy: "on-request",
          sandbox_policy: { type: "danger-full-access" },
        },
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
    });

    expect(result).toEqual({ kind: "cli", sessionId: "terminal-1", ptyId: "pty-1", laneId: "lane-1" });
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]![0];
    expect(args.cwd).toBe(fs.realpathSync(laneCwd));
    expect(args.allowExternalCwd).toBe(false);
    expect(args.startupCommand).toContain("codex --no-alt-screen");
    expect(args.startupCommand).toContain(`resume ${id}`);
    expect(args.startupCommand).toContain("--model gpt-5.6-sol");
    expect(args.startupCommand).toContain("model_reasoning_effort");
    expect(args.startupCommand).toContain("service_tier");
    expect(args.startupCommand).toContain("--sandbox danger-full-access --ask-for-approval on-request");
    expect(args.startupCommand).not.toContain("dangerously-bypass");
    expect(args.resumeMetadata).toMatchObject({
      provider: "codex",
      targetKind: "thread",
      targetId: id,
      importedFrom: { provider: "codex", targetId: id, mode: "resume" },
      launch: {
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        fastMode: true,
        codexApprovalPolicy: "on-request",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      },
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
    // Windows cannot execute an extension-less file, and `resolveFromDirs`
    // resolves through PATHEXT only there — an `opencode` with no extension is
    // a macOS-shaped fixture that no Windows install would ever produce.
    const openCodePath = path.join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode");
    const id = "open-missing-cwd";
    fs.mkdirSync(laneCwd, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    // A real script, not an `execFile` mock: discovery reads the CLI's stdout
    // from a file (OpenCode cuts a piped stdout short).
    const payloadPath = path.join(binDir, "opencode-payload.cjs");
    fs.writeFileSync(
      payloadPath,
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(binDir, "cwd.txt"))}, process.cwd());\n`
        + `process.stdout.write(${JSON.stringify(JSON.stringify([{ id, title: "OpenCode without cwd" }]))});\n`,
      "utf8",
    );
    fs.writeFileSync(
      openCodePath,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "%~dp0opencode-payload.cjs"\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/opencode-payload.cjs"\n`,
      "utf8",
    );
    fs.chmodSync(openCodePath, 0o755);

    const previousPath = process.env.PATH;
    const previousDisableBundled = process.env.ADE_DISABLE_BUNDLED_OPENCODE;
    process.env.PATH = binDir;
    process.env.ADE_DISABLE_BUNDLED_OPENCODE = "1";
    clearOpenCodeBinaryCache();
    try {
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

      // The list ran in the destination lane, OpenCode's only scope for a row with no cwd.
      expect(fs.realpathSync(fs.readFileSync(path.join(binDir, "cwd.txt"), "utf8"))).toBe(fs.realpathSync(laneCwd));
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
      importExternalChatSession: vi.fn(async (importArgs: { externalSessionId: string }) => ({
        chatSessionId: "chat-import",
        chatSummary: makeImportedChatSummary("chat-import"),
        providerTargetId: importArgs.externalSessionId,
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

/**
 * Windows and macOS resolve paths case-insensitively, `fs.realpathSync` does
 * NOT canonicalize case on Windows (it hands both spellings back unchanged),
 * and PowerShell preserves whatever the user typed after `cd`. So a CLI run in
 * the lane folder routinely records a spelling ADE never wrote. Comparing those
 * with `===` reads the lane's own session as belonging somewhere else.
 *
 * On Linux the two spellings really are two directories, so the cases run only
 * where the platform agrees they are one.
 */
const itOnCaseInsensitiveFs = it.runIf(process.platform === "win32" || process.platform === "darwin");

describe("externalSessionsService cwd matching ignores path case", () => {
  itOnCaseInsensitiveFs("still marks a case-different session as belonging to the lane", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    // The same folder as `laneCwd`, spelled the way a shell might have echoed it.
    const recordedCwd = path.join(projectRoot, ".ade", "worktrees", "LANE-1");
    const id = "66666666-6666-4666-8666-666666666666";
    const filePath = path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(recordedCwd), `${id}.jsonl`);
    writeJsonl(filePath, [
      {
        type: "message",
        sessionId: id,
        cwd: recordedCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: "same folder, other casing" },
      },
    ]);

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

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id, cwdMatchesRequestedLane: true });
    // A same-folder resume must stay resumable in place rather than demanding a copy.
    expect(sessions[0]!.capabilities).toMatchObject({ resumeInPlace: true });
  });

  itOnCaseInsensitiveFs("forks a case-different Claude session in place instead of transplanting it", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const recordedCwd = path.join(projectRoot, ".ade", "worktrees", "LANE-1");
    const id = "77777777-7777-4777-8777-777777777777";
    writeJsonl(
      path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(recordedCwd), `${id}.jsonl`),
      [
        {
          type: "message",
          sessionId: id,
          cwd: recordedCwd,
          timestamp: "2026-07-06T10:00:00.000Z",
          message: { role: "user", content: "fork me in place" },
        },
      ],
    );
    const create = vi.fn(async (_args: PtyCreateArgs) => ({
      sessionId: "terminal-claude",
      ptyId: "pty-claude",
      pid: 42,
    }));
    const service = createExternalSessionsService({
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: makeLogger(),
    });

    await service.importExternalSession({
      provider: "claude",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    });

    const ptyArgs = create.mock.calls[0]![0];
    // A transplant would duplicate the whole transcript under a fresh uuid and
    // launch that id instead; the cheap in-place fork keeps the original.
    expect(ptyArgs.startupCommand).toContain(id);
    expect(ptyArgs.allowExternalCwd).toBe(false);
  });
});

describe("droid fork probe", () => {
  function droidFixture() {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "droid-probe-session";
    writeJsonl(path.join(homeDir, ".factory", "sessions", droidSessionDir(laneCwd), `${id}.jsonl`), [
      { type: "session_start", id, cwd: laneCwd, timestamp: "2026-07-06T10:00:00.000Z" },
    ]);
    return { homeDir, projectRoot, laneCwd, id };
  }

  it("does not cache a negative answer when the probe never ran", async () => {
    // Node has refused to spawn a `.cmd`/`.bat` without a shell since
    // CVE-2024-27980, so a probe against an npm shim used to come back
    // `spawn EINVAL` with the error discarded — caching "no --fork" for the
    // service's whole lifetime and permanently disabling fork import.
    const { homeDir, projectRoot, laneCwd, id } = droidFixture();
    const warn = vi.fn();
    let call = 0;
    execFileMock.mockImplementation((...callArgs: any[]) => {
      const callback = callArgs[3] as (error: Error | null, stdout: string, stderr: string) => void;
      call += 1;
      const failed = call === 1;
      setTimeout(() => (failed
        ? callback(Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }), "", "")
        : callback(null, "usage: droid --resume --fork", "")), 0);
      return { pid: 123 } as ReturnType<typeof execFile>;
    });
    const create = vi.fn(async (_args: PtyCreateArgs) => ({
      sessionId: "terminal-droid",
      ptyId: "pty-droid",
      pid: 7,
    }));
    const service = createExternalSessionsService({
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create },
      logger: { warn, info: vi.fn() },
    });

    await expect(service.importExternalSession({
      provider: "droid",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    })).resolves.toMatchObject({ kind: "cli" });

    expect(warn).toHaveBeenCalledWith(
      "external_sessions.droid_fork_probe_failed",
      expect.objectContaining({ error: expect.stringContaining("EINVAL") }),
    );
    expect(create.mock.calls[0]![0].startupCommand).toBe(`droid --fork ${id}`);
  });

  it.runIf(process.platform === "win32")("probes droid through cmd.exe rather than spawning the shim directly", async () => {
    const { homeDir, projectRoot, laneCwd } = droidFixture();
    execFileMock.mockImplementation((...callArgs: any[]) => {
      const callback = callArgs[3] as (error: Error | null, stdout: string, stderr: string) => void;
      setTimeout(() => callback(null, "usage: droid --resume --fork", ""), 0);
      return { pid: 123 } as ReturnType<typeof execFile>;
    });
    createExternalSessionsService({
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    expect(execFileMock).toHaveBeenCalled();
    const [command, spawnArgs] = execFileMock.mock.calls[0]! as unknown as [string, string[]];
    expect(command.toLowerCase()).toContain("cmd");
    expect(spawnArgs.join(" ")).toContain("droid");
    expect(spawnArgs.join(" ")).toContain("--help");
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

  it("rolls back the fork transcript and sidecar directory when sidecar copy fails", async () => {
    const configDir = path.join(root, "claude-sidecar-rollback");
    const sourceCwd = path.join(root, "source-sidecar");
    const targetCwd = path.join(root, "target-sidecar");
    const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const sourceDir = path.join(configDir, "projects", claudeProjectSlugForCwd(sourceCwd));
    const sourcePath = path.join(sourceDir, `${sessionId}.jsonl`);
    writeJsonl(sourcePath, [{ type: "message", sessionId, text: "source stays intact" }]);
    fs.mkdirSync(path.join(sourceDir, sessionId), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, sessionId, "tool-result.txt"), "sidecar", "utf8");
    const copyFile = vi.spyOn(fs.promises, "copyFile").mockRejectedValueOnce(new Error("mock sidecar copy failure"));

    try {
      await expect(transplantClaudeSession({ sessionId, sourceCwd, targetCwd, fork: true, configDir }))
        .rejects.toThrow("mock sidecar copy failure");
    } finally {
      copyFile.mockRestore();
    }

    expect(fs.existsSync(sourcePath)).toBe(true);
    const targetDir = path.join(configDir, "projects", claudeProjectSlugForCwd(targetCwd));
    expect(fs.existsSync(targetDir) ? fs.readdirSync(targetDir) : []).toEqual([]);
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

describe("externalSessionsService imported-session marking", () => {
  function writeClaudeSession(args: { homeDir: string; cwd: string; id: string; text: string }): string {
    const filePath = path.join(
      args.homeDir,
      ".claude",
      "projects",
      claudeProjectSlugForCwd(args.cwd),
      `${args.id}.jsonl`,
    );
    writeJsonl(filePath, [
      {
        type: "message",
        sessionId: args.id,
        cwd: args.cwd,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: args.text },
      },
    ]);
    return filePath;
  }

  function laneSetup(): { homeDir: string; projectRoot: string; laneCwd: string } {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneCwd, { recursive: true });
    return { homeDir, projectRoot, laneCwd };
  }

  it("hides live ADE-tracked sessions and re-lists them after the ADE row is gone", async () => {
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const id = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
    writeClaudeSession({ homeDir, cwd: laneCwd, id, text: "import then delete" });
    let liveSessions: TerminalSessionSummary[] = [];
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => liveSessions, listClaudeSessionPointers: () => [] },
      ptyService: {
        create: vi.fn(async (_args: PtyCreateArgs) => ({ sessionId: "terminal-durable", ptyId: "pty-durable", pid: 11 })),
      },
      logger: makeLogger(),
    });

    await service.importExternalSession({
      provider: "claude",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
    });

    liveSessions = [{ id: "terminal-durable", toolType: "claude" } as TerminalSessionSummary];
    const listArgs: ExternalSessionListArgs = {
      providers: ["claude"],
      laneId: "lane-1",
      scope: "project",
      limit: 5,
    };
    await expect(service.list({ ...listArgs })).resolves.toEqual([]);

    liveSessions = [];
    await expect(service.list({ ...listArgs })).resolves.toMatchObject([
      { alreadyImported: false, importedBefore: true, importedSessionRef: null },
    ]);
  });

  it("hides a Codex chat fork's new thread and keeps listing its untouched original", async () => {
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const sourceId = "c0dec0de-0000-4000-8000-000000000001";
    const forkId = "c0dec0de-0000-4000-8000-000000000002";
    for (const threadId of [sourceId, forkId]) {
      writeJsonl(
        path.join(homeDir, ".codex", "sessions", "2026", "07", "06", `rollout-2026-07-06T10-00-00-${threadId}.jsonl`),
        [
          {
            timestamp: "2026-07-06T10:00:00.000Z",
            type: "session_meta",
            payload: { id: threadId, cwd: laneCwd, timestamp: "2026-07-06T10:00:00.000Z" },
          },
          { timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "fix the build" } },
        ],
      );
    }
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: {
        list: () => [{ id: "chat-codex", toolType: "codex-chat" } as TerminalSessionSummary],
        listClaudeSessionPointers: () => [],
      },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
      chatImporter: {
        importExternalChatSession: async () => ({
          chatSessionId: "chat-codex",
          chatSummary: makeImportedChatSummary("chat-codex"),
          providerTargetId: forkId,
        }),
      },
    });

    await service.importExternalSession({
      provider: "codex",
      sessionId: sourceId,
      laneId: "lane-1",
      target: "chat",
      mode: "fork",
    });

    const rows = await service.list({ providers: ["codex"], laneId: "lane-1", scope: "project", limit: 10 });
    expect(rows.map((row) => row.id)).toEqual([sourceId]);
    expect(rows[0]).toMatchObject({ alreadyImported: false, importedBefore: true, importedSessionRef: null });
    const lookedUpFork = await service.list({
      providers: ["codex"],
      laneId: "lane-1",
      scope: "project",
      sessionId: forkId,
    });
    expect(lookedUpFork[0]).toMatchObject({
      alreadyImported: true,
      importedSessionRef: { kind: "chat", sessionId: "chat-codex" },
    });
  });

  it("lists a Claude session again once the chat its pointer names is deleted", async () => {
    // 2026-09-23: deleting an imported chat left its pointer behind, and the
    // session stayed hidden from the importer for good.
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const id = "abababab-abab-4bab-8bab-abababababab";
    writeClaudeSession({ homeDir, cwd: laneCwd, id, text: "was imported, chat deleted" });
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: {
        list: () => [],
        listClaudeSessionPointers: () => [{ sessionId: id, chatSessionId: "deleted-chat" }],
      },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
    });

    const rows = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 5 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, alreadyImported: false, importedBefore: true, importedSessionRef: null });
  });

  it("keeps listing an original that its ADE copy absorbed through shared history", async () => {
    // 2026-09-23 live test: a copy shares the original's record uuids, so
    // discovery folded the original into the (hidden) copy and it vanished.
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const otherLane = path.join(projectRoot, ".ade", "worktrees", "lane-2");
    fs.mkdirSync(otherLane, { recursive: true });
    const id = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
    const rows = Array.from({ length: 6 }, (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      uuid: `00000000-0000-4000-8000-00000000000${index}`,
      parentUuid: index ? `00000000-0000-4000-8000-00000000000${index - 1}` : null,
      sessionId: id,
      cwd: laneCwd,
      timestamp: `2026-07-06T10:00:0${index}.000Z`,
      message: index % 2 === 0
        ? { role: "user", content: `question ${index}` }
        : { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
    }));
    writeJsonl(path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd), `${id}.jsonl`), rows);
    const terminals: TerminalSessionSummary[] = [];
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: {
        getLaneWorktreePath: (laneId: string) => (laneId === "lane-2" ? otherLane : laneCwd),
        list: () => [
          { id: "lane-1", name: "Lane one", branchRef: "refs/heads/one", color: null, laneType: "worktree", worktreePath: laneCwd },
          { id: "lane-2", name: "Lane two", branchRef: "refs/heads/two", color: null, laneType: "worktree", worktreePath: otherLane },
        ],
      },
      sessionService: { list: () => terminals, listClaudeSessionPointers: () => [] },
      ptyService: {
        create: vi.fn(async (args: PtyCreateArgs) => {
          terminals.push({ id: "copy-terminal", toolType: "claude", resumeMetadata: args.resumeMetadata } as TerminalSessionSummary);
          return { sessionId: "copy-terminal", ptyId: "pty", pid: 7 };
        }),
      },
      logger: makeLogger(),
    });

    await service.importExternalSession({ provider: "claude", sessionId: id, laneId: "lane-2", target: "cli", mode: "fork" });
    const rows2 = await service.list({ providers: ["claude"], scope: "project", limit: 10 });

    expect(rows2.map((row) => row.id)).toEqual([id]);
    expect(rows2[0]).toMatchObject({ importedBefore: true, alreadyImported: false });
  });

  it("hides the transplanted Claude copy but keeps listing the untouched original", async () => {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "repo");
    const sourceCwd = path.join(projectRoot, "source");
    const laneCwd = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(sourceCwd, { recursive: true });
    fs.mkdirSync(laneCwd, { recursive: true });
    const id = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
    writeClaudeSession({ homeDir, cwd: sourceCwd, id, text: "copy me into the lane" });
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: {
        list: () => [{ id: "terminal-transplant", toolType: "claude" } as TerminalSessionSummary],
        listClaudeSessionPointers: () => [],
      },
      ptyService: {
        create: vi.fn(async (_args: PtyCreateArgs) => ({
          sessionId: "terminal-transplant",
          ptyId: "pty-transplant",
          pid: 12,
        })),
      },
      logger: makeLogger(),
    });

    await service.importExternalSession({
      provider: "claude",
      sessionId: id,
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
    });

    const laneProjectDir = path.join(
      homeDir,
      ".claude",
      "projects",
      claudeProjectSlugForCwd(fs.realpathSync(laneCwd)),
    );
    expect(fs.readdirSync(laneProjectDir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);

    // The transplanted copy is a real Claude transcript on disk; it must not
    // come back as a session the user can import into ADE a second time. The
    // original is untouched by a copy, so it stays importable with a hint.
    const rows = await service.list({ providers: ["claude"], scope: "all", limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, alreadyImported: false, importedBefore: true });
  });

  it("marks a continuation-chain leaf that was imported under an ancestor id", async () => {
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const ancestorId = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
    const leafId = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
    const turn = (index: number) => ({
      type: "user",
      uuid: `f0f0f0f0-f0f0-4f0f-8f0f-${String(index).padStart(12, "0")}`,
      cwd: laneCwd,
      entrypoint: "cli",
      message: { role: "user", content: [{ type: "text", text: `turn ${index}` }] },
    });
    const shared = Array.from({ length: 6 }, (_, index) => turn(index));
    const projectDir = path.join(homeDir, ".claude", "projects", claudeProjectSlugForCwd(laneCwd));
    writeJsonl(path.join(projectDir, `${ancestorId}.jsonl`), shared);
    writeJsonl(
      path.join(projectDir, `${leafId}.jsonl`),
      [...shared, ...Array.from({ length: 4 }, (_, index) => turn(6 + index))],
    );

    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: {
        list: () => [{ id: "chat-ancestor", toolType: "claude-chat" } as TerminalSessionSummary],
        listClaudeSessionPointers: () => [],
      },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
      importedSessionStore: {
        list: () => [{
          provider: "claude",
          externalId: ancestorId,
          targetId: null,
          kind: "chat" as const,
          adeSessionId: "chat-ancestor",
          mode: "continue" as const,
          importedAt: "2026-07-06T10:00:00.000Z",
        }],
        record: vi.fn(),
      },
    });

    const rows = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 10 });
    expect(rows).toEqual([]);
  });

  it("reads Claude activity from the live-session registry instead of file mtime", async () => {
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const openId = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    const closedId = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
    writeClaudeSession({ homeDir, cwd: laneCwd, id: openId, text: "still open" });
    // Written just now, but no live process owns it.
    writeClaudeSession({ homeDir, cwd: laneCwd, id: closedId, text: "just closed" });
    const registryPath = path.join(homeDir, ".claude", "sessions", `${process.pid}.json`);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ pid: process.pid, sessionId: openId, cwd: laneCwd, kind: "interactive" }),
      "utf8",
    );
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
      inspectLiveSessions: () => ({
        availability: { available: true, method: "lsof" },
        byKey: new Map(),
      }),
    });

    const rows = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 10 });
    const active = Object.fromEntries(rows.map((row) => [row.id, row.possiblyActive]));

    expect(active).toEqual({ [openId]: true, [closedId]: false });
  });

  it("reads the newest registry entries when dead ones outnumber the cap", async () => {
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const openId = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
    writeClaudeSession({ homeDir, cwd: laneCwd, id: openId, text: "still open" });
    const registryDir = path.join(homeDir, ".claude", "sessions");
    fs.mkdirSync(registryDir, { recursive: true });
    // Claude never prunes this directory, so a long-running install accumulates
    // far more dead entries than any one pass will open.
    const staleSeconds = (Date.now() - 60 * 60_000) / 1000;
    for (let index = 0; index < 2_000; index += 1) {
      const deadPath = path.join(registryDir, `${4_000_000 + index}.json`);
      fs.writeFileSync(
        deadPath,
        JSON.stringify({ pid: 4_000_000 + index, sessionId: `dead-${index}`, cwd: laneCwd }),
        "utf8",
      );
      fs.utimesSync(deadPath, staleSeconds, staleSeconds);
    }
    fs.writeFileSync(
      path.join(registryDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: openId, cwd: laneCwd, kind: "interactive" }),
      "utf8",
    );
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
      inspectLiveSessions: () => ({
        availability: { available: true, method: "lsof" },
        byKey: new Map(),
      }),
    });

    const rows = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 10 });

    expect(rows.find((row) => row.id === openId)?.possiblyActive).toBe(true);
  });

  it("returns as many rows as the caller asks for, not the default page", async () => {
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    for (let index = 0; index < 60; index += 1) {
      writeClaudeSession({
        homeDir,
        cwd: laneCwd,
        id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        text: `session ${index}`,
      });
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

    await expect(service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 60 }))
      .resolves.toHaveLength(60);
    await expect(service.list({ providers: ["claude"], laneId: "lane-1", scope: "project" }))
      .resolves.toHaveLength(50);
  });

  it("drops empty droid stubs from browse but still resolves them by id", async () => {
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const emptyId = "stubstub-0000-4000-8000-000000000001";
    const usedId = "usedused-0000-4000-8000-000000000002";
    const emptyPath = path.join(homeDir, ".factory", "sessions", droidSessionDir(laneCwd), `${emptyId}.jsonl`);
    const usedPath = path.join(homeDir, ".factory", "sessions", droidSessionDir(laneCwd), `${usedId}.jsonl`);
    writeJsonl(emptyPath, [{
      type: "session_start",
      id: emptyId,
      title: "New Session",
      cwd: laneCwd,
      timestamp: "2026-07-06T10:00:00.000Z",
    }]);
    writeJsonl(usedPath, [
      {
        type: "session_start",
        id: usedId,
        title: "New Session",
        cwd: laneCwd,
        timestamp: "2026-07-06T10:00:00.000Z",
      },
      {
        type: "message",
        message: { role: "user", content: "do work" },
        timestamp: "2026-07-06T10:01:00.000Z",
      },
    ]);
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: makeLogger(),
      inspectLiveSessions: () => ({
        availability: { available: true, method: "lsof" },
        byKey: new Map(),
      }),
    });
    const rows = await service.list({ providers: ["droid"], laneId: "lane-1", scope: "project", limit: 10 });
    expect(rows.map((row) => row.id)).toEqual([usedId]);
    const lookedUp = await service.list({
      providers: ["droid"],
      laneId: "lane-1",
      scope: "project",
      sessionId: emptyId,
    });
    expect(lookedUp.map((row) => row.id)).toEqual([emptyId]);
  });

  it("marks a foreign-held session live and hides one held by an ADE PTY", async () => {
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const foreignId = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
    const ownedId = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    writeClaudeSession({ homeDir, cwd: laneCwd, id: foreignId, text: "foreign" });
    writeClaudeSession({ homeDir, cwd: laneCwd, id: ownedId, text: "ade owned" });
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn(), listLiveTrackedCliPids: () => [4242] },
      logger: makeLogger(),
      inspectLiveSessions: () => ({
        availability: { available: true, method: "lsof" },
        byKey: new Map([
          [`claude:${foreignId}`, [{
            provider: "claude" as const,
            sessionId: foreignId,
            filePath: "/tmp/foreign.jsonl",
            pid: 99,
          }]],
          [`claude:${ownedId}`, [{
            provider: "claude" as const,
            sessionId: ownedId,
            filePath: "/tmp/owned.jsonl",
            pid: 4242,
          }]],
        ]),
      }),
    });
    const rows = await service.list({ providers: ["claude"], laneId: "lane-1", scope: "project", limit: 10 });
    expect(rows.map((row) => row.id)).toEqual([foreignId]);
    expect(rows[0]?.possiblyActive).toBe(true);
  });

  it("reports an uninstalled OpenCode CLI to a scan that asked only for it", async () => {
    const { homeDir, projectRoot, laneCwd } = laneSetup();
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    const previousDisableBundled = process.env.ADE_DISABLE_BUNDLED_OPENCODE;
    // Binary resolution also searches HOME-derived CLI directories, so PATH
    // alone does not describe a machine without OpenCode.
    process.env.PATH = path.join(root, "missing-bin");
    process.env.HOME = homeDir;
    process.env.ADE_DISABLE_BUNDLED_OPENCODE = "1";
    clearOpenCodeBinaryCache();
    const logger = makeLogger();
    const service = createExternalSessionsService({
      droidForkSupported: true,
      projectRoot,
      homeDir,
      laneService: { getLaneWorktreePath: () => laneCwd },
      sessionService: { list: () => [], listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger,
    });

    try {
      await expect(service.list({ providers: ["opencode"], scope: "all" }))
        .rejects.toThrow(/OpenCode CLI not found/u);
      // A mixed scan still returns the providers that did work.
      await expect(service.list({ providers: ["claude", "opencode"], scope: "all" })).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "external_sessions.discovery_failed",
        expect.objectContaining({ provider: "opencode" }),
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDisableBundled === undefined) delete process.env.ADE_DISABLE_BUNDLED_OPENCODE;
      else process.env.ADE_DISABLE_BUNDLED_OPENCODE = previousDisableBundled;
      clearOpenCodeBinaryCache();
    }
  });
});

// importedSessionStore suite (folded in from importedSessionStore.test.ts during
// /test consolidation; the store's only consumer is this service).
describe("imported session store (module)", () => {
let storeRoot: string;


function storeRecord(index: number) {
  return {
    provider: "codex",
    externalId: `external-${index}`,
    targetId: null,
    kind: "cli" as const,
    adeSessionId: `ade-${index}`,
    mode: "continue" as const,
  };
}

beforeEach(() => {
  storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-imported-store-"));
});

afterEach(() => {
  fs.rmSync(storeRoot, { recursive: true, force: true });
});

describe("imported session store", () => {
  it("keeps a record another host appended since this store last read", () => {
    const desktop = createImportedSessionStore({ homeDir: storeRoot });
    const headless = createImportedSessionStore({ homeDir: storeRoot });

    desktop.record(storeRecord(1));
    // Populates the desktop store's cache, which the second write must not trust.
    expect(desktop.list()).toHaveLength(1);
    headless.record(storeRecord(2));
    desktop.record(storeRecord(3));

    const externalIds = createImportedSessionStore({ homeDir: storeRoot })
      .list()
      .map((entry) => entry.externalId)
      .sort();
    expect(externalIds).toEqual(["external-1", "external-2", "external-3"]);
  });

  it("takes over a lock left behind by a process that died holding it", () => {
    const filePath = importedSessionsPath({ homeDir: storeRoot });
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(lockPath, "", "utf8");
    const longAgo = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, longAgo, longAgo);
    const warn = vi.fn();
    const store = createImportedSessionStore({ homeDir: storeRoot, logger: { warn } });

    const startedAt = Date.now();
    store.record(storeRecord(1));

    expect(store.list().map((entry) => entry.externalId)).toEqual(["external-1"]);
    expect(warn).not.toHaveBeenCalled();
    // Waiting out a lock nobody holds would stall every import behind it.
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("writes anyway when a live lock never clears", () => {
    const filePath = importedSessionsPath({ homeDir: storeRoot });
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(lockPath, "", "utf8");
    const warn = vi.fn();
    const store = createImportedSessionStore({ homeDir: storeRoot, logger: { warn } });

    // An import that already created the ADE session must never fail because
    // its receipt could not take the lock.
    store.record(storeRecord(1));

    expect(store.list().map((entry) => entry.externalId)).toEqual(["external-1"]);
    expect(warn).toHaveBeenCalledWith(
      "external_sessions.imported_store_lock_timeout",
      expect.objectContaining({ path: lockPath }),
    );
  });
});
});

describe("externalSessionsService list sharing", () => {
  let root: string;
  let previousAdeHome: string | undefined;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-list-sharing-")));
    fs.mkdirSync(path.join(root, "repo"), { recursive: true });
    previousAdeHome = process.env.ADE_HOME;
    process.env.ADE_HOME = path.join(root, "ade-home");
  });

  afterEach(() => {
    if (previousAdeHome === undefined) delete process.env.ADE_HOME;
    else process.env.ADE_HOME = previousAdeHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("externalSessionsService list sharing", () => {
    it("runs the machine-wide process scan once for a burst of per-provider calls, and again for the next call", async () => {
      const inspectLiveSessions = vi.fn(async () => ({
        availability: { available: true as const, method: "lsof" as const },
        byKey: new Map(),
      }));
      const sessionsList = vi.fn(() => []);
      const service = createExternalSessionsService({
        projectRoot: path.join(root, "repo"),
        homeDir: path.join(root, "home"),
        env: { PATH: "" },
        droidForkSupported: true,
        laneService: { getLaneWorktreePath: () => path.join(root, "repo"), list: () => [] },
        sessionService: { list: sessionsList, listClaudeSessionPointers: () => [] },
        ptyService: { create: vi.fn() },
        logger: { warn: vi.fn(), info: vi.fn() },
        inspectLiveSessions,
      });
      const providers = EXTERNAL_SESSION_PROVIDERS.filter((provider) => provider !== "opencode");

      await Promise.all(providers.map((provider) => service.list({ providers: [provider], scope: "project" })));
      expect(inspectLiveSessions).toHaveBeenCalledTimes(1);
      expect(sessionsList).toHaveBeenCalledTimes(1);

      // Settled: the next call reads fresh state.
      await service.list({ providers: ["claude"], scope: "project" });
      expect(inspectLiveSessions).toHaveBeenCalledTimes(2);
    });
  });
});

describe("externalSessionsService ACP provider imports", () => {
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
});
