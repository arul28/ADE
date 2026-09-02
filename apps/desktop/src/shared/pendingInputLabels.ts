// Human-facing provider name for a pending-input `source`
// ("claude" -> "Claude", "codex" -> "Codex", ...). Shared by the desktop chat
// card, the iOS companion, and the `ade code` TUI so the question/plan header
// reads the same on every surface.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  anthropic: "Claude",
  codex: "Codex",
  openai: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  factory: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
  qwen: "Qwen",
  kimi: "Kimi",
  moonshot: "Kimi",
  grok: "Grok",
  xai: "Grok",
  copilot: "GitHub Copilot",
  "github-copilot": "GitHub Copilot",
  // Every ACP provider raises permissions through the same protocol method, so
  // the shared source needs a name a person recognises rather than "Acp".
  acp: "Agent",
  ade: "ADE",
  agent: "Agent",
};

export function providerDisplayName(source: string | null | undefined): string {
  const key = (source ?? "").trim().toLowerCase();
  if (!key) return "Agent";
  const known = PROVIDER_DISPLAY_NAMES[key];
  if (known) return known;
  return key
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const CHAT_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
  // The category, not a plugin. A plugin-owned chat carries the runtime's real
  // name on `session.runtimeLabel`; callers that hold a session should prefer
  // `chatSessionAgentLabel` in `types/chat.ts`, which reads it. This is what is
  // left when all somebody has is the provider string.
  plugin: "Plugin",
  qwen: "Qwen",
  kimi: "Kimi",
  grok: "Grok",
  copilot: "GitHub Copilot",
};

export function providerDisplayLabel(
  provider: string | null | undefined,
  fallback: string,
): string {
  const key = (provider ?? "").trim().toLowerCase();
  if (!key) return fallback;
  const known = CHAT_PROVIDER_DISPLAY_NAMES[key];
  if (known) return known;
  return key
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// One-line header label for a pending input, derived from the source + kind.
// Questions read "{Provider} asks"; plans read "{Provider} · Plan ready".
// This replaces the old "Input needed · {source}" + "Question from {provider}"
// double-labelling the user flagged as repetitive.
export function pendingInputHeaderLabel(
  source: string | null | undefined,
  kind: string | null | undefined,
  options?: {
    /**
     * The name to say instead of the provider's.
     *
     * For a card the host raised on somebody else's behalf — a plugin install,
     * removal or enable, all of which travel as `source: "ade"`. The KIND word
     * is untouched: "Focus · Approval" is still an approval, and a reader
     * scanning for the word finds it in the same place.
     */
    displayName?: string | null;
  },
): string {
  const named = options?.displayName?.trim();
  const name = named && named.length ? named : providerDisplayName(source);
  switch (kind) {
    case "plan_approval":
      return `${name} · Plan ready`;
    case "permissions":
      return `${name} · Permission`;
    case "approval":
      return `${name} · Approval`;
    case "model_selection":
      return `${name} · Pick a model`;
    default:
      return `${name} asks`;
  }
}
