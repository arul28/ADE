import { describe, expect, it } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import {
  EMPTY_WORK_SESSION_FILTERS,
  activeWorkSessionFilterLabels,
  isWorkSessionFilterEmpty,
  matchesWorkSessionFilters,
  normalizeWorkSessionFilters,
  workToolFamily,
  type WorkSessionFilters,
} from "./workSessionFilters";

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "lane one",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: null,
    toolType: "claude-chat",
    title: "A chat",
    status: "running",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: null,
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  } as TerminalSessionSummary;
}

const ctx = {
  nowMs: Date.parse("2026-07-01T01:00:00.000Z"),
  laneHasPr: (laneId: string) => laneId === "lane-with-pr",
  laneIsDirty: (laneId: string) => laneId === "lane-dirty",
};

const filters = (patch: Partial<WorkSessionFilters>): WorkSessionFilters => ({
  ...EMPTY_WORK_SESSION_FILTERS,
  ...patch,
});

describe("workToolFamily", () => {
  it("collapses a tool's chat / cli / orchestrated variants into one family", () => {
    expect(workToolFamily("claude")).toBe("claude");
    expect(workToolFamily("claude-chat")).toBe("claude");
    expect(workToolFamily("claude-orchestrated")).toBe("claude");
    expect(workToolFamily("cursor-cli")).toBe("cursor");
    expect(workToolFamily("cursor")).toBe("cursor");
    expect(workToolFamily("aider")).toBe("other");
    expect(workToolFamily(null)).toBe("other");
  });
});

describe("matchesWorkSessionFilters", () => {
  it("matches everything when nothing is selected", () => {
    expect(isWorkSessionFilterEmpty(EMPTY_WORK_SESSION_FILTERS)).toBe(true);
    expect(matchesWorkSessionFilters(makeSession(), EMPTY_WORK_SESSION_FILTERS, ctx)).toBe(true);
  });

  it("ORs within the status axis", () => {
    const running = makeSession({ runtimeState: "running", status: "running" });
    // A non-zero exit is the "ended" tier; a clean exit files as awaiting-input
    // (the chat is ready for your next message), which is why this uses code 1.
    const ended = makeSession({
      status: "failed",
      runtimeState: "exited",
      exitCode: 1,
      endedAt: "2026-07-01T00:30:00.000Z",
    });
    const both = filters({ status: ["running", "ended"] });
    expect(matchesWorkSessionFilters(running, both, ctx)).toBe(true);
    expect(matchesWorkSessionFilters(ended, both, ctx)).toBe(true);
    // Narrowing to one of the two excludes the other.
    expect(matchesWorkSessionFilters(ended, filters({ status: ["running"] }), ctx)).toBe(false);
  });

  it("files a settled session under the settled chip", () => {
    const settled = makeSession({
      status: "completed",
      runtimeState: "idle",
      settledAt: "2026-07-01T00:40:00.000Z",
    });
    expect(matchesWorkSessionFilters(settled, filters({ status: ["settled"] }), ctx)).toBe(true);
    expect(matchesWorkSessionFilters(settled, filters({ status: ["running"] }), ctx)).toBe(false);
  });

  it("files a snoozed session under snoozed, not its underlying phase", () => {
    const snoozed = makeSession({
      status: "running",
      runtimeState: "running",
      snoozedUntil: "2026-07-01T02:00:00.000Z",
    });
    expect(matchesWorkSessionFilters(snoozed, filters({ status: ["snoozed"] }), ctx)).toBe(true);
    expect(matchesWorkSessionFilters(snoozed, filters({ status: ["running"] }), ctx)).toBe(false);
  });

  it("ANDs across axes", () => {
    const claudeRunning = makeSession({ toolType: "claude-chat" });
    const codexRunning = makeSession({ toolType: "codex-chat" });
    const statusOnly = filters({ status: ["running"] });
    expect(matchesWorkSessionFilters(claudeRunning, statusOnly, ctx)).toBe(true);
    expect(matchesWorkSessionFilters(codexRunning, statusOnly, ctx)).toBe(true);

    const statusAndTool = filters({ status: ["running"], tool: ["claude"] });
    expect(matchesWorkSessionFilters(claudeRunning, statusAndTool, ctx)).toBe(true);
    expect(matchesWorkSessionFilters(codexRunning, statusAndTool, ctx)).toBe(false);
  });

  it("filters on lane PR and dirty state", () => {
    expect(matchesWorkSessionFilters(
      makeSession({ laneId: "lane-with-pr" }), filters({ hasPr: true }), ctx,
    )).toBe(true);
    expect(matchesWorkSessionFilters(makeSession(), filters({ hasPr: true }), ctx)).toBe(false);
    expect(matchesWorkSessionFilters(
      makeSession({ laneId: "lane-dirty" }), filters({ dirtyLane: true }), ctx,
    )).toBe(true);
    expect(matchesWorkSessionFilters(makeSession(), filters({ dirtyLane: true }), ctx)).toBe(false);
  });
});

describe("normalizeWorkSessionFilters", () => {
  it("drops unknown values and defaults a non-object", () => {
    expect(normalizeWorkSessionFilters({
      status: ["running", "nonsense"],
      tool: ["claude", "not-a-tool"],
      hasPr: true,
      dirtyLane: "yes",
    })).toEqual({ status: ["running"], tool: ["claude"], hasPr: true, dirtyLane: false });
    expect(normalizeWorkSessionFilters(null)).toEqual(EMPTY_WORK_SESSION_FILTERS);
    expect(normalizeWorkSessionFilters(undefined)).toEqual(EMPTY_WORK_SESSION_FILTERS);
  });
});

describe("activeWorkSessionFilterLabels", () => {
  it("names each active chip and nothing else", () => {
    expect(activeWorkSessionFilterLabels(EMPTY_WORK_SESSION_FILTERS)).toEqual([]);
    expect(activeWorkSessionFilterLabels(filters({
      status: ["awaiting-input"], tool: ["claude"], hasPr: true,
    }))).toEqual(["Your move", "Claude", "Has PR"]);
  });
});
