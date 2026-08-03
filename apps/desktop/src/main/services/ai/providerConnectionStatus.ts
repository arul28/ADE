import type { AiProviderConnectionStatus, AiProviderConnections } from "../../../shared/types";
import type { CliAuthStatus } from "./authDetector";
import {
  isCodexTokenStale,
  readClaudeCredentials,
  readCodexCredentials,
} from "./providerCredentialSources";
import { getAllApiKeys } from "./apiKeyStore";
import { getProviderRuntimeHealth } from "./providerRuntimeHealth";
import { isCursorAdminApiKey } from "./utils";
import {
  CURSOR_WINDOWS_ARM_BLOCKER,
  isCursorProviderSupported,
} from "../../../shared/providerPlatformSupport";
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
  const cursorRuntimeHealth = getProviderRuntimeHealth("cursor");

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
      // The login-shell/interactive-shell PATH probe is a POSIX-only step —
      // `augmentProcessPathWithShellAndKnownCliDirs` skips it on Windows — so
      // do not claim it happened, and give the right place to fix PATH.
      return process.platform === "win32"
        ? `Local credentials exist but ADE could not find the ${providerLabel} CLI. ADE checks the app PATH (honouring PATHEXT) and the common Windows install directories: %APPDATA%\\npm, %USERPROFILE%\\.local\\bin, %LOCALAPPDATA%\\Programs, %LOCALAPPDATA%\\Microsoft\\WinGet\\Links. If ${providerLabel} is installed elsewhere, add that folder to your PATH in System Properties -> Environment Variables, reopen ADE, and refresh.`
        : `Local credentials exist but ADE could not find the ${providerLabel} CLI. ADE checks the app PATH, login-shell PATH, interactive-shell PATH, and common install directories. If ${providerLabel} is installed elsewhere, add that bin directory to your shell PATH and refresh.`;
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
      if (status.provider !== "cursor") {
        status.usageAvailable = false;
      }
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
    loginHint: "claude auth login or set ANTHROPIC_API_KEY",
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

  // Windows on ARM ships no @cursor/sdk runtime, so Cursor is reported as hard
  // unavailable before any key or runtime-health work happens. See
  // shared/providerPlatformSupport.ts for the reason and the revisit condition.
  // This is the authoritative decision point: `availableProviders.cursor`, the
  // cursor-family model filter and every settings/onboarding surface downstream
  // all derive from the connection built here.
  const cursorSupported = isCursorProviderSupported(process.platform, process.arch);

  const cursorCli = cliStatuses.find((entry) => entry.cli === "cursor") ?? null;
  const cursorEnvKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  const cursorAdminEnvKey = process.env.CURSOR_ADMIN_API_KEY?.trim() ?? "";
  const cursorEnvAuth = Boolean(cursorEnvKey);
  const cursorEnvUsageAuth = isCursorAdminApiKey(cursorEnvKey);
  const cursorAdminEnvAuth = Boolean(cursorAdminEnvKey);
  const cursorAdminUsageAuth = isCursorAdminApiKey(cursorAdminEnvKey);
  let cursorStoredAuth = false;
  let cursorStoredUsageAuth = false;
  let cursorStoreUnavailable = false;
  try {
    const storedCursorKey = getAllApiKeys().cursor?.trim() ?? "";
    cursorStoredAuth = Boolean(storedCursorKey);
    cursorStoredUsageAuth = isCursorAdminApiKey(storedCursorKey);
  } catch {
    // API key store may not be initialized yet (or read failed); surface as a
    // distinct state so the blocker copy doesn't lie about the absence of a key.
    cursorStoreUnavailable = true;
  }
  const cursorSdkAuth = Boolean(cursorEnvAuth || cursorStoredAuth);
  const cursorUsageAuth = Boolean(cursorEnvUsageAuth || cursorStoredUsageAuth || cursorAdminUsageAuth);
  const cursorAuthAvailable = Boolean(cursorSdkAuth || cursorUsageAuth);
  let cursorCredsSource: "cursor-env" | "cursor-api-key-store" | "cursor-admin-env" | undefined;
  if (cursorEnvAuth) cursorCredsSource = "cursor-env";
  else if (cursorStoredAuth) cursorCredsSource = "cursor-api-key-store";
  else if (cursorAdminEnvAuth) cursorCredsSource = "cursor-admin-env";
  // The SDK package is bundled with the app, but Cursor chat is only runtime
  // ready after verification/model discovery proves the SDK can load and the
  // key can access agent models.
  const cursorFlags = {
    runtimeDetected: cursorSupported,
    cliAuthenticated: false,
    cliExplicitlyUnauthenticated: false,
    localCredsDetected: cursorSupported && cursorAuthAvailable,
    authAvailable: cursorSupported && cursorAuthAvailable,
    runtimeAvailable: cursorSupported && cursorRuntimeHealth?.state === "ready",
  };

  let cursorBlocker: string | null;
  if (!cursorSupported) {
    cursorBlocker = CURSOR_WINDOWS_ARM_BLOCKER;
  } else if (cursorFlags.runtimeAvailable) {
    cursorBlocker = null;
  } else if (cursorSdkAuth) {
    cursorBlocker = "Verify the Cursor API key to enable Cursor chat.";
  } else if (cursorAdminUsageAuth) {
    cursorBlocker = "Cursor Admin API key is configured for usage; add a Cursor agent API key for Cursor runtime access.";
  } else if (cursorAdminEnvAuth) {
    cursorBlocker = "CURSOR_ADMIN_API_KEY is set but does not look like a Cursor Admin API key.";
  } else if (cursorStoreUnavailable) {
    cursorBlocker = "ADE could not read the Cursor API key store yet. Retry after the key store is ready.";
  } else {
    cursorBlocker = "Enter a Cursor API key from https://cursor.com/dashboard/api.";
  }

  const cursor: AiProviderConnectionStatus = {
    ...createUnavailableStatus("cursor", checkedAt),
    authAvailable: cursorFlags.authAvailable,
    runtimeDetected: cursorFlags.runtimeDetected,
    runtimeAvailable: cursorFlags.runtimeAvailable,
    usageAvailable: cursorSupported && cursorUsageAuth,
    path: cursorSupported ? "@cursor/sdk" : null,
    sources: cursorSupported
      ? [
        {
          kind: "local-credentials",
          detected: cursorAuthAvailable,
          source: cursorCredsSource,
        },
        {
          kind: "cli",
          detected: Boolean(cursorCli?.installed),
          authenticated: cursorCli?.authenticated,
          verified: cursorCli?.verified,
          path: cursorCli?.path ?? null,
        },
      ]
      : [],
    blocker: cursorBlocker,
  };
  // Runtime health can only promote the connection, so it must not run once the
  // platform gate has decided Cursor is unavailable.
  if (cursorSupported) applyRuntimeHealth(cursor, cursorRuntimeHealth);

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
