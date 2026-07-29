import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_STATUS_CACHE_INVALIDATED_EVENT,
  AI_STATUS_CACHE_UPDATED_EVENT,
  getAgentChatModelsCached,
  getAiStatusCached,
  invalidateAiDiscoveryCache,
  peekAiStatusCached,
  type AiStatusCacheInvalidatedEventDetail,
  type AiStatusCacheUpdatedEventDetail,
} from "./aiDiscoveryCache";
import type { OpenProjectBinding } from "../../shared/types";

const getStatusMock = vi.fn();
const modelsMock = vi.fn();
const CLAUDE_READY = {
  binary: { present: true, source: "path" as const, path: "/usr/local/bin/claude" },
  auth: { ready: true, mode: "oauth" as const, detail: null },
};
const CLAUDE_UNAVAILABLE = {
  binary: { present: false, source: "missing" as const, path: null },
  auth: { ready: false, mode: "none", detail: null },
};

describe("aiDiscoveryCache", () => {
  beforeEach(() => {
    invalidateAiDiscoveryCache();
    getStatusMock.mockReset();
    modelsMock.mockReset();
    const windowEvents = new EventTarget();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: windowEvents.addEventListener.bind(windowEvents),
        removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
        dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
        ade: {
          ai: {
            getStatus: getStatusMock,
          },
          agentChat: {
            models: modelsMock,
          },
        },
      },
    });
  });

  it("reuses an in-flight ai status request for the same project", async () => {
    let resolveStatus!: (value: any) => void;
    getStatusMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );

    const first = getAiStatusCached({ projectRoot: "/project/a" });
    const second = getAiStatusCached({ projectRoot: "/project/a" });
    resolveStatus({ mode: "subscription", availableProviders: { claude: CLAUDE_READY, codex: true, cursor: false }, models: { claude: [], codex: [], cursor: [] }, features: [] });

    await expect(first).resolves.toMatchObject({ mode: "subscription" });
    await expect(second).resolves.toMatchObject({ mode: "subscription" });
    expect(getStatusMock).toHaveBeenCalledTimes(1);
  });

  it("keeps ai status cache entries isolated per project", async () => {
    getStatusMock
      .mockResolvedValueOnce({ mode: "guest", availableProviders: { claude: CLAUDE_UNAVAILABLE, codex: false, cursor: false }, models: { claude: [], codex: [], cursor: [] }, features: [] })
      .mockResolvedValueOnce({ mode: "subscription", availableProviders: { claude: CLAUDE_READY, codex: false, cursor: false }, models: { claude: [], codex: [], cursor: [] }, features: [] });

    const projectA = await getAiStatusCached({ projectRoot: "/project/a" });
    const projectB = await getAiStatusCached({ projectRoot: "/project/b" });
    const projectAAgain = await getAiStatusCached({ projectRoot: "/project/a" });

    expect(projectA.mode).toBe("guest");
    expect(projectB.mode).toBe("subscription");
    expect(projectAAgain.mode).toBe("guest");
    expect(getStatusMock).toHaveBeenCalledTimes(2);
  });

  it("routes and isolates discovery by runtime binding", async () => {
    const studioBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:studio:ade",
      targetId: "studio",
      runtimeName: "Mac Studio",
      projectId: "ade",
      rootPath: "/Users/admin/Projects/ADE",
      displayName: "ADE",
    };
    const macbookBinding: OpenProjectBinding = {
      kind: "local",
      key: "local:/Users/arul/ADE",
      rootPath: "/Users/arul/ADE",
      displayName: "ADE",
      gitOriginUrl: null,
    };
    getStatusMock
      .mockResolvedValueOnce({ mode: "guest", availableProviders: { claude: CLAUDE_UNAVAILABLE, codex: false, cursor: false }, models: { claude: [], codex: [], cursor: [] }, features: [] })
      .mockResolvedValueOnce({ mode: "subscription", availableProviders: { claude: CLAUDE_READY, codex: true, cursor: false }, models: { claude: [], codex: [], cursor: [] }, features: [] });
    modelsMock
      .mockResolvedValueOnce([{ id: "studio-model", displayName: "Studio", isDefault: true }])
      .mockResolvedValueOnce([{ id: "macbook-model", displayName: "MacBook", isDefault: true }]);

    const studioStatus = await getAiStatusCached({
      projectRoot: "/repo/ADE",
      pin: studioBinding,
    });
    const macbookStatus = await getAiStatusCached({
      projectRoot: "/repo/ADE",
      pin: macbookBinding,
    });
    const studioModels = await getAgentChatModelsCached({
      projectRoot: "/repo/ADE",
      provider: "codex",
      pin: studioBinding,
    });
    const macbookModels = await getAgentChatModelsCached({
      projectRoot: "/repo/ADE",
      provider: "codex",
      pin: macbookBinding,
    });

    expect(studioStatus.mode).toBe("guest");
    expect(macbookStatus.mode).toBe("subscription");
    expect(studioModels[0]?.id).toBe("studio-model");
    expect(macbookModels[0]?.id).toBe("macbook-model");
    expect(getStatusMock).toHaveBeenNthCalledWith(1, {
      force: false,
      refreshOpenCodeInventory: false,
    }, studioBinding);
    expect(getStatusMock).toHaveBeenNthCalledWith(2, {
      force: false,
      refreshOpenCodeInventory: false,
    }, macbookBinding);
    expect(modelsMock).toHaveBeenNthCalledWith(1, { provider: "codex" }, studioBinding);
    expect(modelsMock).toHaveBeenNthCalledWith(2, { provider: "codex" }, macbookBinding);
    expect(peekAiStatusCached("/repo/ADE", studioBinding)?.mode).toBe("guest");
    expect(peekAiStatusCached("/repo/ADE", macbookBinding)?.mode).toBe("subscription");
  });

  it("invalidates every machine-scoped status entry for a project root", async () => {
    const binding: OpenProjectBinding = {
      kind: "local",
      key: "local:/repo/ADE",
      rootPath: "/repo/ADE",
      displayName: "ADE",
      gitOriginUrl: null,
    };
    getStatusMock.mockResolvedValue({
      mode: "subscription",
      availableProviders: { claude: CLAUDE_READY, codex: true, cursor: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
    });

    await getAiStatusCached({ projectRoot: "/repo/ADE", pin: binding });
    expect(peekAiStatusCached("/repo/ADE", binding)).not.toBeNull();

    invalidateAiDiscoveryCache("/repo/ADE");

    expect(peekAiStatusCached("/repo/ADE", binding)).toBeNull();
  });

  it("reuses cached model discovery per provider", async () => {
    modelsMock.mockResolvedValueOnce([{ id: "claude-1", displayName: "Claude 1", isDefault: true }]);

    const first = await getAgentChatModelsCached({ projectRoot: "/project/a", provider: "claude" });
    const second = await getAgentChatModelsCached({ projectRoot: "/project/a", provider: "claude" });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(modelsMock).toHaveBeenCalledTimes(1);
  });

  it("forwards explicit OpenCode inventory refresh requests", async () => {
    getStatusMock.mockResolvedValueOnce({
      mode: "subscription",
      availableProviders: { claude: CLAUDE_READY, codex: true, cursor: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
    });

    await getAiStatusCached({
      projectRoot: "/project/a",
      refreshOpenCodeInventory: true,
    });

    expect(getStatusMock).toHaveBeenCalledWith({
      force: false,
      refreshOpenCodeInventory: true,
    });
  });

  it("peekAiStatusCached returns null before any fetch and the cached value after", async () => {
    expect(peekAiStatusCached("/project/a")).toBeNull();

    getStatusMock.mockResolvedValueOnce({
      mode: "subscription",
      availableProviders: { claude: CLAUDE_READY, codex: false, cursor: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
    });

    await getAiStatusCached({ projectRoot: "/project/a" });

    const peeked = peekAiStatusCached("/project/a");
    expect(peeked).not.toBeNull();
    expect(peeked?.mode).toBe("subscription");
    // Other projects should not see this entry.
    expect(peekAiStatusCached("/project/b")).toBeNull();
  });

  it("peekAiStatusCached still returns the previous value while a refresh is in flight", async () => {
    getStatusMock.mockResolvedValueOnce({
      mode: "guest",
      availableProviders: { claude: CLAUDE_UNAVAILABLE, codex: false, cursor: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
    });
    await getAiStatusCached({ projectRoot: "/project/a" });

    let resolveNext!: (value: any) => void;
    getStatusMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNext = resolve;
        }),
    );

    const inFlight = getAiStatusCached({ projectRoot: "/project/a", force: true });
    // While the forced refresh is pending, the previously-cached value should
    // still be readable synchronously — that's what lets the chat picker seed
    // its initial state without flashing "not configured".
    expect(peekAiStatusCached("/project/a")?.mode).toBe("guest");

    resolveNext({
      mode: "subscription",
      availableProviders: { claude: CLAUDE_READY, codex: false, cursor: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
    });
    await inFlight;
    expect(peekAiStatusCached("/project/a")?.mode).toBe("subscription");
  });

  it("does not let a warm generic status cache swallow an explicit OpenCode refresh", async () => {
    getStatusMock
      .mockResolvedValueOnce({
        mode: "subscription",
        availableProviders: { claude: CLAUDE_READY, codex: true, cursor: false },
        models: { claude: [], codex: [], cursor: [] },
        features: [],
      })
      .mockResolvedValueOnce({
        mode: "subscription",
        availableProviders: { claude: CLAUDE_READY, codex: true, cursor: false },
        models: { claude: [], codex: [], cursor: [] },
        features: [],
        opencodeProviders: [{ id: "openai", name: "OpenAI", connected: true, modelCount: 1 }],
      });

    await getAiStatusCached({ projectRoot: "/project/a" });
    await getAiStatusCached({
      projectRoot: "/project/a",
      refreshOpenCodeInventory: true,
    });

    expect(getStatusMock).toHaveBeenCalledTimes(2);
    expect(getStatusMock).toHaveBeenNthCalledWith(2, {
      force: false,
      refreshOpenCodeInventory: true,
    });
  });

  it("emits project-scoped invalidation events", () => {
    const events: AiStatusCacheInvalidatedEventDetail[] = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<AiStatusCacheInvalidatedEventDetail>).detail);
    };
    window.addEventListener(AI_STATUS_CACHE_INVALIDATED_EVENT, listener);

    try {
      invalidateAiDiscoveryCache("/project/a");
      invalidateAiDiscoveryCache();
    } finally {
      window.removeEventListener(AI_STATUS_CACHE_INVALIDATED_EVENT, listener);
    }

    expect(events).toEqual([
      { projectRoot: "/project/a", allProjects: false },
      { projectRoot: null, allProjects: true },
    ]);
  });

  it("emits one project-scoped update after a fresh status request", async () => {
    const events: AiStatusCacheUpdatedEventDetail[] = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<AiStatusCacheUpdatedEventDetail>).detail);
    };
    window.addEventListener(AI_STATUS_CACHE_UPDATED_EVENT, listener);
    getStatusMock.mockResolvedValueOnce({
      mode: "subscription",
      availableProviders: { claude: CLAUDE_READY, codex: true, cursor: false, droid: false },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
    });

    try {
      await getAiStatusCached({ projectRoot: " /project/a " });
      await getAiStatusCached({ projectRoot: "/project/a" });
    } finally {
      window.removeEventListener(AI_STATUS_CACHE_UPDATED_EVENT, listener);
    }

    expect(events).toEqual([{ projectRoot: "/project/a" }]);
    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(peekAiStatusCached("/project/a")?.mode).toBe("subscription");
  });
});
