import os from "node:os";
import { RemoteTargetRegistry } from "../../../../desktop/src/main/services/remoteRuntime/remoteTargetRegistry";
import {
  DesktopPairedMachineStore,
  type PairWithAccountMachineOptions,
} from "../../../../desktop/src/main/services/remoteRuntime/syncPairedMachineStore";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import type { DesktopPairedMachineCredentials } from "../../../../desktop/src/shared/types/pairedRuntime";
import type {
  AdeAccountMachine,
  AdeAccountMachinePairResult,
  AdeAccountMachineRemovalResult,
  AdeAccountMachinesResult,
} from "../../../../desktop/src/shared/types/account";
import {
  accountMachineDisplayName,
  accountMachineSecureSyncEndpoints,
  createAccountDirectoryCorrelationId,
  fetchAccountMachines,
  parseAccountMachine,
  readBoundedAccountDirectoryJson,
  resolveTrustedAccountDirectoryBaseUrl,
  selectAccountMachine,
  shouldIgnoreDevelopmentAccountDirectoryUrl,
  warnDevelopmentClerkIgnored,
} from "../../../../desktop/src/shared/accountDirectory";
import type {
  AccountAuthService,
  AccountSessionReadState,
  AccountSessionState,
} from "./accountAuthService";
import { defaultRelayUrl } from "../sync/syncCloudRelayStore";

type AccountMachinePairer = {
  pairWithAccountMachine(
    machine: AdeAccountMachine,
    accountToken: string,
    deviceName: string,
    options?: PairWithAccountMachineOptions,
  ): Promise<Pick<
    DesktopPairedMachineCredentials,
    "hostIdentity" | "endpoints"
  > & Partial<Pick<DesktopPairedMachineCredentials, "accountOwnerUserId">>>;
  get?(hostDeviceIdOrMachineKey: string): DesktopPairedMachineCredentials | null;
  save?(credentials: DesktopPairedMachineCredentials): DesktopPairedMachineCredentials;
  remove?(hostDeviceIdOrMachineKey: string): boolean;
};

type AccountMachineCredentialPruner = Pick<
  DesktopPairedMachineStore,
  "pruneAccountOwned"
>;

type AccountMachineTargetPruner = Pick<
  RemoteTargetRegistry,
  "pruneAccountOwned" | "list" | "remove"
>;

export type AccountMachineTrustReconciliationResult = {
  removedTargetIds: string[];
  removedCredentialHostIds: string[];
};

/**
 * Remove client-side machine trust that belongs to a different signed-in ADE
 * account. Sign-out keeps host-issued paired secrets for LAN/Tailscale while
 * Relay and directory access remain disabled. Ownerless PIN/address/SSH
 * credentials are deliberately kept.
 * Any target left pointing at a removed credential is unusable and is removed
 * in the same pass so a partial historical write cannot leak its machine name.
 */
export function reconcileAccountOwnedMachineTrust(
  currentOwnerUserIdValue: string | null,
  options: {
    pairedStore?: AccountMachineCredentialPruner;
    targetRegistry?: AccountMachineTargetPruner;
  } = {},
): AccountMachineTrustReconciliationResult {
  const currentOwnerUserId = currentOwnerUserIdValue?.trim() || null;
  const pairedStore = options.pairedStore ?? new DesktopPairedMachineStore();
  const targetRegistry = options.targetRegistry ?? new RemoteTargetRegistry();
  const removedCredentials = currentOwnerUserId
    ? pairedStore.pruneAccountOwned(currentOwnerUserId)
    : [];
  const removedCredentialIds = new Set<string>();
  for (const credentials of removedCredentials) {
    removedCredentialIds.add(credentials.hostIdentity.deviceId);
    if (credentials.machineKey) removedCredentialIds.add(credentials.machineKey);
  }

  const removedTargetIds = new Set(
    currentOwnerUserId
      ? targetRegistry.pruneAccountOwned(currentOwnerUserId).map((target) => target.id)
      : [],
  );
  for (const target of targetRegistry.list()) {
    const reference = target.pairedMachine;
    if (
      !reference
      || (!removedCredentialIds.has(reference.hostIdentity)
        && !(reference.machineKey && removedCredentialIds.has(reference.machineKey)))
    ) continue;
    if (targetRegistry.remove(target.id)) removedTargetIds.add(target.id);
  }

  return {
    removedTargetIds: [...removedTargetIds],
    removedCredentialHostIds: removedCredentials.map(
      (credentials) => credentials.hostIdentity.deviceId,
    ),
  };
}

