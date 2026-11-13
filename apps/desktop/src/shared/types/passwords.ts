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

export type PasswordItemKind = "login" | "secret" | "passkey";

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

/** A passkey ADE's browser made for a site (a software authenticator, ES256). */
export type PasswordPasskeySecret = {
  kind: "passkey";
  rpId: string;
  /** Base64url. */
  credentialId: string;
  /** Base64url. */
  userHandle: string;
  userName: string;
  userDisplayName: string;
  /** Base64 PKCS#8 DER of the P-256 private key. */
  privateKeyPkcs8: string;
  signCount: number;
  createdAt: string;
  updatedAt: string;
};

export type PasswordItemSecret = PasswordLoginSecret | PasswordSecretSecret | PasswordPasskeySecret;

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

/** What Settings › Passwords sends to save (or change) a login. */
export type PasswordLoginSaveInput = {
  id?: string;
  title?: string;
  /** Required for a new login; a change by id keeps its sites when omitted. */
  origins?: string[];
  username?: string;
  password: string;
  notes?: string;
  totpUri?: string | null;
};

/** What Settings › Passwords sends to save (or change) a secret. */
export type PasswordSecretSaveInput = {
  id?: string;
  name: string;
  value: string;
  projectScope: string | null;
  notes?: string;
};

/** Account-level settings, synced as plain account settings (no secrets). */
export type PasswordsSettings = {
  enabled: boolean;
  /** ADE Cloud computers on this account may unlock Passwords. On by default once enabled. */
  cloudEnabled: boolean;
};

/** Whether Passwords is on for one computer, for Settings and `ade passwords status`. */
export type PasswordsStatus = {
  signedIn: boolean;
  /** On for this computer (on an ADE Cloud computer: the ADE Cloud switch). */
  enabled: boolean;
  machineKind: "desktop" | "phone" | "cloud" | "web" | "cli";
  /** The account-wide ADE Cloud switch; null until Passwords was first turned on. */
  cloudEnabled: boolean | null;
  /** Saved items this computer can open, or null when it can't open them now. */
  itemCount: number | null;
};
