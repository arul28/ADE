import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      respondToInput: vi.fn(async () => undefined),
      approveToolUse: vi.fn(async () => undefined),
      updateSession: vi.fn(async () => summary),
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

  it("filters the hidden scope list to personal sessions", async () => {
    const personal = fixture("personal");
    const scope = new PersonalChatScope({ createRuntime: personal.createRuntime });
    await expect(scope.call("list", { includeArchived: false })).resolves.toMatchObject({
      action: "list",
      result: [{ sessionId: "chat-1", surface: "personal" }],
    });

    const work = fixture("work");
    const workScope = new PersonalChatScope({ createRuntime: work.createRuntime });
    await expect(workScope.call("list", {})).resolves.toMatchObject({ result: [] });
    expect(personal.service.listSessions).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ includeArchived: false }),
    );
  });

  it("rejects session-scoped calls when the session is not personal", async () => {
    const { createRuntime, service } = fixture("work");
    const scope = new PersonalChatScope({ createRuntime });
    await expect(scope.call("send", { sessionId: "chat-1", text: "nope" }))
      .rejects.toThrow("Personal chat session 'chat-1' was not found");
    expect(service.getSessionSummary).toHaveBeenCalledWith("chat-1");
    expect(service.sendMessage).not.toHaveBeenCalled();
  });

  it("exposes only the hard allowlisted personal-chat actions", () => {
    const scope = new PersonalChatScope();
    const capabilities = scope.capabilities();
    expect(capabilities.version).toBe(1);
    expect(capabilities.actions).toEqual(expect.arrayContaining(["list", "create", "send", "updateSession", "delete"]));
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
