/**
 * Sign-ins for cloud machines. A new cloud machine has no provider sign-in,
 * and signing in on each one is a step per machine. Instead the person signs
 * in once here: Claude with Claude Code's own `claude setup-token` (a
 * long-lived subscription token made for headless machines), the others with
 * the API key each provider's CLI reads from its environment. ADE keeps them
 * in the person's account vault; each cloud computer's brain reads them from
 * there and puts each in the variable ADE's own status reads for that
 * provider (authDetector.ts), or Codex's auth file
 * (providerLogins/providerLoginApplyPass.ts). They never go in a computer's
 * instance env: the Worker and the host would see them.
 */

import type { ProviderLoginProvider } from "./types/providerLogins";

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
  /** The providers it signs in. OpenRouter's key is shared by OpenCode and Pi. */
  providers: readonly ProviderLoginProvider[];
  /** `claude-token`: Claude Code's own sign-in makes the token. `key`: the person pastes a key. */
  method: "claude-token" | "key";
  /** The variable the brain on a cloud computer puts it in. */
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
    providers: ["claude"],
    method: "claude-token",
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    keyName: "Claude sign-in",
    keyUrl: null,
    note: "Uses your Claude plan. You sign in once in the browser; ADE keeps the long-lived token Claude Code makes for this.",
  },
  {
    id: "codex",
    label: "Codex",
    providers: ["codex"],
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
    providers: ["cursor"],
    method: "key",
    env: "CURSOR_API_KEY",
    keyName: "Cursor API key",
    keyUrl: "https://cursor.com/dashboard/api",
    note: "Make a User API key in your Cursor dashboard.",
  },
  {
    id: "droid",
    label: "Droid",
    providers: ["droid"],
    method: "key",
    env: "FACTORY_API_KEY",
    keyName: "Factory API key",
    keyUrl: "https://app.factory.ai/settings/api-keys",
    note: "Make an API key in your Factory settings.",
  },
  {
    id: "grok",
    label: "Grok",
    providers: ["grok"],
    method: "key",
    env: "XAI_API_KEY",
    keyName: "xAI API key",
    keyUrl: "https://console.x.ai",
    note: "Billed to your xAI API account.",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    providers: ["copilot"],
    method: "key",
    env: "COPILOT_GITHUB_TOKEN",
    keyName: "GitHub token",
    keyUrl: "https://github.com/settings/personal-access-tokens/new",
    note: "A fine-grained personal token with the Copilot Requests permission. Classic tokens don't work.",
  },
  {
    id: "devin",
    label: "Devin",
    providers: ["devin"],
    method: "key",
    env: "WINDSURF_API_KEY",
    keyName: "Windsurf API key",
    keyUrl: "https://windsurf.com/",
    note: "Devin signs in with your Windsurf API key.",
  },
  {
    id: "muse",
    label: "Muse",
    providers: ["muse"],
    method: "key",
    env: "META_API_KEY",
    keyName: "Meta API key",
    keyUrl: "https://dev.meta.ai",
    note: "Make an API key on Meta's developer site.",
  },
  {
    id: "openrouter",
    label: "OpenCode and Pi",
    providers: ["opencode", "pi"],
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

/** The saved ADE Cloud key (a pasted key, never Claude's token) that signs in `provider`, or null. */
export function cloudSignInKeyFor(provider: ProviderLoginProvider): CloudSignInId | null {
  return CLOUD_SIGN_INS.find((spec) => spec.method === "key" && spec.providers.includes(provider))?.id ?? null;
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

/**
 * A pass's place in its year: the tile line starts at `ending_soon`.
 * `estimate_passed`: the estimated end (save + 365 days) is past, but Claude
 * has not refused the pass, so it still works. `ended`: Claude refused the
 * pass as no longer valid (expired or revoked); only that refusal ends it,
 * and a Renew clears it.
 */
export type ClaudePassState = "active" | "ending_soon" | "estimate_passed" | "ended";

/**
 * The sign-in the end warning names (`cloudAccess.read().passEnd`): the
 * soonest one whose notice is due (7 days before its end), whose expected end
 * has passed, or that ended. A Claude pass, or a key ADE Cloud carries whose
 * provider wrote its end date (Cursor's key from the Cursor sign-in); a key
 * with no end date from its provider is never named (no guess). Computed in
 * desktop main from the account's vault, only while ADE Cloud is on. No token.
 */
export type CloudPassEnd = {
  /** Absent on a Claude pass (older answers have no kind). */
  kind?: "claude_pass" | "key";
  /** For a key: the provider it signs in. */
  provider?: ProviderLoginProvider;
  /** For a key: the computer the sign-in that made it was on, or null. */
  madeOnLabel?: string | null;
  /** The vault key: `claude-pass/<id>` or `<provider>/<origin>.<slot>`. */
  key: string;
  /** `estimate_passed` is a Claude pass only: a key's end date is the provider's own. */
  state: "ending" | "estimate_passed" | "ended";
  email: string | null;
  expiresAt: number;
  endedAt: number | null;
  endsInDays: number;
  /** Other sign-ins (passes or keys) that are also due. */
  more: number;
  /** Every due sign-in as `key:state`: a dismiss lasts until this changes (once per state). */
  fingerprint: string;
};

/**
 * Where one window of a pass's use comes from. `pass_turn`: the pass's own
 * turns on a cloud computer (`rate_limit_event`). `account_here`: the Claude
 * account with the same verified email that one of the person's computers
 * tracks; Claude's limits belong to the account, so they are the pass's too.
 * `label`: the computer that read it, or null when the reader is the one asked.
 */
export type ClaudePassUseSource = { kind: "pass_turn" | "account_here"; label: string | null };

/** One window of a pass's use. */
export type ClaudePassUseWindow = {
  /** 0–100, or null when the source gave no share. */
  usedPct: number | null;
  /** Epoch ms, or null. */
  resetsAt: number | null;
  /** What Claude said in the turn; null for `account_here` (the usage read gives no status). */
  status: "allowed" | "allowed_warning" | "rejected" | null;
  /** Epoch ms of the reading. */
  seenAt: number;
  /** The reset time is past: the share is from before the reset, so do not show it. */
  resetSinceSeen: boolean;
  from: ClaudePassUseSource;
};

/** A pass's use: `none_seen` shows "No use seen yet", never 0 %. */
export type ClaudePassUseView =
  | { state: "none_seen" }
  | {
    state: "seen";
    /** Epoch ms of the newest window. */
    lastSeenAt: number;
    fiveHour: ClaudePassUseWindow | null;
    weekly: ClaudePassUseWindow | null;
    models: Partial<Record<"opus" | "sonnet", ClaudePassUseWindow>>;
    /** The source of the newest window, for a one-line caption. */
    from: ClaudePassUseSource & { seenAt: number };
  };

function newerWindow(a: ClaudePassUseWindow | null | undefined, b: ClaudePassUseWindow | null | undefined): ClaudePassUseWindow | null {
  if (!a) return b ?? null;
  if (!b) return a;
  // A window from before its reset loses to one that is still current.
  if (a.resetSinceSeen !== b.resetSinceSeen) return a.resetSinceSeen ? b : a;
  return b.seenAt > a.seenAt ? b : a;
}

/**
 * Two readings of one pass's use joined: per window, the newer one by
 * `seenAt` (a current window beats one from before its reset). For a view
 * that holds both the cloud computer's `claudePasses[].use` (`pass_turn`) and
 * the account side's `CloudClaudePass.use` (`account_here`).
 */
export function newerClaudePassUse(a: ClaudePassUseView | null | undefined, b: ClaudePassUseView | null | undefined): ClaudePassUseView {
  if (!a || a.state === "none_seen") return b ?? { state: "none_seen" };
  if (!b || b.state === "none_seen") return a;
  const fiveHour = newerWindow(a.fiveHour, b.fiveHour);
  const weekly = newerWindow(a.weekly, b.weekly);
  const models: Partial<Record<"opus" | "sonnet", ClaudePassUseWindow>> = {};
  for (const family of ["opus", "sonnet"] as const) {
    const window = newerWindow(a.models[family], b.models[family]);
    if (window) models[family] = window;
  }
  const windows = [fiveHour, weekly, models.opus, models.sonnet].filter((window): window is ClaudePassUseWindow => Boolean(window));
  if (windows.length === 0) return { state: "none_seen" };
  const newest = windows.reduce((best, window) => (window.seenAt > best.seenAt ? window : best));
  return { state: "seen", lastSeenAt: newest.seenAt, fiveHour, weekly, models, from: { ...newest.from, seenAt: newest.seenAt } };
}

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
  /** When Claude refused the pass as no longer valid (`state: "ended"`), else null. */
  endedAt: number | null;
  /** When the one "ends soon" notice is due. */
  noticeDueAt: number;
  /** The local Claude account on the brain that answered with the same email, or null. */
  localInstanceId: string | null;
  /**
   * The limits of the Claude account with the same verified email (`check:
   * "match"`) that this computer tracks, from its own reading or another of
   * the person's computers (`from.kind: "account_here"`). `none_seen` when no
   * such account has numbers. Join it with the cloud computer's
   * `claudePasses[].use` through `newerClaudePassUse`.
   */
  use: ClaudePassUseView;
  /** Not `account`: only on the computer that answered so far. */
  upload: ClaudePassUpload;
  unreadable: false;
};

/**
 * One pass in `provider_logins.status` (`claudePasses`), as the brain that
 * answers sees it (claudePassSync.ts). Never the token.
 */
export type ClaudePassStatusEntry =
  | {
    key: string;
    unreadable: false;
    label: string;
    email: string | null;
    check: ClaudePassCheck;
    legacy: boolean;
    /** Not in the account setting's `off` list (and ADE Cloud sign-ins are on). */
    on: boolean;
    /** The pass new chats on ADE Cloud use. */
    newChats: boolean;
    madeOnLabel: string | null;
    createdAt: number;
    renewedAt: number | null;
    expiresAt: number;
    expiresAtSource: "estimate" | "claude";
    endsInDays: number;
    state: ClaudePassState;
    noticeDueAt: number;
    upload: ClaudePassUpload;
    /** The local Claude account (not a pass account) with the same email on the brain that answers. */
    localInstanceId: string | null;
    /** Cloud computer only: this pass is an account here now. */
    appliedHere: boolean;
    /** Cloud computer only: the pass's folder here also holds a sign-in someone made. */
    homeHasLogin: boolean;
    /** The account setting's Claude smart balance switch for ADE Cloud (the same on every entry). */
    smartBalance: boolean;
    /** When Claude refused the pass as no longer valid (`state: "ended"`), else null. */
    endedAt: number | null;
    /**
     * Use from this pass's own turns, on the computer that answers (the cloud
     * computer that ran them). `none_seen` until its first turn there: never 0 %.
     */
    use: ClaudePassUseView;
  }
  | { key: string; unreadable: true };

/**
 * A pass row this computer can't read (the relay could not open it, or a
 * newer version wrote it). Shown as unknown, never hidden; Remove still works.
 */
export type CloudClaudePassUnreadable = { key: string; unreadable: true };

/**
 * What a window passes to Claude's approve. `forEmail`: the account the
 * person pressed (none = "Another account"). `renewKey`: the pass a Renew
 * replaces. `labelEmail`: an email the person typed, kept only when Claude
 * names none and nothing was pressed. The brain checks every field.
 */
export type CloudSignInClaudeStartArgs = {
  forEmail?: string | null;
  renewKey?: string | null;
  labelEmail?: string | null;
};

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
