import type {
  AdeActionRegistryEntry,
  CloneProjectInput,
  CreateProjectInput,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  ProjectBrowseInput,
  ProjectBrowseResult,
  ProjectDetail,
  RemoteRuntimeProjectWorkSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionState,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeConnectErrorInfo,
  RemoteRuntimeConnectResult,
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeDoctorResult,
  RemoteRuntimePairWithMachineArgs,
  RemoteRuntimePairWithMachineResult,
  RemoteRuntimeBufferedEvent,
  RemoteRuntimePortForward,
  RemoteRuntimePortForwardRequest,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeHandoffStoragePreflightArgs,
  RemoteRuntimeHandoffStoragePreflightResult,
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
  RemoteRuntimeSshHostKeyTrustStatus,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTrustSshHostKeyResult,
} from "../../../shared/types";
import type { DesktopPairedMachineCredentials } from "../../../shared/types/pairedRuntime";
import {
  capRemoteRuntimeErrorDetail,
  RemoteRuntimeConnectError,
} from "../../../shared/types";
import { coerceProjects } from "./remoteBootstrap";
import {
  isRemoteRuntimeConnectionError,
  type RemoteConnectionPool,
} from "./remoteConnectionPool";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";
import { DesktopPairedMachineStore } from "./syncPairedMachineStore";
import { parseRemoteRuntimePairingInput } from "./pairingInput";
import { classifyPairedRuntimeEndpoint } from "./pairedRuntimeRoutes";
import {
  findDiscoveredRuntimeForTargetInput,
  sshRoutesForDiscoveredRuntime,
  sshRoutesForPairedEndpoints,
  syncEndpointsForDiscoveredRuntime,
} from "./discoveredPairedRuntime";
import { runRemoteRuntimeDoctor } from "./connectionDoctor";
import {
  PairedRuntimeRelayAuthRequiredError,
  PairedRuntimeSshTrustRequiredError,
  PairedRuntimeTransportUnavailableError,
} from "./pairedRuntimeErrors";
import {
  getSshHostKeyTrustForTarget,
  trustSshHostKeyForTarget,
} from "./sshTransport";
import { decodeRemoteRuntimeHandoffStoragePreflightResult } from "../../../shared/crossMachineHandoff";

type StatusPatch = Partial<Omit<RemoteRuntimeConnectionStatus, "target">>;

type RemoteConnectionServiceOptions = {
  autoconnectIntervalMs?: number;
  pingTimeoutMs?: number;
  appVersion?: string;
  getAccountRelayProof?: () => Promise<{
    userId: string;
    token: string;
  } | null>;
  /**
   * Returns the refresh-verified account owner allowed to use account-created
   * Relay trust. `null` disables directory/Relay access while preserving
   * host-issued LAN/Tailscale paired trust. Omit only in isolated callers that
   * do not participate in account lifecycle.
   */
  getAuthorizedAccountOwnerId?: () => Promise<string | null>;
};

export type AccountMachineReconciliationResult = {
  removedTargetIds: string[];
  removedCredentialHostIds: string[];
};

type RemoteConnectionDisconnectOptions = {
  manual?: boolean;
};

type RemoteConnectionConnectOptions = {
  explicit?: boolean;
};

const AUTOMATIC_RECONNECT_FAILURE_LIMIT = 10;
const MAX_LAST_ERROR_CHARS = 500;
const DISCOVERED_ENDPOINT_REFRESH_INTERVAL_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capLastError(message: string): string {
  if (message.length <= MAX_LAST_ERROR_CHARS) return message;
  return `${message.slice(0, MAX_LAST_ERROR_CHARS - 1)}…`;
}

function errorInfo(
  error: unknown,
  messageOverride?: string,
): RemoteRuntimeConnectErrorInfo {
  const structured = error instanceof RemoteRuntimeConnectError
    ? error.info
    : null;
  const rawMessage = messageOverride ?? structured?.message ?? errorMessage(error);
  const message = capLastError(rawMessage);
  if (structured) {
    return {
      ...structured,
      message,
      ...(structured.detail
        ? { detail: capRemoteRuntimeErrorDetail(structured.detail) }
        : {}),
    };
  }
  if (error instanceof PairedRuntimeRelayAuthRequiredError) {
    return {
      kind: "auth_required",
      message,
    };
  }
  if (
    error instanceof PairedRuntimeTransportUnavailableError
    && error.diagnostic
  ) {
    return {
      kind: "generic",
      message,
      correlationId: error.diagnostic.correlationId,
      attempts: error.diagnostic.attempts,
      ...(error.diagnostic.omittedAttemptCount != null
        ? { omittedAttemptCount: error.diagnostic.omittedAttemptCount }
        : {}),
    };
  }
  return {
    kind: "generic",
    message,
    detail: capRemoteRuntimeErrorDetail(errorMessage(error)),
  };
}

function errorStatusPatch(
  error: unknown,
  messageOverride?: string,
): Pick<RemoteRuntimeConnectionStatus, "lastError" | "lastErrorInfo"> {
  const info = errorInfo(error, messageOverride);
  return {
    lastError: info.message,
    lastErrorInfo: info,
  };
}

