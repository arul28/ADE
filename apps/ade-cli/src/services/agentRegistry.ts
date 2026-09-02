import { CURSOR_CLI_EXECUTABLES } from "../../../desktop/src/shared/providerCliExecutables";
import { resolveProviderRemediation } from "../../../desktop/src/shared/providerRemediation";
import type { ShippedProvider } from "../../../desktop/src/shared/providers";

export type AgentCliErrorCategory = "missing" | "unauthenticated";

export type AgentCliDescriptor = {
  agent: string;
  displayName: string;
  binaryNames: readonly string[];
  installCommand: string;
  authCommand: string;
  authRecoveryRules?: readonly {
    authCommand: string;
    patterns: readonly RegExp[];
  }[];
  missingErrorPatterns: RegExp[];
  notAuthErrorPatterns: RegExp[];
};

export type AgentCliErrorMatch = {
  agent: string;
  displayName: string;
  category: AgentCliErrorCategory;
  installCommand: string;
  authCommand: string;
};

function hostPlatform(): NodeJS.Platform {
  return typeof process !== "undefined" ? process.platform : "linux";
}

function npmGlobalInstallCommand(packageName: string): string {
  if (hostPlatform() === "win32") {
    return `npm install -g ${packageName}`;
  }
  return `mkdir -p "$HOME/.npm-global" "$HOME/.local/bin" && NPM_CONFIG_PREFIX="$HOME/.npm-global" npm install -g ${packageName}`;
}

/**
 * One vendor command, wrapped for the shell this registry's callers use.
 *
 * The command text itself belongs to
 * `apps/desktop/src/shared/providerRemediation.ts`, which is the one table for
 * every `ShippedProvider`. This function adds only what the call site needs:
 * a `NPM_CONFIG_PREFIX` prelude so a POSIX `npm install -g` lands somewhere the
 * user can write, and `powershell.exe -NoProfile -Command` so a Windows
 * `irm … | iex` line runs from a `cmd.exe` recovery card. No row's command
 * contains a double quote, so the PowerShell wrapping needs no escaping; keep
 * it that way when editing the shared table.
 */
function shellInstallCommand(displayCommand: string): string {
  if (hostPlatform() === "win32") {
    if (displayCommand.startsWith("npm ")) return displayCommand;
    return `powershell.exe -NoProfile -Command "${displayCommand}"`;
  }
  const NPM_PREFIX = "npm install -g ";
  if (displayCommand.startsWith(NPM_PREFIX)) {
    return npmGlobalInstallCommand(displayCommand.slice(NPM_PREFIX.length));
  }
  return `mkdir -p "$HOME/.local/bin" && ${displayCommand}`;
}

/**
 * The install and login commands for one `ShippedProvider`, from the one table.
 *
 * A provider that is not a `ShippedProvider` — Qwen, Kimi, Grok, Copilot — is
 * an ACP provider and writes its own strings below, because the shared table
 * deliberately does not carry them.
 */
function sharedRemediation(provider: ShippedProvider): {
  installCommand: string;
  authCommand: string;
} {
  const resolved = resolveProviderRemediation(provider, hostPlatform());
  return {
    // Every shipped row has an install command on both platforms today. The
    // docs URL is the honest fallback if one ever becomes "no installer here".
    installCommand: resolved.installCommand
      ? shellInstallCommand(resolved.installCommand)
      : (resolved.docsUrl ?? ""),
    authCommand: resolved.loginCommand ?? "",
  };
}

