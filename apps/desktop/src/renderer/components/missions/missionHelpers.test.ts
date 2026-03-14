import { describe, expect, it } from "vitest";
import { MISSION_BOARD_COLUMNS, toPlannerProvider } from "./missionHelpers";

describe("missionHelpers", () => {
  it("includes intervention_required and canceled in board columns", () => {
    const keys = MISSION_BOARD_COLUMNS.map((column) => column.key);
    expect(keys).toContain("intervention_required");
    expect(keys).toContain("canceled");
  });

  it("maps model IDs to supported planner providers", () => {
    expect(toPlannerProvider("anthropic/claude-sonnet-4-6")).toBe("claude");
    expect(toPlannerProvider("openai/gpt-5.3-codex")).toBe("codex");
    expect(toPlannerProvider("auto")).toBe("auto");
  });
});
