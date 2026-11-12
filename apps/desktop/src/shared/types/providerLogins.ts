/**
 * Provider sign-ins kept in the ADE account (the `provider_logins` actions).
 *
 * A sign-in is one login of one provider that one computer made. The account
 * keeps it as one vault item (kind `provider_login`), so ADE Cloud computers
 * can use it. Nothing in these types ever holds a token, a key, a file's
 * content or a hash of one: they are what `status` returns to the person, to
 * agents and to other machines.
 */

/** The providers ADE knows how to talk about here, carried or not. */
import type { ClaudePassStatusEntry } from "../cloudSignIns";
import type { AgentChatProviderLoginNotice } from "./chat";

const PROVIDER_LOGIN_PROVIDERS = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
  "copilot",
  "grok",
  "droid",
  "kimi",
  "qwen",
  "devin",
  "antigravity",
  "muse",
] as const;

export type ProviderLoginProvider = (typeof PROVIDER_LOGIN_PROVIDERS)[number];

export function isProviderLoginProvider(value: unknown): value is ProviderLoginProvider {
  return typeof value === "string" && (PROVIDER_LOGIN_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The `provider_logins` actions, one list for the IPC allow-list and the
 * action policy (`actionPolicy.ts`). The five account writes change which
 * sign-ins ADE Cloud uses; only the person makes them (`ADE_ACTION_USER_ONLY`):
 * outside apps and agents read the status and never change the sign-in in use,
 * switch one off, or remove one. A person's `ade` and an ADE MCP app with full
 * access both run as `cto` with no chat identity, so the CTO and user-client
 * checks alone would let them through; only the desktop's client names reach a
 * user-only action.
 */
export const PROVIDER_LOGIN_ACCOUNT_WRITES = ["use", "setCloud", "setCloudAll", "setCloudBalance", "remove"] as const;
/** Every action but `status`: the person's (copy now, the OS keyring read, the GitHub CLI switch, and the account writes). */
export const PROVIDER_LOGIN_PERSON_ACTIONS = ["captureNow", "allowKeychain", "allowGitHubCli", ...PROVIDER_LOGIN_ACCOUNT_WRITES] as const;
export const PROVIDER_LOGIN_ACTIONS = ["status", ...PROVIDER_LOGIN_PERSON_ACTIONS] as const;
export type ProviderLoginAction = (typeof PROVIDER_LOGIN_ACTIONS)[number];

export function isProviderLoginAction(value: unknown): value is ProviderLoginAction {
  return typeof value === "string" && (PROVIDER_LOGIN_ACTIONS as readonly string[]).includes(value);
}

/** Fixed: copy once. Renewing: the provider renews it; one computer may renew it. */
export type ProviderLoginClass = "fixed" | "renewing";

/**
 * How a provider reaches ADE Cloud:
 * - `carried`: ADE copies its sign-in into the account.
 * - `fallback`: sign in on the cloud computer, or use a key.
 * - `never`: ADE never copies it (Claude's own login; P6 handles the Claude pass).
 */
export type ProviderLoginCarry = "carried" | "fallback" | "never";

/** Why this computer does not copy its sign-ins into the account right now. */
export type ProviderLoginCaptureOffReason =
  | "not_this_runtime"
  | "embedded"
  | "dev_brain"
  | "sync_off"
  | "signed_out"
  | "no_ade_cloud"
  | "ade_cloud_unknown"
  | "all_off"
  | "vault_unavailable";

/** What this computer found for one provider on its last pass. */
export type ProviderLoginLocalState =
  /** In the account and the same as the file here. */
  | "captured"
  /** No login file here. */
  | "not_signed_in"
  /** The login is in the OS keychain or keyring; ADE does not read it in the background. */
  | "os_store"
  /** The file changed in the last seconds; the next pass reads it. */
  | "settling"
  /** The login is too big for one account item. */
  | "too_large"
  /** The file is there but ADE could not read a login from it. */
  | "unreadable"
  /**
   * The account holds this sign-in, but ADE could not read the account's copy
   * on this computer. Capture leaves that copy as it is.
   */
  | "account_unreadable"
  /** The person removed this sign-in from the account; a new sign-in here adds it again. */
  | "removed_from_account"
  /** Another computer renews this sign-in, and its copy is newer. */
  | "other_owner_newer"
  /**
   * A cloud computer renewed this computer's sign-in while it was off, and
   * ADE wrote the newer copy into the login file here (step 3b).
   */
  | "written_back"
  /** A saved ADE Cloud key wrote this file; it stays a key. */
  | "from_saved_key"
  /**
   * The account service refused this sign-in (an older service that does not
   * know sign-ins yet). ADE keeps it on this computer and tries again every hour.
   */
  | "account_refused"
  /** On a cloud computer: the file is the account's sign-in that ADE wrote here. */
  | "from_account"
  /** Not looked at: capture is off, or the provider is not carried. */
  | "not_checked";

export type ProviderLoginOrigin = {
  /** The computer's name, as it was when the sign-in was captured. */
  label: string;
  /**
   * The computer's account machine key, so a page names it as the account's
   * machine list does today (its display name), not as it was named at
   * capture (a hostname). Absent from an older brain.
   */
  machineKey?: string;
  platform: string;
  /** True when this computer made the sign-in. */
  thisComputer: boolean;
};

/** One sign-in kept in the account. */
export type ProviderLoginSignIn = {
  /** The vault key, `<provider>/<origin>.<slot>`. Not a secret. */
  key: string;
  provider: ProviderLoginProvider;
  slot: string;
  class: ProviderLoginClass;
  origin: ProviderLoginOrigin;
  /** The account name the login file holds, when it holds one. */
  account: { email: string | null; id: string | null } | null;
  capturedAt: string | null;
  renewedAt: string | null;
  /** The name of the computer that renewed this copy last; it may be a cloud computer (step 3b). */
  renewedBy: string | null;
  /** True when `renewedBy` is an ADE Cloud computer that took the renewal over. */
  renewedByCloud?: boolean;
  /**
   * The computer that renews this sign-in now (the vault's owner): its name,
   * whether it is a cloud computer, and whether it is this computer. Null for
   * a sign-in that never renews, or when the owner is not known.
   */
  renewsNow?: { label: string; cloudComputer: boolean; thisComputer: boolean } | null;
  expiresAt: string | null;
  /** The switch for ADE Cloud. On from the start. */
  onForCloud: boolean;
  /** True when ADE Cloud uses this sign-in for its provider. */
  inUseOnCloud: boolean;
};

/**
 * The account a sign-in copy is for, the one rule for "same account": the
 * apply's pick of the freshest copy (main) and one card per account (the
 * page) both read it. The email (any case), else the provider's account id.
 * Codex is the exception: its id is the ChatGPT workspace, and one email can
 * have several (personal, Team) with different plans, so a Codex copy is
 * email and id together when it names both. Null when the login names
 * neither: such a copy is only itself.
 */
export function accountIdentityOf(
  provider: ProviderLoginProvider,
  account: { email: string | null; id: string | null } | null | undefined,
): string | null {
  const email = account?.email?.trim().toLowerCase() || null;
  const id = account?.id?.trim() || null;
  if (provider === "codex" && email && id) return `email:${email}\u0000id:${id}`;
  if (email) return `email:${email}`;
  return id ? `id:${id}` : null;
}

export type ProviderLoginProviderStatus = {
  provider: ProviderLoginProvider;
  carry: ProviderLoginCarry;
  /** Plain words: why a provider is fallback or never, or what the local state means. */
  message: string;
  local: {
    state: ProviderLoginLocalState;
    /** The vault key of this computer's sign-in, when it has one. */
    key: string | null;
    /**
     * The last write-back here (step 3b): when ADE wrote the newer copy into
     * the login file, and the name of the computer that renewed it.
     */
    writtenBack?: { at: string; renewedBy: string } | null;
  };
  /**
   * A sign-in ADE copies from this computer's OS keyring only when the person
   * allows it (Antigravity's agy CLI login, on a person's own macOS, Windows or
   * Linux desktop). Absent on a cloud computer and for other providers.
   */
  keychain?: {
    /** Which OS store the read asks. Absent from an older ADE (say "the OS keyring"). */
    store?: ProviderLoginKeyringStore;
    /** True when an Allow can run now (capture is on). */
    canAllow: boolean;
    /**
     * Whether the OS store holds the sign-in, from an attribute-only check;
     * null while unknown. Absent from an older ADE.
     */
    present?: boolean | null;
    /** The last Allow that put the sign-in in the account; null before the first. */
    allowedAt: string | null;
    /** Plain words for the tile, such as "Copied from this computer on Nov 10, 2026. Allow again to update." */
    message: string;
  };
  /** Copilot only, on a person's own computer: this computer's GitHub CLI login (P5 G1). Absent elsewhere. */
  ghCli?: ProviderLoginGhCliStatus;
};

/** The OS store of a keyring Allow: the macOS Keychain, Windows Credential Manager, or a Linux Secret Service keyring. */
export type ProviderLoginKeyringStore = "keychain" | "credential_manager" | "keyring";

/**
 * This computer's GitHub CLI login for github.com, which ADE copies for
 * Copilot on ADE Cloud only after the person turns it on here
 * (`providerLogins.allowGitHubCli`). Off at the start. `present` and `user`
 * come from gh's `hosts.yml` only (a file read, never a process or the
 * Keychain). No token, no hash.
 */
export type ProviderLoginGhCliStatus = {
  /** gh has a github.com login on this computer. */
  present: boolean;
  /** ADE couldn't read gh's `hosts.yml` here (not a missing file): `present` is unknown, and `lastError` says so. */
  readFailed?: boolean;
  /** Its active user, from `hosts.yml`. */
  user: string | null;
  /** The person turned it on for this computer (it lasts until they turn it off or sign out of ADE). */
  allowed: boolean;
  /**
   * True when turning it on can work now: this computer copies sign-ins, or
   * only the one off switch for all is off (then the choice is kept and
   * nothing leaves this computer until that switch is on again:
   * `thisComputer.reason === "all_off"`). False on a cloud computer.
   */
  canAllow: boolean;
  /** The login is a classic personal token (`ghp_`), which Copilot does not accept: not copied. */
  unsupported?: "classic_token";
  /** Why the last read gave no token, in plain words (gh missing, a timeout, an error). */
  lastError?: string;
  /** When ADE last read the login with gh (ISO), after the person turned it on. */
  lastReadAt?: string;
};

/**
 * What a cloud computer did with one ADE Cloud place (a provider, or `pi:<sub>`):
 * - `applied`: the account's sign-in is written here.
 * - `own`: the sign-in in use was made on this computer; ADE left it as it is.
 * - `key`: the saved ADE Cloud key is in use.
 * - `none`: nothing is in use (none switched on, or the off switch for all).
 * - `kept_local`: a sign-in made here is not in the account yet, so ADE did not overwrite it.
 * - `failed`: ADE could not write it; the next pass tries again.
 */
export type ProviderLoginApplyState = "applied" | "own" | "key" | "none" | "kept_local" | "failed";

export type ProviderLoginApplied = {
  /** The provider, or `pi:<sub>` for one Pi sign-in. */
  place: string;
  provider: ProviderLoginProvider | null;
  state: ProviderLoginApplyState;
  /** The vault key in use, or "key" for the saved key; null when none. */
  key: string | null;
  /** The refresh token was taken out: this computer cannot renew it. */
  accessOnly: boolean;
  /** False when ADE could not take the refresh token out (Droid, an unknown Grok shape). */
  renewalSafe: boolean;
  appliedAt: string | null;
  message: string;
  /**
   * The last turn here that needed a fresh copy and did not get one: the
   * computer that renews this sign-in did not renew it in time (step 3a).
   */
  ownerOff?: { ownerLabel: string; at: string } | null;
};

/**
 * What the check before a turn found on a cloud computer. `owner_off`: the
 * copy here was about to expire, the computer that renews it (named) did not
 * send a new one in the short wait, and this computer could not take the
 * renewal over in time (step 3b: the last resort).
 */
export type ProviderLoginGateOutcome = (
  /** `renewedHere`: this cloud computer took the renewal over and renewed the sign-in for this turn (step 3b). */
  | { result: "ok"; renewedHere?: boolean }
  | { result: "timeout" }
  | { result: "owner_off"; provider: ProviderLoginProvider; ownerLabel: string }
) & {
  /**
   * The lines for the chat of this turn, in order (step 3d): the `owner_off`
   * warning, and the first cloud chat line. A terminal logs them only.
   */
  notices?: ProviderLoginChatNotice[];
};

/** One line the gate gives the chat that waits on it; words and data only, never a secret. */
export type ProviderLoginChatNotice = {
  severity: "info" | "warning";
  status?: string;
  message: string;
  providerLogin: AgentChatProviderLoginNotice;
};

/** What a caller of the gate may pass: `onWait` hears the line to show while the turn waits (step 3b). */
export type ProviderLoginGateOptions = {
  /** `providerLogin`: what the line is about, when it is more than words (`renewing`: this computer renews it). */
  onWait?: (message: string, providerLogin?: AgentChatProviderLoginNotice) => void;
  /**
   * The caller shows the first cloud chat line (a chat turn, not a terminal):
   * only then does the gate give it and set the mark that it was shown.
   */
  firstCloudChat?: boolean;
};

export type ProviderLoginStatus = {
  thisComputer: {
    capture: "on" | "off";
    reason: ProviderLoginCaptureOffReason | null;
    /** Plain words for `reason`; null when capture is on. */
    message: string | null;
    label: string | null;
    cloudComputer: boolean;
    lastPassAt: string | null;
  };
  cloud: {
    /** The one off switch for all of ADE Cloud's sign-ins. */
    enabled: boolean;
    /**
     * A copy of the account setting's picks: place ("codex", "pi:xai",
     * "claude") → a sign-in's vault key, "key" for the saved ADE Cloud key, or
     * a Claude pass key. A place with no entry uses the newest switched-on
     * sign-in. Keys only, never a secret.
     */
    inUse: Record<string, string>;
    claude: {
      /**
       * Claude's smart balance on ADE Cloud (`providerLogins.setCloudBalance`).
       * One switch for ADE Cloud, off at the start; each own computer has its
       * own switch, and nothing syncs between them.
       */
      smartBalance: boolean;
    };
  };
  signIns: ProviderLoginSignIn[];
  providers: ProviderLoginProviderStatus[];
  /** On a cloud computer, what it applied for each place; null on every other computer. */
  applied: ProviderLoginApplied[] | null;
} & ProviderLoginStatusParts;

/**
 * Fields another package adds to the status (`registerProviderLoginStatusPart`).
 * P6 fills `claudePasses` (claudePassSync.ts).
 */
export type ProviderLoginStatusParts = {
  claudePasses?: ClaudePassStatusEntry[];
};

/**
 * The vault kind `provider_login` also holds Claude passes (P6), under this
 * key prefix. They are never a carried sign-in: not listed, applied, removed
 * or pruned by the sign-in sync.
 *
 * The one definition of a pass's names: its vault key `claude-pass/<id>`, and
 * the Claude account a cloud computer makes for it, `pass-<id>`. The id is 12
 * hex characters, or `legacy` for the single item of older versions.
 */
export const CLAUDE_PASS_KEY_PREFIX = "claude-pass/";
export const CLAUDE_PASS_LEGACY_KEY = "claude-pass/legacy";
const CLAUDE_PASS_ACCOUNT_ID_PREFIX = "pass-";
export const CLAUDE_PASS_KEY_PATTERN = /^claude-pass\/(legacy|[0-9a-f]{12})$/;
export const CLAUDE_PASS_ACCOUNT_ID_PATTERN = /^pass-(legacy|[0-9a-f]{12})$/;

/** A Claude pass's vault key (strict: the id ADE writes). On a string it does not narrow, so the other branch keeps the string. */
export function isClaudePassKey(key: string): boolean;
export function isClaudePassKey(key: unknown): key is string;
export function isClaudePassKey(key: unknown): boolean {
  return typeof key === "string" && CLAUDE_PASS_KEY_PATTERN.test(key);
}

/** The Claude account id of a pass (`pass-<id>`). */
export function isClaudePassAccountId(id: string | null | undefined): boolean {
  return typeof id === "string" && CLAUDE_PASS_ACCOUNT_ID_PATTERN.test(id);
}

/** `claude-pass/<id>` → `pass-<id>`. Only for a key `isClaudePassKey` accepts. */
export function claudePassAccountId(key: string): string {
  return `${CLAUDE_PASS_ACCOUNT_ID_PREFIX}${key.slice(CLAUDE_PASS_KEY_PREFIX.length)}`;
}

/** `pass-<id>` → `claude-pass/<id>`; null for any other account id. */
export function claudePassKeyOfAccountId(id: string | null | undefined): string | null {
  const match = CLAUDE_PASS_ACCOUNT_ID_PATTERN.exec(id?.trim() ?? "");
  return match ? `${CLAUDE_PASS_KEY_PREFIX}${match[1]}` : null;
}