export type AccountMachinePairOptions = Pick<
  PairWithAccountMachineOptions,
  "connectTimeoutMs" | "pairingTimeoutMs" | "signal" | "onStage"
>;

export type AccountMachineListOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type AccountMachineDeleteOptions = AccountMachineListOptions;
export type AccountMachineRenameOptions = AccountMachineListOptions;

/**
 * The machine left the account roster, but the push relay could not clear the
 * Activity it published. Callers must not report a clean removal: the user is
 * about to open Activity and see that machine's agents still there.
 */
export class AccountMachineActivityPurgeError extends Error {
  readonly code = "activity_purge_failed" as const;
  /** The directory row is gone and the machine can no longer re-register. */
  readonly machineRemoved = true;

  constructor(readonly machineKey: string, readonly detail: string | null) {
    super(
      "This machine was removed from your ADE account, but its Activity couldn't be cleared. Its agents may keep showing in Activity — try removing it again.",
    );
    this.name = "AccountMachineActivityPurgeError";
  }
}

/**
 * Read a directory failure body without letting a malformed or oversized
 * response mask the removal outcome; anything unreadable falls back to the
 * generic status error.
 */
async function readActivityPurgeFailure(
  response: Response,
): Promise<{ detail: string | null } | null> {
  try {
    const body = await readBoundedAccountDirectoryJson(response);
    if (!body || typeof body !== "object") return null;
    const record = body as Record<string, unknown>;
    if (record.code !== "activity_purge_failed") return null;
    return {
      detail: typeof record.detail === "string" && record.detail.trim()
        ? record.detail.trim()
        : null,
    };
  } catch {
    return null;
  }
}

function packagedSafeAccountDirectoryOverride(
  rawUrl: string | null | undefined,
): string | undefined {
  if (shouldIgnoreDevelopmentAccountDirectoryUrl(rawUrl, process.env)) {
    warnDevelopmentClerkIgnored();
    return undefined;
  }
  return rawUrl ?? undefined;
}

/**
 * "Signed out", "the saved sign-in expired", and "this machine's stored session
 * could not be READ" look identical to `getStatus()` — all three report
 * `signedIn: false` — but they need different words. Signing out is something
 * the user did; an expired session is one the identity provider rejected; an
 * unreadable session is a local decrypt/credential-store failure that has
 * changed nothing about the account, and telling the user to sign in makes
 * them destroy a session that is still perfectly valid. Only the first two
 * tell them to sign in.
 */
function notSignedInMessage(
  readState: AccountSessionReadState | undefined,
  action: "remove a machine from your ADE account" | "rename a machine",
  sessionState?: AccountSessionState,
): string {
  if (readState === "unreadable" || sessionState === "unreadable") {
    return `ADE couldn't read this computer's saved sign-in, so nothing was changed. Wait a moment and try again to ${action}; if it keeps failing, sign in again on this computer.`;
  }
  if (sessionState === "expired") {
    return `Your ADE account sign-in expired — sign in again to ${action}.`;
  }
  return `Not signed in — sign in to ${action}.`;
}

export class AccountMachineDirectoryService {
  constructor(
    private readonly account: Pick<AccountAuthService, "getStatus" | "getAccessToken">
      & Partial<Pick<AccountAuthService, "getSessionReadState" | "getSessionState">>,
    private readonly options: {
      directoryBaseUrl?: () => string | null;
      pairedStore?: AccountMachinePairer;
      targetRegistry?: Pick<RemoteTargetRegistry, "save">;
      deviceName?: () => string;
      appVersion?: string;
      fetchImpl?: typeof fetch;
      relayBaseUrls?: readonly string[];
    } = {},
  ) {}

