import type { ShippedProvider } from "./providers";

/**
 * How a user installs and signs in to each CLI-backed provider ADE supports.
 *
 * One table, one owner, for every `ShippedProvider`. Every surface that tells a
 * user how to install or sign in to one of these six providers reads its
 * strings from here:
 *
 * - `providers.status` over `@ade-dev/sdk`, so an embedder never hardcodes
 *   `npm install -g @anthropic-ai/claude-code` and then ships a new build when
 *   the vendor changes it (`apps/desktop/src/main/services/ai/providerStatusProbe.ts`).
 * - the Settings CLI cards (`settings/providers/cliTools.ts`).
 * - the model picker's empty states (`ModelPicker/providerEmptyState.tsx`),
 *   which take the docs URLs from here.
 * - the CLI's auth-recovery registry (`apps/ade-cli/src/services/agentRegistry.ts`),
 *   which takes the same strings and wraps them for a shell — see below.
 *
 * What this table does NOT own: `settings/providers/acpProviders.tsx`, whose
 * four rows (Qwen, Kimi, Grok, Copilot) are ACP providers and are not
 * `ShippedProvider`s, and the same four rows in `agentRegistry.ts`. Add a
 * provider here only when it is in `ShippedProvider`.
 *
 * These are DISPLAY strings: what a user copies into a terminal, or what a card
 * shows. `agentRegistry.ts` needs the same command to survive being handed to a
 * shell it constructs, so it re-wraps each one — a POSIX `npm install -g` line
 * gains an `NPM_CONFIG_PREFIX` prelude, and a Windows `irm … | iex` line gains
 * `powershell.exe -NoProfile -Command`. The wrapping lives there because it is
 * about that call site's shell, not about the vendor. The vendor's part of the
 * string is only ever written here.
 *
 * The commands are the vendors' own documented ones, and the docs URLs are the
 * ones the model picker already links to, so a user cannot be sent to two
 * different pages for one provider.
 *
 * Windows gets its own spelling wherever the vendor ships a different
 * installer. A POSIX `curl … | sh` line is not a fix for a Windows user, it is
 * a dead end — `resolveProviderRemediation` picks the platform's line.
 */

export type ProviderRemediation = {
  /** What the vendor calls the product, for a card title. */
  displayName: string;
  /** Command that installs the CLI. Null when there is nothing to install. */
  installCommand: string | null;
  /** Command that signs the CLI in. Null when sign-in is not a command. */
  loginCommand: string | null;
  /** Vendor documentation for setup. */
  docsUrl: string | null;
  /**
   * Used instead of `installCommand` on win32, where the vendor ships another
   * installer. Set it to `null` for a vendor that has no Windows installer at
   * all: `resolveProviderRemediation` then reports no install command rather
   * than a POSIX `curl … | sh` line the user cannot run, and `docsUrl` is the
   * only remediation left. Omit it when the base command already works on
   * Windows, as `npm install -g` does.
   */
  windowsInstallCommand?: string | null;
  /** Used instead of `loginCommand` on win32. */
  windowsLoginCommand?: string;
};

