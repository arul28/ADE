import type {
  OrchestratorExecutorAdapter,
  OrchestratorExecutorStartArgs,
  OrchestratorExecutorStartResult
} from "./orchestratorService";
import type { OrchestratorWorkerRole, OrchestratorContextView, OrchestratorStep, OrchestratorExecutorKind, TerminalToolType } from "../../../shared/types";
import type { createMemoryService } from "../memory/memoryService";
import { DEFAULT_CONTEXT_VIEW_POLICIES, SLASH_COMMAND_TRANSLATIONS } from "../../../shared/types";

// ─────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────

export function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
      case "skipped":
        prefix = "  [skipped]";
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
    permissionConfig: OrchestratorExecutorStartArgs["permissionConfig"];
    agentCapabilities?: { parallelSubagents?: boolean; agentTeams?: boolean };
  }) => string;
  /** Default model when step metadata doesn't specify one. */
  defaultModel: string;
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
  executorKind?: OrchestratorExecutorKind,
  opts?: { memoryService?: ReturnType<typeof createMemoryService>; projectId?: string }
): {
  prompt: string;
  filePatterns: string[];
  steeringDirectiveCount: number;
} {
  const { run, step } = args;

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

  // B. Propulsion principle
  systemParts.push(
    "EXECUTION PROTOCOL: Execute immediately. Do not ask for confirmation or propose a plan and wait for approval. Do not summarize your instructions back. If you encounter a blocker you cannot work around, fail with a clear error message describing the blocker. Never wait for human input — make the best decision you can and document your reasoning."
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

  // Budget pressure directive injection
  const budgetDirective = step.metadata?.budgetDirective;
  if (typeof budgetDirective === "string" && budgetDirective.length > 0) {
    systemParts.push(
      [
        "COST AWARENESS:",
        budgetDirective
      ].join("\n")
    );
  }

  const instructions =
    typeof step.metadata?.instructions === "string" ? step.metadata.instructions.trim() : "";
  if (instructions) {
    systemParts.push(`Step instructions:\n${instructions}`);
  }

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

  // Shared facts from other agents in this run
  const memoryService = opts?.memoryService;
  const sharedFacts = memoryService?.getSharedFacts?.(run.id, 20) ?? [];
  if (sharedFacts.length > 0) {
    systemParts.push(
      [
        "## Shared Team Knowledge",
        "Facts discovered by other agents in this run:",
        ...sharedFacts.map((fact) => `- [${fact.factType}] ${fact.content}`)
      ].join("\n")
    );
  }

  // Project memories (high importance only)
  const memProjectId = opts?.projectId;
  if (memoryService && memProjectId) {
    const projectMemories = memoryService.getMemoryBudget(memProjectId, "lite");
    const promoted = projectMemories.filter((m) => m.importance === "high");
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

  // Parallel agent capabilities — executor-aware
  {
    const agentCaps = run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
      ? (run.metadata as Record<string, unknown>).agentCapabilities
      : null;
    const caps = agentCaps && typeof agentCaps === "object" && !Array.isArray(agentCaps)
      ? agentCaps as Record<string, unknown>
      : null;
    const kind = executorKind ?? "claude";

    if (caps?.parallelSubagents === true) {
      if (kind === "claude") {
        systemParts.push("PARALLEL SUB-AGENTS (ENABLED): You can use the Task tool to spawn parallel sub-agents for independent subtasks. Each sub-agent runs in its own context window and reports results back to you. Use this when multiple independent operations can be done simultaneously — exploring multiple areas, implementing independent changes, or running parallel research. Sub-agents cannot communicate with each other; they only report back to you.");
      } else if (kind === "codex") {
        systemParts.push("PARALLEL SUB-AGENTS (ENABLED): Multi-agent mode is enabled. You can spawn parallel sub-agents for independent subtasks. Each sub-agent runs in its own thread and reports results back to you. Use this when multiple independent operations can be done simultaneously. Available roles: worker (implementation), explorer (read-heavy exploration), monitor (long-running polling).");
      } else {
        // Generic fallback for third-party executors
        systemParts.push("PARALLEL SUB-AGENTS (ENABLED): You can spawn parallel sub-agents for independent subtasks when multiple independent operations can be done simultaneously.");
      }
    }

    if (caps?.agentTeams === true && kind === "claude") {
      // Agent teams are ONLY available for Claude Code — Codex does not support this
      systemParts.push("AGENT TEAMS (ENABLED): You can create Claude Code agent teams for complex coordinated work. Unlike sub-agents, teammates share a task list, claim work independently, and communicate directly with each other. Use this for tasks that benefit from parallel discussion and collaboration — research with competing hypotheses, cross-layer coordination (frontend + backend + tests), or complex debugging. Each teammate is a full Claude Code instance with its own context window. Start by asking to create an agent team describing the roles you need.");
    }
  }

  // D. Checkpoint instructions
  {
    const sanitizedStepKey = step.stepKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    systemParts.push(
      [
        `PROGRESS CHECKPOINTING: After completing each significant unit of work (e.g., finishing a function, completing a file, passing a test), write a checkpoint file at \`.ade-checkpoint-${sanitizedStepKey}.md\` in your working directory with:`,
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
        "Before compaction, write important discoveries as shared facts using the memoryAdd tool."
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
    defaultModel,
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
        });

        // 3. Determine model
        const model =
          typeof step.metadata?.model === "string" && step.metadata.model.trim().length
            ? step.metadata.model.trim()
            : defaultModel;

        // 4. Construct startup command (adapter-specific)
        const agentCapsRaw = run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
          ? (run.metadata as Record<string, unknown>).agentCapabilities
          : null;
        const agentCaps = agentCapsRaw && typeof agentCapsRaw === "object" && !Array.isArray(agentCapsRaw)
          ? agentCapsRaw as { parallelSubagents?: boolean; agentTeams?: boolean }
          : undefined;
        const startupCommand = buildStartupCommand({
          prompt,
          model,
          step,
          permissionConfig: args.permissionConfig,
          agentCapabilities: agentCaps
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
