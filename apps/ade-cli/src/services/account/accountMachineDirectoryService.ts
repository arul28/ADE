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
  AdeAccountMachinesResult,
} from "../../../../desktop/src/shared/types/account";
import {
  fetchAccountMachines,
  resolveTrustedAccountDirectoryBaseUrl,
  selectAccountMachine,
} from "../../../../desktop/src/shared/accountDirectory";
import type { AccountAuthService } from "./accountAuthService";
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
 * Remove client-side machine trust that belongs to a different (or signed-out)
 * ADE account. Ownerless PIN/address/SSH credentials are deliberately kept.
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
  const removedCredentials = pairedStore.pruneAccountOwned(currentOwnerUserId);
  const removedCredentialIds = new Set<string>();
  for (const credentials of removedCredentials) {
    removedCredentialIds.add(credentials.hostIdentity.deviceId);
    if (credentials.machineKey) removedCredentialIds.add(credentials.machineKey);
  }

  const removedTargetIds = new Set(
    targetRegistry.pruneAccountOwned(currentOwnerUserId).map((target) => target.id),
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
  "connectTimeoutMs" | "pairingTimeoutMs" | "signal"
>;

export type AccountMachineListOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export class AccountMachineDirectoryService {
  constructor(
    private readonly account: Pick<AccountAuthService, "getStatus" | "getAccessToken">,
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
        this.options.directoryBaseUrl?.()
          ?? process.env.ADE_ACCOUNT_DIRECTORY_URL,
      ),
      accessToken: token,
      fetchImpl: this.options.fetchImpl,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
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
    if (!machine.online) throw new Error(`${machine.name ?? machine.machineKey} is offline and cannot be connected.`);
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
        relayBaseUrls: this.options.relayBaseUrls ?? [defaultRelayUrl()],
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
    const fallbackHostname = (() => {
      if (!firstEndpoint) return machine.name ?? machine.machineKey;
      try {
        return new URL(firstEndpoint).hostname;
      } catch {
        return machine.name ?? machine.machineKey;
      }
    })();
    const target: RemoteRuntimeTarget = (this.options.targetRegistry ?? new RemoteTargetRegistry()).save({
      name: machine.name ?? credentials.hostIdentity.name,
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
      name: machine.name ?? credentials.hostIdentity.name,
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
