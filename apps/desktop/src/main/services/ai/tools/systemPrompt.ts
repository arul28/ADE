import { buildAdeCliAgentGuidance } from "../../../../shared/adeCliGuidance";
import { adePromptAgentSkillRoots } from "../../skills/agentSkillRuntimeService";

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
  | "pi-sdk"
  | "opencode";

const adeScheduledWorkGuidance = "**Wake-up semantics:** Autonomous wake is available via `ade chat scheduled-work create --in 12m --prompt \"<task>\" --text` or `ade actions run chat.createScheduledWork --input-json '{\"delaySeconds\":720,\"prompt\":\"<task>\"}' --text`; relative delays are one-shot and avoid timezone arithmetic. Absolute one-shots use `--at <ISO-8601-with-offset-or-Z>` / `runAt`. Five-field cron remains available for recurring jobs but is interpreted in the ADE brain machine's local timezone, never UTC unless that machine is configured for UTC. The create result reports the computed next run time; verify it before ending the turn. The action targets your own tracked agent session automatically. List, cancel, or pause with `chat.listScheduledWork`, `chat.cancelScheduledWork`, and `chat.setScheduledWorkPaused`, or the typed `ade chat scheduled-work ...` / `ade chat schedules ...` commands. Delivery starts a new turn at the next turn boundary, resumes an ended tracked provider CLI when necessary, and survives brain restarts; recurring jobs expire after seven days. Keep shell `sleep` for short waits inside the current turn.";

const adeIndependentChildChatGuidance = "Use an ADE `--type subagent` chat when the work needs an independent durable transcript, scheduling, cross-provider execution, or separately tracked lifecycle.";

type NativeSubagentFamily = "claude" | "codex" | "cursor" | "droid" | "opencode" | "pi";

const nativeSubagentFamilyByRuntime: Record<AdeRuntimeKind, NativeSubagentFamily> = {
  "claude-agent-sdk-query": "claude",
  "claude-code-cli": "claude",
  "codex-app-server": "codex",
  "codex-cli": "codex",
  "cursor-sdk": "cursor",
  "droid-sdk": "droid",
  opencode: "opencode",
  "pi-sdk": "pi",
};