function automaticReconnectStoppedMessage(): string {
  return `ADE stopped automatic reconnecting after ${AUTOMATIC_RECONNECT_FAILURE_LIMIT} failed attempts. Press Connect to try again.`;
}

function isImplicitConnectionFailure(error: unknown): boolean {
  if (isRemoteRuntimeConnectionError(error)) return true;
  const message = errorMessage(error);
  return /remote (?:runtime|ADE service) connection was interrupted|sync (?:connection|websocket|endpoint).*(?:closed|failed)|remote target is not connected|SSH server at .* closed the connection before ADE could finish the SSH handshake|Timed out while waiting for the SSH handshake/i.test(
    message,
  );
}

function isConnectionBackoffThrottle(error: unknown): boolean {
  return /^Remote ADE service connection failed recently\b/i.test(
    errorMessage(error),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function coerceConnectionProject(value: unknown): RemoteRuntimeProjectRecord {
  const project = coerceProjects([value])[0];
  if (!project)
    throw new Error("Remote ADE service did not return a project record.");
  return project;
}

function shouldAutoconnectTarget(target: RemoteRuntimeTarget): boolean {
  return target.autoConnect ?? (
    target.lastConnectedAt != null && target.manuallyDisconnectedAt == null
  );
}

export class RemoteConnectionService {
  private readonly statusById = new Map<string, StatusPatch>();
  private readonly manuallyDisconnectedTargetIds = new Set<string>();
  private readonly automaticReconnectFailuresByTargetId = new Map<
    string,
    number
  >();
  private readonly automaticReconnectPausedTargetIds = new Set<string>();
  private readonly disconnectGenerationByTargetId = new Map<string, number>();
  private readonly latencyProbeTargetIds = new Set<string>();
  private readonly pairedFallbackSshTrustByTargetId = new Map<
    string,
    Extract<RemoteRuntimeSshHostKeyTrustStatus, { state: "needs_trust" | "changed" }>
  >();
  private readonly listeners = new Set<
    (snapshot: RemoteRuntimeConnectionSnapshot) => void
  >();
  private autoconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: RemoteTargetRegistry,
    private readonly pool: RemoteConnectionPool,
    private readonly options: RemoteConnectionServiceOptions = {},
    private readonly pairedStore: DesktopPairedMachineStore = new DesktopPairedMachineStore(),
  ) {
    this.pool.onEntryEvicted((targetId, error) => {
      const current = this.statusById.get(targetId);
      if (current?.state !== "connected" && current?.state !== "connecting") {
        return;
      }
      this.mergeStatus(targetId, {
        state: "error",
        ...errorStatusPatch(error),
        lastAttemptedAt: Date.now(),
      });
    });
  }

  listTargets(): RemoteRuntimeTarget[] {
    return this.registry.list();
  }

  getTarget(targetId: string): RemoteRuntimeTarget | null {
    return this.registry.get(targetId);
  }

  /**
   * Canonical account-trust reconciliation command. Sign-out revokes Relay
   * leases but preserves host-issued paired secrets so LAN/Tailscale remain
   * available. Switching to a different signed-in account prunes the previous
   * account's records as one lifecycle boundary. Ownerless PIN/link/SSH trust
   * is always untouched.
   */
  reconcileAccountOwnership(
    currentOwnerUserIdValue: string | null,
  ): AccountMachineReconciliationResult {
    const currentOwnerUserId = currentOwnerUserIdValue?.trim() || null;
    const disconnectedRelayTargetIds = this.pool.reconcileAccountRelayOwner?.(
      currentOwnerUserId,
    ) ?? [];
    const removedTargets = currentOwnerUserId
      ? this.registry.pruneAccountOwned(currentOwnerUserId)
      : [];
    const removedCredentials = currentOwnerUserId
      ? this.pairedStore.pruneAccountOwned(currentOwnerUserId)
      : [];
    const removedCredentialIds = new Set<string>();
    for (const credentials of removedCredentials) {
      removedCredentialIds.add(credentials.hostIdentity.deviceId);
      if (credentials.machineKey) removedCredentialIds.add(credentials.machineKey);
    }

    // Recover safely from a partial historical write where credentials carry
    // account provenance but their target does not. A target without its paired
    // secret is neither usable nor local trust and must disappear with it.
    const removedTargetIds = new Set(removedTargets.map((target) => target.id));
    for (const target of this.registry.list()) {
      const reference = target.pairedMachine;
      if (
        !reference
        || (!removedCredentialIds.has(reference.hostIdentity)
          && !(reference.machineKey && removedCredentialIds.has(reference.machineKey)))
      ) continue;
      if (this.registry.remove(target.id)) removedTargetIds.add(target.id);
    }

    for (const targetId of removedTargetIds) {
      this.bumpDisconnectGeneration(targetId);
      this.pool.disconnect(targetId);
      this.statusById.delete(targetId);
      this.manuallyDisconnectedTargetIds.delete(targetId);
      this.clearAutomaticReconnectBudget(targetId);
      this.latencyProbeTargetIds.delete(targetId);
      this.pairedFallbackSshTrustByTargetId.delete(targetId);
    }
    for (const targetId of disconnectedRelayTargetIds) {
      if (removedTargetIds.has(targetId)) continue;
      const target = this.registry.get(targetId);
      if (!target) continue;
      this.bumpDisconnectGeneration(targetId);
      this.mergeStatus(targetId, { state: "idle", lastError: null });
      this.clearAutomaticReconnectBudget(targetId);
      if (
        shouldAutoconnectTarget(target)
        && !this.manuallyDisconnectedTargetIds.has(targetId)
      ) {
        void this.connect(targetId).catch(() => {});
      }
    }
    if (
      removedTargetIds.size > 0
      || removedCredentials.length > 0
      || disconnectedRelayTargetIds.length > 0
    ) this.emit();
    return {
      removedTargetIds: [...removedTargetIds],
      removedCredentialHostIds: removedCredentials.map(
        (credentials) => credentials.hostIdentity.deviceId,
      ),
    };
  }

  async reconcileAuthorizedAccountOwnership(): Promise<AccountMachineReconciliationResult> {
    if (!this.options.getAuthorizedAccountOwnerId) {
      return { removedTargetIds: [], removedCredentialHostIds: [] };
    }
    const currentOwnerUserId = await this.options.getAuthorizedAccountOwnerId()
      .catch(() => null);
    return this.reconcileAccountOwnership(currentOwnerUserId);
  }

  setAutoConnect(targetId: string, enabled: boolean): RemoteRuntimeTarget {
    const target = this.requireTarget(targetId);
    const updated = this.registry.update(target.id, {
      autoConnect: enabled,
      ...(enabled ? { manuallyDisconnectedAt: null } : {}),
    });
    if (enabled) {
      this.manuallyDisconnectedTargetIds.delete(target.id);
      this.clearAutomaticReconnectBudget(target.id);
    }
    this.emit();
    return updated;
  }

  saveTarget(
    input: RemoteRuntimeTargetInput,
    discoveredMachine?: RemoteRuntimeDiscoveredMachine | null,
  ): RemoteRuntimeTarget {
    let normalizedInput = input;
    if (discoveredMachine?.hostIdentity) {
      const paired = this.pairedStore.get(discoveredMachine.hostIdentity);
      const discoveredEndpoints = syncEndpointsForDiscoveredRuntime(discoveredMachine);
      if (paired && discoveredEndpoints.length > 0) {
        const saved = this.pairedStore.markEndpointsDiscovered(
          paired.hostIdentity.deviceId,
          discoveredEndpoints,
        );
        normalizedInput = {
          ...input,
          transport: "paired",
          pairedMachine: {
            hostIdentity: saved.hostIdentity.deviceId,
            machineKey: saved.machineKey ?? null,
          },
        };
      }
    }
    const target = this.registry.save(normalizedInput);
    this.mergeStatus(target.id, { state: "idle", lastError: null });
    return target;
  }

  rememberDiscoveredMachines(machines: RemoteRuntimeDiscoveredMachine[]): void {
    const discoveredAt = Date.now();
    for (const machine of machines) {
      if (!machine.hostIdentity) continue;
      const paired = this.pairedStore.get(machine.hostIdentity);
      if (!paired) continue;
      const endpoints = syncEndpointsForDiscoveredRuntime(machine);
      if (endpoints.length === 0) continue;
      const discoveryIsFresh = endpoints.every((endpoint) => {
        const state = paired.endpointStates?.find(
          (candidate) => candidate.endpoint === endpoint,
        );
        return state?.lastDiscoveredAt != null
          && discoveredAt - state.lastDiscoveredAt
            < DISCOVERED_ENDPOINT_REFRESH_INTERVAL_MS;
      });
      if (discoveryIsFresh) continue;
      this.pairedStore.markEndpointsDiscovered(
        paired.hostIdentity.deviceId,
        endpoints,
        discoveredAt,
      );
    }
  }

  findDiscoveredTargetInputMatch(
    machines: RemoteRuntimeDiscoveredMachine[],
    input: RemoteRuntimeTargetInput,
  ): RemoteRuntimeDiscoveredMachine | null {
    return findDiscoveredRuntimeForTargetInput(machines, input);
  }

  async pairWithMachine(
    args: RemoteRuntimePairWithMachineArgs,
  ): Promise<RemoteRuntimePairWithMachineResult> {
    const parsed = parseRemoteRuntimePairingInput(args.input);
    let paired: DesktopPairedMachineCredentials | null = null;
    let relayAuthError: PairedRuntimeRelayAuthRequiredError | null = null;
    const failures: string[] = [];
    for (const endpoint of parsed.endpoints) {
      try {
        let relayAccountToken: string | null = null;
        if (classifyPairedRuntimeEndpoint(endpoint, parsed.relayUrl) === "relay") {
          const proof = await this.options.getAccountRelayProof?.().catch(() => null) ?? null;
          if (!proof?.token.trim()) {
            relayAuthError = new PairedRuntimeRelayAuthRequiredError();
            continue;
          }
          relayAccountToken = proof.token.trim();
        }
        paired = await this.pairedStore.pairWithMachine(
          endpoint,
          args.pin,
          args.deviceName,
          {
            appVersion: this.options.appVersion,
            relayAccountToken,
            runtimeHostGrant: parsed.runtimeHostGrant ?? null,
          },
        );
        if (paired.hostIdentity.deviceId !== parsed.hostIdentity.deviceId) {
          this.pairedStore.remove(paired.hostIdentity.deviceId);
          throw new Error(
            `Pairing endpoint identity mismatch (expected ${parsed.hostIdentity.deviceId}, received ${paired.hostIdentity.deviceId}).`,
          );
        }
        break;
      } catch (error) {
        paired = null;
        failures.push(`${endpoint}: ${errorMessage(error)}`);
      }
    }
    if (!paired) {
      if (relayAuthError) throw relayAuthError;
      throw new Error(`Could not pair with the ADE machine. ${failures.join("; ")}`);
    }
    paired = this.pairedStore.save({
      ...paired,
      endpoints: [...parsed.endpoints, ...paired.endpoints],
      relayUrl: parsed.relayUrl ?? paired.relayUrl ?? null,
    });
    const sshRoutes = sshRoutesForPairedEndpoints(parsed.endpoints);
    const fallbackHostname = (() => {
      try {
        return new URL(parsed.endpoints[0]!).hostname;
      } catch {
        return parsed.hostIdentity.name;
      }
    })();
    const target = this.saveTarget({
      name: parsed.machineName ?? paired.hostIdentity.name,
      hostname: sshRoutes[0]?.hostname ?? fallbackHostname,
      transport: "paired",
      pairedMachine: {
        hostIdentity: paired.hostIdentity.deviceId,
        machineKey: paired.machineKey ?? null,
      },
      accountOwnerUserId: null,
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: sshRoutes,
    });
    return { targetId: target.id };
  }

  async runDoctor(
    targetIdOrMachineId: string,
    discoveredMachine?: RemoteRuntimeDiscoveredMachine | null,
  ): Promise<RemoteRuntimeDoctorResult> {
    const id = targetIdOrMachineId.trim();
    if (!id) throw new Error("A remote target or paired machine id is required.");
    const savedTarget = this.registry.get(id);
    const discoveredRoutes = discoveredMachine
      ? sshRoutesForDiscoveredRuntime(discoveredMachine)
      : [];
    const target: RemoteRuntimeTarget | null = savedTarget ?? (discoveredMachine && discoveredRoutes[0]
      ? {
          id: discoveredMachine.id,
          name: discoveredMachine.machineName,
          hostname: discoveredRoutes[0].hostname,
          sshUser: null,
          port: discoveredRoutes[0].port,
          sshKeyPath: null,
          routes: discoveredRoutes,
          lastSeenArch: null,
          runtimeBinaryVersion: discoveredMachine.runtimeVersion,
          lastConnectedAt: null,
        }
      : null);
    const credentials = target?.pairedMachine
      ? this.pairedStore.getForReference(target.pairedMachine)
      : this.pairedStore.get(discoveredMachine?.hostIdentity ?? id);
    if (!target && !credentials) {
      throw new Error("Remote target or paired machine was not found.");
    }
    return await runRemoteRuntimeDoctor({ target, credentials });
  }

  removeTarget(targetId: string): boolean {
    const target = this.registry.get(targetId);
    const pairedCredentials = target?.transport === "paired" && target.pairedMachine
      ? this.pairedStore.getForReference(target.pairedMachine)
      : null;
    this.disconnect(targetId);
    this.manuallyDisconnectedTargetIds.delete(targetId);
    this.clearAutomaticReconnectBudget(targetId);
    this.pairedFallbackSshTrustByTargetId.delete(targetId);
    this.statusById.delete(targetId);
    const removed = this.registry.remove(targetId);
    if (removed && pairedCredentials) {
      this.pairedStore.remove(pairedCredentials.hostIdentity.deviceId);
    }
    this.emit();
    return removed;
  }

  async getSshHostKeyTrust(
    targetId: string,
  ): Promise<RemoteRuntimeSshHostKeyTrustStatus> {
    const target = this.requireTarget(targetId);
    const pairedFallbackTrust = this.pairedFallbackSshTrustByTargetId.get(targetId);
    if (pairedFallbackTrust) return pairedFallbackTrust;
    // Paired targets attempt authenticated WebSocket RPC first. Avoid asking
    // for SSH trust before that path is known to be unavailable.
    const pairedReference = target.pairedMachine;
    const hasPairedCredentials = pairedReference
      ? this.pairedStore.getForReference(pairedReference)
      : null;
    if (target.transport === "paired" && hasPairedCredentials) {
      return { state: "trusted" };
    }
    return await getSshHostKeyTrustForTarget(target);
  }

  async trustSshHostKey(
    targetId: string,
    fingerprintSha256: string,
  ): Promise<RemoteRuntimeTrustSshHostKeyResult> {
    const fingerprint = fingerprintSha256.trim();
    if (!fingerprint) throw new Error("SSH host key fingerprint is required.");
    const target = this.requireTarget(targetId);
    const cached = this.pairedFallbackSshTrustByTargetId.get(targetId);
    const trustTarget = cached
      ? {
          ...target,
          hostname: cached.route.hostname,
          port: cached.route.port ?? target.port,
          routes: [cached.route],
        }
      : target;
    const result = await trustSshHostKeyForTarget(
      trustTarget,
      fingerprint,
    );
    this.pairedFallbackSshTrustByTargetId.delete(targetId);
    return result;
  }

  snapshot(): RemoteRuntimeConnectionSnapshot {
    const targets = this.registry.list();
    const connections = targets
      .map((target): RemoteRuntimeConnectionStatus => {
        const status = this.statusById.get(target.id) ?? {};
        return {
          target,
          state: status.state ?? (target.lastConnectedAt ? "idle" : "idle"),
          arch: status.arch ?? target.lastSeenArch,
          version: status.version ?? target.runtimeBinaryVersion,
          ...(status.route ? { route: status.route } : {}),
          ...(status.capabilities ? { capabilities: status.capabilities } : {}),
          ...(status.compatibilityWarnings
            ? { compatibilityWarnings: status.compatibilityWarnings }
            : {}),
          projects: status.projects ?? [],
          lastError: status.lastError ?? null,
          lastErrorInfo: status.lastErrorInfo ?? null,
          lastAttemptedAt: status.lastAttemptedAt ?? null,
          connectedAt: status.connectedAt ?? target.lastConnectedAt,
        };
      });
    return {
      connections,
      connectedCount: connections.filter((entry) => entry.state === "connected")
        .length,
      updatedAt: Date.now(),
    };
  }

  onSnapshotChanged(
    listener: (snapshot: RemoteRuntimeConnectionSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startAutoconnect(): void {
    for (const target of this.registry.list()) {
      if (!shouldAutoconnectTarget(target)) continue;
      if (this.manuallyDisconnectedTargetIds.has(target.id)) continue;
      if (this.automaticReconnectPausedTargetIds.has(target.id)) continue;
      void this.connect(target.id).catch(() => {});
    }
    if (this.autoconnectTimer) return;
    this.autoconnectTimer = setInterval(() => {
      void this.maintainSavedConnections();
    }, this.options.autoconnectIntervalMs ?? 30_000);
    this.autoconnectTimer.unref?.();
  }

  stopAutoconnect(): void {
    if (!this.autoconnectTimer) return;
    clearInterval(this.autoconnectTimer);
    this.autoconnectTimer = null;
  }

  async connect(
    targetId: string,
    options: RemoteConnectionConnectOptions = {},
  ): Promise<RemoteRuntimeConnectResult> {
    const target = this.requireTarget(targetId);
    await this.assertAccountOwnershipAuthorized(target);
    this.pairedFallbackSshTrustByTargetId.delete(target.id);
    const explicit = options.explicit === true;
    if (explicit) {
      this.manuallyDisconnectedTargetIds.delete(target.id);
      this.clearAutomaticReconnectBudget(target.id);
    } else {
      this.assertImplicitReconnectAllowed(target.id);
    }
    const disconnectGeneration = this.getDisconnectGeneration(target.id);
    this.mergeStatus(target.id, {
      state: "connecting",
      lastAttemptedAt: Date.now(),
      lastError: null,
    });
    try {
      const result = explicit
        ? await this.pool.connect(target, { bypassFailureBackoff: true })
        : await this.pool.connect(target);
      if (!this.isDisconnectGenerationCurrent(target.id, disconnectGeneration)) {
        if (this.manuallyDisconnectedTargetIds.has(target.id)) {
          this.pool.disconnect(target.id);
        }
        throw new Error(
          "Remote target was disconnected before ADE finished connecting.",
        );
      }
      // A first successful connection enables future reconnects. Once the
      // user disables that preference, Connect must not silently restore it.
      const shouldPersistAutoConnect =
        target.lastConnectedAt == null ||
        (explicit && result.target.manuallyDisconnectedAt != null);
      const connectedResult =
        shouldPersistAutoConnect
          ? {
              ...result,
              target: this.registry.update(result.target.id, {
                autoConnect: true,
                manuallyDisconnectedAt: null,
              }),
            }
          : result;
      this.mergeStatus(connectedResult.target.id, {
        state: "connected",
        arch: connectedResult.arch,
        version: connectedResult.version,
        route: connectedResult.route,
        capabilities: connectedResult.capabilities,
        compatibilityWarnings: connectedResult.compatibilityWarnings,
        projects: connectedResult.projects,
        connectedAt: connectedResult.target.lastConnectedAt ?? Date.now(),
        lastAttemptedAt: Date.now(),
        lastError: null,
      });
      this.clearAutomaticReconnectBudget(connectedResult.target.id);
      this.pairedFallbackSshTrustByTargetId.delete(connectedResult.target.id);
      return connectedResult;
    } catch (error) {
      if (!this.isDisconnectGenerationCurrent(target.id, disconnectGeneration)) {
        throw error;
      }
      if (error instanceof PairedRuntimeSshTrustRequiredError) {
        this.pairedFallbackSshTrustByTargetId.set(target.id, error.trustStatus);
      }
      const lastError = explicit
        ? errorMessage(error)
        : this.recordImplicitFailure(target.id, error);
      this.mergeStatus(target.id, {
        state: "error",
        ...errorStatusPatch(error, lastError),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  disconnect(
    targetId: string,
    options: RemoteConnectionDisconnectOptions = {},
  ): void {
    let persistenceError: unknown = null;
    if (options.manual) {
      this.manuallyDisconnectedTargetIds.add(targetId);
      if (this.registry.get(targetId)) {
        try {
          this.registry.update(targetId, {
            autoConnect: false,
            manuallyDisconnectedAt: Date.now(),
          });
        } catch (error) {
          persistenceError = error;
        }
      }
    }
    this.bumpDisconnectGeneration(targetId);
    this.pool.disconnect(targetId);
    this.mergeStatus(targetId, { state: "idle", lastError: null });
    if (persistenceError) {
      throw persistenceError;
    }
  }

  probeSavedConnections(): void {
    void this.maintainSavedConnections({
      pingTimeoutMs: this.options.pingTimeoutMs ?? 5_000,
    });
  }

  async projects(targetId: string): Promise<RemoteRuntimeProjectRecord[]> {
    const target = await this.requireTargetForImplicitUse(targetId);
    try {
      const value = await this.pool.projectsForTarget(target);
      const projects = coerceProjects(value);
      this.mergeStatus(targetId, {
        state: "connected",
        projects,
        lastError: null,
      });
      this.clearAutomaticReconnectBudget(targetId);
      return projects;
    } catch (error) {
      this.markCallFailure(targetId, error);
      throw error;
    }
  }

  async addProject(
    targetId: string,
    rootPath: string,
  ): Promise<RemoteRuntimeProjectRecord> {
    const target = await this.requireTargetForImplicitUse(targetId);
    try {
      const value = await this.pool.addProjectForTarget(target, rootPath);
      const project = coerceConnectionProject(value);
      this.upsertProject(targetId, project);
      this.clearAutomaticReconnectBudget(targetId);
      return project;
    } catch (error) {
      this.markCallFailure(targetId, error);
      throw error;
    }
  }

  async ensurePortForward(
    targetId: string,
    request: RemoteRuntimePortForwardRequest,
  ): Promise<RemoteRuntimePortForward> {
    const target = await this.requireTargetForImplicitUse(targetId);
    await this.connect(target.id);
    try {
      return await this.pool.ensureLocalPortForward(target.id, request);
    } catch (error) {
      this.markCallFailure(targetId, error);
      throw error;
    }
  }

  async browseDirectories(
    targetId: string,
    input: ProjectBrowseInput,
  ): Promise<ProjectBrowseResult> {
    return (await this.callMachine(
      this.requireTarget(targetId),
      "projects.browseDirectories",
      asRecord(input),
    )) as ProjectBrowseResult;
  }

  async getProjectDetail(
    targetId: string,
    rootPath: string,
  ): Promise<ProjectDetail> {
    return (await this.callMachine(
      this.requireTarget(targetId),
      "projects.getDetail",
      { rootPath },
    )) as ProjectDetail;
  }

  async getProjectWorkSummary(
    targetId: string,
    rootPath: string,
  ): Promise<RemoteRuntimeProjectWorkSummary> {
    return (await this.callMachine(
      this.requireTarget(targetId),
      "projects.getWorkSummary",
      { rootPath },
    )) as RemoteRuntimeProjectWorkSummary;
  }

  async getDefaultParentDir(targetId: string): Promise<string> {
    const value = await this.callMachine(
      this.requireTarget(targetId),
      "projects.getDefaultParentDir",
      {},
    );
    return typeof value === "string" && value.trim()
      ? value.trim()
      : "~/Projects";
  }

  async getHandoffStoragePreflight(
    targetId: string,
    input: RemoteRuntimeHandoffStoragePreflightArgs,
  ): Promise<RemoteRuntimeHandoffStoragePreflightResult> {
    const value = await this.callMachine(
      this.requireTarget(targetId),
      "projects.getHandoffStoragePreflight",
      asRecord(input),
    );
    return decodeRemoteRuntimeHandoffStoragePreflightResult(value);
  }

  async createProject(
    targetId: string,
    input: CreateProjectInput,
  ): Promise<RemoteRuntimeProjectRecord> {
    const value = await this.callMachine(
      this.requireTarget(targetId),
      "projects.create",
      {
        ...asRecord(input),
        catalogVisibility: "recent",
        registrationSource: "desktop",
      },
      { retryOnConnectionError: false },
    );
    const project = coerceConnectionProject(value);
    this.upsertProject(targetId, project);
    return project;
  }

  async cloneProject(
    targetId: string,
    input: CloneProjectInput,
  ): Promise<RemoteRuntimeProjectRecord> {
    const value = await this.callMachine(
      this.requireTarget(targetId),
      "projects.clone",
      {
        ...asRecord(input),
        catalogVisibility: "recent",
        registrationSource: "desktop",
      },
      { retryOnConnectionError: false },
    );
    const project = coerceConnectionProject(value);
    this.upsertProject(targetId, project);
    return project;
  }

  async listMyGitHubRepos(
    targetId: string,
    input: ListMyGitHubReposInput,
  ): Promise<ListMyGitHubReposResult> {
    return (await this.callMachine(
      this.requireTarget(targetId),
      "projects.listMyGitHubRepos",
      asRecord(input),
    )) as ListMyGitHubReposResult;
  }

  async callAction(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeActionRequest,
  ): Promise<RemoteRuntimeActionResult> {
    const target = await this.requireTargetForImplicitUse(targetId);
    try {
      const result = await this.pool.callActionForTarget(
        target,
        projectId,
        request,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return result;
    } catch (error) {
      this.markCallFailure(targetId, error);
      throw error;
    }
  }

  async streamEvents(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
  ): Promise<RemoteRuntimeStreamEventsResult> {
    const target = await this.requireTargetForImplicitUse(targetId);
    try {
      const result = await this.pool.streamEventsForTarget(
        target,
        projectId,
        request,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return result;
    } catch (error) {
      this.markCallFailure(targetId, error);
      throw error;
    }
  }

  async subscribeEvents(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
    onEvent: (event: RemoteRuntimeBufferedEvent, eventEpoch?: string | null) => void,
    onEnded?: () => void,
    onSubscribed?: (result: RemoteRuntimeStreamEventsResult) => void,
  ): Promise<() => void> {
    const target = await this.requireTargetForImplicitUse(targetId);
    try {
      const cleanup = await this.pool.subscribeEventsForTarget(
        target,
        projectId,
        request,
        onEvent,
        onEnded,
        onSubscribed,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return cleanup;
    } catch (error) {
      this.markCallFailure(targetId, error);
      throw error;
    }
  }

  async listActionRegistry(
    targetId: string,
    projectId: string,
  ): Promise<AdeActionRegistryEntry[]> {
    const target = await this.requireTargetForImplicitUse(targetId);
    try {
      const registry = await this.pool.listActionRegistryForTarget(
        target,
        projectId,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return registry;
    } catch (error) {
      this.markCallFailure(targetId, error);
      throw error;
    }
  }

  async callSync(
    targetId: string,
    projectId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const target = await this.requireTargetForImplicitUse(targetId);
    try {
      const result = await this.pool.callSyncForTarget(
        target,
        projectId,
        method,
        params,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return result;
    } catch (error) {
      this.markCallFailure(targetId, error);
      throw error;
    }
  }

  /** Call a machine-scoped runtime RPC that does not require a project. */
  async callMachineMethod<T = unknown>(
    targetId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const target = await this.requireTargetForImplicitUse(targetId);
    return (await this.callMachine(target, method, params)) as T;
  }

  dispose(): void {
    this.stopAutoconnect();
    this.pool.dispose();
    this.latencyProbeTargetIds.clear();
    this.pairedFallbackSshTrustByTargetId.clear();
    this.listeners.clear();
  }

  private async maintainSavedConnections(
    options: { pingTimeoutMs?: number } = {},
  ): Promise<void> {
    await this.reconcileAuthorizedAccountOwnership();
    for (const target of this.registry.list()) {
      if (!shouldAutoconnectTarget(target)) continue;
      if (this.manuallyDisconnectedTargetIds.has(target.id)) continue;
      if (this.automaticReconnectPausedTargetIds.has(target.id)) continue;
      const status = this.statusById.get(target.id);
      if (status?.state === "connecting") continue;
      if (status?.state === "connected") {
        if (this.latencyProbeTargetIds.has(target.id)) continue;
        this.latencyProbeTargetIds.add(target.id);
        const startedAt = Date.now();
        try {
          await this.pool.callMachineForTarget(
            target,
            "ping",
            {},
            {
              timeoutMs: options.pingTimeoutMs,
            },
          );
          const currentRoute = this.statusById.get(target.id)?.route;
          if (currentRoute) {
            this.mergeStatus(target.id, {
              route: {
                ...currentRoute,
                latencyMs: Math.max(0, Date.now() - startedAt),
              },
            });
          }
          continue;
        } catch (error) {
          if (!isImplicitConnectionFailure(error)) continue;
          this.pool.disconnect(target.id);
          this.mergeStatus(target.id, {
            state: "error",
            lastError: "Remote ADE service connection was interrupted.",
          });
        } finally {
          this.latencyProbeTargetIds.delete(target.id);
        }
      }
      void this.connect(target.id).catch(() => {});
    }
  }

  private async callMachine(
    target: RemoteRuntimeTarget,
    method: string,
    params: Record<string, unknown>,
    options: { retryOnConnectionError?: boolean } = {},
  ): Promise<unknown> {
    await this.assertAccountOwnershipAuthorized(target);
    this.assertImplicitReconnectAllowed(target.id);
    try {
      const result = await this.pool.callMachineForTarget(
        target,
        method,
        params,
        options,
      );
      const current = this.statusById.get(target.id);
      if (current?.state !== "connected") {
        this.mergeStatus(target.id, { state: "connected", lastError: null });
      }
      this.clearAutomaticReconnectBudget(target.id);
      return result;
    } catch (error) {
      this.markCallFailure(target.id, error);
      throw error;
    }
  }

  private requireTarget(targetId: string): RemoteRuntimeTarget {
    const target = this.registry.get(targetId);
    if (!target) throw new Error("Remote target was not found.");
    return target;
  }

  private async assertAccountOwnershipAuthorized(
    target: RemoteRuntimeTarget,
  ): Promise<void> {
    const expectedOwnerUserId = target.accountOwnerUserId?.trim();
    if (!expectedOwnerUserId || !this.options.getAuthorizedAccountOwnerId) return;
    const currentOwnerUserId = await this.options.getAuthorizedAccountOwnerId()
      .catch(() => null);
    if (currentOwnerUserId?.trim() === expectedOwnerUserId) return;
    // Signed-out callers may still use the persisted host-issued secret over
    // LAN/Tailscale. Relay remains unavailable because it separately requires
    // a fresh matching account proof.
    if (!currentOwnerUserId?.trim()) return;
    this.reconcileAccountOwnership(currentOwnerUserId);
    throw new PairedRuntimeRelayAuthRequiredError(
      "Sign in with the same ADE account as this machine to connect.",
    );
  }

  private async requireTargetForImplicitUse(
    targetId: string,
  ): Promise<RemoteRuntimeTarget> {
    const target = this.requireTarget(targetId);
    await this.assertAccountOwnershipAuthorized(target);
    this.assertImplicitReconnectAllowed(target.id);
    return target;
  }

  private assertImplicitReconnectAllowed(targetId: string): void {
    const target = this.registry.get(targetId);
    if (
      this.manuallyDisconnectedTargetIds.has(targetId) ||
      target?.manuallyDisconnectedAt != null
    ) {
      throw new Error(
        "Remote machine was manually disconnected. Connect again to use this remote project.",
      );
    }
    if (this.automaticReconnectPausedTargetIds.has(targetId)) {
      throw new Error(automaticReconnectStoppedMessage());
    }
  }

  private clearAutomaticReconnectBudget(targetId: string): void {
    this.automaticReconnectFailuresByTargetId.delete(targetId);
    this.automaticReconnectPausedTargetIds.delete(targetId);
  }

  /**
   * Classify a failure from an RPC call made over an already-established
   * connection. If the response came back over a live channel, the host is
   * reachable and the error is application-level (e.g. a host-side SQL or
   * validation failure). Such errors must NOT flip the connection to
   * "error"/reconnecting — doing so surfaces a false "host is unreachable"
   * toast and a reconnect loop for what is really a per-action failure. Only
   * genuine transport failures update the connection status and reconnect
   * budget; everything else is left to rethrow to the caller untouched.
   */
  private markCallFailure(targetId: string, error: unknown): void {
    if (!isImplicitConnectionFailure(error)) return;
    this.mergeStatus(targetId, {
      state: "error",
      ...errorStatusPatch(
        error,
        this.recordImplicitFailure(targetId, error),
      ),
      lastAttemptedAt: Date.now(),
    });
  }

  private recordImplicitFailure(targetId: string, error: unknown): string {
    if (!isImplicitConnectionFailure(error)) return errorMessage(error);
    if (isConnectionBackoffThrottle(error)) return errorMessage(error);
    return this.noteAutomaticReconnectFailure(targetId, error);
  }

  private noteAutomaticReconnectFailure(
    targetId: string,
    error: unknown,
  ): string {
    if (this.automaticReconnectPausedTargetIds.has(targetId)) {
      return automaticReconnectStoppedMessage();
    }
    const failureCount =
      (this.automaticReconnectFailuresByTargetId.get(targetId) ?? 0) + 1;
    this.automaticReconnectFailuresByTargetId.set(targetId, failureCount);
    if (failureCount >= AUTOMATIC_RECONNECT_FAILURE_LIMIT) {
      this.automaticReconnectPausedTargetIds.add(targetId);
      return automaticReconnectStoppedMessage();
    }
    return errorMessage(error);
  }

  private upsertProject(
    targetId: string,
    project: RemoteRuntimeProjectRecord,
  ): void {
    const current = this.statusById.get(targetId);
    const projects = [
      project,
      ...(current?.projects ?? []).filter(
        (candidate) => candidate.projectId !== project.projectId,
      ),
    ];
    this.mergeStatus(targetId, {
      state: "connected",
      projects,
      lastError: null,
    });
  }

  private mergeStatus(targetId: string, patch: StatusPatch): void {
    const current = this.statusById.get(targetId) ?? {};
    let normalizedPatch = patch;
    if (Object.prototype.hasOwnProperty.call(patch, "lastError")) {
      if (patch.lastError == null) {
        normalizedPatch = { ...patch, lastError: null, lastErrorInfo: null };
      } else {
        const lastError = capLastError(patch.lastError);
        const info = patch.lastErrorInfo ?? {
          kind: "generic",
          message: lastError,
          detail: patch.lastError,
        };
        normalizedPatch = {
          ...patch,
          lastError,
          lastErrorInfo: {
            ...info,
            message: capLastError(info.message),
            ...(info.detail
              ? { detail: capRemoteRuntimeErrorDetail(info.detail) }
              : {}),
          },
        };
      }
    }
    this.statusById.set(targetId, {
      ...current,
      ...normalizedPatch,
      state: (normalizedPatch.state ??
        current.state ??
        "idle") as RemoteRuntimeConnectionState,
    });
    this.emit();
  }

  private getDisconnectGeneration(targetId: string): number {
    return this.disconnectGenerationByTargetId.get(targetId) ?? 0;
  }

  private bumpDisconnectGeneration(targetId: string): void {
    this.disconnectGenerationByTargetId.set(
      targetId,
      this.getDisconnectGeneration(targetId) + 1,
    );
  }

  private isDisconnectGenerationCurrent(
    targetId: string,
    generation: number,
  ): boolean {
    return this.getDisconnectGeneration(targetId) === generation;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      listener(snapshot);
    }
  }
}
