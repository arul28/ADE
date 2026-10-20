import { describe, expect, it } from "vitest";

import { buildGardeningPrompt, parseContinuityCapture, parseGardeningPlan } from "./ctoMemoryCapture";

describe("parseContinuityCapture", () => {
  it("does not replace a summary when none is labeled and keeps known fact kinds", () => {
    const capture = parseContinuityCapture([
      "I cannot provide a summary for this conversation.",
      "DURABLE:",
      "- decision: Keep retries idempotent across the API boundary.",
      "- convention: Use sentence case in user-facing copy.",
    ].join("\n"));

    expect(capture.summary).toBeNull();
    expect(capture.facts).toEqual([
      { kind: "decision", text: "Keep retries idempotent across the API boundary." },
      { kind: "convention", text: "Use sentence case in user-facing copy." },
    ]);
    expect(capture.facts).toHaveLength(2);
  });
});

describe("parseGardeningPlan", () => {
  it("only lets an unattended answer touch shown, unpinned facts, once each, within the nightly caps", () => {
    const facts = Array.from({ length: 8 }, (_, index) => ({
      id: `id-${index + 1}`,
      text: `fact number ${index + 1} about the build`,
      kind: "fact",
      pinned: index === 1,
    }));
    const { shown } = buildGardeningPrompt({ facts, recentLog: "", discoveries: "" });
    const plan = parseGardeningPlan([
      "MERGE F1 F3 -> decision: Builds run on the merge queue only.",
      "MERGE F1 F4 -> fact: F1 was already merged above.",
      "MERGE F2 F5 -> fact: F2 is pinned, so this merge is dropped.",
      "MERGE F6 F99 -> fact: F99 was never shown, so this is dropped.",
      "RETIRE F2: pinned facts are never retired",
      "RETIRE F4: reversed on Tuesday",
      "RETIRE F5: reversed",
      "RETIRE F6: reversed",
      "RETIRE F7: over the nightly cap",
      "- ADD trap: Never run wrangler dev on port 8787.",
      "ADD trap: short",
      "NONE",
    ].join("\n"), shown);
    expect(plan.merge).toEqual([{ ids: ["id-1", "id-3"], kind: "decision", text: "Builds run on the merge queue only." }]);
    expect(plan.retire.map((row) => row.id)).toEqual(["id-4", "id-5", "id-6"]);
    expect(plan.add).toEqual([{ kind: "trap", text: "Never run wrangler dev on port 8787." }]);
  });
});
