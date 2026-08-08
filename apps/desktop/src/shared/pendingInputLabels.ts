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
): string {
  const name = providerDisplayName(source);
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
