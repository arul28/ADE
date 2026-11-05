import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { DEFAULT_GITHUB_RELAY_API_BASE_URL } from "../github/githubRelayConfig";
import type { AdeDb } from "../state/kvDb";

export const CURSOR_CLOUD_RELAY_API_BASE_REF = "automations.cursorCloudRelay.apiBaseUrl";
export const CURSOR_CLOUD_RELAY_SECRET_REF = "automations.cursorCloudRelay.secretRef";
export const CURSOR_CLOUD_RELAY_LAST_EVENT_AT_REF = "automations.cursorCloudRelay.lastEventAt";
export const CURSOR_CLOUD_RELAY_LAST_ERROR_REF = "automations.cursorCloudRelay.lastError";
export const CURSOR_CLOUD_RELAY_CONFIGURED_REF = "automations.cursorCloudRelay.configured";
export const CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY = "cursor.cloudWebhookSecret.v1";
/**
 * The relay's id for this machine's registered secret (`POST /cursor/register`
 * answers it). Kept next to the secret, in this machine's credential store,
 * because it names that secret and no other; a project database row could
 * reach another machine that holds a different secret.
 */
export const CURSOR_CLOUD_WEBHOOK_SECRET_ID_CREDENTIAL_KEY = "cursor.cloudWebhookSecretId.v1";
const MAX_CURSOR_CLOUD_WEBHOOK_SECRET_ID_LENGTH = 256;
export const CURSOR_CLOUD_RELAY_API_BASE_ENV_KEY = "ADE_CURSOR_RELAY_API_BASE_URL";
export const DEFAULT_CURSOR_CLOUD_RELAY_API_BASE_URL = DEFAULT_GITHUB_RELAY_API_BASE_URL;
export const CURSOR_CLOUD_WEBHOOK_ID = "cursor-cloud";

export type CursorCloudRelayKvStore = Pick<AdeDb, "getJson" | "setJson">;
export type CursorCloudRelayCredentialStore = Pick<SyncCredentialStore, "getSync" | "setSync" | "deleteSync">;

export type CursorCloudRelayPersistedState = {
  configured: boolean;
  secretRef: string | null;
  lastEventAt: string | null;
  lastError: string | null;
};

function readString(db: CursorCloudRelayKvStore, key: string): string | null {
  const value = db.getJson<unknown>(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveCursorCloudRelayBaseUrl(db: CursorCloudRelayKvStore): string {
  return (
    readString(db, CURSOR_CLOUD_RELAY_API_BASE_REF)
    || process.env[CURSOR_CLOUD_RELAY_API_BASE_ENV_KEY]?.trim()
    || DEFAULT_CURSOR_CLOUD_RELAY_API_BASE_URL
  ).replace(/\/+$/, "");
}

/**
 * The address Cursor posts webhooks to. With the registration's secret id the
 * relay checks one secret instead of scanning them; without one (a relay too
 * old to answer it, or a registration made before ids were kept) it is the
 * plain address, which the relay still accepts.
 */
export function cursorCloudWebhookUrl(relayBaseUrl: string, secretId?: string | null): string {
  const url = `${relayBaseUrl.replace(/\/+$/, "")}/cursor/webhook`;
  const id = secretId?.trim();
  return id ? `${url}?sid=${encodeURIComponent(id)}` : url;
}

/** The secret id a `POST /cursor/register` answer carries, or null. */
export function readCursorCloudRegisteredSecretId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).secretId;
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= MAX_CURSOR_CLOUD_WEBHOOK_SECRET_ID_LENGTH ? id : null;
}

export function readCursorCloudRelayPersistedState(db: CursorCloudRelayKvStore): CursorCloudRelayPersistedState {
  return {
    configured: db.getJson<unknown>(CURSOR_CLOUD_RELAY_CONFIGURED_REF) === true,
    secretRef: readString(db, CURSOR_CLOUD_RELAY_SECRET_REF),
    lastEventAt: readString(db, CURSOR_CLOUD_RELAY_LAST_EVENT_AT_REF),
    lastError: readString(db, CURSOR_CLOUD_RELAY_LAST_ERROR_REF),
  };
}

export function persistCursorCloudRelayRegistration(db: CursorCloudRelayKvStore): void {
  db.setJson(CURSOR_CLOUD_RELAY_CONFIGURED_REF, true);
  db.setJson(CURSOR_CLOUD_RELAY_SECRET_REF, CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY);
  db.setJson(CURSOR_CLOUD_RELAY_LAST_ERROR_REF, null);
}

export function clearCursorCloudRelayRegistration(db: CursorCloudRelayKvStore): void {
  db.setJson(CURSOR_CLOUD_RELAY_CONFIGURED_REF, null);
  db.setJson(CURSOR_CLOUD_RELAY_SECRET_REF, null);
  db.setJson(CURSOR_CLOUD_RELAY_LAST_EVENT_AT_REF, null);
  db.setJson(CURSOR_CLOUD_RELAY_LAST_ERROR_REF, null);
}

export function readCursorCloudWebhookSecret(
  db: CursorCloudRelayKvStore,
  credentialStore: CursorCloudRelayCredentialStore,
): string | null {
  const canonical = credentialStore.getSync(CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY)?.trim() || null;
  if (canonical) return canonical;
  const secretRef = readString(db, CURSOR_CLOUD_RELAY_SECRET_REF);
  if (!secretRef || secretRef === CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY) return null;
  return credentialStore.getSync(secretRef)?.trim() || null;
}

export function persistCursorCloudWebhookSecret(
  credentialStore: CursorCloudRelayCredentialStore,
  secret: string,
): void {
  credentialStore.setSync(CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY, secret);
}

export function readCursorCloudWebhookSecretId(credentialStore: CursorCloudRelayCredentialStore): string | null {
  const id = credentialStore.getSync(CURSOR_CLOUD_WEBHOOK_SECRET_ID_CREDENTIAL_KEY)?.trim() || null;
  return id && id.length <= MAX_CURSOR_CLOUD_WEBHOOK_SECRET_ID_LENGTH ? id : null;
}

/**
 * Record the id the relay gave the secret just registered. Null (a relay that
 * does not answer one) forgets any older id, which may name another secret.
 */
export function persistCursorCloudWebhookSecretId(
  credentialStore: CursorCloudRelayCredentialStore,
  secretId: string | null,
): void {
  if (secretId) credentialStore.setSync(CURSOR_CLOUD_WEBHOOK_SECRET_ID_CREDENTIAL_KEY, secretId);
  else credentialStore.deleteSync(CURSOR_CLOUD_WEBHOOK_SECRET_ID_CREDENTIAL_KEY);
}

export function clearCursorCloudWebhookSecret(credentialStore: CursorCloudRelayCredentialStore): void {
  credentialStore.deleteSync(CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY);
  credentialStore.deleteSync(CURSOR_CLOUD_WEBHOOK_SECRET_ID_CREDENTIAL_KEY);
}

export function readCursorCloudWebhookBinding(args: {
  db: CursorCloudRelayKvStore;
  credentialStore: CursorCloudRelayCredentialStore;
}): { url: string; secret: string } | null {
  const secret = readCursorCloudWebhookSecret(args.db, args.credentialStore);
  if (!secret || secret.length < 32) return null;
  return {
    url: cursorCloudWebhookUrl(
      resolveCursorCloudRelayBaseUrl(args.db),
      readCursorCloudWebhookSecretId(args.credentialStore),
    ),
    secret,
  };
}
