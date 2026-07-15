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
  AdeAccountMachinesResult,
} from "../../../../desktop/src/shared/types/account";
import {
  fetchAccountMachines,
  resolveTrustedAccountDirectoryBaseUrl,
  selectAccountMachine,
} from "../../../../desktop/src/shared/accountDirectory";
import type { AccountAuthService } from "./accountAuthService";
import { defaultRelayUrl } from "../sync/syncCloudRelayStore";

export type AccountMachinePairResult = {
  targetId: string;
  machineKey: string;
  deviceId: string;
  name: string;
};

type AccountMachinePairer = {
  pairWithAccountMachine(
    machine: AdeAccountMachine,
    accountToken: string,
    deviceName: string,
    options?: PairWithAccountMachineOptions,
  ): Promise<Pick<DesktopPairedMachineCredentials, "hostIdentity" | "endpoints">>;
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

  async listMachines(): Promise<AdeAccountMachinesResult> {
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
        : { state: "unavailable", machines: [], message: "Couldn't read the shared ADE account session." };
    }
    return await fetchAccountMachines({
      baseUrl: resolveTrustedAccountDirectoryBaseUrl(
        this.options.directoryBaseUrl?.()
          ?? process.env.ADE_ACCOUNT_DIRECTORY_URL,
      ),
      accessToken: token,
      fetchImpl: this.options.fetchImpl,
    });
  }

  async pairMachine(query: string): Promise<AccountMachinePairResult> {
    const listed = await this.listMachines();
    if (listed.state === "signed_out" || listed.state === "auth_expired") {
      throw new Error("Not signed in — run `ade login`; local and explicit remote paths still work without an account.");
    }
    if (listed.state !== "ok") {
      throw new Error(listed.message ?? "The account machine directory is unavailable.");
    }
    const machine = selectAccountMachine(listed.machines, query);
    if (!machine.online) throw new Error(`${machine.name ?? machine.machineKey} is offline and cannot be connected.`);
    const hostDeviceId = machine.deviceId?.trim();
    if (!hostDeviceId) throw new Error(`${machine.name ?? machine.machineKey} is missing a stable device id.`);

    const token = await this.account.getAccessToken();
    const pairedStore = this.options.pairedStore ?? new DesktopPairedMachineStore();
    const credentials = await pairedStore.pairWithAccountMachine(
      machine,
      token,
      this.options.deviceName?.() ?? `ADE Code on ${os.hostname()}`,
      {
        appVersion: this.options.appVersion,
        relayBaseUrls: this.options.relayBaseUrls ?? [defaultRelayUrl()],
      },
    );
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
}
