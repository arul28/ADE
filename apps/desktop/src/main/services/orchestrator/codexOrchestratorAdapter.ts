import type {
  OrchestratorExecutorAdapter,
  OrchestratorExecutorStartArgs,
  OrchestratorExecutorStartResult
} from "./orchestratorService";

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

        // File ownership fence
        const filePatterns = Array.isArray(step.metadata?.filePatterns)
          ? (step.metadata.filePatterns as unknown[])
              .map((p) => String(p ?? "").trim())
              .filter(Boolean)
          : [];
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

        // 3. Determine model and approval mode
        const model =
          typeof step.metadata?.model === "string" && step.metadata.model.trim().length
            ? step.metadata.model.trim()
            : "gpt-5.3-codex";

        // Fallback chain: step metadata -> project config -> default
        const approvalMode =
          typeof step.metadata?.approvalMode === "string" && step.metadata.approvalMode.trim().length
            ? step.metadata.approvalMode.trim()
            : args.permissionConfig?.codex?.approvalMode ?? "full-auto";

        const configPath = args.permissionConfig?.codex?.configPath;
        const writablePaths = args.permissionConfig?.codex?.writablePaths ?? [];

        // 4. Construct startup command
        // Codex CLI uses standalone flags for approval mode (--full-auto, --suggest, --auto-edit)
        const approvalFlag =
          approvalMode === "suggest" ? "--suggest"
            : approvalMode === "auto-edit" ? "--auto-edit"
              : "--full-auto";
        const commandParts: string[] = [
          "codex",
          "--model",
          shellEscapeArg(model),
          approvalFlag
        ];

        if (typeof configPath === "string" && configPath.trim().length) {
          commandParts.push("--config", shellEscapeArg(configPath.trim()));
        }

        for (const wp of writablePaths) {
          if (wp.trim().length) {
            commandParts.push("--writable-root", shellEscapeArg(wp.trim()));
          }
        }

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

        // 6. Return accepted
        return {
          status: "accepted",
          sessionId: session.sessionId,
          metadata: {
            adapterKind: "codex",
            model,
            approvalMode,
            filePatterns: filePatterns.length ? filePatterns : undefined,
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
            adapterKind: "codex",
            adapterState: "start_failed"
          }
        };
      }
    }
  };
}
