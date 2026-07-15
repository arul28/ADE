// Main-process bridge for the machine-owned ADE account (Clerk identity, #815).
//
// The renderer never holds the account bearer. This bridge owns the shared
// account auth service in the main process, exposes only the token-free surface
// to IPC (status/startLogin/pollLogin/cancelLogin/signOut), and performs the
// directory-Worker machine fetch here so the token stays in main.
//
// The service is process-global (keyed by secrets dir) and file-backed, so it
// stays consistent with the CLI daemon's own account session on disk.

import {
  getSharedAccountAuthService,
  registerAccountConfigProjectRoot,
} from "../../../../../ade-cli/src/services/account/sharedAccountAuthService";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type {
  AccountAuthStatus,
  AccountLoginPollResult,
  AccountLoginStartResult,
} from "../../../../../ade-cli/src/services/account/accountAuthService";
import { createProjectSecretService } from "../secrets/projectSecretService";
import type {
  AdeAccountMachine,
  AdeAccountMachineEndpoint,
  AdeAccountMachinesResult,
  AdeAccountStatus,
} from "../../../shared/types";

const MACHINES_FETCH_TIMEOUT_MS = 8_000;

type AccountBridgeOptions = {
  /** Resolves the active project root so CLERK_* project secrets win config. */
  getProjectRoot: () => string | null;
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
};

function readProjectSecret(projectRoot: string | null, name: string): string | null {
  if (!projectRoot) return null;
  try {
    return createProjectSecretService(projectRoot).get({ name }).value.trim() || null;
  } catch {
    return null;
  }
}

/** Best-effort: is machine sign-in configured (CLERK issuer + client id present)? */
function isLoginConfigured(projectRoot: string | null): boolean {
  const issuer =
    readProjectSecret(projectRoot, "CLERK_ISSUER") ?? process.env.CLERK_ISSUER?.trim() ?? "";
  const clientId =
    readProjectSecret(projectRoot, "CLERK_OAUTH_CLIENT_ID")
    ?? process.env.CLERK_OAUTH_CLIENT_ID?.trim()
    ?? "";
  return Boolean(issuer && clientId);
}

function isLoopbackHost(hostname: string): boolean {
  // URL.hostname wraps IPv6 in brackets (e.g. "[::1]"); strip them before match.
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Trust boundary for the machine account bearer. `listMachines` attaches the
 * machine's account token to `${baseUrl}/account/machines`, so `baseUrl` must be
 * an origin the machine owner explicitly trusts — never one that a per-project
 * secret can point at an arbitrary host. Accept only an absolute `https:` origin
 * (or `http:` on a loopback host for local dev) and reject everything else, so
 * the bearer can only ever leave over TLS (or stay on the local machine).
 * Returns the normalized base URL (trailing slashes stripped) or null.
 */
export function parseTrustedDirectoryBaseUrl(
  raw: string | null | undefined,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHost(url.hostname))
  ) {
    if (url.username || url.password || url.search || url.hash) return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  }
  return null;
}

/**
 * Resolve the machine directory origin the account bearer may be sent to.
 *
 * Trust model: the bearer is the MACHINE's account token (machine-scoped
 * infrastructure), so where it is sent must be controlled by the machine owner
 * alone. We read ONLY the machine-level `ADE_ACCOUNT_DIRECTORY_URL` env — the
 * per-project `ACCOUNT_DIRECTORY_URL` secret is deliberately NOT consulted, so
 * an opened project can never redirect the token to a host it controls. The
 * value is passed through `parseTrustedDirectoryBaseUrl`, so the token is only
 * ever attached to a trusted https (or loopback) origin.
 */
function resolveDirectoryBaseUrl(): string | null {
  return parseTrustedDirectoryBaseUrl(process.env.ADE_ACCOUNT_DIRECTORY_URL);
}

function toAccountStatus(
  status: AccountAuthStatus,
  configured: boolean,
): AdeAccountStatus {
  return {
    signedIn: status.signedIn,
    userId: status.userId,
    email: status.email,
    name: status.name,
    expiresAt: status.expiresAt,
    // The merged daemon status does not yet carry provider/image; leave null so
    // the renderer degrades to a GitHub-creds image and a monogram.
    provider: null,
    imageUrl: null,
    configured,
  };
}

