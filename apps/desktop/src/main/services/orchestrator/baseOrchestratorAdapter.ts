import type {
  OrchestratorExecutorAdapter,
  OrchestratorExecutorStartArgs,
  OrchestratorExecutorStartResult
} from "./orchestratorService";
import type { OrchestratorWorkerRole, OrchestratorStep, OrchestratorExecutorKind, TerminalToolType, TeamRuntimeConfig } from "../../../shared/types";
import type { createMemoryService } from "../memory/memoryService";
import { DEFAULT_CONTEXT_VIEW_POLICIES, SLASH_COMMAND_TRANSLATIONS } from "./orchestratorConstants";

// ─────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────

export function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellInlineDecodedArg(value: string): string {
  return `"$(node -e 'process.stdout.write(JSON.parse(process.argv[1]))' ${shellEscapeArg(JSON.stringify(value))})"`;
}

export function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function buildCompactPlanView(currentStep: OrchestratorStep, allSteps: OrchestratorStep[]): string {
  if (!allSteps.length) return "";
  const stepIdToKey = new Map(allSteps.map((s) => [s.id, s.stepKey]));
  const sorted = [...allSteps].sort((a, b) => a.stepIndex - b.stepIndex);
  const lines: string[] = ["Mission Plan:"];
  for (const s of sorted) {
    const isCurrentStep = s.id === currentStep.id;
    let prefix: string;
    switch (s.status) {
      case "succeeded":
        prefix = "  [done]";
        break;
      case "failed":
        prefix = "  [FAILED]";
        break;
      case "canceled":
        prefix = "  [canceled]";
        break;
      case "running":
        prefix = isCurrentStep ? "  >>> [running/YOU]" : "  + [running]";
        break;
      case "blocked":
        prefix = "  ! [blocked]";
        break;
      case "ready":
        prefix = "  * [ready]";
        break;
      default:
        prefix = "  -> [pending]";
        break;
    }
    let line = `${prefix} ${s.stepKey}`;
    if (s.status === "running" && !isCurrentStep) {
      line += "  (parallel)";
    }
    if (s.dependencyStepIds.length > 0) {
      const depKeys = s.dependencyStepIds
        .map((depId) => stepIdToKey.get(depId) ?? depId.slice(0, 8))
        .join(", ");
      line += ` (depends on: ${depKeys})`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// Adapter configuration
// ─────────────────────────────────────────────────────

export interface BaseAdapterConfig {
  /** Executor kind identifier, e.g. "claude" or "codex". */
  executorKind: OrchestratorExecutorKind;
  /** Session type for tracked sessions, e.g. "claude-orchestrated". */
  sessionType: TerminalToolType;
  /** Build the startup command for a startup-command-override case. */
  buildOverrideCommand: (args: { prompt: string }) => string;
  /** Build the full startup command from the assembled prompt + resolved config. */
  buildStartupCommand: (args: {
    prompt: string;
    model: string;
    step: OrchestratorStep;
    run: import("../../../shared/types").OrchestratorRun;
    attempt: import("../../../shared/types").OrchestratorAttempt;
    permissionConfig: OrchestratorExecutorStartArgs["permissionConfig"];
    teamRuntime?: TeamRuntimeConfig;
  }) => string;
  /** Build adapter-specific metadata to include in the accepted result. */
  buildAcceptedMetadata: (args: {
    model: string;
    step: OrchestratorStep;
    permissionConfig: OrchestratorExecutorStartArgs["permissionConfig"];
    filePatterns: string[];
    steeringDirectiveCount: number;
    promptLength: number;
    reasoningEffort: string | undefined;
    startupCommandPreview: string;
  }) => Record<string, unknown>;
}

// ─────────────────────────────────────────────────────
// Shared prompt assembly
// ─────────────────────────────────────────────────────

/**
 * Builds the full prompt (system parts + user parts) from the executor start args.
 * This is the shared logic extracted from both Claude and Codex adapters.
 */
export function buildFullPrompt(
  args: OrchestratorExecutorStartArgs,
  _executorKind?: OrchestratorExecutorKind,
  opts?: {
    memoryService?: ReturnType<typeof createMemoryService>;
    projectId?: string;
    workerRuntime?: "tracked_session" | "in_process";
    memoryBriefing?: OrchestratorExecutorStartArgs["memoryBriefing"];
  }
): {
  prompt: string;
  filePatterns: string[];
  steeringDirectiveCount: number;
} {
  const { run, step } = args;
  const workerRuntime = opts?.workerRuntime ?? "tracked_session";
  const hasMissionTooling = workerRuntime === "tracked_session";

  // 1. Build system prompt
  const systemParts: string[] = [];

  const missionGoal =
    typeof run.metadata?.missionGoal === "string" ? run.metadata.missionGoal.trim() : "";
  if (missionGoal) {
    systemParts.push(`Mission goal: ${missionGoal}`);
  }

  systemParts.push(`You are an ADE orchestrator worker executing step "${step.title}".`);

  // A. Identity block
  {
    const role = typeof step.metadata?.role === "string" ? step.metadata.role : step.stepKey;
    const laneLabel = step.laneId ?? "unassigned";
    systemParts.push(
      [
        `Role: ${role}`,
        `Step: "${step.title}" (key: ${step.stepKey})`,
        `Mission: ${missionGoal || "(no goal)"} (mission: ${run.missionId}, run: ${run.id})`,
        `Lane: ${laneLabel}`
      ].join("\n")
    );
  }

  // A½. Worktree isolation constraint
  {
    const laneWorktreePath = typeof step.metadata?.laneWorktreePath === "string"
      ? step.metadata.laneWorktreePath.trim()
      : "";
    if (laneWorktreePath.length > 0) {
      systemParts.push(
        `WORKTREE ISOLATION: You are working in: ${laneWorktreePath}. All file edits MUST be made within this path. Do not read or write files outside this worktree directory.`
      );
    }
  }

  // B. Propulsion principle
  systemParts.push(
    "EXECUTION PROTOCOL: Execute immediately. Do not ask for confirmation or propose a plan and wait for approval. Do not summarize your instructions back. If you encounter a blocker you cannot work around, fail with a clear error message describing the blocker. Make the best decision you can and document your reasoning. The only time you should pause for human input is immediately after opening a blocking ask_user intervention that your phase policy explicitly allows."
  );

  // C. Compact plan view
  {
    const planView = buildCompactPlanView(step, args.allSteps);
    if (planView) {
      systemParts.push(planView);
    }
  }

  systemParts.push(
    [
      "Work style:",
      "- If you discover information relevant to other steps (API changes, schema updates, config requirements), include it in your output summary.",
      "- If you hit a blocker you can work around safely, work around it and note what you did.",
      "- Structure your output: lead with what you accomplished, then what you changed, then risks or notes for downstream steps.",
      "- If your step depends on upstream work, check the handoff context before starting — don't redo completed work."
    ].join("\n")
  );

  // Communication style for team-like updates
  systemParts.push(
    [
      "COMMUNICATION STYLE:",
      "You are part of a team. When you make progress, share brief updates in natural, casual English.",
      "Write like a teammate in a Slack channel — short blurbs, not formal reports.",
      "Examples of good updates:",
      '- "looking at the existing code first to understand the patterns"',
      '- "implementing the auth middleware now, using JWT approach"',
      '- "tests passing, moving on to the edge cases"',
      '- "hit an issue with the import path, working around it"',
      '- "done — changed 3 files, all tests green"',
      "DO NOT dump full file contents, raw errors, or tool output into your updates.",
      "Keep each update to 1-2 sentences max."
    ].join("\n")
  );

  const instructions =
    typeof step.metadata?.instructions === "string" ? step.metadata.instructions.trim() : "";
  if (instructions) {
    systemParts.push(`Step instructions:\n${instructions}`);
  }

  // Phase-level instructions from the phase card (supplements step instructions)
  const phaseInstructions =
    typeof step.metadata?.phaseInstructions === "string" ? step.metadata.phaseInstructions.trim() : "";
  if (phaseInstructions && phaseInstructions !== instructions) {
    systemParts.push(`Phase-level guidance:\n${phaseInstructions}`);
  }

  const requiresPlanApproval =
    step.metadata?.requiresPlanApproval === true || step.metadata?.coordinationPattern === "plan_then_implement";
  const readOnlyExecution = step.metadata?.readOnlyExecution === true || requiresPlanApproval;
  const phaseAskQuestionsRaw =
    step.metadata?.phaseAskQuestions && typeof step.metadata.phaseAskQuestions === "object" && !Array.isArray(step.metadata.phaseAskQuestions)
      ? step.metadata.phaseAskQuestions as Record<string, unknown>
      : null;
  const phaseAllowsQuestions = phaseAskQuestionsRaw?.enabled === true;
  const phaseMaxQuestionsRaw = Number(phaseAskQuestionsRaw?.maxQuestions ?? Number.NaN);
  const phaseMaxQuestions = Number.isFinite(phaseMaxQuestionsRaw)
    ? Math.max(1, Math.min(10, Math.floor(phaseMaxQuestionsRaw)))
    : null;
  const phaseLabel =
    typeof step.metadata?.phaseName === "string" && step.metadata.phaseName.trim().length > 0
      ? step.metadata.phaseName.trim()
      : typeof step.metadata?.phaseKey === "string" && step.metadata.phaseKey.trim().length > 0
        ? step.metadata.phaseKey.trim()
        : "this";
  if (readOnlyExecution) {
    systemParts.push(
      "IMPORTANT: This step is READ-ONLY. Do NOT modify files, stage changes, or run write operations. Research, review, and return findings or a plan only."
    );
  }

  systemParts.push(
    phaseAllowsQuestions
      ? [
          `PHASE QUESTION POLICY (${phaseLabel.toUpperCase()}):`,
          "- You own clarification for this phase while this step is active.",
          "- If you truly need clarification, use `ask_user` yourself rather than asking the coordinator to ask on your behalf.",
          `- If you open a question, bundle related points into one intervention${phaseMaxQuestions ? ` and keep the total rounds for this step within ${phaseMaxQuestions}` : ""}.`,
          "- After opening a blocking question, stop and wait. Do not continue execution, speculate in the transcript, or ask for the same input twice.",
        ].join("\n")
      : [
          `PHASE QUESTION POLICY (${phaseLabel.toUpperCase()}):`,
          "- Ask Questions is disabled for this phase.",
          "- Do not use `ask_user` here unless the runtime itself opens a separate intervention for delivery or policy recovery.",
          "- Proceed with the best grounded assumption you can and document it in your result.",
        ].join("\n")
  );

  // Planning-specific instructions for planning steps
  {
    const stepType = typeof step.metadata?.stepType === "string" ? step.metadata.stepType.trim().toLowerCase() : "";
    const isPlanningStep = stepType === "planning" || stepType === "analysis";
    if (isPlanningStep) {
      systemParts.push(
        [
          "PLANNING ARTIFACTS:",
          "- This planning step is inspect-only. Do not create directories or write plan files yourself.",
          "- Do NOT use ExitPlanMode or any provider-native plan approval flow. Return your plan directly via `report_result`.",
          "- Your `report_result` payload must include a first-class `plan` object with markdown content plus summary metadata.",
          "- ADE will persist the canonical mission plan artifact after you complete successfully.",
          "- If you need clarification from the user and phase policy allows it, use `ask_user` to surface structured questions yourself.",
        ].join("\n")
      );
    }
  }

  {
    const phaseValidation = step.metadata?.phaseValidation;
    const evidenceRequirements = phaseValidation && typeof phaseValidation === "object" && !Array.isArray(phaseValidation) && Array.isArray((phaseValidation as Record<string, unknown>).evidenceRequirements)
      ? ((phaseValidation as Record<string, unknown>).evidenceRequirements as unknown[])
          .map((entry) => typeof entry === "string" ? entry.trim() : "")
          .filter(Boolean)
      : [];
    const hardProofRequirements = evidenceRequirements.filter((entry) =>
      entry === "screenshot"
      || entry === "browser_verification"
      || entry === "browser_trace"
      || entry === "video_recording"
      || entry === "console_logs"
    );
    if (hardProofRequirements.length > 0 && hasMissionTooling) {
      systemParts.push(
        [
          "PROOF CAPTURE:",
          `- This step requires proof artifacts: ${hardProofRequirements.join(", ")}.`,
          "- Prefer external computer-use backends first. Use `get_computer_use_backend_status` to see what ADE can ingest and prefer approved external tools such as `ext.*` backends or external CLIs like agent-browser when available.",
          "- After an external backend produces proof, call `ingest_computer_use_artifacts` so ADE can normalize, store, link, and publish the resulting evidence.",
          "- Use ADE-local tools (`get_environment_info`, `launch_app`, `interact_gui`, `screenshot_environment`, `record_environment`) only as fallback compatibility support when an external backend is not available for the step.",
          "- Do not assume ADE inferred proof automatically. Register or attach the resulting artifact URIs explicitly.",
        ].join("\n")
      );
    }
  }

  systemParts.push(
    hasMissionTooling
      ? [
          "RESULT REPORTING:",
          "- Use `report_status` for short progress updates when you make meaningful progress or hit a blocker.",
          "- Before you exit, ALWAYS call `report_result` with your outcome, summary, filesChanged, and testsRun fields filled in as accurately as possible.",
          "- Planning steps must also include `plan.markdown` in `report_result`.",
          ...(readOnlyExecution
            ? [
                "- This step cannot write files. Do NOT attempt `.ade/checkpoints/...` or `.ade/step-output-...md` writes.",
                "- Put your findings, plan, warnings, and suggested next steps into `report_result` instead."
              ]
            : [
                "- After calling `report_result`, also write the checkpoint and step-output files described below."
              ])
        ].join("\n")
      : [
          "RESULT REPORTING:",
          "- This worker is running in-process. You do NOT have ADE mission-control tools such as `report_status`, `report_result`, `get_pending_messages`, or `get_run_graph`.",
          "- Return your outcome directly in the final assistant response.",
          "- Format the final response with these headings when relevant: Accomplished, Changed Files, Tests Run, Risks / Notes.",
          ...(readOnlyExecution
            ? [
                "- This step is read-only. Do not claim any file changes unless you actually made them."
              ]
            : [])
        ].join("\n")
  );

  const steeringDirectives = Array.isArray(step.metadata?.steeringDirectives)
    ? (step.metadata.steeringDirectives as unknown[])
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const record = entry as Record<string, unknown>;
          const directive = typeof record.directive === "string" ? compactText(record.directive, 240) : "";
          if (!directive.length) return null;
          const priorityRaw = typeof record.priority === "string" ? record.priority.trim() : "";
          const priority = priorityRaw === "instruction" || priorityRaw === "override" ? priorityRaw : "suggestion";
          const targetStepKey = typeof record.targetStepKey === "string" ? record.targetStepKey.trim() : "";
          return {
            directive,
            priority,
            targetStepKey
          };
        })
        .filter((entry): entry is { directive: string; priority: "suggestion" | "instruction" | "override"; targetStepKey: string } => Boolean(entry))
    : [];
  if (steeringDirectives.length > 0) {
    const recentSteering = steeringDirectives.slice(-6);
    systemParts.push(
      [
        "Active operator steering directives (highest priority first):",
        ...recentSteering.map(
          (entry) =>
            `- [${entry.priority}] ${entry.directive}${entry.targetStepKey ? ` (target: ${entry.targetStepKey})` : ""}`
        ),
        "Apply these directives unless a higher-priority safety/policy constraint blocks them."
      ].join("\n")
    );
  }

  // File ownership fence
  const filePatternsFromMetadata = Array.isArray(step.metadata?.filePatterns)
    ? (step.metadata.filePatterns as unknown[])
        .map((p) => String(p ?? "").trim())
        .filter(Boolean)
    : [];
  const filePatternsFromClaimScopes = (() => {
    const policy = step.metadata?.policy;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return [] as string[];
    const claimScopes = Array.isArray((policy as Record<string, unknown>).claimScopes)
      ? ((policy as Record<string, unknown>).claimScopes as unknown[])
      : [];
    return claimScopes
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
        const scope = entry as Record<string, unknown>;
        const scopeKind = String(scope.scopeKind ?? "").trim();
        if (scopeKind !== "file") return "";
        let scopeValue = String(scope.scopeValue ?? "").trim();
        if (scopeValue.startsWith("pattern:")) scopeValue = scopeValue.slice("pattern:".length);
        if (scopeValue.startsWith("glob:")) scopeValue = scopeValue.slice("glob:".length);
        return scopeValue.trim();
      })
      .filter(Boolean);
  })();
  const filePatterns = [...new Set([...filePatternsFromMetadata, ...filePatternsFromClaimScopes])];
  if (filePatterns.length) {
    systemParts.push(
      `You are responsible for these files: ${filePatterns.join(", ")}. Do not modify files outside this scope.`
    );
  }

  // Handoff context from upstream steps
  const handoffSummaries = Array.isArray(step.metadata?.handoffSummaries)
    ? (step.metadata.handoffSummaries as unknown[])
        .map((s) => String(s ?? "").trim())
        .filter(Boolean)
    : [];
  if (handoffSummaries.length) {
    systemParts.push(`Context from upstream steps:\n${handoffSummaries.map((s) => `- ${s}`).join("\n")}`);
  }

  // Shared team knowledge projected from mission memory
  const memoryService = opts?.memoryService;
  const briefing = opts?.memoryBriefing ?? args.memoryBriefing ?? null;
  const sharedFacts = briefing?.sharedFacts ?? [];
  if (sharedFacts.length > 0) {
    systemParts.push(
      [
        "## Shared Team Knowledge",
        "Facts discovered by other agents in this run:",
        ...sharedFacts.map((fact) => `- [${fact.factType}] ${fact.content}`)
      ].join("\n")
    );
  }

  // Project memories (high importance only, above minimum relevance threshold)
  const MIN_MEMORY_SCORE = 0.3;
  const memProjectId = opts?.projectId;
  if (briefing) {
    const missionEntries = Array.isArray(briefing.mission?.entries) ? briefing.mission.entries : [];
    const projectL0Entries = Array.isArray(briefing.l0?.entries) ? briefing.l0.entries : [];
    const projectL1Entries = Array.isArray(briefing.l1?.entries) ? briefing.l1.entries : [];
    const agentEntries = Array.isArray(briefing.l2?.entries) ? briefing.l2.entries : [];
    if (missionEntries.length > 0) {
      systemParts.push(
        [
          "## Mission Memory",
          ...missionEntries.map((mem) => `- [${mem.category}] ${mem.content}`)
        ].join("\n")
      );
    }
    const projectKnowledge = [...projectL0Entries, ...projectL1Entries]
      .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
    if (projectKnowledge.length > 0) {
      systemParts.push(
        [
          "## Project Knowledge",
          ...projectKnowledge.map((mem) => `- [${mem.category}] ${mem.content}`)
        ].join("\n")
      );
    }
    if (agentEntries.length > 0) {
      systemParts.push(
        [
          "## Agent Memory",
          ...agentEntries.map((mem) => `- [${mem.category}] ${mem.content}`)
        ].join("\n")
      );
    }
  } else if (memoryService && memProjectId) {
    const projectMemories = memoryService.getMemoryBudget(memProjectId, "lite");
    const promoted = projectMemories.filter((m) => m.importance === "high" && m.compositeScore >= MIN_MEMORY_SCORE);
    if (promoted.length > 0) {
      systemParts.push(
        [
          "## Project Knowledge",
          ...promoted.map((mem) => `- [${mem.category}] ${mem.content}`)
        ].join("\n")
      );
    }
  }

  // Advisory dependency note
  if (step.joinPolicy === "advisory" && step.dependencyStepIds.length > 0) {
    systemParts.push(
      "Note: Your upstream dependencies are advisory (non-blocking). Some upstream steps may still be running. Proceed with your best understanding and note any assumptions."
    );
  }

  // Recovery context for retry attempts
  if (args.previousCheckpoint || args.previousAttemptSummary) {
    const recoveryParts: string[] = ["RECOVERY CONTEXT — PREVIOUS PROGRESS:"];
    recoveryParts.push("Your previous attempt on this step was interrupted.");
    if (args.previousCheckpoint) {
      recoveryParts.push(
        "Here is your checkpoint from before the interruption:",
        "",
        "---",
        args.previousCheckpoint,
        "---",
        ""
      );
    }
    if (args.previousAttemptSummary) {
      recoveryParts.push(
        "Previous attempt outcome:",
        args.previousAttemptSummary,
        ""
      );
    }
    // Include AI diagnosis if the orchestrator diagnosed the failure
    const recoveryDiagnosis = step.metadata?.lastRecoveryDiagnosis;
    if (recoveryDiagnosis && typeof recoveryDiagnosis === "object" && !Array.isArray(recoveryDiagnosis)) {
      const diag = recoveryDiagnosis as Record<string, unknown>;
      const classification = typeof diag.classification === "string" ? diag.classification : "";
      if (classification) {
        recoveryParts.push(
          `Orchestrator diagnosis of previous failure: ${classification}`,
          "The steering directives above contain specific recovery guidance from the orchestrator. Follow them."
        );
      }
    }
    recoveryParts.push(
      "Resume from where you left off. Do not redo work that was already completed. Check the state of files mentioned in the checkpoint to verify what was actually saved."
    );
    systemParts.push(recoveryParts.join("\n"));
  }

  // Inject translated slash command prompt as instructions
  const rawStartup = typeof step.metadata?.startupCommand === "string" ? step.metadata.startupCommand.trim() : "";
  const slashBase = rawStartup.split(/\s/)[0];
  const slashTranslation = slashBase ? SLASH_COMMAND_TRANSLATIONS[slashBase] : undefined;
  if (slashTranslation) {
    systemParts.push(`Slash command instructions:\n${slashTranslation.prompt}`);
  }

  // Apply role-specific context view
  const workerRole = typeof step.metadata?.role === "string" ? step.metadata.role as OrchestratorWorkerRole : null;
  const contextView = workerRole ? DEFAULT_CONTEXT_VIEW_POLICIES[
    workerRole === "code_review" ? "review" :
    workerRole === "test_review" ? "test_review" :
    "implementation"
  ] : null;

  if (contextView?.readOnly) {
    systemParts.push("IMPORTANT: You are in a READ-ONLY review role. Do NOT modify any files. Only analyze and provide feedback on the code/tests you are reviewing.");
  }

  // ADE self-awareness
  systemParts.push("You are working within ADE (Autonomous Development Environment), an Electron-based multi-agent development tool. ADE manages lanes (git worktrees), missions (task orchestration), PRs, and agent sessions. You have access to the project's full context including PRD and architecture docs when provided.");

  // ADE collaboration tools
  if (hasMissionTooling) {
    systemParts.push(
      [
        "ADE TOOLING: In terminal-capable sessions, use the bundled `ade` CLI for internal ADE actions. Run `ade doctor` for readiness, `ade actions list --text` for discovery, typed commands such as `ade lanes list --text` or `ade prs checks <pr> --text` first, and `ade actions run ...` as the escape hatch. Use `--json` for structured output and `--text` for readable output.",
        "Your worker identity (mission, run, step, attempt IDs) is automatically resolved — you don't need to pass IDs to observation tools.",
        "Key actions available:",
        "- get_worker_states: See all peer workers in your run and their current status",
        "- get_run_graph: See the full execution plan, step statuses, and dependencies",
        "- get_mission: Get mission details and metadata",
        "- get_pending_messages: Check for messages from the coordinator or peer workers",
        "- get_timeline: See recent events in your run",
        "- stream_events: Poll for new orchestrator events",
        "Use get_pending_messages periodically to check for steering directives or peer communications."
      ].join("\n")
    );
  } else {
    systemParts.push(
      [
        "RUNTIME LIMITS:",
        "- This worker runs as a bounded in-process execution, not a tracked ADE session.",
        "- You will not receive follow-up steering while this attempt is running.",
        "- Treat the current prompt as the full assignment and complete it end-to-end in one pass."
      ].join("\n")
    );
  }

  // Team runtime capabilities
  {
    const teamRuntime = run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
      ? (run.metadata as Record<string, unknown>).teamRuntime as TeamRuntimeConfig | undefined
      : undefined;

    if (teamRuntime?.enabled && hasMissionTooling) {
      systemParts.push(
        [
          "TEAM RUNTIME (ACTIVE): You are part of an ADE agent team with shared task management.",
          "- You can claim tasks from the shared task list",
          "- You can send messages to other teammates via the coordinator",
          "- You can report progress, blockers, and discoveries",
          "- Focus on your claimed task — the coordinator manages task distribution",
          "- When your task is done, report completion and the coordinator will assign more work or finalize the run",
          "- If you discover something relevant to other tasks, write it with memory_add so it is preserved in project memories and shared facts"
        ].join("\n")
      );
    } else if (teamRuntime?.enabled) {
      systemParts.push(
        [
          "TEAM RUNTIME (ACTIVE): This mission is running with team semantics, but your worker is one-shot and not live-steerable.",
          "- Finish the assignment in this prompt without waiting for re-assignment.",
          "- Surface discoveries for sibling steps in your final response."
        ].join("\n")
      );
    }
  }

  // D. Checkpoint instructions
  if (!readOnlyExecution) {
    const sanitizedStepKey = step.stepKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    systemParts.push(
      [
        `PROGRESS CHECKPOINTING: After completing each significant unit of work (e.g., finishing a function, completing a file, passing a test), write a checkpoint file at \`.ade/checkpoints/${sanitizedStepKey}.md\` in your working directory with (create the \`.ade/checkpoints\` folder if needed):`,
        "- What you have accomplished so far",
        "- Files you have modified and why",
        "- Key decisions you made and your reasoning",
        "- What you plan to do next",
        "- Any risks or concerns",
        "",
        "Update this file as you progress. This checkpoint will be used for recovery if your session is interrupted."
      ].join("\n")
    );
  }

  // Handoff summary guidance
  systemParts.push(
    [
      "Before finishing, write a HANDOFF SUMMARY (3-5 bullets):",
      "1. What you accomplished (files created/modified)",
      "2. What downstream steps need to know (API changes, new deps, config updates)",
      "3. Any risks or known issues (edge cases not covered, flaky tests)"
    ].join("\n")
  );

  // Durable step output file
  if (!readOnlyExecution) {
    const sanitizedStepKeyForOutput = step.stepKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    systemParts.push(
      [
        `STEP OUTPUT FILE: When you complete your task, write a structured summary file at:`,
        `  .ade/step-output-${sanitizedStepKeyForOutput}.md`,
        "",
        "The file MUST contain these sections:",
        "## Summary",
        "1-2 sentence description of what was accomplished.",
        "",
        "## Files Changed",
        "Bulleted list of files created or modified.",
        "",
        "## Tests",
        "Test results if any tests were run (passed/failed/skipped counts).",
        "",
        "## Validation",
        "Any validation performed and results.",
        "",
        "## Warnings",
        "Any issues, concerns, or risks discovered.",
        "",
        "## Next Steps",
        "Suggested follow-up work if applicable.",
        "",
        "This file is your durable output record. The orchestrator reads it to understand what you accomplished, especially after context compaction when conversation history is lost."
      ].join("\n")
    );
  }

  // Compaction context — preserved across context summarization
  {
    const completedSteps = args.allSteps.filter((s) => s.status === "succeeded").length;
    const totalSteps = args.allSteps.length;
    const claimScopes = Array.isArray(step.metadata?.claimScopes)
      ? (step.metadata.claimScopes as Array<{ scopeValue?: string }>)
          .map((c) => c.scopeValue ?? "")
          .filter(Boolean)
          .join(", ")
      : filePatterns.join(", ");
    systemParts.push(
      [
        "## COMPACTION CONTEXT (preserve across context summarization)",
        `- Mission: "${missionGoal.slice(0, 200)}"`,
        `- Your step: "${step.metadata?.stepKey ?? step.stepKey}" (${step.title})`,
        `- Files you own: ${claimScopes || "none"}`,
        `- Shared facts count: ${sharedFacts.length}`,
        `- Run progress: ${completedSteps}/${totalSteps} steps complete`,
        "When your context is summarized/compacted, preserve this section and any important discoveries.",
        "Before compaction, write important discoveries using memoryAdd so they are preserved in project memories and shared facts."
      ].join("\n")
    );
  }

  // 2. Build user prompt from context snapshot
  const userParts: string[] = [];

  if (args.laneExport) {
    userParts.push(`--- Lane context ---\n${args.laneExport.content}`);
  }
  userParts.push(`--- Project context ---\n${args.projectExport.content}`);

  if (args.fullDocs.length) {
    for (const doc of args.fullDocs) {
      userParts.push(`--- Doc: ${doc.path}${doc.truncated ? " (truncated)" : ""} ---\n${doc.content}`);
    }
  } else if (args.docsRefs.length) {
    userParts.push(
      `Referenced docs: ${args.docsRefs.map((r) => `${r.path} (${r.sha256.slice(0, 8)})`).join(", ")}`
    );
  }

  const prompt = [systemParts.join("\n\n"), userParts.join("\n\n")].join("\n\n");

  return { prompt, filePatterns, steeringDirectiveCount: steeringDirectives.length };
}

