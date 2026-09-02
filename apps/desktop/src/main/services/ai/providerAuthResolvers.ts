/**
 * Whether each provider has credentials this machine can actually use.
 *
 * One row per shipped provider. Every row is a ladder of rungs, cheapest first,
 * and every row stops short of anything that could prompt: no macOS Keychain
 * read, no network. The single exception is a last-resort `auth status` spawn,
 * bounded by {@link PROVIDER_AUTH_STATUS_TIMEOUT_MS}, which runs only when the
 * CLI is installed and no cheaper rung could tell — being silently wrong about
 * a signed-in user is worse than one bounded process.
 *
 * A row that cannot tell says so through `detail` rather than guessing. The
 * probe loop in `providerStatusProbe.ts` joins that text onto the record.
 */

import os from "node:os";
import path from "node:path";
import { resolvePiInstallation } from "./piInstallation";
import type { ShippedProvider } from "../../../shared/providers";
import { getCachedCliAuthStatuses, parseJsonAuthStatus } from "./authDetector";
import { getCursorSdkAuthSnapshot } from "./cursorSdkAuth";
import { readClaudeCredentials, readCodexCredentials } from "./providerCredentialSources";
import {
  PROVIDER_AUTH_STATUS_TIMEOUT_MS,
  PROVIDER_STATUS_DETAILS,
} from "./providerStatusDetails";
import {
  defaultReadTextFile,
  runProviderCommand,
  type ProbeContext,
  type ProviderAuthResolver,
  type ProviderAuthResult,
} from "./providerProbeSeams";

// ---------------------------------------------------------------------------
// Per-provider credentials
// ---------------------------------------------------------------------------

function envKeyPresent(env: NodeJS.ProcessEnv, ...names: string[]): boolean {
  return names.some((name) => Boolean(env[name]?.trim()));
}

function homeDirFrom(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const candidate = platform === "win32"
    ? env.USERPROFILE?.trim() || env.HOME?.trim()
    : env.HOME?.trim();
  return candidate || os.homedir();
}

/**
 * Claude Code's own config file, which records an `oauthAccount` after a
 * browser sign-in.
 *
 * This is the rung that closes the real gap: on macOS the CLI's live token is
 * in the Keychain, which a background poll must not read, and the credentials
 * file next to it can be absent on a machine where Claude works fine. Reading
 * `~/.claude.json` is a plain file read that proves a sign-in happened without
 * a dialog and without a spawn.
 */
function claudeConfigOauthAccountPresent(context: ProbeContext): boolean {
  const configDir = context.env.CLAUDE_CONFIG_DIR?.trim();
  const configPath = configDir
    ? path.join(configDir, ".claude.json")
    : path.join(homeDirFrom(context.env, context.platform), ".claude.json");
  const raw = context.readTextFile(configPath);
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return false;
    const account = (parsed as Record<string, unknown>).oauthAccount;
    return typeof account === "object" && account !== null && Object.keys(account).length > 0;
  } catch {
    return false;
  }
}

/** The auth detector's cached verdict for one CLI, or null when the cache is cold. */
function cachedCliVerdict(cli: string): boolean | null {
  const entry = getCachedCliAuthStatuses().find((status) => status.cli === cli);
  return entry ? entry.authenticated : null;
}

/**
 * The last resort: ask the CLI itself.
 *
 * Every cheaper rung has already failed, and the alternative is telling a
 * signed-in user to log in. The cost is bounded — one spawn per provider per
 * cache TTL, only when the CLI is installed — and a timeout reports "could not
 * verify" rather than a confident "signed out".
 */
async function askCliForAuthStatus(
  binaryPath: string,
  args: readonly string[],
  context: ProbeContext,
): Promise<ProviderAuthResult> {
  const result = await runProviderCommand(binaryPath, args, context, PROVIDER_AUTH_STATUS_TIMEOUT_MS);
  if (result.failed) {
    return {
      authenticated: false,
      authMethod: null,
      detail: PROVIDER_STATUS_DETAILS.authStatusUnverified,
    };
  }
  const parsed = parseJsonAuthStatus(result.stdout);
  if (parsed) {
    return parsed.authenticated
      ? { authenticated: true, authMethod: "subscription" }
      : { authenticated: false, authMethod: null };
  }
  // No JSON to read. A zero exit from an auth-status subcommand is the only
  // other signal, and it is weak enough to label "unknown" rather than name a
  // method ADE did not observe.
  if (result.exitCode === 0) {
    return { authenticated: true, authMethod: "unknown" };
  }
  return { authenticated: false, authMethod: null };
}

