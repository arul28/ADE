import type { ProviderCompactionSettings } from "../compactionSettings";
/**
 * Provider accounts ("instances").
 *
 * One machine, several logins. Claude and Codex both keep their whole signed-in
 * identity inside a single config directory — `~/.claude` and `~/.codex` — and
 * both honour an env var that names that directory (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`). An ADE "provider instance" is nothing more than one of those
 * directories plus a label, so switching accounts is switching a path, never
 * rewriting `HOME` and never mutating `process.env` (both of which would move
 * every other provider's config at the same time).
 *
 * Only `claude` and `codex` participate. Cursor, Droid, OpenCode, Pi and the ACP
 * providers either have no config-home override or no local account file, so
 * they have exactly one identity per machine and are deliberately absent rather
 * than faked with a single synthetic entry.
 *
 * The identity that already exists on the machine becomes the **default**
 * instance automatically: its `id` is the provider slug (`"claude"`/`"codex"`)
 * and its `configHome` is whatever `providerConfigHomes.ts` resolves today. That
 * synthesis happens on read, so there is no migration step and an ADE that has
 * never seen this feature and one that has both describe the same machine.
 */

/** Providers that can hold more than one local account. */
export type ProviderInstanceProvider = "claude" | "codex";

export const PROVIDER_INSTANCE_PROVIDERS: readonly ProviderInstanceProvider[] = ["claude", "codex"];

export function isProviderInstanceProvider(value: unknown): value is ProviderInstanceProvider {
  return value === "claude" || value === "codex";
}

/** The env var each provider reads to find its config directory. */
export const PROVIDER_INSTANCE_ENV_KEY: Record<ProviderInstanceProvider, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/** One local account for one provider. */
export type ProviderInstance = {
  compaction?: ProviderCompactionSettings;
  /** Stable machine-local id. The default instance's id IS the provider slug. */
  id: string;
  provider: ProviderInstanceProvider;
  /** User-facing name. "Default" for the synthesized pre-existing identity. */
  label: string;
  /** `#rrggbb`, chosen by the user to tell accounts apart at a glance. */
  accentColor?: string;
  /** Absolute path to this account's provider config directory. */
  configHome: string;
  /** Exactly one instance per provider is the default; it can never be removed. */
  isDefault: boolean;
  createdAt: string;
  /** Read out of the config home by `refreshAccounts()`; absent until then. */
  account?: { email?: string; plan?: string };
  /**
   * True when the config home names an account (email or plan resolved) and
   * the usage poller has not found its saved login broken.
   */
  signedIn: boolean;
  /**
   * The config home names an account, but its saved login no longer works
   * (the provider CLI cleared it). `signedIn` is false; the account needs a
   * new sign-in. Absent when the login works or was never read.
   */
  loginBroken?: boolean;
  /**
   * Another account of this provider is signed in to the same email: this one
   * is a copy of that login and quota. Names the account that owns it (the
   * default first, then creation order). Smart balance skips copies.
   */
  sameLoginAs?: string;
  /**
   * The login this config home held before a different one replaced it — a
   * sign-in outside ADE, such as `claude /login` in a shell for the default
   * account. Absent once any account holds that email again, or once dismissed.
   */
  replacedAccount?: ProviderInstanceReplacedAccount;
};

export type ProviderInstanceReplacedAccount = {
  email: string;
  plan?: string;
  replacedAt: string;
};

/**
 * The config home names an account, whether or not its login works now.
 * Use it where the question is "which accounts did the user add", not "which
 * account can run a chat right now" (that one is `signedIn`).
 */
export function providerInstanceHasAccount(instance: Pick<ProviderInstance, "signedIn" | "loginBroken">): boolean {
  return instance.signedIn || instance.loginBroken === true;
}

/** Per-provider settings that are about the set of accounts, not one account. */
export type ProviderInstanceSettings = {
  compaction?: ProviderCompactionSettings;
  /**
   * Spread new chats across signed-in accounts instead of always using the
   * default. Stored here; the scheduler that reads it lands with the UI.
   */
  smartBalance: boolean;
  /**
   * Auto-start 5-hour quota windows. When an account's five-hour window
   * closes, ADE sends one tiny request on the provider's cheapest model
   * through that account's own config home so the next window opens at
   * once. Off by default; once on it runs at all hours for every account of
   * this provider that reports a five-hour window. Unrelated to the Windows
   * operating system.
   */
  autoStartWindows: boolean;
};

export const DEFAULT_PROVIDER_INSTANCE_SETTINGS: ProviderInstanceSettings = {
  smartBalance: false,
  autoStartWindows: false,
};

/** The whole machine-local registry, as one read. */
export type ProviderInstanceRegistry = {
  instances: ProviderInstance[];
  settings: Record<ProviderInstanceProvider, ProviderInstanceSettings>;
};

/**
 * How to sign one instance in.
 *
 * ADE never drives the provider's OAuth flow itself — it hands back the exact
 * command, argv and env a terminal (or the user's own shell) must run so the
 * provider CLI writes its credentials into THIS instance's config home. `env`
 * is a patch to apply on top of the caller's environment, never a replacement.
 */
