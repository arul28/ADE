import type {
  OrchestratorExecutorAdapter,
  OrchestratorExecutorStartArgs,
  OrchestratorExecutorStartResult
} from "./orchestratorService";
import type { OrchestratorWorkerRole, OrchestratorContextView } from "../../../shared/types";
import { DEFAULT_CONTEXT_VIEW_POLICIES, SLASH_COMMAND_TRANSLATIONS } from "../../../shared/types";

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function createCodexOrchestratorAdapter(): OrchestratorExecutorAdapter {
  return {
    kind: "codex",
    async start(args: OrchestratorExecutorStartArgs): Promise<OrchestratorExecutorStartResult> {
      const { run, step, attempt } = args;

      if (!step.laneId) {
        return {
          status: "failed",
          errorClass: "policy",
          errorMessage: "Codex executor requires step.laneId to create tracked sessions."
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
            toolType: "codex-orchestrated",
            title: `[Orchestrator] ${step.title}`,
            startupCommand: `exec codex exec ${shellEscapeArg(startupCommandOverride)}`,
            cols: 120,
            rows: 40
          });

          return {
            status: "accepted",
            sessionId: session.sessionId,
            metadata: {
              adapterKind: "codex",
              startupCommandOverride: true,
              promptLength: startupCommandOverride.length,
              startupCommandPreview: startupCommandOverride.slice(0, 320)
            }
          };
        }

        // 1. Build system prompt
        const systemParts: string[] = [];

        const missionGoal =
          typeof run.metadata?.missionGoal === "string" ? run.metadata.missionGoal.trim() : "";
        if (missionGoal) {
          systemParts.push(`Mission goal: ${missionGoal}`);
        }

        systemParts.push(`You are an ADE orchestrator worker executing step "${step.title}".`);

        systemParts.push(
          [
            "Work style:",
            "- If you discover information relevant to other steps (API changes, schema updates, config requirements), include it in your output summary.",
            "- If you hit a blocker you can work around safely, work around it and note what you did.",
            "- Structure your output: lead with what you accomplished, then what you changed, then risks or notes for downstream steps.",
            "- If your step depends on upstream work, check the handoff context before starting — don't redo completed work."
          ].join("\n")
        );

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

        // Inject translated slash command prompt as instructions
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

        // Handoff summary guidance
        systemParts.push(
          [
            "Before finishing, write a HANDOFF SUMMARY (3-5 bullets):",
            "1. What you accomplished (files created/modified)",
            "2. What downstream steps need to know (API changes, new deps, config updates)",
            "3. Any risks or known issues (edge cases not covered, flaky tests)"
          ].join("\n")
        );

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

        // 3. Determine model and execution policy
        const model =
          typeof step.metadata?.model === "string" && step.metadata.model.trim().length
            ? step.metadata.model.trim()
            : "gpt-5.3-codex";

        // Fallback chain: step metadata -> project config -> default
        const approvalMode =
          typeof step.metadata?.approvalMode === "string" && step.metadata.approvalMode.trim().length
            ? step.metadata.approvalMode.trim()
            : args.permissionConfig?.codex?.approvalMode ?? "full-auto";

        const approvalPolicy =
          approvalMode === "suggest"
            ? "untrusted"
            : approvalMode === "auto-edit"
              ? "on-request"
              : "never";

        const sandboxMode =
          typeof step.metadata?.sandboxPermissions === "string" && step.metadata.sandboxPermissions.trim().length
            ? step.metadata.sandboxPermissions.trim()
            : args.permissionConfig?.codex?.sandboxPermissions
              ?? (approvalMode === "suggest" ? "read-only" : "workspace-write");

        const configPath = args.permissionConfig?.codex?.configPath;
        const writablePaths = args.permissionConfig?.codex?.writablePaths ?? [];

        // 4. Construct startup command
        const commandParts: string[] = [
          "codex",
          "--model",
          shellEscapeArg(model),
          "-a",
          shellEscapeArg(approvalPolicy),
          "-s",
          shellEscapeArg(sandboxMode),
          "exec"
        ];

        for (const wp of writablePaths) {
          if (wp.trim().length) {
            commandParts.push("--add-dir", shellEscapeArg(wp.trim()));
          }
        }

        // The Codex CLI no longer accepts "--config <path>" for custom config files.
        // Keep configPath in metadata for visibility but avoid emitting invalid flags.
        void configPath;

        commandParts.push(shellEscapeArg(prompt));
        // Use exec so the shell exits when the command exits, allowing the
        // orchestrator to detect completion or crash immediately.
        const startupCommand = `exec ${commandParts.join(" ")}`;

        // 5. Create tracked session
        const session = await args.createTrackedSession({
          laneId: step.laneId,
          toolType: "codex-orchestrated",
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

        // 7. Return accepted
        return {
          status: "accepted",
          sessionId: session.sessionId,
          metadata: {
            adapterKind: "codex",
            model,
            approvalMode,
            approvalPolicy,
            sandboxMode,
            reasoningEffort,
            filePatterns: filePatterns.length ? filePatterns : undefined,
            steeringDirectiveCount: steeringDirectives.length,
            promptLength: prompt.length,
            configPathApplied: false,
            startupCommandPreview: startupCommand.slice(0, 320)
          }
        };
      } catch (error) {
        return {
          status: "failed",
          errorClass: "executor_failure",
          errorMessage: error instanceof Error ? error.message : String(error),
          metadata: {
            adapterKind: "codex",
            adapterState: "start_failed"
          }
        };
      }
    }
  };
}
