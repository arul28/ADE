function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** One setting as the relay reports it. */
export type AccountSettingRecord = {
  scope: string;
  key: string;
  value: unknown;
  updatedAt: string;
  changedAt: string | null;
  writerDeviceId: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function readTimestamp(value: unknown): string | null {
  const timestamp = readNonEmptyString(value);
  return timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : null;
}

/** Validate one settings row at the relay boundary before it enters a cache. */
export function decodeAccountSettingRecord(value: unknown): AccountSettingRecord | null {
  if (!isRecord(value)) return null;
  const scope = readNonEmptyString(value.scope);
  const key = readNonEmptyString(value.key);
  const updatedAt = readTimestamp(value.updatedAt);
  const changedAt = readNullableString(value.changedAt);
  const writerDeviceId = readNullableString(value.writerDeviceId);
  if (!scope || !key || !updatedAt || changedAt === undefined || writerDeviceId === undefined) return null;
  return { scope, key, value: value.value, updatedAt, changedAt, writerDeviceId };
}

/** One setting as a client sends it. `changedAt` is diagnostics, not ordering. */
export type AccountSettingWrite = {
  scope: string;
  key: string;
  value: unknown;
  changedAt?: string;
};

export type AccountSettingsPage = {
  settings: AccountSettingRecord[];
  /**
   * Pass back as `since` next time. Null only when the account has never
   * written a setting, which is a legitimate starting state.
   */
  cursor: string | null;
  /**
   * The relay says so explicitly rather than leaving a client to infer it from
   * a full page — guessing either loops forever on an exactly-full page or
   * stops one page early on the next.
   */
  truncated: boolean;
};


/** What ADE stores in the vault. Closed, because each kind needs an owner. */
export type AccountVaultItemKind =
  | "secret"
  | "provider_key"
  | "integration"
  | "provider_api_key"
  | "linear_refresh_token"
  | "project_secret";

export type AccountVaultItem = {
  scope: string;
  kind: AccountVaultItemKind;
  key: string;
  /**
   * The credential, or null when the relay could not open its stored bytes.
   *
   * Null is never "absent". A client that treats it as absent will helpfully
   * overwrite a credential that is still good on every other machine.
   */
  value: string | null;
  updatedAt: string;
  writerDeviceId: string | null;
  refreshOwner: string | null;
};

const ACCOUNT_VAULT_ITEM_KINDS: ReadonlySet<string> = new Set([
  "secret",
  "provider_key",
  "integration",
  "provider_api_key",
  "linear_refresh_token",
  "project_secret",
]);

/** Validate one vault row before callers can mistake corrupt data for a secret. */
export function decodeAccountVaultItem(value: unknown): AccountVaultItem | null {
  if (!isRecord(value)) return null;
  const scope = readNonEmptyString(value.scope);
  const kind = readNonEmptyString(value.kind);
  const key = readNonEmptyString(value.key);
  const updatedAt = readTimestamp(value.updatedAt);
  const itemValue = value.value === null || typeof value.value === "string" ? value.value : undefined;
  const writerDeviceId = readNullableString(value.writerDeviceId);
  const refreshOwner = readNullableString(value.refreshOwner);
  if (
    !scope
    || !kind
    || !ACCOUNT_VAULT_ITEM_KINDS.has(kind)
    || !key
    || !updatedAt
    || itemValue === undefined
    || writerDeviceId === undefined
    || refreshOwner === undefined
  ) return null;
  return {
    scope,
    kind: kind as AccountVaultItemKind,
    key,
    value: itemValue,
    updatedAt,
    writerDeviceId,
    refreshOwner,
  };
}

export type AccountVaultWrite = {
  scope: string;
  kind: AccountVaultItemKind;
  key: string;
  value: string;
  /** The machine allowed to exchange a rotating credential; null if it never rotates. */
  refreshOwner?: string | null;
};

export type AccountVaultPage = {
  items: AccountVaultItem[];
  cursor: string | null;
  truncated: boolean;
};