export const AGENT_CLI_REGISTRY: AgentCliDescriptor[] = [
  {
    agent: "claude",
    displayName: "Claude Code",
    binaryNames: ["claude"],
    ...sharedRemediation("claude"),
    missingErrorPatterns: [
      /\bclaude\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bspawn\s+claude\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bclaude\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required)\b/i,
      /\bplease\s+run\s+\/login\b/i,
      /\brun\s+[`'"]?claude\s+auth\s+login[`'"]?/i,
      /\b(?:please\s+)?run\s+[`'"]?claude\s+\/login[`'"]?/i,
    ],
  },
  {
    agent: "codex",
    displayName: "Codex CLI",
    binaryNames: ["codex"],
    ...sharedRemediation("codex"),
    missingErrorPatterns: [
      /\bcodex\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bspawn\s+codex\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bcodex\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required)\b/i,
      /\brun\s+[`'"]?codex\s+login[`'"]?/i,
    ],
  },
  {
    agent: "opencode",
    displayName: "OpenCode",
    binaryNames: ["opencode"],
    ...sharedRemediation("opencode"),
    missingErrorPatterns: [
      /\bopencode\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bspawn\s+opencode\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bopencode\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required)\b/i,
    ],
  },
  {
    agent: "cursor",
    displayName: "Cursor Agent",
    binaryNames: CURSOR_CLI_EXECUTABLES.recoveryMentionNames,
    ...sharedRemediation("cursor"),
    authRecoveryRules: CURSOR_CLI_EXECUTABLES.authRecoveryRules,
    missingErrorPatterns: [
      /\bcursor-agent\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bcursor\b.*\b(command not found|not recognized|enoent)\b/i,
      /\bspawn\s+cursor(?:-agent)?\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bcursor(?:-agent)?\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required)\b/i,
    ],
  },
  {
    agent: "pi",
    displayName: "Pi",
    binaryNames: ["pi"],
    ...sharedRemediation("pi"),
    missingErrorPatterns: [
      /\bpi\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bspawn\s+pi\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bpi\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required|authentication required|no api key|api key required|no credentials|provider not configured)\b/i,
      /\b(?:no api key|api key required|no credentials|provider not configured)\b.*\b(?:for|pi|provider)\b/i,
      /\brun\s+[`'"]?pi\s+\/login[`'"]?/i,
    ],
  },
  {
    agent: "droid",
    displayName: "Factory Droid",
    binaryNames: ["droid"],
    // Factory's own installer, and its interactive `/login` flow rather than a
    // non-interactive `login` subcommand — both from the shared table.
    ...sharedRemediation("droid"),
    missingErrorPatterns: [
      /\bdroid\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bspawn\s+droid\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bdroid\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required)\b/i,
      /\bfactory\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required)\b/i,
      /\b(?:invalid|missing|no)\s+factory(?:_api_key| api key)\b/i,
      /\bfactory(?:_api_key| api key)\b.*\b(invalid|missing|not found|not set|required|unauthorized|must be set)\b/i,
    ],
  },
  {
    agent: "qwen",
    displayName: "Qwen Code",
    binaryNames: ["qwen"],
    installCommand: npmGlobalInstallCommand("@qwen-code/qwen-code"),
    // 0.22.3 removed `qwen auth`. Sign-in is OPENAI_API_KEY / `--auth-type=openai`.
    authCommand: "qwen --auth-type=openai",
    missingErrorPatterns: [
      /\bqwen\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bspawn\s+qwen\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bqwen\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required|no api key|api key required|no credentials)\b/i,
      /\b(?:dashscope|openai)[_ ]api[_ ]key\b.*\b(invalid|missing|not found|not set|required|unauthorized|must be set)\b/i,
    ],
  },
  {
    agent: "kimi",
    displayName: "Kimi Code",
    binaryNames: ["kimi"],
    // Kimi ships a native binary rather than an npm package, so there is no
    // portable one-liner to print here. Point at the vendor's own installer
    // instead of guessing a package name that would fail on paste.
    installCommand: "curl -LsSf https://code.kimi.com/kimi-code/install.sh | bash",
    authCommand: "kimi login",
    missingErrorPatterns: [
      /\bkimi\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bspawn\s+kimi\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bkimi\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required|no api key|api key required|no credentials)\b/i,
      /\brun\s+[`'"]?kimi\s+login[`'"]?/i,
      /\bmoonshot[_ ]api[_ ]key\b.*\b(invalid|missing|not found|not set|required|unauthorized|must be set)\b/i,
    ],
  },
  {
    agent: "grok",
    displayName: "Grok CLI",
    binaryNames: ["grok"],
    installCommand: npmGlobalInstallCommand("@xai-official/grok"),
    authCommand: "grok login",
    missingErrorPatterns: [
      /\bgrok\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bspawn\s+grok\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bgrok\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required|no api key|api key required|no credentials)\b/i,
      /\brun\s+[`'"]?grok\s+login[`'"]?/i,
      /\bxai[_ ]api[_ ]key\b.*\b(invalid|missing|not found|not set|required|unauthorized|must be set)\b/i,
    ],
  },
  {
    agent: "copilot",
    displayName: "GitHub Copilot CLI",
    binaryNames: ["copilot"],
    installCommand: npmGlobalInstallCommand("@github/copilot"),
    authCommand: "copilot login",
    missingErrorPatterns: [
      /\bcopilot\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bspawn\s+copilot\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bcopilot\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required|no credentials)\b/i,
      /\brun\s+[`'"]?copilot\s+login[`'"]?/i,
      /\bgh[_ ]token\b.*\b(invalid|missing|not found|not set|required|unauthorized|must be set)\b/i,
    ],
  },
];

