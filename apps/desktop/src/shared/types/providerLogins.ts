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
export const PROVIDER_LOGIN_PROVIDERS = [
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
  /** The person removed this sign-in from the account; a new sign-in here adds it again. */
  | "removed_from_account"
  /** Another computer renews this sign-in, and its copy is newer. */
  | "other_owner_newer"
  /** A saved ADE Cloud key wrote this file; it stays a key. */
  | "from_saved_key"
  /** Not looked at: capture is off, or the provider is not carried. */
  | "not_checked";

export type ProviderLoginOrigin = {
  /** The computer's name, as it was when the sign-in was captured. */
  label: string;
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
  renewedBy: string | null;
  expiresAt: string | null;
  /** The switch for ADE Cloud. On from the start. */
  onForCloud: boolean;
  /** True when ADE Cloud uses this sign-in for its provider. */
  inUseOnCloud: boolean;
};

export type ProviderLoginProviderStatus = {
  provider: ProviderLoginProvider;
  carry: ProviderLoginCarry;
  /** Plain words: why a provider is fallback or never, or what the local state means. */
  message: string;
  local: {
    state: ProviderLoginLocalState;
    /** The vault key of this computer's sign-in, when it has one. */
    key: string | null;
  };
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
  };
  signIns: ProviderLoginSignIn[];
  providers: ProviderLoginProviderStatus[];
};
