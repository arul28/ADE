import type { AiProviderConnectionStatus, AiProviderConnections } from "../../../shared/types";
import type { CliAuthStatus } from "./authDetector";
import type { CopilotSdkRuntimeResolution } from "./acpExecutables";
import {
  isCodexTokenStale,
  readClaudeCredentials,
  readCodexCredentials,
} from "./providerCredentialSources";
import {
  resolveProviderAccounts,
  type ProviderAccountIdentity,
} from "../usage/providerAccountIdentity";
import { getAllApiKeys } from "./apiKeyStore";
import { getCursorSdkAuthSnapshot } from "./cursorSdkAuth";
import { inspectMuseCredentials } from "./museAuth";
import { museBinaryBlocker, resolveMuseExecutable } from "./museExecutable";
import { getProviderRuntimeHealth } from "./providerRuntimeHealth";
import { isCursorAdminApiKey } from "./utils";
import {
  CURSOR_WINDOWS_ARM_BLOCKER,
  isCursorProviderSupported,
} from "../../../shared/providerPlatformSupport";
import type { PiInstallation, PiProfileInventory } from "./piInstallation";
import { nowIso } from "../shared/utils";
import {
  ACP_PROVIDER_IDS,
  ACP_PROVIDER_METADATA,
  type AcpProviderId,
} from "../../../shared/acpProviderMetadata";
import { COPILOT_TOKEN_ENV_KEYS } from "../shared/providerConfigHomes";
import { pinnedToolForProvider, pinnedToolState } from "./pinnedProviderTools";
import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";

/**
 * Why a provider's runtime is not on this machine: the reason the CLI status
 * carried, else the tools cache's own reading. Every provider runs ADE's own
 * pinned copy, so this is a download state, never "install the CLI".
 */
function runtimeMissingBlocker(provider: string, cli: CliAuthStatus | null): string {
  if (cli?.pinnedBlocker) return cli.pinnedBlocker;
  const tool = pinnedToolForProvider(provider);
  return (tool ? pinnedToolState(tool.tool, tool.label).blocker : null)
    ?? `ADE could not find its ${provider} runtime on this machine.`;
}

/**
 * True when the CLI snapshot says ADE's copy is missing but the tools cache,
 * read live, says it is ready. The snapshot is cached for up to a minute and
 * is taken once around launch, so it can trail the cache; reading "missing"
 * then gave the false "ADE could not find its claude runtime" banner over a
 * chat that was running fine. The tools cache wins, and the disagreement goes
 * to Sentry so its cause can be found.
 */
function pinnedRuntimeReadyDespiteSnapshot(provider: string, cli: CliAuthStatus | null): boolean {
  if (cli?.installed) return false;
  const tool = pinnedToolForProvider(provider);
  if (!tool || pinnedToolState(tool.tool, tool.label).state !== "ready") return false;
  forwardSignalToSentry("ai.provider_status.stale_runtime_snapshot", {
    provider,
    snapshotState: cli?.pinnedState ?? null,
    snapshotPresent: Boolean(cli),
  }, `ai.provider_status.stale_runtime_snapshot:${provider}`);
  return true;
}

/** What the Copilot SDK runtime reported when ADE asked it who is signed in. */
export type CopilotSdkAuthProbe = {
  /** The runtime ADE starts for Copilot chats; only `fallback-command` means none was found. */
  runtime: CopilotSdkRuntimeResolution;
  /** Null when the probe itself failed; the disk check speaks instead. */
  auth: { isAuthenticated: boolean; login?: string; authType?: string; statusMessage?: string } | null;
};

/**
 * Why Copilot is signed out, in words the user can act on. A token in the
 * environment wins over `copilot login`, so a bad one must be named: signing
 * in again would not help.
 */
