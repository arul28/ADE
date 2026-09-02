/**
 * What each CLI-backed provider is called, how it authenticates, and how it is
 * installed — including the Windows install path, which is a different command
 * for every vendor and used to be missing entirely.
 */
import type { AiClaudeAvailability, AiProviderConnectionStatus } from "../../../../shared/types";
import { rendererPlatformAttribute } from "../../../lib/platform";

export type CliName = "claude" | "codex" | "cursor" | "droid";

// Factory ships a native Windows build of `droid` with its own installer and
// its own way of setting an environment variable — a POSIX `export` line and a
// bare docs link leave a Windows user with nothing to run.
// https://docs.factory.ai/cli/getting-started/quickstart
const DROID_INSTALL_HINT = rendererPlatformAttribute() === "win32"
  ? "irm https://app.factory.ai/cli/windows | iex — installs droid.exe into %USERPROFILE%\\bin and puts it on PATH"
  : "curl -fsSL https://app.factory.ai/cli | sh — ensure `droid` is on PATH";
const DROID_LOGIN_CMD = rendererPlatformAttribute() === "win32"
  ? "setx FACTORY_API_KEY … (or sign in via `droid` interactive login)"
  : "export FACTORY_API_KEY=… (or sign in via `droid` interactive login)";

export type CliTool = {
  cli: CliName;
  label: string;
  authStory: string;
  loginCmd: string;
  installHint: string;
  /** Used instead of installHint on Windows, where the vendor ships a different installer. */
  windowsInstallHint?: string;
};

export const CLI_TOOLS: CliTool[] = [
  {
    cli: "claude",
    label: "Claude Code",
    authStory: "Uses your claude login — Claude Pro/Max subscription or ANTHROPIC_API_KEY.",
    loginCmd: "claude auth login or set ANTHROPIC_API_KEY",
    installHint: "npm install -g @anthropic-ai/claude-code",
    // Anthropic's documented Windows installs: the PowerShell native installer
    // (drops claude.exe in %USERPROFILE%\.localin) or WinGet.
    windowsInstallHint: "irm https://claude.ai/install.ps1 | iex (PowerShell), or winget install Anthropic.ClaudeCode",
  },
  {
    cli: "codex",
    label: "Codex CLI",
    authStory: "Uses your ChatGPT sign-in — Plus/Pro subscription or OPENAI_API_KEY.",
    loginCmd: "codex login",
    installHint: "npm install -g @openai/codex",
  },
  {
    cli: "cursor",
    label: "Cursor",
    authStory: "Sign in with Cursor or use a Cursor API key.",
    loginCmd: "Sign in with Cursor or add a Cursor API key",
    installHint: "Get a Cursor API key from https://cursor.com/dashboard/api",
  },
  {
    cli: "droid",
    label: "Droid",
    authStory: "Uses your Factory login or FACTORY_API_KEY.",
    loginCmd: DROID_LOGIN_CMD,
    installHint: DROID_INSTALL_HINT,
  },
];

export function cliTool(cli: CliName): CliTool {
  const found = CLI_TOOLS.find((tool) => tool.cli === cli);
  if (!found) throw new Error(`Unknown CLI tool ${cli}`);
  return found;
}

const isWindowsRenderer = rendererPlatformAttribute() === "win32";

export function installHintFor(tool: CliTool): string {
  return (isWindowsRenderer && tool.windowsInstallHint) || tool.installHint;
}

export function buildCliMessage(
  tool: CliTool,
  connection: AiProviderConnectionStatus | null | undefined,
): string {
  if (connection?.runtimeAvailable) {
    return "Connection verified.";
  }
  if (connection?.blocker) {
    return connection.blocker;
  }
  if (connection?.runtimeDetected && !connection.authAvailable) {
    return `CLI detected but not signed in. Run: ${tool.loginCmd}`;
  }
  if (connection?.authAvailable && !connection.runtimeDetected) {
    return `Local credentials exist but CLI not found in PATH. Install: ${installHintFor(tool)}`;
  }
  const pathAdvice = isWindowsRenderer
    ? "If already installed, add its folder to your Windows PATH (System Properties -> Environment Variables), reopen ADE, and use Refresh."
    : "If already installed, ensure it is on your shell PATH and use Refresh.";
  return `CLI not found in PATH. Install: ${installHintFor(tool)}. ${pathAdvice}`;
}