export const PROVIDER_REMEDIATION = {
  claude: {
    displayName: "Claude Code",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    // `claude auth login` is ADE's own canonical spelling — see
    // `CLAUDE_AUTH_LOGIN_COMMAND` in `renderer/lib/claudeAuthPrompt.ts`, which
    // the Work tab types into a real terminal. Two spellings of one login is a
    // support ticket, so this table repeats that one.
    loginCommand: "claude auth login",
    docsUrl: "https://docs.claude.com/en/docs/agents-and-tools/claude-code/setup",
    // Anthropic's documented Windows installs: the PowerShell native installer
    // (drops claude.exe in %USERPROFILE%\.local\bin) or WinGet.
    windowsInstallCommand: "irm https://claude.ai/install.ps1 | iex",
  },
  codex: {
    displayName: "Codex CLI",
    installCommand: "npm install -g @openai/codex",
    loginCommand: "codex login",
    docsUrl: "https://github.com/openai/codex",
  },
  cursor: {
    displayName: "Cursor",
    installCommand: "curl https://cursor.com/install -fsS | bash",
    // `cursor-agent` is the CLI name ADE launches; see
    // `CURSOR_CLI_EXECUTABLES.authRecoveryRules` in `providerCliExecutables.ts`.
    loginCommand: "cursor-agent login",
    docsUrl: "https://cursor.com/dashboard/api",
    // Cursor runs natively on Windows x64 and ships its own installer; see
    // `docs/development/windows-support.md` and `agentRegistry.ts`, which types
    // the same URL. The POSIX `curl … | bash` line is a dead end there.
    windowsInstallCommand: "irm 'https://cursor.com/install?win32=true' | iex",
  },
  droid: {
    displayName: "Droid",
    installCommand: "curl -fsSL https://app.factory.ai/cli | sh",
    // Factory has no non-interactive login subcommand. Running the CLI starts
    // the sign-in flow, so the honest string is the bare command.
    loginCommand: "droid",
    docsUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
    windowsInstallCommand: "irm https://app.factory.ai/cli/windows | iex",
  },
  opencode: {
    displayName: "OpenCode",
    installCommand: "npm install -g opencode-ai",
    loginCommand: "opencode auth login",
    docsUrl: "https://opencode.ai/",
  },
  pi: {
    displayName: "Pi",
    installCommand: "npm install -g @earendil-works/pi-coding-agent",
    // Pi has no `pi login` subcommand. Sign-in is the interactive CLI's own
    // `/login` flow, so the honest string is the bare command — the same one
    // `PiProvidersPanel.tsx` tells the user to run ("run pi in a terminal and
    // use its /login command") and the one `agentRegistry.ts` recovers with.
    loginCommand: "pi",
    docsUrl: "https://github.com/earendil-works/pi",
  },
} as const satisfies Record<ShippedProvider, ProviderRemediation>;

export const REMEDIATION_PROVIDERS: readonly ShippedProvider[] =
  Object.keys(PROVIDER_REMEDIATION) as ShippedProvider[];

export function isRemediationProvider(value: string): value is ShippedProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_REMEDIATION, value);
}

/**
 * The four strings a host shows, resolved for one platform.
 *
 * Callers get plain values, not a record with optional Windows twins, so a
 * setup screen cannot forget the `win32` branch.
 */
export function resolveProviderRemediation(
  provider: ShippedProvider,
  platform: NodeJS.Platform = process.platform,
): {
  displayName: string;
  installCommand: string | null;
  loginCommand: string | null;
  docsUrl: string | null;
} {
  const entry: ProviderRemediation = PROVIDER_REMEDIATION[provider];
  return {
    displayName: entry.displayName,
    installCommand: pickPlatformCommand(entry, "windowsInstallCommand", entry.installCommand, platform),
    loginCommand: pickPlatformCommand(entry, "windowsLoginCommand", entry.loginCommand, platform),
    docsUrl: entry.docsUrl,
  };
}

/**
 * One command, chosen for the platform.
 *
 * Key presence, not truthiness and not null-ness. `(windows && override) ||
 * base` reads a deliberate empty-string override as "no override" and falls
 * through to the POSIX command — which is exactly the dead end this module
 * exists to prevent. An explicit `null` override is the stronger statement,
 * "this vendor has no Windows installer", and it beats the base command too;
 * the row's `docsUrl` is then the whole remediation.
 *
 * Exported for its own test: the null branch has no row in the table today, and
 * a branch with no test is a branch a refactor silently drops.
 */
export function pickPlatformCommand(
  entry: ProviderRemediation,
  key: "windowsInstallCommand" | "windowsLoginCommand",
  base: string | null,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== "win32") return base;
  if (!Object.prototype.hasOwnProperty.call(entry, key)) return base;
  return entry[key] ?? null;
}
