import { describe, expect, it } from "vitest";
import {
  CLAUDE_AGENT_SDK_TOOL_PROFILE,
  CLAUDE_BUILTIN_AGENT_TEMPLATES,
  claudeToolProfileFromInitTools,
  type ClaudeBuiltinToolProfile,
  withClaudeSubagentCompactWindow,
} from "./claudeBuiltinAgentPrompts";

const launch = { profile: CLAUDE_AGENT_SDK_TOOL_PROFILE, mainModel: "claude-opus-5-5" };

describe("claudeToolProfileFromInitTools", () => {
  it.each([
    ["the Agent SDK on macOS and Linux", ["Bash", "Read", "Edit", "Write"], { shellTool: "Bash", searchTools: false }],
    ["a machine with Glob and Grep", ["Bash", "Glob", "Grep", "Read", "Edit", "Write"], { shellTool: "Bash", searchTools: true }],
    ["Windows without Git Bash", ["PowerShell", "Glob", "Grep", "Read", "Edit", "Write"], { shellTool: "PowerShell", searchTools: true }],
    ["a probe that ran with no tools", [], null],
    ["a chat that narrowed its tools", ["Bash", "Read"], null],
    ["no tool list", undefined, null],
  ])("%s", (_name, tools, expected) => {
    expect(claudeToolProfileFromInitTools(tools)).toEqual(expected);
  });
});

describe("built-in prompts", () => {
  it.each<[string, ClaudeBuiltinToolProfile, string[], string[]]>([
    ["searching with find and grep in Bash", { shellTool: "Bash", searchTools: false }, ["via Bash", "find, grep,", "Use Bash"], ["Use Glob", "Use Grep", "PowerShell"]],
    ["searching with Glob and Grep", { shellTool: "Bash", searchTools: true }, ["Use Glob", "Use Grep", "Use Bash"], ["via Bash", "PowerShell"]],
    ["PowerShell", { shellTool: "PowerShell", searchTools: true }, ["Use Glob", "Use PowerShell", "Get-ChildItem", "New-Item"], ["Bash"]],
  ])("Explore names the tools of a machine %s", (_name, profile, present, absent) => {
    const prompt = CLAUDE_BUILTIN_AGENT_TEMPLATES.explore.prompt(profile);
    for (const text of present) expect(prompt).toContain(text);
    for (const text of absent) expect(prompt).not.toContain(text);
  });
});

describe("withClaudeSubagentCompactWindow", () => {
  it("gives every subagent the window, keeping each built-in on the model and context it uses by itself", () => {
    const pinned = { description: "pinned", prompt: "p", model: "claude-haiku-5-5", effort: "low" };
    const agents = withClaudeSubagentCompactWindow({ Explore: pinned }, { subagentAtTokens: 200_000 }, launch) as Record<string, Record<string, unknown>>;

    // A preset's own entry keeps everything it had.
    expect(agents.Explore).toEqual({ ...pinned, autoCompactWindow: 200_000 });
    // Built-ins nothing replaced get ADE's copy of their definition.
    expect(agents.Plan).toMatchObject({
      prompt: CLAUDE_BUILTIN_AGENT_TEMPLATES.plan.prompt(CLAUDE_AGENT_SDK_TOOL_PROFILE),
      model: "inherit",
      omitClaudeMd: true,
      autoCompactWindow: 200_000,
    });
    expect(agents["general-purpose"]).toMatchObject({
      prompt: CLAUDE_BUILTIN_AGENT_TEMPLATES.generalPurpose.prompt(CLAUDE_AGENT_SDK_TOOL_PROFILE),
      autoCompactWindow: 200_000,
    });
    expect(agents["general-purpose"]).not.toHaveProperty("model");
    expect(agents["general-purpose"]).not.toHaveProperty("omitClaudeMd");
  });

  it.each([
    ["an Opus main model", "claude-opus-5-5", "inherit"],
    ["a Fable main model, which Claude Code caps at Opus", "claude-fable-5-1", "opus"],
  ])("runs Explore under %s on %s", (_name, mainModel, exploreModel) => {
    const agents = withClaudeSubagentCompactWindow({}, { subagentAtTokens: 200_000 }, { ...launch, mainModel }) as Record<string, Record<string, unknown>>;
    expect(agents.Explore?.model).toBe(exploreModel);
    expect(agents.Plan?.model).toBe("inherit");
  });

  it.each([
    ["no window (Auto)", {}, launch],
    ["a window the SDK would ignore: at or above the main chat's", { atTokens: 300_000, subagentAtTokens: 300_000 }, launch],
  ])("leaves every agent as it was with %s", (_name, settings, launchArgs) => {
    const pinned = { description: "pinned", prompt: "p", model: "claude-haiku-5-5" };
    expect(withClaudeSubagentCompactWindow({ Explore: pinned }, settings, launchArgs)).toEqual({ Explore: pinned });
  });

  it("leaves the built-ins to Claude Code on a machine whose shell is not known yet", () => {
    const pinned = { description: "pinned", prompt: "p", model: "claude-haiku-5-5" };
    expect(withClaudeSubagentCompactWindow({ Explore: pinned }, { subagentAtTokens: 200_000 }, { profile: null, mainModel: "claude-opus-5-5" }))
      .toEqual({ Explore: { ...pinned, autoCompactWindow: 200_000 } });
  });
});
