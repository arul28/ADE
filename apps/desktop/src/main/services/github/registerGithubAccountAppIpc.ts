import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type {
  GitHubAccountAppAccountStatus,
  GitHubAccountAppSignInReadResult,
  GitHubAccountAppSignInStartResult,
  GitHubAccountAppSignOutResult,
} from "../../../shared/types";
import { createAccountAppTokenClient } from "../../../shared/github/accountAppTokenClient";
import { resolveTrustedAccountDirectoryBaseUrl } from "../../../shared/accountDirectory";
import { GITHUB_ACCOUNT_APP_TOKEN_KEY } from "../../../shared/github/accountAppTokenClient";
import { updateCredentialKeySync, type UpdatableCredentialStore } from "../../../../../ade-cli/src/services/credentials/updateCredentialKey";
import { isTrustedAdeRendererSender } from "../ipc/trustedRendererSender";
import { openExternalUrl } from "../shared/externalLinks";

/**
 * Settings' controls for the ADE account's GitHub App sign-in: connect (the
 * web flow in the system browser), read how a connect ended, disconnect, and
 * the account's status.
 *
 * These calls take no machine pin, on purpose. The sign-in belongs to the ADE
 * account and lives in the account directory, not on any machine: every
 * machine of the account reads the same grant, whichever machine the project
 * tab is bound to. The main process asks the directory with this window's
 * ADE account token. A machine's own use of the token (and its cache) stays in
 * that machine's GitHub service, which the renderer reaches with its pin.
 *
 * The browser page at the end of the sign-in only says "go back to ADE"; it
 * never carries a token, so nothing comes back to this process through a URL.
 */
export function registerGithubAccountAppIpc(args: {
  credentialStore: UpdatableCredentialStore & { credentialStoreIdentity?(): string };
  getDirectoryBaseUrl: () => string | null;
  getAccountAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  getAccountUserId: () => string | null;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}): void {
  const client = createAccountAppTokenClient({
    getAccountAccessToken: args.getAccountAccessToken,
    getAccountUserId: args.getAccountUserId,
    getDirectoryBaseUrl: () => {
      try {
        return resolveTrustedAccountDirectoryBaseUrl(args.getDirectoryBaseUrl());
      } catch {
        return null;
      }
    },
    // The machine cache, so a connect or disconnect here clears it at once
    // for this machine's desktop and brain.
    store: {
      read: () => args.credentialStore.getSync(GITHUB_ACCOUNT_APP_TOKEN_KEY) ?? null,
      update: (mutator) => {
        updateCredentialKeySync(args.credentialStore, GITHUB_ACCOUNT_APP_TOKEN_KEY, mutator);
      },
      identity: () => `account-app:${args.credentialStore.credentialStoreIdentity?.() ?? "unnamed"}`,
    },
    holderId: `settings-${process.pid}`,
    clientKind: "desktop",
    logger: { info: (event, data) => args.logger.info(event, data), warn: (event, data) => args.logger.warn(event, data) },
  });

  const handle = <A extends unknown[], R>(channel: string, fn: (...a: A) => Promise<R>) => {
    ipcMain.handle(channel, async (event, ...rest) => {
      if (!isTrustedAdeRendererSender(event)) throw new Error("GitHub sign-in is only available to the ADE window.");
      return await fn(...(rest as A));
    });
  };

  handle(IPC.githubGetAccountAppStatus, async (): Promise<GitHubAccountAppAccountStatus> => {
    const answer = await client.status();
    if (!answer.ok) {
      return {
        available: false,
        error: answer.error,
        connected: false,
        state: null,
        stateReason: null,
        githubLogin: null,
        connectedAt: null,
        origin: null,
      };
    }
    return {
      available: true,
      error: null,
      connected: answer.status.connected,
      state: answer.status.state,
      stateReason: answer.status.stateReason,
      githubLogin: answer.status.githubLogin,
      connectedAt: answer.status.connectedAt,
      origin: answer.status.origin,
    };
  });

  handle(IPC.githubStartAccountAppSignIn, async (): Promise<GitHubAccountAppSignInStartResult> => {
    const answer = await client.startSignIn();
    if (!answer.ok) {
      args.logger.info("github.account_app_sign_in_not_started", { error: answer.error });
      return { ok: false, error: answer.error, message: answer.message };
    }
    // Only a github.com page opens; the server builds the URL.
    let authorizeHost = "";
    try {
      authorizeHost = new URL(answer.signIn.authorizeUrl).hostname.toLowerCase();
    } catch {
      authorizeHost = "";
    }
    if (authorizeHost !== "github.com") {
      args.logger.warn("github.account_app_sign_in_bad_url", {});
      return { ok: false, error: "unavailable", message: null };
    }
    await openExternalUrl(answer.signIn.authorizeUrl);
    args.logger.info("github.account_app_sign_in_started", {});
    return { ok: true, signInId: answer.signIn.signInId, expiresAt: answer.signIn.expiresAt };
  });

  handle(IPC.githubReadAccountAppSignIn, async (input: { signInId?: unknown }): Promise<GitHubAccountAppSignInReadResult> => {
    const signInId = typeof input?.signInId === "string" ? input.signInId : "";
    const answer = await client.readSignIn(signInId);
    if (!answer.ok) return { ok: false, error: answer.error };
    if (answer.signIn.status !== "pending") {
      args.logger.info("github.account_app_sign_in_finished", { status: answer.signIn.status, resultCode: answer.signIn.resultCode });
    }
    return { ok: true, ...answer.signIn };
  });

  handle(IPC.githubSignOutAccountApp, async (): Promise<GitHubAccountAppSignOutResult> => {
    const answer = await client.signOut();
    if (!answer.ok) return { ok: false, error: answer.error };
    args.logger.info("github.account_app_signed_out", { deletedAtGitHub: answer.result.deletedAtGitHub });
    return { ok: true, deletedAtGitHub: answer.result.deletedAtGitHub, revokeAtGitHubUrl: answer.result.revokeAtGitHubUrl };
  });
}