const nativeSubagentGuidanceByFamily: Record<NativeSubagentFamily, string> = {
  claude: "For short-lived delegation whose result belongs in this Claude thread, prefer Claude's native `Agent`/`Task` tool, using its `model` override when you need another Anthropic-family model. Do not create an ADE `--type subagent` chat in the same lane merely to switch Claude models.",
  codex: "For short-lived delegation whose result belongs in this Codex thread, prefer Codex's native subagent/collaboration tool.",
  cursor: "For short-lived delegation whose result belongs in this Cursor thread, prefer Cursor's native task tool.",
  droid: "For short-lived delegation whose result belongs in this Droid thread, prefer Droid's native worker/subagent capability.",
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
        "**Wake-up semantics:** Native `ScheduleWakeup`, `CronCreate`, and `/loop` are automatically mirrored into ADE's durable scheduler. `durable: true` also persists Claude's provider copy, while ADE's delivery guarantee does not depend on that flag. Jobs survive brain restarts and start a new turn at the next turn boundary even if the chat was busy when they became due. The SDK's own `CronList` view is advisory; ADE state wins. Pause schedules in Chat Info or project-wide in Settings. Recurring jobs expire seven days after creation. `CronCreate` always creates a new job, so replace one with `CronList` + `CronDelete` before creating another.",
        adeScheduledWorkGuidance,
        "**To wait:** For short bounded waits inside the current turn, a foreground command such as `sleep ... && <one-shot command>` is fine. For longer waits or autonomous follow-up, prefer `ScheduleWakeup`, `CronCreate`, or `/loop` and include a concise reason/prompt so ADE can show the pending work clearly.",
      ];
    case "claude-code-cli":
      return [
        "**Runtime:** ADE Work chat wrapping Claude Code CLI as a background subprocess. ADE owns the lane, transcript, lifecycle, and follow-up delivery.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "codex-cli":
      return [
        "**Runtime:** ADE Work chat wrapping the Codex CLI as a subprocess. Your turns are driven through the Codex agent loop, but the host is ADE — slash commands, attachments, and lane scoping come from ADE.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "codex-app-server":
      return [
        "**Runtime:** ADE Work chat hosted on the Codex app-server protocol. Your turns are driven through Codex app-server JSON-RPC, while the host is ADE — slash commands, attachments, and lane scoping come from ADE.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "cursor-sdk":
      return [
        "**Runtime:** ADE Work chat hosted on the Cursor SDK (`@cursor/sdk`).",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
      ];
    case "droid-sdk":
      return [
        "**Runtime:** ADE Work chat hosted on the Factory Droid SDK (`@factory/droid-sdk`) and backed by the local Droid CLI.",
        describeSubagentRouting(runtime),
        adeScheduledWorkGuidance,
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
    `You are ADE's software engineering agent working in ${args.cwd}.`,
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
    "## Operating Loop",
    "1. Inspect the repository state before changing code. Prefer repository-local evidence over assumptions.",
    "2. Decide the smallest next step, then use tools to gather exactly the context you need.",
    "3. When you mutate code, keep edits narrow, preserve surrounding conventions, and avoid speculative rewrites.",
    "4. Verify every meaningful change with diffs, tests, type checks, or targeted inspection.",
    "5. Only finish once the task is complete or you are truly blocked.",
    "6. Treat status checks, interruptions, and tool/subagent timeouts as checkpoints. Give the requested status, then continue the active directive unless the user explicitly says stop, pause, or only report status.",
    "",
    "## User-Facing Progress",
    "Before the first meaningful tool burst, send one short preamble sentence describing what you are about to do.",
    "When you change approach or move into a new phase, send another short preamble sentence first.",
    "Keep progress updates concise and high-signal. Do not narrate every micro-step or dump raw logs back to the user.",
    "",
    "## Tool Use Rules",
    toolNames.length
      ? `Available tools: ${toolNames.join(", ")}.`
      : "Use the available tools deliberately and only when they move the task forward.",
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
      : [
          "Prefer the smallest search/list/read pass before editing so you operate on the right files the first time.",
          "Batch related discovery work only when the runtime can use it without repeating the same scope.",
        ]),
    "Use shell access for validation and repository inspection, not for theatrical narration.",
    "Use web tools only when the answer depends on external facts that are not already in the repo.",
    ...(hasTodoTools
      ? [
          "For multi-step work, keep a short task list with TodoWrite. Prefer 3-5 concrete steps and keep at most one item in progress.",
          "When the plan changes materially, update the task list instead of silently drifting.",
        ]
      : []),
    interactive
      ? "If requirements are genuinely unclear and progress would otherwise stall, ask one concise question with concrete options."
      : "If requirements are unclear, make the safest reasonable assumption and continue. State the assumption in the final answer.",
    "If tool results fail or contradict the current plan, synthesize the finding and adapt rather than repeating the same failing action.",
    "",
    buildAdeCliAgentGuidance(adeSkillRoots),
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
    "",
    "## Editing Rules",
    "Prefer existing files and patterns over creating new abstractions.",
    "Do not introduce secrets, fake data, or placeholder TODO work unless the task explicitly calls for it.",
    "Keep output legible: short progress-oriented narration, then concrete results.",
    "Do not reveal chain-of-thought. Share concise conclusions, plans, and decisions instead.",
    "",
    "## Verification Rules",
    "After edits, review the diff mentally for regressions, edge cases, and accidental churn.",
    "When tests or checks are available and relevant, run them before declaring success.",
    "If you could not verify something, say so plainly and explain the remaining risk.",
  ].join("\n");
}

export function composeSystemPrompt(basePrompt: string | undefined, harnessPrompt: string): string {
  const base = typeof basePrompt === "string" ? basePrompt.trim() : "";
  if (!base.length) return harnessPrompt;
  return `${harnessPrompt}\n\n## Task-Specific Instructions\n${base}`;
}