// ─────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────

/**
 * Creates an OrchestratorExecutorAdapter from a BaseAdapterConfig.
 * Encapsulates all shared logic (prompt building, session creation,
 * slash command handling, etc.) while delegating CLI-specific details
 * to the config.
 */
export function createBaseOrchestratorAdapter(config: BaseAdapterConfig): OrchestratorExecutorAdapter {
  const {
    executorKind,
    sessionType,
    buildOverrideCommand,
    buildStartupCommand,
    buildAcceptedMetadata
  } = config;

  return {
    kind: executorKind,
    async start(args: OrchestratorExecutorStartArgs): Promise<OrchestratorExecutorStartResult> {
      const { run, step, attempt } = args;

      if (!step.laneId) {
        return {
          status: "failed",
          errorClass: "policy",
          errorMessage: `${executorKind} executor requires step.laneId to create tracked sessions.`
        };
      }

      try {
        // 0a. Translate slash commands to proper prompts
        const rawStartup = typeof step.metadata?.startupCommand === "string" ? step.metadata.startupCommand.trim() : "";
        const slashBase = rawStartup.split(/\s/)[0];
        const slashTranslation = slashBase ? SLASH_COMMAND_TRANSLATIONS[slashBase] : undefined;

        // 0b. Check for startup command override from policy (skip if slash translation applies)
        const startupCommandOverride =
          !slashTranslation && typeof step.metadata?.startupCommand === "string" && step.metadata.startupCommand.trim().length
            ? step.metadata.startupCommand.trim()
            : null;

        if (startupCommandOverride) {
          // Use the startup command directly as the prompt
          const session = await args.createTrackedSession({
            laneId: step.laneId,
            toolType: sessionType,
            title: `[Orchestrator] ${step.title}`,
            startupCommand: buildOverrideCommand({ prompt: startupCommandOverride }),
            cols: 120,
            rows: 40
          });

          return {
            status: "accepted",
            sessionId: session.sessionId,
            metadata: {
              adapterKind: executorKind,
              startupCommandOverride: true,
              promptLength: startupCommandOverride.length,
              startupCommandPreview: startupCommandOverride.slice(0, 320)
            }
          };
        }

        // 1-2. Build full prompt (shared logic, executor-aware)
        const { prompt, filePatterns, steeringDirectiveCount } = buildFullPrompt(args, executorKind, {
          memoryService: args.memoryService as ReturnType<typeof createMemoryService> | undefined,
          projectId: args.memoryProjectId,
          memoryBriefing: args.memoryBriefing,
        });

        // 3. Determine model (strict cutover: modelId is required)
        const model = typeof step.metadata?.modelId === "string" ? step.metadata.modelId.trim() : "";
        if (!model.length) {
          return {
            status: "failed",
            errorClass: "policy",
            errorMessage: `Step '${step.stepKey}' is missing required metadata.modelId for ${executorKind} execution.`
          };
        }

        // 4. Construct startup command (adapter-specific)
        const teamRuntime = run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
          ? (run.metadata as Record<string, unknown>).teamRuntime as TeamRuntimeConfig | undefined
          : undefined;
        const startupCommand = buildStartupCommand({
          prompt,
          model,
          step,
          run,
          attempt,
          permissionConfig: args.permissionConfig,
          teamRuntime
        });

        // 5. Create tracked session
        const session = await args.createTrackedSession({
          laneId: step.laneId,
          toolType: sessionType,
          title: `[Orchestrator] ${step.title}`,
          startupCommand,
          cols: 120,
          rows: 40
        });

        // 6. Resolve reasoning effort from step metadata
        const reasoningEffort =
          typeof step.metadata?.reasoningEffort === "string" && step.metadata.reasoningEffort.trim().length
            ? step.metadata.reasoningEffort.trim()
            : undefined;

        // 7. Return accepted with adapter-specific metadata
        return {
          status: "accepted",
          sessionId: session.sessionId,
          metadata: buildAcceptedMetadata({
            model,
            step,
            permissionConfig: args.permissionConfig,
            filePatterns,
            steeringDirectiveCount,
            promptLength: prompt.length,
            reasoningEffort,
            startupCommandPreview: startupCommand.slice(0, 320)
          })
        };
      } catch (error) {
        return {
          status: "failed",
          errorClass: "executor_failure",
          errorMessage: error instanceof Error ? error.message : String(error),
          metadata: {
            adapterKind: executorKind,
            adapterState: "start_failed"
          }
        };
      }
    }
  };
}
