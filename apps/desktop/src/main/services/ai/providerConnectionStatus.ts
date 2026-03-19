import type { AiProviderConnectionStatus, AiProviderConnections } from "../../../shared/types";
import type { CliAuthStatus } from "./authDetector";
import {
  isCodexTokenStale,
  readClaudeCredentials,
  readCodexCredentials,
} from "./providerCredentialSources";
import { getProviderRuntimeHealth } from "./providerRuntimeHealth";
import { nowIso } from "../shared/utils";

function createUnavailableStatus(
  provider: "claude" | "codex",
  checkedAt: string,
): AiProviderConnectionStatus {
  return {
    provider,
    authAvailable: false,
    runtimeDetected: false,
    runtimeAvailable: false,
    usageAvailable: false,
    path: null,
    blocker: "No local authentication or runtime was detected.",
    lastCheckedAt: checkedAt,
    sources: [],
  };
}

export async function buildProviderConnections(
  cliStatuses: CliAuthStatus[],
): Promise<AiProviderConnections> {
  const checkedAt = nowIso();
  const claudeCli = cliStatuses.find((entry) => entry.cli === "claude") ?? null;
  const codexCli = cliStatuses.find((entry) => entry.cli === "codex") ?? null;
  const [claudeLocalCreds, codexLocalCreds] = await Promise.all([
    readClaudeCredentials(),
    readCodexCredentials(),
  ]);
  const claudeRuntimeHealth = getProviderRuntimeHealth("claude");
  const codexRuntimeHealth = getProviderRuntimeHealth("codex");

  const claudeRuntimeDetected = Boolean(claudeCli?.installed);
  const claudeCliAuthenticated = Boolean(claudeCli?.installed && claudeCli.authenticated);
  const claudeAuthAvailable = Boolean(claudeLocalCreds || claudeCliAuthenticated);
  // Connected = we have auth credentials + the CLI is installed.
  // The runtime probe can only DOWNGRADE this to false on explicit auth failure.
  const claudeRuntimeAvailable = Boolean(claudeAuthAvailable && claudeRuntimeDetected);

  const codexRuntimeDetected = Boolean(codexCli?.installed);
  const codexCliAuthenticated = Boolean(codexCli?.installed && codexCli.authenticated);
  const codexUsageAvailable = Boolean(codexLocalCreds && !isCodexTokenStale(codexLocalCreds));
  const codexAuthAvailable = Boolean(codexLocalCreds || codexCliAuthenticated);
  const codexRuntimeAvailable = Boolean(codexAuthAvailable && codexRuntimeDetected);

  const claude = createUnavailableStatus("claude", checkedAt);
  claude.authAvailable = claudeAuthAvailable;
  claude.runtimeDetected = claudeRuntimeDetected;
  claude.runtimeAvailable = claudeRuntimeAvailable;
  claude.usageAvailable = Boolean(claudeLocalCreds);
  claude.path = claudeCli?.path ?? null;
  claude.sources = [
    {
      kind: "local-credentials",
      detected: Boolean(claudeLocalCreds),
      source: claudeLocalCreds?.source,
    },
    {
      kind: "cli",
      detected: Boolean(claudeCli?.installed),
      authenticated: claudeCli?.authenticated,
      verified: claudeCli?.verified,
      path: claudeCli?.path ?? null,
    },
  ];
  if (!claudeAuthAvailable && !claudeRuntimeDetected) {
    claude.blocker = "No Claude authentication or CLI was found locally.";
  } else if (!claudeAuthAvailable) {
    claude.blocker = "Claude CLI is installed but no login was detected. Run: claude auth login";
  } else if (!claudeRuntimeDetected) {
    claude.blocker = "Local credentials exist but the Claude CLI is not on ADE's PATH.";
  } else {
    claude.blocker = null;
  }
  // Only an explicit auth failure from the runtime probe should downgrade status.
  // Transient failures (aborted, timeout, exit code 1) should NOT override
  // the presence of valid local credentials + installed CLI.
  if (claudeRuntimeHealth?.state === "auth-failed") {
    claude.runtimeAvailable = false;
    claude.blocker = claudeRuntimeHealth.message
      ?? "Claude runtime was detected, but ADE chat reported that login is still required.";
  } else if (claudeRuntimeHealth?.state === "ready") {
    claude.runtimeAvailable = true;
    claude.authAvailable = true;
    claude.blocker = null;
  }
  // Note: "runtime-failed" is deliberately ignored — transient probe failures
  // (process abort, timeout) should not block a user who has valid credentials.

  const codex = createUnavailableStatus("codex", checkedAt);
  codex.authAvailable = codexAuthAvailable;
  codex.runtimeDetected = codexRuntimeDetected;
  codex.runtimeAvailable = codexRuntimeAvailable;
  codex.usageAvailable = codexUsageAvailable;
  codex.path = codexCli?.path ?? null;
  codex.sources = [
    {
      kind: "local-credentials",
      detected: Boolean(codexLocalCreds),
      source: codexLocalCreds?.source,
      stale: Boolean(codexLocalCreds && isCodexTokenStale(codexLocalCreds)),
    },
    {
      kind: "cli",
      detected: Boolean(codexCli?.installed),
      authenticated: codexCli?.authenticated,
      verified: codexCli?.verified,
      path: codexCli?.path ?? null,
    },
  ];
  if (!codexAuthAvailable && !codexRuntimeDetected) {
    codex.blocker = "No Codex authentication or CLI was found locally.";
  } else if (!codexAuthAvailable) {
    codex.blocker = "Codex CLI is installed but no login was detected. Run: codex login";
  } else if (!codexRuntimeDetected) {
    codex.blocker = "Local credentials exist but the Codex CLI is not on ADE's PATH.";
  } else if (codexLocalCreds && isCodexTokenStale(codexLocalCreds)) {
    codex.blocker = "Codex local auth exists, but the stored token looks stale for usage polling.";
  } else {
    codex.blocker = null;
  }
  if (codexRuntimeHealth?.state === "auth-failed") {
    codex.runtimeAvailable = false;
    codex.blocker = codexRuntimeHealth.message
      ?? "Codex runtime was detected, but ADE chat reported that login is still required.";
  } else if (codexRuntimeHealth?.state === "ready") {
    codex.runtimeAvailable = true;
    codex.authAvailable = true;
    codex.blocker = null;
  }

  return { claude, codex };
}
