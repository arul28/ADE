import type { AiClaudeAvailability, AiProviderConnectionStatus, AiProviderConnections } from "../../../shared/types";
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

/**
 * Whether a provider's models are offered: its runtime is ready, or it is
 * signed in with ADE's copy still to download (its first turn downloads it).
 * `runtimeAvailable` stays false in the second case, for health and banners.
 * Claude's row (below) is stricter: a ready runtime also needs its binary.
 * Kept here, beside that row, rather than in `providerConnectionStatus`,
 * which status tests replace whole.
 */
export function connectionListable(connection: AiProviderConnectionStatus | null | undefined): boolean {
  return Boolean(connection?.runtimeAvailable || (connection?.runtimeDownloadPending && connection.authAvailable));
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
  // Signed in with ADE's copy still to download is ready too: the first turn
  // downloads it (`runtimeAvailable` stays false for health and banners).
  const ready = options?.disabled !== true
    && connection.authAvailable
    && (
      (binary.present && (connection.runtimeAvailable || !connection.blocker))
      || connection.runtimeDownloadPending === true
    );
  return {
    binary: withReportedClaudeVersion(binary),
    auth: {
      ready,
      mode: ready ? authMode : "none",
      detail: ready ? null : connection.blocker,
    },
  };
}
