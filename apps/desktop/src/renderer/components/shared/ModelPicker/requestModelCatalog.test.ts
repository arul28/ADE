/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PERSONAL_CHAT_CATALOG_SCOPE,
  requestModelCatalog,
} from "./modelCatalog";
import type { AgentChatModelCatalog } from "../../../../shared/types";

describe("requestModelCatalog", () => {
  const catalog: AgentChatModelCatalog = {
    fetchedAt: "2026-01-01T00:00:00.000Z",
    groups: [],
  };

  afterEach(() => {
    delete (window as { ade?: unknown }).ade;
  });

  it("reads personal Chats from personalChats.call", async () => {
    const personalCall = vi.fn(async () => ({ action: "modelCatalog", result: catalog }));
    const projectCatalog = vi.fn();
    (window as unknown as { ade: unknown }).ade = {
      personalChats: { call: personalCall },
      agentChat: { modelCatalog: projectCatalog },
    };
    await expect(requestModelCatalog({ mode: "cached" }, { catalogScopeKey: PERSONAL_CHAT_CATALOG_SCOPE }))
      .resolves.toEqual(catalog);
    expect(personalCall).toHaveBeenCalledWith({ action: "modelCatalog", args: { mode: "cached" } });
    expect(projectCatalog).not.toHaveBeenCalled();
  });

  it("reads project surfaces from agentChat.modelCatalog", async () => {
    const personalCall = vi.fn();
    const projectCatalog = vi.fn(async () => catalog);
    (window as unknown as { ade: unknown }).ade = {
      personalChats: { call: personalCall },
      agentChat: { modelCatalog: projectCatalog },
    };
    await expect(requestModelCatalog({ mode: "force" }, { catalogScopeKey: "" }))
      .resolves.toEqual(catalog);
    expect(projectCatalog).toHaveBeenCalledWith({ mode: "force" });
    expect(personalCall).not.toHaveBeenCalled();
  });
});