function descriptorMatchesPreferred(descriptor: AgentCliDescriptor, preferredAgent: string | null | undefined): boolean {
  if (!preferredAgent) return false;
  const normalized = preferredAgent.trim().toLowerCase();
  return descriptor.agent === normalized
    || descriptor.displayName.toLowerCase().includes(normalized)
    || descriptor.binaryNames.some((name) => name.toLowerCase() === normalized);
}

function descriptorMentioned(descriptor: AgentCliDescriptor, text: string): boolean {
  return descriptor.binaryNames.some((name) => binaryNameMentioned(text, name))
    || new RegExp(`\\b${descriptor.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function binaryNameMentioned(text: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.exe|\\.cmd|\\.bat|\\.ps1)?\\b`, "i").test(text);
}

function toMatch(descriptor: AgentCliDescriptor, category: AgentCliErrorCategory, text: string): AgentCliErrorMatch {
  const aliasAuthCommand = category === "unauthenticated"
    ? descriptor.authRecoveryRules?.find((rule) => rule.patterns.some((pattern) => pattern.test(text)))?.authCommand
    : undefined;
  return {
    agent: descriptor.agent,
    displayName: descriptor.displayName,
    category,
    installCommand: descriptor.installCommand,
    authCommand: aliasAuthCommand ?? descriptor.authCommand,
  };
}

export function classifyAgentCliError(message: string, preferredAgent?: string | null): AgentCliErrorMatch | null {
  const text = message.trim();
  if (!text) return null;
  const preferred = AGENT_CLI_REGISTRY.find((descriptor) => descriptorMatchesPreferred(descriptor, preferredAgent));
  const candidates = preferred
    ? [preferred, ...AGENT_CLI_REGISTRY.filter((descriptor) => descriptor !== preferred)]
    : AGENT_CLI_REGISTRY;

  for (const descriptor of candidates) {
    const mentioned = descriptorMentioned(descriptor, text);
    if (!mentioned && descriptor !== preferred) continue;
    if (descriptor.missingErrorPatterns.some((pattern) => pattern.test(text))) {
      return toMatch(descriptor, "missing", text);
    }
    if (descriptor.notAuthErrorPatterns.some((pattern) => pattern.test(text))) {
      return toMatch(descriptor, "unauthenticated", text);
    }
  }

  if (preferred) {
    if (
      /\b(command not found|not recognized|enoent|executable file not found|no such file or directory)\b/i.test(text)
      || /\b(?:spawn|exec(?:ute)?|binary|command|executable)\b.*\bnot found\b/i.test(text)
    ) {
      return toMatch(preferred, "missing", text);
    }
    if (/\b(not logged in|not authenticated|unauthorized|authentication failed|login required|invalid api key|401|403)\b/i.test(text)) {
      return toMatch(preferred, "unauthenticated", text);
    }
  }

  return null;
}
