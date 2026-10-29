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
  /** Present on a tombstone so other machines drop the key. */
  deleted?: boolean;
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
  if (value.deleted !== undefined && typeof value.deleted !== "boolean") return null;
  return {
    scope,
    key,
    value: value.value,
    updatedAt,
    changedAt,
    writerDeviceId,
    ...(value.deleted === true ? { deleted: true } : {}),
  };
}

/** One setting as a client sends it. `changedAt` is diagnostics, not ordering. */
export type AccountSettingWrite = {
  scope: string;
  key: string;
  value: unknown;
  changedAt?: string;
  /** When this machine made the write, on its clock; see `AccountWriteResult`. */
  writtenAt?: string;
};

/**
 * One item's answer from a relay that answers per item (the client sends
 * `itemResults: true`). `rejected`: the relay will not store this item as it
 * is (a reason, never a value). `stale`: the stored row is newer than this
 * write, so it was not applied; `current` is that row, to adopt.
 *
 * An older relay answers the whole batch instead, so `results` is absent.
 */
export type AccountWriteResult<TRow> =
  | { status: "written" }
  | { status: "rejected"; reason: string }
  | { status: "stale"; current: TRow | null };

/** A delete the relay refused because the stored row is newer than it. */
export type AccountStaleDelete<TRow> = { stale: true; current: TRow | null };

/** Per-item answers in request order, or undefined when the relay sent none (or an unreadable list). */
export function decodeAccountWriteResults<TRow>(
  value: unknown,
  expected: number,
  decodeRow: (row: unknown) => TRow | null,
): AccountWriteResult<TRow>[] | undefined {
  if (!Array.isArray(value) || value.length !== expected) return undefined;
  const results: AccountWriteResult<TRow>[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (entry.status === "written") results.push({ status: "written" });
    else if (entry.status === "rejected") {
      const reason = typeof entry.reason === "string" && entry.reason.trim() ? entry.reason.slice(0, 120) : "refused";
      results.push({ status: "rejected", reason });
    } else if (entry.status === "stale") {
      results.push({ status: "stale", current: entry.current == null ? null : decodeRow(entry.current) });
    } else {
      return undefined;
    }
  }
  return results;
}

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
  | "project_secret"
  /** ADE MCP: the account secret and the connections (token hashes only). */
  | "ade_mcp";

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
  /** Present on a tombstone so other machines drop the item. */
  deleted?: boolean;
};

const ACCOUNT_VAULT_ITEM_KINDS: ReadonlySet<string> = new Set<AccountVaultItemKind>([
  "secret",
  "provider_key",
  "integration",
  "provider_api_key",
  "linear_refresh_token",
  "project_secret",
  "ade_mcp",
]);

export function isAccountVaultItemKind(value: unknown): value is AccountVaultItemKind {
  return typeof value === "string" && ACCOUNT_VAULT_ITEM_KINDS.has(value);
}

/**
 * Kinds that some deployed push relays do not know yet. The vault uploads
 * them in their own batch, because a Worker refuses a whole batch for one
 * unknown kind.
 */
export const NEWER_VAULT_KINDS: ReadonlySet<AccountVaultItemKind> = new Set<AccountVaultItemKind>(["ade_mcp"]);

/** Validate one vault row before callers can mistake corrupt data for a secret. */
export function decodeAccountVaultItem(value: unknown): AccountVaultItem | null {
  if (!isRecord(value)) return null;
  const scope = readNonEmptyString(value.scope);
  const kind = readNonEmptyString(value.kind);
  const key = readNonEmptyString(value.key);
  const updatedAt = readTimestamp(value.updatedAt);
  const itemValue = value.deleted === true
    ? (value.value === null || typeof value.value === "string" ? value.value : null)
    : (value.value === null || typeof value.value === "string" ? value.value : undefined);
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
  if (value.deleted !== undefined && typeof value.deleted !== "boolean") return null;
  return {
    scope,
    kind: kind as AccountVaultItemKind,
    key,
    value: itemValue,
    updatedAt,
    writerDeviceId,
    refreshOwner,
    ...(value.deleted === true ? { deleted: true } : {}),
  };
}

export type AccountVaultWrite = {
  scope: string;
  kind: AccountVaultItemKind;
  key: string;
  value: string;
  /** The machine allowed to exchange a rotating credential; null if it never rotates. */
  refreshOwner?: string | null;
  /** When this machine made the write, on its clock; see `AccountWriteResult`. */
  writtenAt?: string;
};

export type AccountVaultPage = {
  items: AccountVaultItem[];
  cursor: string | null;
  truncated: boolean;
};

