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

  const deriveProviderFlags = (
    cli: CliAuthStatus | null,
    localCreds: Awaited<ReturnType<typeof readClaudeCredentials>> | Awaited<ReturnType<typeof readCodexCredentials>>,
  ) => {
    const runtimeDetected = Boolean(cli?.installed);
    const cliAuthenticated = Boolean(cli?.installed && cli.authenticated);
    const cliExplicitlyUnauthenticated = Boolean(cli?.installed && cli.verified && !cli.authenticated);
    const localCredsDetected = Boolean(localCreds);
    const authAvailable = Boolean(localCreds || cliAuthenticated);
    // Local credential artifacts are only a fallback signal. If the CLI itself
    // has already verified that the user is signed out, do not promote the
    // provider to runtime-ready until the user logs in again.
    const runtimeAvailable = Boolean(authAvailable && runtimeDetected && !cliExplicitlyUnauthenticated);
    return { runtimeDetected, cliAuthenticated, cliExplicitlyUnauthenticated, localCredsDetected, authAvailable, runtimeAvailable };
  };

  const claudeFlags = deriveProviderFlags(claudeCli, claudeLocalCreds);
  const codexFlags = deriveProviderFlags(codexCli, codexLocalCreds);
  const codexUsageAvailable = Boolean(codexLocalCreds && !isCodexTokenStale(codexLocalCreds));

  function resolveBlocker(
    providerLabel: string,
    loginHint: string,
    flags: ReturnType<typeof deriveProviderFlags>,
    extraBlocker?: string | null,
  ): string | null {
    if (!flags.authAvailable && !flags.runtimeDetected) {
      return `No ${providerLabel} authentication or CLI was found locally.`;
    }
    if (flags.cliExplicitlyUnauthenticated) {
      return flags.localCredsDetected
        ? `Local ${providerLabel} credentials were found, but ${providerLabel} CLI reports no active login. Run: ${loginHint}`
        : `${providerLabel} CLI is installed but no login was detected. Run: ${loginHint}`;
    }
    if (!flags.authAvailable) {
      return `${providerLabel} CLI is installed but no login was detected. Run: ${loginHint}`;
    }
    if (!flags.runtimeDetected) {
      return `Local credentials exist but the ${providerLabel} CLI is not on ADE's PATH.`;
    }
    if (extraBlocker) return extraBlocker;
    return null;
  }

  // Apply runtime health overrides.
  // Only an explicit auth failure should downgrade status. Transient probe
  // failures (process abort, timeout) should not block a user with valid creds.
  function applyRuntimeHealth(
    status: AiProviderConnectionStatus,
    health: ReturnType<typeof getProviderRuntimeHealth>,
  ): void {
    if (health?.state === "auth-failed") {
      status.runtimeAvailable = false;
      status.blocker = health.message
        ?? `${status.provider} runtime was detected, but ADE chat reported that login is still required.`;
    } else if (health?.state === "ready") {
      status.runtimeAvailable = true;
      status.authAvailable = true;
      status.blocker = null;
    }
  }

  const claude = createUnavailableStatus("claude", checkedAt);
  claude.authAvailable = claudeFlags.authAvailable;
  claude.runtimeDetected = claudeFlags.runtimeDetected;
  claude.runtimeAvailable = claudeFlags.runtimeAvailable;
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
  claude.blocker = resolveBlocker("Claude", "claude auth login", claudeFlags);
  applyRuntimeHealth(claude, claudeRuntimeHealth);

  const codex = createUnavailableStatus("codex", checkedAt);
  codex.authAvailable = codexFlags.authAvailable;
  codex.runtimeDetected = codexFlags.runtimeDetected;
  codex.runtimeAvailable = codexFlags.runtimeAvailable;
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
  codex.blocker = resolveBlocker(
    "Codex",
    "codex login",
    codexFlags,
    codexLocalCreds && isCodexTokenStale(codexLocalCreds)
      ? "Codex local auth exists, but the stored token looks stale for usage polling."
      : null,
  );
  applyRuntimeHealth(codex, codexRuntimeHealth);

  return { claude, codex };
}
