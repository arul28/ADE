import { describe, expect, it } from "vitest";
import type { ReviewContextValidationPayload } from "./reviewContextBuilder";
import { buildToolBackedEvidence } from "./reviewToolEvidence";

function emptyPayload(
  overrides: Partial<ReviewContextValidationPayload> = {},
): ReviewContextValidationPayload {
  return {
    linkedPr: null,
    reviewSnapshot: null,
    checks: [],
    suites: [],
    testRuns: [],
    issueInventory: [],
    sessionFailures: [],
    signals: [],
    ...overrides,
  };
}

describe("buildToolBackedEvidence", () => {
  it("returns no evidence when validation payload is null", () => {
    const out = buildToolBackedEvidence({
      finding: { filePath: "src/api.ts", title: "x", body: "", line: 1 },
      validation: null,
    });
    expect(out).toEqual([]);
  });

  it("maps a validation signal when the file path overlaps", () => {
    const out = buildToolBackedEvidence({
      finding: { filePath: "src/api.ts", title: "Handler drops errors", body: "...", line: 20 },
      validation: emptyPayload({
        signals: [
          {
            kind: "test_run_failure",
            summary: "api integration test failing in src/api.ts",
            filePaths: ["src/api.ts"],
            sourceId: "suite:integration",
          },
        ],
      }),
    });
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("tool_signal");
    expect(out[0]?.toolSignal?.kind).toBe("test");
    expect(out[0]?.toolSignal?.status).toBe("fail");
  });

  it("caps evidence at three entries", () => {
    const signals = Array.from({ length: 6 }, (_, i) => ({
      kind: "pr_check_failure" as const,
      summary: `check ${i} error in src/api.ts`,
      filePaths: ["src/api.ts"],
      sourceId: `check-${i}`,
    }));
    const out = buildToolBackedEvidence({
      finding: { filePath: "src/api.ts", title: "Issue", body: "", line: 1 },
      validation: emptyPayload({ signals }),
    });
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("includes a failing CI check that mentions the title keywords", () => {
    const out = buildToolBackedEvidence({
      finding: { filePath: null, title: "Typecheck regression in shared types", body: "", line: null },
      validation: emptyPayload({
        checks: [
          {
            name: "typecheck",
            status: "completed",
            conclusion: "failure",
            detailsUrl: "https://ci/run/1",
            startedAt: null,
            completedAt: null,
          },
        ],
      }),
    });
    expect(out.length).toBe(1);
    expect(out[0]?.toolSignal?.kind).toBe("typecheck");
  });

  it("does not attach a test-run signal whose only token overlap is a substring (test vs latest)", () => {
    // Finding body mentions "latest" and "tested" but never the word "test"
    // on its own. A substring match would have (incorrectly) attached this.
    const out = buildToolBackedEvidence({
      finding: {
        filePath: null,
        title: "Use the latest client",
        body: "We have tested this carefully.",
        line: null,
      },
      validation: emptyPayload({
        signals: [
          {
            kind: "test_run_failure",
            summary: "test suite failing",
            filePaths: [],
            sourceId: "suite:unit",
          },
        ],
      }),
    });
    expect(out).toEqual([]);
  });

  it("single-word summary (e.g. 'typecheck') needs only one token hit to qualify", () => {
    const out = buildToolBackedEvidence({
      finding: { filePath: null, title: "typecheck fails in shared types", body: "", line: null },
      validation: emptyPayload({
        signals: [
          {
            kind: "pr_check_failure",
            summary: "typecheck",
            filePaths: [],
            sourceId: "check:typecheck",
          },
        ],
      }),
    });
    expect(out.length).toBe(1);
    expect(out[0]?.toolSignal?.kind).toBe("ci_check");
  });

  it("does not double-count duplicate tokens in the summary", () => {
    // Summary repeats "handler" three times; title mentions "handler" once.
    // Under the pre-dedup logic, three hits would satisfy the "required: 2"
    // threshold even against a single real occurrence. With dedup, tokens
    // are only counted once — so we still need a second distinct token match.
    const out = buildToolBackedEvidence({
      finding: { filePath: null, title: "Handler drops errors", body: "", line: null },
      validation: emptyPayload({
        signals: [
          {
            kind: "test_run_failure",
            summary: "handler handler handler",
            filePaths: [],
            sourceId: "suite:x",
          },
        ],
      }),
    });
    expect(out).toEqual([]);
  });
});
