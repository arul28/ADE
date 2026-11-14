import { describe, expect, it } from "vitest";
import { buildCodingAgentSystemPrompt, composeSystemPrompt } from "./systemPrompt";

describe("buildCodingAgentSystemPrompt", () => {
  it("returns a prompt containing the cwd", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/my/project" });
    expect(result).toContain("/my/project");
    expect(result).toContain("Read-only inspection outside this path is allowed");
    expect(result).toContain("mutating commands only inside this path");
  });

  it("includes session activity guidance only when a provider supplies it", () => {
    const guidance = "Report this session's current activity through ADE.";
    expect(buildCodingAgentSystemPrompt({
      cwd: "/x",
      sessionActivityGuidance: guidance,
    })).toContain(guidance);
    expect(buildCodingAgentSystemPrompt({ cwd: "/x" })).not.toContain(guidance);
  });

  it("lists provided tool names when non-empty", () => {
    const result = buildCodingAgentSystemPrompt({
      cwd: "/x",
      toolNames: ["listFiles", "readFile"],
    });
    expect(result).toContain("Available tools: listFiles, readFile.");
  });

  it("deduplicates and filters empty tool names", () => {
    const result = buildCodingAgentSystemPrompt({
      cwd: "/x",
      toolNames: ["readFile", "readFile", "", "  ", "listFiles"],
    });
    expect(result).toContain("Available tools: readFile, listFiles.");
    expect(result).not.toContain("Available tools: readFile, readFile");
  });

  it("omits tool list sentence when no tool names provided", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/x" });
    expect(result).not.toContain("Available tools:");
  });

  describe("runtime environment banner", () => {
    it("omits the runtime block when runtime is not provided", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x" });
      expect(result).not.toContain("## Runtime Environment");
    });

    it.each([
      "codex-cli",
      "codex-app-server",
      "claude-agent-sdk-query",
      "cursor-sdk",
      "droid-sdk",
      "opencode",
    ] as const)("tells %s how to wake itself later and where the scheduling rules live", (runtime) => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime });
      expect(result).toContain("ade chat scheduled-work create");
      expect(result).toContain("**ade-cli-control-plane**");
      // A wake is the agent's own work; a message arriving later is a draft.
      expect(result).toContain("ade drafts");
      expect(result).toContain('ade chat note "testing desktop auth fallback"');
      expect(result).toContain('ade chat ask "<the exact question>"');
      // Agents cannot settle; the prompt says so instead of teaching a command.
      expect(result).toContain("You cannot settle or unsettle a session");
      expect(result).not.toContain("ade chat settle --outcome");
    });

  });

  describe("workflow tools section", () => {
    it("includes workflow section when createLane is present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["createLane"],
      });
      expect(result).toContain("## Workflow Tools");
      expect(result).toContain("createLane");
      // The workflow names a proof command that works off the lane screen.
      expect(result).toMatch(/\*\*Workflow:\*\*[^\n]*`ade browser proof`/);
      expect(result).not.toContain("ade proof capture");
    });

    // `captureScreenshot` has no executable implementation in any live tool
    // registry, so the prompt must not advertise it — an agent that believed
    // the bullet got a tool-not-found error.
    it("never advertises captureScreenshot", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["captureScreenshot", "createLane"],
      });
      expect(result).toContain("## Workflow Tools");
      expect(result).not.toContain("**captureScreenshot**");
    });

    // Same state as `captureScreenshot`: named in the workflow tool list, with
    // no implementation in any live registry. A bullet for it only earned the
    // model a tool-not-found error, so the name alone must not open the section.
    it("never advertises reportCompletion, and it alone does not open the section", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["reportCompletion"],
      });
      expect(result).not.toContain("## Workflow Tools");
      expect(result).not.toContain("**reportCompletion**");
    });

    it("omits workflow section when no workflow tools present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["readFile"],
      });
      expect(result).not.toContain("## Workflow Tools");
    });
  });

  describe("pull request tools section", () => {
    it("includes PR tool guidance when PR workflow tools are present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["prRefreshIssueInventory", "prGetReviewComments"],
      });
      expect(result).toContain("## Pull Request Tools");
      expect(result).toContain("prRefreshIssueInventory, prGetReviewComments");
      expect(result).toContain("not shell commands");
      expect(result).toContain("report the misconfiguration immediately");
    });

    it("omits PR tool guidance when PR workflow tools are absent", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["readFile", "listFiles"],
      });
      expect(result).not.toContain("## Pull Request Tools");
    });

  });

  it("names only skill roots that exist, and says so when none does", () => {
    // `/repo/.ade/worktrees/chat-lane` is not a real directory, so the roots
    // derived from it are not real either. Naming them told the agent to read
    // paths it could not open — and because the list is capped, a dead root
    // also pushed a live one out. A caller that supplies explicit roots keeps
    // full control; this covers the default resolver.
    const result = buildCodingAgentSystemPrompt({ cwd: "/repo/.ade/worktrees/chat-lane" });

    expect(result).not.toContain("/repo/.ade/worktrees/chat-lane/apps/desktop/resources/agent-skills");
    expect(result).not.toContain("/repo/.ade/worktrees/chat-lane/resources/agent-skills");
    expect(result).toContain("read the matching `ade-*` skill");
  });

  it("names an explicitly supplied skill root verbatim", () => {
    const result = buildCodingAgentSystemPrompt({
      cwd: "/repo/.ade/worktrees/chat-lane",
      adeSkillRoots: ["/opt/ade/agent-skills"],
    });

    expect(result).toContain("/opt/ade/agent-skills");
    expect(result).toContain("Agent skill root");
  });
});

describe("composeSystemPrompt", () => {
  it("returns only harness prompt when basePrompt is undefined", () => {
    const result = composeSystemPrompt(undefined, "harness prompt");
    expect(result).toBe("harness prompt");
  });

  it("returns only harness prompt when basePrompt is empty string", () => {
    const result = composeSystemPrompt("", "harness prompt");
    expect(result).toBe("harness prompt");
  });

  it("returns only harness prompt when basePrompt is whitespace-only", () => {
    const result = composeSystemPrompt("   \n  ", "harness prompt");
    expect(result).toBe("harness prompt");
  });

  it("combines harness and base prompt with task-specific header", () => {
    const result = composeSystemPrompt("do the thing", "harness prompt");
    expect(result).toBe("harness prompt\n\n## Task-Specific Instructions\ndo the thing");
  });

});
