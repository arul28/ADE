import {
  deviceCredentialProvenance,
  normalizeCredentialProvenance,
  type CredentialProvenance,
} from "./types/credentialProvenance";

export type CredentialProvenanceStoreOptions = {
  read(): string | null;
  write(value: string): void;
};

function readMap(read: () => string | null): Record<string, CredentialProvenance> {
  let raw: string | null;
  try {
    raw = read();
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, CredentialProvenance> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeCredentialProvenance(value);
      if (normalized) result[key] = normalized;
    }
    return result;
  } catch {
    return {};
  }
}

/** Shared read/write semantics for per-credential provenance maps. */
export function createCredentialProvenanceStore(options: CredentialProvenanceStoreOptions) {
  return {
    set(key: string, value: CredentialProvenance): void {
      const map = readMap(options.read);
      map[key] = value;
      options.write(JSON.stringify(map));
    },

    remove(key: string): void {
      const map = readMap(options.read);
      if (!(key in map)) return;
      delete map[key];
      options.write(JSON.stringify(map));
    },

    get(key: string): CredentialProvenance {
      return readMap(options.read)[key] ?? deviceCredentialProvenance();
    },
  };
}
