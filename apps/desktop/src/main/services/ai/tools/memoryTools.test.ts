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
          tier: 3,
          status: "candidate",
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
        status: "candidate",
        tier: 3,
        confidence: 0.6,
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
          tier: 3,
          status: "candidate",
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
        status: "candidate",
        tier: 3,
        confidence: 0.6,
      })
    );
  });

  it("promotes strict-mode writes immediately", async () => {
    const memoryService = {
      search: vi.fn(() => []),
      writeMemory: vi.fn(() => ({
        accepted: true,
        memory: {
          id: "memory-3",
          tier: 2,
          status: "promoted",
        },
        deduped: false,
      })),
      pinMemory: vi.fn(),
      unpinMemory: vi.fn(),
    } as any;

    const tools = createMemoryTools(memoryService, "project-1");

    const result = await (tools.memoryAdd as any).execute({
      content: "Convention: run focused desktop tests before full Electron builds.",
      category: "convention",
      scope: "project",
      importance: "high",
      pin: false,
      writeMode: "strict",
    });

    expect(memoryService.writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "promoted",
        tier: 2,
        confidence: 1,
      })
    );
    expect(result).toEqual(expect.objectContaining({
      saved: true,
      durability: "promoted",
    }));
  });

  it("returns explicit rejection details when the write gate declines a memory", async () => {
    const memoryService = {
      search: vi.fn(() => []),
      writeMemory: vi.fn(() => ({
        accepted: false,
        reason: "memory appears to be raw git history or change log output",
      })),
      pinMemory: vi.fn(),
      unpinMemory: vi.fn(),
    } as any;

    const onMemoryWriteEvent = vi.fn();
    const tools = createMemoryTools(memoryService, "project-1", { onMemoryWriteEvent });

    const result = await (tools.memoryAdd as any).execute({
      content: "commit abc123 Fix CI",
      category: "fact",
      scope: "project",
      importance: "medium",
      pin: false,
      writeMode: "default",
    });

    expect(result).toEqual({
      saved: false,
      durability: "rejected",
      id: null,
      tier: null,
      deduped: false,
      mergedIntoId: null,
      reason: "memory appears to be raw git history or change log output",
    });
    expect(onMemoryWriteEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        saved: false,
        durability: "rejected",
      })
    );
  });
});
