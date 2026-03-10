import { describe, expect, it } from "vitest";
import { deriveSessionSummaryFromText, inferTestOutcomeFromText, parseTranscriptSummary } from "./transcriptInsights";

describe("transcriptInsights", () => {
  it("derives a compact summary from Claude-style output", () => {
    const raw = [
      "Some earlier log line",
      "",
      "All 4 tests pass. Here's what I added:",
      "",
      "  Tip calculation on receipts — the receipt now includes a tip line and a total.",
      "  It defaults to 18% but accepts a custom tipPercent via the options.",
      "",
      "✻ Cooked for 41s",
      ""
    ].join("\n");

    const summary = deriveSessionSummaryFromText(raw);
    expect(summary).toContain("All 4 tests pass");
    expect(summary).toContain("Tip calculation on receipts");
    expect(summary.toLowerCase()).not.toContain("cooked for");
  });

  it("prefers explicit final blocks and records source/confidence", () => {
    const raw = [
      "Checking tests...",
      "",
      "Done. Here's what changed:",
      "- Updated `src/main.ts` to normalize args",
      "- Added retry guard in src/services/retry.ts",
      "- Wrote docs in docs/features/PACKS.md"
    ].join("\n");

    const parsed = parseTranscriptSummary(raw);
    expect(parsed).toBeTruthy();
    expect(parsed?.source).toBe("explicit_final_block");
    expect(parsed?.confidence).toBe("high");
    expect(parsed?.files).toContain("docs/features/PACKS.md");
    expect(parsed?.files).toContain("src/main.ts");
  });

  it("recognizes worker closeout phrasing used by live missions", () => {
    const raw = [
      "thinking",
      "Accomplished: verified the Test tab feature is already fully implemented and committed on this lane branch; no source code changes were required.",
      "",
      "What I verified:",
      "- [TabNav.tsx](/tmp/TabNav.tsx) includes `Test` with `Flask` and `/test`.",
      "- [TestPage.tsx](/tmp/TestPage.tsx) exists and renders 'Coming Soon'.",
    ].join("\n");

    const parsed = parseTranscriptSummary(raw);
    expect(parsed?.source).toBe("explicit_final_block");
    expect(parsed?.summary).toContain("Accomplished:");
    expect(parsed?.files.some((file) => file.endsWith("TabNav.tsx"))).toBe(true);
  });

  it("recognizes planning-worker closeout phrasing", () => {
    const raw = [
      "noise",
      "Research is complete. The \"Test\" tab with \"Coming Soon\" screen is already fully implemented in the codebase from a previous mission run.",
      "",
      "No code changes are needed to complete this task.",
    ].join("\n");

    const summary = deriveSessionSummaryFromText(raw);
    expect(summary).toContain("Research is complete.");
    expect(summary).toContain("No code changes are needed");
  });

  it("falls back to heuristic tail summary when no explicit block exists", () => {
    const raw = [
      "starting",
      "ran tests",
      "All 12 tests passed in 3.8s",
      "Updated parser and conflict heuristics"
    ].join("\n");
    const parsed = parseTranscriptSummary(raw);
    expect(parsed).toBeTruthy();
    expect(parsed?.source).toBe("heuristic_tail");
    expect(parsed?.confidence).toBe("medium");
  });

  it("infers test pass from an 'All tests pass' line", () => {
    const inferred = inferTestOutcomeFromText("All 4 tests pass.\n");
    expect(inferred?.status).toBe("pass");
    expect(inferred?.evidence).toContain("All 4 tests pass");
  });

  it("infers test fail from a jest-like summary line", () => {
    const inferred = inferTestOutcomeFromText("Test Suites: 1 failed, 3 passed, 4 total\n");
    expect(inferred?.status).toBe("fail");
    expect(inferred?.evidence).toContain("Test Suites:");
  });
});
