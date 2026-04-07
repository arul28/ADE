import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeUnified } from "./unifiedExecutor";
import { streamText, stepCountIs } from "ai";
import { resolveModel } from "./providerResolver";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: vi.fn(),
    stepCountIs: vi.fn((count: number) => ({ type: "stepCountIs", count })),
  };
});

vi.mock("../../../shared/modelRegistry", () => ({
  getModelById: vi.fn(() => ({
    id: "test-model",
    authTypes: ["local"],
    harnessProfile: "verified",
    isCliWrapped: false,
  })),
}));

vi.mock("./providerResolver", () => ({
  resolveModel: vi.fn(async () => ({})),
}));

describe("executeUnified", () => {
  beforeEach(() => {
    vi.mocked(streamText).mockReset();
    vi.mocked(stepCountIs).mockClear();
    vi.mocked(resolveModel).mockClear();
  });

  it("exposes the OpenCode-like planning surface when tools='planning'", async () => {
    const observedToolNames: string[][] = [];

    vi.mocked(streamText).mockImplementation((args: Record<string, unknown>) => {
      observedToolNames.push(Object.keys((args.tools ?? {}) as Record<string, unknown>));
      return {
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any;
    });

    for await (const _event of executeUnified({
      modelId: "test-model",
      prompt: "Plan how to add a new blank test tab to the website.",
      cwd: "/repo",
      tools: "planning",
      auth: [],
    })) {
      // drain
    }

    expect(resolveModel).toHaveBeenCalledWith("test-model", []);
    expect(stepCountIs).toHaveBeenCalledWith(10);
    expect(observedToolNames).toHaveLength(1);
    expect(observedToolNames[0]).toEqual(expect.arrayContaining([
      "readFile",
      "TodoWrite",
      "TodoRead",
      "askUser",
      "exitPlanMode",
      "summarizeFrontendStructure",
      "findRoutingFiles",
      "findPageComponents",
      "findAppEntryPoints",
    ]));
    expect(observedToolNames[0]).not.toContain("editFile");
    expect(observedToolNames[0]).not.toContain("writeFile");
    expect(observedToolNames[0]).not.toContain("bash");
  });
});
