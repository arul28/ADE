import type { AccountAppTokenClient } from "../../../shared/github/accountAppTokenClient";
import type { AppUserAuthHandOverOutcome } from "./githubAppUserAuthService";
import type { GitHubAppUserTokenRecord } from "./githubAppUserAuth";

/**
 * Moves a machine's own GitHub App sign-in (the device-flow record in
 * `github.appUserToken.v1`) to the ADE account, so the account directory
 * renews it and every machine of the account uses it.
 *
 * It runs from the account vault tick (the same hook that adopts the account's
 * pasted token), so it adds no timer, and it asks the server only while a
 * local record exists:
 *
 * - `201`: the account holds the chain now; the local record is deleted under
 *   the on-disk refresh lease, so no process here POSTs the refresh token
 *   again.
 * - `409` with the same GitHub login: the account already has this person's
 *   sign-in. The local token is retired at GitHub, then deleted.
 * - `409` with a different login: the local record stays as the legacy `app`
 *   source, and Settings asks which one to keep ("Use @y here"). No request
 *   repeats until the local record or the account's login changes.
 * - No answer: the local record keeps working; the next tick tries again
 *   after a short wait. A server without the routes, or without secrets, is
 *   asked again after six hours.
 *
 * The state lives per credential store for the whole process, because a
 * process runs one GitHub service per open project and every one of them
 * runs this on its tick.
 */

const WAIT_AFTER_NO_ANSWER_MS = 60_000;
const WAIT_AFTER_HELD_MS = 30_000;
const WAIT_AFTER_RETIRE_FAILED_MS = 5 * 60_000;
const WAIT_AFTER_UNSUPPORTED_MS = 6 * 60 * 60_000;
const WAIT_AFTER_REFUSED_MS = 6 * 60 * 60_000;
/** A known login mismatch is asked again after this long, in case the account changed elsewhere. */
const MISMATCH_RECHECK_MS = 6 * 60 * 60_000;

export type GithubAppAdoptionOutcome =
  | "signed_out"
  | "no_local"
  | "waiting"
  | "busy"
  | "adopted"
  | "retired_local"
  | "login_mismatch"
  | "kept"
  | "not_renewable";

export type GithubAppLoginMismatch = {
  accountUserId: string;
  localLogin: string | null;
  accountLogin: string | null;
  at: number;
};

type AdoptionState = {
  inFlight: Promise<GithubAppAdoptionOutcome> | null;
  nextAttemptAt: number;
  mismatch: GithubAppLoginMismatch | null;
};

const states = new Map<string, AdoptionState>();

function stateFor(identity: string): AdoptionState {
  let state = states.get(identity);
  if (!state) {
    state = { inFlight: null, nextAttemptAt: 0, mismatch: null };
    states.set(identity, state);
  }
  return state;
}

/** Drops the process-wide adoption state (harnesses and tests). */
export function resetGithubAppAdoptionStates(): void {
  states.clear();
}

const sameLogin = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

