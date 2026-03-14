import { describe, expect, it, vi } from "vitest";
import { createMemoryTools } from "./memoryTools";

describe("createMemoryTools", () => {
  it("defaults mission scope owner id to the current run", async () => {
    const memoryService = {
      search: vi.fn(() => []),
      writeMemory: vi.fn(() => ({
        accepted: true,
        memory: {
          id: "memory-1",
          tier: 2,
        },
        deduped: false,
      })),
      pinMemory: vi.fn(),
      unpinMemory: vi.fn(),
    } as any;

    const tools = createMemoryTools(memoryService, "project-1", { runId: "run-1" });

    await (tools.memorySearch as any).execute({
      query: "deploy lag",
      scope: "mission",
      limit: 5,
    });
    await (tools.memoryAdd as any).execute({
      content: "Mission-only memory",
      category: "fact",
      scope: "mission",
      importance: "high",
      pin: false,
      writeMode: "default",
    });

    expect(memoryService.search).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "mission",
        scopeOwnerId: "run-1",
      })
    );
    expect(memoryService.writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "mission",
        scopeOwnerId: "run-1",
      })
    );
  });

  it("defaults agent scope owner id to the current agent identity", async () => {
    const memoryService = {
      search: vi.fn(() => []),
      writeMemory: vi.fn(() => ({
        accepted: true,
        memory: {
          id: "memory-2",
          tier: 2,
        },
        deduped: false,
      })),
      pinMemory: vi.fn(),
      unpinMemory: vi.fn(),
    } as any;

    const tools = createMemoryTools(memoryService, "project-1", { agentScopeOwnerId: "agent-session-1" });

    await (tools.memorySearch as any).execute({
      query: "team preference",
      scope: "agent",
      limit: 3,
    });
    await (tools.memoryAdd as any).execute({
      content: "I prefer concise summaries.",
      category: "preference",
      scope: "agent",
      importance: "medium",
      pin: false,
      writeMode: "default",
    });

    expect(memoryService.search).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "agent",
        scopeOwnerId: "agent-session-1",
      })
    );
    expect(memoryService.writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "agent",
        scopeOwnerId: "agent-session-1",
      })
    );
  });
});
