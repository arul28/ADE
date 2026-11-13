/**
 * Passwords: the types every surface shares.
 *
 * Two shapes, kept apart on purpose:
 * - `PasswordItemSecret` is what is sealed inside an item's ciphertext. It
 *   holds the values. It exists only in the brain's memory while it seals or
 *   opens an item, and in desktop main for the moment it fills a page. It is
 *   never returned by an action, never logged, never sent to a renderer
 *   except through the person-only reveal.
 * - `PasswordItemSummary` is what anyone may see, agents included: which
 *   sites, which username, which kinds of value an item holds, never a value.
 */

export type PasswordItemKind = "login" | "secret";

export type PasswordLoginSecret = {
  kind: "login";
  title: string;
  /** Sites this login is for, as normalized https origins (localhost may be http). */
  origins: string[];
  username: string;
  password: string;
  notes: string;
  /** An `otpauth://totp/...` URI when the login has authenticator codes. */
  totpUri: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PasswordSecretSecret = {
  kind: "secret";
  /** The environment variable name agents use it by, e.g. OPENAI_API_KEY. */
  name: string;
  value: string;
  /** The project it belongs to (its account repo scope key), or null for every project. */
  projectScope: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type PasswordItemSecret = PasswordLoginSecret | PasswordSecretSecret;

/** What an agent, a list or a log line may see about an item. Never a value. */
export type PasswordItemSummary = {
  id: string;
  kind: PasswordItemKind;
  /** Logins: the title; secrets: the name. */
  title: string;
  /** Logins: the registrable domains it is for (e.g. "github.com"). */
  sites: string[];
  /** Logins only. */
  username: string | null;
  hasPassword: boolean;
  hasTotp: boolean;
  /** Secrets only. */
  projectScope: string | null;
  updatedAt: string;
};

/** One use of a saved item, for Settings › Passwords › Activity. */
export type PasswordUseRecord = {
  itemId: string;
  kind: PasswordItemKind;
  /** The site it was filled on, or the command a secret was given to. */
  target: string;
  by: "person" | "agent";
  chatSessionId: string | null;
  machineName: string | null;
  at: string;
};

export type PasswordImportResult = {
  imported: number;
  skippedDuplicate: number;
  skippedInvalid: number;
};

/** Account-level settings, synced as plain account settings (no secrets). */
export type PasswordsSettings = {
  enabled: boolean;
  /** ADE Cloud computers on this account may unlock Passwords. On by default once enabled. */
  cloudEnabled: boolean;
};
