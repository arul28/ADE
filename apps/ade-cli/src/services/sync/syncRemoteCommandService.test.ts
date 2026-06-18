import { describe, expect, it, vi } from "vitest";
import type { SyncCommandPayload } from "../../../../desktop/src/shared/types";
import { deriveDeterministicLaneNameFromPrompt } from "../../../../desktop/src/shared/laneNameFallback";
import { createSyncRemoteCommandService } from "./syncRemoteCommandService";

function makePayload(action: string, args: Record<string, unknown> = {}): SyncCommandPayload {
  return { commandId: "cmd-1", action, args };
}

function createService(options?: {
  agentChatService?: Record<string, unknown>;
  prService?: Record<string, unknown>;
}) {
  const ptyService = {
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      ptyId: "pty-1",
      session: { id: "session-1", status: "running" },
    }),
  };
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const service = createSyncRemoteCommandService({
    laneService: {},
    prService: options?.prService ?? {},
    ptyService,
    sessionService: {},
    fileService: {},
    ...(options?.agentChatService ? { agentChatService: options.agentChatService } : {}),
    logger,
  } as any);
  return { service, ptyService, logger };
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

describe("prs.land", () => {
  it("forwards bypass + editable commit message to prService.land", async () => {
    const land = vi.fn().mockResolvedValue({ prId: "pr-1", success: true });
    const { service } = createService({ prService: { land } });

    const result = await service.execute(makePayload("prs.land", {
      prId: "pr-1",
      method: "squash",
      bypassRules: true,
      commitTitle: "Land it",
      commitBody: "Body text",
      expectedHeadSha: "abc123",
    }));

    expect(land).toHaveBeenCalledWith({
      prId: "pr-1",
      method: "squash",
      bypassRules: true,
      commitTitle: "Land it",
      commitBody: "Body text",
      expectedHeadSha: "abc123",
    });
    expect(result).toEqual({ prId: "pr-1", success: true });
  });

  it("omits optional fields that are absent or blank", async () => {
    const land = vi.fn().mockResolvedValue({ prId: "pr-1", success: true });
    const { service } = createService({ prService: { land } });

    await service.execute(makePayload("prs.land", {
      prId: "pr-1",
      method: "merge",
      commitTitle: "   ",
    }));

    expect(land).toHaveBeenCalledWith({ prId: "pr-1", method: "merge" });
  });

  it("rejects an invalid method", async () => {
    const land = vi.fn();
    const { service } = createService({ prService: { land } });

    await expect(
      service.execute(makePayload("prs.land", { prId: "pr-1", method: "fast-forward" })),
    ).rejects.toThrow("prs.land requires method to be merge, squash, or rebase.");
    expect(land).not.toHaveBeenCalled();
  });
});

describe("prs.updateBranch", () => {
  it("forwards strategy + expected head sha to prService.updateBranch", async () => {
    const updateBranch = vi.fn().mockResolvedValue({ prId: "pr-1", success: true, hasConflicts: false });
    const { service } = createService({ prService: { updateBranch } });

    const result = await service.execute(makePayload("prs.updateBranch", {
      prId: "pr-1",
      strategy: "rebase",
      expectedHeadSha: "abc123",
    }));

    expect(updateBranch).toHaveBeenCalledWith({
      prId: "pr-1",
      strategy: "rebase",
      expectedHeadSha: "abc123",
    });
    expect(result).toEqual({ prId: "pr-1", success: true, hasConflicts: false });
  });

  it("rejects an invalid strategy", async () => {
    const updateBranch = vi.fn();
    const { service } = createService({ prService: { updateBranch } });

    await expect(
      service.execute(makePayload("prs.updateBranch", { prId: "pr-1", strategy: "squash" })),
    ).rejects.toThrow("prs.updateBranch requires strategy to be merge or rebase.");
    expect(updateBranch).not.toHaveBeenCalled();
  });
});

describe("lanes.suggestName", () => {
  it("exposes a non-queueable, viewer-allowed descriptor", () => {
    const { service } = createService();

    expect(service.getDescriptor("lanes.suggestName")).toEqual({
      action: "lanes.suggestName",
      scope: "project",
      policy: { viewerAllowed: true },
    });
  });

  it("returns the model-suggested name on success", async () => {
    const suggestLaneNameFromPrompt = vi.fn().mockResolvedValue("refactor-auth-flow");
    const { service } = createService({ agentChatService: { suggestLaneNameFromPrompt } });

    const result = await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "please refactor the auth flow",
      modelId: "anthropic/claude-haiku-4-5",
    }));

    expect(result).toEqual({ name: "refactor-auth-flow" });
    expect(suggestLaneNameFromPrompt).toHaveBeenCalledWith({
      laneId: "lane-1",
      prompt: "please refactor the auth flow",
      modelId: "anthropic/claude-haiku-4-5",
    });
  });

  it("falls back to the client's deterministic name and logs when the naming service throws", async () => {
    const suggestLaneNameFromPrompt = vi.fn().mockRejectedValue(new Error("boom"));
    const { service, logger } = createService({ agentChatService: { suggestLaneNameFromPrompt } });

    const result = await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "fix the flaky login test",
      modelId: "m",
      fallbackName: "fix the flaky login test",
    }));

    expect(result).toEqual({ name: "fix the flaky login test" });
    expect(logger.warn).toHaveBeenCalledWith(
      "sync.lanes_suggest_name_failed",
      expect.objectContaining({ laneId: "lane-1", modelId: "m" }),
    );
  });

  it("falls back when the naming service is unavailable, deriving from the prompt without a client fallback", async () => {
    const { service } = createService();

    const result = await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "Please help me fix the login bug",
      modelId: "m",
    }));

    expect(result).toEqual({
      name: deriveDeterministicLaneNameFromPrompt("Please help me fix the login bug"),
    });
  });

  it("falls back when the naming service returns an empty string", async () => {
    const suggestLaneNameFromPrompt = vi.fn().mockResolvedValue("   ");
    const { service } = createService({ agentChatService: { suggestLaneNameFromPrompt } });

    const result = await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "build the dashboard",
      modelId: "m",
      fallbackName: "build the dashboard",
    }));

    expect(result).toEqual({ name: "build the dashboard" });
  });

  it("rejects when prompt is missing", async () => {
    const { service } = createService();

    await expect(
      service.execute(makePayload("lanes.suggestName", { laneId: "lane-1", modelId: "m" })),
    ).rejects.toThrow("lanes.suggestName requires prompt.");
  });
});
