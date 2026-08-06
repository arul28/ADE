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
  resolveAccountOAuthConfig,
  resolveOfficialAccountDirectoryBaseUrl,
} from "../../../../../ade-cli/src/services/account/sharedAccountAuthService";
import { AccountMachineDirectoryService } from "../../../../../ade-cli/src/services/account/accountMachineDirectoryService";
import { accountMachineDisplayName } from "../../../shared/accountDirectory";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { createFileLogger, type Logger } from "../logging/logger";
import os from "node:os";
import path from "node:path";
import type {
  AccountAuthStatus,
  AccountLoginStartResult,
} from "../../../../../ade-cli/src/services/account/accountAuthService";
import type { AccountMachineReconciliationResult } from "../remoteRuntime/remoteConnectionService";
import type {
  AdeAccountDeviceLoginPoll,
  AdeAccountDeviceLoginStart,
  AdeAccountMachine,
  AdeAccountMachinePairResult,
  AdeAccountMachinePairingRepairResult,
  AdeAccountMachineRemovalResult,
  AdeAccountMachinesResult,
  AdeAccountPairMachineProgress,
  AdeAccountLoginPoll,
  AdeAccountSessionReadState,
  AdeAccountStatus,
} from "../../../shared/types";
import {
  parseTrustedAccountDirectoryBaseUrl,
  shouldIgnoreDevelopmentAccountDirectoryUrl,
  warnDevelopmentClerkIgnored,
} from "../../../shared/accountDirectory";

