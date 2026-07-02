import { createHmac } from "node:crypto";
import type { GitHubAppInstallationStatus, GitHubRepoRef } from "../../../shared/types";

export const ADE_GITHUB_APP_DISPLAY_NAME = "ADE";
export const ADE_GITHUB_APP_SLUG = "ade-for-github";
export const ADE_GITHUB_APP_INSTALL_URL = `https://github.com/apps/${ADE_GITHUB_APP_SLUG}/installations/new`;
export const GITHUB_APP_INSTALLATIONS_URL = "https://github.com/settings/installations";
// Default hosted GitHub App webhook relay. This is a project-operated Cloudflare
// Worker used for the ADE GitHub App integration during beta; it can be pointed
// at a self-hosted relay via GITHUB_RELAY_API_BASE_REF or the *_API_BASE_ENV_KEYS
// env vars. Replacing this personal default with a first-party/self-hostable
// endpoint is a tracked pre-external-launch item.
export const DEFAULT_GITHUB_RELAY_API_BASE_URL = "https://ade-github-webhook-relay.arulsharma1028.workers.dev";

export const GITHUB_RELAY_API_BASE_REF = "automations.githubRelay.apiBaseUrl";
export const GITHUB_RELAY_PROJECT_REF = "automations.githubRelay.remoteProjectId";
export const GITHUB_RELAY_TOKEN_REF = "automations.githubRelay.accessToken";
export const GITHUB_RELAY_API_BASE_ENV_KEYS = ["ADE_GITHUB_RELAY_API_BASE_URL", "GITHUB_RELAY_API_BASE_URL"] as const;
export const GITHUB_RELAY_PROJECT_ENV_KEYS = ["ADE_GITHUB_RELAY_REMOTE_PROJECT_ID", "GITHUB_RELAY_REMOTE_PROJECT_ID"] as const;
export const GITHUB_RELAY_TOKEN_ENV_KEYS = ["ADE_GITHUB_RELAY_ACCESS_TOKEN", "GITHUB_RELAY_ACCESS_TOKEN"] as const;
export const GITHUB_RELAY_PROJECT_TOKEN_PREFIX = "ade_proj_";
const GITHUB_RELAY_PROJECT_TOKEN_CONTEXT = "ade-github-relay-project";

export type GitHubRelaySecretReader = (ref: string) => string | null | undefined;

export type GitHubRelayConfig = {
  apiBaseUrl: string | null;
  remoteProjectId: string | null;
  accessToken: string | null;
  usesHostedDefault: boolean;
  configured: boolean;
};

export type GitHubRelayHostedAuthTokenResolution =
  | {
      ok: true;
      token: string;
    }
  | {
      ok: false;
      error: string;
    };

export type GitHubRelayAuthAuditLog = (event: string, metadata: Record<string, unknown>) => void;

const AUDIT_LOG_MAX_SEEN = 500;

export function createGitHubRelayAuthAuditLog(emit: (event: string, metadata: Record<string, unknown>) => void): GitHubRelayAuthAuditLog {
  const seen = new Set<string>();
  return (event, metadata) => {
    const key = event + ":" + String(metadata.route ?? "") + ":" + String(metadata.repo ?? "") + ":" + String(metadata.tokenSource ?? "");
    if (seen.has(key)) return;
    // Bound memory in long-lived multi-repo processes; occasional re-log is fine.
    if (seen.size >= AUDIT_LOG_MAX_SEEN) seen.clear();
    seen.add(key);
    emit(event, metadata);
  };
}

