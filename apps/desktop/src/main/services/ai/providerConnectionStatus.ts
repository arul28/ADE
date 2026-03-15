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
  const claudeRuntimeAvailable = Boolean(
    claudeCli?.installed && claudeCli.authenticated,
  );
  const claudeAuthAvailable = Boolean(claudeLocalCreds || claudeRuntimeAvailable);

  const codexRuntimeDetected = Boolean(codexCli?.installed);
  const codexRuntimeAvailable = Boolean(
    codexCli?.installed && codexCli.authenticated,
  );
  const codexUsageAvailable = Boolean(codexLocalCreds && !isCodexTokenStale(codexLocalCreds));
  const codexAuthAvailable = Boolean(codexLocalCreds || codexRuntimeAvailable);

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
  if (!claudeAuthAvailable) {
    claude.blocker = "No Claude authentication was found locally.";
  } else if (!claudeRuntimeDetected) {
    claude.blocker = "Claude auth is available, but the Claude CLI runtime is not on ADE's PATH.";
  } else if (!claudeRuntimeAvailable) {
    claude.blocker = "Claude CLI is installed, but ADE could not verify an active Claude login.";
  } else {
    claude.blocker = null;
  }
  if (claudeRuntimeHealth?.state === "auth-failed") {
    claude.runtimeAvailable = false;
    claude.blocker = claudeRuntimeHealth.message
      ?? "Claude runtime was detected, but ADE chat reported that login is still required.";
  } else if (claudeRuntimeHealth?.state === "runtime-failed") {
    claude.runtimeAvailable = false;
    claude.blocker = claudeRuntimeHealth.message
      ?? "Claude runtime was detected, but ADE chat could not launch it successfully.";
  } else if (claudeRuntimeHealth?.state === "ready" && claudeRuntimeAvailable) {
    // Only confirm "ready" when auth is already confirmed — don't let a stale
    // runtime probe override a negative auth check.
    claude.blocker = null;
  }

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
  if (!codexAuthAvailable) {
    codex.blocker = "No Codex authentication was found locally.";
  } else if (!codexRuntimeDetected) {
    codex.blocker = "Codex auth is available, but the Codex CLI runtime is not on ADE's PATH.";
  } else if (!codexRuntimeAvailable) {
    codex.blocker = "Codex CLI is installed, but ADE could not verify an active Codex login.";
  } else if (codexLocalCreds && isCodexTokenStale(codexLocalCreds)) {
    codex.blocker = "Codex local auth exists, but the stored token looks stale for usage polling.";
  } else {
    codex.blocker = null;
  }
  if (codexRuntimeHealth?.state === "auth-failed") {
    codex.runtimeAvailable = false;
    codex.blocker = codexRuntimeHealth.message
      ?? "Codex runtime was detected, but ADE chat reported that login is still required.";
  } else if (codexRuntimeHealth?.state === "runtime-failed") {
    codex.runtimeAvailable = false;
    codex.blocker = codexRuntimeHealth.message
      ?? "Codex runtime was detected, but ADE chat could not launch it successfully.";
  } else if (codexRuntimeHealth?.state === "ready" && codexRuntimeAvailable) {
    codex.blocker = null;
  }

  return { claude, codex };
}
