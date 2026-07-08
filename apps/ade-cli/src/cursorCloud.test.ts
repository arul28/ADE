import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCliPlan } from "./cli";
import { CursorCloudUsageError, parseCursorCloudCommand, runCursorCloud } from "./cursorCloud";

const cursorModelsListMock = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: (...args: unknown[]) => cursorModelsListMock(...args),
    },
  },
}));

afterEach(() => {
  cursorModelsListMock.mockReset();
});

describe("ADE CLI cursor cloud surface", () => {
  it("routes 'cursor cloud' to a cursor-cloud plan", () => {
    const plan = buildCliPlan(["cursor", "cloud", "agents", "list", "--archived"]);
    expect(plan.kind).toBe("cursor-cloud");
    if (plan.kind !== "cursor-cloud") return;
    expect(plan.rest).toEqual(["agents", "list", "--archived"]);
  });

  it("renders top-level cursor help via --help", () => {
    const plan = buildCliPlan(["cursor", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("Cursor Cloud");
    expect(plan.text).toContain("ade cursor cloud agents");
  });

  it("renders group-level cursor help via --help", () => {
    const plan = buildCliPlan(["cursor", "cloud", "agents", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("Cursor Cloud: agents");
  });

  it("resolves help via 'help cursor cloud runs' too", () => {
    const plan = buildCliPlan(["help", "cursor", "cloud", "runs"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("Cursor Cloud: runs");
  });

  it("rejects an unknown ade cursor surface", () => {
    expect(() => buildCliPlan(["cursor", "local", "agents", "list"])).toThrow(/'ade cursor' surface 'local'/);
  });
});

describe("parseCursorCloudCommand", () => {
  it("normalizes plural and singular group aliases", () => {
    const parsed = parseCursorCloudCommand(["agents", "list"]);
    expect(parsed?.group).toBe("agents");
    expect(parsed?.sub).toBe("list");

    const singular = parseCursorCloudCommand(["repo", "list"]);
    expect(singular?.group).toBe("repos");
  });

  it("defaults runtime sub to 'list' when missing", () => {
    const parsed = parseCursorCloudCommand(["agents"]);
    expect(parsed?.group).toBe("agents");
    expect(parsed?.sub).toBe("list");
  });

  it("handles 'me' as a single-shot group", () => {
    const parsed = parseCursorCloudCommand(["me"]);
    expect(parsed?.group).toBe("me");
    expect(parsed?.sub).toBe("show");
  });

  it("rejects an unknown group", () => {
    expect(() => parseCursorCloudCommand(["bogus", "list"])).toThrow(CursorCloudUsageError);
  });
});

describe("runCursorCloud", () => {
  it("renders current Cursor SDK model list entries in text mode", async () => {
    cursorModelsListMock.mockResolvedValue([
      { id: "cursor/claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { model: { id: "legacy/composer" }, displayName: "Legacy Composer" },
    ]);

    const result = await runCursorCloud(["models", "list"], "text");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Claude Sonnet 5 (cursor/claude-sonnet-5)");
    expect(result.output).toContain("Legacy Composer (legacy/composer)");
    expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: undefined });
  });
});
