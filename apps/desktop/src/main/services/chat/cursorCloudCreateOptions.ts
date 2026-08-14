import { createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import {
  EncryptedFileCredentialStore,
  type SyncCredentialStore,
} from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { normalizeProjectRootPath } from "../../../../../ade-cli/src/services/projects/projectRoots";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { createProjectSecretService } from "../secrets/projectSecretService";
import type { AdeDb } from "../state/kvDb";

/**
 * ADE-owned tag names. The SDK types `cloud.metadata`, but REST
 * `POST /v1/agents` does not list it, and sending it fails create with
 * `[feature_unavailable] API v1 agent metadata is not enabled`.
 * Do not spread these onto `Agent.create`.
 */
export const CURSOR_CLOUD_METADATA_SESSION_ID = "ade_session_id";
export const CURSOR_CLOUD_METADATA_LANE_ID = "ade_lane_id";
export const CURSOR_CLOUD_METADATA_PROJECT_ID = "ade_project_id";
export const CURSOR_CLOUD_METADATA_LINEAR_ISSUE_ID = "ade_linear_issue_id";

/** Encrypted credential-store key for the Cursor Cloud webhook HMAC secret. */
export const CURSOR_CLOUD_WEBHOOK_SECRET_KEY = "cursor.cloudWebhookSecret.v1";
export const CURSOR_CLOUD_WEBHOOK_SECRET_MIN_LENGTH = 32;
export const CURSOR_CLOUD_WEBHOOK_PATH = "/cursor/webhook";
export const CURSOR_CLOUD_WEBHOOK_SIGNATURE_HEADER = "X-Webhook-Signature";

const LANE_SECRET_NAMES_KEY_PREFIX = "cursor.cloud.laneSecretNames.v1:";
const CURSOR_RESERVED_ENV_PREFIX = "CURSOR_";

export type CursorCloudWebhookRegistration = {
  url: string;
  secret: string;
};

/**
 * Fields ADE is allowed to spread onto `Agent.create({ cloud })`.
 *
 * REST `POST /v1/agents` accepts `envVars` (silently ignored when the account
 * has not been enabled). It does **not** accept `metadata` (live create fails
 * with `feature_unavailable`) or `webhook` (v1: "Webhooks are coming soon";
 * not on CloudAgentOptions). Keep ADE's receive/HMAC path; never type-assert
 * those onto create.
 */
export type CursorCloudCreateCloudExtras = {
  envVars?: Record<string, string>;
};

export type CursorCloudCreateMetadataInput = {
  sessionId?: string | null;
  laneId?: string | null;
  projectId?: string | null;
  linearIssueId?: string | null;
};

export type CursorCloudCreateExtrasInput = {
  envVars?: Record<string, string> | null;
};

export type CursorCloudResolvedCreateOptions = {
  sessionId: string;
  laneId: string;
  projectId: string | null;
  linearIssueId: string | null;
  envVars: Record<string, string>;
  extras: CursorCloudCreateCloudExtras;
};

export type CursorCloudLaunchResolveInput = {
  projectRoot: string;
  db?: {
    get?: AdeDb["get"];
    all?: AdeDb["all"];
  } | null;
  projectConfigService?: {
    get: () => { effective?: { ui?: { webhookGatewayPublicUrl?: string } } };
  } | null;
  sessionId?: string | null;
  laneId?: string | null;
  projectId?: string | null;
  linearIssueId?: string | null;
  secretNames?: string[] | null;
  rememberSecretNames?: boolean;
  credentialStore?: SyncCredentialStore;
  getSecretValue?: (name: string) => string | null;
};

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : null;
}

export function isInjectableCloudSecretName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !trimmed.toUpperCase().startsWith(CURSOR_RESERVED_ENV_PREFIX);
}

export function buildCursorCloudMetadata(
  input: CursorCloudCreateMetadataInput,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  const sessionId = trimOrNull(input.sessionId);
  const laneId = trimOrNull(input.laneId);
  const projectId = trimOrNull(input.projectId);
  const linearIssueId = trimOrNull(input.linearIssueId);
  if (sessionId) metadata[CURSOR_CLOUD_METADATA_SESSION_ID] = sessionId;
  if (laneId) metadata[CURSOR_CLOUD_METADATA_LANE_ID] = laneId;
  if (projectId) metadata[CURSOR_CLOUD_METADATA_PROJECT_ID] = projectId;
  if (linearIssueId) metadata[CURSOR_CLOUD_METADATA_LINEAR_ISSUE_ID] = linearIssueId;
  return metadata;
}

export function buildCursorCloudEnvVars(
  secrets: Array<{ name: string; value: string }>,
): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const secret of secrets) {
    const name = secret.name.trim();
    if (!isInjectableCloudSecretName(name)) continue;
    if (typeof secret.value !== "string" || secret.value.length === 0) continue;
    envVars[name] = secret.value;
  }
  return envVars;
}