function mapMachine(raw: unknown): AdeAccountMachine | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const machineKey = typeof value.machineKey === "string" ? value.machineKey : null;
  if (!machineKey) return null;
  const endpoints = Array.isArray(value.reachableEndpoints)
    ? value.reachableEndpoints
        .map((entry): AdeAccountMachineEndpoint | null => {
          if (!entry || typeof entry !== "object") return null;
          const e = entry as Record<string, unknown>;
          const kind = e.kind;
          if (kind !== "lan" && kind !== "tailnet" && kind !== "relay") return null;
          return {
            kind,
            url: typeof e.url === "string" ? e.url : undefined,
            host: typeof e.host === "string" ? e.host : undefined,
            port: typeof e.port === "number" ? e.port : undefined,
          };
        })
        .filter((entry): entry is AdeAccountMachineEndpoint => entry != null)
    : [];
  return {
    machineKey,
    deviceId: typeof value.deviceId === "string" ? value.deviceId : null,
    name: typeof value.name === "string" ? value.name : null,
    platform: typeof value.platform === "string" ? value.platform : null,
    deviceType: typeof value.deviceType === "string" ? value.deviceType : null,
    reachableEndpoints: endpoints,
    lastSeenAt: typeof value.lastSeenAt === "number" ? value.lastSeenAt : null,
    online: value.online === true,
  };
}

export type AccountBridge = {
  status(): AdeAccountStatus;
  startLogin(): Promise<AccountLoginStartResult>;
  pollLogin(sessionId: string): Promise<AccountLoginPollResult>;
  cancelLogin(sessionId: string): void;
  signOut(): AdeAccountStatus;
  listMachines(): Promise<AdeAccountMachinesResult>;
};

export function createAccountBridge(options: AccountBridgeOptions): AccountBridge {
  const secretsDir = resolveMachineAdeLayout().secretsDir;

  const service = () =>
    getSharedAccountAuthService({
      secretsDir,
      projectRoots: () => {
        const root = options.getProjectRoot();
        return root ? [root] : [];
      },
      logger: options.logger,
    });

  const configured = () => isLoginConfigured(options.getProjectRoot());

  return {
    status: () => toAccountStatus(service().getStatus(), configured()),

    startLogin: () => {
      // Prioritize the active project's CLERK_* secrets for config resolution.
      const root = options.getProjectRoot();
      if (root) registerAccountConfigProjectRoot(root, secretsDir, { prioritize: true });
      return service().startLogin();
    },

    pollLogin: (sessionId: string) => service().pollLogin(sessionId),

    cancelLogin: (sessionId: string) => service().cancelLogin(sessionId),

    signOut: () => toAccountStatus(service().signOut(), configured()),

    listMachines: async (): Promise<AdeAccountMachinesResult> => {
      const svc = service();
      if (!svc.getStatus().signedIn) {
        return { state: "signed_out", machines: [], message: null };
      }
      const baseUrl = resolveDirectoryBaseUrl();
      if (!baseUrl) {
        return {
          state: "not_configured",
          machines: [],
          message:
            "Machine directory isn't configured — set a trusted https directory URL on this machine.",
        };
      }
      let token: string;
      try {
        token = await svc.getAccessToken();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A missing/expired session reads as signed-out to the UI.
        if (/not signed in|session expired/i.test(message)) {
          return { state: "signed_out", machines: [], message: null };
        }
        return { state: "unavailable", machines: [], message };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MACHINES_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(`${baseUrl}/account/machines`, {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) {
          return {
            state: "unavailable",
            machines: [],
            message: `Machine directory returned ${response.status}.`,
          };
        }
        const payload = (await response.json().catch(() => null)) as
          | { machines?: unknown[] }
          | null;
        const machines = Array.isArray(payload?.machines)
          ? payload!.machines
              .map(mapMachine)
              .filter((entry): entry is AdeAccountMachine => entry != null)
          : [];
        return { state: "ok", machines, message: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.warn("account.machines_fetch_failed", { error: message });
        return {
          state: "unavailable",
          machines: [],
          message: controller.signal.aborted ? "Machine directory timed out." : message,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
