import { describe, expect, it } from "vitest";
import { buildCodingAgentSystemPrompt, composeSystemPrompt } from "./systemPrompt";

describe("buildCodingAgentSystemPrompt", () => {
  it("returns a prompt containing the cwd", () => {
    const result = buildCodingAgentSystemPrompt({ cwd: "/my/project" });
    expect(result).toContain("/my/project");
    expect(result).toContain("Read-only inspection outside this path is allowed");
    expect(result).toContain("mutating commands only inside this path");
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

    it.each([
      "codex-cli",
      "codex-app-server",
      "claude-agent-sdk-query",
      "cursor-sdk",
      "droid-sdk",
      "opencode",
    ] as const)("gives %s timezone-safe scheduled-work guidance", (runtime) => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime });
      expect(result).toContain("scheduled-work create --in 12m");
      expect(result).toContain("avoid timezone arithmetic");
      expect(result).toContain("brain machine's local timezone");
      expect(result).toContain("verify it before ending the turn");
      expect(result).toContain('ade chat note "testing desktop auth fallback"');
      expect(result).toContain('ade chat ask "<the exact question>"');
      // Agents cannot settle; the prompt says so instead of teaching a command.
      expect(result).toContain("You cannot settle or unsettle a session");
      expect(result).not.toContain("ade chat settle --outcome");
    });

    it("describes the Codex CLI runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "codex-cli" });
      expect(result).toContain("## Runtime Environment");
      expect(result).toContain("Codex CLI");
      expect(result).toContain("chat.createScheduledWork");
      expect(result).toContain("targets your own tracked agent session automatically");
    });

    it("describes the Codex app-server runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "codex-app-server" });
      expect(result).toContain("## Runtime Environment");
      expect(result).toContain("Codex app-server protocol");
      expect(result).toContain("JSON-RPC");
      expect(result).toContain("chat.createScheduledWork");
      expect(result).toContain("next turn boundary");
    });

    it("describes durable Claude scheduled self-resume and pause controls", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "claude-agent-sdk-query" });
      expect(result).toContain("## Runtime Environment");
      expect(result).toContain("Claude Agent SDK stable `query()`");
      expect(result).toContain("ScheduleWakeup");
      expect(result).toContain("CronCreate");
      expect(result).toContain("automatically mirrored into ADE's durable scheduler");
      expect(result).toContain("`durable: true` also persists Claude's provider copy");
      expect(result).toContain("next turn boundary even if the chat was busy");
      expect(result).toContain("`CronList` view is advisory; ADE state wins");
      expect(result).toContain("CronCreate` always creates a new job");
      expect(result).toContain("`CronList` + `CronDelete`");
      expect(result).toContain("expire seven days after creation");
      expect(result).toContain("project-wide in Settings");
      expect(result).not.toContain("unavailable in this ADE chat");
      expect(result).not.toContain("will not start a later turn by itself");
    });

    it("routes Claude-family delegation through the native Agent tool", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "claude-agent-sdk-query" });

      expect(result).toContain("prefer Claude's native `Agent`/`Task` tool");
      expect(result).toContain("another Anthropic-family model");
      expect(result).toContain("Do not create an ADE `--type subagent` chat in the same lane merely to switch Claude models");
      expect(result).toContain("independent durable transcript");
    });

    it("does not claim native subagents for the Pi SDK path", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "pi-sdk" });

      expect(result).toContain("Pi's SDK path has no ADE-supported native subagent lifecycle");
      expect(result).toContain("Use an ADE `--type subagent` chat");
      expect(result).not.toContain("prefer Pi's native");
    });

    it("describes the Cursor SDK runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "cursor-sdk" });
      expect(result).toContain("Cursor SDK");
      expect(result).toContain("chat.createScheduledWork");
    });

    it("describes the Droid SDK runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "droid-sdk" });
      expect(result).toContain("Factory Droid SDK");
      expect(result).toContain("chat.createScheduledWork");
    });

    it("describes the OpenCode runtime", () => {
      const result = buildCodingAgentSystemPrompt({ cwd: "/x", runtime: "opencode" });
      expect(result).toContain("OpenCode session");
      expect(result).toContain("chat.createScheduledWork");
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
    expect(result).toContain("status checks, interruptions, and tool/subagent timeouts as checkpoints");
    expect(result).toContain("unless the user explicitly says stop, pause, or only report status");
    expect(result).toContain("## ADE");
    expect(result).toContain("read the matching `ade-*` skill");
    expect(result).toContain("ADE capabilities ship as Agent Skills");
    expect(result).toContain("ade-apple");
    expect(result).toContain("ade-ios-simulator");
    expect(result).toContain("ade-cli-control-plane");
    expect(result).not.toContain("ade-orchestrator");
    expect(result).toContain("## Editing Rules");
    expect(result).toContain("## Verification Rules");
    expect(result).toContain("## User-Facing Progress");
    expect(result).toContain("## Task");
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
    expect(result).toContain("ADE capabilities ship as Agent Skills");
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

  it("trims leading/trailing whitespace from basePrompt", () => {
    const result = composeSystemPrompt("  do the thing  ", "harness prompt");
    expect(result).toContain("do the thing");
    expect(result).not.toContain("  do the thing  ");
  });
});
