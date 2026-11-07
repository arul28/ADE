/**
 * Sign-ins for cloud machines. A new cloud machine has no provider sign-in,
 * and signing in on each one is a step per machine. Instead the person signs
 * in once here: Claude with Claude Code's own `claude setup-token` (a
 * long-lived subscription token made for headless machines), the others with
 * the API key each provider's CLI reads from its environment. ADE keeps them
 * in the person's account vault and gives them to every new Agent 37 machine
 * as instance env. Each variable is the one ADE's own status reads for that
 * provider (authDetector.ts); Codex also needs its auth file, written on the
 * box at boot (agent37CloudSignInBoot.ts).
 */

/** One sign-in kept for new machines. Pi shares OpenCode's OpenRouter key. */
export type Agent37CloudSignInId =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "grok"
  | "copilot"
  | "devin"
  | "muse"
  | "openrouter";

export type Agent37CloudSignInSpec = {
  id: Agent37CloudSignInId;
  /** The providers it signs in, as the card names them. */
  label: string;
  /** `claude-token`: Claude Code's own sign-in makes the token. `key`: the person pastes a key. */
  method: "claude-token" | "key";
  /** The variable a new machine gets it in. */
  env: string;
  /** What the key is called where the person makes it. */
  keyName: string;
  /** Where the person makes the key. */
  keyUrl: string | null;
  /** One sentence the card shows under the row. */
  note: string;
};

export const AGENT37_CLOUD_SIGN_INS: readonly Agent37CloudSignInSpec[] = [
  {
    id: "claude",
    label: "Claude",
    method: "claude-token",
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    keyName: "Claude sign-in",
    keyUrl: null,
    note: "Uses your Claude plan. You sign in once in the browser; ADE keeps the long-lived token Claude Code makes for this.",
  },
  {
    id: "codex",
    label: "Codex",
    method: "key",
    env: "OPENAI_API_KEY",
    keyName: "OpenAI API key",
    keyUrl: "https://platform.openai.com/api-keys",
    // A ChatGPT sign-in can't be copied: each machine refreshes it, and
    // OpenAI then refuses the copies ("refresh token was already used").
    note: "Billed to your OpenAI API account. A ChatGPT sign-in can't be shared between machines, so sign in on the machine to use your plan.",
  },
  {
    id: "cursor",
    label: "Cursor",
    method: "key",
    env: "CURSOR_API_KEY",
    keyName: "Cursor API key",
    keyUrl: "https://cursor.com/dashboard/api",
    note: "Make a User API key in your Cursor dashboard.",
  },
  {
    id: "droid",
    label: "Droid",
    method: "key",
    env: "FACTORY_API_KEY",
    keyName: "Factory API key",
    keyUrl: "https://app.factory.ai/settings/api-keys",
    note: "Make an API key in your Factory settings.",
  },
  {
    id: "grok",
    label: "Grok",
    method: "key",
    env: "XAI_API_KEY",
    keyName: "xAI API key",
    keyUrl: "https://console.x.ai",
    note: "Billed to your xAI API account.",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    method: "key",
    env: "COPILOT_GITHUB_TOKEN",
    keyName: "GitHub token",
    keyUrl: "https://github.com/settings/personal-access-tokens/new",
    note: "A fine-grained personal token with the Copilot Requests permission. Classic tokens don't work.",
  },
  {
    id: "devin",
    label: "Devin",
    method: "key",
    env: "WINDSURF_API_KEY",
    keyName: "Windsurf API key",
    keyUrl: "https://windsurf.com/",
    note: "Devin signs in with your Windsurf API key.",
  },
  {
    id: "muse",
    label: "Muse",
    method: "key",
    env: "META_API_KEY",
    keyName: "Meta API key",
    keyUrl: "https://dev.meta.ai",
    note: "Make an API key on Meta's developer site.",
  },
  {
    id: "openrouter",
    label: "OpenCode and Pi",
    method: "key",
    env: "OPENROUTER_API_KEY",
    keyName: "OpenRouter API key",
    keyUrl: "https://openrouter.ai/keys",
    note: "Both read an OpenRouter key. They also use the OpenAI and xAI keys above.",
  },
];

/** Providers with no sign-in a new machine can start with, and why, in the card's words. */
export const AGENT37_CLOUD_SIGN_IN_GAPS: readonly { provider: string; label: string; reason: string }[] = [
  {
    provider: "qwen",
    label: "Qwen Code",
    reason: "Reads its models and key from its own settings file, and its key would clash with the OpenAI key. Sign in on the machine.",
  },
  {
    provider: "kimi",
    label: "Kimi Code",
    reason: "Reads its key only from its own config file. Sign in on the machine; Kimi shows a link to approve.",
  },
  {
    provider: "antigravity",
    label: "Antigravity",
    reason: "Signs in with Google in a browser on the machine and has no key to hand over. Sign in on the machine.",
  },
];

export function agent37CloudSignInSpec(id: string): Agent37CloudSignInSpec | null {
  return AGENT37_CLOUD_SIGN_INS.find((spec) => spec.id === id) ?? null;
}

export type Agent37ClaudeSignInState = "running" | "saving" | "succeeded" | "failed" | "cancelled";

export type Agent37CloudSignInStatus = {
  /** One entry per sign-in, in `AGENT37_CLOUD_SIGN_INS` order. */
  saved: Array<{ id: Agent37CloudSignInId; saved: boolean; savedAt: number | null }>;
  /** The account could not be read, so `saved` is unknown. */
  unknown: boolean;
  /** Claude's sign-in, running in this computer's ADE background service, if any. */
  claude: {
    state: Agent37ClaudeSignInState;
    /** The link Claude Code printed. The card opens it once. */
    url: string | null;
    /** Claude Code is asking for the code shown in the browser. */
    awaitingCode: boolean;
    /** Why it failed, in one sentence. */
    message: string | null;
  } | null;
};
