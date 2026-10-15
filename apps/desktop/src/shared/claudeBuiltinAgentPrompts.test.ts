import { describe, expect, it } from "vitest";
import { CLAUDE_BUILTIN_AGENT_TEMPLATES, withClaudeSubagentCompactWindow } from "./claudeBuiltinAgentPrompts";

describe("withClaudeSubagentCompactWindow", () => {
  it("gives every subagent the window, keeping each built-in on the model it uses by itself", () => {
    const pinned = { description: "pinned", prompt: "p", model: "claude-haiku-5-5", effort: "low" };
    const agents = withClaudeSubagentCompactWindow({ Explore: pinned }, 200_000) as Record<string, Record<string, unknown>>;

    // A preset's own entry keeps everything it had.
    expect(agents.Explore).toEqual({ ...pinned, autoCompactWindow: 200_000 });
    // Built-ins nothing replaced get ADE's copy of their definition.
    expect(agents.Plan).toMatchObject({
      prompt: CLAUDE_BUILTIN_AGENT_TEMPLATES.plan.prompt,
      model: "inherit",
      autoCompactWindow: 200_000,
    });
    expect(agents["general-purpose"]).toMatchObject({
      prompt: CLAUDE_BUILTIN_AGENT_TEMPLATES.generalPurpose.prompt,
      autoCompactWindow: 200_000,
    });
    expect(agents["general-purpose"]).not.toHaveProperty("model");
  });
});