function copilotSignedOutBlocker(probe: CopilotSdkAuthProbe["auth"], env: NodeJS.ProcessEnv): string {
  const tokenKey = COPILOT_TOKEN_ENV_KEYS.find((key) => env[key]?.trim());
  if (tokenKey) {
    const classic = (env[tokenKey]?.trim() ?? "").startsWith("ghp_");
    return classic
      ? `${tokenKey} holds a classic GitHub token, which Copilot does not accept, and it overrides your Copilot login. Unset ${tokenKey} or replace it with a fine-grained token that has the Copilot Requests permission, then refresh.`
      : `Copilot rejected the token in ${tokenKey}, which overrides your Copilot login. Fix or unset ${tokenKey}, then refresh.`;
  }
  const detail = probe?.statusMessage?.trim();
  return `${detail ? `${detail.replace(/\.$/, "")}. ` : ""}Sign in with \`copilot login\` or \`gh auth login\`, then refresh.`;
}

function buildCopilotConnection(
  cli: CliAuthStatus | null,
  probe: CopilotSdkAuthProbe | null | undefined,
  checkedAt: string,
  env: NodeJS.ProcessEnv,
): AiProviderConnectionStatus {
  const runtimePath = probe?.runtime.path ?? cli?.path ?? null;
  const runtimeDetected = probe ? probe.runtime.source !== "fallback-command" : Boolean(cli?.installed);
  // The SDK's live answer beats the disk heuristic, which misses keychain and
  // `gh` logins and keeps stale ones.
  // Copilot runs on ADE's runtime, so the disk check counts with no CLI installed.
  const authAvailable = probe?.auth ? probe.auth.isAuthenticated : Boolean(cli?.authenticated);
  const verified = Boolean(probe?.auth);
  return {
    ...createUnavailableStatus("copilot", checkedAt),
    authAvailable,
    runtimeDetected,
    runtimeAvailable: authAvailable && runtimeDetected,
    usageAvailable: authAvailable,
    path: runtimePath,
    sources: [{ kind: "cli", detected: runtimeDetected, authenticated: authAvailable, verified, path: runtimePath }],
    blocker: !runtimeDetected
      ? copilotRuntimeMissingBlocker(cli, authAvailable)
      : !authAvailable ? copilotSignedOutBlocker(probe?.auth ?? null, env) : null,
  };
}

function copilotRuntimeMissingBlocker(cli: CliAuthStatus | null, authAvailable: boolean): string {
  const state = cli?.pinnedState ?? pinnedToolState("copilot", "the Copilot runtime").state;
  if (state !== "missing") return runtimeMissingBlocker("copilot", cli);
  return authAvailable
    ? "ADE has not downloaded the Copilot runtime on this machine yet. Refresh to download it."
    : "ADE has not downloaded the Copilot runtime on this machine yet. Sign in with `copilot login` or `gh auth login` and refresh, and ADE downloads it.";
}

