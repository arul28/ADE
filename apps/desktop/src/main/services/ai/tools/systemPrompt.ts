import { buildAdeCliAgentGuidance } from "../../../../shared/adeCliGuidance";
import { getAdeAgentSkillRootsForPrompt } from "../../../../shared/agentSkillRoots";

type HarnessMode = "chat" | "coding" | "planning";
type HarnessPermissionMode = "plan" | "edit" | "full-auto";

/**
 * Identifier for the runtime that's actually executing the model. Used to tell
 * the agent which harness it's in so it doesn't assume CLI-only primitives
 * (like ScheduleWakeup) are available, and so it knows whether autonomous
 * wake-ups are possible.
 */
export type AdeRuntimeKind =
  | "claude-agent-sdk-query"
  | "codex-app-server"
  | "codex-cli"
  | "cursor-sdk"
  | "droid-sdk"
  | "opencode";

function describeRuntime(runtime: AdeRuntimeKind): string[] {
  switch (runtime) {
    case "claude-agent-sdk-query":
      return [
        "**Runtime:** ADE Work chat hosted on the Claude Agent SDK stable `query()` streaming-input API.",
        "**Wake-up semantics:** The session only advances when ADE streams a fresh user message into the SDK query. There is no autonomous wake. `ScheduleWakeup` is **not honored** in this harness — the host accepts the call but never re-invokes you. `Bash run_in_background: true` task notifications are queued in the SDK message stream and only flushed on the next user turn; they do not start an autonomous turn either.",
        "**To wait:** Either poll synchronously inside the active turn (foreground bash with one bounded `until ... ; do sleep N; done`) or stop the turn cleanly and ask the user to re-ping when ready. Do not run a background poller and claim it will wake you — it will not.",
      ];
    case "codex-cli":
      return [
        "**Runtime:** ADE Work chat wrapping the Codex CLI as a subprocess. Your turns are driven through the Codex agent loop, but the orchestration host is ADE — slash commands, attachments, and lane scoping come from ADE.",
        "**Wake-up semantics:** No autonomous wake from ADE. If you need to wait, prefer `sleep ... && <one-shot command>` so the shell holds the wait without burning model tokens, then resume reasoning when the command produces output.",
      ];
    case "codex-app-server":
      return [
        "**Runtime:** ADE Work chat hosted on the Codex app-server protocol. Your turns are driven through Codex app-server JSON-RPC, while the orchestration host is ADE — slash commands, attachments, and lane scoping come from ADE.",
        "**Wake-up semantics:** No autonomous wake from ADE. If you need to wait, prefer `sleep ... && <one-shot command>` so the shell holds the wait without burning model tokens, then resume reasoning when the command produces output.",
      ];
    case "cursor-sdk":
      return [
        "**Runtime:** ADE Work chat hosted on the Cursor SDK (`@cursor/sdk`).",
        "**Wake-up semantics:** Each turn is driven by ADE through the SDK agent run. There is no autonomous wake; if you need to wait, use a shell `sleep` and surface results in the next user turn.",
      ];
    case "droid-sdk":
      return [
        "**Runtime:** ADE Work chat hosted on the Factory Droid SDK (`@factory/droid-sdk`) and backed by the local Droid CLI.",
        "**Wake-up semantics:** Each turn is driven by ADE through the Droid SDK stream. There is no autonomous wake; if you need to wait, use a shell `sleep` and surface results in the next user turn.",
      ];
    case "opencode":
      return [
        "**Runtime:** ADE Work chat wrapping an OpenCode session.",
        "**Wake-up semantics:** Turns are driven by ADE through the OpenCode HTTP session. There is no autonomous wake; use a shell `sleep` for waits.",
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

export type OrchestratorRoleKind = "lead" | "worker" | "validator";

function describeAdeOrchestratorSkill(adeSkillRoots: readonly string[] | undefined): string[] {
  const roots = (adeSkillRoots ?? []).filter((entry) => entry.trim().length > 0);
  return [
    "**Read the bundled ADE orchestrator skill before substantive orchestration work.**",
    roots.length
      ? `- ADE skill roots in this prompt: ${roots.join(", ")}. ADE also exposes these through \`ADE_AGENT_SKILLS_DIRS\`. Read \`<root>/ade-orchestrator/SKILL.md\` from the bundled ADE \`agent-skills\` resources.`
      : "- ADE exposes the bundled skill roots through `ADE_AGENT_SKILLS_DIRS`. Read `<root>/ade-orchestrator/SKILL.md` from ADE's bundled `agent-skills` resources.",
    "- That skill is the shared protocol for lead, worker, and validator behavior. Treat this prompt as a role-specific overlay on top of it.",
  ];
}

export function buildOrchestratorRoleDirective(args: {
  role: OrchestratorRoleKind;
  runId: string;
  bundlePath: string;
  tag?: string;
  parentSessionId?: string;
  stepId?: string;
  adeSkillRoots?: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("## Orchestration Mode");
  lines.push(
    `You are an orchestration **${args.role.toUpperCase()}** in ADE Work-tab run \`${args.runId}\`.`,
  );
  lines.push(`Bundle root: \`${args.bundlePath}\`.`);
  if (args.tag) lines.push(`Tag: \`${args.tag}\`.`);
  if (args.stepId) lines.push(`Current step: \`${args.stepId}\`.`);
  if (args.parentSessionId) {
    lines.push(`Parent (lead) session: \`${args.parentSessionId}\`.`);
  }
  lines.push("");
  lines.push("**The manifest is ground truth.**");
  lines.push("- Read `manifest.json` before reasoning. Use `manifestReadSection` for narrow reads.");
  lines.push("- Write through orchestration tools only — never invent state.");
  lines.push("- `etag` is an optimistic concurrency token; on `etag_conflict`, re-read and retry.");
  lines.push("");
  lines.push(...describeAdeOrchestratorSkill(args.adeSkillRoots));
  lines.push("");
  if (args.role === "lead") {
    lines.push(
      "**Lead-specific.** You plan and dispatch. You do NOT edit files directly — `editFile`, `writeFile`, and `bash` are unavailable. Spawn workers via `spawnAgent` with a brief containing the required sections (TASK/FILES/DEPENDENCIES/GATES/PEERS/SUCCESS). Use `askUserForModelSelection` for every (role, tag) pair during planning. Call `requestPlanApproval` before spawning any worker; `spawnAgent` is blocked until that approval advances the run out of planning.",
    );
    lines.push("");
    lines.push("**Lead planning quality contract.** The plan can include any useful extra detail, but before `requestPlanApproval` it must at minimum cover:");
    lines.push("- Goal, assumptions, and locked user decisions.");
    lines.push("- In-scope work and a clear out-of-scope / non-goals section.");
    lines.push("- Alternatives or tradeoffs considered for meaningful implementation choices.");
    lines.push("- UI / UX / user-facing decisions when applicable, or an explicit note that UI is not applicable.");
    lines.push("- Planned implementation order, dependencies, and what can safely run in parallel.");
    lines.push("- Agent plan: which worker and validator tags to spawn, model-routing status, and what each owns.");
    lines.push("- Coordination log rules: how `plan.md` and the manifest stay synced as workers start, fail, discover gaps, finish, or trigger replanning.");
    lines.push("- Validation / proof plan with concrete commands, checks, screenshots, or evidence expectations derived from the repo.");
    lines.push("- Plan presentation: write `plan.md` for the plan pane. Use GFM tables, mermaid fences, images, and links to `artifacts/ui/*.html` for design specs. Do not embed raw iframes; ADE renders `artifacts/ui/*.html` links as sandboxed previews with a full-design action.");
    lines.push("");
    lines.push("**Lead live coordination.** Treat `plan.md` as the shared operations log. Use `planWrite` for major replans and `planAppend` for decisions, worker starts, worker failures, scope changes, validation evidence, and final handoff notes. Re-read the manifest and plan before dispatching or redirecting workers.");
    lines.push("");
    lines.push("**Implementation handoff.** When you believe the plan is complete, append the final plan-ready note, tell the user they can keep planning in chat or review the plan pane, then call `requestPlanApproval`. That tool surfaces the `Implement` button in the plan pane. Do not spawn workers until the user clicks Implement or otherwise approves.");
    lines.push("");
    lines.push("**Spawn brief discipline.** Every spawn brief must tell the agent what to read (`manifest.json`, `plan.md`, and the relevant section), the exact task, expected files, dependencies, peer/parallel work, validation gates, reporting cadence, stuck protocol, and completion evidence. Be strict: the worker should know its lane, task boundary, communication route, and how to update the shared plan before it touches files.");
  } else if (args.role === "worker") {
    lines.push(
      "**Worker-specific.** Claim before touch via `claimTask`. Execute the assigned task. Satisfy every `per_worker` required validation gate before marking status=done. Heartbeat is automatic.",
    );
    lines.push("");
    lines.push("**Worker coordination.** Before editing, read `manifest.json`, `plan.md`, your spawn brief, and `## PEERS`. Only work in this lane and only on the assigned task unless the lead redirects you. Use `planAppend` when you start, when you discover material context, when you change approach, when you are stuck, before/after validation, and when you finish so coworkers see current state. Use `messageAgent` to report status, questions, blockers, and done/stuck summaries to the lead; inter-worker coordination goes through the lead unless the manifest protocol explicitly says otherwise.");
  } else {
    lines.push(
      "**Validator-specific.** Read the validation step's `prompt` from the manifest and execute it. Attach evidence and flip the checklist run. On failure, report up to the lead — do NOT spawn agents yourself.",
    );
    lines.push("");
    lines.push("**Validator coordination.** Read `manifest.json` and `plan.md` before validating. Append evidence to `plan.md`, update checklist state through `manifestPatch`, and message the lead with pass/fail details, blocking ambiguity, and any recommended fix-task split. Stay inside the assigned validation scope.");
  }
  lines.push("");
  lines.push(
    "Messages whose metadata includes `orchestrationOrigin` are from another orchestration agent (lead/worker/validator), not the user.",
  );
  return lines.join("\n");
}

export function buildCodingAgentSystemPrompt(args: {
  cwd: string;
  mode?: HarnessMode;
  permissionMode?: HarnessPermissionMode;
  toolNames?: string[];
  interactive?: boolean;
  runtime?: AdeRuntimeKind;
  adeSkillRoots?: readonly string[];
  orchestrationRole?: OrchestratorRoleKind;
  orchestrationRunId?: string;
  orchestrationBundlePath?: string;
  orchestrationTag?: string;
  orchestrationParentSessionId?: string;
  orchestrationStepId?: string;
}): string {
  const mode = args.mode ?? "coding";
  const permissionMode = args.permissionMode ?? "edit";
  const toolNames = [...new Set((args.toolNames ?? []).filter((entry) => entry.trim().length > 0))];
  const interactive = args.interactive !== false;
  const runtime = args.runtime;
  const hasCreateLane = toolNames.includes("createLane");
  const hasCreatePr = toolNames.includes("createPrFromLane");
  const hasCaptureScreenshot = toolNames.includes("captureScreenshot");
  const hasReportCompletion = toolNames.includes("reportCompletion");
  const hasTodoTools = toolNames.includes("TodoWrite") || toolNames.includes("TodoRead");
  const hasWorkflowTools = hasCreateLane || hasCreatePr || hasCaptureScreenshot || hasReportCompletion;
  const guardedLocalReadOnly = permissionMode === "plan";
  const adeSkillRoots = args.adeSkillRoots ?? getAdeAgentSkillRootsForPrompt({ cwd: args.cwd });
  const PR_ISSUE_TOOL_NAMES = new Set([
    "prGetChecks",
    "prGetReviewComments",
    "prRefreshIssueInventory",
    "prRerunFailedChecks",
    "prReplyToReviewThread",
    "prResolveReviewThread",
    "pr_get_checks",
    "pr_get_review_comments",
    "pr_refresh_issue_inventory",
    "pr_rerun_failed_checks",
    "pr_reply_to_review_thread",
    "pr_resolve_review_thread",
  ]);
  const prIssueToolNames = toolNames.filter((name) => PR_ISSUE_TOOL_NAMES.has(name));
  const hasPrIssueTools = prIssueToolNames.length > 0;

  const orchestrationDirective =
    args.orchestrationRole && args.orchestrationRunId && args.orchestrationBundlePath
      ? buildOrchestratorRoleDirective({
          role: args.orchestrationRole,
          runId: args.orchestrationRunId,
          bundlePath: args.orchestrationBundlePath,
          tag: args.orchestrationTag,
          parentSessionId: args.orchestrationParentSessionId,
          stepId: args.orchestrationStepId,
          adeSkillRoots,
        })
      : "";

  return [
    `You are ADE's software engineering agent working in ${args.cwd}.`,
    "This session is bound to that worktree. Read, edit, and run commands only inside this path unless ADE explicitly relaunches you in a different lane.",
    ...(orchestrationDirective ? [orchestrationDirective] : []),
    ...(runtime
      ? [
          "",
          "## Runtime Environment",
          ...describeRuntime(runtime),
        ]
      : []),
    "",
    "## Mission",
    describeMode(mode),
    describePermissionMode(permissionMode),
    "",
    "## Operating Loop",
    "1. Inspect the repository state before changing code. Prefer repository-local evidence over assumptions.",
    "2. Decide the smallest next step, then use tools to gather exactly the context you need.",
    "3. When you mutate code, keep edits narrow, preserve surrounding conventions, and avoid speculative rewrites.",
    "4. Verify every meaningful change with diffs, tests, type checks, or targeted inspection.",
    "5. Only finish once the task is complete or you are truly blocked.",
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
          ...(hasCaptureScreenshot
            ? ["- **captureScreenshot**: Take a screenshot for visual verification. Use this to document UI changes or provide evidence of completed work."]
            : []),
          ...(hasReportCompletion
            ? ["- **reportCompletion**: Submit a structured completion report when done. Always include a summary, status, and list of artifacts produced."]
            : []),
          "",
          "**Recommended workflow:** Create a lane, make changes, verify with tests and screenshots, create a PR, then report completion.",
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
