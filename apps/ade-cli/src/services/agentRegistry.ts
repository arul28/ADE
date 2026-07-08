export type AgentCliErrorCategory = "missing" | "unauthenticated";

export type AgentCliDescriptor = {
  agent: string;
  displayName: string;
  binaryNames: string[];
  installCommand: string;
  authCommand: string;
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

function npmGlobalInstallCommand(packageName: string): string {
  if (typeof process !== "undefined" && process.platform === "win32") {
    return `npm install -g ${packageName}`;
  }
  return `mkdir -p "$HOME/.npm-global" "$HOME/.local/bin" && NPM_CONFIG_PREFIX="$HOME/.npm-global" npm install -g ${packageName}`;
}

export const AGENT_CLI_REGISTRY: AgentCliDescriptor[] = [
  {
    agent: "claude",
    displayName: "Claude Code",
    binaryNames: ["claude"],
    installCommand: npmGlobalInstallCommand("@anthropic-ai/claude-code"),
    authCommand: "claude auth login",
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
    installCommand: npmGlobalInstallCommand("@openai/codex"),
    authCommand: "codex login",
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
    installCommand: npmGlobalInstallCommand("opencode-ai"),
    authCommand: "opencode auth login",
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
    binaryNames: ["cursor-agent", "cursor"],
    installCommand: 'mkdir -p "$HOME/.local/bin" && curl https://cursor.com/install -fsS | bash',
    authCommand: "cursor-agent login",
    missingErrorPatterns: [
      /\bcursor-agent\b.*\b(command not found|not recognized|not found|enoent)\b/i,
      /\bcursor\b.*\b(command not found|not recognized|enoent)\b/i,
      /\bspawn\s+cursor(?:-agent)?\s+enoent\b/i,
    ],
    notAuthErrorPatterns: [
      /\bcursor(?:-agent)?\b.*\b(not logged in|not authenticated|unauthorized|authentication failed|login required)\b/i,
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
  return descriptor.binaryNames.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text))
    || new RegExp(`\\b${descriptor.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function toMatch(descriptor: AgentCliDescriptor, category: AgentCliErrorCategory): AgentCliErrorMatch {
  return {
    agent: descriptor.agent,
    displayName: descriptor.displayName,
    category,
    installCommand: descriptor.installCommand,
    authCommand: descriptor.authCommand,
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
      return toMatch(descriptor, "missing");
    }
    if (descriptor.notAuthErrorPatterns.some((pattern) => pattern.test(text))) {
      return toMatch(descriptor, "unauthenticated");
    }
  }

  if (preferred) {
    if (
      /\b(command not found|not recognized|enoent|executable file not found|no such file or directory)\b/i.test(text)
      || /\b(?:spawn|exec(?:ute)?|binary|command|executable)\b.*\bnot found\b/i.test(text)
    ) {
      return toMatch(preferred, "missing");
    }
    if (/\b(not logged in|not authenticated|unauthorized|authentication failed|login required|invalid api key|401|403)\b/i.test(text)) {
      return toMatch(preferred, "unauthenticated");
    }
  }

  return null;
}
