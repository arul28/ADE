import { describe, expect, it } from "vitest";
import {
  buildMemoryQueryPlan,
  buildMemorySearchQuery,
} from "./memoryQueryPlannerService";

describe("memoryQueryPlannerService", () => {
  it("skips casual and test-message turns", () => {
    expect(buildMemoryQueryPlan({ promptText: "thanks" })).toMatchObject({
      classification: "none",
      query: "",
      reasons: ["short_turn"],
    });
    expect(buildMemoryQueryPlan({ promptText: "this is a test message" })).toMatchObject({
      classification: "none",
      query: "",
      reasons: ["test_message"],
    });
  });

  it("requires memory orientation for coding turns and builds a compact intent query", () => {
    const plan = buildMemoryQueryPlan({
      promptText: "Please fix the failing desktop tests in apps/desktop/src/main/main.ts and update renderer memory retrieval.",
    });

    expect(plan.classification).toBe("required");
    expect(plan.reasons).toContain("code_or_file_scope");
    expect(plan.query).toContain("apps/desktop/src/main/main.ts");
    expect(plan.query).toContain("desktop");
    expect(plan.query).toContain("memory");
    expect(plan.query).not.toContain("please");
  });

  it("requires memory orientation for review and architecture decisions", () => {
    const plan = buildMemoryQueryPlan({
      promptText: "Review the memory architecture tradeoffs and decide how agents should retrieve context.",
    });

    expect(plan.classification).toBe("required");
    expect(plan.reasons).toContain("review_or_architecture_decision");
    expect(plan.projectLimit).toBeGreaterThan(plan.agentLimit);
  });

  it("uses attachment presence as a required memory signal", () => {
    const plan = buildMemoryQueryPlan({
      promptText: "Can you inspect this?",
      attachmentCount: 1,
    });

    expect(plan.classification).toBe("required");
    expect(plan.reasons).toContain("attachments");
    expect(plan.query).toContain("inspect");
  });

  it("removes low-signal prompt filler from search queries", () => {
    expect(buildMemorySearchQuery("please make sure that agents use memory when necessary")).toBe(
      "sure agents memory necessary",
    );
  });
});
