import type {
  OrchestratorExecutorAdapter,
  OrchestratorExecutorStartArgs,
  OrchestratorExecutorStartResult
} from "./orchestratorService";

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function createClaudeOrchestratorAdapter(): OrchestratorExecutorAdapter {
  return {
    kind: "claude",
    async start(args: OrchestratorExecutorStartArgs): Promise<OrchestratorExecutorStartResult> {
      const { run, step, attempt } = args;

      if (!step.laneId) {
        return {
          status: "failed",
          errorClass: "policy",
          errorMessage: "Claude executor requires step.laneId to create tracked sessions."
        };
      }

      try {
        // 0. Check for startup command override from policy
        const startupCommandOverride =
          typeof step.metadata?.startupCommand === "string" && step.metadata.startupCommand.trim().length
            ? step.metadata.startupCommand.trim()
            : null;

        if (startupCommandOverride) {
          // Use the startup command directly as the prompt
          const session = await args.createTrackedSession({
            laneId: step.laneId,
            toolType: "claude-orchestrated",
            title: `[Orchestrator] ${step.title}`,
            startupCommand: `exec claude -p ${shellEscapeArg(startupCommandOverride)}`,
            cols: 120,
            rows: 40
          });

          return {
            status: "accepted",
            sessionId: session.sessionId,
            metadata: {
              adapterKind: "claude",
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

        // 3. Determine model and permission mode
        const model =
          typeof step.metadata?.model === "string" && step.metadata.model.trim().length
            ? step.metadata.model.trim()
            : "sonnet";

        // Fallback chain: step metadata -> project config -> default
        const permissionMode =
          typeof step.metadata?.permissionMode === "string" && step.metadata.permissionMode.trim().length
            ? step.metadata.permissionMode.trim()
            : args.permissionConfig?.claude?.permissionMode ?? "acceptEdits";

        const dangerouslySkip = args.permissionConfig?.claude?.dangerouslySkipPermissions === true;

        const allowedTools = args.permissionConfig?.claude?.allowedTools ?? [];

        // 4. Construct startup command
        const commandParts: string[] = [
          "claude",
          "--model",
          shellEscapeArg(model)
        ];

        if (dangerouslySkip) {
          commandParts.push("--dangerously-skip-permissions");
        } else {
          commandParts.push("--permission-mode", shellEscapeArg(permissionMode));
        }

        for (const tool of allowedTools) {
          if (tool.trim().length) {
            commandParts.push("--allowedTools", shellEscapeArg(tool.trim()));
          }
        }

        commandParts.push("-p", shellEscapeArg(prompt));
        // Use exec so the shell exits when the command exits, allowing the
        // orchestrator to detect completion or crash immediately.
        const startupCommand = `exec ${commandParts.join(" ")}`;

        // 5. Create tracked session
        const session = await args.createTrackedSession({
          laneId: step.laneId,
          toolType: "claude-orchestrated",
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
            adapterKind: "claude",
            model,
            permissionMode,
            reasoningEffort,
            filePatterns: filePatterns.length ? filePatterns : undefined,
            steeringDirectiveCount: steeringDirectives.length,
            promptLength: prompt.length,
            startupCommandPreview: startupCommand.slice(0, 320)
          }
        };
      } catch (error) {
        return {
          status: "failed",
          errorClass: "executor_failure",
          errorMessage: error instanceof Error ? error.message : String(error),
          metadata: {
            adapterKind: "claude",
            adapterState: "start_failed"
          }
        };
      }
    }
  };
}