function createUnavailableStatus(
  provider: "claude" | "codex" | "cursor" | "droid" | "pi" | "muse" | "copilot" | AcpProviderId,
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
  options?: {
    piInstallation?: PiInstallation | null;
    piInventory?: PiProfileInventory | null;
    copilot?: CopilotSdkAuthProbe | null;
  },
): Promise<AiProviderConnections> {
  const checkedAt = nowIso();
  const claudeCli = cliStatuses.find((entry) => entry.cli === "claude") ?? null;
  const codexCli = cliStatuses.find((entry) => entry.cli === "codex") ?? null;
  const [claudeLocalCreds, codexLocalCreds, accountIdentities] = await Promise.all([
    readClaudeCredentials(),
    readCodexCredentials(),
    // The same reader the usage poller uses, so Settings > Providers and the
    // Limits cards can never name two different accounts for one provider. It
    // is total by construction, so there is no catch here.
    resolveProviderAccounts(),
  ]);
  const claudeRuntimeHealth = getProviderRuntimeHealth("claude");
  const codexRuntimeHealth = getProviderRuntimeHealth("codex");
  const cursorRuntimeHealth = getProviderRuntimeHealth("cursor");
  const piRuntimeHealth = getProviderRuntimeHealth("pi");

  const deriveProviderFlags = (
    provider: "claude" | "codex",
    cli: CliAuthStatus | null,
    localCreds: Awaited<ReturnType<typeof readClaudeCredentials>> | Awaited<ReturnType<typeof readCodexCredentials>>,
  ) => {
    // `installed` is ADE's own pinned copy, the only one chats run on.
    const runtimeDetected = Boolean(cli?.installed) || pinnedRuntimeReadyDespiteSnapshot(provider, cli);
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

  const claudeFlags = deriveProviderFlags("claude", claudeCli, claudeLocalCreds);
  const codexFlags = deriveProviderFlags("codex", codexCli, codexLocalCreds);
  const codexUsageAvailable = Boolean(codexLocalCreds && !isCodexTokenStale(codexLocalCreds));

  function resolveBlocker(
    provider: "claude" | "codex",
    providerLabel: string,
    loginHint: string,
    flags: ReturnType<typeof deriveProviderFlags>,
    cli: CliAuthStatus | null,
    extraBlocker?: string | null,
  ): string | null {
    if (!flags.runtimeDetected) {
      const missing = runtimeMissingBlocker(provider, cli);
      return flags.authAvailable ? missing : `${missing} No ${providerLabel} login was found either. Run: ${loginHint}`;
    }
    if (flags.cliExplicitlyUnauthenticated) {
      return flags.localCredsDetected
        ? `Local ${providerLabel} credentials were found, but ${providerLabel} reports no active login. Run: ${loginHint}`
        : `No ${providerLabel} login was detected. Run: ${loginHint}`;
    }
    if (!flags.authAvailable) {
      return `No ${providerLabel} login was detected. Run: ${loginHint}`;
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
    status.blocker = args.provider === "claude" || args.provider === "codex"
      ? resolveBlocker(args.provider, args.label, args.loginHint, args.flags, args.cli, args.extraBlocker)
      : args.extraBlocker ?? null;
    // Plain read: `resolveProviderAccounts` already carries the last-known
    // account across a config that exists but could not be read, and already
    // clears it on a real sign-out, so Settings > Providers and the Limits
    // cards cannot name different accounts for one provider.
    const account: ProviderAccountIdentity | undefined =
      args.provider === "claude" || args.provider === "codex"
        ? accountIdentities.identities[args.provider]
        : undefined;
    if (account?.email) status.accountEmail = account.email;
    if (account?.plan) status.accountPlan = account.plan;
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
  const cursorAuthSnapshot = await getCursorSdkAuthSnapshot();
  let cursorStoredAuth = cursorAuthSnapshot.adeKeyPresent;
  let cursorStoredUsageAuth = false;
  let cursorStoreUnavailable = cursorAuthSnapshot.storeUnavailable;
  if (cursorStoredAuth) {
    try {
      const storedCursorKey = getAllApiKeys().cursor?.trim() ?? "";
      cursorStoredUsageAuth = isCursorAdminApiKey(storedCursorKey);
    } catch {
      cursorStoreUnavailable = true;
    }
  }
  // ADE store first, then CURSOR_API_KEY. An OAuth-minted stored key counts as
  // connected; ~/.cursor/sdk/auth.json alone does not.
  const cursorSdkAuth = Boolean(cursorAuthSnapshot.adeKeyPresent || cursorEnvAuth);
  const cursorUsageAuth = Boolean(cursorEnvUsageAuth || cursorStoredUsageAuth || cursorAdminUsageAuth);
  const cursorAuthAvailable = Boolean(cursorSdkAuth || cursorUsageAuth);
  const cursorCredsSource = cursorAuthSnapshot.credentialSource
    ?? (cursorEnvAuth
      ? "cursor-env" as const
      : cursorStoredAuth
        ? "cursor-api-key-store" as const
        : cursorAdminEnvAuth
          ? "cursor-admin-env" as const
          : undefined);
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
    cursorBlocker = "Sign in with Cursor or enter a Cursor API key from https://cursor.com/dashboard/api.";
  }

  const cursor: AiProviderConnectionStatus = {
    ...createUnavailableStatus("cursor", checkedAt),
    authAvailable: cursorFlags.authAvailable,
    runtimeDetected: cursorFlags.runtimeDetected,
    runtimeAvailable: cursorFlags.runtimeAvailable,
    usageAvailable: cursorSupported && cursorUsageAuth,
    path: cursorSupported ? "@cursor/sdk" : null,
    ...(cursorAuthSnapshot.email ? { accountEmail: cursorAuthSnapshot.email } : {}),
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
  if (!droidFlags.runtimeDetected) {
    droidBlocker = runtimeMissingBlocker("droid", droidCli);
  } else if (!droidFlags.authAvailable) {
    droidBlocker = "No Droid credentials were detected. Set FACTORY_API_KEY or sign in with Droid (`droid`).";
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

  const piInstallation = options?.piInstallation ?? null;
  const piInventory = options?.piInventory ?? null;
  const piConfiguredProviderCount = piInventory?.providers.filter((provider) => provider.configured).length ?? 0;
  const piAvailableModelCount = piInventory?.availableModelIds.length ?? 0;
  const piAuthAvailable = piConfiguredProviderCount > 0;
  const piRuntimeDetected = Boolean(piInstallation?.sdkAvailable || piInstallation?.cliAvailable);
  const piRuntimeAvailable = Boolean(piInstallation?.sdkAvailable && piAvailableModelCount > 0);
  let piBlocker = piInstallation?.blocker ?? null;
  if (!piBlocker) {
    if (!piRuntimeDetected) {
      piBlocker = runtimeMissingBlocker("pi", null);
    } else if (!piAuthAvailable) {
      piBlocker = "No Pi providers are configured yet. Use Pi /login or edit auth.json/models.json.";
    } else if (!piRuntimeAvailable) {
      piBlocker = "Pi is configured, but no Pi models are currently available. Check auth.json or models.json.";
    }
  }
  const pi: AiProviderConnectionStatus | undefined = piInstallation || piInventory
    ? {
        ...createUnavailableStatus("pi", checkedAt),
        authAvailable: piAuthAvailable,
        runtimeDetected: piRuntimeDetected,
        runtimeAvailable: piRuntimeAvailable,
        usageAvailable: false,
        path: piInstallation?.cliPath ?? piInstallation?.packageRoot ?? null,
        sources: [
          {
            kind: "local-credentials",
            detected: Boolean(piInventory?.authFileDetected || piInventory?.modelsFileDetected),
            source: piInventory?.authFileDetected ? "pi-auth-file" : piInventory?.modelsFileDetected ? "pi-models-file" : undefined,
            authenticated: piAuthAvailable,
            verified: piAuthAvailable,
            path: piInventory?.authFileDetected
              ? piInstallation?.authPath ?? null
              : piInventory?.modelsFileDetected
                ? piInstallation?.modelsPath ?? null
                : null,
          },
          {
            kind: "cli",
            detected: Boolean(piInstallation?.cliPath),
            authenticated: piRuntimeAvailable,
            verified: Boolean(piInstallation?.sdkAvailable),
            path: piInstallation?.cliPath ?? null,
          },
        ],
        blocker: piBlocker,
      }
    : undefined;
  if (pi) applyRuntimeHealth(pi, piRuntimeHealth);

  const muse = buildMuseConnection(checkedAt);
  applyRuntimeHealth(muse, getProviderRuntimeHealth("muse"));

  const acpConnections: Partial<Record<AcpProviderId, AiProviderConnectionStatus>> = {};
  for (const provider of ACP_PROVIDER_IDS) {
    const metadata = ACP_PROVIDER_METADATA[provider];
    const cli = cliStatuses.find((status) => status.cli === provider) ?? null;
    const runtimeDetected = Boolean(cli?.installed);
    // Credentials are read off disk, so a signed-in provider whose pinned copy
    // is still downloading reads as signed in and downloading.
    const authAvailable = Boolean(cli?.authenticated);
    const health = getProviderRuntimeHealth(provider);
    const status: AiProviderConnectionStatus = {
      ...createUnavailableStatus(provider, checkedAt),
      authAvailable,
      runtimeDetected,
      runtimeAvailable: authAvailable && runtimeDetected,
      // No dialect reports usage through a channel ADE polls yet. Kimi does not
      // report it at all; the rest fold it into prompt results, which only the
      // ACP host sees.
      usageAvailable: false,
      path: cli?.path ?? null,
      sources: [
        {
          kind: "cli",
          detected: runtimeDetected,
          authenticated: cli?.authenticated,
          // Always false for these: a credential file on disk is not proof the
          // credential still works, and saying otherwise would make a stale
          // login read as connected.
          verified: cli?.verified,
          path: cli?.path ?? null,
        },
      ],
      blocker: !runtimeDetected
        ? runtimeMissingBlocker(provider, cli)
        : !authAvailable
          ? metadata.loginCommand
            ? `No ${metadata.statusLabel} login was detected. Run: ${metadata.loginHint}`
            : `No ${metadata.statusLabel} login was detected: ${metadata.loginHint}.`
          : null,
    };
    applyRuntimeHealth(status, health);
    acpConnections[provider] = status;
  }

  const copilot = buildCopilotConnection(
    cliStatuses.find((status) => status.cli === "copilot") ?? null,
    options?.copilot,
    checkedAt,
    process.env,
  );
  applyRuntimeHealth(copilot, getProviderRuntimeHealth("copilot"));

  return {
    claude,
    codex,
    cursor,
    droid,
    ...(pi ? { pi } : {}),
    muse,
    ...acpConnections,
    copilot,
  };
}

/**
 * Muse runs only from ADE's pinned build, so "installed" means "the pinned
 * build is in the tools cache", never "a `muse` is on PATH". Sign-in is read
 * from `META_API_KEY`, a key saved in ADE, or Muse's `auth.json`.
 *
 * On macOS Muse keeps its login token in the Keychain, which a status poll
 * must not read, so a signed-in Mac can show no credential file. There the
 * pinned build alone is enough to offer chat: the first session reports
 * `ready` or `auth-failed` through runtime health, which then corrects this.
 */
function buildMuseConnection(checkedAt: string): AiProviderConnectionStatus {
  const binary = resolveMuseExecutable();
  const credentials = inspectMuseCredentials();
  const runtimeDetected = binary.path != null;
  const authAvailable = credentials.source != null;
  const keychainMayHoldLogin = process.platform === "darwin";
  const runtimeAvailable = runtimeDetected && (authAvailable || keychainMayHoldLogin);

  let blocker: string | null = museBinaryBlocker(binary);
  if (!blocker && !authAvailable) {
    blocker = keychainMayHoldLogin
      ? "No Muse sign-in file was found. If you signed in, Muse keeps it in the macOS Keychain and your first chat confirms it; otherwise sign in or add a Meta API key."
      : "Muse is not signed in. Sign in or add a Meta API key.";
  }

  return {
    ...createUnavailableStatus("muse", checkedAt),
    authAvailable,
    runtimeDetected,
    runtimeAvailable,
    usageAvailable: false,
    path: binary.path,
    sources: [
      {
        kind: "local-credentials",
        detected: authAvailable,
        source: credentials.source ?? undefined,
        path: credentials.source === "muse-auth-file" ? credentials.authFilePath : null,
      },
      {
        kind: "cli",
        detected: runtimeDetected,
        path: binary.path,
      },
    ],
    blocker,
  };
}
