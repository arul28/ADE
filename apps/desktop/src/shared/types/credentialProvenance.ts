/** Identifies whether a credential belongs to this device or an account. */
export type CredentialProvenance = {
  source: "device" | "account";
  accountUserId: string | null;
};

/** The provenance used for values written directly on this machine. */
export function deviceCredentialProvenance(): CredentialProvenance {
  return { source: "device", accountUserId: null };
}

/** Decode persisted provenance without accepting an account with no identity. */
export function normalizeCredentialProvenance(value: unknown): CredentialProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.source === "device") return deviceCredentialProvenance();
  if (record.source !== "account" || typeof record.accountUserId !== "string") return null;
  const accountUserId = record.accountUserId.trim();
  return accountUserId ? { source: "account", accountUserId } : null;
}
