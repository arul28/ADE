import { buildAdeCliAgentGuidance } from "../../../../shared/adeCliGuidance";
import { adePromptAgentSkillRoots } from "../../skills/agentSkillRuntimeService";

/**
 * The opening of every coding-agent system prompt ADE builds. Session import
 * reads it to recognise ADE's own Copilot chats that predate their
 * `client_name` (`externalSessions/discoverCopilot.ts`), so keep it stable.
 */
export const ADE_AGENT_PROMPT_OPENING = "You are ADE's software engineering agent working in";

type HarnessMode = "chat" | "coding" | "planning";
type HarnessPermissionMode = "plan" | "edit" | "full-auto";

/**
 * Identifier for the runtime that's actually executing the model. Used to tell
 * the agent which harness it's in so it knows which provider-native primitives
 * ADE supports and whether autonomous wake-ups are possible.
 */
export type AdeRuntimeKind =
  | "claude-agent-sdk-query"
  | "claude-code-cli"
  | "codex-app-server"
  | "codex-cli"
  | "cursor-sdk"
  | "droid-sdk"
  | "copilot-sdk"
  | "pi-sdk"
  | "opencode";

/**
 * The runtime block is paid on every chat by every provider, so it names each
 * capability in a line and leaves the manual to the **ade-cli-control-plane**
 * skill (scheduling rules, drafts, MCP servers and sign-in). The drafts and
 * MCP-server lines live in the shared `## ADE` block, which every one of these
 * prompts carries.
 */
const adeScheduledWorkGuidance = "**Scheduled work:** to wake yourself later, run `ade chat scheduled-work create --in 12m --prompt \"<task>\" --text`. Details: **ade-cli-control-plane**.";

const openCodeBackgroundWorkGuidance = "**Background work:** `shell` with `background: true` and background subagents are fine: ADE shows each job, keeps the session open, and wakes you when it ends. They stop if ADE restarts, so for a wait that must survive a restart use `ade chat scheduled-work create`.";

const adeProviderSubagentGuidance = "Another provider's model: `ade new chat --mode chat --provider <p> --model <m> --prompt \"<task>\"` (it reports back).";

type NativeSubagentFamily = "claude" | "codex" | "cursor" | "droid" | "copilot" | "opencode" | "pi";

const nativeSubagentFamilyByRuntime: Record<AdeRuntimeKind, NativeSubagentFamily> = {
  "claude-agent-sdk-query": "claude",
  "claude-code-cli": "claude",
  "codex-app-server": "codex",
  "codex-cli": "codex",
  "cursor-sdk": "cursor",
  "droid-sdk": "droid",
  "copilot-sdk": "copilot",
  opencode: "opencode",
  "pi-sdk": "pi",
};

const nativeSubagentGuidanceByFamily: Record<NativeSubagentFamily, string> = {
  claude: "Prefer the native `Agent` tool for Claude models.",
  codex: "Prefer your native subagent tool.",
  cursor: "Prefer Cursor's native task tool.",
  droid: "Prefer Droid's native subagent tool.",
  copilot: "Copilot has no native subagent tool here. Delegate with an ADE subagent chat.",
  opencode: "Prefer OpenCode's native `task` tool.",
  pi: "Pi has no native subagent tool here. Delegate with `ade new chat --mode chat --prompt \"<task>\"`: it runs as your subagent and reports back. Give it a self-contained brief.",
};

export function buildNativeSubagentRoutingGuidance(runtime: AdeRuntimeKind): string {
  const family = nativeSubagentFamilyByRuntime[runtime];
  const nativeGuidance = nativeSubagentGuidanceByFamily[family];
  return `**Subagent routing:** ${nativeGuidance}${family === "pi" ? "" : ` ${adeProviderSubagentGuidance}`}`;
}

function describeSubagentRouting(runtime: AdeRuntimeKind): string {
  return buildNativeSubagentRoutingGuidance(runtime);
}

