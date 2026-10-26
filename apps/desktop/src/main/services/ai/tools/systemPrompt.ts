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
 * skill (scheduling rules, drafts, MCP sign-in). The drafts-versus-wake rule
 * lives in the shared `## ADE` block, which every one of these prompts carries.
 */
const adeScheduledWorkGuidance = "**Scheduled work:** wake yourself later with `ade chat scheduled-work create --in 12m --prompt \"<task>\" --text` (or `ade actions run chat.createScheduledWork --input-json '{\"delaySeconds\":720,\"prompt\":\"<task>\"}' --text`); it targets your own session, starts a new turn at the next turn boundary and survives brain restarts. Verify the next run time it reports. For `--at`, cron (the brain machine's local time), listing, pausing and cancelling, read **ade-cli-control-plane**.";

const openCodeBackgroundWorkGuidance = "**Background work:** `shell` with `background: true` and background subagents are fine here: ADE shows each job in the chat, keeps the session open while it runs, and you are woken when it ends. They stop if ADE closes this chat's connection to OpenCode (for example on an ADE restart), so for a wait that must survive that, use `ade chat scheduled-work create` instead.";

/**
 * What an agent says when the user asks for an MCP server it does not have.
 * The server list is fixed when the provider process starts, and only the user
 * can sign in, so the agent's job is to point at the two steps, not to try.
 */
const adeMcpServersGuidance = "**MCP servers:** this chat keeps the MCP servers it started with, and you cannot add or sign in to one. Tell the user: **Sign in** on its row in Settings › MCP servers if it asks, then right-click this chat in Work and choose **Restart agent session** (the conversation is kept).";

const adeIndependentChildChatGuidance = "Use an ADE `--type subagent` chat for an independent durable transcript, scheduling, another provider, or tracked lifecycle; it stays in this lane unless the user wants a new one.";

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
  claude: "For short-lived delegation whose result belongs in this Claude thread, prefer Claude's native `Agent`/`Task` tool, using its `model` override when you need another Anthropic-family model. Do not create an ADE `--type subagent` chat in the same lane merely to switch Claude models.",
  codex: "For short-lived delegation whose result belongs in this Codex thread, prefer Codex's native subagent/collaboration tool.",
  cursor: "For short-lived delegation whose result belongs in this Cursor thread, prefer Cursor's native task tool.",
  droid: "For short-lived delegation whose result belongs in this Droid thread, prefer Droid's native worker/subagent capability.",
  copilot: "Copilot's SDK path has no ADE-supported native child-session lifecycle. Use an ADE `--type subagent` chat when you need independent delegation.",
  opencode: "For short-lived delegation whose result belongs in this OpenCode thread, prefer OpenCode's native `task` tool.",
  pi: "Pi's SDK path has no ADE-supported native subagent lifecycle. Use an ADE `--type subagent` chat when you need independent delegation, and keep the child brief self-contained.",
};

export function buildNativeSubagentRoutingGuidance(runtime: AdeRuntimeKind): string {
  const family = nativeSubagentFamilyByRuntime[runtime];
  const nativeGuidance = nativeSubagentGuidanceByFamily[family];
  return `**Subagent routing:** ${nativeGuidance}${family === "pi" ? "" : ` ${adeIndependentChildChatGuidance}`}`;
}

function describeSubagentRouting(runtime: AdeRuntimeKind): string {
  return buildNativeSubagentRoutingGuidance(runtime);
}

