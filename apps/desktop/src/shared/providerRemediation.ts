import { MUSE_LOGIN_COMMAND, PROVIDER_DISPLAY_NAME, type ShippedProvider } from "./providers";

/**
 * How a user signs in to each CLI-backed provider ADE supports, and where its
 * docs live.
 *
 * One table, one owner, for every `ShippedProvider`. There is nothing to
 * install: ADE downloads its own pinned, checksum-verified copy of every
 * provider into the agent-tools cache of the machine that runs it and never
 * runs a CLI the user installed. So no surface tells a user to install a CLI
 * or put one on PATH; the ones that would (Settings rows, the chat card) show
 * the pinned copy's download state and a Download/Retry instead.
 *
 * Readers:
 * - `providers.status` over `@ade-dev/sdk`
 *   (`apps/desktop/src/main/services/ai/providerStatusProbe.ts`), which keeps
 *   its `installCommand` field, now always null.
 * - the model picker's empty states (`ModelPicker/providerEmptyState.tsx`),
 *   which take the docs URLs from here.
 * - the CLI's auth-recovery registry (`apps/ade-cli/src/services/agentRegistry.ts`),
 *   which takes the login commands.
 *
 * Login commands run with ADE's pinned binary (the terminal that runs them
 * swaps it in). Windows gets its own spelling where the vendor's differs.
 */

export type ProviderRemediation = {
  /** What the vendor calls the product, for a card title. */
  displayName: string;
  /** Command that signs the CLI in. Null when sign-in is not a command. */
  loginCommand: string | null;
  /** Vendor documentation for setup. */
  docsUrl: string | null;
  /** Used instead of `loginCommand` on win32. */
  windowsLoginCommand?: string;
};

export const PROVIDER_REMEDIATION = {
  claude: {
    displayName: "Claude Code",
    // `claude auth login` is ADE's own canonical spelling — see
    // `CLAUDE_AUTH_LOGIN_COMMAND` in `renderer/lib/claudeAuthPrompt.ts`, which
    // the Work tab types into a real terminal. Two spellings of one login is a
    // support ticket, so this table repeats that one.
    loginCommand: "claude auth login",
    docsUrl: "https://docs.claude.com/en/docs/agents-and-tools/claude-code/setup",
  },
  codex: {
    displayName: "Codex CLI",
    loginCommand: "codex login",
    docsUrl: "https://github.com/openai/codex",
  },
  cursor: {
    displayName: "Cursor",
    // `cursor-agent` is the CLI name ADE launches; see
    // `CURSOR_CLI_EXECUTABLES.authRecoveryRules` in `providerCliExecutables.ts`.
    loginCommand: "cursor-agent login",
    docsUrl: "https://cursor.com/dashboard/api",
  },
  droid: {
    displayName: "Droid",
    // Factory has no non-interactive login subcommand. Running the CLI starts
    // the sign-in flow, so the honest string is the bare command.
    loginCommand: "droid",
    docsUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
  },
  opencode: {
    displayName: "OpenCode",
    loginCommand: "opencode auth login",
    docsUrl: "https://opencode.ai/",
  },
  pi: {
    displayName: "Pi",
    // Pi has no `pi login` subcommand. Sign-in is the interactive CLI's own
    // `/login` flow, so the honest string is the bare command — the same one
    // `PiProvidersPanel.tsx` tells the user to run ("run pi in a terminal and
    // use its /login command") and the one `agentRegistry.ts` recovers with.
    loginCommand: "pi",
    docsUrl: "https://github.com/earendil-works/pi",
  },
  muse: {
    displayName: PROVIDER_DISPLAY_NAME.muse,
    // Run with ADE's pinned binary in an ADE terminal. A Meta API key
    // (META_API_KEY) is the other way in.
    loginCommand: MUSE_LOGIN_COMMAND,
    docsUrl: "https://dev.meta.ai",
  },
} as const satisfies Record<ShippedProvider, ProviderRemediation>;

export const REMEDIATION_PROVIDERS: readonly ShippedProvider[] =
  Object.keys(PROVIDER_REMEDIATION) as ShippedProvider[];

export function isRemediationProvider(value: string): value is ShippedProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_REMEDIATION, value);
}

/**
 * The strings a host shows, resolved for one platform.
 *
 * Callers get plain values, not a record with optional Windows twins, so a
 * setup screen cannot forget the `win32` branch. `installCommand` is always
 * null (ADE downloads its own copy); it stays in the shape because
 * `providers.status` publishes it to SDK embedders.
 */
export function resolveProviderRemediation(
  provider: ShippedProvider,
  platform: NodeJS.Platform = process.platform,
): {
  displayName: string;
  installCommand: null;
  loginCommand: string | null;
  docsUrl: string | null;
} {
  const entry: ProviderRemediation = PROVIDER_REMEDIATION[provider];
  return {
    displayName: entry.displayName,
    installCommand: null,
    loginCommand: pickPlatformCommand(entry, "windowsLoginCommand", entry.loginCommand, platform),
    docsUrl: entry.docsUrl,
  };
}

/**
 * One command, chosen for the platform.
 *
 * Key presence, not truthiness and not null-ness: a deliberate empty-string
 * override must not fall through to the POSIX command.
 */
export function pickPlatformCommand(
  entry: ProviderRemediation,
  key: "windowsLoginCommand",
  base: string | null,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== "win32") return base;
  if (!Object.prototype.hasOwnProperty.call(entry, key)) return base;
  return entry[key] ?? null;
}
