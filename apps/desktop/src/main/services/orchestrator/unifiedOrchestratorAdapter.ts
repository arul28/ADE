import type { OrchestratorExecutorAdapter } from "./orchestratorService";
import { createBaseOrchestratorAdapter, shellEscapeArg } from "./baseOrchestratorAdapter";
import { getModelById } from "../../../shared/modelRegistry";

/**
 * Unified orchestrator adapter that handles ALL model providers.
 * For CLI-wrapped models (Claude CLI, Codex CLI), it delegates to the appropriate CLI.
 * For API-key models, it constructs a direct SDK invocation command.
 */
export function createUnifiedOrchestratorAdapter(): OrchestratorExecutorAdapter {
  return createBaseOrchestratorAdapter({
    executorKind: "unified",
    sessionType: "ai-orchestrated",
    defaultModel: "anthropic/claude-sonnet-4-6",

    buildOverrideCommand: ({ prompt }) => {
      // For override commands, try to detect the best CLI
      // Default to claude since it's the most common
      return `exec claude -p ${shellEscapeArg(prompt)}`;
    },

    buildStartupCommand: ({ prompt, model, step, permissionConfig, agentCapabilities }) => {
      const descriptor = getModelById(model);

      // Determine which CLI to use based on the model
      if (!descriptor || (descriptor.isCliWrapped && descriptor.family === "anthropic")) {
        // Claude CLI path
        const cliModel = descriptor?.sdkModelId ?? "sonnet";
        const permissionMode =
          typeof step.metadata?.permissionMode === "string" && step.metadata.permissionMode.trim().length
            ? step.metadata.permissionMode.trim()
            : permissionConfig?.claude?.permissionMode ?? "acceptEdits";

        const dangerouslySkip = permissionConfig?.claude?.dangerouslySkipPermissions === true;
        const allowedTools = permissionConfig?.claude?.allowedTools ?? [];

        const parts: string[] = ["claude", "--model", shellEscapeArg(cliModel)];

        if (dangerouslySkip) {
          parts.push("--dangerously-skip-permissions");
        } else {
          parts.push("--permission-mode", shellEscapeArg(permissionMode));
        }

        for (const tool of allowedTools) {
          if (tool.trim().length) parts.push("--allowedTools", shellEscapeArg(tool.trim()));
        }

        parts.push("-p", shellEscapeArg(prompt));

        const envParts: string[] = [];
        if (agentCapabilities?.agentTeams) envParts.push("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");

        const cmd = parts.join(" ");
        return envParts.length > 0 ? `${envParts.join(" ")} exec ${cmd}` : `exec ${cmd}`;
      }

      if (descriptor.isCliWrapped && descriptor.family === "openai") {
        // Codex CLI path
        const approvalMode =
          typeof step.metadata?.approvalMode === "string" && step.metadata.approvalMode.trim().length
            ? step.metadata.approvalMode.trim()
            : permissionConfig?.codex?.approvalMode ?? "full-auto";

        const approvalPolicy =
          approvalMode === "suggest" ? "untrusted" :
          approvalMode === "auto-edit" ? "on-request" : "never";

        const sandboxMode =
          typeof step.metadata?.sandboxPermissions === "string" && step.metadata.sandboxPermissions.trim().length
            ? step.metadata.sandboxPermissions.trim()
            : permissionConfig?.codex?.sandboxPermissions ?? "workspace-write";

        const writablePaths = permissionConfig?.codex?.writablePaths ?? [];

        const parts: string[] = [
          "codex", "--model", shellEscapeArg(descriptor.sdkModelId),
          "-a", shellEscapeArg(approvalPolicy),
          "-s", shellEscapeArg(sandboxMode),
          "exec"
        ];

        for (const wp of writablePaths) {
          if (wp.trim().length) parts.push("--add-dir", shellEscapeArg(wp.trim()));
        }

        parts.push(shellEscapeArg(prompt));
        return `exec ${parts.join(" ")}`;
      }

      // For API-key models, we can't use a CLI command directly
      // Fall back to claude CLI with the prompt (the orchestrator will handle the SDK call)
      return `exec claude -p ${shellEscapeArg(prompt)}`;
    },

    buildAcceptedMetadata: ({ model, step, permissionConfig, filePatterns, steeringDirectiveCount, promptLength, reasoningEffort, startupCommandPreview }) => {
      const descriptor = getModelById(model);
      return {
        adapterKind: "unified",
        model,
        modelFamily: descriptor?.family ?? "unknown",
        isCliWrapped: descriptor?.isCliWrapped ?? true,
        reasoningEffort,
        filePatterns: filePatterns.length ? filePatterns : undefined,
        steeringDirectiveCount,
        promptLength,
        startupCommandPreview
      };
    }
  });
}
