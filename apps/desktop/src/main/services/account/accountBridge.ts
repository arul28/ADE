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
import { AccountMachineDirectoryService } from "../../../../../ade-cli/src/services/account/accountMachineDirectoryService";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import os from "node:os";
import type {
  AccountAuthStatus,
  AccountLoginStartResult,
} from "../../../../../ade-cli/src/services/account/accountAuthService";
import { createProjectSecretService } from "../secrets/projectSecretService";
import type { AccountMachineReconciliationResult } from "../remoteRuntime/remoteConnectionService";
import type {
  AdeAccountMachinePairResult,
  AdeAccountMachineRemovalResult,
  AdeAccountMachinesResult,
  AdeAccountLoginPoll,
  AdeAccountStatus,
} from "../../../shared/types";
import {
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  officialAccountDirectoryUrlForIssuer,
  parseTrustedAccountDirectoryBaseUrl,
} from "../../../shared/accountDirectory";

type AccountBridgeOptions = {
  /** Resolves the active project root so CLERK_* project secrets win config. */
  getProjectRoot: () => string | null;
  reconcileAccountOwnership?: (
    currentOwnerUserId: string | null,
  ) => AccountMachineReconciliationResult;
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
  const projectIssuer = readProjectSecret(projectRoot, "CLERK_ISSUER");
  const projectClientId = readProjectSecret(projectRoot, "CLERK_OAUTH_CLIENT_ID");
  const envIssuer = process.env.CLERK_ISSUER?.trim() ?? "";
  const envClientId = process.env.CLERK_OAUTH_CLIENT_ID?.trim() ?? "";
  if (projectIssuer || projectClientId) {
    return Boolean(projectIssuer ?? envIssuer) && Boolean(projectClientId ?? envClientId);
  }
  if (envIssuer || envClientId) return Boolean(envIssuer && envClientId);
  const issuer = DEFAULT_ADE_CLERK_ISSUER;
  const clientId = DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID;
  return Boolean(issuer && clientId);
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
  return parseTrustedAccountDirectoryBaseUrl(raw);
}

/**
 * Resolve the machine directory origin the account bearer may be sent to.
 *
 * Trust model: the bearer is the MACHINE's account token (machine-scoped
 * infrastructure), so where it is sent must be controlled by the machine owner
 * alone. A machine-level `ADE_ACCOUNT_DIRECTORY_URL` env override may select a
 * self-hosted directory; otherwise ADE uses its compiled Cloudflare Worker
 * origin. Per-project secrets are deliberately NOT consulted, so an opened
 * project can never redirect the token to a host it controls. The selected
 * value is passed through `parseTrustedDirectoryBaseUrl`, so the token is only
 * ever attached to a trusted https (or loopback) origin.
 */
function resolveDirectoryBaseUrl(projectRoot: string | null): string | null {
  const machineOverride = process.env.ADE_ACCOUNT_DIRECTORY_URL;
  if (machineOverride?.trim()) {
    return parseTrustedAccountDirectoryBaseUrl(machineOverride);
  }
  const issuer = readProjectSecret(projectRoot, "CLERK_ISSUER")
    ?? process.env.CLERK_ISSUER?.trim()
    ?? DEFAULT_ADE_CLERK_ISSUER;
  return officialAccountDirectoryUrlForIssuer(issuer);
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
    provider: status.provider ?? null,
    imageUrl: status.imageUrl ?? null,
    configured,
  };
}

export type AccountBridge = {
  status(): AdeAccountStatus;
  startLogin(): Promise<AccountLoginStartResult>;
  pollLogin(sessionId: string): Promise<AdeAccountLoginPoll>;
  cancelLogin(sessionId: string): void;
  signOut(): AdeAccountStatus;
  listMachines(): Promise<AdeAccountMachinesResult>;
  pairMachine(machineKey: string): Promise<AdeAccountMachinePairResult>;
  removeMachine(machineKey: string): Promise<AdeAccountMachineRemovalResult>;
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
  const directoryService = () => new AccountMachineDirectoryService(service(), {
    directoryBaseUrl: () => resolveDirectoryBaseUrl(options.getProjectRoot()),
    deviceName: () => `ADE Desktop on ${os.hostname()}`,
  });
  const reconcileLocalMachines = (currentOwnerUserId: string | null): void => {
    const result = options.reconcileAccountOwnership?.(currentOwnerUserId);
    if (
      result
      && (result.removedTargetIds.length > 0
        || result.removedCredentialHostIds.length > 0)
    ) {
      options.logger?.info("account.local_machines_removed", {
        targetCount: result.removedTargetIds.length,
        credentialCount: result.removedCredentialHostIds.length,
      });
    }
  };

  return {
    status: () => toAccountStatus(service().getStatus(), configured()),

    startLogin: () => {
      // Prioritize the active project's CLERK_* secrets for config resolution.
      const root = options.getProjectRoot();
      if (root) registerAccountConfigProjectRoot(root, secretsDir, { prioritize: true });
      return service().startLogin();
    },

    pollLogin: async (sessionId: string) => {
      const result = await service().pollLogin(sessionId);
      if (result.status === "signed_in") {
        reconcileLocalMachines(
          result.authStatus.signedIn ? result.authStatus.userId : null,
        );
      }
      return {
        ...result,
        authStatus: toAccountStatus(result.authStatus, configured()),
      };
    },

    cancelLogin: (sessionId: string) => service().cancelLogin(sessionId),

    signOut: () => {
      const accountService = service();
      const status = accountService.signOut();
      reconcileLocalMachines(null);
      return toAccountStatus(status, configured());
    },

    listMachines: async (): Promise<AdeAccountMachinesResult> => {
      const result = await directoryService().listMachines();
      if (result.state === "auth_expired") reconcileLocalMachines(null);
      if (result.state === "unavailable") {
        options.logger?.warn("account.machines_fetch_failed", { state: result.state });
      }
      return result.state === "auth_expired"
        ? { ...result, message: "Your ADE account session expired. Sign in again." }
        : result;
    },

    pairMachine: async (machineKey: string): Promise<AdeAccountMachinePairResult> => {
      return await directoryService().pairMachine(machineKey);
    },

    removeMachine: async (machineKey: string): Promise<AdeAccountMachineRemovalResult> => {
      return await directoryService().deleteMachine(machineKey);
    },
  };
}