export type ProviderInstanceLoginCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type ProviderInstanceListArgs = {
  provider?: ProviderInstanceProvider;
};

export type ProviderInstanceCreateArgs = {
  provider: ProviderInstanceProvider;
  label: string;
  accentColor?: string;
};

export type ProviderInstanceCreateResult = {
  instance: ProviderInstance;
  loginCommand: ProviderInstanceLoginCommand;
};

export type ProviderInstanceRemoveArgs = {
  id: string;
};

export type ProviderInstanceRemoveResult = {
  removed: boolean;
  /** The config home left on disk; removing an account never deletes credentials. */
  configHome: string;
};

export type ProviderInstanceRenameArgs = {
  id: string;
  label: string;
};

export type ProviderInstanceSetDefaultArgs = {
  id: string;
};

export type ProviderInstanceDismissReplacedArgs = {
  id: string;
};

export type ProviderInstanceSetAccentArgs = {
  id: string;
  /** `#rrggbb`, or `null` to clear the accent. */
  accentColor: string | null;
};

export type ProviderInstanceGetSettingsArgs = {
  provider: ProviderInstanceProvider;
};

export type ProviderInstanceSetSettingsArgs = {
  /** Account override; null compaction restores provider inheritance. */
  instanceId?: string;
  provider: ProviderInstanceProvider;
  settings: Omit<Partial<ProviderInstanceSettings>, "compaction"> & { compaction?: ProviderCompactionSettings | null };
};

export type ProviderInstanceLoginCommandArgs = {
  id: string;
};

/**
 * One sign-in ADE runs for an account: the provider's own login command in a
 * private PTY on the account's machine, read for the link it prints and the
 * code it may ask for. No terminal session or Work row is created.
 */
export type ProviderLoginState = "running" | "verifying" | "succeeded" | "failed" | "cancelled";

export type ProviderLoginStatus = {
  loginId: string;
  instanceId: string;
  provider: ProviderInstanceProvider;
  state: ProviderLoginState;
  /** The sign-in link the CLI printed, once it has. */
  url: string | null;
  /** The CLI is asking for a code pasted from the browser. */
  awaitingCode: boolean;
  /** A device sign-in's one-time code, typed into the sign-in page. */
  deviceCode?: string;
  /** The CLI's output so far, without terminal escapes; the last few KB. */
  output: string;
  /** The account's email once the login is verified. */
  email?: string;
  /** Why a failed sign-in failed, in one sentence. */
  message?: string;
  startedAt: string;
  endedAt?: string;
};

/** A sign-in that has not ended: its CLI still runs, or its result is being checked. */
export function isProviderLoginLive(login: Pick<ProviderLoginStatus, "state"> | null | undefined): boolean {
  return login?.state === "running" || login?.state === "verifying";
}

export type ProviderLoginStartArgs = {
  id: string;
  /**
   * Sign in with a one-time code typed into the sign-in page (Codex
   * `--device-auth`), for a machine other than the one with the browser:
   * Codex's normal sign-in returns to a localhost port on the account's
   * machine, which a browser on another computer cannot reach.
   */
  deviceAuth?: boolean;
};
export type ProviderLoginRefArgs = { loginId: string };
export type ProviderLoginSubmitCodeArgs = { loginId: string; code: string };

export type ProviderInstanceRefreshArgs = {
  provider?: ProviderInstanceProvider;
  /**
   * Re-read this account's saved login now, even when it is not marked
   * signed out — the account a sign-in just finished for.
   */
  instanceId?: string;
};

/** `#rrggbb` only — the renderer renders it raw, so anything else is rejected. */
export const PROVIDER_INSTANCE_ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function normalizeProviderInstanceAccent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return PROVIDER_INSTANCE_ACCENT_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** The default instance's id IS the provider slug, on every machine. */
export function defaultProviderInstanceId(provider: ProviderInstanceProvider): string {
  return provider;
}

export function isDefaultProviderInstanceId(id: string): boolean {
  return isProviderInstanceProvider(id);
}

/**
 * True for the machine's own pre-existing login — the account whose id is the
 * provider slug and whose config home is whatever the environment already
 * names.
 *
 * That account launches with NO config-home variable. Claude Code keys its
 * macOS keychain entry by `CLAUDE_CONFIG_DIR` whenever the variable is set, so
 * exporting even the default path (`~/.claude`) makes the CLI look for a
 * credential under a different key and report itself logged out. Inheriting
 * the environment is exactly what ADE did before accounts existed, so the base
 * identity keeps that behaviour on every seam: chat spawn, tracked CLI, preset
 * launch, and the login command.
 */
export function isBaseProviderInstance(
  instance: { id: string; provider: ProviderInstanceProvider } | null | undefined,
): boolean {
  return Boolean(instance) && instance!.id === defaultProviderInstanceId(instance!.provider);
}
