import { describe, expect, it } from "vitest";
import { renderLanePackMarkdown } from "./lanePackTemplate";

describe("renderLanePackMarkdown", () => {
  it("renders the lane pack structure without ANSI, narrative, or AI summaries", () => {
    const md = renderLanePackMarkdown({
      packKey: "lane:lane-1",
      projectId: "proj-1",
      laneId: "lane-1",
      laneName: "Test Lane",
      branchRef: "feature/test",
      baseRef: "main",
      headSha: "0123456789abcdef",
      dirty: false,
      ahead: 1,
      behind: 0,
      parentName: null,
      deterministicUpdatedAt: "2026-02-14T00:00:00.000Z",
      trigger: "session_end",
      providerMode: "subscription",
      whatChangedLines: ["src/api: 2 files (src/api/a.ts, src/api/b.ts)"],
      inferredWhyLines: ["abc1234 Add rate limiting"],
      userIntentMarkers: { start: "<!-- ADE_INTENT_START -->", end: "<!-- ADE_INTENT_END -->" },
      userIntent: "Tighten API behavior under load.",
      taskSpecMarkers: { start: "<!-- ADE_TASK_SPEC_START -->", end: "<!-- ADE_TASK_SPEC_END -->" },
      taskSpec: "- Problem: API degrades under burst.\n- Acceptance: p95 < 200ms\n- Non-goals: rewrite auth",
      validationLines: ["Tests: PASS (suite=unit, duration=72ms)"],
      keyFiles: [{ file: "src/api/a.ts", insertions: 10, deletions: 2 }],
      errors: ["\u001b[31mTypeError: boom\u001b[0m at src/api/a.ts:1"],
      sessionsDetailed: [
        {
          when: "14:32",
          tool: "Shell",
          goal: "npm test",
          result: "ok",
          delta: "+10/-2",
          prompt: "Run the unit tests",
          commands: ["npm test"],
          filesTouched: ["src/api/a.ts"],
          errors: []
        }
      ],
      sessionsTotal: 1,
      sessionsRunning: 0,
      nextSteps: ["Sync with base"],
      userTodosMarkers: { start: "<!-- ADE_TODOS_START -->", end: "<!-- ADE_TODOS_END -->" },
      userTodos: "- [ ] ship it",
      laneDescription: "Implement rate limiting for the public API endpoints"
    });

    expect(md).toContain("```json");
    expect(md).toContain("# Lane: Test Lane");
    expect(md).toContain("## Original Intent");
    expect(md).toContain("Implement rate limiting for the public API endpoints");
    expect(md).toContain("## What Changed");
    expect(md).toContain("## Why");
    expect(md).toContain("## Task Spec");
    expect(md).toContain("## Validation");
    expect(md).toContain("## Key Files");
    expect(md).toContain("## Errors & Issues");
    expect(md).toContain("## Sessions");
    expect(md).toContain("### Session 1:");
    expect(md).toContain("**Prompt**: Run the unit tests");
    expect(md).toContain("**Goal**: npm test");
    expect(md).toContain("**Result**: ok");
    expect(md).toContain("**Delta**: +10/-2");
    expect(md).toContain("**Commands**:");
    expect(md).toContain("**Files touched**:");
    expect(md).toContain("## Open Questions / Next Steps");
    expect(md).not.toContain("\u001b");
    // No narrative section
    expect(md).not.toContain("## Narrative");
    expect(md).not.toContain("ADE_NARRATIVE");
    // No AI summaries
    expect(md).not.toContain("Recent summaries:");
    // No narrativeUpdatedAt in JSON header
    expect(md).not.toContain("narrativeUpdatedAt");
  });

  it("omits Original Intent section when lane description is empty", () => {
    const md = renderLanePackMarkdown({
      packKey: "lane:lane-2",
      projectId: "proj-1",
      laneId: "lane-2",
      laneName: "Empty Lane",
      branchRef: "feature/empty",
      baseRef: "main",
      headSha: "abcdef1234567890",
      dirty: true,
      ahead: 0,
      behind: 0,
      parentName: "Main Lane",
      deterministicUpdatedAt: "2026-02-14T00:00:00.000Z",
      trigger: "manual",
      providerMode: "guest",
      whatChangedLines: [],
      inferredWhyLines: [],
      userIntentMarkers: { start: "<!-- ADE_INTENT_START -->", end: "<!-- ADE_INTENT_END -->" },
      userIntent: "",
      taskSpecMarkers: { start: "<!-- ADE_TASK_SPEC_START -->", end: "<!-- ADE_TASK_SPEC_END -->" },
      taskSpec: "",
      validationLines: [],
      keyFiles: [],
      errors: [],
      sessionsDetailed: [],
      sessionsTotal: 0,
      sessionsRunning: 0,
      nextSteps: [],
      userTodosMarkers: { start: "<!-- ADE_TODOS_START -->", end: "<!-- ADE_TODOS_END -->" },
      userTodos: "",
      laneDescription: ""
    });

    expect(md).not.toContain("## Original Intent");
    expect(md).toContain("No sessions recorded yet.");
    expect(md).not.toContain("## Narrative");
  });

  it("shows session count message when total exceeds displayed", () => {
    const md = renderLanePackMarkdown({
      packKey: "lane:lane-3",
      projectId: "proj-1",
      laneId: "lane-3",
      laneName: "Busy Lane",
      branchRef: "feature/busy",
      baseRef: "main",
      headSha: "1111111122222222",
      dirty: false,
      ahead: 5,
      behind: 2,
      parentName: null,
      deterministicUpdatedAt: "2026-02-14T00:00:00.000Z",
      trigger: "session_end",
      providerMode: "subscription",
      whatChangedLines: [],
      inferredWhyLines: [],
      userIntentMarkers: { start: "<!-- ADE_INTENT_START -->", end: "<!-- ADE_INTENT_END -->" },
      userIntent: "Test intent",
      taskSpecMarkers: { start: "<!-- ADE_TASK_SPEC_START -->", end: "<!-- ADE_TASK_SPEC_END -->" },
      taskSpec: "",
      validationLines: [],
      keyFiles: [],
      errors: [],
      sessionsDetailed: [
        { when: "10:00", tool: "Claude", goal: "fix bug", result: "ok", delta: "+5/-1", prompt: "Fix the auth bug", commands: [], filesTouched: [], errors: [] }
      ],
      sessionsTotal: 50,
      sessionsRunning: 1,
      nextSteps: [],
      userTodosMarkers: { start: "<!-- ADE_TODOS_START -->", end: "<!-- ADE_TODOS_END -->" },
      userTodos: "",
      laneDescription: ""
    });

    expect(md).toContain("Showing 1 most recent sessions out of 50 total.");
  });
});
