import type { AiClaudeAvailability, AiProviderConnections } from "../../../shared/types";
import { reportedClaudeCodeVersion } from "./claudeCodeInit";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";

// Claude's row in the AI status. One copy for the integration service and the
// IPC fallback status, so both report the same binary and the same version.

export function detectClaudeAuthModeFromConnection(
  connection: AiProviderConnections["claude"],
): AiClaudeAvailability["auth"]["mode"] {
  const localCredentials = connection.sources.find((source) => source.kind === "local-credentials" && source.detected);
  if (localCredentials?.source === "claude-credentials-file" || localCredentials?.source === "macos-keychain") return "oauth";
  if (localCredentials) return "api_key";
  const cli = connection.sources.find((source) => source.kind === "cli" && source.detected);
  if (cli || connection.authAvailable) return "oauth";
  return "none";
}

export function resolveBundledClaudeBinary(): Pick<AiClaudeAvailability["binary"], "present" | "source" | "path"> {
  const resolved = resolveClaudeCodeExecutable({ env: { PATH: "" } });
  // A copy ADE fetched counts as ADE's own, like one it shipped.
  return resolved.source === "bundled" || resolved.source === "tools-cache"
    ? { present: true, source: "bundled", path: resolved.path }
    : { present: false, source: "missing", path: null };
}

/** The binary as resolved, with the version the runtime itself last reported. */
export function withReportedClaudeVersion(binary: AiClaudeAvailability["binary"]): AiClaudeAvailability["binary"] {
  const version = binary.present ? reportedClaudeCodeVersion() : null;
  return version ? { ...binary, version } : binary;
}

export function buildClaudeAvailabilityFromConnection(
  connection: AiProviderConnections["claude"],
  options?: { disabled?: boolean },
): AiClaudeAvailability {
  const bundledBinary = resolveBundledClaudeBinary();
  const binary = bundledBinary.present
    ? bundledBinary
    : {
        present: connection.runtimeDetected,
        source: connection.runtimeDetected ? "path" as const : "missing" as const,
        path: connection.path,
      };
  const authMode = detectClaudeAuthModeFromConnection(connection);
  // The connection's runtime is the same resolver's answer, so a blocker here
  // is about sign-in or runtime health, never a binary ADE has but missed.
  const ready = options?.disabled !== true
    && binary.present
    && connection.authAvailable
    && (connection.runtimeAvailable || !connection.blocker);
  return {
    binary: withReportedClaudeVersion(binary),
    auth: {
      ready,
      mode: ready ? authMode : "none",
      detail: ready ? null : connection.blocker,
    },
  };
}