export function buildCursorCloudWebhookUrl(relayBase: string): string | null {
  const base = relayBase.trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}${CURSOR_CLOUD_WEBHOOK_PATH}`;
}

export function signCursorCloudWebhookBody(secret: string, body: string | Buffer): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

/**
 * Pure assembler used by `Agent.create` callers and by the Cursor SDK worker.
 * Only `envVars` may go on the create body.
 */
export function buildCursorCloudCreateCloudExtras(
  input: CursorCloudCreateExtrasInput,
): CursorCloudCreateCloudExtras {
  const extras: CursorCloudCreateCloudExtras = {};
  const envVars = input.envVars
    ? buildCursorCloudEnvVars(
        Object.entries(input.envVars).map(([name, value]) => ({ name, value })),
      )
    : {};
  if (Object.keys(envVars).length > 0) extras.envVars = envVars;
  return extras;
}

export function laneSecretNamesCredentialKey(laneId: string): string {
  return `${LANE_SECRET_NAMES_KEY_PREFIX}${laneId.trim()}`;
}

export function parseRememberedSecretNames(raw: string | null): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(isInjectableCloudSecretName);
  } catch {
    return [];
  }
}

function lookupCanonicalProjectId(
  db: NonNullable<CursorCloudLaunchResolveInput["db"]>,
  projectRoot: string,
): string | null {
  const normalized = normalizeProjectRootPath(projectRoot);
  try {
    const exact = db.get?.<{ id: string }>(
      "select id from projects where root_path = ? limit 1",
      [normalized],
    );
    const exactId = trimOrNull(typeof exact?.id === "string" ? exact.id : null);
    if (exactId) return exactId;
    const rows = db.all?.<{ id: string; root_path: string }>("select id, root_path from projects") ?? [];
    const match = rows.find((row) => normalizeProjectRootPath(String(row.root_path ?? "")) === normalized);
    return trimOrNull(typeof match?.id === "string" ? match.id : null);
  } catch {
    return null;
  }
}

export function openCursorCloudCredentialStore(projectRoot: string): SyncCredentialStore {
  const layout = resolveAdeLayout(projectRoot);
  const credentialsPath = path.join(layout.secretsDir, "cursor-cloud.v1.enc");
  return new EncryptedFileCredentialStore({
    credentialsPath,
    machineKeyPath: path.join(layout.secretsDir, ".cursor-cloud-key"),
    lockPath: `${credentialsPath}.lock`,
    credentialChangePollIntervalMs: null,
  });
}

export function ensureCursorCloudWebhookSecret(store: SyncCredentialStore): string {
  const existing = store.getSync(CURSOR_CLOUD_WEBHOOK_SECRET_KEY)?.trim() ?? "";
  if (existing.length >= CURSOR_CLOUD_WEBHOOK_SECRET_MIN_LENGTH) return existing;
  const secret = randomBytes(32).toString("hex");
  store.setSync(CURSOR_CLOUD_WEBHOOK_SECRET_KEY, secret);
  return secret;
}

export function readCursorCloudLaneSecretNames(
  store: SyncCredentialStore,
  laneId: string,
): string[] {
  const id = laneId.trim();
  if (!id) return [];
  return parseRememberedSecretNames(store.getSync(laneSecretNamesCredentialKey(id)));
}

export function writeCursorCloudLaneSecretNames(
  store: SyncCredentialStore,
  laneId: string,
  names: string[],
): void {
  const id = laneId.trim();
  if (!id) return;
  const injectable = names.map((name) => name.trim()).filter(isInjectableCloudSecretName);
  const key = laneSecretNamesCredentialKey(id);
  if (injectable.length === 0) {
    store.deleteSync(key);
    return;
  }
  store.setSync(key, JSON.stringify(injectable));
}

function defaultGetSecretValue(projectRoot: string): (name: string) => string | null {
  try {
    const service = createProjectSecretService(projectRoot);
    return (name: string) => {
      try {
        return service.get({ name }).value;
      } catch {
        return null;
      }
    };
  } catch {
    return () => null;
  }
}

/**
 * Main-process resolver: looks up the canonical project id, selected secret
 * values (never the whole store), and optional remembered names. Callers
 * spread `extras` onto `Agent.create({ cloud })` — envVars only.
 */
export function resolveCursorCloudCreateCloudExtras(
  input: CursorCloudLaunchResolveInput,
): CursorCloudResolvedCreateOptions {
  const sessionId = trimOrNull(input.sessionId) ?? randomUUID();
  const laneId = trimOrNull(input.laneId) ?? "";
  const projectId = trimOrNull(input.projectId)
    ?? (input.db ? lookupCanonicalProjectId(input.db, input.projectRoot) : null);
  const linearIssueId = trimOrNull(input.linearIssueId);
  let store = input.credentialStore ?? null;
  if (!store && input.rememberSecretNames === true && laneId) {
    try {
      store = openCursorCloudCredentialStore(input.projectRoot);
    } catch {
      store = null;
    }
  }
  const getSecretValue = input.getSecretValue ?? defaultGetSecretValue(input.projectRoot);

  const requestedNames = (input.secretNames ?? [])
    .map((name) => name.trim())
    .filter(isInjectableCloudSecretName);
  const envVars = buildCursorCloudEnvVars(
    requestedNames.flatMap((name) => {
      const value = getSecretValue(name);
      return value ? [{ name, value }] : [];
    }),
  );

  if (input.rememberSecretNames === true && laneId && store) {
    writeCursorCloudLaneSecretNames(store, laneId, requestedNames);
  }

  return {
    sessionId,
    laneId,
    projectId,
    linearIssueId,
    envVars,
    extras: buildCursorCloudCreateCloudExtras({ envVars }),
  };
}
