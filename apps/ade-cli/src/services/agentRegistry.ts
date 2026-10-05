import { CURSOR_CLI_EXECUTABLES } from "../../../desktop/src/shared/providerCliExecutables";
import { resolveProviderRemediation } from "../../../desktop/src/shared/providerRemediation";
import { COPILOT_NPM_PACKAGE_SPEC } from "../../../desktop/src/shared/acpProviderMetadata";
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
    notAuthErrorPatterns: [
      /\bcursor(?:-agent)?\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required)\b/i,
    ],
  },
  {
    agent: "pi",
    displayName: "Pi",
    binaryNames: ["pi"],
    ...sharedRemediation("pi"),
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
    // 0.24.0 removed `qwen auth`. Sign-in is OPENAI_API_KEY / `--auth-type=openai`.
    authCommand: "qwen --auth-type=openai",
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
    installCommand: npmGlobalInstallCommand("@xai-official/grok@1.0.34"),
    authCommand: "grok login",
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
    installCommand: npmGlobalInstallCommand(COPILOT_NPM_PACKAGE_SPEC),
    authCommand: "copilot login",
    notAuthErrorPatterns: [
      /\bcopilot\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required|no credentials)\b/i,
      /\brun\s+[`'"]?copilot\s+login[`'"]?/i,
      /\bgh[_ ]token\b.*\b(invalid|missing|not found|not set|required|unauthorized|must be set)\b/i,
    ],
  },
  {
    agent: "devin",
    displayName: "Devin CLI",
    binaryNames: ["devin"],
    installCommand: "curl -fsSL https://cli.devin.ai/install.sh | bash",
    authCommand: "devin auth login",
    notAuthErrorPatterns: [
      /\bdevin\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required|no credentials|sign\s*in)\b/i,
      /\brun\s+[`'"]?devin\s+auth\s+login[`'"]?/i,
      /\bwindsurf[_ ]api[_ ]key\b.*\b(invalid|missing|not found|not set|required|unauthorized|must be set)\b/i,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function descriptorMentioned(descriptor: AgentCliDescriptor, text: string): boolean {
  return descriptor.binaryNames.some((name) => binaryNameMentioned(text, name))
    || new RegExp(`\\b${escapeRegExp(descriptor.agent)}\\b`, "i").test(text);
}

function binaryNameMentioned(text: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}(?:\\.exe|\\.cmd|\\.bat|\\.ps1)?\\b`, "i").test(text);
}

/**
 * The phrasings an operating system, a shell or ADE itself uses when the
 * binary `name` could not be started — and only those.
 *
 * Each one names the binary as the thing that is missing. A harness's own
 * "Command not found: ship" (OpenCode, for a `/ship` it does not know) names a
 * slash command, not the binary, and must never read as "install OpenCode".
 * Neither may "Pi session X was not found" or "OpenCode: model not found".
 */
function missingBinaryPatterns(name: string): RegExp[] {
  const bin = `${escapeRegExp(name)}(?:\\.exe|\\.cmd|\\.bat|\\.ps1)?`;
  // An optional directory in front of the name: `spawn /opt/bin/opencode ENOENT`.
  const dir = String.raw`(?:[^\s'"\`]*[\\/])?`;
  // A spawned path may contain spaces (`C:\Program Files\OpenCode\opencode.exe`),
  // so this variant allows them up to the last separator before the binary.
  const spawnDir = String.raw`(?:[^'"\`\n]*[\\/])?`;
  const q = String.raw`['"\`]?`;
  const end = String.raw`(?![\w.-])`;
  return [
    // Node: `spawn opencode ENOENT`, `spawn /opt/bin/opencode ENOENT`,
    // `spawn C:\Program Files\OpenCode\opencode.exe ENOENT`.
    new RegExp(String.raw`\bspawn\s+${q}${spawnDir}${bin}${q}\s+ENOENT\b`, "i"),
    // Node/Electron: `ENOENT: no such file or directory, posix_spawn '/x/opencode'`.
    new RegExp(String.raw`\bENOENT\b[^\n]*\bposix_spawnp?\s+${q}${spawnDir}${bin}${q}${end}`, "i"),
    // bash/dash: `opencode: command not found`, `sh: 1: opencode: not found`,
    // `opencode command not found`.
    new RegExp(String.raw`(?:^|[\s:'"\`])${dir}${bin}${q}(?::\s*(?:command\s+)?not found|\s+command\s+not found)\b`, "im"),
    // zsh/bash: `zsh: command not found: opencode`. The shell prefix is
    // required: a harness answers an unknown slash command with a bare
    // `Command not found: <name>`, which names the command, not a binary.
    new RegExp(String.raw`\b(?:zsh|bash|sh|dash|fish|ksh|csh|tcsh|ash|nu|pwsh|powershell|xonsh):\s*(?:\d+:\s*)?command not found:\s*${q}${dir}${bin}${q}${end}`, "i"),
    // cmd.exe / PowerShell.
    new RegExp(String.raw`${q}${dir}${bin}${q}\s+is not recognized as (?:an internal or external command|the name of a cmdlet)`, "i"),
    // Go/Rust exec: `exec: "opencode": executable file not found in $PATH`.
    new RegExp(String.raw`${q}${dir}${bin}${q}:\s*executable file not found\b`, "i"),
    // ADE's own: "OpenCode binary could not be found", "codex executable not found".
    new RegExp(String.raw`\b${bin}\s+(?:cli|binary|executable)\s+(?:could not be|was not|is not|not)\s+found\b`, "i"),
    // ADE's ACP diagnostics: "Grok was not found on this machine".
    new RegExp(String.raw`\b${bin}\s+(?:was|is)\s+not\s+found\s+on\s+this\s+machine\b`, "i"),
  ];
}

/**
 * The executable an operating-system spawn-failure message names, or null.
 * Used only for the preferred-agent fallback, where the binary name is not in
 * the registry (a custom path or wrapper). A bare "command not found" is
 * deliberately excluded: it is as often a harness's slash command as a binary.
 */
function failedSpawnExecutable(text: string): string | null {
  const spawn = /\bspawn\s+(['"`]?)([^'"`\n]+?)\1\s+ENOENT\b/i.exec(text);
  if (spawn) return spawn[2]!.trim();
  const recognized = /(['"`]?)([^'"`\n]+?)\1\s+is not recognized as (?:an internal or external command|the name of a cmdlet)\b/i.exec(text);
  if (recognized) return recognized[2]!.trim();
  const execMissing = /(['"`]?)([^'"`\n]+?)\1:\s*executable file not found in \$?PATH\b/i.exec(text);
  if (execMissing) return execMissing[2]!.trim();
  return null;
}

/**
 * Whether `text` says the binary of `agent` (any of its registered names, or
 * the agent id itself) could not be started.
 */
export function isAgentBinaryMissingError(text: string, agent: string): boolean {
  const descriptor = AGENT_CLI_REGISTRY.find((entry) => entry.agent === agent);
  const names = new Set([agent, ...(descriptor?.binaryNames ?? [])]);
  return [...names].some((name) => missingBinaryPatterns(name).some((pattern) => pattern.test(text)));
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
    if (isAgentBinaryMissingError(text, descriptor.agent)) {
      return toMatch(descriptor, "missing", text);
    }
    if (descriptor.notAuthErrorPatterns.some((pattern) => pattern.test(text))) {
      return toMatch(descriptor, "unauthenticated", text);
    }
  }

  if (preferred) {
    // The chat's own harness failed to start, under a name the registry does
    // not list (a custom path, a wrapper). Only the operating system's own
    // spawn-failure phrasings count, and only when the failed executable is
    // this agent's: `spawn git ENOENT` must not send the user to reinstall a
    // working OpenCode. A bare "command not found" or "no such file or
    // directory" is as often a harness's slash command or a tool's missing
    // file, and would send the user to reinstall a working CLI.
    const failedExecutable = failedSpawnExecutable(text);
    if (failedExecutable && descriptorMentioned(preferred, failedExecutable)) {
      return toMatch(preferred, "missing", text);
    }
    // A bare 401/403 anywhere in the text is not a sign-in failure: 403 is as
    // often a region, plan or balance refusal, and a number can be a line or
    // PR number. Only an HTTP 401 or an explicit auth phrase counts.
    if (
      /\b(not logged in|not authenticated|unauthorized|authentication failed|login required|invalid api key)\b/i.test(text)
      || /\b(?:status(?:\s+code)?|http(?:\s+status)?|error)\s*[:=]?\s*401\b/i.test(text)
    ) {
      return toMatch(preferred, "unauthenticated", text);
    }
  }

  return null;
}
