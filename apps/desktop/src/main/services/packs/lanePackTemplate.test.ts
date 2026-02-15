import { describe, expect, it } from "vitest";
import { renderLanePackMarkdown } from "./lanePackTemplate";

describe("renderLanePackMarkdown", () => {
  it("renders the new lane pack structure without ANSI or old placeholders", () => {
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
      providerMode: "hosted",
      whatChangedLines: ["src/api: 2 files (src/api/a.ts, src/api/b.ts)"],
      inferredWhyLines: ["abc1234 Add rate limiting"],
      userIntentMarkers: { start: "<!-- ADE_INTENT_START -->", end: "<!-- ADE_INTENT_END -->" },
      userIntent: "Tighten API behavior under load.",
      taskSpecMarkers: { start: "<!-- ADE_TASK_SPEC_START -->", end: "<!-- ADE_TASK_SPEC_END -->" },
      taskSpec: "- Problem: API degrades under burst.\n- Acceptance: p95 < 200ms\n- Non-goals: rewrite auth",
      validationLines: ["Tests: PASS (suite=unit, duration=72ms)"],
      keyFiles: [{ file: "src/api/a.ts", insertions: 10, deletions: 2 }],
      errors: ["\u001b[31mTypeError: boom\u001b[0m at src/api/a.ts:1"],
      sessionsRows: [{ when: "14:32", tool: "Shell", goal: "npm test", result: "ok", delta: "+10/-2" }],
      sessionHighlights: [{ when: "14:32", tool: "Shell", summary: "All tests pass and receipt total updated." }],
      sessionsTotal: 1,
      sessionsRunning: 0,
      nextSteps: ["Sync with base"],
      userTodosMarkers: { start: "<!-- ADE_TODOS_START -->", end: "<!-- ADE_TODOS_END -->" },
      userTodos: "- [ ] ship it",
      narrativeMarkers: { start: "<!-- ADE_NARRATIVE_START -->", end: "<!-- ADE_NARRATIVE_END -->" },
      narrative: "AI narrative not yet generated. Click 'Update with AI' to generate."
    });

    expect(md).toContain("```json");
    expect(md).toContain("# Lane: Test Lane");
    expect(md).toContain("## What Changed");
    expect(md).toContain("## Why");
    expect(md).toContain("## Task Spec");
    expect(md).toContain("## Validation");
    expect(md).toContain("## Key Files");
    expect(md).toContain("## Errors & Issues");
    expect(md).toContain("## Sessions");
    expect(md).toContain("Recent summaries:");
    expect(md).toContain("## Open Questions / Next Steps");
    expect(md).toContain("## Narrative");
    expect(md).not.toContain("\u001b");
    expect(md).not.toContain("Describe lane intent and acceptance criteria here.");
  });
});