export const DEFAULT_AUTH: Record<ShippedProvider, ProviderAuthResolver> = {
  /**
   * Four rungs, cheapest first, because the expensive one is a spawn and the
   * wrong answer is worse than the cost. `allowKeychain: false` is load-bearing:
   * a Keychain read can put a macOS unlock dialog in front of the user, and a
   * status poll is the last thing that should do that. The credentials file is
   * the fallback the reader already falls back to.
   *
   * The plain credentials file alone is not enough: on macOS the CLI keeps its
   * live OAuth token in the Keychain, and a machine where Claude works every
   * day can have no readable credentials file at all. Reporting
   * `authenticated: false` there tells a working user to log in, which is the
   * exact support ticket this RPC exists to prevent. So the ladder falls
   * through to the config file, then to whatever the auth detector already
   * probed, and only then spends a process.
   */
  claude: async (context, install) => {
    try {
      const credentials = await readClaudeCredentials({ allowKeychain: false });
      if (credentials) {
        // Both the Keychain item and ~/.claude/.credentials.json hold the token
        // a Pro/Max sign-in minted, not a key the user pasted.
        return { authenticated: true, authMethod: "subscription" };
      }
    } catch {
      // Fall through to the next rung.
    }
    if (envKeyPresent(context.env, "ANTHROPIC_API_KEY")) {
      return { authenticated: true, authMethod: "api-key" };
    }
    if (claudeConfigOauthAccountPresent(context)) {
      return { authenticated: true, authMethod: "subscription" };
    }
    const cached = cachedCliVerdict("claude");
    if (cached !== null) {
      return cached
        ? { authenticated: true, authMethod: "subscription" }
        : { authenticated: false, authMethod: null };
    }
    if (install.installed && install.binaryPath) {
      return await askCliForAuthStatus(install.binaryPath, ["auth", "status", "--json"], context);
    }
    return { authenticated: false, authMethod: null };
  },
  codex: async (context, install) => {
    try {
      if (await readCodexCredentials()) {
        return { authenticated: true, authMethod: "oauth" };
      }
    } catch {
      // Fall through to the next rung.
    }
    if (envKeyPresent(context.env, "OPENAI_API_KEY")) {
      return { authenticated: true, authMethod: "api-key" };
    }
    const cached = cachedCliVerdict("codex");
    if (cached !== null) {
      return cached
        ? { authenticated: true, authMethod: "oauth" }
        : { authenticated: false, authMethod: null };
    }
    // `~/.codex/auth.json` is absent and nothing else knows. Ask Codex.
    if (install.installed && install.binaryPath) {
      return await askCliForAuthStatus(install.binaryPath, ["login", "status"], context);
    }
    return { authenticated: false, authMethod: null };
  },
  cursor: async (context) => {
    try {
      const snapshot = await getCursorSdkAuthSnapshot();
      if (snapshot.credentialSource === "cursor-oauth" || snapshot.sdkLoggedIn) {
        return { authenticated: true, authMethod: "oauth" };
      }
      if (snapshot.adeKeyPresent || snapshot.envKeyPresent || snapshot.adminEnvKeyPresent) {
        return { authenticated: true, authMethod: "api-key" };
      }
      return { authenticated: false, authMethod: null };
    } catch {
      if (envKeyPresent(context.env, "CURSOR_API_KEY", "CURSOR_ADMIN_API_KEY")) {
        return { authenticated: true, authMethod: "api-key" };
      }
      return { authenticated: false, authMethod: null };
    }
  },
  droid: async (context) => {
    if (envKeyPresent(context.env, "FACTORY_API_KEY")) {
      return { authenticated: true, authMethod: "api-key" };
    }
    // Factory's only non-interactive signal is the CLI's own probe, which this
    // path refuses to spawn. Read whatever the auth detector already cached and
    // say nothing when the cache is cold.
    if (cachedCliVerdict("droid")) return { authenticated: true, authMethod: "unknown" };
    return {
      authenticated: false,
      authMethod: null,
      detail: "Droid sign-in state is only known after its CLI has been probed elsewhere; set FACTORY_API_KEY for a definite answer.",
    };
  },
  /**
   * OpenCode keeps no ADE-readable credential: its own server owns per-provider
   * keys and reports them through `provider.list()`. Claiming `authenticated`
   * from a file would be a guess, so this reports the honest "cannot tell".
   */
  opencode: async () => ({
    authenticated: false,
    authMethod: null,
    detail: "OpenCode stores credentials per model provider inside its own server; ADE cannot read them without starting it.",
  }),
  pi: async (context) => {
    // The try/catch is for `resolvePiInstallation`, which throws when it cannot
    // work out where Pi keeps its state. The file tests themselves do not throw.
    try {
      const installation = resolvePiInstallation(context.env);
      if (
        context.fs.existsSync(installation.authPath)
        || context.fs.existsSync(installation.modelsPath)
      ) {
        return { authenticated: true, authMethod: "unknown" };
      }
    } catch {
      // Pi's state directory could not be located; report nothing found.
    }
    return { authenticated: false, authMethod: null };
  },
};

