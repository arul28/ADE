import { describe, expect, it } from "vitest";
import { buildCodingAgentSystemPrompt, composeSystemPrompt } from "./systemPrompt";

describe("buildCodingAgentSystemPrompt", () => {
  it("returns a prompt containing the cwd", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/my/project" });
    expect(result).toContain("/my/project");
  });

  it("defaults to coding mode and edit permission mode", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/x" });
    // coding mode default text
    expect(result).toContain("You are executing coding work");
    // edit permission mode default text
    expect(result).toContain("Edit mode");
  });

  it("includes planning mode description when mode is planning", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/x", mode: "planning" });
    expect(result).toContain("You are planning work");
  });

  it("includes chat mode description when mode is chat", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/x", mode: "chat" });
    expect(result).toContain("interactive coding chat");
  });

  it("includes plan permission description", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/x", permissionMode: "plan" });
    expect(result).toContain("Read-heavy mode");
  });

  it("includes full-auto permission description", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/x", permissionMode: "full-auto" });
    expect(result).toContain("Autonomous mode");
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
    expect(result).toContain("Use the available tools deliberately");
  });

  it("includes interactive question guidance by default", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/x" });
    expect(result).toContain("ask one concise question");
  });

  it("includes non-interactive guidance when interactive is false", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/x", interactive: false });
    expect(result).toContain("make the safest reasonable assumption");
    expect(result).not.toContain("ask one concise question");
  });

  describe("memory section", () => {
    it("includes memory section when memorySearch is in toolNames", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["memorySearch"],
      });
      expect(result).toContain("## Memory");
      expect(result).toContain("Search first");
    });

    it("includes memory section when memoryAdd is in toolNames", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["memoryAdd"],
      });
      expect(result).toContain("## Memory");
    });

    it("includes memory section when memoryPin is in toolNames", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["memoryPin"],
      });
      expect(result).toContain("## Memory");
    });

    it("includes memory section when a memory_ prefixed tool is present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["memory_search"],
      });
      expect(result).toContain("## Memory");
    });

    it("omits memory section when no memory tools present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["listFiles"],
      });
      expect(result).not.toContain("## Memory");
    });

    it("includes core memory guidance when memoryUpdateCore is present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["memoryUpdateCore"],
      });
      expect(result).toContain("Keep the project brief current");
    });

    it("includes core memory guidance when memory_update_core is present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["memory_update_core"],
      });
      expect(result).toContain("Keep the project brief current");
    });

    it("omits core memory guidance when only memorySearch is present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["memorySearch"],
      });
      expect(result).not.toContain("Keep the project brief current");
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
      expect(result).toContain("Recommended workflow");
    });

    it("includes createPrFromLane guidance when present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["createPrFromLane"],
      });
      expect(result).toContain("## Workflow Tools");
      expect(result).toContain("createPrFromLane");
    });

    it("includes captureScreenshot guidance when present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["captureScreenshot"],
      });
      expect(result).toContain("## Workflow Tools");
      expect(result).toContain("captureScreenshot");
    });

    it("includes reportCompletion guidance when present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["reportCompletion"],
      });
      expect(result).toContain("## Workflow Tools");
      expect(result).toContain("reportCompletion");
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
      expect(result).toContain("report the misconfiguration immediately");
    });

    it("omits PR tool guidance when PR workflow tools are absent", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["readFile", "listFiles"],
      });
      expect(result).not.toContain("## Pull Request Tools");
    });

    it("includes PR tool guidance when ADE MCP PR tools are present", () => {
      const result = buildCodingAgentSystemPrompt({
        cwd: "/x",
        toolNames: ["pr_refresh_issue_inventory", "pr_get_review_comments"],
      });
      expect(result).toContain("## Pull Request Tools");
      expect(result).toContain("pr_refresh_issue_inventory, pr_get_review_comments");
    });
  });

  it("always includes operating loop, editing rules, and verification rules", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/x" });
    expect(result).toContain("## Operating Loop");
    expect(result).toContain("## Editing Rules");
    expect(result).toContain("## Verification Rules");
    expect(result).toContain("## User-Facing Progress");
    expect(result).toContain("## Mission");
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

  it("trims leading/trailing whitespace from basePrompt", () => {
    const result = composeSystemPrompt("  do the thing  ", "harness prompt");
    expect(result).toContain("do the thing");
    expect(result).not.toContain("  do the thing  ");
  });
});
