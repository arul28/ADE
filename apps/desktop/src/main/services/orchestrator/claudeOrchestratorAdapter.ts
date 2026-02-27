import type { OrchestratorExecutorAdapter } from "./orchestratorService";
import { createBaseOrchestratorAdapter, shellEscapeArg } from "./baseOrchestratorAdapter";

export function createClaudeOrchestratorAdapter(): OrchestratorExecutorAdapter {
  return createBaseOrchestratorAdapter({
    executorKind: "claude",
    sessionType: "claude-orchestrated",
    defaultModel: "sonnet",

    buildOverrideCommand: ({ prompt }) =>
      `exec claude -p ${shellEscapeArg(prompt)}`,

    buildStartupCommand: ({ prompt, model, step, permissionConfig, teamRuntime }) => {
      // Fallback chain: step metadata -> project config -> default
      const permissionMode =
        typeof step.metadata?.permissionMode === "string" && step.metadata.permissionMode.trim().length
          ? step.metadata.permissionMode.trim()
          : permissionConfig?.claude?.permissionMode ?? "acceptEdits";

      const dangerouslySkip = permissionConfig?.claude?.dangerouslySkipPermissions === true;

      const allowedTools = permissionConfig?.claude?.allowedTools ?? [];

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

      // Team runtime env vars — enable native teams when ADE team runtime is active
      const envParts: string[] = [];
      if (teamRuntime?.enabled && (teamRuntime.targetProvider === "claude" || teamRuntime.targetProvider === "auto")) {
        envParts.push("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
      }

      // Use exec so the shell exits when the command exits, allowing the
      // orchestrator to detect completion or crash immediately.
      const cmd = commandParts.join(" ");
      return envParts.length > 0 ? `${envParts.join(" ")} exec ${cmd}` : `exec ${cmd}`;
    },

    buildAcceptedMetadata: ({ model, step, permissionConfig, filePatterns, steeringDirectiveCount, promptLength, reasoningEffort, startupCommandPreview }) => {
      const permissionMode =
        typeof step.metadata?.permissionMode === "string" && step.metadata.permissionMode.trim().length
          ? step.metadata.permissionMode.trim()
          : permissionConfig?.claude?.permissionMode ?? "acceptEdits";

      return {
        adapterKind: "claude",
        model,
        permissionMode,
        reasoningEffort,
        filePatterns: filePatterns.length ? filePatterns : undefined,
        steeringDirectiveCount,
        promptLength,
        startupCommandPreview
      };
    }
  });
}
