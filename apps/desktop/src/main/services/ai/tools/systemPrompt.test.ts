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
    expect(result).toContain("Plan mode");
    expect(result).toContain("without editing files or mutating the system");
  });

  it("uses guarded-local discovery guidance in plan mode", () => {
    const result = buildCodingAgentSystemPrompt({
      cwd: "/x",
      permissionMode: "plan",
      toolNames: ["readFile", "findRoutingFiles", "TodoWrite", "exitPlanMode"],
    });

    expect(result).toContain("Plan mode is read-only. Do not attempt editFile, writeFile, bash, or other mutating actions.");
    expect(result).toContain("Inspect only the concrete files needed to form a plan.");
    expect(result).toContain("use exitPlanMode to request implementation approval");
  });

  it("keeps Codex plan context aligned with native app-server plan mode", () => {
    const result = buildCodingAgentSystemPrompt({
      cwd: "/x",
      permissionMode: "plan",
      runtime: "codex-app-server",
    });

    expect(result).toContain("Native Codex Plan Mode controls planning and approval");
    expect(result).toContain("proposed-plan mechanism");
    expect(result).toContain("Do not use TodoWrite, update_plan, or exitPlanMode");
  });

  it("does not tell non-interactive Codex plan sessions to ask blocking questions", () => {
    const result = buildCodingAgentSystemPrompt({
      cwd: "/x",
      permissionMode: "plan",
      runtime: "codex-app-server",
      interactive: false,
    });

    expect(result).toContain("Native Codex Plan Mode controls planning and approval");
    expect(result).toContain("make the safest reasonable assumptions");
    expect(result).not.toContain("use request_user_input");
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

  describe("runtime environment banner", () => {
    it("omits the runtime block when runtime is not provided", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x" });
      expect(result).not.toContain("## Runtime Environment");
    });

    it("describes the Codex CLI runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "codex-cli" });
      expect(result).toContain("## Runtime Environment");
      expect(result).toContain("Codex CLI");
      expect(result).toContain("No autonomous wake from ADE");
    });

    it("describes the Codex app-server runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "codex-app-server" });
      expect(result).toContain("## Runtime Environment");
      expect(result).toContain("Codex app-server protocol");
      expect(result).toContain("JSON-RPC");
      expect(result).toContain("No autonomous wake from ADE");
    });

    it("describes the Claude Agent SDK query runtime with wake-up caveat", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "claude-agent-sdk-query" });
      expect(result).toContain("## Runtime Environment");
      expect(result).toContain("Claude Agent SDK stable `query()`");
      expect(result).toContain("ScheduleWakeup");
      expect(result).toContain("not honored");
      expect(result).toContain("never re-invokes");
    });

    it("describes the Cursor SDK runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "cursor-sdk" });
      expect(result).toContain("Cursor SDK");
    });

    it("describes the Droid SDK runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "droid-sdk" });
      expect(result).toContain("Factory Droid SDK");
    });

    it("describes the OpenCode runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "opencode" });
      expect(result).toContain("OpenCode session");
    });
  });

  describe("orchestration role guidance", () => {
    const orchestrationArgs = {
      cwd: "/repo",
      orchestrationRunId: "run-1",
      orchestrationBundlePath: "/repo/.ade/orchestration/run-1",
      adeSkillRoots: ["/repo/apps/desktop/resources/agent-skills"],
    };

    it("guides leads through bundled skill discovery and plan quality minimums", () => {
      const result = buildCodingAgentSystemPrompt({
        ...orchestrationArgs,
        orchestrationRole: "lead",
      });

      expect(result).toContain("orchestration **LEAD**");
      expect(result).toContain("/repo/apps/desktop/resources/agent-skills");
      expect(result).toContain("ADE_AGENT_SKILLS_DIRS");
      expect(result).toContain("ade-orchestrator/SKILL.md");
      expect(result).toContain("Lead planning quality contract");
      expect(result).toContain("out-of-scope / non-goals");
      expect(result).toContain("UI / UX / user-facing decisions");
      expect(result).toContain("Planned implementation order");
      expect(result).toContain("Agent plan");
      expect(result).toContain("Validation / proof plan");
      expect(result).toContain("Plan presentation");
      expect(result).toContain("artifacts/ui/*.html");
      expect(result).toContain("Do not embed raw iframes");
      expect(result).toContain("Implementation handoff");
      expect(result).toContain("Implement` button");
      expect(result).toContain("requestPlanApproval");
      expect(result).toContain("Spawn brief discipline");
    });

    it("guides workers to read shared state, stay scoped, update the plan, and report blockers", () => {
      const result = buildCodingAgentSystemPrompt({
        ...orchestrationArgs,
        orchestrationRole: "worker",
        orchestrationParentSessionId: "S-lead",
        orchestrationStepId: "T-1",
        orchestrationTag: "prompt-tools",
      });

      expect(result).toContain("orchestration **WORKER**");
      expect(result).toContain("Read the bundled ADE orchestrator skill");
      expect(result).toContain("Before editing, read `manifest.json`, `plan.md`, your spawn brief, and `## PEERS`");
      expect(result).toContain("Only work in this lane and only on the assigned task");
      expect(result).toContain("Use `planAppend` when you start");
      expect(result).toContain("when you are stuck");
      expect(result).toContain("Use `messageAgent` to report status");
      expect(result).toContain("inter-worker coordination goes through the lead");
    });
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

    it("includes PR tool guidance when ADE PR command tools are present", () => {
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
    expect(result).toContain("## ADE CLI");
    expect(result).toContain("only normal reason to skip ADE CLI");
    expect(result).toContain("ADE exposes Agent Skills from project, user, runtime, and bundled ADE skill roots");
    expect(result).toContain("ade-ios-simulator");
    expect(result).toContain("ade-cli-control-plane");
    expect(result).toContain("ade-orchestrator");
    expect(result).toContain("## Editing Rules");
    expect(result).toContain("## Verification Rules");
    expect(result).toContain("## User-Facing Progress");
    expect(result).toContain("## Task");
  });

  it("uses the active cwd when describing ADE skill roots", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/repo/.ade/worktrees/chat-lane" });

    expect(result).toContain("/repo/.ade/worktrees/chat-lane/apps/desktop/resources/agent-skills");
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
