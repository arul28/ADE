import { describe, expect, it, vi } from "vitest";
import { buildCodexDynamicToolSpecs, codexDeferCtoTool } from "./codexCtoToolDeferral";
import { createCtoOperatorTools, type CtoOperatorToolDeps } from "../ai/tools/ctoOperatorTools";
import type { CtoToolPack } from "../ai/tools/ctoToolPacks";

function ctoTools() {
  const deps: CtoOperatorToolDeps = {
    currentSessionId: "cto-1",
    defaultLaneId: "lane-1",
    resolveExecutionLane: vi.fn(),
    laneService: { list: vi.fn(), create: vi.fn() } as any,
    sessionService: { updateMeta: vi.fn() } as any,
    listChats: vi.fn(),
    getChatStatus: vi.fn(),
    getChatTranscript: vi.fn(),
    steerChat: vi.fn(),
    cancelSteer: vi.fn(),
    listSubagents: vi.fn(),
    approveToolUse: vi.fn(),
    createChat: vi.fn(),
    updateChatSession: vi.fn(),
    sendChatMessage: vi.fn(),
    interruptChat: vi.fn(),
    ensureCtoSession: vi.fn(),
  };
  return createCtoOperatorTools(deps);
}

describe("Codex dynamic tool deferral", () => {
  it("defers nothing when no predicate is supplied", () => {
    const specs = buildCodexDynamicToolSpecs(ctoTools(), "ade_cto");
    expect(specs.length).toBeGreaterThan(50);
    expect(specs.every((spec) => spec.deferLoading === false)).toBe(true);
    expect(specs.every((spec) => spec.namespace === "ade_cto")).toBe(true);
  });

  it("never defers a core tool, and defers an unloaded extension pack", () => {
    const tools = ctoTools();
    const loaded = new Set<CtoToolPack>();
    const specs = buildCodexDynamicToolSpecs(
      tools,
      "ade_cto",
      (_name, definition) => codexDeferCtoTool(definition, loaded),
    );
    const byName = new Map(specs.map((spec) => [spec.name, spec]));

    for (const [name, definition] of Object.entries(tools)) {
      expect(byName.get(name)!.deferLoading, `${name} (${definition.pack})`)
        .toBe(definition.pack !== "core");
    }
    // Named anchors, so a pack rename cannot make the loop vacuously true.
    expect(byName.get("spawnChat")!.deferLoading).toBe(false);
    expect(byName.get("loadCtoTools")!.deferLoading).toBe(false);
    expect(byName.get("startReviewRun")!.deferLoading).toBe(true);
    expect(byName.get("getUsageStats")!.deferLoading).toBe(true);
  });

  it("stops deferring a pack once it has been loaded", () => {
    const tools = ctoTools();
    const loaded = new Set<CtoToolPack>(["review"]);
    const specs = buildCodexDynamicToolSpecs(
      tools,
      "ade_cto",
      (_name, definition) => codexDeferCtoTool(definition, loaded),
    );
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    expect(byName.get("startReviewRun")!.deferLoading).toBe(false);
    expect(byName.get("getUsageStats")!.deferLoading).toBe(true);
  });

  it("never defers a tool set that carries no pack metadata", () => {
    // Orchestration tools are plain ExecutableTools. The predicate must leave
    // them eager rather than guessing.
    const plain = {
      someOrchestrationTool: {
        description: "no pack here",
        inputSchema: { } as any,
        execute: async () => null,
      },
    };
    expect(codexDeferCtoTool(plain.someOrchestrationTool as any, new Set())).toBe(false);
  });
});
