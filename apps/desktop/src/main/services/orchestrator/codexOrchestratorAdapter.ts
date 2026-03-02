import type { OrchestratorExecutorAdapter } from "./orchestratorService";
import { createBaseOrchestratorAdapter, shellEscapeArg } from "./baseOrchestratorAdapter";
import { resolveCodexCliModel } from "../ai/claudeModelUtils";

export function createCodexOrchestratorAdapter(): OrchestratorExecutorAdapter {
  return createBaseOrchestratorAdapter({
    executorKind: "codex",
    sessionType: "codex-orchestrated",
    defaultModel: "gpt-5.3-codex",

    buildOverrideCommand: ({ prompt }) =>
      `exec codex exec ${shellEscapeArg(prompt)}`,

    buildStartupCommand: ({ prompt, model, step, permissionConfig }) => {
      // Fallback chain: step metadata -> project config -> default
      const approvalMode =
        typeof step.metadata?.approvalMode === "string" && step.metadata.approvalMode.trim().length
          ? step.metadata.approvalMode.trim()
          : permissionConfig?.codex?.approvalMode ?? "full-auto";

      const approvalPolicy =
        approvalMode === "suggest"
          ? "untrusted"
          : approvalMode === "auto-edit"
            ? "on-request"
            : "never";

      const sandboxMode =
        typeof step.metadata?.sandboxPermissions === "string" && step.metadata.sandboxPermissions.trim().length
          ? step.metadata.sandboxPermissions.trim()
          : permissionConfig?.codex?.sandboxPermissions
            ?? (approvalMode === "suggest" ? "read-only" : "workspace-write");

      const configPath = permissionConfig?.codex?.configPath;
      const writablePaths = permissionConfig?.codex?.writablePaths ?? [];

      const commandParts: string[] = [
        "codex",
        "--model",
        shellEscapeArg(resolveCodexCliModel(model)),
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
      return `exec ${commandParts.join(" ")}`;
    },

    buildAcceptedMetadata: ({ model, step, permissionConfig, filePatterns, steeringDirectiveCount, promptLength, reasoningEffort, startupCommandPreview }) => {
      const approvalMode =
        typeof step.metadata?.approvalMode === "string" && step.metadata.approvalMode.trim().length
          ? step.metadata.approvalMode.trim()
          : permissionConfig?.codex?.approvalMode ?? "full-auto";

      const approvalPolicy =
        approvalMode === "suggest"
          ? "untrusted"
          : approvalMode === "auto-edit"
            ? "on-request"
            : "never";

      const sandboxMode =
        typeof step.metadata?.sandboxPermissions === "string" && step.metadata.sandboxPermissions.trim().length
          ? step.metadata.sandboxPermissions.trim()
          : permissionConfig?.codex?.sandboxPermissions
            ?? (approvalMode === "suggest" ? "read-only" : "workspace-write");

      return {
        adapterKind: "codex",
        model,
        approvalMode,
        approvalPolicy,
        sandboxMode,
        reasoningEffort,
        filePatterns: filePatterns.length ? filePatterns : undefined,
        steeringDirectiveCount,
        promptLength,
        configPathApplied: false,
        startupCommandPreview
      };
    }
  });
}