export function createGithubAppAccountAdoption(deps: {
  /** Names the credential store, shared by every service over it. */
  storeIdentity: string;
  appUserAuth: {
    getAuthStatus(): { tokenStored: boolean; userLogin: string | null };
    handOverToAccount(handOver: (record: GitHubAppUserTokenRecord & { refreshToken: string }) => Promise<"delete" | "keep">): Promise<AppUserAuthHandOverOutcome>;
  };
  client: Pick<AccountAppTokenClient, "adopt" | "retire" | "peek">;
  getAccountUserId: () => string | null;
  onChanged: () => void;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
}) {
  const now = deps.now ?? (() => Date.now());
  const state = stateFor(deps.storeIdentity);

  const attempt = async (userId: string): Promise<GithubAppAdoptionOutcome> => {
    let outcome: GithubAppAdoptionOutcome = "kept";
    let wait = 0;
    const handed = await deps.appUserAuth.handOverToAccount(async (record) => {
      const answer = await deps.client.adopt({
        accessToken: record.accessToken,
        refreshToken: record.refreshToken,
        // An unknown access deadline reads as "spent", so the server refreshes
        // once and so proves the chain. An unknown refresh deadline (the local
        // service treats it as "still good") gets one day; the server's first
        // refresh records GitHub's real deadline.
        expiresAt: record.expiresAt ?? now(),
        refreshTokenExpiresAt: record.refreshTokenExpiresAt ?? now() + 24 * 60 * 60_000,
      });
      switch (answer.kind) {
        case "adopted":
          outcome = "adopted";
          deps.logger.info("github.app_adopted", { loginMatches: sameLogin(answer.githubLogin, record.userLogin) });
          return "delete";
        case "already_connected": {
          if (record.userLogin && sameLogin(answer.githubLogin, record.userLogin)) {
            // The account already holds this person's sign-in: this machine's
            // copy is a second live token for nothing. Retire it first, so a
            // failure leaves the record to try again rather than a live token
            // nobody holds.
            if (await deps.client.retire(record.accessToken)) {
              outcome = "retired_local";
              deps.logger.info("github.app_adopt_retired_local", {});
              return "delete";
            }
            wait = WAIT_AFTER_RETIRE_FAILED_MS;
            outcome = "kept";
            return "keep";
          }
          state.mismatch = { accountUserId: userId, localLogin: record.userLogin ?? null, accountLogin: answer.githubLogin, at: now() };
          outcome = "login_mismatch";
          deps.logger.info("github.app_adopt_skipped_login_mismatch", {});
          return "keep";
        }
        case "rejected":
          wait = WAIT_AFTER_REFUSED_MS;
          deps.logger.info("github.app_adopt_refused", { code: answer.code });
          return "keep";
        case "unsupported":
          wait = WAIT_AFTER_UNSUPPORTED_MS;
          return "keep";
        case "signed_out":
          return "keep";
        case "unavailable":
          wait = Math.max(WAIT_AFTER_NO_ANSWER_MS, (answer.retryAfterSec ?? 0) * 1000);
          return "keep";
      }
    });
    if (handed === "handed_over") {
      state.mismatch = null;
      state.nextAttemptAt = 0;
      deps.onChanged();
      return outcome;
    }
    if (handed === "held") {
      state.nextAttemptAt = now() + WAIT_AFTER_HELD_MS;
      return "busy";
    }
    if (handed === "missing") return "no_local";
    if (handed === "not_renewable") return "not_renewable";
    state.nextAttemptAt = now() + wait;
    return outcome;
  };

  /** One adoption pass; cheap when there is nothing to do (no request). */
  const run = async (): Promise<GithubAppAdoptionOutcome> => {
    const userId = deps.getAccountUserId()?.trim() || null;
    if (!userId) return "signed_out";
    let local: { tokenStored: boolean; userLogin: string | null };
    try {
      local = deps.appUserAuth.getAuthStatus();
    } catch {
      return "no_local";
    }
    if (!local.tokenStored) {
      state.mismatch = null;
      return "no_local";
    }
    const mismatch = state.mismatch;
    if (mismatch) {
      const accountLogin = deps.client.peek().githubLogin;
      const stillTrue = mismatch.accountUserId === userId
        && sameLogin(mismatch.localLogin, local.userLogin)
        && (!accountLogin || sameLogin(accountLogin, mismatch.accountLogin))
        && now() - mismatch.at < MISMATCH_RECHECK_MS;
      if (stillTrue) return "login_mismatch";
      state.mismatch = null;
    }
    if (now() < state.nextAttemptAt) return "waiting";
    if (state.inFlight) return await state.inFlight;
    const work = attempt(userId).catch((error: unknown) => {
      deps.logger.warn("github.app_adopt_failed", { error: error instanceof Error ? error.message : String(error) });
      state.nextAttemptAt = now() + WAIT_AFTER_NO_ANSWER_MS;
      return "kept" as const;
    });
    state.inFlight = work;
    try {
      return await work;
    } finally {
      if (state.inFlight === work) state.inFlight = null;
    }
  };

  /** The login mismatch Settings asks about, for the signed-in account, or null. */
  const loginMismatch = (): GithubAppLoginMismatch | null => {
    const userId = deps.getAccountUserId()?.trim() || null;
    const mismatch = state.mismatch;
    return mismatch && userId && mismatch.accountUserId === userId ? mismatch : null;
  };

  /** Forget a known mismatch (the local record was removed, or a person asked to check again). */
  const forget = (): void => {
    state.mismatch = null;
    state.nextAttemptAt = 0;
  };

  return { run, loginMismatch, forget };
}
