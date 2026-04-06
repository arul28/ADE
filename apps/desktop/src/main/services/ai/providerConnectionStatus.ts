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
  provider: "claude" | "codex" | "cursor" | "droid",
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
      return `Local credentials exist but ADE could not find the ${providerLabel} CLI. ADE checks the app PATH, login-shell PATH, interactive-shell PATH, and common install directories. If ${providerLabel} is installed elsewhere, add that bin directory to your shell PATH and refresh.`;
    }
    if (extraBlocker) return extraBlocker;
    return null;
  }

  // Apply runtime health overrides.
  // If ADE cannot launch the actual provider runtime from this app session,
  // surface that as not runtime-available even when auth artifacts exist.
  function applyRuntimeHealth(
    status: AiProviderConnectionStatus,
    health: ReturnType<typeof getProviderRuntimeHealth> | null,
  ): void {
    if (!health) return;
    if (health.state === "auth-failed" || health.state === "runtime-failed") {
      status.runtimeAvailable = false;
      status.blocker = health.message
        ?? (health.state === "auth-failed"
          ? `${status.provider} runtime was detected, but ADE chat reported that login is still required.`
          : `${status.provider} runtime was detected, but ADE could not launch it from this app session.`);
    } else if (health.state === "ready") {
      status.runtimeAvailable = true;
      status.authAvailable = true;
      status.blocker = null;
    }
  }

  function buildStatus(args: {
    provider: "claude" | "codex" | "cursor" | "droid";
    flags: ReturnType<typeof deriveProviderFlags>;
    usageAvailable: boolean;
    cli: CliAuthStatus | null;
    localCreds: Awaited<ReturnType<typeof readClaudeCredentials>> | Awaited<ReturnType<typeof readCodexCredentials>>;
    credentialExtras?: Record<string, unknown>;
    label: string;
    loginHint: string;
    extraBlocker?: string | null;
    health: ReturnType<typeof getProviderRuntimeHealth>;
  }): AiProviderConnectionStatus {
    const status = createUnavailableStatus(args.provider, checkedAt);
    status.authAvailable = args.flags.authAvailable;
    status.runtimeDetected = args.flags.runtimeDetected;
    status.runtimeAvailable = args.flags.runtimeAvailable;
    status.usageAvailable = args.usageAvailable;
    status.path = args.cli?.path ?? null;
    status.sources = [
      {
        kind: "local-credentials",
        detected: Boolean(args.localCreds),
        source: args.localCreds?.source,
        ...args.credentialExtras,
      },
      {
        kind: "cli",
        detected: Boolean(args.cli?.installed),
        authenticated: args.cli?.authenticated,
        verified: args.cli?.verified,
        path: args.cli?.path ?? null,
      },
    ];
    status.blocker = resolveBlocker(args.label, args.loginHint, args.flags, args.extraBlocker);
    applyRuntimeHealth(status, args.health);
    return status;
  }

  const claude = buildStatus({
    provider: "claude",
    flags: claudeFlags,
    usageAvailable: Boolean(claudeLocalCreds),
    cli: claudeCli,
    localCreds: claudeLocalCreds,
    label: "Claude",
    loginHint: "claude auth login",
    health: claudeRuntimeHealth,
  });

  const codexTokenStale = Boolean(codexLocalCreds && isCodexTokenStale(codexLocalCreds));
  const codex = buildStatus({
    provider: "codex",
    flags: codexFlags,
    usageAvailable: codexUsageAvailable,
    cli: codexCli,
    localCreds: codexLocalCreds,
    credentialExtras: { stale: codexTokenStale },
    label: "Codex",
    loginHint: "codex login",
    extraBlocker: codexTokenStale
      ? "Codex local auth exists, but the stored token looks stale for usage polling."
      : null,
    health: codexRuntimeHealth,
  });

  const cursorCli = cliStatuses.find((entry) => entry.cli === "cursor") ?? null;
  const cursorEnvAuth = Boolean(
    process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_AUTH_TOKEN?.trim(),
  );
  const cursorRuntimeDetected = Boolean(cursorCli?.installed);
  const cursorCliAuthenticated = Boolean(cursorCli?.installed && cursorCli.authenticated);
  const cursorExplicitlyUnauthenticated = Boolean(
    cursorCli?.installed && cursorCli.verified && !cursorCli.authenticated,
  );
  const cursorAuthAvailable = Boolean(cursorCliAuthenticated || cursorEnvAuth);
  const cursorRuntimeAvailable = Boolean(
    cursorAuthAvailable && cursorRuntimeDetected && !(cursorExplicitlyUnauthenticated && !cursorEnvAuth),
  );
  const cursorFlags = {
    runtimeDetected: cursorRuntimeDetected,
    cliAuthenticated: cursorCliAuthenticated,
    cliExplicitlyUnauthenticated: cursorExplicitlyUnauthenticated,
    localCredsDetected: cursorEnvAuth,
    authAvailable: cursorAuthAvailable,
    runtimeAvailable: cursorRuntimeAvailable,
  };

  let cursorBlocker: string | null = null;
  if (!cursorFlags.authAvailable && !cursorFlags.runtimeDetected) {
    cursorBlocker = "No Cursor CLI (`agent`) or Cursor credentials were found locally.";
  } else if (!cursorFlags.authAvailable) {
    cursorBlocker = "Cursor CLI (`agent`) is installed but no login was detected. Run: agent login";
  } else if (!cursorFlags.runtimeDetected) {
    cursorBlocker =
      "Cursor credentials exist, but ADE could not find the `agent` binary. Add Cursor’s CLI install directory to your PATH and refresh.";
  }

  const cursor: AiProviderConnectionStatus = {
    ...createUnavailableStatus("cursor", checkedAt),
    authAvailable: cursorFlags.authAvailable,
    runtimeDetected: cursorFlags.runtimeDetected,
    runtimeAvailable: cursorFlags.runtimeAvailable,
    usageAvailable: cursorFlags.runtimeAvailable,
    path: cursorCli?.path ?? null,
    sources: [
      { kind: "local-credentials", detected: cursorEnvAuth, source: cursorEnvAuth ? "cursor-env" : undefined },
      {
        kind: "cli",
        detected: Boolean(cursorCli?.installed),
        authenticated: cursorCli?.authenticated,
        verified: cursorCli?.verified,
        path: cursorCli?.path ?? null,
      },
    ],
    blocker: cursorBlocker,
  };
  // Cursor has no runtime-health probe yet.

  const droidCli = cliStatuses.find((entry) => entry.cli === "droid") ?? null;
  const factoryEnvAuth = Boolean(process.env.FACTORY_API_KEY?.trim());
  const droidRuntimeDetected = Boolean(droidCli?.installed);
  const droidCliOk = Boolean(droidCli?.installed && droidCli.authenticated);
  const droidExplicitlyBad = Boolean(droidCli?.installed && droidCli.verified && !droidCli.authenticated);
  const droidAuthAvailable = Boolean(droidCliOk || factoryEnvAuth);
  const droidRuntimeAvailable = Boolean(
    droidAuthAvailable && droidRuntimeDetected && !(droidExplicitlyBad && !factoryEnvAuth),
  );
  const droidFlags = {
    runtimeDetected: droidRuntimeDetected,
    cliAuthenticated: droidCliOk,
    cliExplicitlyUnauthenticated: droidExplicitlyBad,
    localCredsDetected: factoryEnvAuth,
    authAvailable: droidAuthAvailable,
    runtimeAvailable: droidRuntimeAvailable,
  };

  let droidBlocker: string | null = null;
  if (!droidFlags.authAvailable && !droidFlags.runtimeDetected) {
    droidBlocker = "No Factory Droid CLI (`droid`) or FACTORY_API_KEY was found locally.";
  } else if (!droidFlags.authAvailable) {
    droidBlocker =
      "Droid CLI is installed but no credentials were detected. Set FACTORY_API_KEY or sign in with the Factory CLI (`droid`).";
  } else if (!droidFlags.runtimeDetected) {
    droidBlocker =
      "FACTORY_API_KEY is set, but ADE could not find the `droid` binary. Add Factory CLI to your PATH and refresh.";
  }

  const droid: AiProviderConnectionStatus = {
    ...createUnavailableStatus("droid", checkedAt),
    authAvailable: droidFlags.authAvailable,
    runtimeDetected: droidFlags.runtimeDetected,
    runtimeAvailable: droidFlags.runtimeAvailable,
    usageAvailable: droidRuntimeAvailable,
    path: droidCli?.path ?? null,
    sources: [
      {
        kind: "local-credentials",
        detected: factoryEnvAuth,
        source: factoryEnvAuth ? "factory-env" : undefined,
      },
      {
        kind: "cli",
        detected: Boolean(droidCli?.installed),
        authenticated: droidCli?.authenticated,
        verified: droidCli?.verified,
        path: droidCli?.path ?? null,
      },
    ],
    blocker: droidBlocker,
  };

  return { claude, codex, cursor, droid };
}
