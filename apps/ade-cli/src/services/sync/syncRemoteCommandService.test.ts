import { describe, expect, it, vi } from "vitest";
import type { SyncCommandPayload } from "../../../../desktop/src/shared/types";
import { createSyncRemoteCommandService } from "./syncRemoteCommandService";

function makePayload(action: string, args: Record<string, unknown> = {}): SyncCommandPayload {
  return { commandId: "cmd-1", action, args };
}

function createService(options?: {
  agentChatService?: Record<string, unknown>;
}) {
  const ptyService = {
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      ptyId: "pty-1",
      session: { id: "session-1", status: "running" },
    }),
  };
  const service = createSyncRemoteCommandService({
    laneService: {},
    prService: {},
    ptyService,
    sessionService: {},
    fileService: {},
    ...(options?.agentChatService ? { agentChatService: options.agentChatService } : {}),
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  } as any);
  return { service, ptyService };
}

describe("createSyncRemoteCommandService", () => {
  it("routes work.resumeCliSession through the durable PTY resume path", async () => {
    const { service, ptyService } = createService();

    expect(service.getDescriptor("work.resumeCliSession")).toEqual({
      action: "work.resumeCliSession",
      scope: "project",
      policy: { viewerAllowed: true, queueable: true },
    });

    const result = await service.execute(makePayload("work.resumeCliSession", {
      sessionId: "session-1",
      cols: 999,
      rows: 1,
    }));

    expect(ptyService.resumeSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cols: 400,
      rows: 4,
    });
    expect(result).toEqual({
      sessionId: "session-1",
      ptyId: "pty-1",
      session: { id: "session-1", status: "running" },
    });
  });

  it("rejects work.resumeCliSession without a session id", async () => {
    const { service, ptyService } = createService();

    await expect(service.execute(makePayload("work.resumeCliSession"))).rejects.toThrow(
      "work.resumeCliSession requires sessionId.",
    );
    expect(ptyService.resumeSession).not.toHaveBeenCalled();
  });

  it("omits non-finite work.resumeCliSession dimensions", async () => {
    const { service, ptyService } = createService();

    await service.execute(makePayload("work.resumeCliSession", {
      sessionId: "session-1",
      cols: Number.NaN,
      rows: Number.POSITIVE_INFINITY,
    }));

    expect(ptyService.resumeSession).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
  });

  it("routes the canonical chat history page command to the chat service", async () => {
    const getChatEventHistoryPage = vi.fn().mockReturnValue({
      sessionId: "chat-1",
      events: [],
      startOffset: 128,
      hasMore: true,
      sessionFound: true,
    });
    const { service } = createService({
      agentChatService: { getChatEventHistoryPage },
    });

    expect(service.getDescriptor("chat.getChatEventHistoryPage")).toEqual({
      action: "chat.getChatEventHistoryPage",
      scope: "project",
      policy: { viewerAllowed: true },
    });

    const result = await service.execute(makePayload("chat.getChatEventHistoryPage", {
      sessionId: "chat-1",
      beforeOffset: 4096,
      maxBytes: 65_536,
    }));

    expect(getChatEventHistoryPage).toHaveBeenCalledWith("chat-1", {
      beforeOffset: 4096,
      maxBytes: 65_536,
    });
    expect(result).toEqual({
      sessionId: "chat-1",
      events: [],
      startOffset: 128,
      hasMore: true,
      sessionFound: true,
    });
  });
});