type AccountBridgeOptions = {
  /** Resolves the active project root so CLERK_* project secrets win config. */
  getProjectRoot: () => string | null;
  reconcileAccountOwnership?: (
    currentOwnerUserId: string | null,
  ) => AccountMachineReconciliationResult;
  /**
   * Clear a removed machine's Activity. Removal deletes one directory row, and
   * nothing in that path has ever touched the Activity store, so the machine's
   * items survive it. Injected rather than imported so the bridge keeps no
   * dependency on the attention stack.
   */
  purgeMachineActivity?: (machineKey: string) => Promise<void>;
  /**
   * Calls an `account.call` action on THIS machine's ADE brain.
   *
   * Re-pairing cannot be done in Electron main: the push revocation's live
   * in-memory gate lives in the brain process, and clearing only the durable
   * file from here would leave the running brain still muted. So the bridge
   * forwards to the brain and owns just the result normalization.
   */
  callBrainAccountAction?: (
    action: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
};

/**
 * Best-effort: is machine sign-in configured (CLERK issuer + client id present)?
 * Derive it from the SAME resolver `startLogin()` uses so the packaged
 * development-Clerk-ignore policy is reflected here — otherwise a stale partial
 * development secret would disable the sign-in UI even though login would fall
 * back to the production defaults and succeed.
 */
function isLoginConfigured(projectRoot: string | null): boolean {
  const { issuer, clientId } = resolveAccountOAuthConfig({
    env: process.env,
    projectRoots: projectRoot ? [projectRoot] : [],
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Strip the brain's `{ domain, action, result }` envelope when it is present. */
function unwrapBrainAccountResult(raw: unknown): unknown {
  return isRecord(raw) && isRecord(raw.result) ? raw.result : raw;
}

/**
 * Read the brain's `account.call` answer for `repairMachinePairing`.
 *
 * The RPC wraps every account action as `{ domain, action, result }`, so unwrap
 * one level when it is present. An unreadable payload THROWS rather than
 * degrading to `repaired: false`: a fabricated failure for a repair that
 * actually succeeded would send the user to re-run a fix they no longer need,
 * and `repaired: false` must keep meaning "the brain said no".
 */
export function readMachinePairingRepairResult(
  raw: unknown,
): AdeAccountMachinePairingRepairResult {
  const envelope = unwrapBrainAccountResult(raw);
  if (!isRecord(envelope) || typeof envelope.repaired !== "boolean") {
    throw new Error(
      "ADE couldn't read the result of reconnecting this computer. Check Your computers to see whether it came back.",
    );
  }
  return {
    repaired: envelope.repaired === true,
    wasRevoked: envelope.wasRevoked === true,
    published: envelope.published === true,
    pushRestored: envelope.pushRestored === true,
    state: typeof envelope.state === "string" && envelope.state.trim()
      ? envelope.state.trim()
      : "unknown",
    reason: typeof envelope.reason === "string" && envelope.reason.trim()
      ? envelope.reason.trim()
      : null,
    // Additive: brains older than this field simply omit it, and the renderer
    // treats null as "unknown" rather than as a negative answer. Unrecognised
    // codes are passed through, not filtered, so a newer brain's vocabulary is
    // visible in logs instead of vanishing at the boundary.
    reasonCode: typeof envelope.reasonCode === "string" && envelope.reasonCode.trim()
      ? envelope.reasonCode.trim()
      : null,
  };
}

function readNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read the brain's `startDeviceLogin` answer.
 *
 * Throws rather than degrading on an unreadable payload: this flow exists to
 * put a real code in front of the user, and a half-filled card that names no
 * code and opens no page is a worse dead end than the error it replaced.
 */
export function readAccountDeviceLoginStart(raw: unknown): AdeAccountDeviceLoginStart {
  const payload = unwrapBrainAccountResult(raw);
  const sessionId = isRecord(payload) ? readNonEmpty(payload.sessionId) : null;
  const userCode = isRecord(payload) ? readNonEmpty(payload.userCode) : null;
  const verificationUri = isRecord(payload) ? readNonEmpty(payload.verificationUri) : null;
  if (!isRecord(payload) || !sessionId || !userCode || !verificationUri) {
    throw new Error(
      "ADE couldn't start a sign-in on this computer. Try again in a moment.",
    );
  }
  const intervalSec = typeof payload.intervalSec === "number" && payload.intervalSec > 0
    ? payload.intervalSec
    : 5;
  return {
    sessionId,
    userCode,
    verificationUri,
    verificationUriComplete: readNonEmpty(payload.verificationUriComplete),
    expiresAt: readNonEmpty(payload.expiresAt)
      ?? new Date(Date.now() + 15 * 60_000).toISOString(),
    intervalSec,
  };
}

const DEVICE_LOGIN_POLL_STATUSES = new Set([
  "pending",
  "slow_down",
  "signed_in",
  "expired",
  "error",
]);

/**
 * Read the brain's `pollDeviceLogin` answer, keeping only the status and the
 * backoff. The account status is re-derived locally by the caller: the brain
 * persists the session to the same machine credential store this process reads,
 * and re-reading it there is what keeps `configured` and the session read state
 * consistent with every other status the renderer sees.
 */
export function readAccountDeviceLoginProgress(
  raw: unknown,
): { status: AdeAccountDeviceLoginPoll["status"]; message: string | null; intervalSec: number | null } {
  const payload = unwrapBrainAccountResult(raw);
  const status = isRecord(payload) ? readNonEmpty(payload.status) : null;
  if (!status || !DEVICE_LOGIN_POLL_STATUSES.has(status)) {
    // An unreadable poll is NOT a sign-in. Report it as an error so the caller
    // stops waiting instead of spinning against a brain that cannot answer.
    return {
      status: "error",
      message: "ADE couldn't check the sign-in on this computer. Try again in a moment.",
      intervalSec: null,
    };
  }
  return {
    status: status as AdeAccountDeviceLoginPoll["status"],
    message: isRecord(payload) ? readNonEmpty(payload.message) : null,
    intervalSec: isRecord(payload) && typeof payload.intervalSec === "number" && payload.intervalSec > 0
      ? payload.intervalSec
      : null,
  };
}

/**
 * Translate a failed brain-routed sign-in into one sentence. Same contract as
 * `describeMachinePairingRepairFailure`: the raw text stays on `cause` for the
 * logs, and no JSON-RPC string ever reaches the card.
 */
export function describeAccountDeviceLoginFailure(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message =
    /ADE_ACCOUNT_TOKEN/i.test(raw)
      ? "This computer signs in with ADE_ACCOUNT_TOKEN, so it can't sign in interactively. Reconnect it from a computer that signs in normally."
      : /econnrefused|enoent|not running|socket|connection (refused|closed|reset)|service is unavailable/i.test(raw)
        ? "ADE's background service isn't running on this computer, so it can't sign in. Reopen ADE, then try again."
        : /timed out|etimedout/i.test(raw)
          ? "Starting the sign-in timed out. Check your internet connection, then try again."
          : "ADE couldn't start a sign-in on this computer. Try again in a moment.";
  const failure = new Error(message);
  if (raw) failure.cause = error;
  return failure;
}

/** The subset of the local runtime pool this bridge needs. */
export type BrainAccountActionCaller = {
  callSync<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
};

/**
 * Build the `callBrainAccountAction` dependency from this machine's runtime
 * pool. Extracted so the method name, the params shape, and the budget are
 * covered by tests instead of living inline in the IPC registration.
 *
 * Returns undefined when there is no pool: the bridge then reports "the
 * background service isn't running" rather than throwing a null-service crash,
 * which is a standing bug class in this codebase.
 */
export function createBrainAccountActionCaller(
  pool: BrainAccountActionCaller | null | undefined,
  timeoutMs: number,
): ((action: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined {
  if (!pool) return undefined;
  return (action, args) =>
    pool.callSync<unknown>(
      "account.call",
      { action, ...(args ? { args } : {}) },
      { timeoutMs },
    );
}

/**
 * Translate a failed reconnect into one sentence the user can act on.
 *
 * Same contract as `describeAttentionOpenFailure`: the raw text is preserved as
 * `cause` for the logs, and the copy never leaks a JSON-RPC string — "method
 * account.call failed: ECONNREFUSED" reads as a broken app to the one user who
 * most needs to believe the recovery works.
 */
export function describeMachinePairingRepairFailure(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message =
    /not publishing this machine/i.test(raw)
      ? "ADE isn't publishing this computer to your account yet. Open a project on this computer, then try again."
      : /econnrefused|enoent|not running|socket|connection (refused|closed|reset)|service is unavailable/i.test(raw)
        ? "ADE's background service isn't running on this computer, so it can't reconnect to your account. Reopen ADE, then try again."
        : /timed out|etimedout/i.test(raw)
          ? "Reconnecting this computer timed out. Check your internet connection, then try again."
          : /\bnot signed in\b|\bsigned out\b|unauthenticated|unauthori[sz]|\b401\b/i.test(raw)
            ? "Sign in to ADE again, then reconnect this computer."
            : "ADE couldn't reconnect this computer to your account. Try again in a moment.";
  const failure = new Error(message);
  if (raw) failure.cause = error;
  return failure;
}

/**
 * Resolve the machine directory origin the account bearer may be sent to.
 *
 * Trust model: the bearer is the MACHINE's account token (machine-scoped
 * infrastructure), so where it is sent must be controlled by the machine owner
 * alone. A machine-level `ADE_ACCOUNT_DIRECTORY_URL` env override may select a
 * self-hosted directory; otherwise ADE maps the active project's official
 * Clerk issuer to its compiled Cloudflare Worker origin. Project configuration
 * can select an official issuer but cannot provide an arbitrary directory host.
 * The selected value is passed through `parseTrustedDirectoryBaseUrl`, so the
 * token is only ever attached to a trusted https (or loopback) origin.
 */
function resolveDirectoryBaseUrl(projectRoot: string | null): string | null {
  const machineOverride = process.env.ADE_ACCOUNT_DIRECTORY_URL;
  if (machineOverride?.trim()) {
    if (shouldIgnoreDevelopmentAccountDirectoryUrl(machineOverride, process.env)) {
      warnDevelopmentClerkIgnored();
      return resolveOfficialAccountDirectoryBaseUrl({
        env: process.env,
        projectRoots: projectRoot ? [projectRoot] : [],
      });
    }
    return parseTrustedAccountDirectoryBaseUrl(machineOverride);
  }
  return resolveOfficialAccountDirectoryBaseUrl({
    env: process.env,
    projectRoots: projectRoot ? [projectRoot] : [],
  });
}

function toAccountStatus(
  status: AccountAuthStatus,
  configured: boolean,
  sessionReadState?: AdeAccountSessionReadState,
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
    ...(sessionReadState ? { sessionReadState } : {}),
  };
}

export type AccountBridge = {
  status(): AdeAccountStatus;
  startLogin(): Promise<AccountLoginStartResult>;
  pollLogin(sessionId: string): Promise<AdeAccountLoginPoll>;
  cancelLogin(sessionId: string): void;
  /**
   * Interactive sign-in the account directory can SEE, run inside the brain.
   *
   * Both properties are load-bearing and neither is optional:
   * - the directory only mints a pairing grant on its own `/device/*` flow, and
   *   `startLogin`'s loopback PKCE goes straight to Clerk, so a re-pair after an
   *   account-side removal can never be proven through that path;
   * - the grant lives in memory in the process whose auth service earned it, and
   *   the publisher that spends it runs in the brain — so a device flow driven
   *   by THIS process would strand the grant here, where nothing can spend it.
   */
  startDeviceLogin(): Promise<AdeAccountDeviceLoginStart>;
  pollDeviceLogin(sessionId: string): Promise<AdeAccountDeviceLoginPoll>;
  cancelDeviceLogin(sessionId: string): Promise<void>;
  signOut(): AdeAccountStatus;
  listMachines(): Promise<AdeAccountMachinesResult>;
  renameMachine(machineKey: string, customName: string | null): Promise<AdeAccountMachine>;
  pairMachine(
    machineKey: string,
    options?: AccountBridgePairMachineOptions,
  ): Promise<AdeAccountMachinePairResult>;
  onPairMachineProgress(
    listener: (progress: AdeAccountPairMachineProgress) => void,
  ): () => void;
  removeMachine(machineKey: string): Promise<AdeAccountMachineRemovalResult>;
  repairMachinePairing(): Promise<AdeAccountMachinePairingRepairResult>;
};

export type AccountBridgePairMachineOptions = {
  onProgress?: (progress: AdeAccountPairMachineProgress) => void;
};

export function createAccountBridge(options: AccountBridgeOptions): AccountBridge {
  const secretsDir = resolveMachineAdeLayout().secretsDir;
  const pairMachineProgressListeners = new Set<
    (progress: AdeAccountPairMachineProgress) => void
  >();
  const accountMachineNames = new Map<string, string>();

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
  // Machine-scoped, deliberately not the project logger. Dropping a paired
  // secret is a machine-level credential mutation, and the project logger
  // follows the active project — which, on a remote-bound project, ships these
  // records to the other machine and leaves nothing behind on the machine that
  // actually lost its trust. Resolved lazily and defensively: a log sink is
  // never worth failing account auth over.
  let machineLogger: Logger | null | undefined;
  const getMachineLogger = (): Logger | null => {
    if (machineLogger !== undefined) return machineLogger;
    try {
      const { runtimeDir } = resolveMachineAdeLayout();
      machineLogger = runtimeDir
        ? createFileLogger(path.join(runtimeDir, "account-trust.jsonl"))
        : null;
    } catch {
      machineLogger = null;
    }
    return machineLogger;
  };

  const reconcileLocalMachines = (currentOwnerUserId: string | null): void => {
    const result = options.reconcileAccountOwnership?.(currentOwnerUserId);
    if (
      result
      && (result.removedTargetIds.length > 0
        || result.removedCredentialHostIds.length > 0)
    ) {
      const counts = {
        targetCount: result.removedTargetIds.length,
        credentialCount: result.removedCredentialHostIds.length,
      };
      // Warn, not info: each removed credential costs the user a manual
      // re-pair of that machine, so this is never routine.
      //
      // Account and host identifiers go ONLY to the machine-local sink. The
      // project logger is the reason this split exists — on a remote-bound
      // project it ships records to the other machine, so putting owner ids in
      // it would re-introduce exactly the cross-machine identifier exposure the
      // split was added to prevent. It gets counts, nothing more.
      getMachineLogger()?.warn("account.local_machines_removed", {
        ...counts,
        currentOwnerUserId: result.currentOwnerUserId,
        removed: result.removedCredentials.map((credentials) => ({
          hostDeviceId: credentials.hostDeviceId,
          hostName: credentials.hostName,
          previousOwnerUserId: credentials.previousOwnerUserId,
        })),
      });
      // Dropping a paired secret is the forensic record for "why did my
      // pairing vanish". The file logger batches on a 500 ms timer, so a quit
      // that follows the prune closely would lose exactly that line.
      getMachineLogger()?.flushSync?.();
      options.logger?.info("account.local_machines_removed", counts);
    }
  };

  return {
    status: () => {
      const accountService = service();
      // Read the state alongside the status: `signedIn: false` with an
      // "unreadable" session is a failed decrypt, not a sign-out, and the
      // renderer must be able to tell them apart.
      const status = accountService.getStatus();
      // Optional call: a runtime that predates the split simply reports no read
      // state, and the renderer then falls back to its previous behaviour.
      const readState = accountService.getSessionReadState?.();
      return toAccountStatus(status, configured(), readState);
    },

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

    startDeviceLogin: async (): Promise<AdeAccountDeviceLoginStart> => {
      if (!options.callBrainAccountAction) {
        throw new Error(
          "ADE's background service isn't running on this computer, so it can't sign in. Reopen ADE, then try again.",
        );
      }
      const root = options.getProjectRoot();
      if (root) registerAccountConfigProjectRoot(root, secretsDir, { prioritize: true });
      try {
        return readAccountDeviceLoginStart(
          // The brain resolves this project's CLERK_* secrets from the same
          // root, exactly as `ade login` does.
          await options.callBrainAccountAction(
            "startDeviceLogin",
            root ? { projectRoot: root } : {},
          ),
        );
      } catch (error) {
        options.logger?.warn("account.device_login_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw describeAccountDeviceLoginFailure(error);
      }
    },

    pollDeviceLogin: async (sessionId: string): Promise<AdeAccountDeviceLoginPoll> => {
      if (!options.callBrainAccountAction) {
        throw new Error(
          "ADE's background service isn't running on this computer, so it can't sign in. Reopen ADE, then try again.",
        );
      }
      const progress = readAccountDeviceLoginProgress(
        await options.callBrainAccountAction("pollDeviceLogin", { sessionId }),
      );
      // Re-read the machine credential store the brain just wrote rather than
      // trusting the RPC's status record, so the renderer gets the same shape
      // (`configured`, session read state) every other status call produces.
      const authStatus = toAccountStatus(
        service().getStatus(),
        configured(),
        service().getSessionReadState?.(),
      );
      if (progress.status === "signed_in") {
        reconcileLocalMachines(authStatus.signedIn ? authStatus.userId : null);
      }
      return { ...progress, authStatus };
    },

    cancelDeviceLogin: async (sessionId: string): Promise<void> => {
      // Routed to the brain's `cancelLogin`, which cancels BOTH the loopback
      // and the device sign-in session maps — there is no `cancelDeviceLogin`
      // action to grep for on that side.
      //
      // Best-effort: the device session expires on its own, and a failed
      // cancel must never surface as a sign-in error the user has to read.
      await options.callBrainAccountAction?.("cancelLogin", { sessionId })
        .catch(() => undefined);
    },

    signOut: () => {
      const accountService = service();
      const status = accountService.signOut();
      accountMachineNames.clear();
      reconcileLocalMachines(null);
      return toAccountStatus(status, configured());
    },

    listMachines: async (): Promise<AdeAccountMachinesResult> => {
      const result = await directoryService().listMachines();
      if (result.state === "ok") {
        accountMachineNames.clear();
        for (const machine of result.machines) {
          const name = accountMachineDisplayName(machine) || machine.machineKey;
          accountMachineNames.set(machine.machineKey, name);
          if (machine.deviceId?.trim()) {
            accountMachineNames.set(machine.deviceId.trim(), name);
          }
          if (machine.name?.trim()) {
            accountMachineNames.set(machine.name.trim().toLowerCase(), name);
          }
          if (machine.customName?.trim()) {
            accountMachineNames.set(machine.customName.trim().toLowerCase(), name);
          }
        }
      }
      if (result.state === "auth_expired") {
        accountMachineNames.clear();
        reconcileLocalMachines(null);
      }
      if (result.state === "unavailable") {
        options.logger?.warn("account.machines_fetch_failed", { state: result.state });
      }
      return result;
    },

    pairMachine: async (
      machineKey: string,
      pairOptions: AccountBridgePairMachineOptions = {},
    ): Promise<AdeAccountMachinePairResult> => {
      const emitProgress = (progress: AdeAccountPairMachineProgress): void => {
        try {
          pairOptions.onProgress?.(progress);
        } catch {
          // Progress reporting is best-effort and must not abort adoption.
        }
        for (const listener of pairMachineProgressListeners) {
          try {
            listener(progress);
          } catch {
            // One window listener must not prevent the pair attempt or other listeners.
          }
        }
      };
      const result = await directoryService().pairMachine(machineKey, {
        onStage: ({ kind, phase }) => {
          const machineName = accountMachineNames.get(machineKey)
            ?? accountMachineNames.get(machineKey.trim().toLowerCase())
            ?? machineKey;
          if (phase === "verifying") {
            emitProgress({
              machineKey,
              stage: "verifying",
              label: `Verifying it's really ${machineName}…`,
            });
            return;
          }
          emitProgress({
            machineKey,
            stage: kind,
            label: kind === "relay"
              ? "Connecting through ADE relay…"
              : kind === "tailnet"
                ? "Trying Tailscale…"
                : "Trying local network…",
          });
        },
      });
      emitProgress({
        machineKey,
        stage: "opening",
        label: "Opening connection…",
      });
      return result;
    },

    onPairMachineProgress: (listener) => {
      pairMachineProgressListeners.add(listener);
      return () => pairMachineProgressListeners.delete(listener);
    },

    renameMachine: async (
      machineKey: string,
      customName: string | null,
    ): Promise<AdeAccountMachine> => {
      return await directoryService().renameMachine(machineKey, customName);
    },

    removeMachine: async (machineKey: string): Promise<AdeAccountMachineRemovalResult> => {
      // Directory removal first: it is the authoritative membership change, and
      // a purge that landed against a machine still on the roster would just be
      // refilled by its next publish.
      const result = await directoryService().deleteMachine(machineKey);
      try {
        await options.purgeMachineActivity?.(machineKey);
      } catch (error) {
        options.logger?.warn("account.machine_activity_purge_failed", {
          machineKey,
          error: error instanceof Error ? error.message : String(error),
        });
        // Surfaced, not swallowed: the machine is off the account but its work
        // is still in Activity, and only the user can decide to retry. The
        // purge is idempotent, so retrying removal is safe.
        throw new Error(
          "The machine was removed from your ADE account, but its Activity could not be cleared. "
          + "Try removing it again to finish clearing it.",
        );
      }
      return result;
    },

    /**
     * The ONLY product path back from an account-side removal. Everything else
     * a user would try — restarting, signing out and back in, reinstalling —
     * leaves both latches set, because heartbeats always publish
     * `pairing: false` and sign-in reuses the same stable device id.
     */
    repairMachinePairing: async (): Promise<AdeAccountMachinePairingRepairResult> => {
      if (!options.callBrainAccountAction) {
        throw new Error(
          "ADE's background service isn't running on this computer, so it can't reconnect to your account. Reopen ADE, then try again.",
        );
      }
      let raw: unknown;
      try {
        raw = await options.callBrainAccountAction("repairMachinePairing");
      } catch (error) {
        options.logger?.warn("account.machine_pairing_repair_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw describeMachinePairingRepairFailure(error);
      }
      const result = readMachinePairingRepairResult(raw);
      options.logger?.info("account.machine_pairing_repair", {
        repaired: result.repaired,
        wasRevoked: result.wasRevoked,
        published: result.published,
        pushRestored: result.pushRestored,
        state: result.state,
      });
      return result;
    },
  };
}