function firstEnvValue(keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function readSecret(reader: GitHubRelaySecretReader | null | undefined, ref: string): string | null {
  const value = reader?.(ref)?.trim();
  return value || null;
}

export function readGitHubRelayConfig(secretReader?: GitHubRelaySecretReader | null): GitHubRelayConfig {
  const configuredApiBaseUrl =
    readSecret(secretReader, GITHUB_RELAY_API_BASE_REF)
    || firstEnvValue(GITHUB_RELAY_API_BASE_ENV_KEYS);
  const apiBaseUrl = configuredApiBaseUrl || DEFAULT_GITHUB_RELAY_API_BASE_URL;
  const remoteProjectId =
    readSecret(secretReader, GITHUB_RELAY_PROJECT_REF)
    || firstEnvValue(GITHUB_RELAY_PROJECT_ENV_KEYS);
  const accessToken =
    readSecret(secretReader, GITHUB_RELAY_TOKEN_REF)
    || firstEnvValue(GITHUB_RELAY_TOKEN_ENV_KEYS);
  return {
    apiBaseUrl,
    remoteProjectId,
    accessToken,
    usesHostedDefault: !configuredApiBaseUrl,
    configured: Boolean(apiBaseUrl && ((remoteProjectId && accessToken) || apiBaseUrl === DEFAULT_GITHUB_RELAY_API_BASE_URL)),
  };
}

export function deriveGitHubRelayProjectToken(accessToken: string, projectId: string): string {
  const trimmedToken = accessToken.trim();
  if (trimmedToken.startsWith(GITHUB_RELAY_PROJECT_TOKEN_PREFIX)) return trimmedToken;
  const digest = createHmac("sha256", trimmedToken)
    .update(`${GITHUB_RELAY_PROJECT_TOKEN_CONTEXT}:${projectId.trim()}`)
    .digest("hex");
  return `${GITHUB_RELAY_PROJECT_TOKEN_PREFIX}${digest}`;
}

export function gitHubRelayAuthorizationToken(config: GitHubRelayConfig): string | null {
  if (!config.accessToken || !config.remoteProjectId) return null;
  return deriveGitHubRelayProjectToken(config.accessToken, config.remoteProjectId);
}

export function shouldUseLegacyGitHubRelayProjectRoute(
  config: GitHubRelayConfig,
): boolean {
  if (!config.remoteProjectId || !config.accessToken) return false;
  return !config.usesHostedDefault;
}

export function resolveHostedGitHubRelayAuthToken(args: {
  githubAppUserToken?: string | null;
}): GitHubRelayHostedAuthTokenResolution {
  const githubAppUserToken = args.githubAppUserToken?.trim();
  if (!githubAppUserToken) {
    return {
      ok: false,
      error: "Authorize the ADE GitHub App with GitHub before using the hosted relay.",
    };
  }
  return {
    ok: true,
    token: githubAppUserToken,
  };
}

function baseStatus(repo: GitHubRepoRef | null, patch: Partial<GitHubAppInstallationStatus>): GitHubAppInstallationStatus {
  return {
    repo,
    appName: ADE_GITHUB_APP_DISPLAY_NAME,
    appSlug: ADE_GITHUB_APP_SLUG,
    installUrl: ADE_GITHUB_APP_INSTALL_URL,
    manageUrl: GITHUB_APP_INSTALLATIONS_URL,
    relayConfigured: false,
    installed: false,
    state: "unknown",
    installationId: null,
    repositorySelection: null,
    lastSeenAt: null,
    webhookEvents: [],
    missingWebhookEvents: [],
    webhookState: "unknown",
    webhookLastSeenAt: null,
    checkedAt: new Date().toISOString(),
    error: null,
    ...patch,
  };
}

function normalizeRelayStatusPayload(
  repo: GitHubRepoRef,
  payload: unknown,
  relayConfigured: boolean,
): GitHubAppInstallationStatus {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const installationId = typeof record.installationId === "number" && Number.isFinite(record.installationId)
    ? Math.trunc(record.installationId)
    : null;
  const repositorySelection =
    record.repositorySelection === "all" || record.repositorySelection === "selected"
      ? record.repositorySelection
      : record.repositorySelection === "unknown"
        ? "unknown"
        : null;
  const state = record.installed === true
    ? "configured"
    : record.state === "not_installed"
      ? "not_installed"
      : "unknown";
  const webhookEvents = Array.isArray(record.webhookEvents)
    ? record.webhookEvents.filter((event): event is string => typeof event === "string" && event.trim().length > 0)
    : [];
  const missingWebhookEvents = Array.isArray(record.missingWebhookEvents)
    ? record.missingWebhookEvents.filter((event): event is string => typeof event === "string" && event.trim().length > 0)
    : [];
  const webhookState =
    record.webhookState === "active" || record.webhookState === "deleted" || record.webhookState === "unknown"
      ? record.webhookState
      : "unknown";
  return baseStatus(repo, {
    relayConfigured,
    installed: record.installed === true,
    state,
    installationId,
    repositorySelection,
    lastSeenAt: typeof record.lastSeenAt === "string" && record.lastSeenAt ? record.lastSeenAt : null,
    webhookEvents,
    missingWebhookEvents,
    webhookState,
    webhookLastSeenAt: typeof record.webhookLastSeenAt === "string" && record.webhookLastSeenAt ? record.webhookLastSeenAt : null,
    checkedAt: typeof record.checkedAt === "string" && record.checkedAt ? record.checkedAt : new Date().toISOString(),
    error: typeof record.error === "string" && record.error ? record.error : null,
  });
}

export async function fetchGitHubAppInstallationStatus(args: {
  repo: GitHubRepoRef | null;
  secretReader?: GitHubRelaySecretReader | null;
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  githubAppUserToken?: string | null;
  auditLog?: GitHubRelayAuthAuditLog | null;
}): Promise<GitHubAppInstallationStatus> {
  const config = readGitHubRelayConfig(args.secretReader);
  if (!args.repo) {
    return baseStatus(null, {
      relayConfigured: config.configured,
      state: "unknown",
      error: "No GitHub repository was detected for this project.",
    });
  }
  if (!config.apiBaseUrl) {
    return baseStatus(args.repo, {
      relayConfigured: false,
      state: "unconfigured",
      error: "GitHub App relay is not configured for this ADE runtime.",
    });
  }

  try {
    const baseUrl = config.apiBaseUrl!.replace(/\/+$/, "");
    const githubAppUserToken = args.githubAppUserToken?.trim();
    const legacyAuthToken = gitHubRelayAuthorizationToken(config);
    const useLegacyProjectRoute = shouldUseLegacyGitHubRelayProjectRoute(config);
    const url = useLegacyProjectRoute
      ? `${baseUrl}/projects/${encodeURIComponent(config.remoteProjectId!)}/github/repos/${encodeURIComponent(args.repo.owner)}/${encodeURIComponent(args.repo.name)}/status${args.forceRefresh ? "?refresh=1" : ""}`
      : `${baseUrl}/github/repos/${encodeURIComponent(args.repo.owner)}/${encodeURIComponent(args.repo.name)}/status${args.forceRefresh ? "?refresh=1" : ""}`;
    const hostedAuth = useLegacyProjectRoute
      ? null
      : resolveHostedGitHubRelayAuthToken({ githubAppUserToken });
    if (hostedAuth && !hostedAuth.ok) {
      return baseStatus(args.repo, {
        relayConfigured: true,
        state: "error",
        error: hostedAuth.error,
      });
    }
    const authToken = useLegacyProjectRoute ? legacyAuthToken : hostedAuth?.token ?? null;
    if (!authToken) {
      return baseStatus(args.repo, {
        relayConfigured: true,
        state: "error",
        error: "GitHub auth is required to check the ADE GitHub App installation.",
      });
    }
    if (hostedAuth?.ok) {
      args.auditLog?.("github.hosted_relay_auth_token_used", {
        origin: new URL(baseUrl).origin,
        repo: `${args.repo.owner}/${args.repo.name}`,
        tokenSource: "github-app-user-token",
        route: "status",
      });
    }
    const response = await (args.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authToken}`,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `GitHub App relay status check failed (${response.status})`;
      return baseStatus(args.repo, {
        relayConfigured: true,
        state: "error",
        error: message,
      });
    }
    return normalizeRelayStatusPayload(args.repo, payload, config.configured);
  } catch (error) {
    return baseStatus(args.repo, {
      relayConfigured: config.configured,
      state: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
