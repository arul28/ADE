import { describe, expect, it } from "vitest";
import { foldTodoItemsIntoPlanSteps, todoItemsCoveredByPlanSteps } from "./todoPlanFold";

describe("todoPlanFold", () => {
  it("updates a matching step and appends a new one without mutating the input", () => {
    const steps = [{ text: "Read", status: "pending" as const }];
    const next = foldTodoItemsIntoPlanSteps(steps, [
      { id: "1", description: " Read ", status: "completed" },
      { id: "2", description: "Write", status: "in_progress" },
      { id: "3", description: "   ", status: "pending" },
    ]);
    expect(next).toEqual([
      { text: "Read", status: "completed" },
      { text: "Write", status: "in_progress" },
    ]);
    expect(steps[0]?.status).toBe("pending");
  });

  it("treats a todo as covered only when the plan names every item", () => {
    const steps = [{ text: "Read" }, { text: "Write" }];
    expect(todoItemsCoveredByPlanSteps([{ id: "1", description: "Read", status: "pending" }], steps)).toBe(true);
    expect(todoItemsCoveredByPlanSteps([
      { id: "1", description: "Read", status: "pending" },
      { id: "2", description: "Deploy", status: "pending" },
    ], steps)).toBe(false);
    expect(todoItemsCoveredByPlanSteps([], steps)).toBe(false);
    expect(todoItemsCoveredByPlanSteps([{ id: "1", description: "Read", status: "pending" }], [])).toBe(false);
  });
});
