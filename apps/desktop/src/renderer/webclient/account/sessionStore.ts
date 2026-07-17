import {
  IndexedDbStorage,
  type WebClientStorage,
} from "../sync/envStore";

const ACCOUNT_SESSION_KEY = "oauthSession";
const ACCOUNT_SESSION_VERSION = 1;

export type PersistedBrowserAccountSession = {
  version: typeof ACCOUNT_SESSION_VERSION;
  refreshToken: string;
  issuer: string;
  clientId: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
};

export type BrowserAccountSessionPersistence = {
  load(): Promise<PersistedBrowserAccountSession | null>;
  save(session: PersistedBrowserAccountSession): Promise<void>;
  clear(): Promise<void>;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | null {
  return value == null ? null : nonEmptyString(value);
}

function parsePersistedSession(value: unknown): PersistedBrowserAccountSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const refreshToken = nonEmptyString(record.refreshToken);
  const issuer = nonEmptyString(record.issuer);
  const clientId = nonEmptyString(record.clientId);
  if (
    record.version !== ACCOUNT_SESSION_VERSION
    || !refreshToken
    || !issuer
    || !clientId
  ) {
    return null;
  }
  return {
    version: ACCOUNT_SESSION_VERSION,
    refreshToken,
    issuer,
    clientId,
    userId: optionalString(record.userId),
    email: optionalString(record.email),
    name: optionalString(record.name),
    imageUrl: optionalString(record.imageUrl),
  };
}

export class BrowserAccountSessionStore implements BrowserAccountSessionPersistence {
  constructor(private readonly storage: WebClientStorage = new IndexedDbStorage()) {}

  async load(): Promise<PersistedBrowserAccountSession | null> {
    const stored = await this.storage.get<unknown>("account", ACCOUNT_SESSION_KEY);
    return parsePersistedSession(stored);
  }

  async save(session: PersistedBrowserAccountSession): Promise<void> {
    await this.storage.put("account", ACCOUNT_SESSION_KEY, session);
  }

  async clear(): Promise<void> {
    await this.storage.delete("account", ACCOUNT_SESSION_KEY);
  }
}