export function buildClaudeAvailabilityMessage(
  availability: AiClaudeAvailability | null | undefined,
): string {
  if (!availability?.binary.present) {
    return "Claude unavailable (binary missing; should not happen with bundled install; run /doctor).";
  }
  if (!availability.auth.ready) {
    return availability.auth.detail || "Sign in to use Claude";
  }
  return "Ready";
}

export function describeCredentialSource(
  connection: AiProviderConnectionStatus | null | undefined,
): string | null {
  const localSource = connection?.sources.find((entry) => entry.kind === "local-credentials" && entry.detected);
  if (!localSource?.source) return null;
  if (localSource.source === "macos-keychain") return "Local credentials found in macOS Keychain.";
  if (localSource.source === "claude-credentials-file") return "Local credentials found in ~/.claude/.credentials.json.";
  if (localSource.source === "codex-auth-file") return "Local credentials found in ~/.codex/auth.json.";
  if (localSource.source === "cursor-env") return "Detected via CURSOR_API_KEY environment variable.";
  if (localSource.source === "cursor-api-key-store") return "Cursor API key is stored in ADE encrypted storage.";
  if (localSource.source === "cursor-oauth") {
    const email = connection?.accountEmail?.trim();
    return email ? `Signed in as ${email}.` : "Signed in with Cursor.";
  }
  if (localSource.source === "factory-env") return "Detected via FACTORY_API_KEY environment variable.";
  if (localSource.source === "pi-auth-file") return "Detected via ~/.pi/agent/auth.json.";
  if (localSource.source === "pi-models-file") return "Detected via ~/.pi/agent/models.json.";
  return null;
}

/**
 * The same credential, in two or three words.
 *
 * `describeCredentialSource` writes a sentence for the detail page's left rail;
 * a tile has one short line and no room for "Local credentials found in
 * ~/.claude/.credentials.json." Both read the one `local-credentials` source
 * the auth detector reports, so they can never disagree about which credential
 * is in play — only about how much of it there is room to say.
 */
export function shortCredentialSource(
  connection: AiProviderConnectionStatus | null | undefined,
): string | null {
  const localSource = connection?.sources.find((entry) => entry.kind === "local-credentials" && entry.detected);
  switch (localSource?.source) {
    // The keychain and the credential files are where the vendor CLIs park the
    // token a Pro/Max/Plus sign-in minted — a subscription, not a key the user
    // pasted.
    case "macos-keychain":
    case "claude-credentials-file":
    case "codex-auth-file":
      return "CLI subscription";
    case "cursor-oauth":
      return "OAuth";
    case "cursor-admin-env":
    case "cursor-env":
    case "cursor-api-key-store":
    case "factory-env":
      return "API key";
    case "pi-auth-file":
    case "pi-models-file":
      return "Signed in";
    default:
      return null;
  }
}

/**
 * OpenCode's own documented install methods, per platform. Windows has neither
 * Homebrew nor a POSIX shell to pipe the install script into, so it gets the
 * package managers OpenCode actually documents for Windows (npm, Scoop,
 * Chocolatey) instead of commands that cannot run there.
 */
export function openCodeInstallCommands(
  platform: ReturnType<typeof rendererPlatformAttribute> = rendererPlatformAttribute(),
): string[] {
  if (platform === "win32") {
    return [
      "npm i -g opencode-ai",
      "scoop install opencode",
      "choco install opencode",
    ];
  }
  return [
    "brew install anomalyco/tap/opencode",
    "npm i -g opencode-ai",
    "curl -fsSL https://opencode.ai/install | bash",
  ];
}