  async listMachines(options: AccountMachineListOptions = {}): Promise<AdeAccountMachinesResult> {
    const status = this.account.getStatus();
    if (!status.signedIn && status.source !== "env-token") {
      // An unreadable stored session is a local failure, not a sign-out. Report
      // it as unavailable so the surface says "couldn't load" instead of
      // inviting the user to sign in over a session that is still valid.
      const sessionState = status.sessionState ?? this.account.getSessionState?.();
      if (this.account.getSessionReadState?.() === "unreadable" || sessionState === "unreadable") {
        return {
          state: "unavailable",
          machines: [],
          message: "ADE couldn't read this computer's saved sign-in. Try again in a moment.",
        };
      }
      // A provider-rejected session is a real sign-out, but the user should be
      // told it expired rather than that they were never signed in.
      if (sessionState === "expired") {
        return {
          state: "auth_expired",
          machines: [],
          message: "Your ADE account session expired. Run `ade login` again.",
        };
      }
      return { state: "signed_out", machines: [], message: null };
    }
    let token: string;
    try {
      token = await this.account.getAccessToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return /not signed in|session expired/i.test(message)
        ? { state: "auth_expired", machines: [], message: "Your ADE account session expired. Run `ade login` again." }
        : { state: "unavailable", machines: [], message };
    }
    return await fetchAccountMachines({
      baseUrl: resolveTrustedAccountDirectoryBaseUrl(
        packagedSafeAccountDirectoryOverride(
          this.options.directoryBaseUrl?.() ?? process.env.ADE_ACCOUNT_DIRECTORY_URL,
        ),
      ),
      accessToken: token,
      refreshAccessToken: () => this.account.getAccessToken({ forceRefresh: true }),
      fetchImpl: this.options.fetchImpl,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  async deleteMachine(
    machineKeyValue: string,
    options: AccountMachineDeleteOptions = {},
  ): Promise<AdeAccountMachineRemovalResult> {
    const machineKey = machineKeyValue.trim();
    if (!machineKey) throw new Error("Machine key is required.");

    const status = this.account.getStatus();
    if (!status.signedIn && status.source !== "env-token") {
      throw new Error(notSignedInMessage(
        this.account.getSessionReadState?.(),
        "remove a machine from your ADE account",
        status.sessionState ?? this.account.getSessionState?.(),
      ));
    }
    let token: string;
    try {
      token = (await this.account.getAccessToken()).trim();
    } catch {
      throw new Error("Your ADE account session expired. Sign in again.");
    }
    if (!token) throw new Error("Your ADE account session expired. Sign in again.");

    const baseUrl = resolveTrustedAccountDirectoryBaseUrl(
      packagedSafeAccountDirectoryOverride(
        this.options.directoryBaseUrl?.() ?? process.env.ADE_ACCOUNT_DIRECTORY_URL,
      ),
    );
    if (!baseUrl) {
      throw new Error(
        "Machine directory isn't configured — set a trusted https directory URL on this machine.",
      );
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = Math.max(250, Math.floor(options.timeoutMs ?? 8_000));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const correlationId = createAccountDirectoryCorrelationId();
    try {
      const sendDelete = (accessToken: string): Promise<Response> =>
        (this.options.fetchImpl ?? fetch)(
          `${baseUrl}/account/machines/${encodeURIComponent(machineKey)}`,
          {
            method: "DELETE",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${accessToken}`,
              "x-ade-correlation-id": correlationId,
            },
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          },
        );
      let response = await sendDelete(token);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        let refreshedToken: string | null = null;
        try {
          refreshedToken = (await this.account.getAccessToken({ forceRefresh: true })).trim() || null;
        } catch {
          // Preserve the original auth-expired classification below.
        }
        if (refreshedToken) response = await sendDelete(refreshedToken);
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error("Your ADE account session expired. Sign in again.");
      }
      if (!response.ok) {
        // A partial removal (roster row gone, Activity left behind) has to read
        // as a failure, or the UI reports success over a feed that still shows
        // the machine's agents.
        const purgeFailure = await readActivityPurgeFailure(response);
        if (purgeFailure) {
          throw new AccountMachineActivityPurgeError(machineKey, purgeFailure.detail);
        }
        throw new Error(`Machine directory returned ${response.status}.`);
      }
      return { ok: true, machineKey };
    } catch (error) {
      if (error instanceof AccountMachineActivityPurgeError) throw error;
      if (error instanceof Error && /account session expired|directory returned/i.test(error.message)) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw new Error("Machine removal was cancelled.");
      }
      throw new Error(timedOut ? "Machine directory timed out." : "Couldn't reach the machine directory.");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async renameMachine(
    machineKeyValue: string,
    customNameValue: string | null,
    options: AccountMachineRenameOptions = {},
  ): Promise<AdeAccountMachine> {
    const machineKey = machineKeyValue.trim();
    if (!machineKey) throw new Error("Machine key is required.");
    const customName = customNameValue?.trim() || null;
    if (customName && customName.length > 80) {
      throw new Error("Machine name must be 80 characters or fewer.");
    }

    const status = this.account.getStatus();
    if (!status.signedIn && status.source !== "env-token") {
      throw new Error(notSignedInMessage(
        this.account.getSessionReadState?.(),
        "rename a machine",
        status.sessionState ?? this.account.getSessionState?.(),
      ));
    }
    let token: string;
    try {
      token = (await this.account.getAccessToken()).trim();
    } catch {
      throw new Error("Your ADE account session expired. Sign in again.");
    }
    if (!token) throw new Error("Your ADE account session expired. Sign in again.");

    const baseUrl = resolveTrustedAccountDirectoryBaseUrl(
      packagedSafeAccountDirectoryOverride(
        this.options.directoryBaseUrl?.() ?? process.env.ADE_ACCOUNT_DIRECTORY_URL,
      ),
    );
    if (!baseUrl) {
      throw new Error(
        "Machine directory isn't configured — set a trusted https directory URL on this machine.",
      );
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = Math.max(250, Math.floor(options.timeoutMs ?? 8_000));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const correlationId = createAccountDirectoryCorrelationId();
    try {
      const sendRename = (accessToken: string): Promise<Response> =>
        (this.options.fetchImpl ?? fetch)(
          `${baseUrl}/account/machines/${encodeURIComponent(machineKey)}`,
          {
            method: "PATCH",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
              "x-ade-correlation-id": correlationId,
            },
            body: JSON.stringify({ customName }),
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          },
        );
      let response = await sendRename(token);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        let refreshedToken: string | null = null;
        try {
          refreshedToken = (await this.account.getAccessToken({ forceRefresh: true })).trim() || null;
        } catch {
          // Preserve the original auth-expired classification below.
        }
        if (refreshedToken) response = await sendRename(refreshedToken);
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error("Your ADE account session expired. Sign in again.");
      }
      if (!response.ok) {
        throw new Error(`Machine directory returned ${response.status}.`);
      }
      const machine = parseAccountMachine(
        await readBoundedAccountDirectoryJson(response),
      );
      if (!machine) throw new Error("Machine directory returned unreadable data.");
      return machine;
    } catch (error) {
      if (error instanceof Error && /account session expired|directory returned/i.test(error.message)) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw new Error("Machine rename was cancelled.");
      }
      throw new Error(timedOut ? "Machine directory timed out." : "Couldn't reach the machine directory.");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async pairMachine(
    query: string,
    options: AccountMachinePairOptions = {},
  ): Promise<AdeAccountMachinePairResult> {
    const listed = await this.listMachines(options);
    if (listed.state === "signed_out" || listed.state === "auth_expired") {
      throw new Error("Not signed in — run `ade login`; local and explicit remote paths still work without an account.");
    }
    if (listed.state !== "ok") {
      throw new Error(listed.message ?? "The account machine directory is unavailable.");
    }
    const machine = selectAccountMachine(listed.machines, query);
    return await this.pairListedMachine(machine, options);
  }

  async pairListedMachine(
    machine: AdeAccountMachine,
    options: AccountMachinePairOptions = {},
  ): Promise<AdeAccountMachinePairResult> {
    const relayBaseUrls = this.options.relayBaseUrls ?? [defaultRelayUrl()];
    const hasVerifiedRelayRoute = accountMachineSecureSyncEndpoints(
      machine,
      relayBaseUrls,
    ).length > 0;
    if (!machine.online && !hasVerifiedRelayRoute) {
      throw new Error(`${machine.name ?? machine.machineKey} is offline and cannot be connected.`);
    }
    const hostDeviceId = machine.deviceId?.trim();
    if (!hostDeviceId) throw new Error(`${machine.name ?? machine.machineKey} is missing a stable device id.`);

    const initialStatus = this.account.getStatus();
    const accountOwnerUserId = initialStatus.signedIn
      ? initialStatus.userId?.trim() ?? ""
      : "";
    if (!accountOwnerUserId) {
      throw new Error("Your ADE account identity is unavailable. Sign in again.");
    }
    const token = (await this.account.getAccessToken()).trim();
    const refreshedStatus = this.account.getStatus();
    if (
      !token
      || !refreshedStatus.signedIn
      || refreshedStatus.userId?.trim() !== accountOwnerUserId
    ) {
      throw new Error("Your ADE account changed before the connection started. Try again.");
    }
    const authorizeAccountCommit = async (expectedOwnerUserId: string): Promise<boolean> => {
      const before = this.account.getStatus();
      if (!before.signedIn || before.userId?.trim() !== expectedOwnerUserId) return false;
      try {
        const currentToken = (await this.account.getAccessToken()).trim();
        const after = this.account.getStatus();
        return Boolean(
          currentToken
          && currentToken === token
          && after.signedIn
          && after.userId?.trim() === expectedOwnerUserId,
        );
      } catch {
        return false;
      }
    };
    const pairedStore = this.options.pairedStore ?? new DesktopPairedMachineStore();
    const priorCredentials = pairedStore.get?.(hostDeviceId)
      ?? pairedStore.get?.(machine.machineKey)
      ?? null;
    const credentials = await pairedStore.pairWithAccountMachine(
      machine,
      token,
      this.options.deviceName?.() ?? `ADE Code on ${os.hostname()}`,
      {
        ...options,
        appVersion: this.options.appVersion,
        relayBaseUrls,
        accountOwnerUserId,
        authorizeAccountCommit,
      },
    );
    if (!await authorizeAccountCommit(accountOwnerUserId)) {
      this.reconcileStaleAccountCommit({
        pairedStore,
        credentials,
        priorCredentials,
        expectedOwnerUserId: accountOwnerUserId,
      });
      throw new Error("Your ADE account changed before this machine could be saved. Try again.");
    }
    const firstEndpoint = credentials.endpoints[0];
    const displayName = accountMachineDisplayName(machine);
    const fallbackHostname = (() => {
      if (!firstEndpoint) return machine.name ?? machine.machineKey;
      try {
        return new URL(firstEndpoint).hostname;
      } catch {
        return machine.name ?? machine.machineKey;
      }
    })();
    const target: RemoteRuntimeTarget = (this.options.targetRegistry ?? new RemoteTargetRegistry()).save({
      name: displayName ?? credentials.hostIdentity.name,
      hostname: fallbackHostname,
      transport: "paired",
      pairedMachine: {
        hostIdentity: credentials.hostIdentity.deviceId,
        machineKey: machine.machineKey,
      },
      accountOwnerUserId,
      sshUser: null,
      port: null,
      sshKeyPath: null,
      // Account-created targets always use the paired runtime bridge. Do not
      // synthesize an SSH fallback from account-directory endpoint data.
      routes: [],
    });
    return {
      targetId: target.id,
      machineKey: machine.machineKey,
      deviceId: hostDeviceId,
      name: displayName ?? credentials.hostIdentity.name,
    };
  }

  private reconcileStaleAccountCommit(args: {
    pairedStore: AccountMachinePairer;
    credentials: Pick<DesktopPairedMachineCredentials, "hostIdentity" | "endpoints">
      & Partial<Pick<DesktopPairedMachineCredentials, "accountOwnerUserId">>;
    priorCredentials: DesktopPairedMachineCredentials | null;
    expectedOwnerUserId: string;
  }): void {
    if (args.credentials.accountOwnerUserId !== args.expectedOwnerUserId) return;
    const current = args.pairedStore.get?.(args.credentials.hostIdentity.deviceId);
    if (!current || current.accountOwnerUserId !== args.expectedOwnerUserId) return;

    const currentStatus = this.account.getStatus();
    const activeOwnerUserId = currentStatus.signedIn
      ? currentStatus.userId?.trim() ?? null
      : null;
    const prior = args.priorCredentials;
    if (
      prior
      && (prior.accountOwnerUserId == null || prior.accountOwnerUserId === activeOwnerUserId)
      && args.pairedStore.save
    ) {
      args.pairedStore.save(prior);
      return;
    }
    args.pairedStore.remove?.(args.credentials.hostIdentity.deviceId);
  }
}
