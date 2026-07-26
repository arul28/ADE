import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdeRuntime } from "../../bootstrap";
import { PersonalChatScope } from "./personalChatScope";

describe("PersonalChatScope", () => {
  let adeHome: string;
  let previousAdeHome: string | undefined;

  beforeEach(() => {
    previousAdeHome = process.env.ADE_HOME;
    adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-personal-chat-scope-"));
    process.env.ADE_HOME = adeHome;
  });

  afterEach(() => {
    if (previousAdeHome == null) delete process.env.ADE_HOME;
    else process.env.ADE_HOME = previousAdeHome;
    fs.rmSync(adeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function fixture(surface: "personal" | "work" = "personal") {
    const summary = {
      sessionId: "chat-1",
      laneId: "internal-lane",
      provider: "codex",
      model: "gpt-5",
      surface,
      status: "idle",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      lastOutputPreview: null,
      summary: null,
    } as const;
    const service = {
      listSessions: vi.fn(async () => [summary]),
      createSession: vi.fn(async (args) => ({
        id: "chat-1",
        ...args,
        status: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
      })),
      getSessionSummary: vi.fn(async () => summary),
      sendMessage: vi.fn(async () => undefined),
      readTranscript: vi.fn(async () => []),
      steer: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      recoverTurn: vi.fn(async ({ turnId, action }) => ({
        turnId,
        action,
        status: action === "nudge" ? "nudged" : "waiting",
      })),
      resolveUnprocessedMessage: vi.fn(async ({ steerId, action }) => ({
        steerId,
        action,
        status: "completed",
      })),
      respondToInput: vi.fn(async () => undefined),
      approveToolUse: vi.fn(async () => undefined),
      createScheduledWork: vi.fn(async ({ sessionId, cron, runAt, prompt }: {
        sessionId: string;
        cron?: string;
        runAt?: string;
        prompt: string;
      }) => ({
        item: {
          id: "cron-created",
          sessionId,
          ...(cron ? { cron } : {}),
          ...(runAt ? { nextRunAt: runAt } : {}),
          prompt,
          status: "scheduled",
        },
        timeZone: "America/New_York",
      })),
      cancelScheduledWork: vi.fn(async ({ sessionId, scheduleId }: {
        sessionId: string;
        scheduleId: string;
      }) => ({
        schedule: { id: scheduleId, sessionId, status: "cancelled" },
        providerCancellationRequested: true,
        providerCancellationConfirmed: true,
      })),
      setScheduledWorkPaused: vi.fn(async ({ sessionId, paused }: {
        sessionId: string;
        paused: boolean;
      }) => ({ sessionId, paused, nextWakeAt: null })),
      updateSession: vi.fn(async () => summary),
      ensureSessionSurface: vi.fn(),
      archiveSession: vi.fn(async () => undefined),
      unarchiveSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      getAvailableModels: vi.fn(async () => []),
      getModelCatalog: vi.fn(async () => ({ groups: [], fetchedAt: "now" })),
      getChatEventHistory: vi.fn(() => ({ sessionId: "chat-1", events: [], truncated: false, sessionFound: true })),
      getChatEventHistoryPage: vi.fn(() => ({ sessionId: "chat-1", events: [], startOffset: 0, hasMore: false, sessionFound: true })),
    };
    const runtime = {
      agentChatService: service,
      projectRoot: path.join(adeHome, "personal-chats", "state"),
      workspaceRoot: path.join(adeHome, "personal-chats", "workspaces"),
      laneService: {
        list: vi.fn(async () => [{ id: "internal-lane", laneType: "primary" }]),
      },
      ptyService: {
        create: vi.fn(async () => ({ ptyId: "pty-personal", sessionId: "terminal-personal", pid: 42 })),
        writeTerminal: vi.fn(async () => ({ ok: true as const })),
        resizeTerminal: vi.fn(() => ({ ok: true as const, cols: 100, rows: 30 })),
        dispose: vi.fn(() => ({ disposed: true, reason: "disposed" as const })),
      },
      sessionService: { get: vi.fn(() => ({ transcriptPath: "/tmp/chat-1.jsonl" })) },
      eventBuffer: { drain: vi.fn(() => ({ events: [], nextCursor: 0, hasMore: false, eventEpoch: "epoch", gap: false, oldestCursor: null })) },
      dispose: vi.fn(),
    } as unknown as AdeRuntime;
    const createRuntime = vi.fn(async (
      _args: Parameters<typeof import("../../bootstrap").createAdeRuntime>[0],
    ): Promise<AdeRuntime> => runtime);
    return { summary, service, runtime, createRuntime };
  }

  it("resolves a compressed durable personal transcript", async () => {
    const { runtime, createRuntime } = fixture();
    const durablePath = path.join(runtime.projectRoot, ".ade", "transcripts", "chat", "chat-1.jsonl");
    fs.mkdirSync(path.dirname(durablePath), { recursive: true });
    fs.writeFileSync(`${durablePath}.gz`, gzipSync("history\n"));
    const scope = new PersonalChatScope({ createRuntime });

    await expect(scope.transcriptPath("chat-1")).resolves.toBe(`${durablePath}.gz`);
    await scope.dispose();
  });

  it("repairs legacy surface metadata for transcript and activity subscriptions", async () => {
    const { summary, service, runtime, createRuntime } = fixture("work");
    service.getSessionSummary.mockResolvedValue({
      ...summary,
      status: "active",
    } as never);
    const durablePath = path.join(runtime.projectRoot, ".ade", "transcripts", "chat", "chat-1.jsonl");
    fs.mkdirSync(path.dirname(durablePath), { recursive: true });
    fs.writeFileSync(durablePath, "history\n");
    const scope = new PersonalChatScope({ createRuntime });

    await expect(scope.transcriptPath("chat-1")).resolves.toBe(durablePath);
    await expect(scope.isTurnActive("chat-1")).resolves.toBe(true);
    expect(service.ensureSessionSurface).toHaveBeenCalledWith("chat-1", "personal");
    await scope.dispose();
  });

  it("creates a hidden personal session and dispatches an optional kickoff", async () => {
    const { service, createRuntime } = fixture();
    const scope = new PersonalChatScope({ createRuntime });

    const response = await scope.call("create", {
      provider: "codex",
      model: "gpt-5",
      laneId: "attacker-lane",
      requestedCwd: "/tmp/outside",
      surface: "work",
      sessionProfile: "workflow",
      kickoffText: "hello",
    });

    expect(response.action).toBe("create");
    expect(service.createSession).toHaveBeenCalledWith(expect.objectContaining({
      laneId: "internal-lane",
      surface: "personal",
      sessionProfile: "light",
      permissionMode: "default",
    }));
    expect(service.createSession).not.toHaveBeenCalledWith(expect.objectContaining({ requestedCwd: expect.anything() }));
    expect(service.sendMessage).toHaveBeenCalledWith(
      { sessionId: "chat-1", text: "hello" },
      { awaitDispatch: false },
    );
    const runtimeArgs = createRuntime.mock.calls[0]?.[0];
    if (!runtimeArgs || typeof runtimeArgs === "string") throw new Error("Expected structured runtime args");
    expect(runtimeArgs?.projectRoot).toBe(path.join(adeHome, "personal-chats", "state"));
    expect(runtimeArgs?.primaryWorktreePath).toBe(path.join(adeHome, "personal-chats", "workspaces"));
    expect(runtimeArgs?.projectRoot).not.toBe(runtimeArgs?.primaryWorktreePath);
    expect(runtimeArgs.runtimeProfile).toBe("chat");
    expect(runtimeArgs.publishPushEvents).toBe(false);
  });

  it("repairs legacy surface metadata while listing the hidden scope", async () => {
    const personal = fixture("personal");
    const scope = new PersonalChatScope({ createRuntime: personal.createRuntime });
    await expect(scope.call("list", { includeArchived: false })).resolves.toMatchObject({
      action: "list",
      result: [{ sessionId: "chat-1", surface: "personal" }],
    });

    const work = fixture("work");
    const workScope = new PersonalChatScope({ createRuntime: work.createRuntime });
    await expect(workScope.call("list", {})).resolves.toMatchObject({
      result: [{ sessionId: "chat-1", surface: "personal" }],
    });
    expect(work.service.ensureSessionSurface).toHaveBeenCalledWith("chat-1", "personal");
    expect(personal.service.listSessions).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ includeArchived: false }),
    );
  });

  it("repairs legacy surface metadata before a session-scoped call", async () => {
    const { createRuntime, service } = fixture("work");
    const scope = new PersonalChatScope({ createRuntime });
    await expect(scope.call("send", { sessionId: "chat-1", text: "continue" }))
      .resolves.toMatchObject({ action: "send" });
    expect(service.getSessionSummary).toHaveBeenCalledWith("chat-1");
    expect(service.ensureSessionSurface).toHaveBeenCalledWith("chat-1", "personal");
    expect(service.sendMessage).toHaveBeenCalledWith({ sessionId: "chat-1", text: "continue" });
  });

  it("routes recovery and durable message resolution only for personal sessions", async () => {
    const { createRuntime, service } = fixture();
    const scope = new PersonalChatScope({ createRuntime });

    await expect(scope.call("recoverTurn", {
      sessionId: "chat-1",
      turnId: "turn-1",
      action: "nudge",
    })).resolves.toMatchObject({
      action: "recoverTurn",
      result: { turnId: "turn-1", action: "nudge", status: "nudged" },
    });
    await expect(scope.call("resolveUnprocessedMessage", {
      sessionId: "chat-1",
      steerId: "steer-1",
      action: "run_next",
    })).resolves.toMatchObject({
      action: "resolveUnprocessedMessage",
      result: { steerId: "steer-1", action: "run_next", status: "completed" },
    });

    expect(service.recoverTurn).toHaveBeenCalledWith({
      sessionId: "chat-1",
      turnId: "turn-1",
      action: "nudge",
    });
    expect(service.resolveUnprocessedMessage).toHaveBeenCalledWith({
      sessionId: "chat-1",
      steerId: "steer-1",
      action: "run_next",
    });
  });

  it("rejects session-scoped calls when the session row is missing", async () => {
    const { createRuntime, service } = fixture();
    service.getSessionSummary.mockResolvedValueOnce(null as never);
    const scope = new PersonalChatScope({ createRuntime });
    await expect(scope.call("send", { sessionId: "missing", text: "nope" }))
      .rejects.toThrow("Personal chat session 'missing' was not found");
    expect(service.sendMessage).not.toHaveBeenCalled();
  });

  it("prewarms only when personal-chat state already exists", async () => {
    const { createRuntime } = fixture();
    const scope = new PersonalChatScope({ createRuntime });
    await scope.warmExisting();
    expect(createRuntime).not.toHaveBeenCalled();

    const dbPath = path.join(adeHome, "personal-chats", "state", ".ade", "ade.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");

    await scope.warmExisting();
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  it("cancels scheduled work only for an owned personal session", async () => {
    const { createRuntime, service } = fixture();
    const scope = new PersonalChatScope({ createRuntime });

    await expect(scope.call("cancelScheduledWork", {
      sessionId: "chat-1",
      scheduleId: "cron-1",
    })).resolves.toMatchObject({
      action: "cancelScheduledWork",
      result: {
        schedule: { id: "cron-1", sessionId: "chat-1", status: "cancelled" },
        providerCancellationConfirmed: true,
      },
    });
    expect(service.cancelScheduledWork).toHaveBeenCalledWith({
      sessionId: "chat-1",
      scheduleId: "cron-1",
    });

    await expect(scope.call("cancelScheduledWork", {
      sessionId: "chat-1",
      scheduleId: " ",
    })).rejects.toThrow("scheduleId is required");
    expect(service.cancelScheduledWork).toHaveBeenCalledTimes(1);
  });

  it("creates and pauses scheduled work only for an owned personal session", async () => {
    const { createRuntime, service } = fixture();
    const scope = new PersonalChatScope({ createRuntime });

    await expect(scope.call("createScheduledWork", {
      sessionId: "chat-1",
      cron: "*/20 * * * *",
      prompt: "Check PR CI",
    })).resolves.toMatchObject({
      action: "createScheduledWork",
      result: { item: { id: "cron-created", sessionId: "chat-1", status: "scheduled" } },
    });
    expect(service.createScheduledWork).toHaveBeenCalledWith({
      sessionId: "chat-1",
      cron: "*/20 * * * *",
      prompt: "Check PR CI",
    });

    await expect(scope.call("createScheduledWork", {
      sessionId: "chat-1",
      delaySeconds: 720,
      prompt: "Check PR CI again",
    })).resolves.toMatchObject({
      action: "createScheduledWork",
      result: { item: { id: "cron-created", sessionId: "chat-1" } },
    });
    expect(service.createScheduledWork).toHaveBeenLastCalledWith({
      sessionId: "chat-1",
      delaySeconds: 720,
      prompt: "Check PR CI again",
    });

    await expect(scope.call("createScheduledWork", {
      sessionId: "chat-1",
      runAt: "2026-07-23T01:05:00-04:00",
      prompt: "Check PR CI at the requested time",
    })).resolves.toMatchObject({
      action: "createScheduledWork",
      result: {
        item: {
          id: "cron-created",
          sessionId: "chat-1",
        },
      },
    });
    expect(service.createScheduledWork).toHaveBeenLastCalledWith({
      sessionId: "chat-1",
      runAt: "2026-07-23T01:05:00-04:00",
      prompt: "Check PR CI at the requested time",
    });

    await expect(scope.call("setScheduledWorkPaused", {
      sessionId: "chat-1",
      paused: true,
    })).resolves.toEqual({
      action: "setScheduledWorkPaused",
      result: { sessionId: "chat-1", paused: true, nextWakeAt: null },
    });
    expect(service.setScheduledWorkPaused).toHaveBeenCalledWith({
      sessionId: "chat-1",
      paused: true,
    });
    await expect(scope.call("setScheduledWorkPaused", {
      sessionId: "chat-1",
      paused: "yes",
    })).rejects.toThrow("paused must be a boolean");
    expect(service.setScheduledWorkPaused).toHaveBeenCalledTimes(1);
  });

  it("exposes only the hard allowlisted personal-chat actions", () => {
    const scope = new PersonalChatScope();
    const capabilities = scope.capabilities();
    expect(capabilities.version).toBe(1);
    expect(capabilities.actions).toEqual(expect.arrayContaining([
      "list",
      "create",
      "send",
      "recoverTurn",
      "resolveUnprocessedMessage",
      "createScheduledWork",
      "cancelScheduledWork",
      "setScheduledWorkPaused",
      "updateSession",
      "delete",
    ]));
    expect(capabilities.actions).not.toContain("projects.list");
  });

  it("owns terminal lifecycle inside the hidden workspace", async () => {
    const { createRuntime, runtime } = fixture();
    const scope = new PersonalChatScope({ createRuntime });

    await expect(scope.call("terminalCreate", {
      chatSessionId: "chat-1",
      cols: 100,
      rows: 30,
    })).resolves.toMatchObject({
      action: "terminalCreate",
      result: { ptyId: "pty-personal", sessionId: "terminal-personal", pid: 42 },
    });
    expect(runtime.ptyService.create).toHaveBeenCalledWith({
      laneId: "internal-lane",
      cwd: path.join(adeHome, "personal-chats", "workspaces"),
      chatSessionId: "chat-1",
      cols: 100,
      rows: 30,
      title: "Personal terminal",
      tracked: true,
      toolType: "shell",
    });

    await expect(scope.call("terminalWrite", { ptyId: "pty-personal", data: "pwd\n" }))
      .resolves.toMatchObject({ result: { ok: true } });
    expect(runtime.ptyService.writeTerminal).toHaveBeenCalledWith({
      ptyId: "pty-personal",
      data: "pwd\n",
    });
    await expect(scope.call("terminalResize", { ptyId: "pty-personal", cols: 100, rows: 30 }))
      .resolves.toMatchObject({ result: { ok: true, cols: 100, rows: 30 } });
    await expect(scope.call("terminalDispose", {
      ptyId: "pty-personal",
      sessionId: "terminal-personal",
    })).resolves.toMatchObject({ result: { disposed: true, reason: "disposed" } });

    await expect(scope.call("terminalWrite", { ptyId: "pty-personal", data: "nope" }))
      .rejects.toThrow("Personal terminal 'pty-personal' was not found");
  });

  it("saves validated image attachments only inside hidden state", async () => {
    const { createRuntime } = fixture();
    const scope = new PersonalChatScope({ createRuntime });
    const response = await scope.call("saveTempAttachment", {
      filename: "photo.png",
      mimeType: "image/png",
      base64: "iVBORw0KGgo=",
    });
    expect(response).toMatchObject({
      action: "saveTempAttachment",
      result: { mimeType: "image/png", previewDataUrl: null },
    });
    const savedPath = (response.result as { path: string }).path;
    expect(savedPath.startsWith(path.join(adeHome, "personal-chats", "state", ".ade", "attachments")))
      .toBe(true);
    expect(fs.existsSync(savedPath)).toBe(true);

    await expect(scope.call("getImageDataUrl", { path: savedPath })).resolves.toMatchObject({
      action: "getImageDataUrl",
      result: { dataUrl: expect.stringMatching(/^data:image\/png;base64,/) },
    });
    await expect(scope.call("getImageDataUrl", { path: __filename }))
      .rejects.toThrow(/outside the attachment store/);

    await expect(scope.call("saveTempAttachment", {
      filename: "fake.png",
      mimeType: "image/png",
      base64: Buffer.from("not an image").toString("base64"),
    })).rejects.toThrow(/MIME type does not match/);
  });
});
