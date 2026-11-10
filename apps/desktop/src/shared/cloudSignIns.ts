/**
 * Sign-ins for cloud machines. A new cloud machine has no provider sign-in,
 * and signing in on each one is a step per machine. Instead the person signs
 * in once here: Claude with Claude Code's own `claude setup-token` (a
 * long-lived subscription token made for headless machines), the others with
 * the API key each provider's CLI reads from its environment. ADE keeps them
 * in the person's account vault and gives them to every new cloud machine
 * as instance env. Each variable is the one ADE's own status reads for that
 * provider (authDetector.ts); Codex also needs its auth file, written on the
 * box at boot (cloudSignInBoot.ts).
 */

/** One sign-in kept for new machines. Pi shares OpenCode's OpenRouter key. */
export type CloudSignInId =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "grok"
  | "copilot"
  | "devin"
  | "muse"
  | "openrouter";

export type CloudSignInSpec = {
  id: CloudSignInId;
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

export const CLOUD_SIGN_INS: readonly CloudSignInSpec[] = [
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
export const CLOUD_SIGN_IN_GAPS: readonly { provider: string; label: string; reason: string }[] = [
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

export function cloudSignInSpec(id: string): CloudSignInSpec | null {
  return CLOUD_SIGN_INS.find((spec) => spec.id === id) ?? null;
}

/**
 * One approve, in order: `running` (Claude Code's sign-in waits for the
 * browser), `verifying` (ADE asks Claude Code which account the new pass is
 * for), then `saving` and `succeeded`. `mismatch` waits for the person: the
 * pass is for another account than the one pressed (Keep it, or try again).
 * `saved_here`: the pass is kept on this computer but has not reached the
 * account (`upload` says why); ADE sends it on its own. Never "Signed in".
 */
export type CloudClaudeSignInState =
  | "running"
  | "verifying"
  | "mismatch"
  | "saving"
  | "succeeded"
  | "saved_here"
  | "failed"
  | "cancelled";

/**
 * Where a pass's last write is. `account`: in the ADE account. `pending`: kept
 * on this computer, sent on the next sync. `refused`: the account service
 * refused it (an older server); kept on this computer and tried every hour.
 */
export type ClaudePassUpload = "account" | "pending" | "refused";

/**
 * How ADE knows which account a pass is for. `match`: Claude Code named the
 * account the person pressed (or, with none pressed, named one). `kept_other`:
 * it named another account and the person kept it. `unchecked`: Claude Code
 * named none, so the label is the pressed account.
 */
export type ClaudePassCheck = "match" | "kept_other" | "unchecked";

/** Where a pass's label email came from. */
export type ClaudePassLabelSource = "checked" | "pressed" | "typed" | "none";

/** A pass's place in its year: the tile line starts at `ending_soon`. */
export type ClaudePassState = "active" | "ending_soon" | "ended";

/** One Claude pass for ADE Cloud, as a window may see it: never the token. */
export type CloudClaudePass = {
  /** Vault key, `claude-pass/<12 hex>` or `claude-pass/legacy`. Stable. */
  key: string;
  /** The account's email, or "Claude pass from <date>" without one. */
  label: string;
  email: string | null;
  check: ClaudePassCheck;
  /** The pass the single sign-in of older versions kept. */
  legacy: boolean;
  /** The computer the approve ran on, or null (a legacy pass). */
  madeOnLabel: string | null;
  createdAt: number;
  /** Last Renew of this pass, or null. */
  renewedAt: number | null;
  expiresAt: number;
  /** `estimate`: save time plus one year. `claude`: Claude Code reported it. */
  expiresAtSource: "estimate" | "claude";
  /** Whole days left, never below 0. */
  endsInDays: number;
  state: ClaudePassState;
  /** When the one "ends soon" notice is due. */
  noticeDueAt: number;
  /** The local Claude account on the brain that answered with the same email, or null. */
  localInstanceId: string | null;
  /** Not `account`: only on the computer that answered so far. */
  upload: ClaudePassUpload;
  unreadable: false;
};

/**
 * A pass row this computer can't read (the relay could not open it, or a
 * newer version wrote it). Shown as unknown, never hidden; Remove still works.
 */
export type CloudClaudePassUnreadable = { key: string; unreadable: true };

/** A signed-in Claude account of the computer the approve runs on, to pick from. */
export type CloudClaudeLocalAccount = {
  instanceId: string;
  email: string;
  isDefault: boolean;
};

export type CloudSignInStatus = {
  /** One entry per sign-in, in `CLOUD_SIGN_INS` order. */
  saved: Array<{ id: CloudSignInId; saved: boolean; savedAt: number | null }>;
  /** The account could not be read, so `saved` is unknown. */
  unknown: boolean;
  /** Claude's sign-in, running in this computer's ADE background service, if any. */
  claude: {
    state: CloudClaudeSignInState;
    /** The link Claude Code printed. The card opens it once. */
    url: string | null;
    /** Claude Code is asking for the code shown in the browser. */
    awaitingCode: boolean;
    /** Why it failed, in one sentence. */
    message: string | null;
    /** The account the person pressed "Sign in" for, or null ("Another account"). */
    forEmail: string | null;
    /** The account Claude Code named for the new pass; set in `mismatch` and after. */
    foundEmail: string | null;
    /** Set once the check ran: in `mismatch`, `saving` and `succeeded`. */
    check: ClaudePassCheck | null;
    /** The pass this approve renews, or null. */
    renewKey: string | null;
    /** The pass key the approve saved, once `succeeded` or `saved_here`. */
    savedKey: string | null;
    /** Where the saved pass is; set with `savedKey`. */
    upload: ClaudePassUpload | null;
  } | null;
  /** The signed-in Claude accounts of the computer that answers, for the account list. */
  localAccounts: CloudClaudeLocalAccount[];
  /**
   * Every Claude pass of the account, newest first, then the unreadable rows;
   * null when the passes can't be read here. Narrow on `unreadable`.
   */
  passes: Array<CloudClaudePass | CloudClaudePassUnreadable> | null;
};