function describeRuntime(runtime: AdeRuntimeKind): string[] {
  switch (runtime) {
    case "claude-agent-sdk-query":
      return [
        "**Runtime:** ADE Work chat hosted on the Claude Agent SDK stable `query()` streaming-input API.",
        describeSubagentRouting(runtime),
        "**Wake-ups:** native `ScheduleWakeup`, `CronCreate` and `/loop` are mirrored into ADE's durable scheduler and start a new turn at the next turn boundary, even after a brain restart. Use `sleep` only for short waits inside this turn. `CronList` is advisory (ADE state wins), and `CronCreate` always adds a job, so delete the old one first. Pausing, `ade chat scheduled-work` and drafts: **ade-cli-control-plane**.",
        adeMcpServersGuidance,
      ];
    case "claude-code-cli":
      return [
        "**Runtime:** ADE Work chat wrapping Claude Code CLI as a background subprocess. ADE owns the lane, transcript, lifecycle, and follow-up delivery.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
        adeMcpServersGuidance,
      ];
    case "codex-cli":
      return [
        "**Runtime:** ADE Work chat wrapping the Codex CLI as a subprocess. Your turns are driven through the Codex agent loop, but the host is ADE — slash commands, attachments, and lane scoping come from ADE.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
        adeMcpServersGuidance,
      ];
    case "codex-app-server":
      return [
        "**Runtime:** ADE Work chat hosted on the Codex app-server protocol. Your turns are driven through Codex app-server JSON-RPC, while the host is ADE — slash commands, attachments, and lane scoping come from ADE.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
        adeMcpServersGuidance,
      ];
    case "cursor-sdk":
      return [
        "**Runtime:** ADE Work chat hosted on the Cursor SDK (`@cursor/sdk`).",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
        adeMcpServersGuidance,
      ];
    case "droid-sdk":
      return [
        "**Runtime:** ADE Work chat hosted on the Factory Droid SDK (`@factory/droid-sdk`) and backed by the local Droid CLI.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
        adeMcpServersGuidance,
      ];
    case "copilot-sdk":
      return [
        "**Runtime:** ADE Work chat hosted on the GitHub Copilot SDK and backed by the installed Copilot CLI.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
        adeMcpServersGuidance,
      ];
    case "pi-sdk":
      return [
        "**Runtime:** ADE Work chat hosted on the user's Pi SDK installation. ADE owns the chat transcript and lane boundary; Pi owns its native session file and provider credentials.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "opencode":
      return [
        "**Runtime:** ADE Work chat wrapping an OpenCode session.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
        adeMcpServersGuidance,
        openCodeBackgroundWorkGuidance,
      ];
  }
}

function describePermissionMode(mode: HarnessPermissionMode): string {
  switch (mode) {
    case "plan":
      return "Plan mode. Stay read-only: inspect, analyze, ask clarifying questions, and prepare an implementation plan without editing files or mutating the system.";
    case "full-auto":
      return "Autonomous mode. You may edit and validate proactively, but still prefer the smallest safe change and verify it.";
    default:
      return "Edit mode. You may make focused code changes and run validation, but stay deliberate and avoid unnecessary mutations.";
  }
}

function describeMode(mode: HarnessMode): string {
  switch (mode) {
    case "planning":
      return "You are planning work. Prioritize discovery, constraints, risks, and a concrete execution plan over code changes.";
    case "chat":
      return "You are in an interactive coding chat. Keep the user informed through concise, high-signal progress while you work.";
    default:
      return "You are executing coding work. Move from inspection to edits to verification without stalling.";
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
   * The Project notes block, snapshotted when the session started. Last in
   * the prompt, so a changed note leaves every section above it cached.
   */
  projectNotes?: string | null;
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

  return [
    `${ADE_AGENT_PROMPT_OPENING} ${args.cwd}.`,
    "This session is bound to that worktree for writes and mutations. Read-only inspection outside this path is allowed when needed, but edit files and run mutating commands only inside this path unless ADE explicitly relaunches you in a different lane.",
    ...(runtime
      ? [
          "",
          "## Runtime Environment",
          ...describeRuntime(runtime),
        ]
      : []),
    "",
    "## Task",
    describeMode(mode),
    describePermissionMode(permissionMode),
    "",
    // No generic coding advice here (inspect first, keep edits narrow, verify,
    // narrate briefly): every harness ADE hosts already gives its own, and a
    // second copy only dilutes the lines below, which are ADE's own.
    "## Working in ADE",
    "Treat status checks, interruptions, and tool/subagent timeouts as checkpoints. Give the requested status, then continue the active directive unless the user explicitly says stop, pause, or only report status.",
    "Your thinking is not your reply: the user sees it only as a collapsed thought, if at all. Anything they need to read or act on (answers to their questions, requests for them, and your final summary) must go in your visible reply text, written in full, never only in your thinking.",
    "",
    "## Tool Use Rules",
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
    interactive
      ? "If requirements are genuinely unclear and progress would otherwise stall, ask one concise question with concrete options."
      : "If requirements are unclear, make the safest reasonable assumption and continue. State the assumption in the final answer.",
    "",
    buildAdeCliAgentGuidance(adeSkillRoots),
    ...(args.sessionActivityGuidance ? ["", args.sessionActivityGuidance] : []),
    ...(hasWorkflowTools
      ? [
          "",
          "## Workflow Tools",
          "You have workflow tools for managing development lifecycle:",
          ...(hasCreateLane
            ? ["- **createLane**: Create an isolated development lane (git worktree + branch) before starting work. Use this to keep changes separate from the main branch."]
            : []),
          ...(hasCreatePr
            ? ["- **createPrFromLane**: Open a GitHub pull request from a lane. Use this when your changes are committed and pushed. Prefer draft PRs for work-in-progress."]
            : []),
          "",
          "**Recommended workflow:** Create a lane, make changes, verify with tests and `ade proof capture --caption \"…\"`, then create a PR.",
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
    ...(args.projectNotes?.trim() ? ["", args.projectNotes.trim()] : []),
  ].join("\n");
}

export function composeSystemPrompt(basePrompt: string | undefined, harnessPrompt: string): string {
  const base = typeof basePrompt === "string" ? basePrompt.trim() : "";
  if (!base.length) return harnessPrompt;
  return `${harnessPrompt}\n\n## Task-Specific Instructions\n${base}`;
}
