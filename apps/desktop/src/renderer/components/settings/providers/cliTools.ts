/**
 * What each CLI-backed provider is called and how it authenticates.
 *
 * There is no install story here: ADE runs its own pinned copy of every
 * provider, downloaded into the agent-tools cache of the machine that runs
 * it, and never a CLI the user installed or put on PATH. Whether that copy is
 * on the machine yet is the pinned-tool row's job (`usePinnedToolStatus`).
 */
import type { AiClaudeAvailability, AiProviderConnectionStatus } from "../../../../shared/types";
import { rendererPlatformAttribute } from "../../../lib/platform";

export type CliName = "claude" | "codex" | "cursor" | "droid" | "copilot";

// Factory's own way of setting an environment variable differs on Windows; a
// POSIX `export` line leaves a Windows user with nothing to run.
// https://docs.factory.ai/cli/getting-started/quickstart
const DROID_LOGIN_CMD = rendererPlatformAttribute() === "win32"
  ? "setx FACTORY_API_KEY … (or sign in via `droid` interactive login)"
  : "export FACTORY_API_KEY=… (or sign in via `droid` interactive login)";

export type CliTool = {
  cli: CliName;
  label: string;
  authStory: string;
  loginCmd: string;
};

export const CLI_TOOLS: CliTool[] = [
  {
    cli: "claude",
    label: "Claude Code",
    authStory: "Uses your claude login — Claude Pro/Max subscription or ANTHROPIC_API_KEY.",
    loginCmd: "claude auth login or set ANTHROPIC_API_KEY",
  },
  {
    cli: "codex",
    label: "Codex CLI",
    authStory: "Uses your ChatGPT sign-in — Plus/Pro subscription or OPENAI_API_KEY.",
    loginCmd: "codex login",
  },
  {
    cli: "cursor",
    label: "Cursor",
    authStory: "Sign in with Cursor or use a Cursor API key.",
    loginCmd: "Sign in with Cursor or add a Cursor API key",
  },
  {
    cli: "droid",
    label: "Droid",
    authStory: "Uses your Factory login or FACTORY_API_KEY.",
    loginCmd: DROID_LOGIN_CMD,
  },
  {
    cli: "copilot",
    label: "GitHub Copilot",
    authStory: "Runs on the Copilot runtime ADE downloads and reuses your GitHub sign-in.",
    loginCmd: "copilot login",
  },
];

export function cliTool(cli: CliName): CliTool {
  const found = CLI_TOOLS.find((tool) => tool.cli === cli);
  if (!found) throw new Error(`Unknown CLI tool ${cli}`);
  return found;
}

export function buildCliMessage(
  tool: CliTool,
  connection: AiProviderConnectionStatus | null | undefined,
): string {
  if (connection?.runtimeAvailable) {
    return "Connection verified.";
  }
  // The pinned copy's state (downloading, couldn't download, not available
  // on this machine) or the sign-in that is missing, in the host's words.
  if (connection?.blocker) {
    return connection.blocker;
  }
  if (connection?.runtimeDetected && !connection.authAvailable) {
    return `Not signed in. Run: ${tool.loginCmd}`;
  }
  if (connection?.authAvailable && !connection.runtimeDetected) {
    return `Signed in. ADE downloads ${tool.label} for this machine the first time it is used.`;
  }
  return `ADE downloads ${tool.label} for this machine the first time it is used.`;
}

export function buildClaudeAvailabilityMessage(
  availability: AiClaudeAvailability | null | undefined,
): string {
  if (!availability?.binary.present) {
    return "ADE's Claude Code is not on this machine yet. It downloads the first time this machine uses it.";
  }
  if (!availability.auth.ready) {
    return availability.auth.detail || "Sign in to use Claude";
  }
  return "Ready";
}

/** "Authenticated as dev@example.com · ChatGPT Pro", when the provider says so. */
export function describeAuthenticatedAccount(
  connection: AiProviderConnectionStatus | null | undefined,
): string | null {
  const email = connection?.accountEmail?.trim();
  const plan = connection?.accountPlan?.trim();
  if (!email && !plan) return null;
  if (!email) return `Authenticated · ${plan}`;
  return plan ? `Authenticated as ${email} · ${plan}` : `Authenticated as ${email}`;
}

/**
 * The credential line the detail page's left rail prints.
 *
 * The account, when the provider records one locally, says more than the file
 * it was read from — so it leads, and the file stays as the fallback. Kept
 * separate from {@link describeCredentialSource} so a caller that genuinely
 * wants the *file* (a diagnostics view) can still reach it.
 */
export function describeProviderCredentialLine(
  connection: AiProviderConnectionStatus | null | undefined,
): string | null {
  const account = describeAuthenticatedAccount(connection);
  if (account) return `${account}.`;
  return describeCredentialSource(connection);
}

/** Which file or environment variable the local credential was detected in. */
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
  if (localSource.source === "muse-env") return "Detected via META_API_KEY environment variable.";
  if (localSource.source === "muse-api-key-store") return "Meta API key is stored in ADE encrypted storage.";
  if (localSource.source === "muse-auth-file") {
    return localSource.path ? `Signed in to Muse (${localSource.path}).` : "Signed in to Muse.";
  }
  return null;
}

/**
 * The same credential, in two or three words.
 *
 * `describeProviderCredentialLine` writes a sentence for the detail page's left rail;
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
    case "muse-env":
    case "muse-api-key-store":
      return "API key";
    case "muse-auth-file":
      return "Signed in";
    case "pi-auth-file":
    case "pi-models-file":
      return "Signed in";
    default:
      return null;
  }
}