function describeRuntime(runtime: AdeRuntimeKind): string[] {
  switch (runtime) {
    case "claude-agent-sdk-query":
      return [
        "**Runtime:** ADE Work chat on the Claude Agent SDK.",
        describeSubagentRouting(runtime),
        "**Wake-ups:** `ScheduleWakeup`, `CronCreate` and `/loop` use ADE's durable scheduler. Details: **ade-cli-control-plane**.",
      ];
    case "claude-code-cli":
      return [
        "**Runtime:** ADE Work chat running Claude Code CLI as a subprocess; ADE owns the lane, transcript and follow-ups.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "codex-cli":
      return [
        "**Runtime:** ADE Work chat running the Codex CLI; ADE hosts slash commands, attachments and the lane.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "codex-app-server":
      return [
        "**Runtime:** ADE Work chat on the Codex app-server; ADE hosts slash commands, attachments and the lane.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "cursor-sdk":
      return [
        "**Runtime:** ADE Work chat on the Cursor SDK.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "droid-sdk":
      return [
        "**Runtime:** ADE Work chat on the Factory Droid SDK (local Droid CLI).",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "copilot-sdk":
      return [
        "**Runtime:** ADE Work chat on the GitHub Copilot SDK (installed Copilot CLI).",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "pi-sdk":
      return [
        "**Runtime:** ADE Work chat on the user's Pi SDK; ADE owns the transcript and lane, Pi its session file and credentials.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "opencode":
      return [
        "**Runtime:** ADE Work chat wrapping an OpenCode session.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
        openCodeBackgroundWorkGuidance,
      ];
  }
}

function describePermissionMode(mode: HarnessPermissionMode): string {
  switch (mode) {
    case "plan":
      return "Plan mode: stay read-only. Inspect, analyze, ask, and plan; do not edit files or change the system.";
    case "full-auto":
      return "Autonomous mode: edit and validate on your own, with the smallest safe change, and verify it.";
    default:
      return "Edit mode: make focused changes and run validation; avoid needless mutations.";
  }
}

function describeMode(mode: HarnessMode): string {
  switch (mode) {
    case "planning":
      return "You are planning: find constraints and risks and give a concrete plan before any code change.";
    case "chat":
      return "Interactive coding chat: keep the user informed with short progress notes.";
    default:
      return "You are doing coding work: inspect, edit and verify without stalling.";
  }
}

export function buildCodingAgentSystemPrompt(args: {
  cwd: string;
  mode?: HarnessMode;
  permissionMode?: HarnessPermissionMode;
  toolNames?: string[];
  interactive?: boolean;
  runtime?: AdeRuntimeKind;
  adeSkillRoots?: readonly string[];
  /** Provider-gated status advice; omitted unless this session can run ADE CLI. */
  sessionActivityGuidance?: string | null;
  /**
   * The runtime lists ADE's skills itself, with their descriptions (Claude's
   * bundled `ade` plugin). The prompt then leaves out its own copy of the index.
   */
  nativeSkillListing?: boolean;
  /** The caller appends the computer-use directive to this same prompt. */
  computerUseDirectiveIncluded?: boolean;
}): string {
  const mode = args.mode ?? "coding";
  const permissionMode = args.permissionMode ?? "edit";
  const toolNames = [...new Set((args.toolNames ?? []).filter((entry) => entry.trim().length > 0))];
  const interactive = args.interactive !== false;
  const runtime = args.runtime;
  const hasCreateLane = toolNames.includes("createLane");
  const hasCreatePr = toolNames.includes("createPrFromLane");
  const hasTodoTools = toolNames.includes("TodoWrite") || toolNames.includes("TodoRead");
  // Only tools with a live implementation get a bullet. `createLane` and
  // `createPrFromLane` are real (`ctoOperatorTools.ts`); `captureScreenshot`
  // and `reportCompletion` had none in any tool registry, so advertising them
  // just earned the model a tool-not-found error.
  const hasWorkflowTools = hasCreateLane || hasCreatePr;
  const guardedLocalReadOnly = permissionMode === "plan";
  const adeSkillRoots = args.adeSkillRoots ?? adePromptAgentSkillRoots({ cwd: args.cwd });
  // Both spellings on purpose. The camelCase names are historical chat-tool
  // spellings; most have a LIVE snake_case twin on the RPC tool surface
  // (`apps/ade-cli/src/adeRpcServer.ts`). Never conclude "unbuilt" from the
  // camelCase spelling alone — see docs/features/chat/tool-system.md, "Tier 2".
  const PR_ISSUE_TOOL_NAMES = new Set([
    "prGetChecks",
    "prGetCheckLog",
    "prGetReviewComments",
    "prRefreshIssueInventory",
    "prRerunFailedChecks",
    "prReplyToReviewThread",
    "prResolveReviewThread",
    "pr_get_checks",
    "pr_get_check_log",
    "pr_get_review_comments",
    "pr_refresh_issue_inventory",
    "pr_rerun_failed_checks",
    "pr_reply_to_review_thread",
    "pr_resolve_review_thread",
  ]);
  const prIssueToolNames = toolNames.filter((name) => PR_ISSUE_TOOL_NAMES.has(name));
  const hasPrIssueTools = prIssueToolNames.length > 0;

  // An interactive chat gets no "ask one question when stuck" line: the
  // harnesses already decide when to ask, and the 2026-11-16 discovery bench
  // found no loss without it. The section stays for what changes behavior: a
  // tool list, plan mode, a task list, a headless run.
  const toolUseRules = [
    ...(toolNames.length ? [`Available tools: ${toolNames.join(", ")}.`] : []),
    ...(guardedLocalReadOnly
      ? runtime === "codex-cli" || runtime === "codex-app-server"
        ? [
            interactive
              ? "Native Codex Plan Mode controls planning and approval. Preserve that built-in flow: stay read-only, use request_user_input for important clarifications when needed, and publish the final plan through Codex's proposed-plan mechanism."
              : "Native Codex Plan Mode controls planning and approval. Preserve that built-in flow: stay read-only, make the safest reasonable assumptions when clarification would otherwise be needed, and publish the final plan through Codex's proposed-plan mechanism.",
            "Do not use TodoWrite, update_plan, or exitPlanMode as the plan-approval path in native Codex Plan Mode.",
          ]
        : [
            "Plan mode is read-only. Do not attempt editFile, writeFile, bash, or other mutating actions.",
            "Inspect only the concrete files needed to form a plan. Do not keep broad-searching once you have enough context.",
            "When the plan is clear, write or update a short TodoWrite plan, ask one clarifying question if needed, then use exitPlanMode to request implementation approval.",
          ]
      : []),
    ...(hasTodoTools
      ? [
          "For multi-step work, keep a short task list with TodoWrite. Prefer 3-5 concrete steps and keep at most one item in progress.",
          "When the plan changes materially, update the task list instead of silently drifting.",
        ]
      : []),
    ...(interactive
      ? []
      : ["If requirements are unclear, make the safest reasonable assumption and continue. State the assumption in the final answer."]),
  ];

  return [
    `${ADE_AGENT_PROMPT_OPENING} ${args.cwd}.`,
    "Edit files and run mutating commands only inside this worktree, unless ADE relaunches you in another lane. Reading outside it is fine.",
    ...(runtime
      ? [
          "",
          "## Runtime Environment",
          ...describeRuntime(runtime),
        ]
      : []),
    // The default task (coding work in edit mode) needs no words: every
    // harness ADE hosts already works that way. Only a mode that changes what
    // the agent may do gets a `## Task` section.
    ...(mode !== "coding" || permissionMode !== "edit"
      ? ["", "## Task", describeMode(mode), describePermissionMode(permissionMode)]
      : []),
    "",
    // No generic coding advice here (inspect first, keep edits narrow, verify,
    // narrate briefly): every harness ADE hosts already gives its own, and a
    // second copy only dilutes the lines below, which are ADE's own.
    "## Working in ADE",
    "A status question or a timeout is a checkpoint: answer it, then continue. New instructions replace old ones; stop only when told. Put answers and your summary in your visible reply.",
    ...(toolUseRules.length ? ["", "## Tool Use Rules", ...toolUseRules] : []),
    "",
    buildAdeCliAgentGuidance(adeSkillRoots, {
      nativeSkillListing: args.nativeSkillListing === true,
      // The runtime block already names the subagent route.
      subagentRouteStated: Boolean(runtime),
      computerUseDirectiveIncluded: args.computerUseDirectiveIncluded === true,
    }),
    // The activity line belongs with the Work row line that ends the block above.
    ...(args.sessionActivityGuidance ? [args.sessionActivityGuidance] : []),
    ...(hasWorkflowTools
      ? [
          "",
          "## Workflow Tools",
          "You have workflow tools for managing development lifecycle:",
          ...(hasCreateLane
            ? ["- **createLane**: Create a lane (git worktree + branch) when the user asks for one or the work is unrelated to the current lane."]
            : []),
          ...(hasCreatePr
            ? ["- **createPrFromLane**: Open a GitHub pull request from a lane once its changes are committed and pushed. Open it as a draft only when the user asks or the work is unfinished."]
            : []),
          "",
          "**Workflow:** make the changes, verify with tests and the surface's own `proof` command (`ade browser proof`, `ade app-control proof`, `ade apple proof`), then create the PR and stop. Merge it only when the user says to land it.",
          "**Do not** create infrastructure (CI configs, deployment scripts) or modify settings outside your lane without explicit user approval.",
        ]
      : []),
    ...(hasPrIssueTools
      ? [
          "",
          "## Pull Request Tools",
          `Key PR tools in this session: ${prIssueToolNames.join(", ")}.`,
          "Use these tools first when the task is to address PR comments, review threads, or CI failures.",
          "ADE PR tools are runtime tool calls, not shell commands. Do not probe them with `which`, `command -v`, or local settings files.",
          "Use the exact identifier shown in the live tool list.",
          "If a required PR tool is missing, report the misconfiguration immediately instead of spelunking through local bootstrap code.",
        ]
      : []),
  ].join("\n");
}

export function composeSystemPrompt(basePrompt: string | undefined, harnessPrompt: string): string {
  const base = typeof basePrompt === "string" ? basePrompt.trim() : "";
  if (!base.length) return harnessPrompt;
  return `${harnessPrompt}\n\n## Task-Specific Instructions\n${base}`;
}
