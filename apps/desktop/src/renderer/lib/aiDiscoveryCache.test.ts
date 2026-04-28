import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentChatModelsCached, getAiStatusCached, invalidateAiDiscoveryCache } from "./aiDiscoveryCache";

const getStatusMock = vi.fn();
const modelsMock = vi.fn();

describe("aiDiscoveryCache", () => {
  beforeEach(() => {
    invalidateAiDiscoveryCache();
    getStatusMock.mockReset();
    modelsMock.mockReset();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
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
    resolveStatus({ mode: "subscription", availableProviders: { claude: true, codex: true, cursor: false }, models: { claude: [], codex: [], cursor: [] }, features: [] });

    await expect(first).resolves.toMatchObject({ mode: "subscription" });
    await expect(second).resolves.toMatchObject({ mode: "subscription" });
    expect(getStatusMock).toHaveBeenCalledTimes(1);
  });

  it("keeps ai status cache entries isolated per project", async () => {
    getStatusMock
      .mockResolvedValueOnce({ mode: "guest", availableProviders: { claude: false, codex: false, cursor: false }, models: { claude: [], codex: [], cursor: [] }, features: [] })
      .mockResolvedValueOnce({ mode: "subscription", availableProviders: { claude: true, codex: false, cursor: false }, models: { claude: [], codex: [], cursor: [] }, features: [] });

    const projectA = await getAiStatusCached({ projectRoot: "/project/a" });
    const projectB = await getAiStatusCached({ projectRoot: "/project/b" });
    const projectAAgain = await getAiStatusCached({ projectRoot: "/project/a" });

    expect(projectA.mode).toBe("guest");
    expect(projectB.mode).toBe("subscription");
    expect(projectAAgain.mode).toBe("guest");
    expect(getStatusMock).toHaveBeenCalledTimes(2);
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
      availableProviders: { claude: true, codex: true, cursor: false },
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

  it("does not let a warm generic status cache swallow an explicit OpenCode refresh", async () => {
    getStatusMock
      .mockResolvedValueOnce({
        mode: "subscription",
        availableProviders: { claude: true, codex: true, cursor: false },
        models: { claude: [], codex: [], cursor: [] },
        features: [],
      })
      .mockResolvedValueOnce({
        mode: "subscription",
        availableProviders: { claude: true, codex: true, cursor: false },
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
});
