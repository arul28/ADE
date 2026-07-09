import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { DEFAULT_GITHUB_RELAY_API_BASE_URL } from "../github/githubRelayConfig";
import type { AdeDb } from "../state/kvDb";

export const LINEAR_RELAY_API_BASE_REF = "automations.linearRelay.apiBaseUrl";
export const LINEAR_RELAY_WEBHOOK_ID_REF = "automations.linearRelay.webhookId";
export const LINEAR_RELAY_ORGANIZATION_ID_REF = "automations.linearRelay.organizationId";
export const LINEAR_RELAY_SECRET_REF = "automations.linearRelay.secretRef";
export const LINEAR_RELAY_LAST_EVENT_AT_REF = "automations.linearRelay.lastEventAt";
export const LINEAR_RELAY_LAST_ERROR_REF = "automations.linearRelay.lastError";
export const LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY = "linear.webhookSecret.v1";
export const LINEAR_RELAY_API_BASE_ENV_KEY = "ADE_LINEAR_RELAY_API_BASE_URL";
export const DEFAULT_LINEAR_RELAY_API_BASE_URL = DEFAULT_GITHUB_RELAY_API_BASE_URL;

export type LinearRelayKvStore = Pick<AdeDb, "getJson" | "setJson">;
export type LinearRelayCredentialStore = Pick<SyncCredentialStore, "getSync" | "setSync" | "deleteSync">;

export type LinearRelayPersistedState = {
  webhookId: string | null;
  organizationId: string | null;
  secretRef: string | null;
  lastEventAt: string | null;
  lastError: string | null;
};

function readString(db: LinearRelayKvStore, key: string): string | null {
  const value = db.getJson<unknown>(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveLinearRelayBaseUrl(db: LinearRelayKvStore): string {
  return (
    readString(db, LINEAR_RELAY_API_BASE_REF)
    || process.env[LINEAR_RELAY_API_BASE_ENV_KEY]?.trim()
    || DEFAULT_LINEAR_RELAY_API_BASE_URL
  ).replace(/\/+$/, "");
}

export function readLinearRelayPersistedState(db: LinearRelayKvStore): LinearRelayPersistedState {
  return {
    webhookId: readString(db, LINEAR_RELAY_WEBHOOK_ID_REF),
    organizationId: readString(db, LINEAR_RELAY_ORGANIZATION_ID_REF),
    secretRef: readString(db, LINEAR_RELAY_SECRET_REF),
    lastEventAt: readString(db, LINEAR_RELAY_LAST_EVENT_AT_REF),
    lastError: readString(db, LINEAR_RELAY_LAST_ERROR_REF),
  };
}

export function persistLinearRelayRegistration(
  db: LinearRelayKvStore,
  registration: { webhookId: string; organizationId: string },
): void {
  db.setJson(LINEAR_RELAY_WEBHOOK_ID_REF, registration.webhookId);
  db.setJson(LINEAR_RELAY_ORGANIZATION_ID_REF, registration.organizationId);
  db.setJson(LINEAR_RELAY_SECRET_REF, LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY);
  db.setJson(LINEAR_RELAY_LAST_ERROR_REF, null);
}

export function clearLinearRelayRegistration(db: LinearRelayKvStore): void {
  db.setJson(LINEAR_RELAY_WEBHOOK_ID_REF, null);
  db.setJson(LINEAR_RELAY_ORGANIZATION_ID_REF, null);
  db.setJson(LINEAR_RELAY_SECRET_REF, null);
  db.setJson(LINEAR_RELAY_LAST_EVENT_AT_REF, null);
  db.setJson(LINEAR_RELAY_LAST_ERROR_REF, null);
}

export function readLinearWebhookSecret(
  db: LinearRelayKvStore,
  credentialStore: LinearRelayCredentialStore,
): string | null {
  const secretRef = readString(db, LINEAR_RELAY_SECRET_REF);
  if (secretRef !== LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY) return null;
  return credentialStore.getSync(secretRef)?.trim() || null;
}

export function persistLinearWebhookSecret(credentialStore: LinearRelayCredentialStore, secret: string): void {
  credentialStore.setSync(LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY, secret);
}

export function clearLinearWebhookSecret(credentialStore: LinearRelayCredentialStore): void {
  credentialStore.deleteSync(LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY);
}
