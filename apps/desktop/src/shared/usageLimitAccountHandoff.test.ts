import { describe, expect, it } from "vitest";
import { usageLimitHandoffPrompt } from "./usageLimitAccountHandoff";

describe("usageLimitHandoffPrompt", () => {
  it("names the account and keeps the task that was already in progress", () => {
    const prompt = usageLimitHandoffPrompt({
      accountLabel: "1028",
      title: "Fix the auth fallback",
      task: "Wire the second Claude login",
      summary: "The reader was still looking at the credentials file.",
    });
    expect(prompt).toContain("Continue the interrupted task on the 1028 account.");
    expect(prompt).toContain("Title: Fix the auth fallback");
    expect(prompt).toContain("Task: Wire the second Claude login");
    expect(prompt).toContain("Where it stopped: The reader was still looking at the credentials file.");
    expect(prompt).toContain("Do not restart work that already completed.");
  });

  it("omits blank context instead of printing empty headings", () => {
    expect(usageLimitHandoffPrompt({ accountLabel: "  ", title: "  ", task: "", summary: null }))
      .toBe("Continue the interrupted task on the other account. The previous chat hit a usage limit. Do not restart work that already completed.");
  });
});
